const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { detectedCarCount } = require('./component-state.cjs');

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

class ParkingDatabase {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        sequence_id INTEGER,
        event_class TEXT NOT NULL,
        signature_status TEXT NOT NULL,
        sequence_status TEXT NOT NULL,
        server_datetime TEXT,
        received_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_sequence ON events(sequence_id);
      CREATE INDEX IF NOT EXISTS idx_events_class ON events(event_class);

      CREATE TABLE IF NOT EXISTS components (
        component_type TEXT NOT NULL,
        name TEXT NOT NULL,
        zone TEXT,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY(component_type, name)
      );

      CREATE TABLE IF NOT EXISTS cars (
        plate TEXT PRIMARY KEY,
        car_type TEXT,
        planned_minutes INTEGER,
        status TEXT NOT NULL DEFAULT 'unknown',
        current_spot TEXT,
        assigned_spot TEXT,
        entered_at TEXT,
        parked_at TEXT,
        departed_spot_at TEXT,
        arrived_exit_at TEXT,
        exited_at TEXT,
        payment_status TEXT NOT NULL DEFAULT 'not_requested',
        paid_amount REAL,
        last_event_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cars_status ON cars(status);

      CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        response_json TEXT
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  hasEvent(eventId) {
    return Boolean(this.db.prepare('SELECT 1 FROM events WHERE event_id = ?').get(eventId));
  }

  insertEvent(payload, signatureStatus, sequenceStatus, receivedAt = nowIso()) {
    this.db.prepare(`
      INSERT INTO events (
        event_id, sequence_id, event_class, signature_status, sequence_status,
        server_datetime, received_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.EventId,
      Number.isFinite(Number(payload.SequenceId)) ? Number(payload.SequenceId) : null,
      payload.EventClass,
      signatureStatus,
      sequenceStatus,
      payload.ServerDateTime || null,
      receivedAt,
      JSON.stringify(payload),
    );
  }

  getMetadata(key) {
    return this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value ?? null;
  }

  setMetadata(key, value) {
    this.db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  upsertComponent(componentType, component) {
    const name = component.name || component.Name || component.ZoneName;
    if (!name) return;
    const zone = component.zoneParent || component.ZoneName || component.zone || null;
    this.db.prepare(`
      INSERT INTO components (component_type, name, zone, updated_at, data_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(component_type, name) DO UPDATE SET
        zone = excluded.zone,
        updated_at = excluded.updated_at,
        data_json = excluded.data_json
    `).run(componentType, name, zone, nowIso(), JSON.stringify(component));
  }

  replaceComponents(componentType, components) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM components WHERE component_type = ?').run(componentType);
      for (const component of components || []) this.upsertComponent(componentType, component);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getComponent(componentType, name) {
    const row = this.db.prepare(`
      SELECT component_type, name, zone, updated_at, data_json
      FROM components WHERE component_type = ? AND name = ?
    `).get(componentType, name);
    return row ? this.componentFromRow(row) : null;
  }

  listComponents(componentType, filters = {}) {
    const rows = this.db.prepare(`
      SELECT component_type, name, zone, updated_at, data_json
      FROM components WHERE component_type = ? ORDER BY name
    `).all(componentType).map((row) => this.componentFromRow(row));

    return rows.filter((row) => {
      if (filters.zone && row.zone !== filters.zone) return false;
      if (filters.status === 'free') return detectedCarCount(row.detectedCars) === 0;
      if (filters.status === 'occupied') return detectedCarCount(row.detectedCars) > 0;
      return true;
    });
  }

  componentFromRow(row) {
    return {
      ...safeJsonParse(row.data_json, {}),
      _type: row.component_type,
      _updatedAt: row.updated_at,
    };
  }

  findAvailableSpot(carType) {
    const compatibleTypes = carType === 'Electric'
      ? ['Electric', 'Any']
      : carType === 'Accessible'
        ? ['Accessible', 'Any']
        : ['Any'];
    const assigned = new Set(
      this.db.prepare(`
        SELECT assigned_spot FROM cars
        WHERE assigned_spot IS NOT NULL AND status NOT IN ('departed', 'parked')
      `).all().map((row) => row.assigned_spot),
    );
    const spots = this.listComponents('parking_spot', { status: 'free' })
      .filter((spot) => spot.purpose === 'Park')
      .filter((spot) => !assigned.has(spot.name))
      .filter((spot) => !spot.broken && !spot.isUnderMaintenance)
      .filter((spot) => compatibleTypes.includes(spot.parkingForCarType));
    spots.sort((left, right) => {
      const leftRank = compatibleTypes.indexOf(left.parkingForCarType);
      const rightRank = compatibleTypes.indexOf(right.parkingForCarType);
      return leftRank - rightRank || left.name.localeCompare(right.name);
    });
    return spots[0] || null;
  }

  // A newly loaded level has all-new cars, so any car rows we kept are phantoms
  // that would hold reservations against spots nobody is in.
  resetCarState() {
    const removed = this.db.prepare('SELECT COUNT(*) AS total FROM cars').get().total;
    this.db.exec("DELETE FROM cars; DELETE FROM metadata WHERE key = 'last_sequence_id';");
    return removed;
  }

  // Wipes the audit trail: stored webhooks (including penalties) and the record
  // of every command we sent. Component state and the last sync are untouched,
  // so the level does not need re-discovering.
  resetHistory() {
    const events = this.db.prepare('SELECT COUNT(*) AS total FROM events').get().total;
    const commands = this.db.prepare('SELECT COUNT(*) AS total FROM commands').get().total;
    this.db.exec("DELETE FROM events; DELETE FROM commands; DELETE FROM metadata WHERE key = 'last_sequence_id';");
    return { events, commands };
  }

  getCar(plate) {
    return this.db.prepare('SELECT * FROM cars WHERE plate = ?').get(plate) || null;
  }

  upsertCar(plate, patch) {
    const existing = this.getCar(plate) || {
      plate,
      car_type: null,
      planned_minutes: null,
      status: 'unknown',
      current_spot: null,
      assigned_spot: null,
      entered_at: null,
      parked_at: null,
      departed_spot_at: null,
      arrived_exit_at: null,
      exited_at: null,
      payment_status: 'not_requested',
      paid_amount: null,
      last_event_at: null,
    };
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const next = { ...existing, ...definedPatch, plate, updated_at: nowIso() };
    this.db.prepare(`
      INSERT OR REPLACE INTO cars (
        plate, car_type, planned_minutes, status, current_spot, assigned_spot,
        entered_at, parked_at, departed_spot_at, arrived_exit_at, exited_at,
        payment_status, paid_amount, last_event_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      next.plate,
      next.car_type,
      next.planned_minutes,
      next.status,
      next.current_spot,
      next.assigned_spot,
      next.entered_at,
      next.parked_at,
      next.departed_spot_at,
      next.arrived_exit_at,
      next.exited_at,
      next.payment_status,
      next.paid_amount,
      next.last_event_at,
      next.updated_at,
    );
    return this.getCar(plate);
  }

  listCars(filters = {}) {
    let sql = 'SELECT * FROM cars WHERE 1 = 1';
    const params = [];
    if (filters.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters.query) {
      sql += ' AND plate LIKE ?';
      params.push(`%${filters.query}%`);
    }
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    params.push(filters.limit || 100);
    return this.db.prepare(sql).all(...params);
  }

  listEvents(filters = {}) {
    let sql = 'SELECT * FROM events WHERE 1 = 1';
    const params = [];
    if (filters.eventClass) {
      sql += ' AND event_class = ?';
      params.push(filters.eventClass);
    }
    if (filters.afterSequence !== undefined) {
      sql += ' AND sequence_id > ?';
      params.push(filters.afterSequence);
    }
    sql += ' ORDER BY COALESCE(sequence_id, 0) DESC, received_at DESC LIMIT ?';
    params.push(filters.limit || 100);
    return this.db.prepare(sql).all(...params).map((row) => ({
      eventId: row.event_id,
      sequenceId: row.sequence_id,
      eventClass: row.event_class,
      signatureStatus: row.signature_status,
      sequenceStatus: row.sequence_status,
      serverDateTime: row.server_datetime,
      receivedAt: row.received_at,
      payload: safeJsonParse(row.payload_json, {}),
    }));
  }

  createCommand(action, target, requestedBy) {
    const result = this.db.prepare(`
      INSERT INTO commands (action, target, requested_by, status, requested_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(action, target, requestedBy, nowIso());
    return Number(result.lastInsertRowid);
  }

  completeCommand(id, status, response = null, error = null) {
    this.db.prepare(`
      UPDATE commands
      SET status = ?, completed_at = ?, response_json = ?, error = ?
      WHERE id = ?
    `).run(status, nowIso(), response === null ? null : JSON.stringify(response), error, id);
  }

  listCommands(limit = 100) {
    return this.db.prepare('SELECT * FROM commands ORDER BY id DESC LIMIT ?').all(limit);
  }

  dashboard() {
    const spots = this.listComponents('parking_spot');
    const parkSpots = spots.filter((spot) => spot.purpose === 'Park');
    const occupied = parkSpots.filter((spot) => detectedCarCount(spot.detectedCars) > 0).length;
    const byZone = {};
    for (const spot of parkSpots) {
      const zone = spot.zoneParent || 'unassigned';
      byZone[zone] ||= { total: 0, occupied: 0, free: 0 };
      byZone[zone].total += 1;
      if (detectedCarCount(spot.detectedCars) > 0) byZone[zone].occupied += 1;
      else byZone[zone].free += 1;
    }
    return {
      parking: {
        total: parkSpots.length,
        occupied,
        free: parkSpots.length - occupied,
        byZone,
      },
      barriers: this.listComponents('barrier'),
      zones: this.listComponents('zone'),
      alarms: this.listComponents('alarm'),
      activeCars: this.listCars({ limit: 500 }).filter((car) => car.status !== 'departed').length,
      recentEvents: this.listEvents({ limit: 20 }),
      lastSyncAt: this.getMetadata('last_sync_at'),
      lastSequenceId: this.getMetadata('last_sequence_id'),
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = { ParkingDatabase, safeJsonParse };

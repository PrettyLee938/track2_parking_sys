import type Database from "better-sqlite3";
import type { StatsResponse } from "@gpa/shared";

const reasonKey = (reason: string) => reason.replace(/\([^)]*\)/g, "(â€¦)").trim();

export function stats(db: Database.Database, sinceMs: number, untilMs: number, bucketS: number): StatsResponse {
  const since = new Date(sinceMs).toISOString(), until = new Date(untilMs).toISOString();
  const nBuckets = Math.max(1, Math.ceil((untilMs - sinceMs) / (bucketS * 1000)));
  const buckets = Array.from({ length: nBuckets }, (_, i) => ({
    t: new Date(sinceMs + i * bucketS * 1000).toISOString(), arrivals: 0, departures: 0, revenue: 0, turned_away: 0, penalties: 0,
  }));
  const bucketOf = (ms: number) => buckets[Math.min(nBuckets - 1, Math.max(0, Math.floor((ms - sinceMs) / (bucketS * 1000))))];
  const arrivals = db.prepare(
    `SELECT received_ms FROM events WHERE spot_type = 'EntrySpot' AND direction = 'CarIn' AND received_ms BETWEEN ? AND ?`,
  ).all(sinceMs, untilMs) as { received_ms: number }[];
  for (const arrival of arrivals) bucketOf(arrival.received_ms).arrivals++;
  const sessions = db.prepare(
    `SELECT recorded_at, status, spot, planned_minutes, paid, payment_ok, exit_lane FROM sessions WHERE recorded_at BETWEEN ? AND ?`,
  ).all(since, until) as { recorded_at: string; status: string; spot: string | null; planned_minutes: number | null;
    paid: number | null; payment_ok: number | null; exit_lane: string | null }[];
  let departures = 0, turnedAway = 0, neglected = 0, lost = 0, revenue = 0, paidCount = 0, mismatches = 0, escaped = 0;
  let plannedSum = 0, plannedN = 0;
  const stay = new Map<number, number>(), usage = new Map<string, number>();
  for (const session of sessions) {
    const bucket = bucketOf(Date.parse(session.recorded_at));
    if (session.status === "gone") {
      departures++; bucket.departures++;
      if (session.payment_ok === 1) { revenue += session.paid ?? 0; bucket.revenue += session.paid ?? 0; paidCount++; }
      else if (session.exit_lane) escaped++;
      if (session.planned_minutes) { stay.set(session.planned_minutes, (stay.get(session.planned_minutes) ?? 0) + 1); plannedSum += session.planned_minutes; plannedN++; }
    }
    if (session.payment_ok === 0) mismatches++;
    if (session.status === "turned_away") { turnedAway++; bucket.turned_away++; }
    if (session.status === "neglected") neglected++;
    if (session.status === "lost") lost++;
    if (session.spot && (session.status === "gone" || session.status === "lost")) usage.set(session.spot, (usage.get(session.spot) ?? 0) + 1);
  }
  const other = db.prepare(
    `SELECT received_ms, event_class, payload FROM events WHERE event_class IN ('penalty', 'gate_action') AND received_ms BETWEEN ? AND ?`,
  ).all(sinceMs, untilMs) as { received_ms: number; event_class: string; payload: string }[];
  const penalties = new Map<string, { count: number; fines: number }>(), gates = new Map<string, number>();
  let fines = 0, penaltyCount = 0;
  for (const row of other) {
    const payload = JSON.parse(row.payload);
    if (row.event_class === "penalty") {
      const key = reasonKey(String(payload.Reason ?? "unknown")), fine = Number(payload.FineAmount) || 0;
      const aggregate = penalties.get(key) ?? { count: 0, fines: 0 };
      aggregate.count++; aggregate.fines += fine; penalties.set(key, aggregate);
      fines += fine; penaltyCount++; bucketOf(row.received_ms).penalties++;
    } else if (payload.Action === "Open") gates.set(payload.Name, (gates.get(payload.Name) ?? 0) + 1);
  }
  const actions = db.prepare(`SELECT cmd, ok, ms FROM actions WHERE at BETWEEN ? AND ?`).all(since, until) as { cmd: string; ok: number; ms: number }[];
  const byCmd = new Map<string, { ms: number[]; failed: number }>();
  for (const action of actions) {
    const aggregate = byCmd.get(action.cmd) ?? { ms: [], failed: 0 };
    aggregate.ms.push(action.ms ?? 0); if (!action.ok) aggregate.failed++; byCmd.set(action.cmd, aggregate);
  }
  const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
  return {
    since, until, bucket_s: bucketS,
    totals: { arrivals: arrivals.length, departures, turned_away: turnedAway, neglected, lost, revenue: round(revenue),
      avg_ticket: paidCount ? round(revenue / paidCount) : 0, avg_planned_min: plannedN ? round(plannedSum / plannedN, 1) : 0,
      penalties: penaltyCount, fines: round(fines), payment_mismatches: mismatches, escaped },
    buckets: buckets.map((bucket) => ({ ...bucket, revenue: round(bucket.revenue) })),
    stay_histogram: [...stay.entries()].sort((a, b) => a[0] - b[0]).map(([minutes, count]) => ({ minutes, count })),
    spot_usage: [...usage.entries()].map(([spot, visits]) => ({ spot, visits })).sort((a, b) => b.visits - a.visits || a.spot.localeCompare(b.spot, undefined, { numeric: true })),
    penalties_by_reason: [...penalties.entries()].map(([reason, value]) => ({ reason, ...value, fines: round(value.fines) })).sort((a, b) => b.count - a.count),
    gate_cycles: [...gates.entries()].map(([gate, opens]) => ({ gate, opens })).sort((a, b) => b.opens - a.opens),
    commands: [...byCmd.entries()].map(([cmd, value]) => {
      const times = [...value.ms].sort((a, b) => a - b);
      return { cmd, count: times.length, failed: value.failed, avg_ms: round(times.reduce((x, y) => x + y, 0) / times.length, 1),
        p95_ms: round(times[Math.min(times.length - 1, Math.floor(times.length * 0.95))], 1) };
    }).sort((a, b) => b.count - a.count),
  };
}

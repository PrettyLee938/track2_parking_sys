import { createHash, randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { SimulatorCommand, SimulatorSnapshot, SpotCandidate } from '../domain/types.js';
import type { CommandAcceptance, GatewayHealth, SimulatorGateway } from './contracts.js';
import { WebhookBoundary } from './webhook-boundary.js';

type Fetcher = typeof fetch;
type Json = Record<string, unknown>;

const value = (row: Json, ...keys: string[]) => keys.map((key) => row[key]).find((item) => item !== undefined && item !== null);
const bool = (item: unknown) => item === true || item === 1 || item === '1' || String(item).toLowerCase() === 'true';

function normalizeSpot(row: Json, rank: number): SpotCandidate | undefined {
  const purpose = String(value(row, 'purpose', 'Purpose') || '').toLowerCase();
  if (purpose !== 'park') return undefined;
  const rawType = String(value(row, 'parkingForCarType', 'type', 'Type') || 'Any').toLowerCase();
  const type = rawType === 'electric' ? 'electric' : rawType === 'accessible' ? 'accessible' : 'any';
  const detectedCars = value(row, 'detectedCars', 'DetectedCars');
  return {
    id: String(value(row, 'name', 'Name', 'id', 'Id') || `spot-${rank}`),
    zoneId: String(value(row, 'zoneParent', 'ZoneParent') || ''),
    type,
    accessible: type === 'accessible' || bool(value(row, 'accessible', 'Accessible')),
    occupied: Array.isArray(detectedCars) ? detectedCars.length > 0 : bool(value(row, 'occupied', 'Occupied')),
    reserved: bool(value(row, 'reserved', 'Reserved')),
    broken: bool(value(row, 'broken', 'Broken')),
    underMaintenance: bool(value(row, 'isUnderMaintenance', 'underMaintenance', 'UnderMaintenance')),
    reachable: value(row, 'reachable', 'Reachable') === undefined ? true : bool(value(row, 'reachable', 'Reachable')),
    zoneSafe: value(row, 'zoneSafe', 'ZoneSafe') === undefined ? true : bool(value(row, 'zoneSafe', 'ZoneSafe')),
    rank
  };
}

function normalizeDevices(rows: Json[], kind: string) {
  return rows.map((row) => {
    const broken = bool(value(row, 'broken', 'Broken'));
    const underMaintenance = bool(value(row, 'isUnderMaintenance', 'underMaintenance', 'UnderMaintenance'));
    return {
      ...row,
      id: String(value(row, 'name', 'Name', 'id', 'Id') || randomUUID()),
      kind,
      zoneId: value(row, 'zoneParent', 'ZoneParent', 'zoneId', 'ZoneId') || null,
      status: broken ? 'broken' : underMaintenance ? 'under-maintenance' : value(row, 'isOn', 'IsOn') !== undefined ? (bool(value(row, 'isOn', 'IsOn')) ? 'on' : 'off') : String(value(row, 'state', 'State') || 'healthy')
    };
  });
}

export class HttpSimulatorGateway implements SimulatorGateway {
  private token: string | undefined;
  private discoveryWarnings: string[] = [];
  private state: GatewayHealth = { connected: false, runId: undefined, discoveryComplete: false, lastError: undefined, checkedAt: undefined };
  private readonly boundary: WebhookBoundary;

  constructor(private readonly config: Config, private readonly fetcher: Fetcher = fetch) {
    this.boundary = new WebhookBoundary(config.allowUnsignedSimulatorWebhooks);
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    const response = await this.fetcher(`${this.config.simulatorBaseUrl}${path}`, { ...init, headers });
    if (response.status === 401 && retry && this.token) { this.token = undefined; await this.login(); return this.request(path, init, false); }
    if (!response.ok) throw new Error(`simulator-http-${response.status}`);
    if (response.status === 204) return undefined as T;
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  }

  async login() {
    if (!this.config.simulatorName || !this.config.simulatorPassword) throw new Error('simulator-credentials-missing');
    const result = await this.request<{ token?: string; accessToken?: string }>('/api/v1/auth/login', {
      method: 'POST', body: JSON.stringify({ Email: this.config.simulatorName, Password: this.config.simulatorPassword })
    });
    this.token = result.token || result.accessToken;
    if (!this.token) throw new Error('simulator-token-missing');
    this.state = { connected: true, runId: undefined, discoveryComplete: false, lastError: undefined, checkedAt: new Date().toISOString() };
  }

  private async list<T>(path: string): Promise<T[]> {
    const result = await this.request<T[] | { items?: T[] }>(path);
    return Array.isArray(result) ? result : result.items || [];
  }

  private async optionalList<T>(path: string): Promise<T[]> {
    return this.optional(path, () => this.list<T>(path), []);
  }

  private async optionalObject(path: string): Promise<Json> {
    return this.optional(path, () => this.request<Json>(path), {});
  }

  private async optional<T>(path: string, request: () => Promise<T>, fallback: T): Promise<T> {
    try { return await request(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.endsWith('404')) this.discoveryWarnings.push(`${path}:${message}`);
      return fallback;
    }
  }

  async discover(): Promise<SimulatorSnapshot> {
    try {
      if (!this.token) await this.login();
      this.discoveryWarnings = [];
      const [rawSpots, rawBarriers, rawLights, rawFans, rawAlarms, zones, status] = await Promise.all([
        this.list<Json>('/api/v1/list-parking-spots'),
        this.optionalList<Json>('/api/v1/list-barriers'),
        this.optionalList<Json>('/api/v1/list-lights'),
        this.optionalList<Json>('/api/v1/list-exhaust-fans'),
        this.optionalList<Json>('/api/v1/list-alarms'),
        this.optionalList<Json>('/api/v1/list-zones'),
        this.optionalObject('/api/v1/status')
      ]);
      if (this.discoveryWarnings.length) throw new Error(`simulator-discovery-incomplete:${this.discoveryWarnings.join(',')}`);
      const spots = rawSpots.map(normalizeSpot).filter((spot): spot is SpotCandidate => Boolean(spot));
      if (!spots.length) throw new Error('simulator-level-not-loaded');
      const barriers = normalizeDevices(rawBarriers, 'barrier-gate');
      const lights = normalizeDevices(rawLights, 'light');
      const fans = normalizeDevices(rawFans, 'exhaust-fan');
      const alarms = normalizeDevices(rawAlarms, 'alarm');
      const levelId = String(value(status, 'levelId', 'LevelId', 'level', 'Level') || 'lvl1');
      const remoteRunId = value(status, 'runId', 'RunId');
      const runId = String(remoteRunId || `local-${createHash('sha256').update(`${this.config.simulatorBaseUrl}|${levelId}`).digest('hex').slice(0, 24)}`);
      const snapshot = { runId, levelId, spots, components: [], zones, barriers, lights, fans, alarms, topology: [] };
      this.boundary.setRunId(runId);
      this.state = { connected: true, runId, discoveryComplete: true, lastError: undefined, checkedAt: new Date().toISOString() };
      return snapshot;
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      this.state = { connected: false, runId: undefined, discoveryComplete: false, lastError, checkedAt: new Date().toISOString() };
      throw error;
    }
  }

  async send(command: SimulatorCommand): Promise<CommandAcceptance> {
    try {
      if (!this.token) await this.login();
      const target = command.target.startsWith('/') ? command.target : `/api/v1/${command.target}`;
      const result = await this.request<{ id?: string }>(target, { method: 'POST' });
      return { accepted: true, outcome: 'accepted', externalId: result?.id, error: undefined };
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      this.state = { connected: false, runId: undefined, discoveryComplete: false, lastError, checkedAt: new Date().toISOString() };
      const rejected = lastError.startsWith('simulator-http-4');
      return { accepted: false, outcome: rejected ? 'rejected' : 'unknown', externalId: undefined, error: lastError };
    }
  }

  async reconcile() {
    return this.discover();
  }

  health() {
    return this.state;
  }

  webhookBoundary() { return this.boundary; }
}

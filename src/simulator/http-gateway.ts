import type { Config } from '../config.js';
import type { SimulatorCommand, SimulatorSnapshot, SpotCandidate } from '../domain/types.js';
import type { CommandAcceptance, GatewayHealth, SimulatorGateway } from './contracts.js';
import { WebhookBoundary } from './webhook-boundary.js';

type Fetcher = typeof fetch;

export class HttpSimulatorGateway implements SimulatorGateway {
  private token: string | undefined;
  private state: GatewayHealth = { connected: false, runId: undefined, lastError: undefined, checkedAt: undefined };
  private readonly boundary = new WebhookBoundary();

  constructor(private readonly config: Config, private readonly fetcher: Fetcher = fetch) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    const response = await this.fetcher(`${this.config.simulatorBaseUrl}${path}`, { ...init, headers });
    if (!response.ok) throw new Error(`simulator-http-${response.status}`);
    return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
  }

  async login() {
    if (!this.config.simulatorName || !this.config.simulatorPassword) throw new Error('simulator-credentials-missing');
    const result = await this.request<{ token?: string; accessToken?: string }>('/api/v1/auth/login', {
      method: 'POST', body: JSON.stringify({ Name: this.config.simulatorName, Password: this.config.simulatorPassword })
    });
    this.token = result.token || result.accessToken;
    if (!this.token) throw new Error('simulator-token-missing');
    this.state = { connected: true, runId: undefined, lastError: undefined, checkedAt: new Date().toISOString() };
  }

  private async list<T>(path: string): Promise<T[]> {
    const result = await this.request<T[] | { items?: T[] }>(path);
    return Array.isArray(result) ? result : result.items || [];
  }

  private async optionalList<T>(path: string): Promise<T[]> {
    try { return await this.list<T>(path); } catch { return []; }
  }

  async discover(): Promise<SimulatorSnapshot> {
    if (!this.token) await this.login();
    const [spots, barriers, lights, fans, alarms, zones, topology] = await Promise.all([
      this.list<SpotCandidate>('/api/v1/parking-spots'),
      this.optionalList<Record<string, unknown>>('/api/v1/barriers'),
      this.optionalList<Record<string, unknown>>('/api/v1/lights'),
      this.optionalList<Record<string, unknown>>('/api/v1/fans'),
      this.optionalList<Record<string, unknown>>('/api/v1/alarms'),
      this.optionalList<Record<string, unknown>>('/api/v1/zones'),
      this.optionalList<Record<string, unknown>>('/api/v1/topology')
    ]);
    const status = await this.optionalStatus();
    const runId = String(status?.runId || status?.RunId || 'unknown-run');
    const components = [...barriers, ...lights, ...fans, ...alarms];
    const snapshot = { runId, levelId: String(status?.levelId || status?.LevelId || 'lvl1'), spots, components, zones, barriers, lights, fans, alarms, topology };
      this.state = { connected: true, runId, lastError: undefined, checkedAt: new Date().toISOString() };
    return snapshot;
  }

  private async optionalStatus() {
    try { return await this.request<Record<string, unknown>>('/api/v1/status'); } catch { return undefined; }
  }

  async send(command: SimulatorCommand): Promise<CommandAcceptance> {
    try {
      if (!this.token) await this.login();
      const target = command.target.startsWith('/') ? command.target : `/api/v1/${command.target}`;
      const result = await this.request<{ id?: string }>(target, { method: 'POST', body: JSON.stringify(command.payload) });
      return { accepted: true, externalId: result?.id, error: undefined };
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      this.state = { connected: false, runId: undefined, lastError, checkedAt: new Date().toISOString() };
      return { accepted: false, externalId: undefined, error: lastError };
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

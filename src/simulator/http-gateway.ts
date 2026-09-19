import type { Config } from '../config.js';
import type { SimulatorCommand, SimulatorSnapshot, SpotCandidate } from '../domain/types.js';
import type { CommandAcceptance, GatewayHealth, SimulatorGateway } from './contracts.js';

type Fetcher = typeof fetch;

export class HttpSimulatorGateway implements SimulatorGateway {
  private token: string | undefined;
  private state: GatewayHealth = { connected: false, runId: undefined, lastError: undefined, checkedAt: undefined };

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

  async discover(): Promise<SimulatorSnapshot> {
    if (!this.token) await this.login();
    const [spots, components, zones, barriers, lights, fans, alarms, topology] = await Promise.all([
      this.list<SpotCandidate>('/api/v1/parking-spots'),
      this.list<Record<string, unknown>>('/api/v1/components'),
      this.list<Record<string, unknown>>('/api/v1/zones'),
      this.list<Record<string, unknown>>('/api/v1/barriers'),
      this.list<Record<string, unknown>>('/api/v1/lights'),
      this.list<Record<string, unknown>>('/api/v1/fans'),
      this.list<Record<string, unknown>>('/api/v1/alarms'),
      this.list<Record<string, unknown>>('/api/v1/topology')
    ]);
    const runId = String((await this.request<Record<string, unknown>>('/api/v1/status')).runId || 'unknown-run');
    const snapshot = { runId, levelId: 'lvl1', spots, components, zones, barriers, lights, fans, alarms, topology };
      this.state = { connected: true, runId, lastError: undefined, checkedAt: new Date().toISOString() };
    return snapshot;
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
}

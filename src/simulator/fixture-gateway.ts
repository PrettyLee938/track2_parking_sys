import type { SimulatorCommand, SimulatorSnapshot } from '../domain/types.js';
import type { CommandAcceptance, GatewayHealth, SimulatorGateway } from './contracts.js';
import { WebhookBoundary } from './webhook-boundary.js';

export class FixtureGateway implements SimulatorGateway {
  readonly commands: SimulatorCommand[] = [];
  private connected = false;
  private readonly snapshot: SimulatorSnapshot;
  private readonly boundary = new WebhookBoundary();

  constructor(snapshot?: Partial<SimulatorSnapshot>) {
    this.snapshot = {
      runId: 'fixture-run', levelId: 'lvl1', spots: [], components: [], zones: [], barriers: [], lights: [], fans: [], alarms: [], topology: [], ...snapshot
    };
  }

  async login() {
    this.connected = true;
  }

  async discover() {
    this.connected = true;
    return this.snapshot;
  }

  async send(command: SimulatorCommand): Promise<CommandAcceptance> {
    if (!this.connected) return { accepted: false, externalId: undefined, error: 'simulator-not-connected' };
    this.commands.push(command);
    return { accepted: true, externalId: `fixture-${command.id}`, error: undefined };
  }

  async reconcile() {
    return this.discover();
  }

  health(): GatewayHealth {
    return { connected: this.connected, runId: this.connected ? this.snapshot.runId : undefined, lastError: undefined, checkedAt: new Date().toISOString() };
  }

  webhookBoundary() { return this.boundary; }
}

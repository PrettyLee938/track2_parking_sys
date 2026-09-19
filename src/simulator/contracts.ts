import type { SimulatorCommand, SimulatorSnapshot } from '../domain/types.js';

export interface GatewayHealth {
  connected: boolean;
  runId: string | undefined;
  lastError: string | undefined;
  checkedAt: string | undefined;
}

export interface CommandAcceptance {
  accepted: boolean;
  externalId: string | undefined;
  error: string | undefined;
}

export interface SimulatorGateway {
  login(): Promise<void>;
  discover(): Promise<SimulatorSnapshot>;
  send(command: SimulatorCommand): Promise<CommandAcceptance>;
  reconcile(): Promise<SimulatorSnapshot>;
  health(): GatewayHealth;
}

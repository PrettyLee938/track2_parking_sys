import type { SimulatorCommand, SimulatorSnapshot } from '../domain/types.js';
import type { WebhookBoundary } from './webhook-boundary.js';

export interface GatewayHealth {
  connected: boolean;
  runId: string | undefined;
  lastError: string | undefined;
  checkedAt: string | undefined;
}

export interface CommandAcceptance {
  accepted: boolean;
  outcome: 'accepted' | 'rejected' | 'unknown';
  externalId: string | undefined;
  error: string | undefined;
}

export interface SimulatorGateway {
  login(): Promise<void>;
  discover(): Promise<SimulatorSnapshot>;
  send(command: SimulatorCommand): Promise<CommandAcceptance>;
  reconcile(): Promise<SimulatorSnapshot>;
  health(): GatewayHealth;
  webhookBoundary(): WebhookBoundary;
}

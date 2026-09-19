export type Role = 'admin' | 'operator';
export type CarType = 'normal' | 'electric';
export type CommandStatus = 'pending' | 'rejected' | 'confirmed' | 'unknown' | 'cancelled';
export type RunStatus = 'active' | 'reconciling' | 'ambiguous' | 'closed';

export interface SpotCandidate {
  id: string;
  zoneId?: string;
  type: 'any' | 'electric' | 'accessible';
  accessible: boolean;
  occupied: boolean;
  reserved: boolean;
  broken: boolean;
  underMaintenance: boolean;
  reachable: boolean;
  zoneSafe: boolean;
  rank: number;
}

export interface AllocationRequest {
  carType: CarType;
  accessible: boolean;
  needsCharging: boolean;
  spots: SpotCandidate[];
}

export interface InvoiceInput {
  durationMinutes: number;
  parkingRateCentsPerHour: number;
  electricityKwh: number;
  electricityRateCentsPerKwh: number;
}

export interface InvoiceTotal {
  parkingCents: number;
  electricityCents: number;
  totalCents: number;
}

export interface SimulatorCommand {
  id: string;
  kind: string;
  target: string;
  payload: Record<string, unknown>;
}

export interface SimulatorSnapshot {
  runId: string;
  levelId: string;
  spots: SpotCandidate[];
  components: Record<string, unknown>[];
  zones: Record<string, unknown>[];
  barriers?: Record<string, unknown>[];
  lights?: Record<string, unknown>[];
  fans?: Record<string, unknown>[];
  alarms?: Record<string, unknown>[];
  topology?: Record<string, unknown>[];
}

export interface NormalizedEvent {
  eventId: string;
  type: string;
  sequenceId: number;
  runId: string | undefined;
  receivedAt: string;
  payload: Record<string, unknown>;
}

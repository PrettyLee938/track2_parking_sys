// Event, time-series, and statistics contracts.
// ---------------------------------------------------------------------------
// logs & statistics
// ---------------------------------------------------------------------------
/** GET /api/events - received webhooks, searchable. */
export interface EventView {
  id: number;
  received_at: string;
  event_class: string;
  plate: string | null;
  spot: string | null;
  direction: string | null;
  sig: string | null;
  accepted: boolean;
  payload: Record<string, unknown>;
}
export interface EventsResponse { items: EventView[] }

/** GET /api/timeseries - occupancy sampled by the server (in memory, recent only). */
export interface TimeseriesPoint {
  t: string;
  occupied: number;
  reserved: number;
  free: number;
  out_of_service: number;
  queued: number;
  capacity: number;
}
export interface TimeseriesResponse { sample_s: number; points: TimeseriesPoint[] }

/** GET /api/stats?minutes= - aggregates over a time window, from the database. */
export interface StatsResponse {
  since: string;
  until: string;
  bucket_s: number;
  totals: {
    arrivals: number;
    departures: number;
    turned_away: number;
    neglected: number;
    lost: number;
    revenue: number;
    avg_ticket: number;
    avg_planned_min: number;
    penalties: number;
    fines: number;
    payment_mismatches: number;
    escaped: number;
  };
  buckets: { t: string; arrivals: number; departures: number; revenue: number; turned_away: number; penalties: number }[];
  stay_histogram: { minutes: number; count: number }[];
  spot_usage: { spot: string; visits: number }[];
  penalties_by_reason: { reason: string; count: number; fines: number }[];
  gate_cycles: { gate: string; opens: number }[];
  commands: { cmd: string; count: number; failed: number; avg_ms: number; p95_ms: number }[];
}

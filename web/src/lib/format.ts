/** Display helpers - one place for how numbers and times look. */
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat();
const money = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtInt = (n: number) => (Math.abs(n) >= 10_000 ? compact.format(n) : whole.format(Math.round(n)));
export const fmtMoney = (n: number) => money.format(n);
export const fmtPct = (n: number, digits = 0) => `${(n * 100).toFixed(digits)}%`;

export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const fmtTimeSec = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Simulator ServerDateTime "2026-09-19 16:29:21" -> "16:29:21". */
export const simClock = (s: string | null) => (s ? s.slice(11, 19) : "—");

export function fmtDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return m < 60 ? `${m}m ${r.toString().padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${(m % 60).toString().padStart(2, "0")}m`;
}

export function ago(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

/** Human names for car statuses. */
export const STATUS_LABEL: Record<string, string> = {
  queued: "Waiting at entry", dispatching: "Gate opening", dispatched: "Admitted", entering: "Driving in",
  parked: "Parked", to_exit: "Driving to exit", at_exit: "At exit", invoiced: "Invoiced", payment_mismatch: "Payment mismatch",
  released: "Leaving", turned_away: "Turned away", neglected: "Gave up waiting", lost: "Record lost", unknown: "Unknown", gone: "Completed",
};

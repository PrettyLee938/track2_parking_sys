/** Time conversion helpers shared by the parking controller and its reports. */

export const nowSeconds = () => Date.now() / 1000;

/** Seconds between simulator ServerDateTime stamps (`YYYY-MM-DD HH:mm:ss`). */
export function simSecondsBetween(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start.replace(" ", "T"));
  const b = Date.parse(end.replace(" ", "T"));
  return Number.isNaN(a) || Number.isNaN(b) ? null : (b - a) / 1000;
}

export const timestampSeconds = (iso?: string | null): number | null => {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? null : timestamp / 1000;
};

export const integerOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
};

export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

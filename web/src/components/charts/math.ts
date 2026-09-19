export const M = { l: 48, r: 20, t: 14, b: 26 };

/**
 * Clean axis: a round step (1 / 2 / 2.5 / 5 x 10^k) giving about `ticks` intervals, and
 * the top rounded up to a whole number of steps - 30 -> 0/10/20/30, 510 -> 0/200/400/600.
 * Counts never get fractional ticks.
 */
export function niceScale(dataMax: number, ticks = 4, integer = true): { max: number; values: number[] } {
  let step: number;
  if (!(dataMax > 0)) step = 1;
  else {
    const raw = dataMax / ticks, p = 10 ** Math.floor(Math.log10(raw));
    step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  }
  if (integer) step = Math.max(1, Math.ceil(step));
  const max = Math.max(step, Math.ceil(dataMax / step - 1e-9) * step);
  return { max, values: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step) };
}

/** Show every k-th category label so labels of this text length never overlap. */
export function labelEvery(labels: string[], plotWidth: number): number {
  const longest = Math.max(1, ...labels.map((l) => l.length));
  const needed = longest * 6.5 + 14; // ~px per character at 11px, plus a gap
  return Math.max(1, Math.ceil((labels.length * needed) / Math.max(1, plotWidth)));
}

/**
 * Hand-built SVG charts (no chart library).
 *
 * Mark specs: 2px lines, ~10% area wash, bars <= 24px with a 4px rounded data-end and a
 * square baseline, hairline solid grid, end markers with a 2px surface ring. A legend is
 * shown for 2+ series; values are labelled selectively (the latest / the largest); every
 * chart has a hover tooltip and a table view. Colors come from CSS custom properties
 * (validated categorical slots --s1/--s2, status tokens, sequential --seq-*).
 */
import { useMemo, useState, type ReactNode } from "react";
import { useWidth } from "../lib/useWidth";

export interface Column { key: string; label: string; align?: "right" }
export interface TableData { columns: Column[]; rows: Record<string, ReactNode>[] }

/** Card body with a Chart/Table switch - the table is the accessible twin of the chart. */
export function ChartFrame({ title, subtitle, legend, table, children }:
  { title: string; subtitle?: string; legend?: ReactNode; table: TableData; children: ReactNode }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <section className="card chart-card">
      <header className="card-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="muted small">{subtitle}</p>}
        </div>
        <div className="view-toggle" role="radiogroup" aria-label={`${title} view`}>
          {(["chart", "table"] as const).map((v) => (
            <button key={v} role="radio" aria-checked={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {v === "chart" ? "Chart" : "Table"}
            </button>
          ))}
        </div>
      </header>
      {view === "chart" ? <>{legend}{children}</> : <DataTable data={table} />}
    </section>
  );
}

export function DataTable({ data }: { data: TableData }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr>{data.columns.map((c) => <th key={c.key} className={c.align}>{c.label}</th>)}</tr></thead>
        <tbody>
          {data.rows.length ? data.rows.map((r, i) => (
            <tr key={i}>{data.columns.map((c) => <td key={c.key} className={c.align}>{r[c.key]}</td>)}</tr>
          )) : <tr><td colSpan={data.columns.length} className="muted">No data in this range</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; kind?: "line" | "box" }[] }) {
  return (
    <ul className="legend">
      {items.map((i) => (
        <li key={i.label}><span className={`key ${i.kind ?? "box"}`} style={{ background: i.color }} />{i.label}</li>
      ))}
    </ul>
  );
}

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
function labelEvery(labels: string[], plotWidth: number): number {
  const longest = Math.max(1, ...labels.map((l) => l.length));
  const needed = longest * 6.5 + 14; // ~px per character at 11px, plus a gap
  return Math.max(1, Math.ceil((labels.length * needed) / Math.max(1, plotWidth)));
}

const M = { l: 48, r: 20, t: 14, b: 26 };

// ---------------------------------------------------------------------------
// line / area over time
// ---------------------------------------------------------------------------
export interface Series { key: string; label: string; color: string; values: (number | null)[] }

export function LineChart({ x, series, height = 220, area = false, reference, yMax, format = String, tickFormat, xFormat = String, ariaLabel }: {
  x: string[]; series: Series[]; height?: number; area?: boolean; reference?: { value: number; label: string };
  yMax?: number; format?: (n: number) => string; tickFormat?: (n: number) => string; xFormat?: (s: string) => string; ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = x.length;
  const w = width - M.l - M.r, h = height - M.t - M.b;
  const dataMax = Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)), reference?.value ?? 0);
  const { max, values: ticks } = niceScale(yMax ?? dataMax);
  const px = (i: number) => M.l + (n <= 1 ? w / 2 : (i * w) / (n - 1));
  const py = (v: number) => M.t + h - (v / max) * h;
  const fmtTick = tickFormat ?? format;
  const xTicks = n ? Array.from(new Set([0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1])) : [];

  const paths = useMemo(() => series.map((s) => {
    let d = "", open = false;
    s.values.forEach((v, i) => {
      if (v === null) { open = false; return; }
      d += `${open ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`;
      open = true;
    });
    return d;
  }), [series, width, height, max, n]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };

  const last = n - 1;
  return (
    <div className="chart" ref={ref} style={{ height }}>
      {n === 0 ? <p className="empty">Collecting data…</p> : (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={M.l + w} y1={py(t)} y2={py(t)} className={t === 0 ? "axis" : "grid"} />
              <text x={M.l - 8} y={py(t)} className="tick" textAnchor="end" dominantBaseline="middle">{fmtTick(t)}</text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={px(i)} y={height - 6} className="tick" textAnchor={i === 0 ? "start" : i === last ? "end" : "middle"}>{xFormat(x[i])}</text>
          ))}
          {reference && (
            <g>
              <line x1={M.l} x2={M.l + w} y1={py(reference.value)} y2={py(reference.value)} className="reference" />
              <text x={M.l + 4} y={py(reference.value) - 5} className="tick">{reference.label}</text>
            </g>
          )}
          {area && series[0] && paths[0] && (
            <path d={`${paths[0]}L${px(last).toFixed(1)},${py(0)}L${px(series[0].values.findIndex((v) => v !== null)).toFixed(1)},${py(0)}Z`}
              fill={series[0].color} opacity={0.1} />
          )}
          {series.map((s, k) => <path key={s.key} d={paths[k]} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
          {series.map((s) => s.values[last] !== null && (
            <g key={s.key}>
              <circle cx={px(last)} cy={py(s.values[last]!)} r={4} fill={s.color} className="ring" />
              {series.length === 1 && <text x={px(last) - 8} y={py(s.values[last]!) - 10} className="value-label" textAnchor="end">{format(s.values[last]!)}</text>}
            </g>
          ))}
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={px(hover)} x2={px(hover)} y1={M.t} y2={M.t + h} className="crosshair" />
              {series.map((s) => s.values[hover] !== null && <circle key={s.key} cx={px(hover)} cy={py(s.values[hover]!)} r={4} fill={s.color} className="ring" />)}
            </g>
          )}
          <rect x={M.l} y={M.t} width={w} height={h} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}
      {hover !== null && n > 0 && (
        <div className="tooltip" style={{ left: Math.min(px(hover) + 12, width - 170), top: M.t }}>
          <div className="tt-title">{xFormat(x[hover])}</div>
          {series.map((s) => (
            <div key={s.key} className="tt-row"><span className="key line" style={{ background: s.color }} />{s.label}
              <b>{s.values[hover] === null ? "—" : format(s.values[hover]!)}</b></div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// columns (one series)
// ---------------------------------------------------------------------------
export function ColumnChart({ data, height = 200, color = "var(--s1)", format = String, tickFormat, ariaLabel }: {
  data: { label: string; value: number; hint?: string }[]; height?: number; color?: string;
  format?: (n: number) => string; tickFormat?: (n: number) => string; ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = data.length;
  const w = width - M.l - M.r, h = height - M.t - M.b;
  const { max, values: ticks } = niceScale(Math.max(0, ...data.map((d) => d.value)), 3);
  const band = n ? w / n : w;
  const bw = Math.max(2, Math.min(24, band - 2)); // <= 24px, >= 2px surface gap between neighbours
  const py = (v: number) => M.t + h - (v / max) * h;
  const base = M.t + h;
  const every = labelEvery(data.map((d) => d.label), w);
  const fmtTick = tickFormat ?? format;
  const peak = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? -1) ? i : best), 0);

  const column = (x: number, v: number) => {
    const y = py(v), r = Math.min(4, (base - y) / 2, bw / 2);
    if (base - y < 0.5) return "";
    return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${base}Z`;
  };

  return (
    <div className="chart" ref={ref} style={{ height }}>
      {n === 0 ? <p className="empty">No data in this range</p> : (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={M.l + w} y1={py(t)} y2={py(t)} className={t === 0 ? "axis" : "grid"} />
              <text x={M.l - 8} y={py(t)} className="tick" textAnchor="end" dominantBaseline="middle">{fmtTick(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = M.l + i * band + (band - bw) / 2;
            return (
              <g key={i}>
                <path d={column(x, d.value)} fill={color} opacity={hover === null || hover === i ? 1 : 0.55} />
                {i % every === 0 && <text x={x + bw / 2} y={height - 6} className="tick" textAnchor="middle">{d.label}</text>}
                {i === peak && d.value > 0 && <text x={x + bw / 2} y={py(d.value) - 6} className="value-label" textAnchor="middle">{format(d.value)}</text>}
                <rect x={M.l + i * band} y={M.t} width={band} height={h} fill="transparent"
                  onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && data[hover] && (
        <div className="tooltip" style={{ left: Math.min(M.l + hover * band + band, width - 170), top: M.t }}>
          <div className="tt-title">{data[hover].hint ?? data[hover].label}</div>
          <div className="tt-row"><span className="key box" style={{ background: color }} />{format(data[hover].value)}</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// horizontal bars for ranked categories (HTML: labels never clip)
// ---------------------------------------------------------------------------
export function BarList({ rows, format = String, color = "var(--s1)", empty = "No data in this range" }: {
  rows: { label: ReactNode; value: number; note?: ReactNode }[]; format?: (n: number) => string; color?: string; empty?: string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="empty">{empty}</p>;
  return (
    <ul className="barlist">
      {rows.map((r, i) => (
        <li key={i} title={typeof r.label === "string" ? r.label : undefined}>
          <span className="bl-label">{r.label}</span>
          <span className="bl-track">{r.value > 0 && <span className="bl-fill" style={{ width: `${(r.value / max) * 100}%`, background: color }} />}</span>
          <span className="bl-value">{format(r.value)}{r.note && <span className="muted"> {r.note}</span>}</span>
        </li>
      ))}
    </ul>
  );
}

/** Stacked 100% bar for a part-to-whole (e.g. a zone: occupied / reserved / free / out of service). */
export function StackBar({ parts, total }: { parts: { label: string; value: number; color: string }[]; total: number }) {
  return (
    <div className="stackbar" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
      {parts.filter((p) => p.value > 0).map((p) => (
        <span key={p.label} style={{ width: `${(p.value / Math.max(1, total)) * 100}%`, background: p.color }} title={`${p.label}: ${p.value}`} />
      ))}
    </div>
  );
}

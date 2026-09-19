import { useState } from "react";
import { useWidth } from "../../lib/useWidth";
import { labelEvery, M, niceScale } from "./math";

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

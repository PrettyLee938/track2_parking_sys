import { useMemo, useState } from "react";
import { useWidth } from "../../lib/useWidth";
import { M, niceScale } from "./math";

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
      {n === 0 ? <p className="empty">Collecting dataâ€¦</p> : (
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
              <b>{s.values[hover] === null ? "â€”" : format(s.values[hover]!)}</b></div>
          ))}
        </div>
      )}
    </div>
  );
}

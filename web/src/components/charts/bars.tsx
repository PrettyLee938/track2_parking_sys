import type { ReactNode } from "react";

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

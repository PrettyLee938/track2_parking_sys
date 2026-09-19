import { useState, type ReactNode } from "react";

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

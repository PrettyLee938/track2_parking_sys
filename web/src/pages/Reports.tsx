import { useEffect, useState } from "react";
import type { DailyReport } from "@gpa/shared";
import { Badge, Card, Empty, Segmented, Tile } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDateTime, fmtInt, fmtMoney } from "../lib/format";

export function Reports() {
  const { can } = useAuth();
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [kind, setKind] = useState<"operations" | "financial">("operations");
  const [report, setReport] = useState<DailyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let alive = true; api.dailyReport(day, kind).then((r) => alive && (setReport(r), setError(null))).catch((e) => alive && setError(e.message)); return () => { alive = false; }; }, [day, kind]);
  return <div className="page">
    <div className="filter-row"><input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Report day" />
      <Segmented label="Report type" value={kind} onChange={setKind} options={[{ value: "operations", label: "Operations" }, ...(can("admin") ? [{ value: "financial" as const, label: "Financial" }] : [])]} />
      <a className="btn" href={api.dailyReportExportUrl(day, kind)}>Export CSV</a></div>
    {error && <p className="form-error">{error}</p>}
    {report ? <ReportBody report={report} /> : <Empty>Loading report...</Empty>}
  </div>;
}

function ReportBody({ report }: { report: DailyReport }) {
  const totals = report.totals;
  return <>
    <Card title={`${report.kind === "financial" ? "Financial" : "Operations"} report · ${report.day}`} subtitle={`Generated ${fmtDateTime(report.generated_at)} · ${report.time_basis}`}>
      <div className="tiles">{Object.entries(totals).map(([key, value]) => <Tile key={key} label={key.replaceAll("_", " ")} value={key.includes("revenue") || key.includes("fines") ? fmtMoney(value) : fmtInt(value)} />)}</div>
      {report.provisional && <p className="muted small">This report is provisional until simulator calendar anchoring is available.</p>}
    </Card>
    <div className="grid-2">
      <Card title="Incidents"><CompactList items={report.incidents.map((i) => `#${i.id} ${i.kind}: ${i.reason}`)} empty="No incidents for this report." /></Card>
      <Card title="Penalties"><CompactList items={report.penalties.map((p) => `${fmtMoney(p.fine)} · ${p.reason}`)} empty="No penalties for this report." /></Card>
    </div>
    <Card title="Equipment snapshot"><CompactList items={report.equipment.map((e) => `${String(e.kind ?? "equipment")} ${String(e.name ?? "")}: ${String(e.health ?? "unknown")}`)} empty="No equipment recorded." /></Card>
    <div className="grid-2">
      <Card title="Security decisions"><CompactList items={(report.security_events ?? []).map((e) => `${e.decision} · ${e.event_class ?? "request"} · ${e.reason}`)} empty="No security events for this report." /></Card>
      <Card title="Maintenance activity"><CompactList items={(report.maintenance ?? []).map((m) => `${m.component_kind}:${m.component_name} · ${m.status} · ${m.reason}`)} empty="No maintenance jobs for this report." /></Card>
    </div>
    <Card title="Audit trail"><CompactList items={(report.audit ?? []).map((a) => `${a.actor ?? "system"} · ${a.action} · ${a.target ?? "-"}`)} empty="No audit entries for this report." /></Card>
  </>;
}

function CompactList({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? <ul className="plain-list">{items.slice(0, 50).map((x, i) => <li key={`${x}-${i}`}>{x}</li>)}</ul> : <Empty>{empty}</Empty>;
}

import { useEffect, useState } from "react";
import type { DailyReportFinancial, DailyReportView } from "@gpa/shared";
import { Card, Empty } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDateTime, fmtInt, fmtMoney } from "../lib/format";

const todayUtc = () => new Date().toISOString().slice(0, 10);
const utcStamp = (iso: string) => new Date(iso).toISOString().replace("T", " ").replace(".000Z", " UTC");

export function DailyReports({ maintenanceOnly = false }: { maintenanceOnly?: boolean }) {
  const { can } = useAuth();
  const isAdmin = can("admin");
  const [day, setDay] = useState(todayUtc);
  const [report, setReport] = useState<DailyReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      setLoading(true);
      setError(null);
      api.dailyReport(day, maintenanceOnly ? "maintenance" : isAdmin ? "financial" : "operations")
        .then((r) => { if (alive) setReport(r); })
        .catch((e) => { if (alive) { setReport(null); setError((e as Error).message); } })
        .finally(() => { if (alive) setLoading(false); });
    };
    refresh();
    const timer = setInterval(refresh, 10_000); // database only; the route never polls the simulator
    return () => { alive = false; clearInterval(timer); };
  }, [day, isAdmin, maintenanceOnly]);

  const kind = maintenanceOnly ? "maintenance" : isAdmin ? "financial" : "operations";
  const exportUrl = `/api/reports/daily/export?${new URLSearchParams({ day, kind })}`;

  return (
    <div className="page">
      <div className="filters">
        <label>Report date (UTC)
          <input type="date" value={day} max={todayUtc()} onChange={(e) => setDay(e.target.value)} aria-label="Report date in UTC" />
        </label>
        <a className="btn primary" href={exportUrl}>Download CSV</a>
      </div>
      <p className="banner">Provisional date basis: this report uses persisted server UTC timestamps, not the simulator’s calendar day. Simulator day and run identity are unavailable.</p>
      {error && <p className="form-error">{error}</p>}
      {loading && !report ? <Empty>Loading report…</Empty> : report && (
        <>
      <Card title={`${maintenanceOnly ? "Maintenance daily summary" : "Daily report"} · ${report.requested_utc_day} UTC`} subtitle={`${utcStamp(report.period_start_utc)} to ${utcStamp(report.period_end_utc_exclusive)} (end exclusive) · generated ${fmtDateTime(report.generated_at)}`}>
        <div className="table-wrap">
          <table className="data compact">
            <thead><tr><th>{maintenanceOnly ? "Equipment metric" : "Operational metric"}</th><th className="right">Value</th></tr></thead>
            <tbody>
              {"maintenance" in report ? <>
                <Metric label="Maintenance requests during selected UTC day" value={fmtInt(report.maintenance.maintenance_requests)} />
                <Metric label="Repairs currently completed" value={fmtInt(report.maintenance.completed_repairs_current_status)} />
                <Metric label="Active maintenance jobs" value={fmtInt(report.maintenance.active_jobs_current_status)} />
                <Metric label="Failed maintenance jobs" value={fmtInt(report.maintenance.failed_jobs_current_status)} />
                <Metric label="Open equipment incidents" value={fmtInt(report.maintenance.open_equipment_incidents_current_status)} />
                <Metric label="Component failure events" value={fmtInt(report.maintenance.component_failure_events)} />
                <Metric label="Component recovery events" value={fmtInt(report.maintenance.component_recovery_events)} />
                <Metric label="CO events" value={fmtInt(report.maintenance.co_events)} />
                <Metric label="Peak CO level" value={report.maintenance.peak_co_level ?? "Unavailable"} />
              </> : <>
                <Metric label="Arrivals" value={fmtInt(report.operational.arrivals)} />
                <Metric label="Admissions" value={fmtInt(report.operational.admissions)} />
                <Metric label="Completed departures" value={fmtInt(report.operational.completed_departures)} />
                <Metric label="Turnaways" value={fmtInt(report.operational.turnaways)} />
                <Metric label="Abandoned visits" value={fmtInt(report.operational.abandoned_visits)} />
                <Metric label="Lost visits" value={fmtInt(report.operational.lost_visits)} />
                <Metric label="Accepted simulator penalties" value={fmtInt(report.operational.accepted_simulator_penalties)} />
                <Metric label="Component failure events" value={fmtInt(report.operational.component_failure_events)} />
                <Metric label="Component recovery events" value={fmtInt(report.operational.component_recovery_events)} />
                <Metric label="CO events" value={fmtInt(report.operational.co_events)} />
                <Metric label="Peak CO level" value={report.operational.peak_co_level ?? "Unavailable"} />
              </>}
            </tbody>
          </table>
        </div>
      </Card>
      {isAdmin && "financial" in report && report.financial && <FinancialReport financial={report.financial} />}
          {report.unavailable_metrics.length > 0 && (
            <Card title="Unavailable metrics" subtitle="Not inferred or filled with zero when the source data is unavailable">
              <ul className="plain-list">{report.unavailable_metrics.map((item) => <li key={item}>{item}</li>)}</ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function FinancialReport({ financial: f }: { financial: DailyReportFinancial }) {
  const rows: [string, string][] = [
    ["Invoices created during UTC day", fmtInt(f.invoices_created)],
    ["Invoices currently issued or settled", fmtInt(f.invoices_issued_current_status)],
    ["Verified payments (count)", fmtInt(f.verified_payments_count)],
    ["Verified payments", fmtMoney(f.verified_payments_minor / 100)],
    ["Outstanding invoices (current state)", fmtInt(f.outstanding_invoices_current_status)],
    ["Uncertain payment outcomes", fmtInt(f.uncertain_payment_outcomes_current_status)],
    ["Waived invoices (current state)", fmtInt(f.waived_invoices_current_status)],
    ["Waived total (current state)", fmtMoney(f.waived_total_minor_current_status / 100)],
    ["Financial adjustments (count)", fmtInt(f.financial_adjustments_count)],
    ["Financial adjustment amount", fmtMoney(f.financial_adjustments_amount_minor_recorded / 100)],
    ["Waiver records / amount", `${fmtInt(f.waiver_records_count)} / ${fmtMoney(f.waiver_amount_minor_recorded / 100)}`],
    ["Emergency releases / amount", `${fmtInt(f.emergency_release_records_count)} / ${fmtMoney(f.emergency_release_amount_minor_recorded / 100)}`],
    ["Known simulator fines", fmtMoney(f.known_simulator_fines_minor / 100)],
    ["Fines with unknown amount", fmtInt(f.unknown_simulator_fine_amount_count)],
    ["Receipts after known simulator fines", f.receipts_after_known_simulator_fines_minor === null
      ? "Unavailable" : fmtMoney(f.receipts_after_known_simulator_fines_minor / 100)],
    ["Financial state as of", fmtDateTime(f.financial_state_as_of)],
  ];
  return (
    <Card title="Financial report" subtitle="Admin only · verified amounts; receipts after known simulator fines is not profit or net operating income">
      <div className="table-wrap">
        <table className="data compact">
          <thead><tr><th>Financial metric</th><th className="right">Value</th></tr></thead>
          <tbody>{rows.map(([label, value]) => <Metric key={label} label={label} value={value} />)}</tbody>
        </table>
      </div>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <tr><td>{label}</td><td className="right">{value}</td></tr>;
}

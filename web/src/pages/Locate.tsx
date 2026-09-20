/**
 * Find a vehicle (Level 3 §7.10).
 *
 * "Provide a function to locate vehicles, including cars that did not park in their
 * assigned spots." Type any part of a plate: cars still inside come from live state,
 * cars that have left from their last stored visit. The row that matters is the one
 * where the assigned spot and the actual spot disagree, so it is called out.
 */
import { useCallback, useEffect, useState } from "react";
import type { VehicleLocationView, VehicleTimelineEntry } from "@gpa/shared";
import { Badge, Button, Card, Empty } from "../components/ui";
import { api } from "../lib/api";
import { STATUS_LABEL, fmtDateTime, simClock } from "../lib/format";

export function Locate() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<VehicleLocationView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.vehicles(query).then((r) => { setItems(r.items); setError(null); })
      .catch((e) => setError((e as Error).message));
  }, [query]);
  // Cars move, so the list refreshes itself while the page is open.
  useEffect(() => {
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="page">
      <Card title="Find a vehicle" subtitle="Any part of a plate. Cars inside are shown live; cars that have left come from their last visit.">
        <div className="inline-form">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Plate, or part of one" aria-label="Plate" autoFocus />
          <Button onClick={load}>Search</Button>
          <span className="muted small">{items.length} match{items.length === 1 ? "" : "es"}</span>
        </div>
        {error && <p className="form-error">{error}</p>}
        {!items.length ? <Empty>{query ? "No vehicle matches." : "No cars inside right now - type a plate to search past visits."}</Empty> : (
          <div className="table-wrap tall">
            <table className="data">
              <thead><tr><th>Plate</th><th>Where</th><th>Zone</th><th>Sent to</th><th>Parked in</th><th>Invoice</th><th>Paid</th><th /></tr></thead>
              <tbody>
                {items.map((v) => (
                  <tr key={v.plate} className={selected === v.plate ? "clickable" : "clickable"} onClick={() => setSelected(v.plate === selected ? null : v.plate)}>
                    <td className="mono"><b>{v.plate}</b>{!v.active && <span className="muted small"> (past visit)</span>}</td>
                    <td>{v.where}</td>
                    <td>{v.zone ?? "—"}</td>
                    <td className="mono">{v.assigned_spot ?? "—"}</td>
                    <td className="mono">
                      {v.actual_spot ?? "—"}
                      {v.parked_elsewhere && <> <Badge tone="warning" title={`We sent it to ${v.assigned_spot}`}>not where we sent it</Badge></>}
                    </td>
                    <td className="right">{v.invoice_amount !== null ? v.invoice_amount.toFixed(2) : "—"}</td>
                    <td>{v.payment_ok === null ? <span className="muted">—</span>
                      : v.payment_ok ? <Badge tone="good">paid</Badge> : <Badge tone="critical">unpaid</Badge>}</td>
                    <td className="right"><Button small variant="ghost">{selected === v.plate ? "Hide" : "History"}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {selected && <VehicleDetail plate={selected} />}
    </div>
  );
}

function VehicleDetail({ plate }: { plate: string }) {
  const [timeline, setTimeline] = useState<VehicleTimelineEntry[] | null>(null);
  const [vehicle, setVehicle] = useState<VehicleLocationView | null>(null);
  useEffect(() => {
    setTimeline(null);
    api.vehicle(plate).then((r) => { setVehicle(r.vehicle); setTimeline(r.timeline); }).catch(() => setTimeline([]));
  }, [plate]);

  return (
    <Card title={`${plate}`} subtitle="Everything we received about this car and everything we sent about it, oldest first">
      {vehicle && (
        <dl className="details">
          <dt>Status</dt><dd>{STATUS_LABEL[vehicle.status] ?? vehicle.status} — {vehicle.where}</dd>
          <dt>Arrived</dt><dd className="mono">{simClock(vehicle.arrived_at)}</dd>
          <dt>Entrance / exit</dt><dd>{vehicle.entry_lane ?? "—"} / {vehicle.exit_lane ?? "—"}</dd>
          <dt>Sent to / parked in</dt>
          <dd>{vehicle.assigned_spot ?? "—"} / {vehicle.actual_spot ?? "—"}
            {vehicle.parked_elsewhere && <> <Badge tone="warning">parked somewhere else</Badge></>}</dd>
          <dt>Type</dt><dd>{vehicle.car_type}{vehicle.planned_minutes ? `, planned ${vehicle.planned_minutes} min` : ""}</dd>
          <dt>Invoice</dt>
          <dd>{vehicle.invoice_amount !== null ? vehicle.invoice_amount.toFixed(2) : "none"}
            {vehicle.invoice_status && <span className="muted"> ({vehicle.invoice_status})</span>}</dd>
          <dt>Payment</dt>
          <dd>{vehicle.paid !== null ? vehicle.paid.toFixed(2) : "nothing received"}
            {vehicle.payment_ok === false && <> <Badge tone="critical">not accepted</Badge></>}</dd>
        </dl>
      )}
      {!timeline ? <p className="muted">Loading…</p> : !timeline.length ? <Empty>Nothing recorded for this plate.</Empty> : (
        <div className="table-wrap tall">
          <table className="data compact">
            <thead><tr><th>When</th><th>Source</th><th>What</th><th>Detail</th></tr></thead>
            <tbody>
              {timeline.map((t, i) => (
                <tr key={i}>
                  <td className="mono">{fmtDateTime(t.at)}</td>
                  <td>{t.kind === "command" ? <Badge tone="info">we sent</Badge> : t.kind === "visit" ? <Badge tone="neutral">visit</Badge> : <Badge tone="neutral">received</Badge>}</td>
                  <td>{t.what}{!t.ok && <> <Badge tone="critical">failed</Badge></>}</td>
                  <td className="muted">{t.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

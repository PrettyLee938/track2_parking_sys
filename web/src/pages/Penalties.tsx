import { useEffect, useState } from "react";
import type { PenaltiesResponse, PenaltyDetailResponse, PenaltyResolutionStatus } from "@gpa/shared";
import { Badge, Button, Card, Empty } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDateTime, fmtMoney } from "../lib/format";

const todayUtc = () => new Date().toISOString().slice(0, 10);
const timeBasis = "server_utc_received_at_provisional";
const utcStamp = (iso: string) => new Date(iso).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");

export function Penalties() {
  const { can } = useAuth();
  const admin = can("admin");
  const [day, setDay] = useState(todayUtc);
  const [status, setStatus] = useState<PenaltyResolutionStatus | "">("");
  const [zone, setZone] = useState("");
  const [component, setComponent] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [reason, setReason] = useState("");
  const [data, setData] = useState<PenaltiesResponse | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PenaltyDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api.penalties({ day: day || undefined, resolution_status: status || undefined, zone: zone.trim() || undefined,
      component: component.trim() || undefined, vehicle: vehicle.trim() || undefined, reason: reason.trim() || undefined })
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) { setData(null); setError((e as Error).message); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [day, status, zone, component, vehicle, reason]);

  useEffect(() => {
    if (selectedId === null) { setDetail(null); setDetailError(null); return; }
    let alive = true;
    setDetailLoading(true);
    setDetailError(null);
    api.penaltyDetail(selectedId)
      .then((result) => { if (alive) setDetail(result); })
      .catch((e) => { if (alive) { setDetail(null); setDetailError((e as Error).message); } })
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [selectedId]);

  return (
    <div className="page">
      <div className="filters">
        <label>Received date (UTC)
          <input type="date" value={day} max={todayUtc()} onChange={(e) => setDay(e.target.value)} aria-label="Penalty received date in UTC" />
        </label>
        <select value={status} onChange={(e) => setStatus(e.target.value as PenaltyResolutionStatus | "")} aria-label="Penalty resolution status">
          <option value="">All statuses</option>
          <option value="unlinked">Unlinked</option><option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option>
        </select>
        <input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Zone" aria-label="Filter by zone" />
        <input value={component} onChange={(e) => setComponent(e.target.value)} placeholder="Component" aria-label="Filter by component" />
        <input value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="Vehicle / plate" aria-label="Filter by vehicle" />
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason contains…" aria-label="Filter by penalty reason" />
      </div>
      <p className="banner">These are accepted simulator penalties, separate from suspected incidents. Date filtering uses server UTC receipt time provisionally; simulator day/run identity is unavailable.</p>
      {error && <p className="form-error">{error}</p>}
      <Card title="Simulator penalties" subtitle={data?.time_basis === timeBasis ? "Fine amounts are shown only to Admin; unknown values are not estimated." : undefined}>
        {loading && !data ? <Empty>Loading penalties…</Empty> : !data?.items.length ? <Empty>No simulator penalties match this filter.</Empty> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Received (UTC)</th><th>Plate</th><th>Component</th><th>Zone</th><th>Reason</th><th>Status</th><th>Incident</th>{admin && <th className="right">Fine</th>}<th>Evidence</th></tr></thead>
              <tbody>{data.items.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{utcStamp(p.received_at)}</td>
                  <td className="mono">{p.plate ?? "—"}</td>
                  <td>{p.simulator_component_type && `${p.simulator_component_type} `}{p.component ?? "—"}</td>
                  <td>{p.zone ?? "—"}</td>
                  <td>{p.message ?? "Unknown simulator reason"}</td>
                  <td><Badge tone={p.resolution_status === "resolved" ? "good" : p.resolution_status === "open" ? "warning" : "neutral"}>{p.resolution_status}</Badge></td>
                  <td className="mono">{p.incident_id ?? "—"}</td>
                  {admin && <td className="right">{p.fine_minor !== null ? fmtMoney(p.fine_minor / 100) : p.fine_amount_raw ?? "Unknown"}</td>}
                  <td><Button small variant="ghost" onClick={() => setSelectedId(selectedId === p.id ? null : p.id)}>
                    {selectedId === p.id ? "Hide" : "View"}
                  </Button></td>
                </tr>
              ))}</tbody>
            </table>
            {selectedId !== null && <section className="card" aria-label="Penalty evidence detail">
              <header className="card-head"><div><h2>Penalty evidence</h2><p className="muted small">Context is time-bounded; it is not a causal diagnosis.</p></div>
                <Button small variant="ghost" onClick={() => setSelectedId(null)}>Close</Button></header>
              {detailLoading && <Empty>Loading evidence...</Empty>}
              {detailError && <p className="form-error">{detailError}</p>}
              {detail && <div>
                <p><strong>Simulator message:</strong> {detail.item.penalty.message ?? "Unknown simulator reason"}</p>
                <p><strong>Fine:</strong> {admin
                  ? detail.item.penalty.fine_minor !== null ? fmtMoney(detail.item.penalty.fine_minor / 100) : detail.item.penalty.fine_amount_raw ?? "Unknown"
                  : "Restricted to Admin"}</p>
                <p><strong>Related visit:</strong> {detail.item.related_visit
                  ? `${detail.item.related_visit.plate} - ${detail.item.related_visit.status}, spot ${detail.item.related_visit.spot ?? "unknown"} (${detail.item.visit_link})`
                  : detail.item.visit_link === "ambiguous" ? "Multiple candidate visits; no visit was selected."
                    : "No visit could be linked confidently."}</p>
                <p><strong>Related component:</strong> {detail.item.related_component
                  ? `${detail.item.related_component.simulator_type ?? "Unknown type"} ${detail.item.related_component.name}${detail.item.related_component.zone ? ` - ${detail.item.related_component.zone}` : ""}`
                  : "None identified."}</p>
                <p><strong>Suspected cause:</strong> {detail.item.suspected_cause.assessment} (confidence: {detail.item.suspected_cause.confidence}). {detail.item.suspected_cause.explanation}</p>
                <p><strong>Recovery:</strong> {detail.item.recovery_action.status}. {detail.item.recovery_action.explanation}</p>
                <h3>Nearby accepted events</h3>
                {!detail.item.nearby_events.length ? <p className="muted">No accepted events in the evidence window.</p> : <ul>
                  {detail.item.nearby_events.map((event) => <li key={event.id}>
                    <span className="mono">{utcStamp(event.received_at)}</span> - {event.event_class}
                    {event.event_id && <span> ({event.event_id})</span>}{event.plate && <span> - plate {event.plate}</span>}
                    {event.spot && <span> - {event.spot}</span>}{event.direction && <span> {event.direction}</span>}
                  </li>)}
                </ul>}
                <h3>Nearby commands (attempt evidence only)</h3>
                {!detail.item.nearby_commands.length ? <p className="muted">No command records in the evidence window.</p> : <ul>
                  {detail.item.nearby_commands.map((command) => <li key={`${command.source}-${command.id}`}>
                    <span className="mono">{utcStamp(command.at)}</span> - {command.cmd}({command.args.join(", ")}) - {command.outcome}
                    {command.actor && <span> by {command.actor}</span>}
                  </li>)}
                </ul>}
                <h3>Linked incident</h3>
                {detail.item.linked_incident ? <p>
                  <span className="mono">{detail.item.linked_incident.id}</span> - {detail.item.linked_incident.summary} ({detail.item.linked_incident.status})
                  {detail.item.linked_incident.latest_note && <span> Latest note: {detail.item.linked_incident.latest_note}</span>}
                </p> : <p className="muted">No linked incident.</p>}
              </div>}
            </section>}
          </div>
        )}
      </Card>
    </div>
  );
}

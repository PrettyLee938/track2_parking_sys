import { useCallback, useEffect, useState } from "react";
import type { CarView, IncidentStatus, IncidentView } from "@gpa/shared";
import { Badge, Button, Card, Empty, useToast } from "../components/ui";
import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { useAuth } from "../lib/auth";

type Filter = IncidentStatus | "";
const severityTone = (s: IncidentView["severity"]) => s === "critical" ? "critical" : s === "high" ? "serious" : s === "warning" ? "warning" : "neutral";

export function Incidents() {
  const { can } = useAuth();
  const [filter, setFilter] = useState<Filter>("open");
  const [items, setItems] = useState<IncidentView[]>([]);
  const [cars, setCars] = useState<CarView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [incidents, state] = await Promise.all([api.incidents({ status: filter || undefined }), api.state()]);
      setItems(incidents.items);
      setCars(state.active_cars);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const acknowledge = async (incident: IncidentView) => {
    const reason = prompt(`Add an acknowledgement note for ${incident.id} (at least 8 characters):`);
    if (!reason) return;
    if (reason.trim().length < 8) {
      toast(false, "Acknowledgement note must be at least 8 characters");
      return;
    }
    setBusyId(incident.id);
    try {
      const result = await api.acknowledgeIncident(incident.id, reason.trim());
      if (filter === "open") setItems((rows) => rows.filter((row) => row.id !== incident.id));
      else setItems((rows) => rows.map((row) => row.id === incident.id ? result.incident : row));
      toast(true, `Incident ${incident.id} acknowledged`);
    } catch (e) {
      toast(false, (e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const recover = async (incident: IncidentView, action: "duration" | "reservation" | "waiver" | "emergency") => {
    const visitId = typeof incident.details.visit_id === "string" ? incident.details.visit_id : null;
    const car = cars.find((candidate) => (visitId && candidate.visit_id === visitId) || (!visitId && incident.plate && candidate.plate === incident.plate));
    if (!car?.visit_id || car.state_version === undefined) {
      toast(false, "The active visit/version is unavailable. Refresh the incident and state before retrying.");
      return;
    }
    let minutes: number | undefined;
    if (action === "duration") {
      const value = prompt(`Verified stay duration in minutes for ${car.plate} (1–1440):`);
      if (!value) return;
      minutes = Number(value);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        toast(false, "Duration must be a whole number from 1 to 1440 minutes");
        return;
      }
    }
    const reason = prompt(action === "reservation"
      ? `Explain the verification for ${car.spot ?? "the assigned spot"} (the server will still require a fresh empty sensor check):`
      : `Reason/evidence for ${action} on ${car.plate} (at least 8 characters):`);
    if (!reason || reason.trim().length < 8) return;
    setBusyId(incident.id);
    try {
      const requestId = crypto.randomUUID();
      const result = action === "duration"
        ? await api.reviewUnknownDuration(car.plate, { expected_version: car.state_version, minutes: minutes!, reason: reason.trim() })
        : action === "reservation"
          ? await api.reviewReservation(car.visit_id, { request_id: requestId, expected_version: car.state_version, reason: reason.trim() })
          : action === "waiver"
            ? await api.waiveVisit(car.visit_id, { request_id: requestId, expected_version: car.state_version, reason: reason.trim() })
            : await api.emergencyRelease(car.visit_id, { request_id: requestId, expected_version: car.state_version, reason: reason.trim() });
      if (!result.ok) throw new Error(result.message);
      toast(true, result.message);
      await load();
    } catch (e) {
      toast(false, (e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <div className="filters">
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Incident status">
          <option value="open">Open</option><option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option><option value="">All statuses</option>
        </select>
        <Button onClick={() => void load()} busy={loading}>Refresh</Button>
      </div>
      {error && <p className="form-error">{error}</p>}
      <Card title="Incidents" subtitle="Acknowledge for investigation; use the incident-specific recovery workflow to resolve domain incidents.">
        {loading && !items.length ? <Empty>Loading incidents…</Empty> : !items.length ? <Empty>No incidents match this filter.</Empty> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Opened</th><th>Severity</th><th>Status</th><th>Incident</th><th>Related item</th><th>Zone / lane</th><th>Reason</th><th>Evidence</th><th></th></tr></thead>
              <tbody>{items.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{fmtDateTime(i.opened_at)}</td>
                  <td><Badge tone={severityTone(i.severity)}>{i.severity}</Badge></td>
                  <td><Badge tone={i.status === "open" ? "warning" : i.status === "resolved" ? "good" : "neutral"}>{i.status}</Badge></td>
                  <td><b>{i.type.replaceAll("_", " ")}</b><div className="muted small">{i.summary}</div><span className="mono muted small">{i.id}</span></td>
                  <td>{i.component ? `${i.component_type ?? "component"} ${i.component}` : i.plate ? `Plate ${i.plate}` : "—"}</td>
                  <td>{[i.zone, i.lane].filter(Boolean).join(" / ") || "—"}</td>
                  <td>{i.reason ?? "—"}</td>
                  <td><details><summary>View</summary><pre className="mono small">{JSON.stringify(i.details, null, 2)}</pre></details></td>
                  <td className="btn-row">
                    {i.status === "open" && <Button small onClick={() => void acknowledge(i)} busy={busyId === i.id}>Acknowledge</Button>}
                    {i.type === "unknown_visit" && i.plate && cars.some((car) => car.plate === i.plate) &&
                      <Button small onClick={() => void recover(i, "duration")} busy={busyId === i.id}>Review duration</Button>}
                    {i.type === "uncertain_reservation" && typeof i.details.visit_id === "string" && cars.some((car) => car.visit_id === i.details.visit_id) &&
                      <Button small variant="danger" onClick={() => void recover(i, "reservation")} busy={busyId === i.id}>Check reserved spot</Button>}
                    {can("admin") && i.type === "unknown_visit" && typeof i.details.visit_id === "string" && cars.some((car) => car.visit_id === i.details.visit_id) && <>
                      <Button small variant="danger" onClick={() => void recover(i, "waiver")} busy={busyId === i.id}>Waive</Button>
                      <Button small variant="danger" onClick={() => void recover(i, "emergency")} busy={busyId === i.id}>Emergency release</Button>
                    </>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

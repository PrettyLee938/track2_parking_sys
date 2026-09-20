import { useCallback, useEffect, useState } from "react";
import type { CoZoneSafetyState, FanView, MaintenanceJobView, StateSnapshot } from "@gpa/shared";
import { Badge, Button, Card, Empty, useCommand, useToast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDateTime, fmtInt } from "../lib/format";

type CoZoneSafetyView = Omit<CoZoneSafetyState, "raw">;

export function Maintenance({ state }: { state: StateSnapshot }) {
  const [jobs, setJobs] = useState<MaintenanceJobView[]>([]);
  const [fans, setFans] = useState<FanView[]>([]);
  const [lights, setLights] = useState<import("@gpa/shared").LightView[]>([]);
  const [inventoryComplete, setInventoryComplete] = useState({ fans: false, lights: false });
  const [coZones, setCoZones] = useState<CoZoneSafetyView[]>([]);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState<string | null>(null);
  const { can, user } = useAuth();
  const toast = useToast();
  const { busy, run } = useCommand();
  const canRecover = can("operator");
  const refresh = useCallback(() => {
    api.maintenanceJobs().then((r) => setJobs(r.items)).catch(() => undefined);
    Promise.all([api.equipment(), api.environmentZones()])
      .then(([equipment, environment]) => {
        setFans(equipment.fans);
        setLights(equipment.lights);
        setInventoryComplete({ fans: equipment.fan_inventory_complete, lights: equipment.light_inventory_complete });
        setCoZones(environment.items);
        setEnvironmentError(null);
      })
      .catch((e) => setEnvironmentError((e as Error).message));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 8000);
    return () => clearInterval(timer);
  }, [refresh]);

  const requestAndStart = async (type: "gate" | "spot" | "fan", component: string) => {
    const reason = prompt(`Reason for maintenance on ${component} (at least 8 characters):`);
    if (!reason || reason.trim().length < 8) return;
    await run(`repair:${component}`, async () => {
      const { job } = await api.requestMaintenance({ component_type: type, component, reason: reason.trim() });
      return api.startMaintenance(job.id);
    });
    await refresh();
  };

  const active = (type: "gate" | "spot" | "fan", name: string) => jobs.some((j) =>
    j.component_type === type && j.component === name && (j.status === "requested" || j.status === "in_progress"));
  const startRequested = async (job: MaintenanceJobView) => {
    await run(`start:${job.id}`, () => api.startMaintenance(job.id));
    await refresh();
  };
  const claimRequested = async (job: MaintenanceJobView) => {
    await run(`claim:${job.id}`, async () => { await api.claimMaintenance(job.id); return { ok: true, message: `Claimed ${job.component}` }; });
    await refresh();
  };

  const verifyRecovery = async (zone: CoZoneSafetyView) => {
    const reason = prompt(`Reason for checking CO recovery in ${zone.zone} (at least 8 characters):`);
    if (!reason) return;
    if (reason.trim().length < 8) {
      toast(false, "Recovery-check reason must be at least 8 characters");
      return;
    }
    setRecoveryBusy(zone.zone);
    try {
      const result = await api.recoveryCheck(zone.zone, { reason: reason.trim() });
      if (result.status === "verified") {
        toast(true, `${zone.zone} CO recovery verified at level ${result.level}`);
      } else {
        toast(false, result.reason);
      }
      refresh();
    } catch (e) {
      toast(false, (e as Error).message);
    } finally {
      setRecoveryBusy(null);
    }
  };

  const componentStatus = (broken: boolean | null, maintenance: boolean | null, draining = false) => draining
    ? <Badge tone="warning">Draining</Badge> : broken === true
    ? <Badge tone="critical">Broken</Badge>
    : maintenance === true ? <Badge tone="warning">Under maintenance</Badge>
      : broken === false || maintenance === false ? <Badge tone="good">Available</Badge> : <Badge tone="neutral">Unknown</Badge>;

  return (
    <div className="page">
      <Card title="Equipment" subtitle="Occupancy and reservations are shown without vehicle identities. Repairs remain blocked until the simulator confirms safety and completion.">
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Component</th><th>Zone</th><th>Status</th><th>Use / lane</th><th className="right">Action</th></tr></thead>
          <tbody>
            {state.gates.map((g) => {
              const entry = state.entry_lanes.find((l) => l.gate === g.name);
              const exit = state.exit_lanes.find((l) => l.gate === g.name);
              const lane = exit ? `Exit ${exit.spot}: ${exit.passage_state}` : entry ? `Entry ${entry.spot}` : "Unassigned";
              return <tr key={`gate:${g.name}`}>
                <td>{g.name} <span className="muted small">gate · {g.state}</span></td><td>{g.zone || "—"}</td>
                <td>{componentStatus(g.broken, g.maintenance, g.draining)}</td><td>{lane}</td>
                <td className="right"><Button small variant="danger" disabled={g.maintenance || g.draining || active("gate", g.name)}
                  busy={busy === `repair:${g.name}`} onClick={() => void requestAndStart("gate", g.name)}>Request / start</Button></td>
              </tr>;
            })}
            {state.spots.filter((s) => s.purpose === "Park").map((s) => {
              const occupied = !!s.occupant || s.detected > 0;
              const reserved = !!s.reserved_for;
              return <tr key={`spot:${s.name}`}>
                <td>{s.name} <span className="muted small">parking spot · {s.car_type}</span></td><td>{s.zone || "—"}</td>
                <td>{componentStatus(s.broken, s.maintenance)}</td>
                <td>{occupied ? "Occupied" : reserved ? "Reserved" : "Clear"}</td>
                <td className="right"><Button small variant="danger" disabled={s.maintenance || occupied || reserved || active("spot", s.name)}
                  busy={busy === `repair:${s.name}`} onClick={() => void requestAndStart("spot", s.name)}>Request / start</Button></td>
              </tr>;
            })}
            {fans.map((fan) => (
              <tr key={`fan:${fan.name}`}>
                <td>{fan.name} <span className="muted small">exhaust fan</span></td><td>{fan.zone || "â€”"}</td>
                <td>{componentStatus(fan.broken, fan.maintenance)}</td><td>{fan.is_on === true ? "On" : fan.is_on === false ? "Off" : "Unknown"}</td>
                <td className="right"><Button small variant="danger" disabled={fan.broken !== true || fan.maintenance === true || active("fan", fan.name)}
                  busy={busy === `repair:${fan.name}`} title={fan.broken !== true ? "Repair is available only after a confirmed component failure" : "Repair only after CO safety has a confirmed replacement fan, if applicable"}
                  onClick={() => void requestAndStart("fan", fan.name)}>Request / start</Button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {!state.gates.length && !state.spots.some((s) => s.purpose === "Park") && !fans.length && <Empty>No equipment is loaded.</Empty>}
        {!inventoryComplete.fans && <p className="muted small">Exhaust-fan inventory or status is incomplete; ventilation safety checks fail closed.</p>}
        {!inventoryComplete.lights && <p className="muted small">Light inventory or status is incomplete; no availability or usage assumptions are made.</p>}
      </Card>

      <Card title="Exhaust fans" subtitle="Unknown health or usage is shown as unknown; no values are inferred">
        {!fans.length ? <Empty>No exhaust fans are reported by the simulator.</Empty> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Fan</th><th>Zone</th><th>Health</th><th>Ventilation</th><th className="right">Usage count</th></tr></thead>
            <tbody>{fans.map((fan) => {
              const health = fan.broken === true ? <Badge tone="critical">Broken</Badge>
                : fan.maintenance === true ? <Badge tone="warning">Under maintenance</Badge>
                  : !fan.health_known ? <Badge tone="neutral">Unknown</Badge> : <Badge tone="good">Available</Badge>;
              const on = fan.is_on === true ? <Badge tone="info">On</Badge>
                : fan.is_on === false ? <Badge tone="neutral">Off</Badge> : <Badge tone="warning">Unknown</Badge>;
              return <tr key={fan.name}>
                <td>{fan.name}</td><td>{fan.zone || "—"}</td><td>{health}</td><td>{on}</td>
                <td className="right">{fan.usage_count === null ? "Unknown" : fmtInt(fan.usage_count)}</td>
              </tr>;
            })}</tbody>
          </table></div>
        )}
      </Card>

      <Card title="Lights" subtitle="Read-only monitoring; the simulator does not document a light repair endpoint">
        {!lights.length ? <Empty>No lights are reported by the simulator.</Empty> : <div className="table-wrap"><table className="data">
          <thead><tr><th>Light</th><th>Zone</th><th>Group</th><th>State</th><th>Health</th><th className="right">Usage count</th></tr></thead>
          <tbody>{lights.map((light) => <tr key={light.name}>
            <td>{light.name}</td><td>{light.zone || "â€”"}</td><td>{light.group ?? "Unknown"}</td>
            <td>{light.is_on === null ? "Unknown" : light.is_on ? "On" : "Off"}</td>
            <td>{light.broken === true ? <Badge tone="critical">Broken</Badge> : light.maintenance === true
              ? <Badge tone="warning">Under maintenance</Badge> : light.broken === false || light.maintenance === false
                ? <Badge tone="good">Available</Badge> : <Badge tone="neutral">Unknown</Badge>}</td>
            <td className="right">{light.usage_count === null ? "Unknown" : fmtInt(light.usage_count)}</td>
          </tr>)}</tbody>
        </table></div>}
        <p className="muted small">Broken lights create equipment incidents. Repair must be handled outside the dashboard unless the simulator publishes a supported repair command.</p>
      </Card>

      <Card title="CO safety by zone" subtitle="Admission restrictions are fail-safe; a recovery check is one explicit simulator reading, never a polling loop">
        {environmentError && <p className="form-error">Could not load CO/environment state: {environmentError}</p>}
        {!coZones.length ? <Empty>No CO safety readings have been recorded.</Empty> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Zone</th><th>CO reading</th><th>Admission restriction</th><th>Ventilation</th><th>Evidence</th><th className="right">Recovery verification</th></tr></thead>
            <tbody>{coZones.map((zone) => (
              <tr key={zone.zone}>
                <td><b>{zone.zone}</b></td>
                <td>{zone.level === null ? "Unknown" : zone.level}{zone.dangerLevel ? <span className="muted small"> · {zone.dangerLevel}</span> : ""}</td>
                <td>{zone.restricted
                  ? <><Badge tone="critical">Restricted</Badge>{zone.restrictionReason && <div className="muted small">{zone.restrictionReason}</div>}</>
                  : <Badge tone="good">Open</Badge>}</td>
                <td>{zone.ventilationRequired ? <Badge tone="warning">Required</Badge> : <Badge tone="neutral">Not required</Badge>}
                  {zone.ventilationStartedAtGame !== null && <div className="muted small">Started at game time {zone.ventilationStartedAtGame}</div>}</td>
                <td>{zone.source} · {fmtDateTime(zone.observedAt)}{zone.verifiedAt && <div className="muted small">Verified {fmtDateTime(zone.verifiedAt)}</div>}</td>
                <td className="right">{canRecover && zone.ventilationRequired
                  ? <Button small variant="primary" busy={recoveryBusy === zone.zone} disabled={!!recoveryBusy}
                    title="One-shot check; the server refuses checks before the safe ventilation interval or when unsupported"
                    onClick={() => void verifyRecovery(zone)}>Verify recovery</Button>
                  : zone.ventilationRequired ? <span className="muted small">Operator/Admin only</span> : <span className="muted small">Available when ventilation is required</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <p className="muted small">An early, unsupported, stale, or unsafe check is refused by the server; a failed check does not clear ventilation or zone restrictions.</p>
      </Card>

      <Card title="Maintenance jobs" subtitle="Requests and repairs are retained across server restarts">
        {!jobs.length ? <Empty>No maintenance jobs recorded.</Empty> : <div className="table-wrap"><table className="data">
          <thead><tr><th>Requested</th><th>Component</th><th>Zone</th><th>Status</th><th>Reason / resolution</th><th className="right">Action</th></tr></thead>
          <tbody>{jobs.map((job) => <tr key={job.id}>
            <td>{new Date(job.requested_at).toLocaleString()}</td><td>{job.component} <span className="muted small">{job.component_type}</span>
              <div className="muted small">Assigned to: {job.assigned_to ?? "Unassigned"}</div></td>
            <td>{job.zone || "—"}</td><td><Badge tone={job.status === "completed" ? "good" : job.status === "failed" ? "critical" : "warning"}>{job.status.replaceAll("_", " ")}</Badge></td>
            <td>{job.resolution ?? job.reason}</td><td className="right">
              {job.status === "requested" && job.assigned_to === null && !can("admin") &&
                <Button small variant="primary" disabled={!!busy} onClick={() => void claimRequested(job)}>Claim</Button>}
              {job.status === "requested" && (can("admin") || job.assigned_to === user?.username) &&
                <Button small variant="primary" disabled={!!busy} onClick={() => void startRequested(job)}>Start</Button>}
            </td>
          </tr>)}</tbody>
        </table></div>}
      </Card>
    </div>
  );
}

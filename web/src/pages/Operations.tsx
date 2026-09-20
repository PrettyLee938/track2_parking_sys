/** Manual control: gates, spots and (admin) entrances. The server refuses anything the simulator penalises. */
import { useEffect, useState } from "react";
import type { ActionView, GateView, StateSnapshot } from "@gpa/shared";
import { ComponentHealthCard } from "../components/health";
import { CarsTable, GateBadge, SpotMap, spotState } from "../components/site";
import { Badge, Button, Card, Empty, useCommand } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtTimeSec } from "../lib/format";

export function Operations({ s }: { s: StateSnapshot }) {
  const { can } = useAuth();
  const { busy, run } = useCommand();
  const [selected, setSelected] = useState<string | null>(null);
  const spot = s.spots.find((x) => x.name === selected);

  const laneOf = (g: GateView) => {
    const entry = s.entry_lanes.find((l) => l.gate === g.name);
    const exit = s.exit_lanes.find((l) => l.gate === g.name);
    return entry ? `Entrance ${entry.spot}` : exit ? `Exit ${exit.spot}` : "Not on a lane";
  };
  const onLane = (g: GateView) => s.entry_lanes.some((l) => l.gate === g.name) || s.exit_lanes.some((l) => l.gate === g.name);
  const gates = [...s.gates].sort((a, b) => Number(onLane(b)) - Number(onLane(a)) || a.name.localeCompare(b.name));

  const gateCmd = (g: GateView, action: "open" | "close" | "auto" | "repair") => {
    if (action === "repair" && !confirm(`Start maintenance on ${g.name}? It cannot be used until the simulator reports it repaired.`)) return;
    return run(`${g.name}:${action}`, () => api.gate(g.name, action));
  };

  return (
    <div className="page">
      <ComponentHealthCard components={s.components ?? []} />

      <Card title="Barrier gates" subtitle="Holding a gate open or closed overrides the automation until you return it to automatic">
        <div className="gate-grid">
          {gates.map((g) => {
            const unusable = g.broken || g.maintenance;
            return (
              <div key={g.name} className={`gate-card${onLane(g) ? "" : " dim"}`}>
                <div className="gate-head"><b>{g.name}</b><span className="muted small">{laneOf(g)}</span></div>
                <GateBadge gate={g} />
                <div className="btn-row">
                  <Button small onClick={() => gateCmd(g, "open")} busy={busy === `${g.name}:open`} disabled={unusable || g.hold === "open"}
                    title="Open and keep open">Hold open</Button>
                  <Button small onClick={() => gateCmd(g, "close")} busy={busy === `${g.name}:close`} disabled={unusable || g.hold === "closed"}
                    title="Close and keep closed - cars for this lane will wait">Hold closed</Button>
                  <Button small variant="primary" onClick={() => gateCmd(g, "auto")} busy={busy === `${g.name}:auto`} disabled={!g.hold}
                    title="Give the gate back to the automation">Automatic</Button>
                  <Button small variant="danger" onClick={() => gateCmd(g, "repair")} busy={busy === `${g.name}:repair`} disabled={g.maintenance}
                    title="Start maintenance (refused while a car is passing)">Repair</Button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {can("admin") && (
        <Card title="Entrances" subtitle="Admin: a closed entrance turns arriving cars away; cars already queued are still served">
          <table className="data compact">
            <tbody>
              {s.entry_lanes.map((l) => (
                <tr key={l.spot}>
                  <td>{l.spot}</td>
                  <td>{l.closed ? <Badge tone="warning">Closed</Badge> : <Badge tone="good">Open</Badge>}</td>
                  <td className="muted">{l.zone && `leads to ${l.zone}`}</td>
                  <td className="right">
                    <Button small variant={l.closed ? "primary" : "danger"} busy={busy === `entry:${l.spot}`}
                      onClick={() => run(`entry:${l.spot}`, () => api.entrance(l.spot, l.closed))}>
                      {l.closed ? "Reopen" : "Close entrance"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <div className="grid-2 wide-left">
        <Card title="Parking spots" subtitle="Select a spot for details and maintenance">
          <SpotMap spots={s.spots} selected={selected} onSelect={setSelected} />
        </Card>
        <Card title={spot ? `Spot ${spot.name}` : "Spot details"}>
          {!spot ? <Empty>Select a spot on the map.</Empty> : (
            <>
              <dl className="details">
                <dt>State</dt><dd>{{ free: "Free", occupied: "Occupied", reserved: "Reserved", out: spot.sensor_abnormal ? "Sensor abnormal" : spot.broken ? "Broken" : "Under maintenance" }[spotState(spot)]}</dd>
                <dt>Car</dt><dd className="mono">{spot.occupant === "?" ? "unknown car" : spot.occupant ?? spot.reserved_for ?? "—"}</dd>
                <dt>Zone</dt><dd>{spot.zone || "—"}</dd>
                <dt>For</dt><dd>{spot.car_type === "Any" ? "Any car" : `${spot.car_type} cars only`}</dd>
              </dl>
              <Button variant="danger" busy={busy === `spot:${spot.name}`}
                disabled={spotState(spot) === "occupied" || spotState(spot) === "reserved" || spot.maintenance}
                title={spot.occupant || spot.reserved_for ? "Repairing an occupied spot is a penalty" : "Start maintenance"}
                onClick={() => confirm(`Start maintenance on ${spot.name}? It will not be offered to cars until repaired.`) &&
                  run(`spot:${spot.name}`, () => api.repairSpot(spot.name))}>
                Start maintenance
              </Button>
              {(spot.occupant || spot.reserved_for) && <p className="muted small">Available once the spot is empty - repairing an occupied spot is a penalty.</p>}
            </>
          )}
          <h3 className="section-title">Recent manual commands</h3>
          <RecentManual />
        </Card>
      </div>

      <Card title="Cars inside" subtitle={`${s.active_cars.length} tracked`}><CarsTable cars={s.active_cars} /></Card>
    </div>
  );
}

function RecentManual() {
  const [items, setItems] = useState<ActionView[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.actions({ manual: true, limit: 8 }).then((r) => alive && setItems(r.items)).catch(() => undefined);
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  if (!items.length) return <Empty>None yet.</Empty>;
  return (
    <ul className="plain-list">
      {items.map((a) => (
        <li key={a.id}><time className="mono muted">{fmtTimeSec(a.at)}</time> <b>{a.actor}</b> {a.cmd} {a.args.join(" ")}
          {!a.ok && <Badge tone="critical">failed</Badge>}</li>
      ))}
    </ul>
  );
}

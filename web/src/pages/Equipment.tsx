import { useEffect, useMemo, useState } from "react";
import type { ComponentView, DeviceAction, EnvironmentSnapshot, StateSnapshot } from "@gpa/shared";
import { Badge, Button, Card, Empty, Tile, useCommand } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDateTime, fmtInt } from "../lib/format";

const healthTone = (health: ComponentView["health"]) => health === "ok" ? "good" : health === "broken" ? "critical" : "warning";

export function Equipment({ s }: { s: StateSnapshot }) {
  const { can } = useAuth();
  const { busy, run } = useCommand();
  const [jobs, setJobs] = useState<Awaited<ReturnType<typeof api.maintenance>>["items"]>([]);
  const load = () => api.maintenance(100).then((r) => setJobs(r.items)).catch(() => undefined);
  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, []);
  const environment: EnvironmentSnapshot | undefined = s.environment;
  const zones = environment?.zones ?? [];
  const lighting = environment?.lights;
  const byKind = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of s.components ?? []) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
    return [...counts.entries()].map(([kind, count]) => `${kind}: ${count}`).join(" · ");
  }, [s.components]);

  // Fans and lights are controlled like gates: On/Off take a part out of automatic control
  // until Automatic hands it back. Which parts are held comes from the environment
  // subsystem, since that is what the holds actually suspend.
  const devices = useMemo(
    () => (s.components ?? []).filter((c) => c.kind === "fan" || c.kind === "light"),
    [s.components],
  );
  const holds = environment?.holds ?? [];
  const holdOf = (c: ComponentView) => holds.find((h) => h.kind === c.kind && h.name === c.name);

  const deviceCmd = (c: ComponentView, action: DeviceAction) =>
    run(`${c.kind}:${c.name}:${action}`, () => api.device(c.kind as "fan" | "light", c.name, action));

  const releaseAll = () =>
    run("devices:auto-all", async () => {
      for (const h of holds) await api.device(h.kind, h.name, "auto");
      return { ok: true, message: `${holds.length} part${holds.length === 1 ? "" : "s"} returned to automatic` };
    });

  const repair = (c: ComponentView) => {
    // A light cannot be repaired through the simulator, so the same button reports it
    // instead; the server raises an incident and says so.
    const ask = c.kind === "light"
      ? `Report ${c.name} as faulty? The simulator cannot repair lights, so this raises an incident.`
      : `Start maintenance on ${c.name}? It will remain unavailable until repaired.`;
    if (!confirm(ask)) return;
    void run(`${c.kind}:${c.name}:repair`, async () => {
      const result = await api.maintenanceStart(c.kind, c.name);
      load();
      return result;
    });
  };

  return (
    <div className="page">
      <Card title="Environment" subtitle="CO readings and admission restrictions are isolated by zone">
        {!zones.length ? <Empty>No Level 2 zone readings yet.</Empty> : (
          <div className="table-wrap">
            <table className="data compact">
              <thead><tr><th>Zone</th><th>CO</th><th>Risk</th><th>Ventilation</th><th>Traffic</th><th>Status</th></tr></thead>
              <tbody>{zones.map((z) => (
                <tr key={z.zone}>
                  <td><b>{z.zone}</b></td><td className="right">{z.co === null ? "-" : `${z.co}`}</td><td>{z.risk ?? "-"}</td>
                  <td>{z.want ? "running" : "off"}</td><td className="right">{z.lights_on + z.fans_on ? "active" : "idle"}</td>
                  <td>{z.forced ? <Badge tone="critical">CO recovery</Badge> : <Badge tone="good">Operating</Badge>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Guide lighting" subtitle="Lights follow moving traffic in each zone and remain off during daytime">
        {!lighting ? <Empty>No lighting state has been reported yet.</Empty> : (
          <>
            <div className="tiles">
              <Tile label="Lights on" value={`${lighting.on} / ${lighting.total}`} tone={lighting.on ? "warning" : "good"}
                sub={lighting.night ? "night policy" : "day policy · off"} />
              <Tile label="Control" value={lighting.mode} sub={`${lighting.detail} detail`} />
              <Tile label="Simulator hour" value={lighting.hour === null ? "unknown" : `${lighting.hour.toFixed(2)}:00`} sub={lighting.reason} />
            </div>
            <div className="table-wrap"><table className="data compact"><thead><tr><th>Zone</th><th>Lights on</th><th>Fans on</th><th>CO</th></tr></thead>
              <tbody>{zones.map((z) => <tr key={z.zone}><td><b>{z.zone}</b></td><td>{z.lights_on ?? "-"} / {z.lights ?? "-"}</td>
                <td>{z.fans_on ?? "-"} / {z.fans ?? "-"}</td><td>{z.co === null ? "-" : z.co}</td></tr>)}</tbody>
            </table></div>
          </>
        )}
      </Card>

      <Card
        title="Fans & lights"
        subtitle="On and Off hold a part where you put it; Automatic hands it back to the CO and daylight rules"
        actions={holds.length ? (
          <Button small variant="primary" busy={busy === "devices:auto-all"} onClick={releaseAll}>
            Return all {holds.length} to automatic
          </Button>
        ) : null}
      >
        {!devices.length ? <Empty>This level reports no exhaust fans or lights.</Empty> : (
          <>
            {holds.length > 0 && (
              <p className="banner">
                {holds.length === 1
                  ? `${holds[0].name} is held ${holds[0].hold} by ${holds[0].actor} and is not following the automatic rules.`
                  : `${holds.length} parts are held by an operator and are not following the automatic rules.`}
                {" "}A fan held off is released automatically if its zone goes above the CO level.
              </p>
            )}
            <div className="gate-grid">
              {devices.map((d) => {
                const key = `${d.kind}:${d.name}`;
                const hold = holdOf(d);
                const unusable = d.health !== "ok";
                return (
                  <div key={key} className="gate-card">
                    <div className="gate-head">
                      <b>{d.name}</b>
                      <span className="muted small">{d.kind === "fan" ? "Exhaust fan" : "Light"}{d.zone && ` · ${d.zone}`}</span>
                    </div>
                    <div className="badge-row">
                      {unusable ? <Badge tone={healthTone(d.health)}>{d.health}</Badge>
                        : d.on ? <Badge tone="warning">On</Badge> : <Badge tone="good">Off</Badge>}
                      {hold && <Badge tone="info" title={`Held by ${hold.actor}; the automatic rules leave it alone`}>Held {hold.hold}</Badge>}
                    </div>
                    {can("operator") && (
                      <div className="btn-row">
                        <Button small busy={busy === `${key}:on`} disabled={unusable || hold?.hold === "on"}
                          onClick={() => deviceCmd(d, "on")} title="Switch on and keep it on">On</Button>
                        <Button small busy={busy === `${key}:off`} disabled={unusable || hold?.hold === "off"}
                          onClick={() => deviceCmd(d, "off")} title="Switch off and keep it off">Off</Button>
                        <Button small variant="primary" busy={busy === `${key}:auto`} disabled={!hold}
                          onClick={() => deviceCmd(d, "auto")} title="Give it back to the automatic rules">Automatic</Button>
                        {/* The simulator repairs fans but not lights, so a faulty light is
                            put on record as an incident instead - see reportLightFault. */}
                        {d.kind === "fan" ? (
                          <Button small variant="danger" busy={busy === `${key}:repair`} disabled={d.health === "maintenance" || d.on === true}
                            onClick={() => repair(d)}
                            title={d.on === true ? "Switch it off first - repairing a running fan is a penalty" : "Start maintenance"}>
                            Repair
                          </Button>
                        ) : (
                          <Button small variant="danger" busy={busy === `${key}:repair`}
                            onClick={() => repair(d)}
                            title="The simulator cannot repair lights; this raises an incident for someone to chase">
                            Report fault
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>

      <Card title="Equipment health" subtitle={`${s.components?.length ?? 0} components · ${byKind || "none"}`}>
        {!s.components?.length ? <Empty>No component inventory has been synced.</Empty> : (
          <div className="table-wrap">
            <table className="data compact">
              <thead><tr><th>Component</th><th>Zone</th><th>Health</th><th>Usage</th><th>Failures</th><th>Last change</th><th /></tr></thead>
              <tbody>{s.components.map((c) => (
                <tr key={`${c.kind}:${c.name}`}>
                  <td><b>{c.name}</b><span className="muted small"> · {c.kind}</span></td><td>{c.zone || "-"}</td>
                  <td><Badge tone={healthTone(c.health)}>{c.health}{c.maintenance_due ? " · due" : ""}</Badge></td>
                  <td className="right">{fmtInt(c.uses)} <span className="muted">({fmtInt(c.uses_total)} total)</span></td>
                  <td className="right">{c.breakdowns}</td><td>{c.last_fixed_at ? fmtDateTime(c.last_fixed_at) : c.last_broken_at ? `broken ${fmtDateTime(c.last_broken_at)}` : "-"}</td>
                  <td className="right">{can("operator") && c.health !== "maintenance" &&
                    <Button small variant="danger" disabled={!!c.waiting && /occupied|driving|reserved/.test(c.waiting)}
                      busy={busy === `${c.kind}:${c.name}:repair`} onClick={() => repair(c)}>
                      {c.kind === "light" ? "Report" : "Repair"}
                    </Button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Maintenance history" subtitle="Automatic and operator-requested work, newest first">
        {!jobs.length ? <Empty>No maintenance jobs yet.</Empty> : (
          <div className="table-wrap tall"><table className="data compact">
            <thead><tr><th>When</th><th>Component</th><th>Reason</th><th>Status</th><th>By</th></tr></thead>
            <tbody>{jobs.map((j) => <tr key={j.id}><td className="mono">{fmtDateTime(j.updated_at)}</td><td>{j.component_name} <span className="muted">({j.component_kind})</span></td>
              <td>{j.reason}</td><td><Badge tone={j.status === "completed" ? "good" : j.status === "failed" ? "critical" : "warning"}>{j.status}</Badge></td><td>{j.actor ?? "controller"}</td></tr>)}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

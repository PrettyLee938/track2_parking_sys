import { useEffect, useMemo, useState } from "react";
import type { ComponentView, EnvironmentSnapshot, StateSnapshot } from "@gpa/shared";
import { Badge, Button, Card, Empty, Tile, useCommand } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDateTime, fmtInt } from "../lib/format";

const healthTone = (health: ComponentView["health"]) => health === "ok" ? "good" : health === "broken" || health === "sensor_abnormal" ? "critical" : "warning";

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

  const repair = (c: ComponentView) => {
    if (c.kind === "light") return;
    if (!confirm(`Start maintenance on ${c.name}? It will remain unavailable until repaired.`)) return;
    void run(`${c.kind}:${c.name}`, async () => {
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
                  <td className="right">{can("operator") && c.kind !== "light" && c.health !== "maintenance" &&
                    <Button small variant="danger" disabled={!!c.waiting && /occupied|driving|reserved/.test(c.waiting)} busy={busy === `${c.kind}:${c.name}`} onClick={() => repair(c)}>Repair</Button>}</td>
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

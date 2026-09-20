/** Component health: what is broken or being repaired, and the breakdown/repair history. */
import { useEffect, useState } from "react";
import type { ComponentEventView, ComponentKind, ComponentView } from "@gpa/shared";
import { api } from "../lib/api";
import { fmtTimeSec } from "../lib/format";
import { Badge, Card, Empty, Tile } from "./ui";

const KINDS: { kind: ComponentKind; label: string; unit: string }[] = [
  { kind: "gate", label: "Gates", unit: "cycles" },
  { kind: "spot", label: "Parking spots", unit: "visits" },
  { kind: "fan", label: "Exhaust fans", unit: "h on" },
  { kind: "light", label: "Lights", unit: "h on" },
];

const EVENT_LABEL: Record<ComponentEventView["event"], { text: string; tone: "critical" | "warning" | "good" | "neutral" }> = {
  broken: { text: "broke", tone: "critical" },
  repair_sent: { text: "repair started", tone: "warning" },
  preventive_repair: { text: "preventive repair", tone: "warning" },
  repair_failed: { text: "repair rejected", tone: "critical" },
  fixed: { text: "back in service", tone: "good" },
};

export function ComponentHealthCard({ components }: { components: ComponentView[] }) {
  const trouble = components.filter((c) => c.health !== "ok");
  return (
    <Card title="Component health" subtitle="Broken parts are repaired automatically as soon as nothing is using them">
      <div className="tiles">
        {KINDS.map(({ kind, label }) => {
          const all = components.filter((c) => c.kind === kind);
          if (!all.length) return null;
          const broken = all.filter((c) => c.health === "broken" || c.health === "sensor_abnormal").length, repairing = all.filter((c) => c.health === "maintenance").length;
          return (
            <Tile key={kind} label={label} value={`${all.length - broken - repairing} / ${all.length} working`}
              tone={broken ? "critical" : repairing ? "warning" : "good"}
              sub={broken || repairing ? [broken && `${broken} broken`, repairing && `${repairing} in repair`].filter(Boolean).join(" · ") : "all working"} />
          );
        })}
      </div>
      <h3 className="section-title">Out of service</h3>
      {!trouble.length ? <Empty>Everything is working.</Empty> : (
        <table className="data compact">
          <thead><tr><th>Part</th><th>Zone</th><th>State</th><th className="right">Uses since repair</th><th>Note</th></tr></thead>
          <tbody>
            {trouble.map((c) => (
              <tr key={`${c.kind}:${c.name}`}>
                <td>{c.kind} <b>{c.name}</b></td>
                <td>{c.zone || "—"}</td>
                <td>{c.health === "broken" ? <Badge tone="critical">broken</Badge> : c.health === "sensor_abnormal" ? <Badge tone="critical">sensor abnormal</Badge> : <Badge tone="warning">being repaired</Badge>}</td>
                <td className="right">{c.uses}</td>
                <td className="muted">{c.waiting ? `waiting: ${c.waiting}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className="section-title">Wear (most used first)</h3>
      <table className="data compact">
        <thead><tr><th>Part</th><th className="right">Uses since repair</th><th className="right">Total</th><th className="right">Breakdowns</th><th>Broke after</th></tr></thead>
        <tbody>
          {[...components].filter((c) => c.kind === "gate" || c.kind === "fan" || c.breakdowns > 0)
            .sort((a, b) => b.uses - a.uses).slice(0, 12).map((c) => (
              <tr key={`${c.kind}:${c.name}`}>
                <td>{c.kind} <b>{c.name}</b></td>
                <td className="right">{c.uses} {KINDS.find((k) => k.kind === c.kind)?.unit}</td>
                <td className="right">{c.uses_total}</td>
                <td className="right">{c.breakdowns}</td>
                <td className="muted">{c.uses_at_breakdown.length ? c.uses_at_breakdown.join(", ") : "—"}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <h3 className="section-title">Breakdowns and repairs</h3>
      <ComponentHistory />
    </Card>
  );
}

function ComponentHistory() {
  const [items, setItems] = useState<ComponentEventView[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.components({ limit: 15 }).then((r) => alive && setItems(r.events)).catch(() => undefined);
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  if (!items.length) return <Empty>No breakdowns yet.</Empty>;
  return (
    <ul className="plain-list">
      {items.map((e) => (
        <li key={e.id}>
          <time className="mono muted">{fmtTimeSec(e.at)}</time> {e.kind} <b>{e.name}</b>{" "}
          <Badge tone={EVENT_LABEL[e.event].tone}>{EVENT_LABEL[e.event].text}</Badge>
          {e.amount !== null && <span className="muted"> · {e.amount.toFixed(2)}</span>}
          {e.detail && <span className="muted small"> · {e.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

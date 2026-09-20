/** Component health: what is broken or being repaired, and the breakdown/repair history. */
import { useEffect, useState } from "react";
import type { ComponentEventView, ComponentKind, ComponentView, QueueStats, SensorFaultKind, SpotSensorSnapshot } from "@gpa/shared";
import { api } from "../lib/api";
import { fmtTimeSec } from "../lib/format";
import { Badge, Card, Empty, Tile, type Tone } from "./ui";

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
          const broken = all.filter((c) => c.health === "broken").length, repairing = all.filter((c) => c.health === "maintenance").length;
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
                <td>{c.health === "broken" ? <Badge tone="critical">broken</Badge> : <Badge tone="warning">being repaired</Badge>}</td>
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

/**
 * Every webhook, tick and manual command runs through one queue, in order, so nothing is
 * ever lost - but a queue that keeps growing means the engine is falling behind the
 * simulator. This is what an operator watches when a lot of cars leave at once.
 *
 * Thresholds are judgement, not measurement: a handful of tasks in flight is normal at a
 * busy moment, tens of them mean the dashboard is showing stale state.
 */
const QUEUE_BUSY = 10, QUEUE_BEHIND = 25;

export function EventQueueCard({ queue }: { queue?: QueueStats | null }) {
  if (!queue) return null;
  const tone: Tone = queue.depth >= QUEUE_BEHIND ? "critical" : queue.depth >= QUEUE_BUSY ? "warning" : "good";
  const state = queue.depth >= QUEUE_BEHIND ? "Falling behind" : queue.depth >= QUEUE_BUSY ? "Busy" : "Keeping up";
  return (
    <Card title="Event queue" subtitle="Simulator events, ticks and your commands all run here, one at a time and in order">
      <div className="tiles">
        <Tile label="Waiting" value={queue.depth} tone={tone} sub={state} />
        <Tile label="Longest wait" value={`${Math.round(queue.oldest_wait_ms)} ms`}
          sub={queue.oldest_label ? `oldest: ${queue.oldest_label}` : "nothing waiting"} />
        <Tile label="Handling now" value={queue.running ?? "idle"} sub={queue.running ? `${Math.round(queue.running_ms)} ms so far` : undefined} />
        <Tile label="Handler time" value={`${queue.avg_ms.toFixed(1)} ms avg`} sub={`95th ${queue.p95_ms.toFixed(1)} ms · worst ${queue.max_ms.toFixed(1)} ms`} />
        <Tile label="Slowest handler" value={queue.slowest ?? "—"} sub="over the last 200 tasks" />
        <Tile label="Handled" value={queue.completed.toLocaleString()} tone={queue.failed ? "critical" : "good"}
          sub={queue.failed ? `${queue.failed} failed` : "none failed"} />
      </div>
    </Card>
  );
}

/**
 * Parking spots whose sensor we do not trust (Level 3 §7.2). The simulator has no
 * maintenance command for a spot, so "out of service" here is our own decision: the spot
 * is simply not offered to cars. In "watch" mode nothing is locked and this card is a
 * warning list only.
 */
const SIGNAL: Record<SensorFaultKind, string> = {
  ghost: "Reports a car nobody arrived in",
  over_count: "Counts more cars than arrived",
  flapping: "Changes its mind repeatedly",
  silent: "Never sees the cars sent to it",
  operator: "Taken out of service by an operator",
};

export function SpotSensorCard({ sensors }: { sensors?: SpotSensorSnapshot }) {
  if (!sensors || sensors.mode === "off") return null;
  const subtitle = sensors.mode === "maintenance"
    ? "Spots with an unreliable sensor are not offered to cars until they read clean again"
    : "Watching only: these spots are still offered to cars. Set GPA_SPOT_SENSOR_MODE=maintenance to take them out.";
  return (
    <Card title="Spot sensors" subtitle={subtitle}>
      <div className="tiles">
        <Tile label="Sensors in doubt" value={sensors.faults} tone={sensors.faults ? "warning" : "good"}
          sub={sensors.faults ? "see the list below" : "all reading normally"} />
        <Tile label="Out of service" value={sensors.out_of_service} tone={sensors.out_of_service ? "warning" : "good"}
          sub={sensors.mode === "maintenance" ? "not offered to cars" : "locking is switched off"} />
      </div>
      {!sensors.spots.length ? <Empty>No sensor abnormalities.</Empty> : (
        <table className="data compact">
          <thead><tr><th>Spot</th><th>Zone</th><th>Signal</th><th>What we saw</th><th>State</th></tr></thead>
          <tbody>
            {sensors.spots.map((f) => (
              <tr key={f.spot}>
                <td><b>{f.spot}</b></td>
                <td>{f.zone || "—"}</td>
                <td title={SIGNAL[f.signal]}>{SIGNAL[f.signal]}</td>
                <td className="muted">{f.reason}</td>
                <td>{f.locked ? <Badge tone="warning">out of service</Badge> : <Badge tone="neutral">still in use</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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

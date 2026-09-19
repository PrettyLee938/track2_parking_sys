/** Site widgets used on several pages: spot map, gate status, activity feed, cars inside. */
import type { CarView, FeedItem, GateView, SpotView } from "@gpa/shared";
import { STATUS_LABEL, fmtTimeSec, simClock } from "../lib/format";
import { Legend } from "./charts";
import { Badge, Empty, StatusIcon, type Tone } from "./ui";

export type SpotState = "free" | "occupied" | "reserved" | "out";

export const spotState = (s: SpotView): SpotState =>
  s.broken || s.maintenance ? "out" : s.occupant ? "occupied" : s.reserved_for ? "reserved" : "free";

export const SPOT_LEGEND = [
  { label: "Free", color: "var(--free-fill)" },
  { label: "Occupied", color: "var(--s1)" },
  { label: "Reserved (car on its way)", color: "var(--s2)" },
  { label: "Out of service", color: "var(--critical)" },
];

/** Every parking spot as a tile, grouped by zone. Identity is text + color, never color alone. */
export function SpotMap({ spots, selected, onSelect }: { spots: SpotView[]; selected?: string | null; onSelect?: (name: string) => void }) {
  const park = spots.filter((s) => s.purpose === "Park");
  const zones = [...new Set(park.map((s) => s.zone || "-"))].sort();
  if (!park.length) return <Empty>No level loaded yet.</Empty>;
  return (
    <div>
      <Legend items={SPOT_LEGEND} />
      {zones.map((z) => (
        <div key={z} className="zone-block">
          {zones.length > 1 && <h3 className="zone-name">{z}</h3>}
          <div className="spot-grid">
            {park.filter((s) => (s.zone || "-") === z).map((s) => {
              const st = spotState(s);
              const who = s.occupant && s.occupant !== "?" ? s.occupant : s.reserved_for ?? "";
              const label = `${s.name}: ${st === "out" ? (s.broken ? "broken" : "under maintenance") : st}${who ? ` (${who})` : ""}${s.car_type !== "Any" ? `, ${s.car_type} only` : ""}`;
              return (
                <button key={s.name} className={`spot ${st}${selected === s.name ? " selected" : ""}`} title={label} aria-label={label}
                  onClick={onSelect ? () => onSelect(s.name) : undefined} disabled={!onSelect}>
                  <b>{s.name}</b>
                  {st === "out" && <span className="spot-flag" aria-hidden>✕</span>}
                  {s.car_type !== "Any" && <span className="spot-type" aria-hidden>{s.car_type === "Electric" ? "⚡" : "♿"}</span>}
                  <span className="spot-who">{who}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function gateTone(g: GateView): { tone: Tone; text: string } {
  if (g.broken) return { tone: "critical", text: "Broken" };
  if (g.maintenance) return { tone: "warning", text: "Maintenance" };
  if (g.state === "Open") return { tone: "good", text: "Open" };
  if (g.state === "Closed") return { tone: "neutral", text: "Closed" };
  return { tone: "info", text: g.state }; // Opening / Closing
}

export function GateBadge({ gate }: { gate?: GateView }) {
  if (!gate) return <Badge>no barrier</Badge>;
  const { tone, text } = gateTone(gate);
  return (
    <span className="badge-row">
      <Badge tone={tone}>{text}</Badge>
      {gate.hold && <Badge tone="info" title="Held by an operator; the automation will not change it">held {gate.hold}</Badge>}
    </span>
  );
}

export function Feed({ items, limit = 60 }: { items: FeedItem[]; limit?: number }) {
  if (!items.length) return <Empty>No activity yet.</Empty>;
  const tone = (l: string): Tone => (l === "error" ? "critical" : l === "warn" ? "warning" : "neutral");
  return (
    <ol className="feed">
      {[...items].reverse().slice(0, limit).map((f, i) => (
        <li key={i} className={f.level}>
          <time>{fmtTimeSec(f.at)}</time>
          {f.level !== "info" && <StatusIcon tone={tone(f.level)} />}
          <span>{f.msg}</span>
        </li>
      ))}
    </ol>
  );
}

const statusTone = (s: string): Tone =>
  s === "payment_mismatch" ? "critical" : s === "queued" || s === "at_exit" || s === "invoiced" ? "warning" : s === "released" ? "good" : "neutral";

export function CarsTable({ cars }: { cars: CarView[] }) {
  if (!cars.length) return <Empty>No cars inside right now.</Empty>;
  const order = ["queued", "dispatching", "dispatched", "entering", "parked", "to_exit", "at_exit", "invoiced", "payment_mismatch", "released"];
  const sorted = [...cars].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.plate.localeCompare(b.plate));
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Plate</th><th>Status</th><th>Spot</th><th>Type</th><th className="right">Planned</th><th>Arrived</th><th>Parked</th><th className="right">Invoice</th></tr></thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.plate}>
              <td className="mono">{c.plate}</td>
              <td><Badge tone={statusTone(c.status)}>{STATUS_LABEL[c.status] ?? c.status}</Badge></td>
              <td>{c.spot ?? "—"}</td>
              <td>{c.car_type}</td>
              <td className="right">{c.planned_minutes ? `${c.planned_minutes} min` : "—"}</td>
              <td className="mono">{simClock(c.arrived_at)}</td>
              <td className="mono">{simClock(c.parked_at)}</td>
              <td className="right">{c.charge_parking !== null ? (c.charge_parking + (c.charge_electric ?? 0)).toFixed(2) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

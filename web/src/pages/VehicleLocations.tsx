import { useEffect, useState } from "react";
import type { VehicleLocationView } from "@gpa/shared";
import { Badge, Card, Empty } from "../components/ui";
import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";

/** Durable locator for active and recently observed vehicles, including misrouted cars. */
export function VehicleLocations() {
  const [plate, setPlate] = useState("");
  const [items, setItems] = useState<VehicleLocationView[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.vehicleLocations({ plate: plate.trim() || undefined, limit: 300 }).then((r) => alive && setItems(r.items)).catch(() => undefined);
    load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [plate]);
  return <div className="page">
    <Card title="Vehicle locator" subtitle="Every recent sensor observation, including cars that did not reach their assigned spot">
      <div className="filters"><input placeholder="Plate" value={plate} onChange={(e) => setPlate(e.target.value)} aria-label="Plate" /></div>
      {!items.length ? <Empty>No location observations yet.</Empty> : <div className="table-wrap"><table className="data compact">
        <thead><tr><th>When</th><th>Plate</th><th>Location</th><th>Zone</th><th>Assigned</th><th>Actual</th><th>Confidence</th><th>Source</th></tr></thead>
        <tbody>{items.map((v) => <tr key={v.id}><td className="mono">{fmtDateTime(v.at)}</td><td className="mono"><b>{v.plate}</b></td><td>{v.location}</td><td>{v.zone ?? "-"}</td>
          <td>{v.assigned_spot ?? "-"}</td><td>{v.actual_spot ?? "-"}</td><td><Badge tone={v.confidence === "high" ? "good" : v.confidence === "medium" ? "warning" : "critical"}>{v.confidence}</Badge></td><td>{v.source}</td></tr>)}</tbody>
      </table></div>}
    </Card>
  </div>;
}

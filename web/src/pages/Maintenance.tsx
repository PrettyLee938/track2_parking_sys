import { useEffect, useState } from "react";
import type { MaintenanceJobView } from "@gpa/shared";
import { Badge, Card, Empty } from "../components/ui";
import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";

const tone = (status: MaintenanceJobView["status"]) => status === "completed" ? "good" : status === "failed" || status === "outcome_unknown" ? "critical" : "warning";

export function Maintenance() {
  const [items, setItems] = useState<MaintenanceJobView[]>([]);
  useEffect(() => { const load = () => api.maintenance(500).then((r) => setItems(r.items)).catch(() => undefined); load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, []);
  return <div className="page"><Card title="Maintenance schedule" subtitle="Preventive and breakdown work, including jobs waiting for a safe clearance">
    {!items.length ? <Empty>No maintenance jobs yet.</Empty> : <div className="table-wrap"><table className="data compact">
      <thead><tr><th>Updated</th><th>Component</th><th>Zone</th><th>Status</th><th>Reason</th><th>Owner</th></tr></thead>
      <tbody>{items.map((j) => <tr key={j.id}><td className="mono">{fmtDateTime(j.updated_at)}</td><td><b>{j.component_name}</b> <span className="muted">({j.component_kind})</span></td><td>{j.zone ?? "-"}</td>
        <td><Badge tone={tone(j.status)}>{j.status}</Badge></td><td>{j.reason}</td><td>{j.actor ?? "controller"}</td></tr>)}</tbody>
    </table></div>}
  </Card></div>;
}

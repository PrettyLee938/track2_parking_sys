import { useCallback, useEffect, useState } from "react";
import type { IncidentView } from "@gpa/shared";
import { Badge, Button, Card, Empty, useToast } from "../components/ui";
import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";

const tone = (i: IncidentView) => i.status === "open" ? "critical" : i.status === "provisional" ? "warning" : "good";

export function Incidents() {
  const toast = useToast();
  const [items, setItems] = useState<IncidentView[]>([]);
  const load = useCallback(() => api.incidents(undefined, 200).then((r) => setItems(r.items)).catch((e) => toast(false, e.message)), [toast]);
  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [load]);
  const resolve = async (incident: IncidentView) => {
    const resolution = prompt(`Resolution for ${incident.kind}:`);
    if (!resolution?.trim()) return;
    try { await api.resolveIncident(incident.id, resolution.trim()); toast(true, `Incident #${incident.id} resolved`); load(); }
    catch (e) { toast(false, (e as Error).message); }
  };
  return <div className="page"><Card title="Incidents" subtitle="Operational exceptions remain visible until an operator records the recovery evidence">
    {!items.length ? <Empty>No incidents recorded.</Empty> : <div className="table-wrap"><table className="data compact">
      <thead><tr><th>When</th><th>Status</th><th>Kind</th><th>Zone / component</th><th>Reason</th><th /></tr></thead>
      <tbody>{items.map((i) => <tr key={i.id}><td className="mono">{fmtDateTime(i.at)}</td><td><Badge tone={tone(i)}>{i.status}</Badge></td>
        <td><b>#{i.id}</b> {i.kind}</td><td>{i.zone ?? "-"}{i.component ? ` · ${i.component}` : ""}</td><td>{i.reason}</td>
        <td className="right">{i.status === "open" || i.status === "provisional" ? <Button small onClick={() => resolve(i)}>Resolve</Button> : i.resolved_by ? <span className="muted">by {i.resolved_by}</span> : null}</td></tr>)}</tbody>
    </table></div>}
  </Card></div>;
}

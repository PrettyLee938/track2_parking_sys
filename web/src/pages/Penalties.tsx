import { useEffect, useState } from "react";
import type { PenaltyView } from "@gpa/shared";
import { Badge, Card, Empty } from "../components/ui";
import { api } from "../lib/api";
import { fmtDateTime, fmtMoney } from "../lib/format";

export function Penalties() {
  const [items, setItems] = useState<PenaltyView[]>([]);
  useEffect(() => { const load = () => api.penalties(500).then((r) => setItems(r.items)).catch(() => undefined); load(); const id = setInterval(load, 10000); return () => clearInterval(id); }, []);
  return <div className="page"><Card title="Simulator penalties" subtitle="Accepted, deduplicated penalty events. Locally detected incidents are shown separately.">
    {!items.length ? <Empty>No penalties recorded.</Empty> : <div className="table-wrap"><table className="data compact">
      <thead><tr><th>When</th><th>Fine</th><th>Type</th><th>Component / plate</th><th>Reason</th></tr></thead>
      <tbody>{items.map((p) => <tr key={p.id}><td className="mono">{fmtDateTime(p.at)}</td><td><Badge tone="critical">{fmtMoney(p.fine)}</Badge></td><td>{p.type ?? "-"}</td><td>{p.component ?? "-"}</td><td>{p.reason}</td></tr>)}</tbody>
    </table></div>}
  </Card></div>;
}

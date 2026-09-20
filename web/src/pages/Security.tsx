/**
 * Admin only: every delivery the parking network made to us, and what we did with it.
 *
 * This is the page the Level 3 brief asks for - "detect and reject invalid, duplicated,
 * tampered requests ... show them on a dedicated admin page". Rejected deliveries are
 * kept whole, so an admin can open the payload that was actually sent, not a summary of
 * it. Sign-in attempts live here too: both answer the same question, "who is knocking?".
 */
import { useCallback, useEffect, useState } from "react";
import type { DeliveriesResponse, DeliveryRejection, DeliveryView, LoginAttemptView } from "@gpa/shared";
import { DELIVERY_REJECTIONS } from "@gpa/shared";
import { Badge, Button, Card, Empty, Segmented, Tile, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";

/** Plain English for each reason, and how alarming it is. */
const REASON: Record<DeliveryRejection, { label: string; tone: Tone; why: string }> = {
  duplicate: { label: "Duplicate", tone: "neutral", why: "The same delivery arrived twice. Normal: the simulator retries." },
  tampered: { label: "Tampered", tone: "critical", why: "The same event ID came back with a different payload. Somebody rewrote a delivery." },
  unsigned: { label: "Unsigned", tone: "warning", why: "No signature, and this level requires one." },
  bad_signature: { label: "Bad signature", tone: "critical", why: "The signature does not match the payload. A fake payment looks like this." },
  stale: { label: "Stale", tone: "warning", why: "Stamped outside the accepted time window - a replayed delivery." },
  rate_limited: { label: "Rate limited", tone: "warning", why: "More deliveries from one source than the configured ceiling." },
  malformed: { label: "Malformed", tone: "warning", why: "Not valid JSON, or no event class. Probably not the simulator." },
  forbidden_source: { label: "Wrong source", tone: "critical", why: "Came from somewhere other than the local simulator." },
};

type Filter = "all" | "any" | DeliveryRejection;

export function Security() {
  return (
    <div className="page">
      <Deliveries />
      <LoginAttempts />
    </div>
  );
}

function Deliveries() {
  const [filter, setFilter] = useState<Filter>("any");
  const [eventClass, setEventClass] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<DeliveriesResponse | null>(null);
  const limit = 50;

  const load = useCallback(() => {
    api.deliveries({ rejection: filter === "all" ? undefined : filter, class: eventClass || undefined, q: search || undefined, limit, offset })
      .then(setData).catch(() => undefined);
  }, [filter, eventClass, search, offset]);
  useEffect(() => { load(); }, [load]);
  // The filters are the query, so changing one has to start again from the first page.
  useEffect(() => { setOffset(0); }, [filter, eventClass, search]);

  const counts = data?.counts ?? {};
  const refused = DELIVERY_REJECTIONS.reduce((n, r) => n + (counts[r] ?? 0), 0);
  const serious = (counts.tampered ?? 0) + (counts.bad_signature ?? 0) + (counts.forbidden_source ?? 0);

  return (
    <Card title="Deliveries from the parking network"
      subtitle="Everything that arrived at /webhook, accepted or not. Rejected deliveries are kept whole as evidence."
      actions={<Button small onClick={load}>Refresh</Button>}>
      <div className="tiles">
        <Tile label="Accepted" value={(counts.accepted ?? 0).toLocaleString()} tone="good" sub="acted on by the engine" />
        <Tile label="Rejected" value={refused.toLocaleString()} tone={refused ? "warning" : "good"} sub="recorded but not acted on" />
        <Tile label="Needs attention" value={serious.toLocaleString()} tone={serious ? "critical" : "good"}
          sub="tampered, badly signed or from the wrong source" />
        <Tile label="Duplicates" value={(counts.duplicate ?? 0).toLocaleString()} sub="retries of a delivery we already had" />
      </div>

      <div className="inline-form">
        <Segmented label="Show" value={filter} onChange={(v) => setFilter(v as Filter)} options={[
          { value: "all", label: "Everything" },
          { value: "any", label: `Rejected (${refused})` },
          ...DELIVERY_REJECTIONS.filter((r) => counts[r]).map((r) => ({ value: r, label: `${REASON[r].label} (${counts[r]})` })),
        ]} />
        <input placeholder="Event class" value={eventClass} onChange={(e) => setEventClass(e.target.value)} aria-label="Event class" />
        <input placeholder="Event ID, plate or payload text" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search deliveries" />
      </div>

      {!data?.items.length ? <Empty>Nothing matches. That is the result you want here.</Empty> : (
        <>
          <div className="table-wrap tall">
            <table className="data compact">
              <thead><tr><th>When</th><th>Outcome</th><th>Class</th><th>Event ID</th><th>Signature</th><th>Source</th><th>Seq</th><th /></tr></thead>
              <tbody>{data.items.map((d) => <DeliveryRow key={d.id} d={d} />)}</tbody>
            </table>
          </div>
          <div className="btn-row">
            <Button small disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Newer</Button>
            <Button small disabled={offset + limit >= data.total} onClick={() => setOffset(offset + limit)}>Older</Button>
            <span className="muted small">{offset + 1}–{Math.min(offset + limit, data.total)} of {data.total.toLocaleString()}</span>
          </div>
        </>
      )}
    </Card>
  );
}

function DeliveryRow({ d }: { d: DeliveryView }) {
  const [open, setOpen] = useState(false);
  const reason = d.rejection ? REASON[d.rejection] : null;
  return (
    <>
      <tr>
        <td className="mono">{fmtDateTime(d.received_at)}</td>
        <td>{reason ? <Badge tone={reason.tone} title={reason.why}>{reason.label}</Badge> : <Badge tone="good">Accepted</Badge>}</td>
        <td>{d.event_class}</td>
        <td className="mono">{d.event_id ?? "—"}</td>
        <td className="muted">{d.sig ?? "—"}</td>
        <td className="mono muted">{d.source ?? "—"}</td>
        <td className="muted">{d.seq ?? "—"}{d.seq_note && <span title={d.seq_note}> ⚠</span>}</td>
        <td className="right"><Button small variant="ghost" onClick={() => setOpen(!open)}>{open ? "Hide" : "Payload"}</Button></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8}>
            {reason && <p className="muted small">{reason.why}</p>}
            {d.seq_note && <p className="muted small">Sequence: {d.seq_note}</p>}
            <pre className="raw">{JSON.stringify(d.payload, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}

function LoginAttempts() {
  const [items, setItems] = useState<LoginAttemptView[]>([]);
  useEffect(() => {
    const load = () => api.securityLoginAttempts(100).then((r) => setItems(r.items)).catch(() => undefined);
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, []);
  const failed = items.filter((a) => !a.ok).length;
  return (
    <Card title="Sign-in attempts" subtitle="Every attempt on this dashboard, successful or not">
      {!items.length ? <Empty>No sign-in attempts recorded.</Empty> : (
        <>
          <p className="muted small">{items.length} recent attempts, {failed} of them failed.</p>
          <div className="table-wrap tall">
            <table className="data compact">
              <thead><tr><th>When</th><th>User</th><th>Result</th><th>Reason</th><th>From</th></tr></thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{fmtDateTime(a.at)}</td>
                    <td>{a.username}</td>
                    <td>{a.ok ? <Badge tone="good">signed in</Badge> : <Badge tone="warning">failed</Badge>}</td>
                    <td className="muted">{a.reason ?? "—"}</td>
                    <td className="mono muted">{a.ip ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

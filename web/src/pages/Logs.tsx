/** Searchable history: finished visits, raw simulator events, and every command sent. */
import { Fragment, useCallback, useEffect, useState } from "react";
import type { ActionView, EventView, SessionsResponse } from "@gpa/shared";
import { Badge, Button, Card, Empty, Segmented, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { STATUS_LABEL, fmtDateTime, fmtDuration, simClock } from "../lib/format";

type Tab = "visits" | "events" | "commands";
const RANGES = [{ value: 60, label: "1 h" }, { value: 360, label: "6 h" }, { value: 1440, label: "24 h" }, { value: 0, label: "All" }];
const sinceIso = (minutes: number) => (minutes ? new Date(Date.now() - minutes * 60_000).toISOString() : undefined);
const PAGE = 50;

export function Logs() {
  const [tab, setTab] = useState<Tab>("visits");
  return (
    <div className="page">
      <Segmented label="Log" value={tab} onChange={setTab}
        options={[{ value: "visits", label: "Visits" }, { value: "events", label: "Simulator events" }, { value: "commands", label: "Commands" }]} />
      {tab === "visits" && <Visits />}
      {tab === "events" && <Events />}
      {tab === "commands" && <Commands />}
    </div>
  );
}

/** Loads the first page on filter change, "Load more" appends older rows. */
function usePaged<T extends { id: number }>(fetchPage: (before?: number) => Promise<T[]>, deps: unknown[]) {
  const [rows, setRows] = useState<T[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (append: boolean) => {
    setLoading(true);
    try {
      const page = await fetchPage(append ? rows.at(-1)?.id : undefined);
      setRows((r) => (append ? [...r, ...page] : page));
      setMore(page.length === PAGE);
    } finally {
      setLoading(false);
    }
  }, [fetchPage, rows]);
  useEffect(() => { load(false); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { rows, more, loading, loadMore: () => load(true), reload: () => load(false) };
}

const visitTone = (s: string, ok: boolean | null): Tone =>
  s === "gone" ? (ok ? "good" : "critical") : s === "lost" ? "warning" : "neutral";

function Visits() {
  const [plate, setPlate] = useState("");
  const [status, setStatus] = useState("");
  const [range, setRange] = useState(360);
  const fetchPage = useCallback((before?: number) =>
    api.sessions({ plate: plate.trim() || undefined, status: status || undefined, since: sinceIso(range), before, limit: PAGE }).then((r) => r.items),
  [plate, status, range]);
  const { rows, more, loading, loadMore } = usePaged<SessionsResponse["items"][number]>(fetchPage, [plate, status, range]);

  return (
    <Card title="Visits" subtitle="Every finished car visit: arrival, parking time, departure and charges">
      <div className="filters">
        <input placeholder="Plate (e.g. FKC 430)" value={plate} onChange={(e) => setPlate(e.target.value)} aria-label="Plate" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Outcome">
          <option value="">All outcomes</option>
          <option value="gone">Completed</option>
          <option value="turned_away">Turned away (full)</option>
          <option value="neglected">Gave up waiting</option>
          <option value="lost">Record lost</option>
        </select>
        <Segmented label="Time range" value={range} onChange={setRange} options={RANGES} />
      </div>
      {rows.length === 0 && !loading ? <Empty>No visits match.</Empty> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Recorded</th><th>Plate</th><th>Outcome</th><th>Type</th><th>Spot</th><th>Arrived</th><th>Parked</th><th>Left spot</th>
              <th className="right">Planned</th><th className="right">Parked for</th><th className="right">Invoice</th><th className="right">Paid</th></tr></thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td className="mono">{fmtDateTime(v.recorded_at)}</td>
                  <td className="mono">{v.plate}</td>
                  <td><Badge tone={visitTone(v.status, v.payment_ok)}>{v.status === "gone" && v.payment_ok === false ? "Paid wrong amount" : STATUS_LABEL[v.status] ?? v.status}</Badge></td>
                  <td>{v.car_type}</td>
                  <td>{v.spot ?? "—"}</td>
                  <td className="mono">{simClock(v.arrived_at)}</td>
                  <td className="mono">{simClock(v.parked_at)}</td>
                  <td className="mono">{simClock(v.left_spot_at)}</td>
                  <td className="right">{v.planned_minutes ? `${v.planned_minutes} min` : "—"}</td>
                  <td className="right">{fmtDuration(v.parked_seconds)}</td>
                  <td className="right">{v.charge_parking !== null ? (v.charge_parking + (v.charge_electric ?? 0)).toFixed(2) : "—"}</td>
                  <td className="right">{v.paid !== null ? v.paid.toFixed(2) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && <div className="load-more"><Button onClick={loadMore} busy={loading}>Load older</Button></div>}
      <p className="muted small">Times in Arrived / Parked / Left spot are the simulator's clock; "Parked for" is wall-clock (the bill uses the planned game minutes).</p>
    </Card>
  );
}

function eventSummary(e: EventView): string {
  const p = e.payload as Record<string, string>;
  switch (e.event_class) {
    case "car_spot_action": return `${p.Direction === "CarIn" ? "arrived at" : "left"} ${p.SpotName} (${p.SpotType}${p.PlannedParkingDurationInMinutes && p.PlannedParkingDurationInMinutes !== "0" ? `, planned ${p.PlannedParkingDurationInMinutes} min` : ""})`;
    case "gate_action": return `${p.Name} ${p.Action}`;
    case "payment_made": return `paid ${p.Amount}`;
    case "penalty": return `fine ${p.FineAmount}: ${p.Reason}`;
    case "component_broken": return `${p.Type} ${p.Name} broke`;
    case "component_fixed": return `${p.Type} ${p.Name} repaired (${p.RepairCost})`;
    case "carbon_monoxide_event": return `${p.ZoneName} CO ${p.CarbonMonoxideLevel} (${p.DangerLevel})`;
    default: return e.event_class;
  }
}

function Events() {
  const [plate, setPlate] = useState("");
  const [cls, setCls] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const fetchPage = useCallback((before?: number) =>
    api.events({ plate: plate.trim() || undefined, class: cls || undefined, before, limit: PAGE }).then((r) => r.items), [plate, cls]);
  const { rows, more, loading, loadMore } = usePaged<EventView>(fetchPage, [plate, cls]);
  const tone = (c: string): Tone => (c === "penalty" || c === "component_broken" ? "critical" : c === "payment_made" ? "good" : "neutral");

  return (
    <Card title="Simulator events" subtitle="Every webhook received, as stored - select a row for the raw payload">
      <div className="filters">
        <input placeholder="Plate" value={plate} onChange={(e) => setPlate(e.target.value)} aria-label="Plate" />
        <select value={cls} onChange={(e) => setCls(e.target.value)} aria-label="Event type">
          <option value="">All events</option>
          {["car_spot_action", "gate_action", "payment_made", "penalty", "component_broken", "component_fixed", "carbon_monoxide_event"].map((c) =>
            <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {rows.length === 0 && !loading ? <Empty>No events match.</Empty> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Received</th><th>Event</th><th>Plate</th><th>Detail</th><th>Signature</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <Fragment key={e.id}>
                  <tr className="clickable" onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <td className="mono">{fmtDateTime(e.received_at)}</td>
                    <td><Badge tone={tone(e.event_class)}>{e.event_class}</Badge></td>
                    <td className="mono">{e.plate ?? ""}</td>
                    <td>{eventSummary(e)}</td>
                    <td>{e.accepted ? <span className="muted">{e.sig}</span> : <Badge tone="critical">rejected ({e.sig})</Badge>}</td>
                  </tr>
                  {open === e.id && <tr><td colSpan={5}><pre className="raw">{JSON.stringify(e.payload, null, 2)}</pre></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && <div className="load-more"><Button onClick={loadMore} busy={loading}>Load older</Button></div>}
    </Card>
  );
}

function Commands() {
  const [manual, setManual] = useState(false);
  const [rows, setRows] = useState<ActionView[]>([]);
  useEffect(() => { api.actions({ manual, limit: 200 }).then((r) => setRows(r.items)).catch(() => undefined); }, [manual]);
  return (
    <Card title="Commands" subtitle="Everything sent to the simulator, by the controller or by a person"
      actions={<Segmented label="Source" value={manual ? "manual" : "all"} onChange={(v) => setManual(v === "manual")}
        options={[{ value: "all", label: "All" }, { value: "manual", label: "Manual only" }]} />}>
      {!rows.length ? <Empty>No commands.</Empty> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Sent</th><th>By</th><th>Command</th><th>Target</th><th>Result</th><th className="right">Latency</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{fmtDateTime(a.at)}</td>
                  <td>{a.actor ? <b>{a.actor}</b> : <span className="muted">controller</span>}</td>
                  <td>{a.cmd}</td>
                  <td className="mono">{a.args.join(" ")}</td>
                  <td>{a.ok ? <Badge tone="good">ok</Badge> : <Badge tone="critical" title={a.error ?? ""}>failed</Badge>}</td>
                  <td className="right mono">{a.ms.toFixed(1)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

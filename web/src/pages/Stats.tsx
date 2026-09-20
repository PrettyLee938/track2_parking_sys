/** Statistics over a chosen time window, from the database. One filter row scopes every chart. */
import { useEffect, useState } from "react";
import type { SpotView, StatsResponse } from "@gpa/shared";
import { BarList, ChartFrame, ColumnChart, DataTable, Legend, LineChart } from "../components/charts";
import { Card, Empty, Segmented, Tile } from "../components/ui";
import { api } from "../lib/api";
import { fmtInt, fmtMoney, fmtPct, fmtTime } from "../lib/format";

const RANGES = [
  { value: 15, label: "15 min" }, { value: 60, label: "1 h" }, { value: 360, label: "6 h" },
  { value: 1440, label: "24 h" }, { value: 10080, label: "7 days" },
];

export function Stats({ spots }: { spots: SpotView[] }) {
  const [minutes, setMinutes] = useState(60);
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.stats(minutes).then((d) => { if (alive) { setData(d); setError(null); } }).catch((e) => alive && setError(e.message));
    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [minutes]);

  return (
    <div className="page">
      <div className="filter-row">
        <Segmented label="Time range" value={minutes} onChange={setMinutes} options={RANGES} />
        {data && <span className="muted small">{fmtTime(data.since)} - {fmtTime(data.until)} · {data.bucket_s / 60} min intervals · refreshes every 30 s</span>}
      </div>
      {error && <p className="form-error">{error}</p>}
      {/* Hold the previous render while refetching - no skeleton flash. */}
      {data ? <StatsBody d={data} spots={spots} /> : <Empty>Loading…</Empty>}
    </div>
  );
}

export function StatsBody({ d, spots }: { d: StatsResponse; spots: SpotView[] }) {
  const t = d.totals;
  const lost = t.turned_away + t.neglected;
  const bucketLabel = (iso: string) => fmtTime(iso);
  return (
    <>
      <section className="tiles">
        <Tile label="Arrivals" value={fmtInt(t.arrivals)} />
        <Tile label="Completed visits" value={fmtInt(t.departures)} />
        <Tile label="Revenue" value={fmtMoney(t.revenue)} sub={`${fmtMoney(t.avg_ticket)} per visit`} />
        <Tile label="Average planned stay" value={`${t.avg_planned_min} min`} sub="game minutes" />
        <Tile label="Not served" value={fmtInt(lost)} sub={t.arrivals ? `${fmtPct(lost / t.arrivals)} of arrivals` : undefined}
          tone={lost ? "warning" : undefined} />
        <Tile label="Penalties" value={fmtInt(t.penalties)} sub={t.penalties ? `${fmtMoney(t.fines)} in fines` : "None"} tone={t.penalties ? "critical" : "good"} />
        <Tile label="Payment problems" value={fmtInt(t.payment_mismatches + t.escaped)}
          sub={`${t.payment_mismatches} wrong amount · ${t.escaped} left unpaid`} tone={t.payment_mismatches + t.escaped ? "critical" : "good"} />
        <Tile label="Duplicate payments" value={fmtInt(t.duplicate_payments ?? 0)} sub="ignored after an earlier payment" tone={t.duplicate_payments ? "warning" : "good"} />
        <Tile label="Records lost" value={fmtInt(t.lost)} sub="closing event never arrived" />
      </section>

      <div className="grid-2">
        <ChartFrame title="Traffic" subtitle={`Cars per ${d.bucket_s / 60} min`}
          legend={<Legend items={[{ label: "Arrivals", color: "var(--s1)", kind: "line" }, { label: "Departures", color: "var(--s2)", kind: "line" }]} />}
          table={{ columns: [{ key: "t", label: "From" }, { key: "a", label: "Arrivals", align: "right" }, { key: "d", label: "Departures", align: "right" }, { key: "x", label: "Turned away", align: "right" }],
            rows: d.buckets.map((b) => ({ t: bucketLabel(b.t), a: b.arrivals, d: b.departures, x: b.turned_away })) }}>
          <LineChart ariaLabel="Arrivals and departures per interval" x={d.buckets.map((b) => b.t)} xFormat={bucketLabel}
            series={[
              { key: "a", label: "Arrivals", color: "var(--s1)", values: d.buckets.map((b) => b.arrivals) },
              { key: "d", label: "Departures", color: "var(--s2)", values: d.buckets.map((b) => b.departures) },
            ]} />
        </ChartFrame>

        <ChartFrame title="Revenue" subtitle={`Payments received per ${d.bucket_s / 60} min`}
          table={{ columns: [{ key: "t", label: "From" }, { key: "r", label: "Revenue", align: "right" }],
            rows: d.buckets.map((b) => ({ t: bucketLabel(b.t), r: fmtMoney(b.revenue) })) }}>
          <ColumnChart ariaLabel="Revenue per interval" format={fmtMoney} tickFormat={fmtInt}
            data={d.buckets.map((b) => ({ label: bucketLabel(b.t), value: b.revenue, hint: `From ${bucketLabel(b.t)}` }))} />
        </ChartFrame>
      </div>

      <div className="grid-3">
        <ChartFrame title="Outcomes" subtitle="What happened to each car"
          table={{ columns: [{ key: "o", label: "Outcome" }, { key: "n", label: "Cars", align: "right" }],
            rows: outcomes(t).map((o) => ({ o: o.label, n: o.value })) }}>
          <BarList rows={outcomes(t)} format={fmtInt} />
        </ChartFrame>

        <ChartFrame title="Planned stay" subtitle="Completed visits by planned game minutes"
          table={{ columns: [{ key: "m", label: "Minutes" }, { key: "n", label: "Visits", align: "right" }],
            rows: d.stay_histogram.map((s) => ({ m: s.minutes, n: s.count })) }}>
          <ColumnChart ariaLabel="Visits by planned stay" format={fmtInt} height={180}
            data={d.stay_histogram.map((s) => ({ label: `${s.minutes}m`, value: s.count, hint: `${s.minutes} min planned` }))} />
        </ChartFrame>

        <ChartFrame title="Gate cycles" subtitle="Openings in this window - gates need repair after a number of cycles"
          table={{ columns: [{ key: "g", label: "Gate" }, { key: "n", label: "Openings", align: "right" }],
            rows: d.gate_cycles.map((g) => ({ g: g.gate, n: g.opens })) }}>
          <BarList rows={d.gate_cycles.map((g) => ({ label: g.gate, value: g.opens }))} format={fmtInt} />
        </ChartFrame>
      </div>

      <div className="grid-2">
        <SpotUsage usage={d.spot_usage} spots={spots} />
        <ChartFrame title="Penalties by reason" subtitle="Fines from the simulator in this window"
          table={{ columns: [{ key: "r", label: "Reason" }, { key: "n", label: "Count", align: "right" }, { key: "f", label: "Fines", align: "right" }],
            rows: d.penalties_by_reason.map((p) => ({ r: p.reason, n: p.count, f: fmtMoney(p.fines) })) }}>
          <BarList rows={d.penalties_by_reason.map((p) => ({ label: p.reason, value: p.count, note: `· ${fmtMoney(p.fines)}` }))}
            format={fmtInt} empty="No penalties in this window" />
        </ChartFrame>
      </div>

      <Card title="Simulator command health" subtitle="Every command we sent: how many, how many failed, and how long the simulator took">
        <DataTable data={{
          columns: [{ key: "c", label: "Command" }, { key: "n", label: "Sent", align: "right" }, { key: "f", label: "Failed", align: "right" },
            { key: "a", label: "Average", align: "right" }, { key: "p", label: "95th percentile", align: "right" }],
          rows: d.commands.map((c) => ({ c: c.cmd, n: fmtInt(c.count), f: c.failed, a: `${c.avg_ms} ms`, p: `${c.p95_ms} ms` })),
        }} />
      </Card>
    </>
  );
}

const outcomes = (t: StatsResponse["totals"]) => [
  { label: "Completed", value: t.departures },
  { label: "Turned away (full)", value: t.turned_away },
  { label: "Gave up waiting", value: t.neglected },
  { label: "Record lost", value: t.lost },
];

/** Visits per spot as a sequential heat grid (one hue, light -> dark). */
function SpotUsage({ usage, spots }: { usage: StatsResponse["spot_usage"]; spots: SpotView[] }) {
  const visits = new Map(usage.map((u) => [u.spot, u.visits]));
  const park = spots.filter((s) => s.purpose === "Park")
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const max = Math.max(0, ...usage.map((u) => u.visits));
  const step = (v: number) => (v === 0 ? 0 : Math.min(5, Math.ceil((v / Math.max(1, max)) * 5)));
  const bounds = [1, 2, 3, 4, 5].map((k) => Math.ceil((k * max) / 5));
  return (
    <ChartFrame title="Spot usage" subtitle="Completed visits per spot - darker is busier"
      table={{ columns: [{ key: "s", label: "Spot" }, { key: "v", label: "Visits", align: "right" }],
        rows: park.map((s) => ({ s: s.name, v: visits.get(s.name) ?? 0 })).sort((a, b) => b.v - a.v) }}>
      {!park.length ? <Empty>No level loaded yet.</Empty> : (
        <>
          <ul className="legend seq-legend">
            <li><span className="key box" style={{ background: "var(--free-fill)" }} />0</li>
            {max > 0 && [1, 2, 3, 4, 5].map((k) => (
              <li key={k}><span className="key box" style={{ background: `var(--seq-${k})` }} />{k === 1 ? `1-${bounds[0]}` : `≤${bounds[k - 1]}`}</li>
            ))}
          </ul>
          <div className="spot-grid heat">
            {park.map((s) => {
              const v = visits.get(s.name) ?? 0, k = step(v);
              return (
                <div key={s.name} className={`spot heat-${k}`} title={`${s.name}: ${v} visits`} aria-label={`${s.name}: ${v} visits`}>
                  <b>{s.name}</b><span className="spot-who">{v}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </ChartFrame>
  );
}

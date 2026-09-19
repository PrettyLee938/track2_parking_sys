/** The operator's home screen: is the car park healthy right now? */
import type { StateSnapshot } from "@gpa/shared";
import { ChartFrame, LineChart, Legend, StackBar } from "../components/charts";
import { CarsTable, Feed, GateBadge } from "../components/site";
import { Badge, Card, Tile } from "../components/ui";
import { fmtInt, fmtMoney, fmtPct, fmtTime } from "../lib/format";
import { useTimeseries } from "../lib/live";

export function Overview({ s }: { s: StateSnapshot }) {
  const ts = useTimeseries();
  const zones = Object.entries(s.zones);
  const total = zones.reduce((a, [, z]) => ({ cap: a.cap + z.total, occ: a.occ + z.occupied, res: a.res + z.reserved, free: a.free + z.free,
    oos: a.oos + z.out_of_service }), { cap: 0, occ: 0, res: 0, free: 0, oos: 0 });
  const usable = Math.max(1, total.cap - total.oos);
  const occupancy = (total.occ + total.res) / usable;
  const queued = s.entry_lanes.reduce((n, l) => n + l.queue.length, 0);
  const c = s.counters;
  const admitRate = c.arrived ? c.admitted / c.arrived : 0;
  const gate = (name: string | null) => s.gates.find((g) => g.name === name);

  const points = ts?.points ?? [];
  return (
    <div className="page">
      <section className="hero card">
        <div>
          <span className="tile-label">Occupancy</span>
          <div className="hero-figure">{fmtPct(occupancy)}</div>
          <p className="muted">{total.occ} parked · {total.res} on their way · {total.free} free of {total.cap} spots
            {total.oos > 0 && <> · <Badge tone="warning">{total.oos} out of service</Badge></>}</p>
        </div>
        <div className="hero-bar">
          <StackBar total={total.cap} parts={[
            { label: "Occupied", value: total.occ, color: "var(--s1)" },
            { label: "Reserved", value: total.res, color: "var(--s2)" },
            { label: "Free", value: total.free, color: "var(--free-fill)" },
            { label: "Out of service", value: total.oos, color: "var(--critical)" },
          ]} />
          <Legend items={[{ label: "Occupied", color: "var(--s1)" }, { label: "Reserved", color: "var(--s2)" },
            { label: "Free", color: "var(--free-fill)" }, { label: "Out of service", color: "var(--critical)" }]} />
        </div>
      </section>

      <section className="tiles">
        <Tile label="Free spots" value={fmtInt(total.free)} sub={total.free === 0 ? "Full - arrivals are turned away" : undefined} tone={total.free === 0 ? "warning" : undefined} />
        <Tile label="Waiting at entry" value={fmtInt(queued)} sub={queued > 3 ? "Queue building up" : undefined} tone={queued > 3 ? "warning" : undefined} />
        <Tile label="Cars handled" value={fmtInt(c.arrived)} sub={`${fmtPct(admitRate)} admitted`} />
        <Tile label="Completed visits" value={fmtInt(c.exited - c.escaped)} />
        <Tile label="Revenue" value={fmtMoney(c.revenue)} sub="since server start" />
        <Tile label="Turned away" value={fmtInt(c.turned_away + c.neglected)}
          sub={`${c.turned_away} full · ${c.neglected} gave up`} />
        <Tile label="Penalties" value={fmtInt(c.penalties)} sub={c.penalties ? `${fmtMoney(c.fines)} in fines` : "None"}
          tone={c.penalties ? "critical" : "good"} />
        <Tile label="Game speed" value={`×${s.time_scale.toFixed(2)}`} sub={s.time_scale_source} />
      </section>

      <div className="grid-2">
        <ChartFrame title="Occupancy and queue" subtitle={`Last ${Math.round((points.length * (ts?.sample_s ?? 10)) / 60)} min, sampled every ${ts?.sample_s ?? 10}s`}
          legend={<Legend items={[{ label: "Cars parked or on their way", color: "var(--s1)", kind: "line" }, { label: "Waiting at entry", color: "var(--s2)", kind: "line" }]} />}
          table={{ columns: [{ key: "t", label: "Time" }, { key: "occ", label: "Parked + reserved", align: "right" }, { key: "q", label: "Waiting", align: "right" }, { key: "cap", label: "Capacity", align: "right" }],
            rows: [...points].reverse().slice(0, 60).map((p) => ({ t: fmtTime(p.t), occ: p.occupied + p.reserved, q: p.queued, cap: p.capacity })) }}>
          <LineChart ariaLabel="Occupied spots and entry queue over time" x={points.map((p) => p.t)} xFormat={fmtTime} area
            reference={total.cap ? { value: total.cap, label: `capacity ${total.cap}` } : undefined}
            series={[
              { key: "occ", label: "Parked or on their way", color: "var(--s1)", values: points.map((p) => p.occupied + p.reserved) },
              { key: "q", label: "Waiting at entry", color: "var(--s2)", values: points.map((p) => p.queued) },
            ]} />
        </ChartFrame>

        <Card title="Zones" subtitle="Spots by state">
          {zones.map(([name, z]) => (
            <div key={name} className="zone-row">
              <div className="zone-head"><b>{name}</b><span className="muted">{z.free} free / {z.total}</span></div>
              <StackBar total={z.total} parts={[
                { label: "Occupied", value: z.occupied, color: "var(--s1)" }, { label: "Reserved", value: z.reserved, color: "var(--s2)" },
                { label: "Free", value: z.free, color: "var(--free-fill)" }, { label: "Out of service", value: z.out_of_service, color: "var(--critical)" },
              ]} />
            </div>
          ))}
          <h3 className="section-title">Entrances and exits</h3>
          <table className="data compact">
            <tbody>
              {s.entry_lanes.map((l) => (
                <tr key={l.spot}>
                  <td>Entrance {l.spot}</td>
                  <td><GateBadge gate={gate(l.gate)} /></td>
                  <td className="muted">{l.closed ? <Badge tone="warning">closed by admin</Badge> : l.current ? `admitting ${l.current}` : ""}{l.queue.length ? ` · ${l.queue.length} waiting` : ""}</td>
                </tr>
              ))}
              {s.exit_lanes.map((l) => (
                <tr key={l.spot}>
                  <td>Exit {l.spot}</td>
                  <td><GateBadge gate={gate(l.gate)} /></td>
                  <td className="muted">{l.releasing.length ? `letting out ${l.releasing.join(", ")}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Cars inside" subtitle={`${s.active_cars.length} tracked`}><CarsTable cars={s.active_cars} /></Card>
        <Card title="Live activity" subtitle="Newest first"><Feed items={s.feed} /></Card>
      </div>
    </div>
  );
}

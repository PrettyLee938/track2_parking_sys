/**
 * Starter dashboard (workstream 4 builds on this). Everything is typed against
 * @gpa/shared, so a change to the server's /api/state shape breaks the build here.
 */
import type { GateView, SpotView, StateSnapshot } from "@gpa/shared";
import { useLiveState } from "./api";

export function App() {
  const { state, error } = useLiveState();
  return (
    <main>
      <header>
        <h1>Grand Park Auto</h1>
        {state && (
          <span className="meta">
            {state.topology?.name ?? "no level loaded"} · game speed ×{state.time_scale.toFixed(2)} ({state.time_scale_source})
            {" · "}{state.synced ? "synced" : "syncing…"}
          </span>
        )}
      </header>
      {error && <p className="banner">Server unreachable: {error}</p>}
      {state ? <Dashboard s={state} /> : !error && <p className="muted">Loading…</p>}
    </main>
  );
}

function Dashboard({ s }: { s: StateSnapshot }) {
  const c = s.counters;
  const parkSpots = s.spots.filter((x) => x.purpose === "Park");
  return (
    <>
      <section className="tiles">
        <Tile label="Arrived" value={c.arrived} />
        <Tile label="Admitted" value={c.admitted} />
        <Tile label="Exited" value={c.exited} />
        <Tile label="Revenue" value={c.revenue.toFixed(2)} />
        <Tile label="Turned away" value={c.turned_away} warn={c.turned_away > 0} />
        <Tile label="Gave up" value={c.neglected} warn={c.neglected > 0} />
        <Tile label="Penalties" value={c.penalties} warn={c.penalties > 0} />
      </section>

      <section className="grid2">
        <div className="card">
          <h2>Zones</h2>
          {Object.entries(s.zones).map(([name, z]) => (
            <div key={name} className="zone">
              <div className="zone-head"><strong>{name}</strong><span>{z.free} free / {z.total}</span></div>
              <div className="bar">
                <span className="occ" style={{ width: `${(z.occupied / z.total) * 100}%` }} />
                <span className="res" style={{ width: `${(z.reserved / z.total) * 100}%` }} />
                <span className="oos" style={{ width: `${(z.out_of_service / z.total) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>Gates & lanes</h2>
          <table>
            <tbody>
              {s.entry_lanes.map((l) => (
                <tr key={l.spot}><td>Entry {l.spot}</td><td><GateBadge g={s.gates.find((g) => g.name === l.gate)} /></td>
                  <td className="muted">{l.current ? `→ ${l.current}` : ""}{l.queue.length ? ` · ${l.queue.length} waiting` : ""}</td></tr>
              ))}
              {s.exit_lanes.map((l) => (
                <tr key={l.spot}><td>Exit {l.spot}</td><td><GateBadge g={s.gates.find((g) => g.name === l.gate)} /></td>
                  <td className="muted">{l.releasing.length ? `releasing ${l.releasing.join(", ")}` : ""}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Spots</h2>
        <div className="spots">{parkSpots.map((sp) => <SpotCell key={sp.name} sp={sp} />)}</div>
      </section>

      <section className="card">
        <h2>Activity</h2>
        <ol className="feed">
          {[...s.feed].reverse().slice(0, 40).map((f, i) => (
            <li key={i} className={f.level}><time>{new Date(f.at).toLocaleTimeString()}</time>{f.msg}</li>
          ))}
        </ol>
      </section>
    </>
  );
}

const Tile = ({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) => (
  <div className={`tile${warn ? " warn" : ""}`}><span>{label}</span><strong>{value}</strong></div>
);

function GateBadge({ g }: { g?: GateView }) {
  if (!g) return <span className="badge">no gate</span>;
  const cls = g.broken || g.maintenance ? "bad" : g.state === "Open" ? "open" : "";
  return <span className={`badge ${cls}`}>{g.name}: {g.broken ? "broken" : g.maintenance ? "maintenance" : g.state}</span>;
}

function SpotCell({ sp }: { sp: SpotView }) {
  const cls = sp.broken || sp.maintenance ? "oos" : sp.occupant ? "occ" : sp.reserved_for ? "res" : "free";
  const who = sp.occupant && sp.occupant !== "?" ? sp.occupant : sp.reserved_for ?? "";
  return (
    <div className={`spot ${cls}`} title={`${sp.name} (${sp.car_type}) ${who}`}>
      <b>{sp.name}</b>{sp.car_type !== "Any" && <i>{sp.car_type[0]}</i>}
    </div>
  );
}

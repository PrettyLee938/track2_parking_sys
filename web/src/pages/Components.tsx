/**
 * Components: what is broken, what is worn, what the air is doing, and manual control
 * of the lights and exhaust fans.
 *
 * The three Level 2 questions this page answers at a glance:
 *   - is anything out of service right now?
 *   - what is about to need maintenance?
 *   - is any zone's CO high, and are its fans actually running?
 */
import { useEffect, useState } from "react";
import type { ComponentWearView, DeviceView, StateSnapshot, TunableView, ZoneAirView } from "@gpa/shared";
import { Badge, Button, Card, Empty, Segmented, Tile, type Tone } from "../components/ui";
import { useCommand } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDuration, fmtTimeSec } from "../lib/format";

const KIND_LABEL: Record<string, string> = { gate: "Gate", spot: "Spot", light: "Light", fan: "Exhaust fan" };

/** Worn components are ranked by how much of their service interval is used up. */
function wearTone(w: ComponentWearView): Tone {
  if (w.broken) return "critical";
  if (w.maintenance) return "info";
  if (w.ratio >= 1) return "serious";
  if (w.ratio >= 0.75) return "warning";
  return "good";
}

function statusOf(w: ComponentWearView) {
  if (w.broken) return <Badge tone="critical">Broken</Badge>;
  if (w.maintenance) return <Badge tone="info">Maintenance</Badge>;
  if (w.ratio >= 1) return <Badge tone="serious">Service due</Badge>;
  if (w.ratio >= 0.75) return <Badge tone="warning">Wearing</Badge>;
  return <Badge tone="good">OK</Badge>;
}

/** A horizontal bar showing how close a component is to its service interval. */
function WearBar({ ratio, tone }: { ratio: number; tone: Tone }) {
  const pct = Math.min(100, Math.round(ratio * 100));
  return (
    <div className="wear-bar" title={`${pct}% of the service interval`}>
      <div className={`wear-fill ${tone}`} style={{ width: `${Math.max(2, pct)}%` }} />
      <span className="wear-pct">{pct}%</span>
    </div>
  );
}

function AirCard({ air, daytime }: { air: ZoneAirView[]; daytime: boolean | null }) {
  return (
    <Card
      title="Air quality"
      subtitle="Fans start above the action threshold and stop only once the level falls well below it, so they do not chatter"
      actions={daytime === null ? null : <Badge tone="neutral">{daytime ? "Daytime" : "Night"}</Badge>}
    >
      {air.length === 0 ? (
        <Empty>No carbon monoxide readings yet. Levels with CO sensors report them as they change.</Empty>
      ) : (
        <table className="data compact">
          <thead>
            <tr><th>Zone</th><th className="right">CO</th><th>Danger</th><th>Ventilation</th><th className="right">Peak</th><th className="right">Excursions</th><th>Last reading</th></tr>
          </thead>
          <tbody>
            {air.map((z) => (
              <tr key={z.zone}>
                <td><b>{z.zone}</b></td>
                <td className="right">{z.level}</td>
                <td>{z.danger || "—"}</td>
                <td>{z.ventilating ? <Badge tone="warning">Extracting</Badge> : <Badge tone="good">Idle</Badge>}</td>
                <td className="right muted">{z.peak}</td>
                <td className="right muted">{z.excursions}</td>
                <td className="muted small">{z.at ? fmtTimeSec(z.at) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function DeviceCard({ devices }: { devices: DeviceView[] }) {
  const { busy, run } = useCommand();
  if (!devices.length) {
    return (
      <Card title="Lights & exhaust fans">
        <Empty>This level reports no lights or exhaust fans.</Empty>
      </Card>
    );
  }
  const cmd = (d: DeviceView, action: "on" | "off" | "auto" | "repair") => {
    if (action === "repair" && !confirm(`Start maintenance on ${d.name}? It cannot be used until the simulator reports it repaired.`)) return;
    return run(`${d.kind}:${d.name}:${action}`, () => api.device(d.kind, d.name, action));
  };

  // Clicking On or Off takes a device out of automatic control until it is handed back,
  // which is easy to do by accident while testing and then puzzling: the CO and daylight
  // rules appear to stop working. Say so plainly and make it one click to undo.
  const held = devices.filter((d) => d.hold);
  const releaseAll = () =>
    run("devices:auto-all", async () => {
      for (const d of held) await api.device(d.kind, d.name, "auto");
      return { ok: true, message: `${held.length} device${held.length === 1 ? "" : "s"} returned to automatic` };
    });

  return (
    <Card
      title="Lights & exhaust fans"
      subtitle="On and Off take a device out of automatic control until Automatic hands it back to the CO and daylight rules"
      actions={held.length > 0 ? (
        <Button small variant="primary" onClick={releaseAll} busy={busy === "devices:auto-all"}>
          Return all {held.length} to automatic
        </Button>
      ) : null}
    >
      {held.length > 0 && (
        <p className="banner">
          {held.length === 1
            ? `${held[0].name} is held ${held[0].hold} by an operator and is not following the automatic rules.`
            : `${held.length} devices are held by an operator and are not following the automatic rules.`}
          {" "}A fan held off is released automatically if its zone becomes polluted.
        </p>
      )}
      <div className="gate-grid">
        {devices.map((d) => {
          const key = `${d.kind}:${d.name}`;
          const unusable = d.broken || d.maintenance;
          return (
            <div key={key} className="gate-card">
              <div className="gate-head">
                <b>{d.name}</b>
                <span className="muted small">{KIND_LABEL[d.kind]}{d.zone && ` · ${d.zone}`}</span>
              </div>
              <div className="badge-row">
                {d.broken ? <Badge tone="critical">Broken</Badge>
                  : d.maintenance ? <Badge tone="info">Maintenance</Badge>
                  : d.on ? <Badge tone="warning">On</Badge>
                  : <Badge tone="good">Off</Badge>}
                {d.hold && <Badge tone="info" title="Held by an operator; automation will not change it">Held {d.hold}</Badge>}
                {d.pending && <Badge tone="neutral">sending {d.pending}…</Badge>}
              </div>
              <p className="muted small device-reason">{d.reason}</p>
              <div className="btn-row">
                <Button small onClick={() => cmd(d, "on")} busy={busy === `${key}:on`} disabled={unusable || d.hold === "on"}>On</Button>
                <Button small onClick={() => cmd(d, "off")} busy={busy === `${key}:off`} disabled={unusable || d.hold === "off"}>Off</Button>
                <Button small variant="primary" onClick={() => cmd(d, "auto")} busy={busy === `${key}:auto`} disabled={!d.hold}>Automatic</Button>
                {d.kind === "fan" && (
                  <Button small variant="danger" onClick={() => cmd(d, "repair")} busy={busy === `${key}:repair`} disabled={d.maintenance}>Repair</Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * Live tuning of the rules that drive ventilation, lighting and maintenance. Admin only,
 * and the server validates every value again - the form only shortens the feedback loop.
 * Changes take effect immediately and survive a restart.
 */
function SettingsCard() {
  const { busy, run } = useCommand();
  const [items, setItems] = useState<TunableView[] | null>(null);
  const [draft, setDraft] = useState<Record<string, number | boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api.settings().then((r) => {
      setItems(r.items);
      setDraft({});
    }).catch((e) => setError(String(e.message ?? e)));

  useEffect(() => { void load(); }, []);

  if (error) return <Card title="Control settings"><Empty>Could not load settings: {error}</Empty></Card>;
  if (!items) return <Card title="Control settings"><Empty>Loading…</Empty></Card>;

  const valueOf = (t: TunableView) => (t.key in draft ? draft[t.key] : t.value);
  const dirty = Object.keys(draft).filter((k) => {
    const item = items.find((t) => t.key === k);
    return item && draft[k] !== item.value;
  });

  const save = () => {
    setError(null);
    const patch = Object.fromEntries(dirty.map((k) => [k, draft[k]]));
    return run("settings:save", async () => {
      const res = await api.updateSettings(patch);
      await load();
      return res;
    });
  };

  const groups = ["Ventilation", "Lighting", "Maintenance"] as const;
  return (
    <Card
      title="Control settings"
      subtitle="When to ventilate, when to light, when to service. Changes apply at once and are kept across restarts."
      actions={
        <div className="row-gap">
          {dirty.length > 0 && <span className="muted small">{dirty.length} unsaved</span>}
          <Button small onClick={() => setDraft({})} disabled={!dirty.length}>Discard</Button>
          <Button small variant="primary" onClick={save} busy={busy === "settings:save"} disabled={!dirty.length}>
            Save changes
          </Button>
        </div>
      }
    >
      <div className="settings-grid">
        {groups.map((group) => (
          <div key={group} className="settings-group">
            <h3>{group}</h3>
            {items.filter((t) => t.group === group).map((t) => {
              const value = valueOf(t);
              const changed = dirty.includes(t.key);
              return (
                <label key={t.key} className={`setting${changed ? " changed" : ""}`} title={t.help}>
                  <span className="setting-label">{t.label}</span>
                  {t.type === "boolean" ? (
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={(e) => setDraft({ ...draft, [t.key]: e.target.checked })}
                    />
                  ) : (
                    <span className="setting-input">
                      <input
                        type="number"
                        value={String(value)}
                        min={t.inputMin}
                        max={t.inputMax}
                        step={t.step ?? 1}
                        onChange={(e) => setDraft({ ...draft, [t.key]: Number(e.target.value) })}
                      />
                      {t.unit && <span className="muted small">{t.unit}</span>}
                    </span>
                  )}
                  <span className="setting-help muted small">{t.help}</span>
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function Components({ s }: { s: StateSnapshot }) {
  const { can } = useAuth();
  const [kind, setKind] = useState<string>("all");
  const [onlyAttention, setOnlyAttention] = useState(false);

  const all = s.components;
  const outOfService = all.filter((w) => w.broken || w.maintenance);
  const due = all.filter((w) => !w.broken && !w.maintenance && w.ratio >= 1);
  const soon = all.filter((w) => !w.broken && !w.maintenance && w.ratio >= 0.75 && w.ratio < 1);

  const rows = all
    .filter((w) => kind === "all" || w.kind === kind)
    .filter((w) => !onlyAttention || w.broken || w.maintenance || w.ratio >= 0.75);

  return (
    <div className="page">
      <div className="tiles">
        <Tile label="Tracked components" value={all.length} sub="gates, spots, lights, fans" />
        <Tile label="Out of service" value={outOfService.length} tone={outOfService.length ? "critical" : "good"}
          sub={outOfService.length ? outOfService.slice(0, 3).map((w) => w.name).join(", ") : "everything available"} />
        <Tile label="Service due" value={due.length} tone={due.length ? "serious" : "good"} sub="past the service interval" />
        <Tile label="Wearing" value={soon.length} tone={soon.length ? "warning" : "good"} sub="over 75% of the interval" />
        <Tile label="Breakdowns" value={s.counters.breakdowns} tone={s.counters.breakdowns ? "warning" : "good"} sub="reported this run" />
        <Tile label="Preventive repairs" value={s.counters.preventive_repairs} sub="sent before a failure" />
      </div>

      <AirCard air={s.air} daytime={s.daytime} />
      <DeviceCard devices={s.devices} />
      {can("admin") && <SettingsCard />}

      <Card
        title="Usage & maintenance"
        subtitle="Cycles counted since each component's last repair. A gate cycle is one confirmed open; a spot cycle is one car parked."
        actions={
          <div className="row-gap">
            <Segmented
              label="Kind"
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: "All" },
                { value: "gate", label: "Gates" },
                { value: "spot", label: "Spots" },
                { value: "light", label: "Lights" },
                { value: "fan", label: "Fans" },
              ]}
            />
            <label className="check small">
              <input type="checkbox" checked={onlyAttention} onChange={(e) => setOnlyAttention(e.target.checked)} />
              Needs attention
            </label>
          </div>
        }
      >
        {rows.length === 0 ? (
          <Empty>
            {all.length === 0
              ? "No usage recorded yet. Counters start as soon as gates cycle and cars park."
              : "Nothing matches this filter."}
          </Empty>
        ) : (
          <table className="data compact">
            <thead>
              <tr>
                <th>Component</th><th>Kind</th><th>Zone</th><th>Status</th>
                <th className="right">Since repair</th><th>Service interval</th>
                <th className="right">Lifetime</th><th className="right">Breakdowns</th><th className="right">Repairs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => {
                const tone = wearTone(w);
                const isDevice = w.kind === "light" || w.kind === "fan";
                return (
                  <tr key={`${w.kind}:${w.name}`}>
                    <td><b>{w.name}</b></td>
                    <td className="muted">{KIND_LABEL[w.kind]}</td>
                    <td className="muted">{w.zone || "—"}</td>
                    <td>{statusOf(w)}</td>
                    <td className="right">
                      {isDevice
                        ? `${w.cycles_since_repair} on/off · ${fmtDuration(w.runtime_since_repair_game_s)}`
                        : `${w.cycles_since_repair} cycles`}
                    </td>
                    <td><WearBar ratio={w.ratio} tone={tone} /></td>
                    <td className="right muted">{w.cycles}</td>
                    <td className="right muted">{w.breakdowns || "—"}</td>
                    <td className="right muted">{w.repairs || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

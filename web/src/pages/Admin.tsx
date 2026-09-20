/** Admin only: accounts, site controls, audit trail, configuration. */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AuditView, Role, SimulatorClockStatus, UserView } from "@gpa/shared";
import { Badge, Button, Card, Empty, useCommand, useToast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, fmtDateTime } from "../lib/format";

export function Admin() {
  return (
    <div className="page">
      <Users />
      <SimulatorClock />
      <FinancialAdjustments />
      <div className="grid-2">
        <SiteControls />
        <Audit />
      </div>
      <Config />
    </div>
  );
}

function minuteOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

function SimulatorClock() {
  const toast = useToast();
  const [status, setStatus] = useState<SimulatorClockStatus | null>(null);
  const [runId, setRunId] = useState("");
  const [simulatorTime, setSimulatorTime] = useState("");
  const [rate, setRate] = useState("");
  const [dayStart, setDayStart] = useState("");
  const [nightStart, setNightStart] = useState("");
  const [reason, setReason] = useState("");
  const [invalidateReason, setInvalidateReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setStatus(await api.simulatorClock()); }
    catch (error) { toast(false, (error as Error).message); }
  };
  useEffect(() => { void load(); }, []);

  const anchor = async (event: FormEvent) => {
    event.preventDefault();
    const day = minuteOfDay(dayStart), night = minuteOfDay(nightStart), parsedRate = Number(rate);
    if (day === null || night === null) { toast(false, "Enter both boundaries as valid HH:MM times"); return; }
    setBusy(true);
    try {
      const result = await api.anchorSimulatorClock({
        run_id: runId.trim(), simulator_time_iso: simulatorTime.trim(),
        calendar_seconds_per_real_second: parsedRate, day_start_minute: day, night_start_minute: night,
        reason: reason.trim(),
      });
      setStatus(result);
      toast(true, "Manual simulator calendar anchor saved");
    } catch (error) { toast(false, (error as Error).message); }
    finally { setBusy(false); }
  };

  const invalidate = async () => {
    if (invalidateReason.trim().length < 8) { toast(false, "Explain why the manual calendar is no longer trustworthy (8+ characters)"); return; }
    setBusy(true);
    try {
      setStatus(await api.invalidateSimulatorClock({ reason: invalidateReason.trim() }));
      setInvalidateReason("");
      toast(true, "Manual simulator calendar invalidated");
    } catch (error) { toast(false, (error as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Manual simulator calendar" subtitle="Admin only · manually calibrated projection, not a simulator clock">
      {status && (status.status === "available" ? (
        <p><Badge tone="warning">Manual confidence only</Badge> Run <span className="mono">{status.run_id}</span> · modeled time <span className="mono">{status.modeled_time}</span> · {status.is_night ? "night" : "day"}</p>
      ) : (
        <p><Badge tone="warning">Unavailable</Badge> {status.reason.replaceAll("_", " ")}{status.run_id ? <> · run <span className="mono">{status.run_id}</span></> : null}</p>
      ))}
      <ul className="muted small">
        <li>Anchor again after every server restart. A saved anchor from a previous process is deliberately unavailable.</li>
        <li>Invalidate after simulator pause/speed changes or whenever the observed calendar becomes uncertain.</li>
        <li>Daily reports remain server-UTC; unattended lighting is disabled and is not integrated with this manual projection.</li>
      </ul>
      <form className="inline-form" onSubmit={(event) => void anchor(event)}>
        <input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="Simulator run ID" aria-label="Simulator run ID" required />
        <input value={simulatorTime} onChange={(event) => setSimulatorTime(event.target.value)} placeholder="2026-09-20T18:30:00+08:00" aria-label="Observed simulator time with numeric UTC offset" required />
        <input type="number" value={rate} onChange={(event) => setRate(event.target.value)} placeholder="Calibrated calendar seconds / real second" aria-label="Calendar seconds per real second" min="0" step="any" required />
        <input value={dayStart} onChange={(event) => setDayStart(event.target.value)} placeholder="Day starts HH:MM" aria-label="Day start time" required />
        <input value={nightStart} onChange={(event) => setNightStart(event.target.value)} placeholder="Night starts HH:MM" aria-label="Night start time" required />
        <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason / calibration evidence (8+ chars)" aria-label="Anchor reason" required minLength={8} maxLength={500} />
        <Button type="submit" variant="primary" busy={busy}>Save manual anchor</Button>
      </form>
      <div className="inline-form">
        <input value={invalidateReason} onChange={(event) => setInvalidateReason(event.target.value)} placeholder="Why is the current anchor uncertain?" aria-label="Invalidation reason" minLength={8} maxLength={500} />
        <Button variant="danger" onClick={() => void invalidate()} busy={busy}>Invalidate anchor</Button>
        <Button onClick={() => void load()} disabled={busy}>Refresh status</Button>
      </div>
    </Card>
  );
}

function FinancialAdjustments() {
  const toast = useToast();
  const [plate, setPlate] = useState("");
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof api.sessions>>["items"]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.sessions({ plate: plate.trim() || undefined, status: "gone", limit: 50 });
      setSessions(result.items.filter((session) => session.payment_ok === true && !!session.visit_id));
    } catch (error) {
      toast(false, (error as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const adjust = async (session: (typeof sessions)[number]) => {
    const amountText = prompt(`Signed accounting adjustment for visit ${session.visit_id} (major currency units, e.g. -1.25). This will not change the simulator payment:`);
    if (!amountText) return;
    const amount = Number(amountText);
    if (!Number.isFinite(amount) || Math.abs(amount) < 0.005 || Math.abs(amount) > 1_000_000) {
      toast(false, "Enter a nonzero finite amount within the supported limit");
      return;
    }
    const reason = prompt("Reason for this financial adjustment (at least 8 characters):");
    if (!reason || reason.trim().length < 8) return;
    setBusy(session.visit_id!);
    try {
      const result = await api.applyAdjustment(session.visit_id!, {
        request_id: crypto.randomUUID(), expected_version: session.state_version ?? 0, amount, reason: reason.trim(),
      });
      if (!result.ok) throw new Error(result.message);
      toast(true, result.message);
    } catch (error) {
      toast(false, (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Financial adjustments" subtitle="Admin only · records a signed accounting adjustment; it does not alter the simulator's settled charge">
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <input value={plate} onChange={(event) => setPlate(event.target.value)} placeholder="Filter by plate (optional)" aria-label="Filter visits by plate" />
        <Button type="submit" busy={loading}>Find verified paid visits</Button>
      </form>
      {!sessions.length ? <Empty>No verified paid visits found.</Empty> : (
        <div className="table-wrap"><table className="data compact">
          <thead><tr><th>Completed</th><th>Plate</th><th>Visit</th><th>Status</th><th className="right">Action</th></tr></thead>
          <tbody>{sessions.map((session) => <tr key={session.visit_id}>
            <td>{session.left_at ? fmtDateTime(session.left_at) : "—"}</td>
            <td className="mono">{session.plate}</td>
            <td className="mono small">{session.visit_id}</td>
            <td><Badge tone="good">verified paid</Badge></td>
            <td className="right"><Button small onClick={() => void adjust(session)} busy={busy === session.visit_id}>Record adjustment</Button></td>
          </tr>)}</tbody>
        </table></div>
      )}
    </Card>
  );
}

function Users() {
  const { user: me } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState<UserView[]>([]);
  const load = useCallback(() => api.users().then((r) => setUsers(r.items)).catch((e) => toast(false, e.message)), [toast]);
  useEffect(() => { load(); }, [load]);

  const update = async (u: UserView, body: Parameters<typeof api.updateUser>[1], done: string) => {
    try {
      await api.updateUser(u.id, body);
      toast(true, done);
      load();
    } catch (e) {
      toast(false, (e as Error).message);
    }
  };
  const resetPassword = (u: UserView) => {
    const pw = prompt(`New password for ${u.username} (at least 8 characters). They will be signed out everywhere.`);
    if (pw) update(u, { password: pw }, `Password for ${u.username} changed`);
  };

  return (
    <Card title="Users" subtitle="Operators manage traffic; Maintenance users handle equipment work; admins manage users, entrances and the site">
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Created</th><th className="right">Actions</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><b>{u.username}</b>{u.id === me?.id && <span className="muted"> (you)</span>}</td>
                <td>
                  <select value={u.role} aria-label={`Role of ${u.username}`}
                    onChange={(e) => update(u, { role: e.target.value as Role }, `${u.username} is now ${e.target.value}`)}>
                    <option value="operator">Operator</option>
                    <option value="maintenance">Maintenance</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td>{u.disabled ? <Badge tone="warning">Disabled</Badge> : <Badge tone="good">Active</Badge>}</td>
                <td>{u.last_login_at ? ago(u.last_login_at) : <span className="muted">never</span>}</td>
                <td className="muted">{fmtDateTime(u.created_at)}</td>
                <td className="right btn-row end">
                  <Button small onClick={() => resetPassword(u)}>Reset password</Button>
                  <Button small variant={u.disabled ? "primary" : "danger"} disabled={u.id === me?.id}
                    onClick={() => update(u, { disabled: !u.disabled }, `${u.username} ${u.disabled ? "enabled" : "disabled"}`)}>
                    {u.disabled ? "Enable" : "Disable"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CreateUser onCreated={load} />
    </Card>
  );
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("operator");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createUser({ username: username.trim(), password, role });
      toast(true, `Created ${role} ${username.trim()}`);
      setUsername(""); setPassword("");
      onCreated();
    } catch (err) {
      toast(false, (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <h3 className="section-title">Add a user</h3>
      <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} maxLength={32}
        pattern="[A-Za-z0-9_.\-]+" title="Letters, digits, _ . or -" aria-label="New username" />
      <input type="password" placeholder="Password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} required
        minLength={8} autoComplete="new-password" aria-label="New password" />
      <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="New user's role">
        <option value="operator">Operator</option>
        <option value="maintenance">Maintenance</option>
        <option value="admin">Admin</option>
      </select>
      <Button type="submit" variant="primary" busy={busy}>Create</Button>
    </form>
  );
}

function SiteControls() {
  const { busy, run } = useCommand();
  return (
    <Card title="Site" subtitle="Entrances can be closed from the Operations page">
      <p className="muted small">Resync re-reads every spot and gate from the simulator. It has an operational cost in the simulator -
        use it after a restart or if the dashboard disagrees with the simulator window.</p>
      <Button onClick={() => run("resync", api.resync)} busy={busy === "resync"}>Resync with simulator</Button>
    </Card>
  );
}

function Audit() {
  const [items, setItems] = useState<AuditView[]>([]);
  useEffect(() => { api.audit(100).then((r) => setItems(r.items)).catch(() => undefined); }, []);
  return (
    <Card title="Audit trail" subtitle="Administrative and security activity, newest first">
      {!items.length ? <Empty>No audit records yet.</Empty> : (
        <div className="table-wrap tall">
          <table className="data compact">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Reason</th><th>Details</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="mono">{fmtDateTime(item.at)}</td>
                  <td><b>{item.actor_username ?? "System"}</b></td>
                  <td>{item.action}</td>
                  <td>{item.target ?? "—"}</td>
                  <td>{item.reason ?? "—"}</td>
                  <td><details><summary>View</summary><pre className="mono small">{JSON.stringify(item.details, null, 2)}</pre></details></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Config() {
  const [cfg, setCfg] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { api.config().then(setCfg).catch(() => undefined); }, []);
  if (!cfg) return null;
  const envName = (k: string) => "GPA_" + k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return (
    <Card title="Configuration" subtitle="Effective settings of the running server (read-only - change them in .env and restart)">
      <div className="table-wrap tall">
        <table className="data compact">
          <thead><tr><th>Setting</th><th>Variable</th><th>Value</th></tr></thead>
          <tbody>
            {Object.entries(cfg).filter(([, v]) => v !== undefined).map(([k, v]) => (
              <tr key={k}><td>{k}</td><td className="mono muted">{envName(k)}</td><td className="mono">{String(v)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

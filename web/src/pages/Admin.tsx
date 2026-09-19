/** Admin only: accounts, site controls, audit trail, configuration. */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ActionView, Role, UserView } from "@gpa/shared";
import { Badge, Button, Card, Empty, useCommand, useToast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, fmtDateTime } from "../lib/format";

export function Admin() {
  return (
    <div className="page">
      <Users />
      <div className="grid-2">
        <SiteControls />
        <Audit />
      </div>
      <Config />
    </div>
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
    <Card title="Users" subtitle="Operators can monitor and control gates and spots; admins can also manage users, entrances and the site">
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
  const [items, setItems] = useState<ActionView[]>([]);
  useEffect(() => { api.actions({ manual: true, limit: 50 }).then((r) => setItems(r.items)).catch(() => undefined); }, []);
  return (
    <Card title="Audit trail" subtitle="Every command a person sent, newest first">
      {!items.length ? <Empty>No manual commands yet.</Empty> : (
        <div className="table-wrap tall">
          <table className="data compact">
            <thead><tr><th>When</th><th>Who</th><th>Command</th><th>Result</th></tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{fmtDateTime(a.at)}</td>
                  <td><b>{a.actor}</b></td>
                  <td>{a.cmd} <span className="mono">{a.args.join(" ")}</span></td>
                  <td>{a.ok ? <Badge tone="good">ok</Badge> : <Badge tone="critical" title={a.error ?? ""}>failed</Badge>}</td>
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

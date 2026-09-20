/**
 * Dashboard shell: sign-in gate, navigation by role, and the live state every page reads.
 * Roles are enforced by the server; the UI only hides what a role cannot use.
 */
import { useEffect, useState } from "react";
import { Badge, Card, ToastProvider } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import { useLiveState } from "./lib/live";
import { Admin } from "./pages/Admin";
import { Equipment } from "./pages/Equipment";
import { Incidents } from "./pages/Incidents";
import { Login } from "./pages/Login";
import { Logs } from "./pages/Logs";
import { Maintenance } from "./pages/Maintenance";
import { Operations } from "./pages/Operations";
import { Overview } from "./pages/Overview";
import { Penalties } from "./pages/Penalties";
import { Reports } from "./pages/Reports";
import { Security } from "./pages/Security";
import { Stats } from "./pages/Stats";
import type { LoginAttemptView } from "@gpa/shared";
import { fmtDateTime } from "./lib/format";

type Route = "overview" | "operations" | "equipment" | "maintenance" | "incidents" | "penalties" | "reports" | "logs" | "stats" | "security" | "admin";
const ROUTES: { id: Route; label: string; adminOnly?: boolean }[] = [
  { id: "overview", label: "Overview" },
  { id: "operations", label: "Operations" },
  { id: "equipment", label: "Equipment" },
  { id: "maintenance", label: "Maintenance" },
  { id: "incidents", label: "Incidents" },
  { id: "penalties", label: "Penalties" },
  { id: "reports", label: "Reports" },
  { id: "logs", label: "Logs" },
  { id: "stats", label: "Statistics" },
  { id: "security", label: "Security", adminOnly: true },
  { id: "admin", label: "Admin", adminOnly: true },
];

/** The page in the URL hash (#/stats), so pages can be bookmarked and survive a reload. */
function useHashRoute(): Route {
  const read = () => (location.hash.replace(/^#\/?/, "") as Route) || "overview";
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Root />
      </AuthProvider>
    </ToastProvider>
  );
}

function Root() {
  const { user, loading } = useAuth();
  if (loading) return <main className="splash muted">Loading…</main>;
  return user ? <Shell /> : <Login />;
}

function Shell() {
  const { user, signOut, can, previousLoginAttempts } = useAuth();
  const route = useHashRoute();
  const { state, connected } = useLiveState();
  const visible = ROUTES.filter((r) => !r.adminOnly || can("admin"));
  const current = visible.some((r) => r.id === route) ? route : "overview";

  return (
    <>
      <header className="topbar">
        <div className="brand">Grand Park Auto</div>
        <nav>
          {visible.map((r) => (
            <a key={r.id} href={`#/${r.id}`} className={current === r.id ? "on" : ""} aria-current={current === r.id ? "page" : undefined}>{r.label}</a>
          ))}
        </nav>
        <div className="topbar-right">
          {state && <span className="muted small">{state.topology?.name ?? "no level"} · ×{state.time_scale.toFixed(2)}</span>}
          <Badge tone={connected ? "good" : "critical"} title={connected ? "Receiving live updates" : "Live updates interrupted - reconnecting"}>
            {connected ? "Live" : "Offline"}
          </Badge>
          <span className="user">{user!.username} <Badge tone="info">{user!.role}</Badge></span>
          <button className="btn ghost small" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="content">
        <LoginHistory attempts={previousLoginAttempts} />
        {!state ? <p className="muted">Connecting to the control centre…</p> : (
          <>
            {!state.synced && <p className="banner">Waiting for the simulator - start it and load a level.</p>}
            {current === "overview" && <Overview s={state} />}
            {current === "operations" && <Operations s={state} />}
            {current === "equipment" && <Equipment s={state} />}
            {current === "maintenance" && <Maintenance />}
            {current === "incidents" && <Incidents />}
            {current === "penalties" && <Penalties />}
            {current === "reports" && <Reports />}
            {current === "logs" && <Logs />}
            {current === "stats" && <Stats spots={state.spots} />}
            {current === "security" && <Security />}
            {current === "admin" && <Admin />}
          </>
        )}
      </main>
    </>
  );
}

function LoginHistory({ attempts }: { attempts: LoginAttemptView[] }) {
  if (!attempts.length) return null;
  return <Card title="Recent sign-in attempts" subtitle="The three attempts before this session was opened">
    <div className="table-wrap"><table className="data compact"><thead><tr><th>When</th><th>User</th><th>Result</th><th>Reason</th><th>IP</th></tr></thead>
      <tbody>{attempts.map((a) => <tr key={a.id}><td className="mono">{fmtDateTime(a.at)}</td><td>{a.username}</td><td>{a.ok ? "successful" : "failed"}</td><td>{a.reason ?? "-"}</td><td className="mono">{a.ip ?? "-"}</td></tr>)}</tbody>
    </table></div>
  </Card>;
}

/**
 * Dashboard shell: sign-in gate, navigation by role, and the live state every page reads.
 * Roles are enforced by the server; the UI only hides what a role cannot use.
 */
import { useEffect, useState } from "react";
import type { Role } from "@gpa/shared";
import { Badge, Card, ToastProvider } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import { useLiveState } from "./lib/live";
import { Admin } from "./pages/Admin";
import { DailyReports } from "./pages/DailyReports";
import { Incidents } from "./pages/Incidents";
import { Login } from "./pages/Login";
import { Logs } from "./pages/Logs";
import { Maintenance } from "./pages/Maintenance";
import { Operations } from "./pages/Operations";
import { Overview } from "./pages/Overview";
import { Penalties } from "./pages/Penalties";
import { Stats } from "./pages/Stats";

type Route = "overview" | "operations" | "logs" | "stats" | "incidents" | "penalties" | "reports" | "admin" | "maintenance";
const ROUTES: { id: Route; label: string; role: Role }[] = [
  { id: "overview", label: "Overview", role: "operator" },
  { id: "operations", label: "Operations", role: "operator" },
  { id: "logs", label: "Logs", role: "operator" },
  { id: "stats", label: "Statistics", role: "operator" },
  { id: "incidents", label: "Incidents", role: "maintenance" },
  { id: "penalties", label: "Penalties", role: "operator" },
  { id: "reports", label: "Daily reports", role: "maintenance" },
  { id: "maintenance", label: "Maintenance", role: "maintenance" },
  { id: "admin", label: "Admin", role: "admin" },
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
  const { user, signOut, can, previousAttempts } = useAuth();
  const route = useHashRoute();
  const { state, connected } = useLiveState();
  const visible = ROUTES.filter((r) => can(r.role));
  const current = visible.some((r) => r.id === route) ? route : visible[0]?.id;

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
        {previousAttempts.length > 0 && <Card title="Previous sign-in attempts" subtitle="Most recent attempts before this sign-in">
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Time (local)</th><th>Result</th><th>Details</th></tr></thead>
            <tbody>{previousAttempts.map((a) => <tr key={a.id}>
              <td>{new Date(a.attempted_at).toLocaleString()}</td>
              <td><Badge tone={a.success ? "good" : "warning"}>{a.success ? "Success" : "Failed"}</Badge></td>
              <td>{a.category.replaceAll("_", " ")}</td>
            </tr>)}</tbody>
          </table></div>
        </Card>}
        {!state ? <p className="muted">Connecting to the control centre…</p> : (
          <>
            {!state.synced && <p className="banner">Waiting for the simulator - start it and load a level.</p>}
            {current === "overview" && <Overview s={state} />}
            {current === "operations" && <Operations s={state} />}
            {current === "logs" && <Logs />}
            {current === "stats" && <Stats spots={state.spots} />}
            {current === "incidents" && <Incidents />}
            {current === "penalties" && <Penalties />}
            {current === "reports" && <DailyReports maintenanceOnly={user!.role === "maintenance"} />}
            {current === "maintenance" && <Maintenance state={state} />}
            {current === "admin" && <Admin />}
          </>
        )}
      </main>
    </>
  );
}

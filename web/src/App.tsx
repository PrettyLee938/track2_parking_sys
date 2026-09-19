/**
 * Dashboard shell: sign-in gate, navigation by role, and the live state every page reads.
 * Roles are enforced by the server; the UI only hides what a role cannot use.
 */
import { useEffect, useState } from "react";
import { Badge, ToastProvider } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import { useLiveState } from "./lib/live";
import { Admin } from "./pages/Admin";
import { Login } from "./pages/Login";
import { Logs } from "./pages/Logs";
import { Operations } from "./pages/Operations";
import { Overview } from "./pages/Overview";
import { Stats } from "./pages/Stats";

type Route = "overview" | "operations" | "logs" | "stats" | "admin";
const ROUTES: { id: Route; label: string; adminOnly?: boolean }[] = [
  { id: "overview", label: "Overview" },
  { id: "operations", label: "Operations" },
  { id: "logs", label: "Logs" },
  { id: "stats", label: "Statistics" },
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
  const { user, signOut, can } = useAuth();
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
        {!state ? <p className="muted">Connecting to the control centre…</p> : (
          <>
            {!state.synced && <p className="banner">Waiting for the simulator - start it and load a level.</p>}
            {current === "overview" && <Overview s={state} />}
            {current === "operations" && <Operations s={state} />}
            {current === "logs" && <Logs />}
            {current === "stats" && <Stats spots={state.spots} />}
            {current === "admin" && <Admin />}
          </>
        )}
      </main>
    </>
  );
}

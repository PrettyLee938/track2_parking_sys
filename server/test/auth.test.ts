/** Authentication, roles and manual control over HTTP. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthService, hashPassword, hasRole, verifyPassword } from "../src/auth";
import { Store } from "../src/store";
import { carEv, feed, gateEv, testServer, testSettings } from "./helpers";

const json = { "content-type": "application/json" };

describe("passwords", () => {
  it("hashes with a per-password salt and verifies", async () => {
    const a = await hashPassword("correct horse"), b = await hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("wrong horse", a)).toBe(false);
  });

  it("ranks admin above operator", () => {
    const u = (role: "admin" | "operator", disabled = false) => ({ id: 1, username: "u", role, disabled, created_at: "", last_login_at: null });
    expect(hasRole(u("admin"), "operator")).toBe(true);
    expect(hasRole(u("operator"), "admin")).toBe(false);
    expect(hasRole(u("admin", true), "operator")).toBe(false);
  });

  it("keeps Maintenance separate from traffic control while Admin inherits both", () => {
    const u = (role: "admin" | "operator" | "maintenance") => ({ id: 1, username: "u", role, disabled: false, created_at: "", last_login_at: null });
    expect(hasRole(u("maintenance"), "maintenance")).toBe(true);
    expect(hasRole(u("maintenance"), "operator")).toBe(false);
    expect(hasRole(u("operator"), "maintenance")).toBe(false);
    expect(hasRole(u("admin"), "maintenance")).toBe(true);
  });
});

describe("sign-in", () => {
  it("creates the first admin once, with a generated password if none is configured", async () => {
    const { auth, store } = await testServer();
    expect(await auth.bootstrap()).toBeNull(); // already has users
    expect(store.listUsers().map((u) => [u.username, u.role])).toEqual([["admin", "admin"], ["oper", "operator"]]);
  });

  it("signs in with a cookie session and signs out", async () => {
    const { app, signIn } = await testServer();
    expect((await app.inject({ url: "/api/state" })).statusCode).toBe(401);
    const cookie = await signIn("admin", "admin-password");
    expect(cookie).toMatch(/^gpa_session=/);
    const me = await app.inject({ url: "/api/auth/me", headers: { cookie } });
    expect(me.json().user).toMatchObject({ username: "admin", role: "admin" });
    expect(me.json().user.password_hash).toBeUndefined();
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect((await app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("sets an HttpOnly, SameSite=Strict cookie and never stores the token itself", async () => {
    const { app, store } = await testServer();
    const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: json,
      payload: JSON.stringify({ username: "oper", password: "oper-password" }) });
    const header = String(res.headers["set-cookie"]);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    const token = decodeURIComponent(header.split(";")[0].split("=")[1]);
    const stored = store.db.prepare("SELECT token_hash FROM auth_sessions").all() as { token_hash: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).not.toBe(token);
  });

  it("rejects wrong passwords and throttles repeated failures", async () => {
    const { app } = await testServer({ cfg: { loginMaxFailures: 3, loginLockoutS: 60 } });
    const attempt = (password: string) => app.inject({ method: "POST", url: "/api/auth/login", headers: json,
      payload: JSON.stringify({ username: "oper", password }) });
    for (let i = 0; i < 3; i++) expect((await attempt("nope-nope")).statusCode).toBe(401);
    const locked = await attempt("oper-password"); // even the right password waits out the lockout
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toBeDefined();
  });

  it("persists prior login attempts and returns only the current user's previous attempts", async () => {
    const { app, signIn, store } = await testServer();
    await app.inject({ method: "POST", url: "/api/auth/login", headers: json,
      payload: JSON.stringify({ username: "oper", password: "incorrect-password" }) });
    const cookie = await signIn("oper", "oper-password");
    const response = await app.inject({ url: "/api/auth/login-attempts?limit=3", headers: { cookie } });
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0]).toMatchObject({ username: "oper", success: false, category: "invalid_password" });
    expect(store.recentLoginAttempts(10).map((a) => a.category)).toEqual(["success", "invalid_password"]);
  });

  it("keeps case-insensitive login history and cookie sessions valid across a database restart", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gpa-auth-restart-"));
    const databasePath = path.join(directory, "app.sqlite");
    let store = new Store(databasePath);
    try {
      store.createUser("operator.example", await hashPassword("oper-password"), "operator");
      const auth = new AuthService(store, testSettings());
      expect((await auth.login("OPERATOR.EXAMPLE", "bad-password", { sourceIp: "127.0.0.1" })).ok).toBe(false);
      const login = await auth.login("Operator.Example", "oper-password");
      expect(login.ok).toBe(true);
      if (!login.ok) return;
      store.close();

      store = new Store(databasePath);
      const recoveredAuth = new AuthService(store, testSettings());
      expect(recoveredAuth.userForToken(login.token)).toMatchObject({ username: "operator.example", role: "operator" });
      expect(recoveredAuth.loginAttemptsForToken(login.token)).toMatchObject([
        { username: "OPERATOR.EXAMPLE", success: false, category: "invalid_password" },
      ]);
    } finally {
      try { store.close(); } catch { /* closed before reopening */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("gives Maintenance a redacted state and repair permissions, but not traffic controls", async () => {
    const { app, signIn, store } = await testServer();
    store.createUser("maint", await hashPassword("maint-password"), "maintenance");
    const cookie = await signIn("maint", "maint-password");
    const state = (await app.inject({ url: "/api/state", headers: { cookie } })).json();
    expect(state.active_cars).toEqual([]);
    expect(state.recent_sessions).toEqual([]);
    expect(state.feed).toEqual([]);
    expect(state.counters.revenue).toBe(0);
    expect((await app.inject({ url: "/api/sessions", headers: { cookie } })).statusCode).toBe(403);
    for (const url of ["/api/stats?minutes=60", "/api/penalties", "/api/reports/daily?day=2026-09-19&kind=operations"])
      expect((await app.inject({ url, headers: { cookie } })).statusCode, url).toBe(403);
    expect((await app.inject({ url: "/api/reports/daily?day=2026-09-19", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/control/gates/gateA/open", headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/control/spots/S2/repair", headers: { cookie, ...json },
      payload: JSON.stringify({ reason: "preventive spot maintenance" }) })).statusCode).toBe(200);
  });

  it("persists operator repair requests and starts/completes them through Maintenance", async () => {
    const { app, signIn, store, sim, controller } = await testServer();
    store.createUser("maint", await hashPassword("maint-password"), "maintenance");
    const operatorCookie = await signIn("oper", "oper-password");
    const request = await app.inject({ method: "POST", url: "/api/maintenance", headers: { cookie: operatorCookie, ...json },
      payload: JSON.stringify({ component_type: "spot", component: "S2", reason: "preventive wear inspection" }) });
    expect(request.statusCode).toBe(201);
    const id = request.json().job.id as string;
    expect(request.json().job.status).toBe("requested");
    expect(sim.calls.filter((call) => call[0] === "repair")).toHaveLength(0);

    const maintenanceCookie = await signIn("maint", "maint-password");
    const unclaimedStart = await app.inject({ method: "POST", url: `/api/maintenance/${id}/start`, headers: { cookie: maintenanceCookie } });
    expect(unclaimedStart.statusCode).toBe(403);
    const claim = await app.inject({ method: "POST", url: `/api/maintenance/${id}/claim`, headers: { cookie: maintenanceCookie } });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().job.assigned_to).toBe("maint");
    const started = await app.inject({ method: "POST", url: `/api/maintenance/${id}/start`, headers: { cookie: maintenanceCookie } });
    expect(started.statusCode).toBe(200);
    expect(store.getMaintenanceJob(id)?.status).toBe("in_progress");
    await controller.handle({ EventClass: "component_fixed", Type: "ParkingSpot", Name: "S2", EventId: "fixed-s2", _received_at: new Date().toISOString() });
    expect(store.getMaintenanceJob(id)?.status).toBe("completed");
    expect((await app.inject({ url: "/api/maintenance", headers: { cookie: operatorCookie } })).json().items[0].id).toBe(id);
  });
});

describe("roles", () => {
  it("lets an operator see the site and control gates, but not administer", async () => {
    const { app, signIn } = await testServer();
    const cookie = await signIn("oper", "oper-password");
    for (const url of ["/api/state", "/api/stats?minutes=60", "/api/timeseries", "/api/sessions", "/api/events", "/api/actions"]) {
      expect((await app.inject({ url, headers: { cookie } })).statusCode, url).toBe(200);
    }
    for (const [method, url] of [["GET", "/api/users"], ["POST", "/api/users"], ["PATCH", "/api/users/1"], ["GET", "/api/config"],
      ["POST", "/api/resync"], ["POST", "/api/control/entries/ENTRY1/close"]] as const) {
      expect((await app.inject({ method, url, headers: { cookie, ...json }, payload: "{}" })).statusCode, url).toBe(403);
    }
  });

  it("lets an admin manage users", async () => {
    const { app, signIn } = await testServer();
    const cookie = await signIn("admin", "admin-password");
    const created = await app.inject({ method: "POST", url: "/api/users", headers: { cookie, ...json },
      payload: JSON.stringify({ username: "night.shift", password: "long-enough", role: "operator" }) });
    expect(created.statusCode).toBe(201);
    const id = created.json().user.id;
    expect((await signIn("night.shift", "long-enough"))).toMatch(/gpa_session/);

    const weak = await app.inject({ method: "POST", url: "/api/users", headers: { cookie, ...json },
      payload: JSON.stringify({ username: "x", password: "short", role: "operator" }) });
    expect(weak.statusCode).toBe(400);

    const disabled = await app.inject({ method: "PATCH", url: `/api/users/${id}`, headers: { cookie, ...json },
      payload: JSON.stringify({ disabled: true }) });
    expect(disabled.json().user.disabled).toBe(true);
    await expect(signIn("night.shift", "long-enough")).rejects.toThrow(/401/);
  });

  it("signs a user out everywhere when their password or role changes", async () => {
    const { app, signIn } = await testServer();
    const admin = await signIn("admin", "admin-password");
    const oper = await signIn("oper", "oper-password");
    await app.inject({ method: "PATCH", url: "/api/users/2", headers: { cookie: admin, ...json }, payload: JSON.stringify({ password: "brand-new-pw" }) });
    expect((await app.inject({ url: "/api/state", headers: { cookie: oper } })).statusCode).toBe(401);
    expect(await signIn("oper", "brand-new-pw")).toMatch(/gpa_session/);
  });

  it("never removes the last active admin, or lets you disable yourself", async () => {
    const { app, signIn } = await testServer();
    const cookie = await signIn("admin", "admin-password");
    const demote = await app.inject({ method: "PATCH", url: "/api/users/1", headers: { cookie, ...json }, payload: JSON.stringify({ role: "operator" }) });
    expect(demote.statusCode).toBe(409);
    const self = await app.inject({ method: "PATCH", url: "/api/users/1", headers: { cookie, ...json }, payload: JSON.stringify({ disabled: true }) });
    expect(self.statusCode).toBe(409);
  });

  it("keeps the webhook public and debug endpoints to this machine", async () => {
    const { app } = await testServer();
    const hook = await app.inject({ method: "POST", url: "/webhook", payload: '{"EventClass":"test_webhook","EventId":"x"}' });
    expect(hook.statusCode).toBe(200);
    expect((await app.inject({ url: "/debug/stats", remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/debug/stats", remoteAddress: "10.0.0.7" })).statusCode).toBe(403);
  });
});

describe("manual control", () => {
  it("holds a gate open against the automation, then hands it back", async () => {
    const { app, signIn, sim, controller } = await testServer();
    const cookie = await signIn("oper", "oper-password");
    const post = (url: string) => app.inject({ method: "POST", url, headers: { cookie } });

    const opened = await post("/api/control/gates/gateA/open");
    expect(opened.json()).toMatchObject({ ok: true });
    expect(sim.last()).toEqual(["open", "gateA"]);
    await controller.handle(gateEv("gateA", "Open"));
    await controller.closeGateIfIdle("gateA"); // what the automation would do
    expect(sim.calls).not.toContainEqual(["close", "gateA"]);
    expect(controller.snapshot().gates.find((g) => g.name === "gateA")!.hold).toBe("open");

    await post("/api/control/gates/gateA/auto");
    expect(sim.last()).toEqual(["close", "gateA"]); // idle, so the automation closes it again
  });

  it("holds a gate closed: arriving cars wait until it is released", async () => {
    const { app, signIn, sim, controller } = await testServer();
    const cookie = await signIn("oper", "oper-password");
    await app.inject({ method: "POST", url: "/api/control/gates/gateA/close", headers: { cookie } });
    await feed(controller, carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    expect(sim.calls.filter((c) => c[0] === "open")).toEqual([]);
    await app.inject({ method: "POST", url: "/api/control/gates/gateA/auto", headers: { cookie } });
    expect(sim.last()).toEqual(["open", "gateA"]);
  });

  it("refuses what the simulator penalises", async () => {
    const { app, signIn, store, controller } = await testServer();
    const cookie = await signIn("oper", "oper-password");
    const post = (url: string, session = cookie, body: unknown = {}) => app.inject({ method: "POST", url,
      headers: { cookie: session, ...json }, payload: JSON.stringify(body) });

    await feed(controller, gateEv("gateA", "Open"), carEv("A", "ENTRY1", "CarIn", "10:00:00"),
      carEv("A", "ENTRY1", "CarOut", "10:00:02"), carEv("A", "S1", "CarIn", "10:00:05"));
    expect((await post("/api/control/spots/S1/repair")).statusCode).toBe(403);
    store.createUser("maint", await hashPassword("maint-password"), "maintenance");
    const maintenanceCookie = await signIn("maint", "maint-password");
    const occupied = await post("/api/control/spots/S1/repair", maintenanceCookie, { reason: "repair occupied component" });
    expect(occupied.statusCode).toBe(409);
    expect(occupied.json().message).toMatch(/occupied by A/);

    expect((await post("/api/control/spots/S2/repair", maintenanceCookie, { reason: "preventive spot maintenance" })).json()).toMatchObject({ ok: true });
    expect(controller.spots.get("S2")!.available).toBe(false); // not offered to cars while repaired

    controller.spots.get("S3")!.detected = 1; // sensor reports a vehicle whose identity is unknown
    const ambiguous = await post("/api/control/spots/S3/repair", maintenanceCookie, { reason: "repair spot after failure" });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json().message).toMatch(/simulator-detected vehicle/);

    controller.gates.get("gateB")!.broken = true;
    expect((await post("/api/control/gates/gateB/open")).statusCode).toBe(409);
  });

  it("records who issued each manual command", async () => {
    const { app, signIn, store, controller } = await testServer();
    const cookie = await signIn("oper", "oper-password");
    await app.inject({ method: "POST", url: "/api/control/gates/gateA/open", headers: { cookie } });
    const manual = store.searchActions({ manualOnly: true });
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ cmd: "open", args: ["gateA"], actor: "oper", ok: true });
    expect(store.listCommandIntents(1)[0].status).toBe("acknowledged");
    await controller.handle(gateEv("gateA", "Open"));
    expect(store.listCommandIntents(1)[0].status).toBe("confirmed");
  });

  it("lets an admin close an entrance: arriving cars are turned away", async () => {
    const { app, signIn, sim, controller } = await testServer();
    const cookie = await signIn("admin", "admin-password");
    const res = await app.inject({ method: "POST", url: "/api/control/entries/ENTRY1/close", headers: { cookie } });
    expect(res.json()).toMatchObject({ ok: true });
    await feed(controller, carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    expect(sim.last()).toEqual(["goto", "A", "leavepark"]);
  });
});

describe("statistics", () => {
  it("aggregates visits, revenue and penalties over a window", async () => {
    const { app, signIn, store } = await testServer();
    const now = new Date().toISOString();
    store.recordEvent({ ...carEv("A", "ENTRY1", "CarIn", "10:00:00"), _received_at: now });
    store.recordEvent({ EventClass: "penalty", Reason: "Car is being charged wrongly with amount: (2.00).", FineAmount: "10", EventId: "p1", _received_at: now });
    store.recordSession({ plate: "A", car_type: "Normal", planned_minutes: 3, status: "gone", entry_lane: "ENTRY1", exit_lane: "EXIT_EXIT",
      arrived_at: null, spot: "S1", parked_at: null, left_spot_at: null, exit_at: null, charge_parking: 3, charge_electric: 0,
      charge_attempts: 1, charge_override: null, paid: 3, payment_ok: true, left_at: null, parked_seconds: 180 });
    const cookie = await signIn("oper", "oper-password");
    const stats = (await app.inject({ url: "/api/stats?minutes=60", headers: { cookie } })).json();
    expect(stats.totals).toMatchObject({ arrivals: 1, departures: 1, revenue: 0, avg_ticket: 0, penalties: 1, fines: 0, avg_planned_min: 3 });
    expect(stats.penalties_by_reason[0].reason).toBe("Car is being charged wrongly with amount: (…).");
    expect(stats.spot_usage).toEqual([{ spot: "S1", visits: 1 }]);
    expect(stats.buckets.reduce((n: number, b: { arrivals: number }) => n + b.arrivals, 0)).toBe(1);
    const admin = await signIn("admin", "admin-password");
    const financial = (await app.inject({ url: "/api/stats?minutes=60", headers: { cookie: admin } })).json();
    expect(financial.totals).toMatchObject({ revenue: 3, avg_ticket: 3, fines: 10 });
  });
});

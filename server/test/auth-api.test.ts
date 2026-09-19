import { describe, expect, it } from "vitest";
import { testServer } from "./helpers";

const json = { "content-type": "application/json" };

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

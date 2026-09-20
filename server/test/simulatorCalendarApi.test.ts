import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService, hashPassword } from "../src/auth";
import { registerRoutes } from "../src/app";
import { Controller, type Logger } from "../src/controller";
import { Store } from "../src/store";
import { FakeSim, LVL1, silentLog, testServer, testSettings } from "./helpers";

const json = { "content-type": "application/json" };
const validAnchor = {
  run_id: "sim-run-42",
  simulator_time_iso: "2026-09-20T16:30:00+08:00",
  calendar_seconds_per_real_second: 1,
  day_start_minute: 360,
  night_start_minute: 1080,
  reason: "Observed simulator HUD and calibrated against a timed interval.",
};

describe("Admin manual simulator calendar API", () => {
  const closeApps: (() => Promise<void>)[] = [];
  const closeStores: (() => void)[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const close of closeApps.splice(0)) await close();
    for (const close of closeStores.splice(0)) close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("requires Admin for clock status, anchoring, and invalidation", async () => {
    const { app, store, signIn } = await testServer();
    closeApps.push(() => app.close());
    closeStores.push(() => store.close());
    store.createUser("maint", await hashPassword("maint-password"), "maintenance");
    const operator = await signIn("oper", "oper-password");
    const maintenance = await signIn("maint", "maint-password");

    for (const [method, url, payload] of [
      ["GET", "/api/simulator-clock", undefined],
      ["POST", "/api/simulator-clock/anchor", validAnchor],
      ["POST", "/api/simulator-clock/invalidate", { reason: "manual uncertainty" }],
    ] as const) {
      expect((await app.inject({ method, url, headers: payload ? { cookie: operator, ...json } : { cookie: operator },
        payload: payload ? JSON.stringify(payload) : undefined })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: payload ? { cookie: maintenance, ...json } : { cookie: maintenance },
        payload: payload ? JSON.stringify(payload) : undefined })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: payload ? json : {}, payload: payload ? JSON.stringify(payload) : undefined })).statusCode).toBe(401);
    }
  });

  it("rejects invalid anchor input without persisting or auditing it", async () => {
    const { app, store, signIn } = await testServer();
    closeApps.push(() => app.close());
    closeStores.push(() => store.close());
    const admin = await signIn("admin", "admin-password");
    const bad = [
      { ...validAnchor, simulator_time_iso: "2026-09-20T16:30:00Z" },
      { ...validAnchor, calendar_seconds_per_real_second: 0 },
      { ...validAnchor, day_start_minute: 1440 },
      { ...validAnchor, night_start_minute: 360 },
      { ...validAnchor, run_id: "has spaces" },
      { ...validAnchor, reason: "short" },
    ];
    for (const payload of bad) {
      const response = await app.inject({ method: "POST", url: "/api/simulator-clock/anchor", headers: { cookie: admin, ...json },
        payload: JSON.stringify(payload) });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(store.latestSimulatorCalendarRecord()).toBeNull();
    expect(store.searchAudit().filter((record) => record.action.startsWith("simulator_clock."))).toHaveLength(0);
  });

  it("returns unavailable without inventing time, and audits valid anchor and invalidation before/after", async () => {
    const { app, store, signIn } = await testServer();
    closeApps.push(() => app.close());
    closeStores.push(() => store.close());
    const admin = await signIn("admin", "admin-password");

    const absent = await app.inject({ url: "/api/simulator-clock", headers: { cookie: admin } });
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toMatchObject({
      status: "unavailable", confidence: "none", reason: "missing_anchor", run_id: null,
      modeled_time: null, simulator_epoch_ms: null, is_night: null,
    });

    const anchored = await app.inject({ method: "POST", url: "/api/simulator-clock/anchor", headers: { cookie: admin, ...json },
      payload: JSON.stringify(validAnchor) });
    expect(anchored.statusCode).toBe(200);
    expect(anchored.json()).toMatchObject({
      status: "available", confidence: "manual", reason: null, run_id: "sim-run-42",
      modeled_time: "2026-09-20T16:30:00.000+08:00", is_night: false, source: "administrator_anchor",
    });

    const invalidated = await app.inject({ method: "POST", url: "/api/simulator-clock/invalidate", headers: { cookie: admin, ...json },
      payload: JSON.stringify({ reason: "Simulator speed changed during the run." }) });
    expect(invalidated.statusCode).toBe(200);
    expect(invalidated.json()).toMatchObject({
      status: "unavailable", confidence: "none", reason: "manual_invalidation", run_id: "sim-run-42",
      modeled_time: null, is_night: null,
    });

    const records = store.searchAudit().filter((record) => record.action.startsWith("simulator_clock."));
    expect(records.map((record) => record.action)).toEqual(["simulator_clock.invalidate", "simulator_clock.anchor"]);
    expect(records[0]).toMatchObject({ actor_username: "admin", reason: "Simulator speed changed during the run." });
    expect(records[0].details).toMatchObject({
      before: { status: "available", confidence: "manual", run_id: "sim-run-42" },
      after: { status: "unavailable", reason: "manual_invalidation", run_id: "sim-run-42" },
    });
    expect(records[1]).toMatchObject({ actor_username: "admin", reason: validAnchor.reason });
    expect(records[1].details).toMatchObject({
      before: { status: "unavailable", reason: "missing_anchor" },
      after: { status: "available", confidence: "manual", run_id: "sim-run-42", is_night: false },
    });
  });

  it("keeps durable anchors unavailable after a new server process until re-anchored", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sim-calendar-api-"));
    tempDirs.push(dir);
    const cfg = testSettings({ adminPassword: "admin-password" });
    const sim = FakeSim.lvl1();
    const open = async (store: Store) => {
      const controller = new Controller({ sim, cfg, store, log: silentLog as Logger, topologies: [LVL1] });
      const auth = new AuthService(store, cfg);
      await auth.bootstrap();
      const app = Fastify();
      registerRoutes(app, { cfg, controller, store, auth });
      const signIn = async () => {
        const response = await app.inject({ method: "POST", url: "/api/auth/login", headers: json,
          payload: JSON.stringify({ username: cfg.adminUsername, password: "admin-password" }) });
        expect(response.statusCode).toBe(200);
        return String(response.headers["set-cookie"]).split(";")[0];
      };
      return { app, controller, signIn };
    };

    const firstStore = new Store(dir);
    closeStores.push(() => firstStore.close());
    const first = await open(firstStore);
    closeApps.push(() => first.app.close());
    const firstAdmin = await first.signIn();
    const anchorResponse = await first.app.inject({ method: "POST", url: "/api/simulator-clock/anchor", headers: { cookie: firstAdmin, ...json },
      payload: JSON.stringify(validAnchor) });
    expect(anchorResponse.statusCode).toBe(200);
    expect(anchorResponse.json().status).toBe("available");
    await first.app.close();
    closeApps.pop();
    firstStore.close();
    closeStores.pop();

    const secondStore = new Store(dir);
    closeStores.push(() => secondStore.close());
    const second = await open(secondStore);
    closeApps.push(() => second.app.close());
    const secondAdmin = await second.signIn();
    const afterRestart = await second.app.inject({ url: "/api/simulator-clock", headers: { cookie: secondAdmin } });
    expect(afterRestart.statusCode).toBe(200);
    expect(afterRestart.json()).toMatchObject({
      status: "unavailable", confidence: "none", reason: "process_mismatch", run_id: "sim-run-42",
      modeled_time: null, simulator_epoch_ms: null, is_night: null,
    });
  });
});

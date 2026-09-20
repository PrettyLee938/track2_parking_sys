import { describe, expect, it } from "vitest";
import { computeSignature, Intake, parseRaw, signatureStatus } from "../src/webhook";
import { Store } from "../src/store";
import { testServer } from "./helpers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// The worked example from the simulator's webhook documentation.
const SPEC_EXAMPLE = `{"EventClass":"car_spot_action","CarPlateNumber":"WAW 228","SpotName":"ENTRY1","SpotType":"EntrySpot",
"Direction":"CarOut","PlannedParkingDurationInMinutes":"0","EventId":"efa2d3ac-1a6e-47d4-9099-3457270e30ee",
"SequenceId":405,"ServerDateTime":"2026-09-12 14:25:50","RealDateTime":"2026-09-12 14:51:37"}`;

function signedBody(overrides: Record<string, unknown> = {}): string {
  const event = { ...parseRaw(SPEC_EXAMPLE), ...overrides };
  delete event.Signature;
  return JSON.stringify({ ...event, Signature: computeSignature(event) });
}

describe("signature", () => {
  it("matches the documented example", () => {
    expect(computeSignature(parseRaw(SPEC_EXAMPLE))).toBe("80beadedc24aea52b9c6222aba1815d3");
  });

  it("keeps numbers as the text the simulator sent", () => {
    const e = parseRaw('{"a":1.0,"b":63.564693,"c":405}');
    expect(e).toEqual({ a: "1.0", b: "63.564693", c: "405" });
  });

  it("classifies valid, unsigned and tampered events", () => {
    const e = parseRaw(SPEC_EXAMPLE);
    expect(signatureStatus({ ...e, Signature: null })).toBe("unsigned");
    expect(signatureStatus({ ...e, Signature: "80BEADEDC24AEA52B9C6222ABA1815D3" })).toBe("valid");
    expect(signatureStatus({ ...e, CarPlateNumber: "XXX 000", Signature: "80beadedc24aea52b9c6222aba1815d3" })).toBe("invalid");
  });
});

describe("intake", () => {
  it("drops duplicates and flags sequence gaps", () => {
    const intake = new Intake(false);
    expect(intake.check({ EventClass: "x", EventId: "1", SequenceId: "10" }).accept).toBe(true);
    expect(intake.check({ EventClass: "x", EventId: "1", SequenceId: "10" })).toMatchObject({ accept: false, duplicate: true, seqNote: "" });
    expect(intake.check({ EventClass: "x", EventId: "2", SequenceId: "12" }).seqNote).toBe("expected 11, got 12");
  });

  it("drops unsigned events once signatures are required", () => {
    expect(new Intake(true).check({ EventClass: "x", EventId: "1", Signature: null }).accept).toBe(false);
    expect(new Intake(false).check({ EventClass: "x", EventId: "1", Signature: null }).accept).toBe(true);
  });

  it("does not let an untrusted event reserve an ID or move the sequence cursor", () => {
    const intake = new Intake(true);
    expect(intake.check({ EventClass: "x", EventId: "same", SequenceId: "90", Signature: null }))
      .toMatchObject({ accept: false, duplicate: false, conflict: false });
    expect(intake.lastSeq).toBeNull();
    expect(intake.check({ EventClass: "x", EventId: "same", SequenceId: "10", Signature: computeSignature({ EventClass: "x", EventId: "same", SequenceId: "10" }) }))
      .toMatchObject({ accept: true, duplicate: false, conflict: false });
    expect(intake.lastSeq).toBe(10);
  });
});

describe("HTTP", () => {
  async function server() {
    const { app, store, queue, signIn } = await testServer();
    const cookie = await signIn("admin", "admin-password");
    return { app, store, queue, cookie };
  }

  it("records a webhook, hands it to the controller and answers 200", async () => {
    const { app, store, queue } = await server();
    const res = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" }, payload: SPEC_EXAMPLE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(queue.tasks).toHaveLength(1);
    const row = store.db.prepare("SELECT event_class, plate, seq, sig, accepted, profile FROM events").get();
    expect(row).toEqual({ event_class: "car_spot_action", plate: "WAW 228", seq: 405, sig: "unsigned", accepted: 1, profile: "level1" });
  });

  it("answers non-JSON bodies without crashing", async () => {
    const { app, store } = await server();
    const res = await app.inject({ method: "POST", url: "/webhook", payload: "not json" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "malformed JSON payload" });
    const row = store.db.prepare("SELECT event_class, sig, accepted, raw_body FROM events").get();
    expect(row).toEqual({ event_class: "malformed_webhook", sig: "malformed", accepted: 0, raw_body: "not json" });
  });

  it("accepts an exact repeat with 200 but processes it only once", async () => {
    const { app, store, queue } = await server();
    const payload = { "content-type": "application/json" };
    const first = await app.inject({ method: "POST", url: "/webhook", headers: payload, payload: SPEC_EXAMPLE });
    const second = await app.inject({ method: "POST", url: "/webhook", headers: payload, payload: SPEC_EXAMPLE });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(queue.tasks).toHaveLength(1);
    expect(store.db.prepare("SELECT count(*) n FROM events").get()).toEqual({ n: 2 });
    expect(store.db.prepare("SELECT accepted, duplicate, conflict FROM events ORDER BY id DESC LIMIT 1").get())
      .toEqual({ accepted: 0, duplicate: 1, conflict: 0 });
  });

  it("requires a valid signature in the Level 2 profile and does not advance state on rejection", async () => {
    const { app, store, queue } = await testServer({ cfg: { webhookProfile: "level2", requireSignature: false } });
    const invalid = JSON.stringify({ ...parseRaw(signedBody({ EventId: "retry-me", SequenceId: "90", Direction: "CarIn" })), Signature: "not-a-signature" });
    const rejected = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" }, payload: invalid });
    expect(rejected.statusCode).toBe(401);
    expect(queue.tasks).toHaveLength(0);
    expect(store.lastWebhookSequence("level2")).toBeNull();
    expect(store.stats(Date.now() - 60_000, Date.now() + 60_000, 60).totals.arrivals).toBe(0);

    // The invalid delivery did not reserve EventId, so a valid copy is accepted.
    const validSameId = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" },
      payload: signedBody({ EventId: "retry-me", SequenceId: "10" }) });
    expect(validSameId.statusCode).toBe(200);
    expect(queue.tasks).toHaveLength(1);

    const unsigned = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" },
      payload: JSON.stringify({ ...parseRaw(SPEC_EXAMPLE), EventId: "unsigned", SequenceId: "50", Signature: null }) });
    expect(unsigned.statusCode).toBe(401);
    expect(store.lastWebhookSequence("level2")).toBe(10);
    expect(store.db.prepare("SELECT count(*) n FROM events WHERE accepted = 0").get()).toEqual({ n: 2 });
  });

  it("records a signed EventId conflict and never forwards the conflicting payload", async () => {
    const { app, store, queue } = await testServer({ cfg: { webhookProfile: "level2" } });
    const headers = { "content-type": "application/json" };
    expect((await app.inject({ method: "POST", url: "/webhook", headers, payload: signedBody({ EventId: "conflict", SequenceId: "1" }) })).statusCode).toBe(200);
    const conflict = await app.inject({ method: "POST", url: "/webhook", headers,
      payload: signedBody({ EventId: "conflict", SequenceId: "2", CarPlateNumber: "DIFFERENT" }) });
    expect(conflict.statusCode).toBe(409);
    expect(queue.tasks).toHaveLength(1);
    expect(store.db.prepare("SELECT conflict, accepted, rejection_reason FROM events ORDER BY id DESC LIMIT 1").get())
      .toEqual({ conflict: 1, accepted: 0, rejection_reason: "event id reused with different payload" });
    expect(store.lastWebhookSequence("level2")).toBe(1);
  });

  it("keeps event-ID dedupe and sequence progress across Store restarts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gpa-webhook-"));
    try {
      const event = parseRaw(signedBody({ EventId: "durable", SequenceId: "41" }));
      const options = { receivedAt: new Date().toISOString(), rawBody: signedBody({ EventId: "durable", SequenceId: "41" }),
        sig: "valid", trusted: true, profile: "level2" as const };
      const first = new Store(dir);
      expect(first.persistWebhook(event, options)).toMatchObject({ accept: true, duplicate: false, lastSeq: 41 });
      first.close();

      const restarted = new Store(dir);
      expect(restarted.lastWebhookSequence("level2")).toBe(41);
      expect(restarted.persistWebhook(event, { ...options, receivedAt: new Date().toISOString() }))
        .toMatchObject({ accept: false, duplicate: true, conflict: false, lastSeq: 41 });
      restarted.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates a Level 1 event log additively and seeds its durable sequence", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gpa-webhook-migration-"));
    try {
      const file = path.join(dir, "gpa.db");
      const oldDb = new Database(file);
      oldDb.exec(`CREATE TABLE events (
        id INTEGER PRIMARY KEY, event_id TEXT, seq INTEGER, event_class TEXT NOT NULL, plate TEXT, spot TEXT,
        received_at TEXT NOT NULL, received_ms INTEGER NOT NULL, sig TEXT, accepted INTEGER NOT NULL,
        duplicate INTEGER NOT NULL, payload TEXT NOT NULL
      )`);
      const oldEvent = { EventClass: "old", EventId: "legacy", SequenceId: "17", Signature: null };
      oldDb.prepare(`INSERT INTO events (event_id, seq, event_class, received_at, received_ms, sig, accepted, duplicate, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("legacy", 17, "old", new Date().toISOString(), Date.now(), "unsigned", 1, 0, JSON.stringify(oldEvent));
      oldDb.close();

      const upgraded = new Store(dir);
      expect(upgraded.lastWebhookSequence("level1")).toBe(17);
      expect(upgraded.persistWebhook(parseRaw(JSON.stringify(oldEvent)), {
        receivedAt: new Date().toISOString(), rawBody: JSON.stringify(oldEvent), sig: "unsigned", trusted: true, profile: "level1",
      })).toMatchObject({ accept: false, duplicate: true, conflict: false, lastSeq: 17 });
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 503 and never queues a delivery when persistence fails", async () => {
    const { app, store, queue } = await server();
    store.persistWebhook = () => { throw new Error("disk unavailable"); };
    const res = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" }, payload: SPEC_EXAMPLE });
    expect(res.statusCode).toBe(503);
    expect(queue.tasks).toHaveLength(0);
  });

  it("rejects webhook traffic not originating on loopback", async () => {
    const { app, store, queue } = await server();
    const res = await app.inject({ method: "POST", url: "/webhook", remoteAddress: "203.0.113.9",
      headers: { "content-type": "application/json" }, payload: SPEC_EXAMPLE });
    expect(res.statusCode).toBe(403);
    expect(queue.tasks).toHaveLength(0);
    expect(store.db.prepare("SELECT count(*) n FROM events").get()).toEqual({ n: 0 });
  });

  it("serves the dashboard state", async () => {
    const { app, cookie } = await server();
    const state = (await app.inject({ url: "/api/state", headers: { cookie } })).json();
    expect(state).toMatchObject({ synced: true, topology: { name: "test-lvl1" } });
    expect(state.zones.ZONE1).toEqual({ total: 3, occupied: 0, reserved: 0, free: 3, out_of_service: 0 });
  });
});

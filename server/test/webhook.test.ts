import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerRoutes } from "../src/app";
import { Controller } from "../src/controller";
import { Store } from "../src/store";
import { computeSignature, Intake, parseRaw, signatureStatus } from "../src/webhook";
import { FakeSim, LVL1, RecordingQueue, silentLog, testSettings } from "./helpers";

// The worked example from the simulator's webhook documentation.
const SPEC_EXAMPLE = `{"EventClass":"car_spot_action","CarPlateNumber":"WAW 228","SpotName":"ENTRY1","SpotType":"EntrySpot",
"Direction":"CarOut","PlannedParkingDurationInMinutes":"0","EventId":"efa2d3ac-1a6e-47d4-9099-3457270e30ee",
"SequenceId":405,"ServerDateTime":"2026-09-12 14:25:50","RealDateTime":"2026-09-12 14:51:37"}`;

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
});

describe("HTTP", () => {
  async function server() {
    const cfg = testSettings({ closeIdleGatesOnSync: false });
    const store = new Store(":memory:");
    const queue = new RecordingQueue();
    const controller = new Controller({ sim: FakeSim.lvl1(), cfg, store, log: silentLog, topologies: [LVL1], queue });
    await controller.sync();
    const app = Fastify();
    registerRoutes(app, { cfg, controller, store });
    return { app, store, queue };
  }

  it("records a webhook, hands it to the controller and answers 200", async () => {
    const { app, store, queue } = await server();
    const res = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" }, payload: SPEC_EXAMPLE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(queue.tasks).toHaveLength(1);
    const row = store.db.prepare("SELECT event_class, plate, seq, sig FROM events").get();
    expect(row).toEqual({ event_class: "car_spot_action", plate: "WAW 228", seq: 405, sig: "unsigned" });
  });

  it("answers non-JSON bodies without crashing", async () => {
    const { app } = await server();
    const res = await app.inject({ method: "POST", url: "/webhook", payload: "not json" });
    expect(res.json()).toEqual({ ok: false });
  });

  it("serves the dashboard state", async () => {
    const { app } = await server();
    const state = (await app.inject({ url: "/api/state" })).json();
    expect(state).toMatchObject({ synced: true, topology: { name: "test-lvl1" } });
    expect(state.zones.ZONE1).toEqual({ total: 3, occupied: 0, reserved: 0, free: 3, out_of_service: 0 });
  });
});

import { describe, expect, it } from "vitest";
import { computeSignature, DEFAULT_VARIANT, Intake, parseRaw, signatureStatus } from "../src/webhook";
import { testServer } from "./helpers";

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

describe("signature grace", () => {
  const signed = (scheme: string, extra: Record<string, unknown> = {}) => {
    const e = { ...parseRaw(SPEC_EXAMPLE), ...extra };
    return { ...e, Signature: computeSignature(e, scheme) };
  };

  it("processes failing events while the budget lasts, then drops them", () => {
    const intake = new Intake({ requireSignature: true, graceN: 2, autodetect: false });
    const bad = (id: string) => ({ EventClass: "x", EventId: id, Signature: "0".repeat(32) });
    expect(intake.check(bad("1"))).toMatchObject({ accept: true, sig: "invalid", graced: true });
    expect(intake.check(bad("2"))).toMatchObject({ accept: true, graced: true });
    expect(intake.check(bad("3"))).toMatchObject({ accept: false, graced: false });
    expect(intake.stats.sig_graced).toBe(2);
  });

  it("covers unsigned events too, so a level that stops signing is not silently lost", () => {
    const intake = new Intake({ requireSignature: true, graceN: 1, autodetect: false });
    expect(intake.check({ EventClass: "x", EventId: "1", Signature: null })).toMatchObject({
      accept: true, sig: "unsigned", graced: true,
    });
  });

  it("ends grace for good once a signature verifies", () => {
    const intake = new Intake({ requireSignature: true, graceN: 5, autodetect: false });
    expect(intake.check(signed(DEFAULT_VARIANT)).sig).toBe("valid");
    expect(intake.sawValid).toBe(true);
    // A genuinely bad event afterwards is dropped even with budget remaining.
    const res = intake.check({ EventClass: "x", EventId: "9", Signature: "0".repeat(32) });
    expect(res).toMatchObject({ accept: false, graced: false });
    expect(intake.graceLeft).toBe(5);
  });

  it("autodetects a different signing scheme and adopts it", () => {
    const intake = new Intake({ requireSignature: true, graceN: 0 });
    const event = signed("sorted-pairs-amp", { EventId: "a" });
    expect(intake.check(event)).toMatchObject({ accept: true, sig: "valid" });
    expect(intake.scheme).toBe("sorted-pairs-amp");
    expect(intake.stats.sig_autodetected).toBe(1);
    // The adopted scheme is then used directly, with no further sweeping.
    expect(intake.check(signed("sorted-pairs-amp", { EventId: "b" })).sig).toBe("valid");
    expect(intake.stats.sig_autodetected).toBe(1);
  });

  it("does not adopt a scheme once one is known to work", () => {
    const intake = new Intake({ requireSignature: true, graceN: 0 });
    intake.check(signed(DEFAULT_VARIANT, { EventId: "a" }));
    expect(intake.check(signed("sorted-pairs-amp", { EventId: "b" })).sig).toBe("invalid");
    expect(intake.scheme).toBe(DEFAULT_VARIANT);
  });

  it("folds in a shared secret when one is configured", () => {
    const secret = "s3cret";
    const e = parseRaw(SPEC_EXAMPLE);
    const event = { ...e, Signature: computeSignature(e, "sorted-values-pipe+secret-suffix", secret) };
    expect(signatureStatus(event, DEFAULT_VARIANT)).toBe("invalid");
    expect(new Intake({ requireSignature: true, secret }).check(event).sig).toBe("valid");
  });

  it("keeps a diagnosable sample of what failed", () => {
    const intake = new Intake({ requireSignature: true, graceN: 1, autodetect: false });
    intake.check({ EventClass: "x", EventId: "1", A: "1", Signature: "0".repeat(32) });
    const d = intake.diagnosis();
    expect(d.samples).toHaveLength(1);
    expect(d.samples[0]).toMatchObject({ status: "invalid", received: "0".repeat(32), matches: [] });
    expect(d.samples[0].basis).toBe("1|x|1"); // A, EventClass, EventId - sorted, pipe-joined
    expect(d.samples[0].computed).not.toBe(d.samples[0].received);
  });

  it("names the scheme that would have matched", () => {
    const intake = new Intake({ requireSignature: true, graceN: 1, autodetect: false });
    intake.check(signed("order-pairs-amp"));
    expect(intake.diagnosis().samples[0].matches).toContain("order-pairs-amp");
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
    const row = store.db.prepare("SELECT event_class, plate, seq, sig FROM events").get();
    expect(row).toEqual({ event_class: "car_spot_action", plate: "WAW 228", seq: 405, sig: "unsigned" });
  });

  it("answers non-JSON bodies without crashing", async () => {
    const { app } = await server();
    const res = await app.inject({ method: "POST", url: "/webhook", payload: "not json" });
    expect(res.json()).toEqual({ ok: false });
  });

  it("processes a graced event but records it as untrusted", async () => {
    const { app, store, queue } = await testServer({ cfg: { requireSignature: true, signatureGraceN: 1 } });
    const post = (payload: string) =>
      app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" }, payload });

    // Grace spends its one unit: the event reaches the controller...
    expect((await post(SPEC_EXAMPLE)).json()).toEqual({ ok: true });
    expect(queue.tasks).toHaveLength(1);
    // ...but the database still says the signature never verified.
    expect(store.db.prepare("SELECT sig, accepted FROM events").get()).toEqual({ sig: "unsigned", accepted: 1 });

    // Budget gone: the next one is logged and dropped, exactly as the brief requires.
    const second = SPEC_EXAMPLE.replace("efa2d3ac-1a6e-47d4-9099-3457270e30ee", "11111111-1111-1111-1111-111111111111");
    expect((await post(second)).json()).toEqual({ ok: true });
    expect(queue.tasks).toHaveLength(1);
    expect(store.db.prepare("SELECT sig, accepted FROM events ORDER BY id DESC LIMIT 1").get())
      .toEqual({ sig: "unsigned", accepted: 0 });
  });

  it("reports the signing scheme and what failed, to admins only", async () => {
    const { app, signIn } = await testServer({ cfg: { requireSignature: true, signatureGraceN: 1 } });
    await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" }, payload: SPEC_EXAMPLE });
    const d = (await app.inject({ url: "/debug/signature", headers: { cookie: await signIn("admin", "admin-password") } })).json();
    expect(d).toMatchObject({ scheme: DEFAULT_VARIANT, require_signature: true, saw_valid: false, grace_left: 0 });
    expect(d.known_schemes).toContain(DEFAULT_VARIANT);
    expect(d.samples[0]).toMatchObject({ status: "unsigned", received: null });
    expect(d.samples[0].basis).toContain("WAW 228"); // the exact text that was hashed
  });

  it("serves the dashboard state", async () => {
    const { app, cookie } = await server();
    const state = (await app.inject({ url: "/api/state", headers: { cookie } })).json();
    expect(state).toMatchObject({ synced: true, topology: { name: "test-lvl1" } });
    expect(state.zones.ZONE1).toEqual({ total: 3, occupied: 0, reserved: 0, free: 3, out_of_service: 0 });
  });
});

/**
 * Webhook ingress security (Level 3 §7.7).
 *
 * "Detect and reject invalid, duplicated, tampered requests coming from the parking
 * network and log duplicated calls." Every one of these tests checks two things: the
 * right HTTP answer, and that the delivery is still on record with its payload - the
 * evidence the admin page shows.
 */
import { describe, expect, it } from "vitest";
import type { DeliveriesResponse } from "@gpa/shared";
import { RateLimiter, clockSkewS, computeSignature } from "../src/webhook";
import { Store } from "../src/store";
import { testServer } from "./helpers";

const base = (over: Record<string, unknown> = {}) => ({
  EventClass: "car_spot_action", CarPlateNumber: "SEC 001", SpotName: "ENTRY1", SpotType: "EntrySpot",
  Direction: "CarIn", PlannedParkingDurationInMinutes: "2", EventId: "sec-1", SequenceId: "1",
  ServerDateTime: "2026-09-12 14:25:50", ...over,
});
const signed = (over: Record<string, unknown> = {}) => {
  const payload = base(over);
  return { ...payload, Signature: computeSignature(payload) };
};
const post = (app: Awaited<ReturnType<typeof testServer>>["app"], payload: unknown) =>
  app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });

/** Every delivery, newest last, as the store holds it. */
const deliveries = (store: Store) => store.listDeliveries({ limit: 500 }).items.reverse();

describe("rejecting bad deliveries", () => {
  it("refuses a second delivery of an EventId with a different payload, and keeps both", async () => {
    // "tampered": the same EventId came back with the payload rewritten. Never acted on,
    // whatever the signature says - it is the one shape that cannot be an honest retry.
    const { app, store, queue } = await testServer({ cfg: { signatureMode: "monitor" } });
    expect((await post(app, base())).statusCode).toBe(200);
    const res = await post(app, base({ CarPlateNumber: "SEC 999" }));
    expect(res.statusCode).toBe(409);

    const rows = deliveries(store);
    expect(rows.map((d) => d.rejection)).toEqual([null, "tampered"]);
    expect(rows[1].payload.CarPlateNumber).toBe("SEC 999"); // the evidence is kept whole
    expect(queue.tasks).toHaveLength(1);                     // only the first was acted on
    expect(store.listIncidents({ status: "open" }).some((i) => i.kind === "event_id_conflict")).toBe(true);
  });

  it("acknowledges a byte-identical redelivery as a duplicate without acting on it twice", async () => {
    // Webhooks are at-most-once and the simulator retries: answering with an error would
    // only make it try again, so a duplicate gets a 200 and a row saying what it was.
    const { app, store, queue } = await testServer({ cfg: { signatureMode: "monitor" } });
    await post(app, base());
    expect((await post(app, base())).statusCode).toBe(200);
    expect(deliveries(store).map((d) => d.rejection)).toEqual([null, "duplicate"]);
    expect(queue.tasks).toHaveLength(1);
  });

  it("still recognises a duplicate after a restart", async () => {
    // The in-memory id cache dies with the process; event_identities does not. Before
    // this, a restart mid-run let every redelivered event be handled a second time.
    const store = new Store(":memory:");
    const first = await testServer({ store, cfg: { signatureMode: "monitor" } });
    await post(first.app, base());
    const second = await testServer({ store, cfg: { signatureMode: "monitor" } });
    expect((await post(second.app, base())).statusCode).toBe(200);
    expect(second.queue.tasks).toHaveLength(0);
    expect(deliveries(store).map((d) => d.rejection)).toEqual([null, "duplicate"]);
  });

  it("keeps a malformed body as evidence instead of throwing it away", async () => {
    const { app, store } = await testServer();
    expect((await app.inject({ method: "POST", url: "/webhook", payload: "not json at all" })).statusCode).toBe(400);
    const [row] = deliveries(store);
    expect(row.rejection).toBe("malformed");
    expect(row.payload._raw_body).toBe("not json at all");
    expect(row.source).toBeTruthy();
  });

  it("rejects an unsigned delivery in strict mode and records why", async () => {
    const { app, store, queue } = await testServer({ cfg: { signatureMode: "strict" } });
    expect((await post(app, base())).statusCode).toBe(401);
    expect(deliveries(store)[0]).toMatchObject({ rejection: "unsigned", sig: "unsigned", accepted: false });
    expect(queue.tasks).toHaveLength(0);
  });

  it("accepts a correctly signed delivery in strict mode", async () => {
    const { app, store, queue } = await testServer({ cfg: { signatureMode: "strict" } });
    expect((await post(app, signed())).statusCode).toBe(200);
    expect(deliveries(store)[0]).toMatchObject({ rejection: null, sig: "valid", accepted: true });
    expect(queue.tasks).toHaveLength(1);
  });
});

describe("replay window", () => {
  it("is off by default, because the simulator's clock is not ours to trust", async () => {
    // ServerDateTime is the simulator machine's wall clock. If the two clocks disagree,
    // a window on by default would reject every single event - so it is opt-in.
    const { app, store, cfg } = await testServer({ cfg: { signatureMode: "monitor" } });
    expect(cfg.webhookReplayWindowS).toBe(0);
    expect((await post(app, base({ ServerDateTime: "2020-01-01 00:00:00" }))).statusCode).toBe(200);
    expect(deliveries(store)[0].rejection).toBeNull();
  });

  it("refuses a delivery stamped outside the window once one is configured", async () => {
    const { app, store, queue } = await testServer({ cfg: { signatureMode: "monitor", webhookReplayWindowS: 300 } });
    const old = await post(app, base({ ServerDateTime: "2020-01-01 00:00:00" }));
    expect(old.statusCode).toBe(400);
    expect(deliveries(store)[0].rejection).toBe("stale");
    expect(queue.tasks).toHaveLength(0);

    // Inside the window: handled normally. ServerDateTime carries no zone, so it has to
    // be built in local time - exactly the reason the window is off by default.
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const now = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    expect((await post(app, base({ EventId: "sec-2", ServerDateTime: now }))).statusCode).toBe(200);
    expect(queue.tasks).toHaveLength(1);
  });

  it("measures the skew from the ServerDateTime text, and ignores an unusable one", () => {
    const at = Date.parse("2026-09-12T14:25:50");
    expect(clockSkewS("2026-09-12 14:25:50", at)).toBe(0);
    expect(clockSkewS("2026-09-12 14:24:50", at)).toBe(60);
    expect(clockSkewS("2026-09-12 14:26:50", at)).toBe(60); // ahead of us counts too
    expect(clockSkewS(undefined, at)).toBeNull();
    expect(clockSkewS("not a date", at)).toBeNull();
  });
});

describe("per-source rate limit", () => {
  it("lets everything through while it is off", () => {
    const limiter = new RateLimiter(0, 1);
    expect(limiter.enabled).toBe(false);
    for (let i = 0; i < 100; i++) expect(limiter.allow("127.0.0.1")).toBe(true);
  });

  it("allows a burst, then refills at the configured rate, per source", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 3, () => now);
    expect([limiter.allow("a"), limiter.allow("a"), limiter.allow("a"), limiter.allow("a")]).toEqual([true, true, true, false]);
    expect(limiter.allow("b")).toBe(true); // a different source has its own bucket
    now += 1000;                            // one second at 2/s
    expect([limiter.allow("a"), limiter.allow("a"), limiter.allow("a")]).toEqual([true, true, false]);
  });

  it("answers 429 and records the refused delivery", async () => {
    const { app, store } = await testServer({ cfg: { signatureMode: "monitor", webhookRatePerSourcePerS: 1, webhookRateBurst: 2 } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await post(app, base({ EventId: `rl-${i}` }))).statusCode);
    expect(codes.slice(0, 2)).toEqual([200, 200]);
    expect(codes.slice(2)).toEqual([429, 429]);
    expect(deliveries(store).filter((d) => d.rejection === "rate_limited")).toHaveLength(2);
  });
});

describe("the security admin page", () => {
  /** A server with one of each interesting outcome already on record. */
  async function withHistory() {
    const server = await testServer({ cfg: { signatureMode: "strict", adminPassword: "admin-password" } });
    await post(server.app, signed({ EventId: "ok-1" }));                      // accepted
    await post(server.app, signed({ EventId: "ok-1" }));                      // duplicate
    await post(server.app, base({ EventId: "ok-1", CarPlateNumber: "X 1" })); // tampered
    await post(server.app, base({ EventId: "un-1" }));                        // unsigned
    await server.app.inject({ method: "POST", url: "/webhook", payload: "{" }); // malformed
    return server;
  }

  const list = async (server: Awaited<ReturnType<typeof withHistory>>, cookie: string, query = "") =>
    (await server.app.inject({ url: `/api/security/deliveries${query}`, headers: { cookie } })).json() as DeliveriesResponse;

  it("lists every delivery with its reason and counters", async () => {
    const server = await withHistory();
    const cookie = await server.signIn("admin", "admin-password");
    const all = await list(server, cookie);
    expect(all.total).toBe(5);
    expect(all.counts).toEqual({ accepted: 1, duplicate: 1, tampered: 1, unsigned: 1, malformed: 1 });
  });

  it("filters by reason and by event class, and pages", async () => {
    const server = await withHistory();
    const cookie = await server.signIn("admin", "admin-password");
    expect((await list(server, cookie, "?rejection=any")).total).toBe(4);
    expect((await list(server, cookie, "?rejection=tampered")).items.map((d) => d.event_id)).toEqual(["ok-1"]);
    expect((await list(server, cookie, "?class=car_spot_action")).total).toBe(4);
    const page = await list(server, cookie, "?limit=2&offset=1");
    expect([page.total, page.items.length, page.offset]).toEqual([5, 2, 1]);
    expect((await server.app.inject({ url: "/api/security/deliveries?rejection=nonsense", headers: { cookie } })).statusCode).toBe(400);
  });

  it("carries the payload so an admin can see what was actually sent", async () => {
    const server = await withHistory();
    const cookie = await server.signIn("admin", "admin-password");
    const tampered = (await list(server, cookie, "?rejection=tampered")).items[0];
    expect(tampered.payload.CarPlateNumber).toBe("X 1");
    expect(tampered.source).toBeTruthy();
  });

  it("is admin only - payloads carry plates and signatures", async () => {
    const server = await withHistory();
    const operator = await server.signIn("oper", "oper-password");
    expect((await server.app.inject({ url: "/api/security/deliveries", headers: { cookie: operator } })).statusCode).toBe(403);
    expect((await server.app.inject({ url: "/api/security/deliveries" })).statusCode).toBe(401);
    expect((await server.app.inject({ url: "/api/security/intake", headers: { cookie: operator } })).statusCode).toBe(403);
  });

  it("counts each outcome in the live intake figures too", async () => {
    const server = await withHistory();
    const cookie = await server.signIn("admin", "admin-password");
    const stats = (await server.app.inject({ url: "/api/security/intake", headers: { cookie } })).json();
    expect(stats).toMatchObject({ accepted: 1, duplicates: 1, tampered: 1, malformed: 1, signature_mode: "strict" });
  });
});

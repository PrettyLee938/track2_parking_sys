/**
 * Burst safety (Level 3 §7.6).
 *
 * Level 3 runs three car emitters instead of one, so "an event happens and everybody
 * leaves at once" is ordinary traffic rather than a corner case. These tests drive the
 * engine through the REAL SerialQueue (makeQueued) instead of the recording one, because
 * what is being asserted is exactly what the queue guarantees: every submitted event is
 * handled, once, in arrival order, and no car is charged or released twice.
 */
import { describe, expect, it } from "vitest";
import { FakeSim, carEv, fireTimers, gateEv, makeQueued, payEv, spot, testServer } from "./helpers";
import type { Controller } from "../src/controller";

const PLATES = Array.from({ length: 40 }, (_, i) => `BURST ${String(i + 1).padStart(3, "0")}`);

/** A one-zone site with room for everyone, so nothing is turned away for the wrong reason. */
function bigSim() {
  return new FakeSim(
    [...Array.from({ length: 60 }, (_, i) => spot(`S${i + 1}`)), spot("ENTRY1", "EntrySpot", ""), spot("EXIT_EXIT", "ExitSpot")],
    [{ name: "gateA", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, state: "Closed" },
      { name: "gateB", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, state: "Open" }],
  );
}

/** Walk every plate in one at a time and park it, so the burst starts from a full car park. */
async function parkEveryone(c: Controller) {
  await c.handle(gateEv("gateA", "Open"));
  for (const [i, plate] of PLATES.entries()) {
    const t = `10:${String(i).padStart(2, "0")}:00`;
    await c.handle(carEv(plate, "ENTRY1", "CarIn", t));
    const spotName = c.cars.get(plate)!.spot!;
    await c.handle(carEv(plate, "ENTRY1", "CarOut", t));
    await c.handle(carEv(plate, spotName, "CarIn", t));
  }
  // Everyone decides to go at the same moment: they all leave their spots, then all
  // arrive at the exit sensor together.
  for (const plate of PLATES) await c.handle(carEv(plate, c.cars.get(plate)!.spot!, "CarOut", "11:00:00"));
}

describe("simultaneous events", () => {
  it("charges and releases each of 40 cars leaving at once exactly once, in order", async () => {
    const { c, sim, drain } = await makeQueued({ sim: bigSim(), cfg: { gameSpeed: 1 } });
    await parkEveryone(c);

    // The burst itself: 40 exit CarIn webhooks submitted before any of them is handled.
    for (const plate of PLATES) c.submit(carEv(plate, "EXIT_EXIT", "CarIn", "11:00:01"));
    await drain();
    expect(PLATES.filter((p) => c.cars.get(p)?.status === "at_exit")).toHaveLength(PLATES.length);

    await fireTimers(c); // the settle delay before charging (exitChargeDelayGameS)
    const charges = sim.charges();
    expect(charges.map((x) => x[1])).toEqual(PLATES); // one each, in arrival order
    expect(new Set(charges.map((x) => x[1])).size).toBe(PLATES.length);

    // Every car pays; nobody may be released before their own payment.
    for (const plate of PLATES) c.submit(payEv(plate, 2));
    await drain();
    const leave = sim.gotos().filter((g) => g[2] === "leavepark");
    expect(leave.map((x) => x[1])).toEqual(PLATES);

    for (const plate of PLATES) c.submit(carEv(plate, "EXIT_EXIT", "CarOut", "11:00:09"));
    await drain();
    expect(c.counters.exited).toBe(PLATES.length);
    expect(c.counters.escaped).toBe(0);
    expect(c.counters.repeat_exits).toBe(0);
    expect(c.cars.size).toBe(0);
    expect(c.completed.filter((s) => s.payment_ok)).toHaveLength(PLATES.length);
  });

  it("keeps an unpaid car in the burst shut in while the paid ones leave", async () => {
    // The dangerous version of the same burst: if ordering slipped, the gate opened for a
    // paid car could release the unpaid one behind it ("escaped without paying").
    const { c, sim, drain } = await makeQueued({ sim: bigSim(), cfg: { gameSpeed: 1 } });
    await parkEveryone(c);
    for (const plate of PLATES) c.submit(carEv(plate, "EXIT_EXIT", "CarIn", "11:00:01"));
    await drain();
    await fireTimers(c);

    const dodger = PLATES[7];
    for (const plate of PLATES) if (plate !== dodger) c.submit(payEv(plate, 2));
    await drain();

    const leave = sim.gotos().filter((g) => g[2] === "leavepark").map((g) => g[1]);
    expect(leave).not.toContain(dodger);
    expect(leave).toHaveLength(PLATES.length - 1);
    expect(c.cars.get(dodger)!.status).toBe("invoiced");
  });

  it("reports queue depth, the oldest waiting task and handler durations", async () => {
    const { c, queue, drain } = await makeQueued({ sim: bigSim(), cfg: { gameSpeed: 1 } });
    await parkEveryone(c);
    for (const plate of PLATES) c.submit(carEv(plate, "EXIT_EXIT", "CarIn", "11:00:01"));

    const backlog = queue.stats();
    expect(backlog.depth).toBe(PLATES.length);
    expect(backlog.oldest_label).toBe("event car_spot_action");
    expect(backlog.oldest_wait_ms).toBeGreaterThanOrEqual(0);

    await drain();
    const done = queue.stats();
    expect(done.depth).toBe(0);
    expect(done.running).toBeNull();
    expect(done.completed).toBeGreaterThanOrEqual(PLATES.length);
    expect(done.failed).toBe(0);
    expect(done.slowest).toBeTruthy();
    expect(c.snapshot().queue?.completed).toBe(done.completed);
  });

  it("keeps running when one handler throws, and counts it", async () => {
    // Nothing may be lost because an earlier task failed: the queue is the only writer,
    // so a thrown handler must not stop the ones behind it.
    const { queue, drain } = await makeQueued({ sim: bigSim() });
    const ran: string[] = [];
    queue.push(() => { ran.push("a"); }, "a");
    queue.push(() => { throw new Error("boom"); }, "b");
    queue.push(() => { ran.push("c"); }, "c");
    await drain();
    expect(ran).toEqual(["a", "c"]);
    expect(queue.stats().failed).toBe(1);
  });
});

describe("webhook intake under load", () => {
  it("acknowledges the delivery before the controller has handled it", async () => {
    // The response must not wait on the engine: a slow handler would otherwise push back
    // on the simulator and make a burst worse.
    const { app, queue, store } = await testServer();
    const res = await app.inject({ method: "POST", url: "/webhook", payload: JSON.stringify(carEv("Q 1", "ENTRY1", "CarIn", "10:00:00")) });
    expect(res.statusCode).toBe(200);
    expect(queue.tasks).toHaveLength(1);   // queued...
    expect(queue.labels).toEqual(["event car_spot_action"]);
    expect(store.searchEvents({}).length).toBe(1); // ...but already persisted, so it cannot be lost
  });
});

/** Test doubles and event builders shared by the controller tests. */
import Fastify from "fastify";
import type { SimBarrier, SimParkingSpot } from "@gpa/shared";
import { registerRoutes } from "../src/app";
import { AuthService, hashPassword } from "../src/auth";
import { loadSettings, type Settings } from "../src/config";
import { Controller, type Logger } from "../src/controller";
import { GameClock } from "../src/gameClock";
import type { Task, TaskQueue } from "../src/serialQueue";
import type { SimApi } from "../src/simClient";
import { Store, type EventRecord } from "../src/store";
import type { Topology } from "../src/topology";

export type Call = [string, ...(string | number)[]];

export class FakeSim implements SimApi {
  calls: Call[] = [];
  constructor(public spots: SimParkingSpot[], public barriers: SimBarrier[]) {}

  static lvl1(nSpots = 3) {
    return new FakeSim(
      [...Array.from({ length: nSpots }, (_, i) => spot(`S${i + 1}`)), spot("ENTRY1", "EntrySpot", ""), spot("EXIT_EXIT", "ExitSpot")],
      [gate("gateA", "Closed"), gate("gateB", "Open"), gate("gateC", "Open", "")],
    );
  }

  async listParkingSpots() { return this.spots; }
  async listBarriers() { return this.barriers; }
  async openGate(n: string) { this.calls.push(["open", n]); }
  async closeGate(n: string) { this.calls.push(["close", n]); }
  async carGoto(p: string, d: string) { this.calls.push(["goto", p, d]); }
  async carCharge(p: string, pc: number, cc: number) { this.calls.push(["charge", p, pc, cc]); }
  async repairGate(n: string) { this.calls.push(["repair", n]); }
  async repairSpot(n: string) { this.calls.push(["repair", n]); }

  charges() { return this.calls.filter((c) => c[0] === "charge"); }
  gotos() { return this.calls.filter((c) => c[0] === "goto"); }
  last() { return this.calls.at(-1); }
}

/** Collects scheduled tasks instead of running them, so tests stay deterministic. */
export class RecordingQueue implements TaskQueue {
  tasks: Task[] = [];
  push(task: Task) { this.tasks.push(task); }
  /** Manual commands run straight away: tests await them directly. */
  run<T>(fn: () => Promise<T> | T): Promise<T> { return Promise.resolve(fn()); }
}

export function spot(name: string, purpose = "Park", zone = "ZONE1", carType = "Any", detected = 0): SimParkingSpot {
  return { name, purpose, parkingForCarType: carType, zoneParent: zone, detectedCars: detected, broken: false, isUnderMaintenance: false };
}

export function gate(name: string, state = "Closed", zone = "ZONE1"): SimBarrier {
  return { name, zoneParent: zone, broken: false, isUnderMaintenance: false, state };
}

// One-zone site like Level 1
export const LVL1: Topology = {
  name: "test-lvl1",
  entry_lanes: [{ spot: "ENTRY1", gate: "gateA", zone: "ZONE1" }],
  exit_lanes: [{ spot: "EXIT_EXIT", gate: "gateB", zone: "ZONE1" }],
};
// Two independent zones like Level 2
export const TWO_ZONES: Topology = {
  name: "test-2zones",
  entry_lanes: [{ spot: "ENTRY1", gate: "g1", zone: "ZONE1" }, { spot: "ENTRY2", gate: "g3", zone: "ZONE2" }],
  exit_lanes: [{ spot: "EXIT_EXIT", gate: "g2", zone: "ZONE1" }, { spot: "Exit67", gate: "g4", zone: "ZONE2" }],
};

export function twoZoneSim() {
  return new FakeSim(
    [spot("S1"), spot("S2"), spot("S3", "Park", "ZONE2"), spot("S4", "Park", "ZONE2", "Electric"),
      spot("ENTRY1", "EntrySpot", ""), spot("ENTRY2", "EntrySpot", ""),
      spot("EXIT_EXIT", "ExitSpot"), spot("Exit67", "ExitSpot", "ZONE2")],
    [gate("g1"), gate("g2", "Open"), gate("g3", "Closed", "ZONE2"), gate("g4", "Open", "ZONE2")],
  );
}

let seq = 0;
const nextId = () => `e${++seq}`;
const SPOT_TYPES: Record<string, string> = { ENTRY1: "EntrySpot", ENTRY2: "EntrySpot", EXIT_EXIT: "ExitSpot", Exit67: "ExitSpot" };

export function carEv(plate: string, spotName: string, direction: "CarIn" | "CarOut", t: string, planned = "2", carType = "Normal"): EventRecord {
  return {
    EventClass: "car_spot_action", CarPlateNumber: plate, SpotName: spotName, SpotType: SPOT_TYPES[spotName] ?? "Park",
    CarType: carType, Direction: direction, PlannedParkingDurationInMinutes: planned, EventId: nextId(),
    ServerDateTime: `2026-09-19 ${t}`, _received_at: "",
  };
}

export const gateEv = (name: string, action: string): EventRecord =>
  ({ EventClass: "gate_action", Name: name, Action: action, EventId: nextId(), _received_at: "" });

export const payEv = (plate: string, amount: number): EventRecord =>
  ({ EventClass: "payment_made", CarPlateNumber: plate, Amount: amount.toFixed(2), Reason: "Car Payment", EventId: nextId(), _received_at: "" });

export const penaltyEv = (component: string, reason = "Car should be charged at the exit."): EventRecord =>
  ({ EventClass: "penalty", Reason: reason, FineAmount: "10", Type: "Car", ComponentName: component, EventId: nextId(), _received_at: "" });

export const at = (realS: number) => new Date(realS * 1000).toISOString();

export const silentLog: Logger = { info() {}, warn() {}, error() {} };

export function testSettings(overrides: Partial<Settings> = {}): Settings {
  return loadSettings({}, overrides);
}

export async function make(opts: { sim?: FakeSim; topo?: Topology; topologies?: Topology[]; cfg?: Partial<Settings> } = {}) {
  const sim = opts.sim ?? FakeSim.lvl1();
  const store = new Store(":memory:");
  const queue = new RecordingQueue();
  // closeIdleGatesOnSync off keeps call logs simple; it has its own test.
  const cfg = testSettings({ closeIdleGatesOnSync: false, ...opts.cfg });
  // The clock reads a hand-driven wall clock, starting at the real one (replayed events
  // carry real timestamps).
  const time = { now: Date.now() / 1000 };
  const clock = new GameClock(cfg, () => time.now);
  const c = new Controller({ sim, cfg, store, queue, clock, log: silentLog, topologies: opts.topologies ?? [opts.topo ?? LVL1] });
  await c.sync();
  /** Let realS wall-clock seconds pass. live: the simulator keeps sending events meanwhile
   * (false = silent, as when the game is paused). */
  const advance = (realS: number, live = true) => {
    for (let left = realS; left > 0; left -= 5) {
      time.now += Math.min(5, left);
      if (live) clock.activity();
    }
  };
  return { c, sim, store, queue, clock, advance };
}

/**
 * A Fastify app with routes, a synced controller and two accounts:
 * admin / admin-password and oper / oper-password.
 */
export async function testServer(opts: { cfg?: Partial<Settings>; sim?: FakeSim } = {}) {
  const cfg = testSettings({ closeIdleGatesOnSync: false, adminPassword: "admin-password", ...opts.cfg });
  const store = new Store(":memory:");
  const queue = new RecordingQueue();
  const sim = opts.sim ?? FakeSim.lvl1();
  const controller = new Controller({ sim, cfg, store, log: silentLog, topologies: [LVL1], queue });
  await controller.sync();
  const auth = new AuthService(store, cfg);
  await auth.bootstrap();
  store.createUser("oper", await hashPassword("oper-password"), "operator");
  const app = Fastify();
  registerRoutes(app, { cfg, controller, store, auth });

  /** Sign in and return the Cookie header to send with later requests. */
  const signIn = async (username: string, password: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: JSON.stringify({ username, password }),
      headers: { "content-type": "application/json" } });
    if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.statusCode} ${res.body}`);
    return String(res.headers["set-cookie"]).split(";")[0];
  };
  return { app, store, queue, sim, controller, auth, signIn };
}

/** Run every pending timer now, regardless of its delay. */
export async function fireTimers(c: Controller) {
  for (const t of c.timers) t.due = 0;
  await c.tick();
}

export async function feed(c: Controller, ...events: EventRecord[]) {
  for (const e of events) await c.handle(e);
}

export async function parkAndReachExit(c: Controller, plate = "A") {
  await feed(c, gateEv("gateA", "Open"), carEv(plate, "ENTRY1", "CarIn", "10:00:00"),
    carEv(plate, "ENTRY1", "CarOut", "10:00:02"), carEv(plate, "S1", "CarIn", "10:00:05"),
    carEv(plate, "S1", "CarOut", "10:03:05"), carEv(plate, "EXIT_EXIT", "CarIn", "10:03:10"));
}

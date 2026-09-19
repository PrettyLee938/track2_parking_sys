# Grand Park Auto — System Guide

How the control centre works, end to end: the moving parts, the data flow, and the
reasoning behind the code that matters.

This is the companion to [`README.md`](../README.md). The README tells you which command
to type; this document tells you what happens after you type it.

---

## Contents

1. [What the system does](#1-what-the-system-does)
2. [The three processes](#2-the-three-processes)
3. [Repository layout](#3-repository-layout)
4. [Running it](#4-running-it)
5. [The two channels: webhooks in, REST out](#5-the-two-channels-webhooks-in-rest-out)
6. [The serial queue: why nothing interleaves](#6-the-serial-queue-why-nothing-interleaves)
7. [Webhook intake: signature, duplicates, sequence](#7-webhook-intake-signature-duplicates-sequence)
8. [Site topology: which gate belongs to which lane](#8-site-topology-which-gate-belongs-to-which-lane)
9. [The game clock](#9-the-game-clock)
10. [The car lifecycle](#10-the-car-lifecycle)
11. [Spot allocation](#11-spot-allocation)
12. [Billing and payment](#12-billing-and-payment)
13. [Gates](#13-gates)
14. [Penalties: how the system corrects itself](#14-penalties-how-the-system-corrects-itself)
15. [Lost webhooks and ghost records](#15-lost-webhooks-and-ghost-records)
16. [Crash recovery: replaying events and commands](#16-crash-recovery-replaying-events-and-commands)
17. [Storage](#17-storage)
18. [The HTTP API, accounts and roles](#18-the-http-api-accounts-and-roles)
19. [The dashboard](#19-the-dashboard)
20. [Configuration](#20-configuration)
21. [Tests and tools](#21-tests-and-tools)
22. [Troubleshooting](#22-troubleshooting)

---

## 1. What the system does

A parking simulator runs a multi-storey car park: cars arrive at entrances, wait, park,
leave, and pay. The simulator has no logic of its own for *deciding* anything. It reports
what happens, and it obeys commands.

This project is the **control centre** that supplies the decisions:

- which arriving car is let in, and which spot it is sent to
- when each barrier gate opens and closes
- what each car is charged, and when it is released to leave
- who gets turned away when the car park is full
- a live dashboard for human operators, with logs and statistics

The simulator penalises wrong decisions (charging a car twice, sending a car to an
occupied spot, operating a broken gate), so most of the interesting code is about *not*
being wrong when information arrives late, out of order, or not at all.

---

## 2. The three processes

```
┌───────────────────────┐        webhooks (HTTP POST)        ┌────────────────────────┐
│  Parking Simulator    │ ─────────────────────────────────► │   Control server       │
│  ParkingSimulator.exe │                                    │   Fastify, :8000       │
│  REST API :9898       │ ◄───────────────────────────────── │   Node 22 + tsx        │
└───────────────────────┘     commands (open/goto/charge)    └───────────┬────────────┘
                                                                         │
                                                        server-sent events (1/s)
                                                                         │
                                                             ┌───────────▼────────────┐
                                                             │  React dashboard       │
                                                             │  Vite :5173            │
                                                             └────────────────────────┘
```

Three processes, three ports:

| Process | Port | Started by |
|---|---|---|
| Parking simulator | 9898 (its REST API) | `ParkingSimulator.exe` |
| Control server | 8000 | `npm run dev` |
| Dashboard (dev) | 5173 | `npm run dev:web` |

The dashboard is optional in two senses: the controller runs headless without it, and
once built (`npm run build`) the server serves it itself on port 8000, so 5173 is only
needed for UI development.

---

## 3. Repository layout

An npm workspace with three packages:

```
shared/    types both sides compile against  (@gpa/shared)
server/    the controller and HTTP API       (@gpa/server)
web/       the React dashboard               (@gpa/web)
topology/  one layout file per level
data/      SQLite database (git-ignored)
```

`shared/` exists so that a renamed field is a **compile error** rather than a blank
widget. It holds two files:

- `shared/src/protocol.ts` — every literal the *simulator* sends or expects
- `shared/src/api.ts` — every type *our own* HTTP API exposes

The server's modules divide by responsibility:

| File | Responsibility |
|---|---|
| `server/src/main.ts` | wiring: build the objects, start Fastify |
| `server/src/config.ts` | settings schema (zod), `.env` loading, game-speed reading |
| `server/src/app.ts` | HTTP routes and role enforcement |
| `server/src/webhook.ts` | parsing, signature, dedupe, sequence tracking |
| `server/src/controller.ts` | all car-park logic (the brain) |
| `server/src/simClient.ts` | REST client for the simulator |
| `server/src/topology.ts` | pairing entry/exit sensors with gates |
| `server/src/allocation.ts` | which spot an arriving car is sent to |
| `server/src/billing.ts` | what a car is charged |
| `server/src/store.ts` | SQLite persistence and statistics |
| `server/src/auth.ts` | accounts, passwords, login sessions |
| `server/src/serialQueue.ts` | the concurrency guarantee |

---

## 4. Running it

### Prerequisites

Node 22 or newer (`"engines": { "node": ">=22" }`). The server runs TypeScript directly
through `tsx` — there is no build step for the server, only for the dashboard.

```bash
npm install
```

### Point the simulator at the server

In the simulator's `settings/settings.json`:

```json
{
  "ListenAddress": "http://127.0.0.1:9898",
  "WebhookUrl": "http://127.0.0.1:8000/webhook",
  "GameSpeedMultiplier": 3.0,
  "Name": "admin",
  "Password": "admin"
}
```

Two things bite people here:

- Use `127.0.0.1`, never `localhost`. On Windows `localhost` resolves to IPv6 first and
  costs roughly two seconds per request before falling back to IPv4.
- The simulator reads `settings.json` **only at startup**. Change it, then restart it.

### Point the server at the simulator

In `.env` at the repo root (copy from `.env.example`):

```bash
GPA_SIM_BASE_URL=http://127.0.0.1:9898/api/v1
GPA_SIM_USER=admin
GPA_SIM_PASSWORD=admin
GPA_APP_PORT=8000
GPA_ADMIN_PASSWORD=something-long
GPA_SIM_LEVELS_DIR=C:/path/to/ParkingSimulator-win-x64/settings
```

`GPA_SIM_LEVELS_DIR` is worth setting even though it is optional: it is how the server
reads `GameSpeedMultiplier` before the first car completes a stay (see
[the game clock](#9-the-game-clock)), and it lets the server derive a layout for a level
that has no `topology/*.json` yet.

### Start order

```bash
npm run dev
```

Start the server **first**, so no arriving car goes unseen. Then launch the simulator and
load a level, and optionally:

```bash
npm run dev:web
```

The dashboard is then at <http://localhost:5173>. Sign in with the admin account. Confirm
the link is live:

```bash
curl -s http://127.0.0.1:8000/debug/stats
```

`received` climbing above zero means webhooks are arriving.

> **Never use `npm run dev:watch` during a real run.** It restarts the server on every
> source change, and every restart loses the webhooks sent while it was down. The server
> *can* recover from a restart (see
> [§16](#16-crash-recovery-replaying-events-and-commands)), but recovery is not free.

---

## 5. The two channels: webhooks in, REST out

Everything the system knows arrives on one channel, and everything it does goes out on
the other.

### Inbound: webhooks

The simulator POSTs a JSON event to `/webhook` whenever something happens. The event
classes are enumerated once, in `shared/src/protocol.ts`:

```ts
export const EventClass = {
  ComponentBroken: "component_broken",
  ComponentFixed:  "component_fixed",
  CarbonMonoxide:  "carbon_monoxide_event",
  CarSpotAction:   "car_spot_action",
  GateAction:      "gate_action",
  PaymentMade:     "payment_made",
  Penalty:         "penalty",
  Test:            "test_webhook",
} as const;
```

`car_spot_action` is the workhorse. It fires whenever a car crosses any sensor — an
entrance, an exit, or a parking spot — and carries a direction:

```ts
export const Direction = { In: "CarIn", Out: "CarOut" } as const;
```

So a single car generates at least six events in a normal visit: entry CarIn, entry
CarOut, spot CarIn, spot CarOut, exit CarIn, exit CarOut.

### Outbound: the REST API

`server/src/simClient.ts` is a thin typed client. The whole command vocabulary is small:

```ts
export interface SimApi {
  listParkingSpots(): Promise<SimParkingSpot[]>;
  listBarriers(): Promise<SimBarrier[]>;
  openGate(name: string): Promise<void>;
  closeGate(name: string): Promise<void>;
  carGoto(plate: string, destination: string): Promise<void>;
  carCharge(plate: string, parkingCost: number, chargingCost: number): Promise<void>;
  repairGate(name: string): Promise<void>;
  repairSpot(name: string): Promise<void>;
}
```

`carGoto` takes either a parking spot name or one of two special destinations:

```ts
export const Destination = {
  Exit:      "exit",       // drive to any exit; payment is requested there
  LeavePark: "leavepark",  // leave through an escape route
} as const;
```

The interface exists so tests can substitute a fake simulator — `server/test/helpers.ts`
implements `SimApi` in memory, which is how 81 tests run without the simulator.

Two practical notes on the client:

```ts
let r = await send();
if (r.status === 401) {
  await this.login();
  r = await send();
}
```

An expired bearer token re-logs in once and retries, so token expiry never takes the
control loop down. And the `list-*` endpoints carry a simulated operational cost in the
scoring, so they are called at startup, on a level change, or after a suspected restart —
never on a polling loop. **All routine state comes from webhooks.**

---

## 6. The serial queue: why nothing interleaves

This is the single most important structural decision in the server, so it comes before
the logic that depends on it.

Handling one event involves `await`ing HTTP calls to the simulator. In plain async
JavaScript, a second webhook can begin being handled at exactly that `await`, and see
state that is half-updated. Two cars would be assigned the same spot.

`server/src/serialQueue.ts` removes the possibility:

```ts
export class SerialQueue implements TaskQueue {
  private tail: Promise<unknown> = Promise.resolve();

  push(task: Task): void {
    this.run(task).catch(this.onError);
  }

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.pending++;
    const result = this.tail.then(() => fn());
    this.tail = result.catch(() => undefined).finally(() => { this.pending--; });
    return result;
  }
}
```

Each task is chained onto the tail of a promise chain. The `.catch(() => undefined)` on
the stored tail matters: a task that throws must not break the chain for everything
queued behind it.

**Every** mutation goes through this one queue:

```ts
submit(e: EventRecord): void          { this.queue.push(() => this.handle(e)); }
requestResync(): void                 { this.queue.push(() => this.sync()); }
exclusive<T>(fn: () => T): Promise<T> { return this.queue.run(fn); }
```

- webhooks — `submit()`
- the periodic tick — pushed by `setInterval`
- resyncs — `requestResync()`
- manual dashboard commands — `exclusive()`

The consequence worth internalising: **handlers never interleave, so controller state can
be plain mutable maps with no locking.** That is why `Controller` can hold `spots`,
`gates` and `cars` as ordinary `Map`s and mutate them freely.

Note that the webhook route does *not* wait for handling:

```ts
controller.submit(record); // handled on the controller's queue; respond immediately
return { ok: true };
```

The simulator gets its HTTP 200 straight away; a slow decision never causes a delivery
timeout.

---

## 7. Webhook intake: signature, duplicates, sequence

Before an event reaches the controller it passes through `server/src/webhook.ts`.

### Parsing preserves the exact text

```ts
export function parseRaw(body: string): SimEventBase {
  const reviver: Reviver = (_key, value, context) =>
    typeof value === "number" && context ? context.source : value;
  const parsed = JSON.parse(body, reviver);
  ...
}
```

This uses `JSON.parse` source-text access (Node 21+) to keep every number as the literal
text the simulator sent — `1.0` stays `"1.0"` rather than becoming `1`. The signature is
an MD5 over the *text* of the values, so normalising numbers would break verification.

This is also why the Fastify JSON parser is removed in `app.ts`:

```ts
app.removeAllContentTypeParsers();
app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
```

### The signature

```ts
export function computeSignature(payload: Record<string, unknown>): string {
  const joined = Object.keys(payload)
    .filter((k) => k !== "Signature")
    .sort()
    .map((k) => String(payload[k]))
    .join("|");
  return createHash("md5").update(joined, "utf8").digest("hex");
}
```

Level 1 sends `Signature: null` on every event, so `signatureStatus()` returns one of
three values — `valid`, `unsigned`, `invalid` — and which ones are acted on is the
`GPA_SIGNATURE_MODE` setting: `strict` (only `valid`; the Level 2+ default), `lenient` (also
`unsigned`; use this for Level 1) or `monitor` (everything; only records the status,
to check how a new level signs with `npm run report:level -w server`). Every event is
stored either way, with its status and whether it was acted on.

### Dedupe and gap detection

```ts
const accept = trusted(sig, this.mode) && !duplicate;
```

`Intake` keeps a set of seen `EventId`s and the last `SequenceId`. A gap is **recorded,
not repaired** — there is no way to ask the simulator to resend. Counters are exposed at
`/debug/stats`:

```json
{"received":0,"accepted":0,"sig_valid":0,"sig_unsigned":0,"sig_invalid":0,
 "duplicates":0,"seq_gaps":0,"last_sequence_id":null,"controller_enabled":true}
```

Measured on a real Level 1 run: **1 event lost in 3,406, and 7 delivered out of order.**
That number is the justification for everything in
[§15](#15-lost-webhooks-and-ghost-records).

Every event is written to SQLite *before* it is handled, accepted or not. The stored log
is what makes restart recovery possible.

---

## 8. Site topology: which gate belongs to which lane

The simulator's API lists parking spots and barrier gates, but never says **which gate
serves which entrance**. Without that pairing the controller cannot know which barrier to
open for an arriving car.

That mapping lives in `topology/*.json`, one file per level:

```json
{
  "name": "lvl1",
  "entry_lanes": [{ "spot": "ENTRY1",    "gate": "gateA", "zone": "ZONE1" }],
  "exit_lanes":  [{ "spot": "EXIT_EXIT", "gate": "gateB", "zone": "ZONE1" }],
  "notes": {
    "gate_distance": { "ENTRY1": 178.4, "EXIT_EXIT": 113.4 },
    "gates_not_on_a_lane": ["gateC"]
  }
}
```

At sync time the controller lists the live entry and exit spots and picks the file whose
spot sets match **exactly**:

```ts
export function matches(t: Topology, entrySpots: Set<string>, exitSpots: Set<string>): boolean {
  return sameSet(new Set(t.entry_lanes.map((l) => l.spot)), entrySpots) &&
         sameSet(new Set(t.exit_lanes.map((l) => l.spot)), exitSpots);
}
```

Exact matching is what makes level switching automatic: load a different level and the
running set of sensors stops matching, which is detected as a level change.

Resolution tries three sources in order:

1. explicitly injected candidates (tests)
2. files in `topology/` (`GPA_TOPOLOGY_DIR`)
3. layouts derived from the simulator's own `lvl*.json` (`GPA_SIM_LEVELS_DIR`)

Derivation pairs each sensor with its nearest gate by coordinates, claiming pairs
closest-first so two sensors never share a gate:

```ts
const pairs = sensors
  .flatMap((s) => [...gates.values()].map((g) => ({ dist: Math.hypot(s.X - g.X, s.Y - g.Y), sensor: s.Name, gate: g.Name })))
  .sort((a, b) => a.dist - b.dist);
for (const p of pairs) {
  if (p.dist > maxGateDistance) break;
  if (sensorGate.has(p.sensor) || used.has(p.gate)) continue;
  sensorGate.set(p.sensor, { gate: p.gate, dist: p.dist });
  used.add(p.gate);
}
```

`npm run topology -- --levels-dir "<sim>/settings"` writes the result to `topology/` so
it can be reviewed and committed.

If nothing matches, the server does **not** refuse to start. It falls back to gate-less
lanes and logs loudly — cars are still routed, they just pass gates nobody opens.

### Level changes mid-run

Two mechanisms catch a level switch:

- **A long silence.** No events for `GPA_RESYNC_AFTER_SILENCE_GAME_S` triggers a resync
  on the next event.
- **An event from an unknown sensor.** This one is subtle and handled specially:

```ts
private async handleUnknownLaneEvent(e: EventRecord, name: string, spotType: string) {
  ...
  await this.sync();              // reload the layout right now
  if (this.entryLanes.has(name) || this.exitLanes.has(name)) {
    return this.routeCarEvent(e); // and handle THIS event
  }
}
```

Queueing a resync behind the event would drop the event — and it is always the first car
of the new level. Instead the layout is reloaded inline and the same event re-routed.

---

## 9. The game clock

This is the detail most likely to be missed, and it silently corrupts everything if it is
wrong.

**Webhook timestamps are wall-clock, but cars, gates and sensors move in game time.** The
simulator runs at `GameSpeedMultiplier` (3.0 in a typical setup, and changeable at
runtime with Shift+PgUp). A gate that takes 1.5 "seconds" to close takes 0.5 real seconds
at 3×.

So every timer in the codebase that waits on the simulator is declared in **game
seconds**, with a `_GAME_S` suffix, and converted at use:

```ts
/** Real seconds for a duration the simulator measures in game time. */
real(gameS: number): number {
  return gameS / this.timeScale;
}
```

The scale comes from four sources, first that applies:

```ts
get timeScaleInfo(): { value: number; source: TimeScaleSource } {
  if (this.cfg.gameSpeed) return { value: this.cfg.gameSpeed, source: "configured" };
  if (this.scaleSamples.length >= this.cfg.timeScaleMinSamples)
    return { value: median(this.scaleSamples), source: "learned" };
  if (this.simSettingsSpeed) return { value: this.simSettingsSpeed, source: "simulator settings" };
  return { value: 1, source: "default" };
}
```

The *learned* case is the neat one. A car parks for exactly its planned duration in game
minutes, so measuring how long that took in real seconds recovers the speed for free:

```ts
private learnTimeScale(car: Car) {
  if (car.planned_minutes && car.parkedReal && car.leftSpotReal) {
    const realS = car.leftSpotReal - car.parkedReal;
    if (realS > 5) {
      const ratio = (car.planned_minutes * 60) / realS;
      if (ratio > 0.1 && ratio < 20) {           // reject nonsense
        this.scaleSamples.push(ratio);
        if (this.scaleSamples.length > this.cfg.timeScaleSamples) this.scaleSamples.shift();
      }
    }
  }
}
```

A **median** over a rolling window of 30 samples, requiring at least 3, so one odd stay
cannot move it. Because it is learned continuously, changing the speed mid-run with
Shift+PgUp is followed automatically.

`/api/state` exposes both the value and where it came from, as `time_scale` and
`time_scale_source`, and the dashboard shows it in the top bar (`×3.00`). **If that reads
`×1.00` while the simulator runs at 3×, every timeout in the system is three times too
long** — that is the first thing to check when timing behaves oddly.

---

## 10. The car lifecycle

The heart of the controller. Statuses are declared in `shared/src/api.ts`:

```ts
export type CarStatus =
  | "queued" | "dispatching" | "dispatched" | "entering" | "parked" | "to_exit"
  | "at_exit" | "invoiced" | "payment_mismatch" | "released"
  | "turned_away" | "neglected" | "lost" | "unknown" | "gone";
```

The happy path, event by event:

```
entry CarIn   →  queue on that lane; turn away if no spot will be left
(dispatch)    →  reserve a spot, open the lane's gate, on gate Open: goto <spot>
entry CarOut  →  dispatch the lane's next car, else close the gate after a delay
spot  CarIn   →  occupied, parking starts
spot  CarOut  →  spot free; the car drives to an exit on its own
exit  CarIn   →  charge exactly once, after the sensor settles
payment_made  →  amount matches? open the exit gate and goto leavepark : hold
exit  CarOut  →  session finished and stored; close the exit gate after a delay
```

### Arrival and admission control

```ts
private async onEntryIn(e: EventRecord, lane: EntryLane) {
  ...
  if (lane.closed) return this.turnAway(car, `entrance ${lane.spot} is closed`);

  // Spots are reserved at dispatch time, so every car already queued for the same
  // pool of spots still needs one.
  const free = this.allocator.candidates(car.car_type, lane.zone, this.spots.values()).length;
  const waiting = [...this.entryLanes.values()]
    .filter((l) => this.allocator.sharesPool(l.zone, lane.zone))
    .reduce((n, l) => n + l.queue.length, 0);
  if (free - waiting <= 0) return this.turnAway(car, "no free spot");
  lane.queue.push(plate);
  await this.pumpEntry(lane);
}
```

The `free - waiting` arithmetic is the admission test. Spots are only *reserved* when a
car is dispatched, so counting free spots alone would admit ten cars into three spaces.
Cars already queued at lanes that draw on the same pool must be subtracted.

Turning a car away is an explicit command — `goto leavepark` — not silence. A car left
waiting blocks the entrance sensor for everyone behind it.

### Dispatch

Each entry lane is a FIFO with one car in flight:

```ts
export interface EntryLane {
  spot: string;
  gate: string | null;
  zone: string;
  queue: string[];         // plates waiting, FIFO
  current: string | null;  // plate dispatched, not yet off the sensor
  closed: boolean;         // closed by an admin
}
```

```ts
async pumpEntry(lane: EntryLane): Promise<void> {
  if (this.replaying || lane.current || !lane.queue.length) return;
  const gate = lane.gate ? this.gates.get(lane.gate) : undefined;
  if (lane.gate && (!gate || !gate.operable)) return; // held; onComponent() pumps again once fixed
  const plate = lane.queue.shift()!;
  const car = this.cars.get(plate)!;
  const spot = this.allocator.choose(car.car_type, lane.zone, this.spots.values());
  if (!spot) {
    await this.turnAway(car, "no suitable spot");
    return this.pumpEntry(lane);      // try the next car
  }
  spot.reserved_for = plate;
  car.spot = spot.name;
  car.status = "dispatching";
  lane.current = plate;
  const send = () => this.sendToSpot(plate, lane);
  if (gate) await this.whenGateOpen(gate, send);
  else await send();
}
```

Two things to notice. The reservation is taken **before** the gate is opened, closing the
window in which another lane could pick the same spot. And `goto` is sent only once the
gate reports `Open` — `whenGateOpen` registers a callback rather than blocking.

`pumpEntry` is called from everywhere a lane could become free or a spot could appear: an
entry CarOut, a spot CarOut, a component being fixed, an entrance reopening, a ghost being
retired, and after every sync.

### Parking

```ts
private async onSpotIn(e: EventRecord) {
  ...
  // Another car already in this spot does NOT mean it left: the simulator lets a second
  // car park on top (and fines it). Both stay recorded until each one's CarOut.
  const others = [...spot.occupants].filter((p) => p !== plate && p !== "?");
  if (others.length) this.note("error", `${plate} parked in ${name}, which still holds ${others.join(", ")}`);
```

This explains the `Spot.occupants` **set**, rather than a single plate:

```ts
export class Spot implements AllocSpot {
  readonly occupants = new Set<string>();
  reserved_for: string | null = null; // plate sent here but not arrived yet
  detected = 0;                       // car count from the last list-parking-spots
```

A car sent to an occupied spot is fined *and parks there anyway*, so one spot can hold two
cars. With a single-plate field, the first car to leave would mark the spot free while the
other is still in it — and every car sent there afterwards would be fined too. The `"?"`
sentinel represents a car known to be present but impossible to name (reported by
`detectedCars`, which on Level 1 is a **count**, not a list of plates).

### Departure and the 0.2-second trap

```ts
private async onSpotOut(e: EventRecord) {
  ...
  // Only advance the state. From a spot right next to an exit (S15 on Level 1) the
  // exit CarIn arrives ~0.2s BEFORE this CarOut; overwriting "at_exit" here would
  // cancel the pending charge and the car escapes unpaid.
  if (car.status === "parked" || car.status === "unknown") car.status = "to_exit";
```

Guarding the assignment instead of assigning unconditionally is the entire fix. The
related trap is at the other end — spots *beyond* the exit sensor (S15, S30 on Level 1)
are reached by driving over it, so a car on its way **in** fires exit CarIn/CarOut before
it parks:

```ts
private drivingIn(plate: string): boolean {
  const car = this.cars.get(plate);
  return !!car && (MID_ENTRY.includes(car.status) || car.status === "entering");
}
```

Both `onExitIn` and `onExitOut` check it first and ignore the event.

---

## 11. Spot allocation

Strategies live in `server/src/allocation.ts` and are selected by
`GPA_ALLOCATION_STRATEGY`. The base class takes any free compatible spot anywhere:

```ts
export class Allocator {
  static readonly id: string = "any_zone_first_free";

  candidates<S extends AllocSpot>(carType: string, laneZone: string, spots: Iterable<S>): S[] {
    const all = [...spots];
    return all.filter((s) => s.available && s.accepts(carType) && this.inScope(s, laneZone, all));
  }

  /** A spot built for this car type first (an electric car to a charger), then generic
   * spots. Normal cars never reach typed spots: accepts() excludes them. */
  rank(s: AllocSpot): [number, number] {
    return [s.car_type === CarType.Any ? 1 : 0, spotNumber(s.name)];
  }
}
```

The ranking is a two-level sort: prefer a purpose-built spot (an electric car to a
charger), then lowest spot number, for deterministic and debuggable behaviour.

The default strategy restricts cars to the zone their entrance leads to:

```ts
export class LaneZoneAllocator extends Allocator {
  static override readonly id = "lane_zone_first_free";

  override inScope(spot: AllocSpot, laneZone: string, all: AllocSpot[]): boolean {
    if (!laneZone || !all.some((s) => s.zone === laneZone && s.purpose === SpotPurpose.Park)) return true;
    return spot.zone === laneZone;
  }

  override sharesPool(a: string, b: string): boolean {
    return !a || !b || a === b;
  }
}
```

Zones marked "Closed" in the simulator are physically separate areas — a car sent across
zones may simply never arrive. The fallback (`if (!laneZone || ...)`) means an unknown or
parking-less zone degrades to the permissive behaviour rather than admitting nobody.

`sharesPool` is what makes the admission test in `onEntryIn` correct per zone: with
zone-restricted allocation, cars queued at a different zone's entrance are not competing
for these spots and must not be subtracted.

Availability is a single expression on `Spot`:

```ts
get available(): boolean {
  return this.purpose === SpotPurpose.Park && !this.broken && !this.maintenance &&
    this.occupants.size === 0 && this.reserved_for === null;
}
```

To add a strategy: extend `Allocator`, register it in `STRATEGIES`, set the env var.

---

## 12. Billing and payment

### The rules

`server/src/billing.ts` is deliberately tiny:

```ts
export function billableMinutes(gameSeconds: number, plannedMinutes: number | null, cfg: BillingSettings): number {
  if (cfg.billingRounding === "planned" && plannedMinutes) return plannedMinutes;
  const minutes = gameSeconds / 60;
  if (cfg.billingRounding === "ceil") return Math.max(1, Math.ceil(minutes - 1e-9));
  return Math.max(1, Math.round(minutes));
}

export function parkingCost(gameSeconds: number, plannedMinutes: number | null, carType: string, cfg: BillingSettings): number {
  let cost = billableMinutes(gameSeconds, plannedMinutes, cfg) * cfg.pricePerMinute;
  if ((carType ?? "").toLowerCase() === CarType.Electric.toLowerCase()) cost *= cfg.electricMultiplier;
  return Math.round(cost * 100) / 100;
}
```

`"planned"` is the default rounding mode, and the reason is empirical: the simulator
checks the bill against the **planned** minutes, not the measured ones. At game speed 1.7,
measured clock time was 1.7× too short and 14 of 14 rejected bills matched the planned
figure. Billing the planned duration is therefore correct at any game speed.

Electricity is deliberately always zero:

```ts
export function chargingCost(_carType: string, _cfg: BillingSettings): number {
  return 0;
}
```

No level so far reports how much electricity a car actually drew, and billing for
electricity that was not used is its own penalty
(`Penalty_ChargeCarForNoElectricityUsed`). The function is kept as a seam for when an
event supplies the amount.

### Charging exactly once

```ts
private async charge(plate: string) {
  const car = this.cars.get(plate);
  if (!car) return;
  car.chargeScheduled = false;
  if (car.status !== "at_exit" || car.charge_parking !== null) return;
  ...
  if (await this.cmd("charge", () => this.sim.carCharge(plate, parking, electric), [plate, parking, electric])) {
    car.charge_parking = parking;
    car.charge_electric = electric;
    car.status = "invoiced";
  }
  // On an HTTP failure we do NOT retry: the charge may have registered, and a second
  // one is a penalty. A rejection arrives as a penalty event instead (onPenalty).
}
```

That closing comment is the important one. **A failed HTTP call is not evidence the
charge did not happen** — the response may have been lost after the simulator processed
it. Retrying blindly risks a double charge, which is penalised. The system waits for the
simulator to say, via a penalty event, that the charge was rejected.

Charging is also delayed rather than immediate:

```ts
// Charging the instant the sensor fires is rejected ("Car should be charged at the
// exit"): give the car a moment to settle on the exit spot.
this.scheduleCharge(plate, this.real(this.cfg.exitChargeDelayGameS));
```

1.5 game-seconds, verified at speed 1.0 — and passed through `real()`, so it is 0.5 real
seconds at 3×.

### Payment

```ts
const expected = car.charge_parking + (car.charge_electric ?? 0);
car.paid = amount;
if (Math.abs(amount - expected) <= this.cfg.paymentTolerance) {
  car.payment_ok = true;
  this.counters.revenue += amount;
  await this.release(car);
} else {
  car.payment_ok = false;
  car.status = "payment_mismatch";
  this.counters.payment_mismatches++;
  this.note("error", `${plate} paid ${amount.toFixed(2)}, invoice ${expected.toFixed(2)} - NOT releasing`);
}
```

Underpayment does not open the gate. The car sits at the exit and the mismatch is surfaced
on the dashboard for an operator to resolve.

---

## 13. Gates

A gate has four states (`Open`, `Closed`, `Opening`, `Closing`) plus two conditions
(`broken`, `maintenance`) and an operator override:

```ts
export class Gate {
  state: string = GateState.Closed;
  broken = false;
  maintenance = false;
  onOpen: Callback[] = [];              // run once the gate reports Open
  hold: GateHold = null;                // operator override, until back to automatic
  openRequestedAt: number | null = null;
  openRetries = 0;

  get operable(): boolean { return !this.broken && !this.maintenance; }
}
```

Opening is asynchronous and callback-driven:

```ts
async whenGateOpen(gate: Gate, fn: Callback): Promise<void> {
  if (gate.state === GateState.Open) { await fn(); return; }
  gate.onOpen.push(fn);
  if (gate.hold === "closed") return;   // an operator holds it shut: the car waits
  if (gate.state !== GateState.Opening) await this.requestOpen(gate);
  else if (gate.openRequestedAt === null) gate.openRequestedAt = nowS();
}
```

Three behaviours are worth calling out.

**An `open` sent while the gate is still closing is silently dropped by the simulator.**
So the gate event handler re-asks once closing completes:

```ts
} else if (gate.state === GateState.Closed && gate.onOpen.length && gate.hold !== "closed") {
  await this.requestOpen(gate);
}
```

**The simulator does not always confirm an opening.** A two-stage timeout handles it —
re-send once, then assume open rather than stranding the car forever:

```ts
if (gate.openRetries === 0) {
  gate.openRetries = 1;
  this.note("warn", `${gate.name} did not confirm opening, re-sending open`);
  await this.requestOpen(gate);
} else {
  this.note("warn", `${gate.name} still unconfirmed, assuming it is open`);
  gate.state = GateState.Open;
  await this.gateOpened(gate);
}
```

**Closing is conditional on nobody needing it:**

```ts
gateBusy(name: string): boolean {
  return [...this.entryLanes.values()].some((l) => l.gate === name && (l.current || l.queue.length)) ||
         [...this.exitLanes.values()].some((l) => l.gate === name && l.releasing.size > 0);
}

async closeGateIfIdle(name: string | null): Promise<void> {
  const gate = name ? this.gates.get(name) : undefined;
  if (gate && gate.operable && gate.hold !== "open" && !this.gateBusy(gate.name) && !gate.onOpen.length &&
      (gate.state === GateState.Open || gate.state === GateState.Opening)) {
    if (await this.cmd("close", () => this.sim.closeGate(gate.name), [gate.name])) gate.state = GateState.Closing;
  }
}
```

### Manual control

Operators can override a gate, and the server refuses anything the simulator would
penalise:

```ts
const unusable = gate.broken ? "broken" : gate.maintenance ? "under maintenance" : null;
const inUse = this.gateBusy(name) || gate.onOpen.length > 0;
switch (action) {
  case "open":
  case "close": {
    if (unusable) return fail(`${name} is ${unusable} - operating it now is a penalty`);
    if (action === "close" && inUse) return fail(`${name} is letting a car through right now - try again in a moment`);
    gate.hold = action === "open" ? "open" : "closed";
```

A `hold` means the automation will not override the operator. `auto` hands control back,
and if cars queued up while it was held closed, they are served immediately:

```ts
case "auto": {
  gate.hold = null;
  if (gate.onOpen.length && gate.operable) await this.requestOpen(gate);
  else await this.closeGateIfIdle(name);
```

The same protective checks apply to spot maintenance — repairing an occupied or reserved
spot is refused with the reason.

---

## 14. Penalties: how the system corrects itself

Penalty events are not only scoring feedback; they carry **information the API does not
otherwise expose**. The controller parses them and acts.

The reason strings are matched by case-insensitive substring, declared once:

```ts
export const PenaltyReason = {
  ChargeNotAtExit: "charged at the exit",
  ChargedWrongly:  "charged wrongly",
  OccupiedSpot:    "occupied spot",
  AlreadyPaid:     "already paid",
} as const;

export const CORRECT_AMOUNT_PATTERN = /should be:\s*\(([\d.]+)\)/;
export const OCCUPIED_SPOT_PATTERN  = /spot:\s*\(([^)]+)\)/i;
```

### "Charged wrongly" — the simulator states the right answer

```
Car is being charged wrongly with amount: (2.00). Car type is (Normal) so charge should be: (4.00)
```

```ts
} else if (lowered.includes(PenaltyReason.ChargedWrongly) && this.cfg.rechargeOnWrongAmount) {
  // Rejected for amount, and the simulator says what it should be. Left alone the car
  // never pays, sits on the exit sensor and blocks every car behind it.
  const m = CORRECT_AMOUNT_PATTERN.exec(reason);
  if (m) this.rebill(car, Number(m[1]));
}
```

```ts
private rebill(car: Car, override: number | null) {
  car.charge_parking = car.charge_electric = null;
  car.charge_override = override;
  car.status = "at_exit";
  if (car.charge_attempts < this.cfg.maxChargeAttempts) this.scheduleCharge(car.plate, this.real(this.cfg.exitChargeRetryGameS));
  else this.note("error", `${car.plate}: invoice rejected ${car.charge_attempts}x, giving up`);
}
```

One penalty is cheaper than a blocked exit lane. The attempt counter bounds the loop.

### "Occupied spot" — the simulator reveals a car we lost

```
Car:(ARA 545) attempted to park in an occupied spot:(S12).
```

```ts
private async onOccupiedSpotPenalty(reason: string, car: Car | undefined) {
  const spotName = OCCUPIED_SPOT_PATTERN.exec(reason)?.[1]?.trim();
  const spot = spotName ? this.spots.get(spotName) : undefined;
  if (!spot) return;
  if (!spot.occupants.size) spot.occupants.add("?"); // cleared by that spot's next CarOut
  if (spot.reserved_for === car?.plate) spot.reserved_for = null;
  ...
  const alt = this.allocator.choose(car.car_type, lane?.zone ?? "", this.spots.values());
  if (!alt) { this.note("error", `${car.plate}: ${spot.name} is taken and no other spot is free`); return; }
  alt.reserved_for = car.plate;
  car.spot = alt.name;
  car.dispatchRetries = 0;
  await this.cmd("goto", () => this.sim.carGoto(car.plate, alt.name), [car.plate, alt.name]);
}
```

Two corrections in one handler: mark the spot as taken (so nobody else is sent there) and
redirect this car immediately. The comment records what happens without it — *"re-sending
it and then sending the next car there is how one wrong spot became 83 penalties."*

### "Already paid" — trust the simulator over our own record

```ts
if (car && lowered.includes(PenaltyReason.AlreadyPaid) && ["at_exit", "invoiced", "payment_mismatch"].includes(car.status)) {
  // Our record missed its payment (e.g. across a restart); the simulator knows it paid.
  this.note("warn", `${car.plate} has already paid according to the simulator - releasing`);
  car.payment_ok = true;
  return this.release(car);
}
```

One more guard, in `onExitIn`, prevents billing the same visit twice when a car loops back
to an exit without re-entering (seen with cars restored from a simulator save):

```ts
if (car.entry_lane === null && this.recentPaid.has(plate)) {
  this.counters.repeat_exits++;
  this.note("warn", `${plate} back at ${lane.spot} after paying, without entering - not billing again, releasing`);
  car.payment_ok = true;
  return this.release(car);
}
```

---

## 15. Lost webhooks and ghost records

Delivery is at-most-once, and a simulator restart makes cars vanish with no event at all.
A car record whose closing event never arrives would otherwise hold a spot, a lane, or —
worst — an exit gate, forever.

`sweepGhosts` runs on every tick with a different deadline per status:

```ts
private async sweepGhosts(now: number) {
  const gatesToClose = new Set<string>();
  for (const car of [...this.cars.values()]) {
    const quietFor = now - (car.lastSeenReal ?? car.arrivedReal ?? now);
    if (car.status === "released" && car.releasedReal && now - car.releasedReal > this.real(this.cfg.releaseTimeoutGameS)) {
      const gate = car.exit_lane ? this.exitLanes.get(car.exit_lane)?.gate : null;
      this.retire(car, `was released at ${car.exit_lane} but never reported leaving`, "gone");
      if (gate) gatesToClose.add(gate);
    } else if (car.status === "parked") {
      const since = car.parkedReal ?? car.lastSeenReal;
      const allowed = this.real((car.planned_minutes ?? 0) * 60 + this.cfg.parkedOverstayGameS);
      if (since && now - since > allowed) this.retire(car, `is still recorded in ${car.spot} well past its planned ${car.planned_minutes}m`);
    } else if (car.status === "queued") {
      if (now - (car.arrivedReal ?? now) > this.real(this.cfg.entryPatienceGameS + 60)) this.retire(car, ...);
    } else if (["to_exit", "at_exit", "invoiced", "payment_mismatch", "entering", "unknown"].includes(car.status)) {
      if (quietFor > this.real(this.cfg.staleCarGameS)) this.retire(car, `has had no events for ${Math.round(quietFor)}s (status ${car.status})`);
    }
  }
  for (const gate of gatesToClose) await this.closeGateIfIdle(gate);
  ...
}
```

The deadlines differ because the expectations differ. A released car should leave within
~1.5 game-seconds, so 20 is generous. A parked car's deadline is *its own planned
duration* plus a margin. Every limit is in game seconds and passed through `real()`.

Retiring is a clean teardown, not a delete:

```ts
private retire(car: Car, why: string, status: CarStatus = "lost") {
  this.note("warn", `${car.plate} ${why} - closing its record (event lost or simulator restarted)`);
  this.detach(car);
  car.status = status;
  this.counters.ghosts_retired++;
  this.finish(car, { EventClass: "", _received_at: new Date().toISOString() });
}

private detach(car: Car) {
  for (const s of this.spots.values()) {
    s.occupants.delete(car.plate);
    if (s.reserved_for === car.plate) s.reserved_for = null;
  }
  for (const lane of this.entryLanes.values()) {
    lane.queue = lane.queue.filter((p) => p !== car.plate);
    if (lane.current === car.plate) lane.current = null;
  }
  for (const lane of this.exitLanes.values()) lane.releasing.delete(car.plate);
}
```

The record is stored as a session with status `lost` (or `gone`), counted as
`ghosts_retired`, and any lane it was holding is pumped again. Nothing is silently
dropped — `npm run report:gaps -w server` lists silences and lost events afterwards.

Three other repair paths are worth knowing: `reconcile()` reconciles remembered state
against what the sensors report at sync time; `onEntryIn` replaces a stale record when a
plate reappears at an entrance (plates are reused across simulator restarts); and
`checkDispatchTimeout` re-sends a `goto` once, then gives up on the car so the lane keeps
moving.

---

## 16. Crash recovery: replaying events and commands

Because every webhook is written to SQLite before it is handled, the server can rebuild
its state after a restart. The subtlety is that events alone are not enough:

```ts
/**
 * Rebuild state after a restart: recent webhooks AND the commands we sent, merged in time
 * order. Events go through the handlers (what happened); our own decisions are taken from
 * the recorded commands (where a car was sent, what it was charged, when it was released),
 * never re-made - replaying events alone forgot every charge, so cars that had already
 * paid were billed again ("Car has already paid for parking").
 */
```

So the replay merges two logs into one timeline:

```ts
const events = this.store.eventsSince(since);
const actions = this.store.actionsSince(since).filter((a) => a.ok && (a.cmd === "goto" || a.cmd === "charge"));
const timeline = [
  ...events.map((e) => ({ t: tsOf(e._received_at) ?? 0, event: e, action: null })),
  ...actions.map((a) => ({ t: tsOf(a.at) ?? 0, event: null, action: a })),
].sort((a, b) => a.t - b.t);
this.replaying = true;
try {
  for (const item of timeline) {
    if (item.event) await this.handle(item.event);
    else this.applyRecordedAction(item.action!);
  }
} finally {
  this.replaying = false;
}
```

The `replaying` flag threads through the whole controller and suppresses every side
effect — commands, timers, feed entries, session writes:

```ts
private async cmd(...)   { if (this.replaying) return true; ... }   // already sent
later(delayS, label, fn) { if (this.replaying) return; ... }        // reconcile() re-arms
note(level, msg)         { if (this.replaying) return; ... }        // already logged
async release(car)       { if (this.replaying) return; ... }        // in the action log
private finish(car, e)   { if (!this.replaying) this.store.recordSession(session); }
```

Replay is also skipped entirely if the log is stale:

```ts
if (nowS() - newest > this.cfg.replayMaxGapS) {
  this.log.info(`event log is ... old - simulator likely restarted since; starting fresh`);
  return;
}
```

A gap longer than `GPA_REPLAY_MAX_GAP_S` (120s) means the simulator was probably restarted
too, and replaying would resurrect cars that no longer exist.

Finally, events that arrived during startup appear in both the replayed log and the live
queue, so they are de-duplicated by id:

```ts
if (this.replaying) {
  if (eid) this.replayedIds.add(eid);
} else {
  if (eid && this.replayedIds.has(eid)) return;
```

---

## 17. Storage

SQLite through `better-sqlite3`, in WAL mode, at `data/gpa.db`. Writes are synchronous and
take microseconds, so they never hold up event handling.

Five tables:

| Table | Contents |
|---|---|
| `events` | every webhook received, with intake metadata |
| `sessions` | one row per finished car visit |
| `actions` | every command sent, by the controller or a named user |
| `users` | dashboard accounts |
| `auth_sessions` | login sessions (token hashes only) |

Events keep both the extracted columns and the original payload:

```sql
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY,
  event_id     TEXT,
  seq          INTEGER,
  event_class  TEXT NOT NULL,
  plate        TEXT,
  spot         TEXT,
  received_at  TEXT NOT NULL,
  received_ms  INTEGER NOT NULL,
  sig          TEXT,
  accepted     INTEGER NOT NULL,
  duplicate    INTEGER NOT NULL,
  payload      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_received ON events (received_ms);
CREATE INDEX IF NOT EXISTS events_plate    ON events (plate, received_ms);
CREATE INDEX IF NOT EXISTS events_class    ON events (event_class, received_ms);
```

Indexed columns make queries fast; `payload` means no information is ever lost to a
schema decision made too early.

Schema changes are additive and applied at startup, so an existing database keeps working:

```ts
private migrate() {
  const columns = (table: string) => new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  const events = columns("events");
  if (!events.has("spot_type")) {
    this.db.exec(`ALTER TABLE events ADD COLUMN spot_type TEXT; ALTER TABLE events ADD COLUMN direction TEXT;
      UPDATE events SET spot_type = json_extract(payload, '$.SpotType'), direction = json_extract(payload, '$.Direction');`);
  }
  ...
}
```

Note the backfill: new columns are populated from the stored JSON, so historical rows
become queryable too.

`store.stats()` computes the dashboard's statistics in SQL over a time window, bucketed
for the charts — arrivals from entry-sensor events, departures and revenue from sessions,
plus stay-length and spot-usage distributions.

Tests pass `":memory:"` as the data directory for an isolated database per test.

---

## 18. The HTTP API, accounts and roles

### Roles

Two roles, `operator` and `admin`, with admin a strict superset:

```ts
export function hasRole(user: UserView | null | undefined, required: Role): boolean {
  if (!user || user.disabled) return false;
  return required === "operator" ? user.role === "operator" || user.role === "admin" : user.role === "admin";
}
```

Enforcement is a Fastify `preHandler`, applied per route:

```ts
const guard = (role: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.user) return err(reply, 401, "not signed in");
  if (!hasRole(req.user, role)) return err(reply, 403, `requires the ${role} role`);
};
const operator = { preHandler: guard("operator") };
const admin    = { preHandler: guard("admin") };
```

**Every rule is enforced on the server.** The dashboard hides what a role cannot use, but
never relies on that.

### Endpoints

| Endpoint | Role |
|---|---|
| `POST /webhook` | public (the simulator) |
| `POST /api/auth/login`, `/logout` | public |
| `GET /api/auth/me` | operator |
| `GET /api/state`, `/api/stream`, `/api/timeseries`, `/api/stats?minutes=` | operator |
| `GET /api/sessions`, `/api/events`, `/api/actions` | operator |
| `POST /api/control/gates/:name/(open\|close\|auto\|repair)` | operator |
| `POST /api/control/spots/:name/repair` | operator |
| `POST /api/control/entries/:spot/(open\|close)` | admin |
| `POST /api/resync`, `GET /api/config`, `/api/users` (+ `POST`, `PATCH /:id`) | admin |
| `/debug/*` | loopback, or an admin |

Manual commands route through `exclusive()` so they take their turn with webhooks:

```ts
app.post("/api/control/gates/:name/:action", operator, async (req, reply) => {
  const action = req.params.action as GateAction;
  if (!GATE_ACTIONS.includes(action)) return err(reply, 400, `action must be one of ${GATE_ACTIONS.join(", ")}`);
  return control(reply, () => controller.exclusive(() => controller.manualGate(req.params.name, action, req.user!.username)));
});
```

A refused command returns **409** with a human-readable reason, distinct from 400
(malformed) and 403 (not allowed).

### Authentication

- Passwords are scrypt-hashed with a per-password random salt, parameters stored
  alongside: `scrypt$N$r$p$salt$hash`.
- A login mints a random 256-bit token. The browser holds it in an `HttpOnly`,
  `SameSite=Strict` cookie; the database stores only its SHA-256 hash.
- Failed logins are throttled per username.
- Changing a password or role, or disabling an account, revokes every existing session.

Two details worth copying elsewhere. Timing is equalised so a wrong username costs the
same as a wrong password:

```ts
// Hash even when the user does not exist, so timing does not reveal valid usernames.
const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
```

And the last admin cannot lock everyone out:

```ts
const losesAdmin = target.role === "admin" && (body.role === "operator" || body.disabled === true);
if (losesAdmin && store.countOtherActiveAdmins(id) === 0) return err(reply, 409, "cannot remove the last active admin");
if (id === req.user!.id && body.disabled === true) return err(reply, 409, "you cannot disable your own account");
```

On first start, an admin account is created from `GPA_ADMIN_USERNAME` /
`GPA_ADMIN_PASSWORD`. With no password set, one is generated and printed **once** to the
log. Forgot it? `npm run user:password -w server -- admin "new password"`.

---

## 19. The dashboard

React 19 + Vite, in `web/`. In development it runs on 5173 and proxies to the server:

```ts
const server = process.env.GPA_API_URL ?? "http://127.0.0.1:8000";
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": server, "/debug": server } },
});
```

After `npm run build`, the server serves `web/dist` itself, so everything is on port 8000.

### Live state

One `EventSource` feeds every page. The server pushes a full snapshot each second:

```ts
app.get("/api/stream", operator, (req, reply) => {
  const token = cookies(req)[SESSION_COOKIE];
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = () => res.write(`data: ${JSON.stringify(controller.snapshot())}\n\n`);
  send();
  const timer = setInterval(() => {
    if (!auth.userForToken(token)) {   // signed out, expired or disabled meanwhile
      res.write("event: signedout\ndata: {}\n\n");
      clearInterval(timer);
      res.end();
      return;
    }
    send();
  }, cfg.streamIntervalS * 1000);
  req.raw.on("close", () => clearInterval(timer));
});
```

Authorisation is re-checked on **every** push, not just at connect — disabling a user
closes their stream within a second rather than at token expiry.

The client reconnects on its own, and distinguishes a dropped connection from an expired
session:

```ts
source.onerror = () => {
  setConnected(false);
  if (source?.readyState === EventSource.CLOSED) {
    api.me().then(() => { if (alive) retry = setTimeout(connect, 3000); }).catch(() => undefined); // 401 signs out
  }
};
```

Snapshots come from `Controller.snapshot()`, which is why car and spot records use the
API's `snake_case` field names internally — the read model needs no translation layer:

```ts
snapshot(): StateSnapshot {
  return {
    synced: this.synced,
    time_scale: Math.round(this.timeScale * 1000) / 1000,
    time_scale_source: this.timeScaleInfo.source,
    topology: this.topology ? { name: this.topology.name, source: this.topology.source ?? "" } : null,
    zones, spots,
    gates:       [...this.gates.values()].map((g) => ({ ... })),
    entry_lanes: [...this.entryLanes.values()].map((l) => ({ ... })),
    exit_lanes:  [...this.exitLanes.values()].map((l) => ({ ... })),
    active_cars: [...this.cars.values()].map(publicCar),
    recent_sessions: this.completed.slice(-50),
    counters: { ...this.counters },
    feed: this.feed.slice(-100),
  };
}
```

`publicCar()` strips the internal real-clock bookkeeping fields, so the wire format stays
exactly the declared `CarView`.

### Pages

| Page | Contents | Role |
|---|---|---|
| **Overview** | occupancy, zones, gates, entry queue, cars inside, live activity | operator |
| **Operations** | hold a gate open/closed, return to automatic, start maintenance | operator |
| **Logs** | search visits, simulator events, commands | operator |
| **Statistics** | traffic, revenue, outcomes, stay lengths, spot usage, penalties, gate cycles | operator |
| **Admin** | users, resync, audit trail, effective configuration | admin |

Routing is the URL hash (`#/stats`), so pages survive a reload and can be bookmarked
without a router dependency.

For UI work without a simulator, the chart gallery renders every chart from recorded
fixtures — `npm run dev:web`, then <http://localhost:5173/gallery.html>.

---

## 20. Configuration

All settings live in one zod schema in `server/src/config.ts`: typed, validated, with a
default and a comment each. Resolution order is **environment > `.env` > defaults**, and
the variable name is `GPA_` plus the field name in SCREAMING_SNAKE_CASE:

```ts
export const envName = (key: string) => "GPA_" + key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
```

So `simBaseUrl` → `GPA_SIM_BASE_URL`, mechanically. Invalid values stop the server at
startup with a precise message rather than failing mysteriously later:

```ts
const parsed = schema.safeParse(raw);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `${envName(String(i.path[0]))}: ${i.message}`);
  throw new Error(`Invalid settings:\n  ${problems.join("\n  ")}`);
}
```

Typos are caught too — a `GPA_*` variable matching no setting would otherwise be silently
ignored, so it is reported as a startup warning:

```ts
export function unknownSettingVars(env = process.env): string[] {
  const known = new Set(Object.keys(schema.shape).map(envName));
  return Object.keys(env).filter((k) => k.startsWith("GPA_") && !known.has(k)).sort();
}
```

### The settings you are most likely to touch

| Variable | Default | What |
|---|---|---|
| `GPA_SIM_BASE_URL` | `http://127.0.0.1:9898/api/v1` | the simulator's REST API |
| `GPA_APP_PORT` | `8000` | this server's port (must match `WebhookUrl`) |
| `GPA_SIM_LEVELS_DIR` | — | the simulator's settings folder: game speed + layouts |
| `GPA_ADMIN_PASSWORD` | — | first admin's password |
| `GPA_CONTROLLER_ENABLED` | `true` | `false` = passive listener, sends no commands |
| `GPA_ALLOCATION_STRATEGY` | `lane_zone_first_free` | see [§11](#11-spot-allocation) |
| `GPA_BILLING_ROUNDING` | `planned` | `planned` \| `round` \| `ceil` |
| `GPA_GAME_SPEED` | — | fixed override; normally leave unset |
| `GPA_SIGNATURE_MODE` | `strict` | `strict` / `lenient` / `monitor`: which signature statuses are acted on |
| `GPA_LOG_LEVEL` | `info` | `fatal`…`trace` |

**Naming convention:** a setting ending in `_GAME_S` is in **game seconds** and is scaled
by the current game speed. A setting ending in `_S` is real seconds. Mixing them up is the
easiest way to break timing.

The effective configuration, with secrets redacted, is visible at `/api/config` (admin) or
`/debug/config` (loopback) — useful for confirming what the running process actually
loaded, as opposed to what the `.env` on disk says.

---

## 21. Tests and tools

### Tests

```bash
npm test
```

81 tests across three files, plus `npm run typecheck` for every package.

| File | Covers |
|---|---|
| `server/test/controller.test.ts` | the car-park logic against a fake simulator |
| `server/test/webhook.test.ts` | parsing, signature, dedupe, sequence |
| `server/test/auth.test.ts` | hashing, sessions, roles, throttling |
| `server/test/helpers.ts` | the in-memory `SimApi` and time control |

The design makes this possible without the simulator: `SimApi` is an interface, `Store`
accepts `":memory:"`, topologies can be injected, and the task queue can be driven by
hand. Tests advance time by calling `tick()` rather than by sleeping, which is why
`later()` registers timers in a list *as well as* on `setTimeout`:

```ts
later(delayS: number, label: string, fn: Callback): void {
  if (this.replaying) return;
  const timer: Timer = { due: nowS() + delayS, label, fn, done: false };
  this.timers.push(timer);
  if (this.started) setTimeout(() => this.queue.push(() => this.runTimer(timer)), delayS * 1000);
}
```

Every simulator behaviour documented in the README has a corresponding test here — the
suite is a record of what live runs taught the team.

### Live tools

| Command | What |
|---|---|
| `npm run smoke` | API both ways + webhook delivery (`-- --gates` cycles a gate) |
| `npm run single-car` | drive one car by hand (needs `GPA_CONTROLLER_ENABLED=false`) |
| `npm run topology -- --levels-dir "<sim>/settings"` | regenerate `topology/*.json` |
| `npm run fake-sim -w server` | stand-in simulator on :9899 for dashboard work |
| `npm run report:gaps -w server` | silences and lost events |
| `npm run report:gates -w server` | gate timings |
| `npm run report:turnaways -w server` | cars refused entry |
| `npm run report:timeline -w server` | a run, event by event |
| `npm run report:plate -w server -- "ABC 123"` | one plate's full history |

---

## 22. Troubleshooting

**Nothing arrives — `/debug/stats` shows `received: 0`.**
Work outwards. Is the simulator running and listening? (`netstat -ano | grep 9898`.) Does
its `WebhookUrl` point at *this* server's port? Is it `127.0.0.1` rather than `localhost`?
Did you restart the simulator after editing `settings.json` — it only reads it at startup.

**`EADDRINUSE: address already in use 0.0.0.0:8000`.**
Another server instance is already running. Find it with `netstat -ano | grep ":8000 "`
and stop that PID, or change `GPA_APP_PORT` (and the simulator's `WebhookUrl` to match).

**Events arrive but no commands are sent.**
Check `controller_enabled` in `/debug/stats`. `GPA_CONTROLLER_ENABLED=false` is passive
mode, used with the single-car tool. Also check the log for `running WITHOUT gate control`
— an unresolved topology.

**"no topology matches entries=[…] exits=[…]".**
The running level has no layout file. Set `GPA_SIM_LEVELS_DIR` so one can be derived, or
generate one with `npm run topology`. The server still runs, without gate control.

**Timing is wrong — gates close too early, charges are rejected.**
Check `time_scale` and `time_scale_source` in `/api/state` (or the `×3.00` in the
dashboard's top bar). `×1.00` from `default` while the simulator runs faster means the
scale has not been found: set `GPA_SIM_LEVELS_DIR`, or `GPA_GAME_SPEED` as an override.

**Bills are rejected as the wrong amount.**
`GPA_BILLING_ROUNDING` should stay `planned`. Measured durations are wall-clock and are
wrong by the game-speed factor. With `GPA_RECHARGE_ON_WRONG_AMOUNT=true` the system
recovers by billing the amount the penalty states, but the root cause is usually rounding
mode or time scale.

**A car sits at the exit and blocks the lane.**
Look for `payment_mismatch` on the dashboard: the car underpaid and is deliberately not
released. Check the Logs page for the penalty text.

**Cars are turned away while spots look free.**
Free spots minus queued cars is the admission test. With `lane_zone_first_free`, an
entrance only draws on its own zone — spots free in another zone do not count. Check the
zone breakdown on Overview.

**Lost cars / rising `ghosts_retired`.**
Expected in small numbers (delivery is at-most-once). A sharp rise usually means the
simulator was restarted under a running server. `npm run report:gaps -w server` shows
where the silences were.

---

## Appendix: the shape of a decision

One arrival, from webhook to command, as a summary of everything above:

```
POST /webhook  {EventClass: "car_spot_action", SpotName: "ENTRY1", Direction: "CarIn", ...}
  │
  ├─ parseRaw()          numbers kept as text, for the signature
  ├─ intake.check()      signature / duplicate / sequence  →  accepted
  ├─ store.recordEvent() written to SQLite before anything else
  └─ controller.submit() queued; HTTP 200 returned immediately
        │
        ▼  (on the serial queue, one task at a time)
     handle() → routeCarEvent() → onEntryIn()
        │
        ├─ free spots − queued cars ≤ 0 ?  →  goto leavepark   (turned away)
        └─ otherwise: queue the car, then pumpEntry()
              │
              ├─ allocator.choose()   pick a spot; reserve it now
              ├─ whenGateOpen(gate)   request open, register a callback
              │      ⋯ gate_action webhook: Open ⋯
              └─ carGoto(plate, spot) ── recorded in `actions`
```

Every step is recorded, so the whole chain can be reconstructed afterwards from the
database — and replayed after a restart.

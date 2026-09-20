# Grand Park Auto — Level 3 context pack

Written for an autonomous coding agent (Devin) joining this repo cold.
Read this file **completely** before writing code. `CLAUDE.md` (repo root) is the
day-to-day handoff; `README.md` is setup/API; `docs/GUIDE.md` walks through the Level 1
mechanisms. This file is the Level 3 brief and it wins where the others are out of date.

---

## 1. What this system is

A hackathon project (Track 2). A Windows app — the **Parking Simulator** — runs a car park
and pushes **webhooks** at us; we drive it back through its **REST API**. Our server decides
everything: who is let in, which spot each car gets, when gates open and close, what each car
is billed, when equipment is repaired, when fans and lights run. The simulator fines us
("penalties") whenever we get it wrong, so *penalties are the score*.

Level 1 (one zone) and Level 2 (three zones, lights, fans, signed webhooks, component health)
are **done and verified against the live simulator**. Level 3 is an airport-scale car park:
7 zones, 250 parking spots, 20 gates, three traffic sources, indoor and outdoor areas.

### Level 3 requirements, verbatim from the organisers

> * Manage multiple parking zones, each with different layouts, capacities, entrances, and exits.
> * Support parking spots being placed into maintenance mode and temporarily removed from availability due to sensor abnormalities.
> * Be careful about suspicious payments and ask for payment again.
> * Continue operating when individual entry or exit gates fail, using other available gates.
> * Handle increased website and API traffic while keeping the dashboard stable and responsive. Think of optimization possibilities.
> * Reliably process many simulator events arriving simultaneously without losing or incorrectly processing events, like many cars deciding to leave after an event.
> * Detect and reject invalid, duplicated, tampered requests coming from the parking network and log duplicated calls. Show them on a dedicated admin page.
> * Provide dashboard views that give a summary about available, broken, under-maintenance components.
> * Detect double parking and raise an early warning when a vehicle occupies more than one parking spot.
> * Provide a function to locate vehicles, including cars that did not park in their assigned spots.
> * Big project needs better reporting and a complete audit trail for the new incidents and actions.

---

## 2. What you can and cannot run

| | |
|---|---|
| **You can run** | `npm install`, `npm test` (vitest, **142 tests pass today**), `npm run typecheck`, `npm run build`, the fake simulator (`npm run fake-sim -w server`), any `server/tools/*` script against a SQLite file |
| **You cannot run** | the Parking Simulator itself (Windows-only, on the team's laptop), anything that needs real webhooks, anything that needs the simulator's REST API |

**Therefore: every behaviour you add must be provable by a unit test.** "I think this works
live" is worth nothing here. The test harness (`server/test/helpers.ts`) already fakes the
simulator, the clock and the queue — extend it rather than inventing a second harness.

Node **>= 22** (the code uses `JSON.parse` source-text access). `better-sqlite3` is native and
compiles on install. Windows line endings are normalised by git (`autocrlf`); write LF.

---

## 3. Repo map

npm workspaces, TypeScript everywhere.

```
shared/src/protocol.ts   every literal string the simulator sends/expects + payload & REST types
shared/src/api.ts        our own HTTP API types (the contract the web app compiles against)

server/src/
  main.ts          startup
  app.ts           Fastify routes, auth guards, SSE stream, /debug/*
  webhook.ts       intake: parse, signature, dedupe, sequence tracking   <-- Level 3 security work lands near here
  serialQueue.ts   the single lane every state change runs through
  controller.ts    the brain: lanes, cars, gates, billing, routes, ghost sweeper (1900 lines)
  gameClock.ts     game speed estimation + pause detection
  topology.ts      lane<->gate pairing, routes derived from the level's road network, light placement
  allocation.ts    spot choice strategies (pluggable)
  components.ts    ComponentRegistry: health, usage, breakdowns, preventive maintenance
  environment.ts   subsystem: exhaust fans by CO, lights by night+movement
  subsystems.ts    the plug-in interface (onSync / onEvent / onTick / snapshot) + Engine facade
  billing.ts  simClient.ts  store.ts (SQLite)  auth.ts  config.ts
server/tools/      diagnostics, all runnable as `npm run <name> -w server -- <args>`
server/test/       vitest: controller, components, lights, webhook, auth + helpers.ts

web/src/           React 19 + Vite. pages: Overview, Operations, Equipment, Maintenance,
                   Incidents, Penalties, Reports, Logs, Stats, Admin, Login. Live data via SSE.

topology/lvl1..3.json   generated lane<->gate maps (lvl3 already generated: 8 entries, 10 exits)
data/gpa.db             SQLite (git-ignored)
```

### Database tables (`server/src/store.ts`)

`events` (every raw delivery, including rejected/duplicate) · `event_identities` (EventId ->
payload hash, first seen, accepted) · `sessions` (a car's visit) · `actions` (every command we
sent) · `components` + `component_events` · `incidents` · `maintenance_jobs` ·
`command_intents` · `invoices` + `payments` · `users`, `auth_sessions`, `login_attempts`,
`audit_log`.

Several of these (incidents, maintenance_jobs, invoices, payments, audit_log) were added late
in Level 2 by teammates and are **only partly wired up** — check what actually writes to each
before assuming a feature exists.

---

## 4. Architecture invariants — do not break these

1. **One serial queue.** Every webhook, tick, resync and manual command runs as a task on
   `SerialQueue`. No handler ever sees state change under its feet, so there are no locks
   anywhere. If you need concurrency for throughput, get it *outside* the queue (cheaper
   handlers, batched REST calls, off-queue read models) — **do not** add a second writer.
2. **Game time, never wall time.** The simulator's speed changes live (×1 to ×12) and the game
   can be paused. Every delay is expressed in *game seconds* (`*GameS` settings) and scheduled
   with `engine.later()` / `GameClock`. **Never hardcode a real-second timeout.**
3. **Subsystems, not controller edits.** New behaviour (environment, and anything you add for
   Level 3 such as sensor-health or fraud scoring) implements `Subsystem` in its own file and
   is registered in `createSubsystems()`. `controller.ts` is already 1900 lines; resist adding
   to it unless the logic truly belongs to car/lane/gate flow.
4. **`shared/` is the contract.** Simulator strings live only in `protocol.ts`; our own API
   types only in `api.ts`. The web app must compile against those types — changing a response
   shape without updating `api.ts` breaks the other workstream.
5. **Everything is replayable.** Events are persisted before they are acted on, and
   `controller.replay()` rebuilds state after a restart (`engine.replaying` = decide nothing,
   send nothing). New state you introduce must either be derivable on replay or persisted.
6. **Config, not constants.** Every tunable goes in `server/src/config.ts` (env `GPA_*`) and is
   documented in `.env.example`. New Level 3 features ship **behind a flag that defaults to the
   safe/current behaviour** so a bad idea can be switched off during a live run.
7. **Every simulator quirk gets a regression test**, with a comment citing the run that found
   it. That is why the existing tests are worth reading — each one encodes a real fine.

---

## 5. The simulator contract (learned the hard way — trust this list)

* Address is `127.0.0.1`, never `localhost`. REST base `http://127.0.0.1:9898/api/v1`, basic
  login admin/admin, JWT bearer afterwards.
* **Webhooks are at-most-once and can reorder.** They carry `EventId`, `SequenceId`,
  `Signature`, `ServerDateTime` (wall clock — *no* in-game time of day anywhere).
* **Signature** = MD5 of the payload's values, keys sorted alphabetically, joined with `|`,
  excluding `Signature`. Numbers must be hashed as the exact text received, which is why
  `parseRaw()` keeps JSON number source text. Level 1 is unsigned; **Level 2+ signs
  everything**; `GPA_SIGNATURE_MODE` = `strict` | `lenient` | `monitor`.
* **A `payment_made` with a bad signature is the spec's fake payment.** Never release the car;
  re-issue the charge (currently up to 3 times — some cars fake twice).
* Event classes: `car_spot_action`, `gate_action`, `payment_made`, `penalty`,
  `component_broken`, `component_fixed`, `carbon_monoxide_event`, `test_webhook`.
* **`carbon_monoxide_event` has never actually arrived**, even while we were being fined for
  high CO. CO is read by polling `list-zones`.
* Commands: `goto <plate> <spot|exit|leavepark>`, `charge`, gate open/close/repair, light
  on/off + group on/off, fan on/off/repair, spot repair. **The simulator silently drops some
  gotos** — we re-send after 4 game-seconds (max 5 resends).
* An `open` sent while a gate is *closing* is ignored; re-send when it reports `Closed`.
* **Parts break by use**: gates on their ~10th opening, spots after ~12 visits. A broken repair
  takes ~2.3 minutes; a **preventive** repair (before it breaks) takes 8–35 s and is not fined.
  Operating or repairing a part that is broken, under repair, or in use is a penalty.
* Charge ~1.5 game-seconds after the car's CarIn at an exit (too early = "should be charged at
  the exit"); the delay self-tunes per exit. Bill = planned minutes × rate, ×2 for Electric.
  Never charge twice.
* A car sent to an occupied spot is fined **and parks anyway** — spots hold a *set* of
  occupants, not one.
* **We never choose a car's exit.** A parked car leaves on its own and appears at whichever
  exit sensor it chose; we only open that gate and charge there. (`goto ... exit` exists but we
  do not use it. If Level 3 needs exit steering, that must be tested live first — see §9.)
* Cars at an *exit* sensor will drive out through an open gate whether they paid or not; cars
  at an *entry* sensor never move without our `goto` (7,124 entries checked), so entry gates
  can safely be held open across a stream of cars.
* Level state is **not saved** — restarting the simulator resets every part's usage counter, so
  our persisted usage has to be reset on a fresh site or gates look worn and stop opening
  (this bug once blocked every entrance).

---

## 6. The Level 3 map — measured from the simulator's `lvl3.json`

| | |
|---|---|
| Zones | **7**: `ZONE1-3` are `ZoneType: "Closed"` (indoor), `ZONE4-7` are `"Open"` (outdoor) |
| Parking spots | **250** (`ZONE1-3`: 30 each, `ZONE4-7`: 40 each) + 8 entry, 13 exit, 12 `LeaveParking` escape spots = 275 total |
| Spot car types | 218 `Any`, 21 `Electric`, 11 `Accessible` |
| Gates | **20**, `gate1`–`gate19` — **note `gate7` appears twice** (once with no zone, once in ZONE4), and `gate2`/`gate19` have an empty `ZoneParent`. Do not assume gate names are unique keys without checking. |
| Lights | **30**, only indoors: ZONE1/G1, ZONE2/G2, ZONE3/G3, ten each |
| Exhaust fans | **12**, only indoors: 4 per closed zone |
| Entrances | 8: `ENTRY1-3` (indoor), `Entry104`, `OENTRY1-4` (outdoor) |
| Exits | 10 lanes: indoor zones have 1 exit each, **ZONE5/6/7 have 2 exits each** |
| Traffic | **3 car emitters** (periods 7000/2000/8000 ms) vs one on Level 2 — bursts arrive at several entrances at once |
| Roads | two large, effectively separate networks (164 and 366 path connections): the indoor side and the outdoor side |

`topology/lvl3.json` has already been generated (entry/exit lane → gate → zone). Routes
between entrances and zones are derived at runtime from the simulator's own level file via
`GPA_SIM_LEVELS_DIR`; `npm run report:routes -w server` prints them.

**Implications you should design for:**
* Outdoor zones have **no lights and no fans** — the environment subsystem must not try to
  operate equipment that does not exist there, and must not report those zones as "dark".
* Two exits per outdoor zone = the first real chance to keep serving a zone whose exit gate is
  broken.
* 250 spots × 20 gates × 30 lights × 12 fans = ~312 tracked components, and the dashboard
  currently ships all of them to every client every second (see §7, performance).
* Three emitters mean genuinely simultaneous events; the "many cars leave after an event"
  scenario in the brief is exactly this.

---

## 7. Where Level 3 meets the existing code

For each requirement: what exists, what is missing, and how to approach it. **Read the
existing code before building** — several of these are 80% done.

### 7.1 Many zones, layouts, capacities, entrances, exits — *mostly exists*
`topology.ts` derives lanes, gates and routes from the level file; `allocation.ts` has four
strategies (`lane_zone_first_free`, `lane_zone_then_any`, `any_zone_first_free`,
`zone_balanced`). **Missing:** `ZoneType` (Closed/Open) is not carried into our topology;
allocation has never run against 7 zones or dual-exit zones; capacity and occupancy per zone
are computed but not used for admission control at this scale. Add the zone type, make the balanced
strategy aware of indoor/outdoor and of *which exits are healthy*, and make sure a zone that is
full or unreachable degrades to the next best zone instead of turning the car away.

### 7.2 Maintenance mode for spots with sensor abnormalities — *new*
The REST API we know exposes only `repair` for a spot; `list-parking-spots` reports
`isUnderMaintenance` and `detectedCars`. **Check the simulator's API docs for a Level 3
maintenance endpoint** — if there is one, call it behind a flag; if not, implement maintenance
as *our* soft lock: the spot stays in the registry, is excluded from allocation, is shown as
"under maintenance" on the dashboard, and a `maintenance_jobs` row records why.
Abnormality signals worth detecting (all visible in existing data): `detectedCars` > 1 when we
placed one car; `detectedCars` > 0 for a spot we believe is free (ghost), persisting across two
syncs; a spot that never reports the car we sent to it; a sensor flapping several times within
a short game window; a spot whose occupancy disagrees with our session state after a resync.
Each detection → an `incidents` row with evidence + confidence, and a `maintenance_jobs` row.
Auto-return to service after the spot reads clean for N consecutive syncs, or on operator
action. Everything configurable, default thresholds conservative.

### 7.3 Suspicious payments — *partly exists*
Today: an invalid signature = fake payment, we never release the car and re-charge up to
`GPA_FAKE_PAYMENT_RECHARGES` (3). **Missing:** the other fraud shapes — wrong amount (there is
`rechargeOnWrongAmount` but no incident trail), a payment replayed with a new `EventId`, two
payments against one invoice (the `payments` table has `UNIQUE(invoice_id, amount)` — use it),
payment for a car that is not at an exit, payment before we issued a charge, payment for an
unknown plate, amounts that do not match any open invoice. Put the scoring in one place
(a `fraud`/`payments` subsystem), raise an incident with evidence, re-ask, and never release.

### 7.4 Keep running when gates fail — *partly exists*
`components.ts` already repairs broken parts as soon as nothing is using them, repairs
preventively before the breaking use, and refuses to open a worn-out gate; `resume()` restarts
whatever was waiting. **Missing at Level 3 scale:** entry-side failover (if an entrance's gate
is down, admit through another entrance/route to a reachable zone rather than queueing), exit
awareness (prefer zones whose exit gates are healthy — ZONE5/6/7 have two), and an explicit
"degraded mode" view so the operator can see which lanes are effectively out of service.

### 7.5 Traffic, responsiveness, optimization — *the weakest area today*
Current behaviour: **`/api/stream` serialises a full `controller.snapshot()` for every
connected client every second** (`streamIntervalS`), and `snapshot()` walks every spot, gate,
car and lane. At 250 spots that is megabytes per minute per open dashboard tab. Ideas, roughly
in value order:
* build the snapshot **once per tick** and share the serialised string across all SSE clients;
* send **deltas** (changed entities only) with a periodic full resync, keeping the full
  snapshot on `/api/state` for first paint;
* cheap **ETag/304** on `/api/state`, and `limit`/`offset` + sane caps on every list endpoint
  (several already cap at 500–1000 — make it consistent);
* SQLite: confirm **WAL mode** and that hot queries are indexed (`events`, `sessions`,
  `actions` by time); keep using prepared statements;
* cap in-memory ring buffers (`feedSize`, `recentEventsSize`, `completedSessionsSize`) and the
  timeseries;
* web side: virtualise the 250-spot grid and the long tables, memoise chart data, avoid
  re-rendering every card on each snapshot;
* add a **load-test tool** (`server/tools/loadTest.ts`) that fires N webhooks/second at
  `/webhook` and opens M SSE clients, and report before/after numbers in the PR. This is the
  evidence the organisers asked for ("think of optimization possibilities").

### 7.6 Bursts of simultaneous events — *partly exists*
Events are persisted on arrival and then queued, so nothing is lost if a handler throws; the
queue guarantees order. **Missing:** visibility and backpressure — queue depth, oldest waiting
task, per-handler duration, and a metric on the dashboard; making sure `/webhook` responds
immediately rather than after processing; and making the hot handlers cheap (batch or cache
`list-*` calls instead of one REST round-trip per car). Simulate the "everyone leaves at once"
scenario in a test: 40 `car_spot_action` CarOut events in one tick, all of them must produce
exactly one charge and one release each.
**Also delete the 8 `#region agent log` blocks in `controller.ts`** — they `fetch()` to
`127.0.0.1:7502` on every event, command and penalty. They are leftover debugging and will
hurt under load.

### 7.7 Invalid / duplicated / tampered requests + admin page — *partly exists*
`webhook.ts` classifies `valid|unsigned|invalid`, dedupes by `EventId` (in memory) and tracks
`SequenceId` gaps; `event_identities` stores the payload hash of the first delivery.
**Missing:** the **tampered** classification (same `EventId`, *different* payload hash — the
table already makes this a one-line lookup), durable dedupe across restarts (load the ids or
query the table instead of the in-memory `Set`), stale/replayed `ServerDateTime` outside an
accepted window, per-source rate limiting, and the **dedicated admin page** the brief demands:
filterable list of rejected / duplicate / tampered / unsigned deliveries with payload, reason,
source and counters. Keep the raw deliveries — they are the evidence.

### 7.8 Dashboard summary of available / broken / under-maintenance components — *partly exists*
`/api/components` and `/api/equipment` return every component with health and usage;
`web/src/components/health.tsx` and `Equipment.tsx` show them. **Missing:** the rollup the brief
asks for — per zone and per kind: total / available / broken / under maintenance / due for
preventive repair, with drill-down, and a whole-site banner when a zone is degraded.

### 7.9 Double parking — *new*
Two distinct cases, both detectable from data we already hold:
1. a spot reports `detectedCars > 1`, or a `car_spot_action` CarIn arrives for a spot whose
   `occupants` set is not empty;
2. one plate is recorded at two spots at once (it drove off to a second spot without a CarOut).
Raise an **early warning** — an `incidents` row with confidence and evidence, a dashboard
badge, and a feed line — *before* the simulator fines us where possible (e.g. when we are about
to dispatch a car to a spot whose sensor already sees something). Include the neighbouring
spot when the geometry in the level file makes it obvious.

### 7.10 Locate a vehicle — *new (pieces exist)*
A single function/endpoint: given a plate (partial match too), return where the car is *now*
(entry lane / driving in / parked at spot X / at exit / left), where it was **assigned** versus
where it **actually parked**, its zone, its invoice and payment state, and its full event
timeline. `server/tools/plateHistory.ts` already assembles most of this offline — lift that
logic into the store/API and give it a search page in the web app. Cars that parked somewhere
other than their assignment are the interesting case and should be flagged as such.

### 7.11 Reporting and a complete audit trail — *partly exists*
`audit_log` exists and `/api/audit` serves it; daily reports exist at `/api/reports/daily`
(+ `/export`). **Missing:** every *new* Level 3 action must be audited with actor, permission,
target, result and reason — incident raised/resolved, maintenance mode entered/left, manual
repair, fraud re-charge, report generated, security rejection. Reports should gain: incidents
by kind, fraud attempts, maintenance and availability per zone, gate/spot wear, revenue and
uncollected amounts, penalty count and cost. Enforce RBAC on the privileged ones
(`ROLE_PERMISSIONS` in `shared/src/api.ts` — repair and financial reports are Admin-only).

---

## 8. Conventions

* Comments explain **why**, and cite the live run that motivated the code where relevant.
* New settings: `server/src/config.ts` + `.env.example`, `GPA_` prefix, safe defaults.
* Timings in **game seconds**, named `*GameS`.
* Keep `shared/` types and the web app in sync; `npm run typecheck` covers all three workspaces.
* Small, reviewable commits with a subject line that says what changed and why.
* Do not commit `data/`, `.env`, or anything with credentials.
* British/plain English in UI strings; the dashboard is used by non-developers.

---

## 9. Open questions only the human team can answer

Flag these in your PR rather than guessing — the team can check them against the running
simulator in minutes:

1. Does the Level 3 REST API expose a **maintenance-mode endpoint** for spots (beyond
   `repair`)? Check the simulator's API docs/Swagger on port 9898.
2. Does `goto <plate> exit` let us **steer a car to a specific exit** (e.g. `goto <plate>
   Exit187`), or only to "any exit"? This decides whether exit-gate failover can actively
   reroute cars or only repair fast.
3. Are there **new Level 3 webhook classes** (maintenance, sensor fault, double parking)? Run
   the simulator for a few minutes and check `report:level`.
4. Do the two road networks connect anywhere, i.e. can a car entering at `ENTRY1` (indoor)
   reach an outdoor zone? `report:routes` answers this from the level file.
5. Does a restart still wipe part usage at Level 3 (it did at Level 2)?

---

## 10. Definition of done

* `npm run typecheck` clean; `npm test` green with the existing **142 tests still passing**
  plus new tests for everything you added.
* Every new feature has a config flag with a safe default and a line in `.env.example`.
* No behaviour regression for Levels 1 and 2 — the same code runs all three levels, selected by
  the level file, not by branching on a level number.
* Performance work is backed by before/after numbers from a repeatable script.
* New API responses are typed in `shared/src/api.ts` and surfaced in the web app.
* `CLAUDE.md` updated: what is new, what is still open, what needs live verification.
* A PR description listing: what changed, how it was verified, what could not be verified
  without the simulator, and the answers you need from the team (§9).

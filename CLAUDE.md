# Grand Park Auto — context for Claude

IoT hackathon, **Track 2**, team of 4. We control a simulated car park: the Parking
Simulator (a Windows app) sends us webhooks and we drive it through its REST API.
**Current stage: Level 1 done (branch main); Level 2 in progress on branch `miro_level2` - see Status below.** Deep walkthrough of
every mechanism: `docs/GUIDE.md` (22 sections). Setup/API/behaviours: `README.md`.

## Level 1 requirements (from the spec)
Receive simulator webhooks, call its REST API, run entry -> parking -> billing -> exit,
web dashboard, database, **Admin and Operator roles** (admin has more privileges),
searchable logs, final presentation. Billing: 1 per minute (planned minutes), x2 for
electric cars. Penalties are fines the simulator issues for our mistakes; minimise them.

## Stack & layout (npm workspaces, Node >= 22, TypeScript)
- `shared/` — protocol constants (`protocol.ts`) and API types (`api.ts`) used by both sides.
- `server/` — Fastify 5, zod 4, better-sqlite3, pino, vitest.
  - `src/main.ts` startup · `app.ts` routes + auth guards + SSE · `webhook.ts` intake
    (signature, EventId dedupe, SequenceId gaps) · `serialQueue.ts` · `controller.ts` the
    brain · `gameClock.ts` game speed + pauses · `topology.ts` lane/gate pairing ·
    `allocation.ts` spot choice · `billing.ts` · `simClient.ts` REST + JWT · `store.ts`
    SQLite · `auth.ts` scrypt + sessions · `config.ts` all settings (env `GPA_*`).
  - `tools/` diagnostics (see below) · `test/` vitest (88 tests; `helpers.ts` has FakeSim,
    RecordingQueue, `make()` with a hand-driven clock `advance(realS, live)`).
- `web/` — React 19 + Vite dashboard: pages Overview, Operations, Logs, Stats, Admin, Login.
  Hash routing in `App.tsx`; live data via SSE (`lib/live.ts`). `gallery.html` +
  `dev-fixtures/` render pages without a server (dev only).
- `topology/lvl1..3.json` — which gate serves which entry/exit (resolved by matching live sensors).
- `data/gpa.db` — runtime SQLite (git-ignored): events, actions, sessions, users, auth_sessions.
- `.env` (git-ignored, repo root) — local: `GPA_SIM_LEVELS_DIR=<simulator>/settings`.

## Running
```
npm install
npm run dev          # server on :8000 (NOT watch mode - restarts mid-run break state)
npm run dev:web      # dashboard on :5173 (proxies /api to :8000); or `npm run build` and use :8000
npm test             # server tests      npm run typecheck   # all workspaces
```
Simulator: `http://127.0.0.1:9898/api/v1`, login admin/admin; its `settings.json` has
`WebhookUrl: http://127.0.0.1:8000/webhook` and `GameSpeedMultiplier`. First start creates
dashboard admin from `GPA_ADMIN_PASSWORD` (or prints a generated one). Reset a password:
`npm run user:password -w server -- admin "new password"`.
Before restarting the server, make sure no old `tsx src/main.ts` process is still running
(two controllers once ran at the same time; the dashboard's SSE stayed on the stale one).

## How the engine works (short)
Webhook -> stored in `events` -> `controller.submit` -> **SerialQueue** (events, 0.5 s ticks,
resyncs and dashboard commands never interleave) -> handler -> REST commands (each stored in
`actions`). Per entry lane: FIFO queue, one car at a time: reserve spot -> open gate -> on
`Open` goto spot -> on entry CarOut dispatch next or close gate after 1.5 game-s.
Exit: exit CarIn -> charge after 1.5 game-s -> payment_made -> open gate -> goto leavepark
-> exit CarOut -> session stored -> close gate. Startup replays the last 30 min of events
AND our recorded commands (only if the log is < 120 s old) and reconciles with
list-parking-spots/barriers. A ghost sweeper retires records whose closing event never came.
Car statuses: queued, dispatching, dispatched, entering, parked, to_exit, at_exit, invoiced,
released, gone, payment_mismatch, turned_away, neglected, lost, unknown.

## Simulator facts we learned the hard way (all have tests)
- Use `127.0.0.1`, never `localhost` (Windows IPv6 fallback costs ~2 s per request).
- Level 1 webhooks are unsigned (`Signature: null`); at-most-once, can reorder.
- **Game speed**: timestamps are wall-clock, the game runs faster and can be changed live
  (Shift+PgUp) or paused. All timing settings are `*GameS` and measured on `GameClock`:
  speed from gate move timing right after a change (a move = 0.03 s + ~0.48 game-s), then
  from completed stays (planned min / real time), else settings.json, else 1. The clock
  stops after 20 s with no webhook (paused game must not age parked cars).
- **The sim silently drops some `goto`s** (~15% when another car's event fires at the same
  moment): car sits on its sensor. We re-send after 4 game-s, up to 5 times (entry dispatch,
  exit release, turn-away). Unconfirmed gate open/close are re-sent too.
- An `open` sent while a gate is closing is ignored — re-sent on `Closed`.
- Charging instantly at exit CarIn is a penalty ("charged at the exit") — wait 1.5 game-s.
  The sim checks the bill against **planned** minutes. Never charge twice.
- A car sent to an occupied spot is fined **and parks there anyway**: spots track a set of
  occupants; an "occupied spot" penalty marks it taken and redirects the car.
- S15/S30 (Level 1) are beyond the exit sensor: cars fire exit CarIn/Out on the way IN
  (ignored while driving in). From S15 the exit CarIn arrives before the spot CarOut.
- The sim autosaves cars into `lvl*.json` and reuses plates; restarting it makes cars
  vanish without events.
- Penalty `ComponentName` has no space in the plate ("QNL430").

## Roles & API
Operator: view everything, hold gates open/closed/auto, repair gates/spots.
Admin: + open/close entrances, resync, config, user management (`/api/users`).
Cookie `gpa_session` (HttpOnly, SameSite=Strict), login throttling. `/debug/*` only from
loopback or admin. Main routes: `/webhook`, `/api/auth/*`, `/api/state`, `/api/stream`
(SSE), `/api/timeseries`, `/api/stats`, `/api/sessions|events|actions`, `/api/control/*`.

## Diagnostic tools (`npm run <script> -w server -- args`)
`report:penalties` (why each penalty happened) · `report:window 21:10:50 21:11:10`
(every event + command, local time) · `report:speed 21:00 21:30` (speed estimator replay) ·
`discover` (list-* snapshot of the loaded level, once per level; saved to data/discovery/) ·
`report:level [HH:MM HH:MM]` (event classes/fields, signature check + variants, car
routes, CO, component failures, penalties, which time fields are game time) ·
`report:gaps` (lost events / silences) · `report:gates` · `report:turnaways` ·
`report:plate "ABC 123"` · `report:timeline` · `smoke` · `single-car` · `fake-sim`.
For ad-hoc DB analysis write a script (PowerShell mangles inline `node -e` quoting).

## Status (2026-09-20)
Done: TS migration, controller, dashboard + auth, penalty fixes (occupied spots, double
charges, exit-sensor pass-through, replay of our own commands), dropped-goto re-sends,
live game-speed tracking + pause freeze. Latest measured run: 0 penalties in the hour
after the occupied-spot fix. All on `main` (commits 1e56dfd, 81dda80; teammate added
`docs/GUIDE.md`). Branches `miro_testing` (old Python prototype), `miro_level1`.

Open / next:
- Verify the dropped-goto and speed-change fixes on a live run at several speeds
  (watch the log for "re-sending" and "game speed changed ... (from gate timing)").
- `controller.ts` contains `#region agent log` blocks posting to `127.0.0.1:7502`
  (leftover from another debugging tool) — remove once no one needs them.
- Presentation for Level 1.
- Level 2 (branch `miro_level2`), incremental plan: 1 baseline on the 3-zone map + signed
  webhooks (`GPA_SIGNATURE_MODE` strict|lenient|monitor) -> 2 component health (broken/
  fixed, never use broken parts, dashboard; split controller.ts) -> 3 preventive
  maintenance -> 4 CO fans + day/night lights -> 5 RBAC, login history, audit log ->
  6 penalties page, daily reports, vehicle-type billing, manually-parked-car scenario.
  **Step 1 DONE** (commit 7940b8c on miro_level2; push failed from Claude's sandbox with an
  SSL error - push from your own terminal). Level 2 run 2026-09-20 01:14: 557/557 webhooks
  validly signed -> local .env GPA_SIGNATURE_MODE=strict. Findings: all cars arrive at
  ENTRY1 only (Normal/Accessible/Electric ~1/3 each) so ZONE2/3 sat empty (allocator keeps
  ENTRY1 cars in ZONE1 - try GPA_ALLOCATION_STRATEGY=any_zone_first_free and watch for
  "cannot reach" penalties); gate1 broke 1 min in and nothing repaired it (lane dead 12
  min); ServerDateTime is wall clock (x1.01) so day/night is NOT in events; CO max 7 (fans
  never needed); all 30 lights on.
  **Step 2 (component health) BUILT** (commit f4a8f7b on miro_level2, not yet verified live): `server/src/subsystems.ts`
  (plug-in slot: Subsystem{onSync,onEvent,onTick,snapshot} + Engine interface; add new ones
  in createSubsystems()), `server/src/components.ts` (ComponentRegistry: gates/spots/fans/
  lights, health, usage persisted in tables `components` + `component_events`, auto repair
  when not in use, retry after repairRetryGameS), controller guards (never open a broken
  gate; resume() after a fix restarts lanes, waiting gate opens and paid cars at exits;
  gateInUse()), shared types for components/permissions/login attempts/audit/penalties in
  shared/src/api.ts, protocol types SimLight/SimExhaustFan/SimAlarm/SimZone,
  test/components.test.ts, GET /api/components (parts + history), dashboard "Component
  health" card at the top of Operations (web/src/components/health.tsx), allocation strategy
  `lane_zone_then_any` (own zone first, overflow to others; opt-in via
  GPA_ALLOCATION_STRATEGY). 98 tests pass. Remaining for step 2: a live Level 2 run to verify
  repairs (`report:level`, look for "repairing broken" in the log and the health card).
  **Live run 2026-09-20 01:50-02:15 (step 2 verified) found:** auto repairs worked, but
  gates break on EXACTLY their 10th opening (10/10 breakdowns), a repair takes ~2.3 min,
  so each entrance/exit was down 55% of the time (20 fine per breakdown); 6 payments had
  a BAD SIGNATURE = the spec's fake payments -> 9 "Car escaped without paying" penalties
  (unpaid car sits at the exit, fined every ~3 min until it drives out).
  **Step 3 BUILT (fixes):** preventive maintenance in components.ts (limit learned =
  min uses_at_breakdown per kind, or GPA_GATE_CYCLE_LIMIT etc.; repair when one more use
  would break it, or at GPA_PREVENTIVE_IDLE_RATIO=0.8 when nothing needs it; controller
  never opens a worn-out gate); entry gates stay open GPA_ENTRY_GATE_CLOSE_DELAY_GAME_S=10
  after the last car (cars never enter without a goto: 7,124 entries checked; each
  closing costs a cycle) while exit gates still close in 1.5 game-s (unpaid cars at an
  exit DO drive out through an open gate); bad-signature payment_made -> app.ts
  controller.submitRejected() -> counted (counters.fake_payments), never released, car
  asked to pay once more (GPA_RECHARGE_AFTER_FAKE_PAYMENT; watch for a "charged twice"
  penalty in the next run - if so set it false). BUG found live 02:26 + fixed: the simulator
  restarts Level 2 with NEW parts (lvl2.json is never saved) but our persisted gate uses (11)
  survived -> gate1 looked worn out and was never opened. Fix: usage reset when the sim/level
  starts fresh (menu -> level, level change, event log older than replayMaxGapS; history and
  learned limits kept); a blocked worn gate gets its repair immediately, and is used anyway if the
  repair is refused or none starts within GPA_WORN_WAIT_MAX_GAME_S (never a dead lane);
  controller no longer resumes on component_fixed before components reset the count.
  Diagnose a live run with 
pm run report:live -w server (GET /debug/controller, loopback).
  Also verified: 0 of 2,165 turned-away cars parked without our goto (open entry gate safe).
  **Verified live 02:28-03:00: 0 breakdowns (24 preventive repairs, 35 s each vs ~140 s for a
  broken gate), lanes down 21-24% (was 55%), 5 fake payments all paid for real after the re-charge,
  0 penalties.** Remaining: 119/331 arrivals (36%) turned away - ZONE1 full while ZONE2/3 empty
  (all cars enter at ENTRY1). Fixed: 49 double leaveparks (stuck check used the old entry goto;
  car.gotoG reset on release + waitingForGate).
  **Zone distribution BUILT (untested live):** allocation strategy zone_balanced (allocation.ts)
  scores each free spot: zone load + 0.25 if not the entrance's own zone + exit gate down (1) /
  wear (0.3 x uses/limit) from controller.allocContext() + 0.3 if not the car's own spot type;
  ties -> least-worn spot. Penalty mentioning "reach" for a car mid-entry to another zone ->
  controller.unreachable "ENTRY1>ZONE2" + redirect home. Local .env set to zone_balanced (default
  stays lane_zone_first_free). 109 tests. NEXT: live run - watch ZONE2/3 filling, turn-aways,
  any "reach" penalties, exit gates gate4/gate6 used. Then (was: live run to verify),
  then zone distribution (user wants a smarter spread across zones: full/broken-gate zones,
  balance wear so one zone's gates/spots don't take all the maintenance).
  Team split (4 people): A = core engine/repairs/maintenance (Miro + Claude), B = environment
  subsystem (CO fans, day/night lights) plugging into subsystems.ts, C = RBAC permissions
  (ROLE_PERMISSIONS in shared/api.ts), login attempt log + last 3 after login, audit log,
  rejected-webhook page, D = penalties page, components page, daily/financial reports,
  presentation.

## Working conventions
- Don't commit or push unless asked; branch off `main` for new work.
- Match existing style: comments explain *why* (often citing the run that found the bug),
  settings go in `config.ts` + `.env.example` + README, every simulator quirk gets a test.
- Never hardcode timing in real seconds: add a `*GameS` setting.
- Windows machine: PowerShell 5.1 is the shell; files use CRLF (git autocrlf).

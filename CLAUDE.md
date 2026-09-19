# Grand Park Auto — context for Claude

IoT hackathon, **Track 2**, team of 4. We control a simulated car park: the Parking
Simulator (a Windows app) sends us webhooks and we drive it through its REST API.
**Current stage: Level 1 is built and running; not yet on Level 2.** Deep walkthrough of
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
  Step 1 in progress: observe a Level 2 run in monitor mode, then `discover` + `report:level`.

## Working conventions
- Don't commit or push unless asked; branch off `main` for new work.
- Match existing style: comments explain *why* (often citing the run that found the bug),
  settings go in `config.ts` + `.env.example` + README, every simulator quirk gets a test.
- Never hardcode timing in real seconds: add a `*GameS` setting.
- Windows machine: PowerShell 5.1 is the shell; files use CRLF (git autocrlf).

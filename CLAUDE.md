# Grand Park Auto — context for Claude

IoT hackathon, **Track 2**, team of 4. We control a simulated car park: the Parking
Simulator (a Windows app) sends us webhooks and we drive it through its REST API.
**Level 1 done (branch `main`). Level 2 in progress on branch `miro_level2`: everything but
LIGHTS is built and verified live - see "Level 2 status" and "NEXT: lights" below.**
Deep walkthrough of the Level 1 mechanisms: `docs/GUIDE.md`. Setup/API/behaviours: `README.md`.
Spec PDF: `C:\Users\Miro Or Kam Fat\Downloads\Track 2 specs.pdf` (read with pypdf; Level 1
+ API/webhook/penalty docs). Level 2 requirements are in "Level 2 requirements" below.

## Requirements
Level 1: receive webhooks, call the REST API, entry -> parking -> billing -> exit, web
dashboard, database, Admin and Operator roles, searchable logs, presentation. Billing: 1 per
planned minute, x2 electric.
Level 2 (3 zones, several entrances/exits, car/spot types, lights, exhaust fans): keep running
while parts fail; monitor usage of spots, gates, lights, fans; **lights must not run in the
simulator's daytime**; preventive maintenance before parts fail; detect/record/show broken
parts; monitor CO and run fans; charges per vehicle type; store events; RBAC (only authorised
users repair and generate financial reports); record successful and failed logins and show the
last three after login; only act on signed webhooks and log unsigned ones; audit log; penalties
page; dynamic daily reports; explain how we handle a car parked manually without entry/spot
sensors that wants to leave.

## Stack & layout (npm workspaces, Node >= 22, TypeScript)
- `shared/` — `protocol.ts` (every simulator string + payload/REST types incl. SimLight,
  SimExhaustFan, SimAlarm, SimZone) and `api.ts` (our HTTP API types incl. ComponentView,
  ROLE_PERMISSIONS, LoginAttemptView, AuditEntryView, PenaltyView - contracts for teammates).
- `server/` — Fastify 5, zod 4, better-sqlite3, pino, vitest.
  - `main.ts` startup · `app.ts` routes, auth guards, SSE, `/debug/*` · `webhook.ts` intake
    (signature, dedupe, sequence) · `serialQueue.ts` · `controller.ts` the brain (lanes, cars,
    gates, billing, routes, ghost sweeper) · `gameClock.ts` game speed + pauses ·
    `topology.ts` lane/gate pairing + **routes from the level's road network** ·
    `allocation.ts` spot choice · `billing.ts` · `simClient.ts` REST + JWT · `store.ts` SQLite ·
    `auth.ts` · `config.ts` every setting (env `GPA_*`, documented in `.env.example`).
  - **Plug-ins:** `subsystems.ts` (Subsystem {onSync, onEvent, onTick, snapshot} + Engine
    interface; register in `createSubsystems()`), `components.ts` (ComponentRegistry: health,
    usage, repairs, preventive maintenance - core, always first), `environment.ts` (exhaust
    fans by CO; **lights go here**).
  - `tools/` diagnostics (below) · `test/` vitest, 125 tests (`helpers.ts`: FakeSim with
    fans/lights/zones, RecordingQueue, `make()` with a hand-driven clock `advance(realS, live)`).
- `web/` — React 19 + Vite: pages Overview, Operations (top: Component health card incl.
  fans table - `components/health.tsx`), Logs, Stats, Admin, Login. Live data via SSE.
- `topology/lvl1..3.json` — gate per entry/exit lane; routes are derived at runtime from
  `<GPA_SIM_LEVELS_DIR>/lvl*.json`.
- `data/gpa.db` (git-ignored): events, sessions, actions, users, auth_sessions, components,
  component_events. `data/discovery/` list-* snapshots.
- `.env` (git-ignored) local: `GPA_SIM_LEVELS_DIR=C:/Users/Miro Or Kam Fat/Downloads/ParkingSimulator-win-x64/ParkingSimulator-win-x64/settings`,
  `GPA_SIGNATURE_MODE=strict` (Level 2; use lenient for Level 1), `GPA_ALLOCATION_STRATEGY=zone_balanced`.

## Running
```
npm install
npm run dev          # server :8000 (NOT watch mode - restarts mid-run break state)
npm run dev:web      # dashboard :5173 (proxies /api), or npm run build and use :8000
npm test             # server tests      npm run typecheck   # all workspaces
```
Simulator API `http://127.0.0.1:9898/api/v1` (admin/admin); its `settings.json` WebhookUrl
`http://127.0.0.1:8000/webhook`. Keys: P pause, Shift+PgUp/PgDn speed, Shift+C remove cars,
Shift+Z clear penalties, Shift+X repair all, Shift+V clear CO. Make sure only ONE
`tsx src/main.ts` runs. `git push` fails from Claude's sandbox (SSL) - the user pushes.

## Diagnostic tools (`npm run <script> -w server -- args`)
`report:live` (running engine: lanes, gates + wear, fans/CO, unreachable, feed - use DURING a
run) · `report:penalties [min]` (each penalty with the car's events/commands) ·
`report:level [HH:MM HH:MM]` (classes, signatures, routes, CO, failures, time fields) ·
`report:window HH:MM:SS HH:MM:SS [YYYY-MM-DD]` (every event + command) · `report:routes`
(entry -> zone gates from the level files) · `report:speed HH:MM HH:MM` (speed estimator
replay) · `discover` (list-* snapshot, once per level) · `report:gaps` · `report:plate "ABC 123"`
· `report:gates` · `report:turnaways` · `report:timeline`. For ad-hoc DB analysis write a
.mjs script in the scratchpad using `createRequire(<repo>/server/package.json)` for
better-sqlite3 (PowerShell mangles inline `node -e`; single-quoted PowerShell strings do NOT
expand `r`n; `"`n"` inside double quotes becomes a newline).

## Simulator facts (all have tests)
- `127.0.0.1`, never `localhost`. Webhooks at-most-once, can reorder.
- Level 1 unsigned; **Level 2 signs everything** (md5 of values sorted by key, joined "|").
  **payment_made with a bad signature = the spec's fake payment**: never release for it; ask
  the car to pay again (up to 3 times - some cars fake twice; re-asking was never fined).
- **Game speed** changes live and the game can pause. All timings are `*GameS` on GameClock:
  speed from stays (planned/real) and from gate move timing (0.03 s + ~0.5 game-s per move;
  moves < 0.055 s are ignored, speed clamped 0.2-12, a change needs two windows); the clock
  stops after 20 s with no webhook.
- The sim **drops some gotos** - re-sent after 4 game-s (entry, exit, turn-away).
- An `open` sent while a gate is closing is ignored (re-sent on Closed).
- Charge ~1.5 game-s after exit CarIn (too early = "should be charged at the exit"; the delay
  learns +0.5 per such penalty per exit). Bill = planned minutes. Never charge twice.
- A car sent to an occupied spot is fined and parks anyway (spots hold a set of occupants).
- **Parts break by use**: gates on their 10th opening (10/10), spots ~12 visits; broken repair
  ~2.3 min, preventive repair 8-35 s and no fine. Operating/repairing a broken, under-repair or
  in-use part is a penalty.
- **Level 2 map:** one one-way road down the west side with gate1, gate3, gate5 across it in
  series; each zone branches off after its gate; each zone has its own exit (gate2, gate4,
  gate6). ENTRY1 -> ZONE2 needs gate1+gate3 and drives over the ENTRY2 sensor. Entrances never
  reach zones above them. Path Direction: 0 = From->To, 1 = To->From, 2 = both. In all runs so
  far every car arrives at ENTRY1 (~1/3 each Normal/Electric/Accessible).
- **No carbon_monoxide_event webhook has ever arrived** (even while fining "High CO gas level
  detected" 30 each) - CO is read with list-zones.
- Level 2 is NOT saved: a simulator restart gives new parts (usage reset on fresh start).
- ServerDateTime is the wall clock (x1.00) - there is NO day/night information in any event.
- Cars at an exit sensor drive out through an open exit gate (paid or not); cars at an entry
  never move without our goto (7,124 entries checked), so entry gates can stay open.

## Level 2 status (all on miro_level2, verified live unless noted)
- Signed webhooks: `GPA_SIGNATURE_MODE` strict|lenient|monitor; rejected ones stored + logged.
- Component health: every gate/spot/fan/light tracked, usage persisted, broken parts repaired
  as soon as unused, preventive repair before the breaking use (limit learned from breakdowns;
  early when idle at 80%, spots only if the zone has spare room); never opens a worn/broken
  gate; `resume()` restarts waiting cars after a fix. Dashboard card + `GET /api/components`.
- Gates: entry/route gates held open 10 game-s across a stream of cars; exit gates close
  1.5 game-s after each car; `closeForgottenGates()` closes any idle open lane gate.
- Routes + zone distribution: `zone_balanced` spreads cars over reachable zones (load, home
  preference, exit-gate wear/health, extra route gates, spot type, least-worn spot). Decision
  from data: exit gates carry the per-car wear (gate2 247 openings/31 repairs vs entry gate1
  169 openings for 802 cars), so spreading zones spreads it. Fill-zone-1-first =
  `lane_zone_then_any`.
- Fans (`environment.ts`): per zone on at CO >= `coFanOnLevel` (50), off below `coFanOffLevel` (40 since 8e94c38); list-zones polled every
  15 game-s only while there is traffic or a fan runs; a CO penalty forces fans on.
- Fake payments: counted (`counters.fake_payments`), re-charged up to 3x, never released.
- Latest validated run (04:23-04:55, speeds x1.7-x5.8): no occupied-spot, CO or charge-timing
  penalties; 0 gate breakdowns (all repairs preventive); only penalties were 3 cars that faked
  twice (fixed after that run: up to 3 re-asks - not yet verified live).

## Lights (`environment.ts`, done - not yet verified live)
Rule is movement, not occupancy: a full car park with nobody driving needs no light, one car
crossing an empty one does. Want = night && a car is driving in that zone.
- **Night**: no event carries the simulator time of day (ServerDateTime is the wall clock), so
  it is the configured window `nightStartHour` 18 .. `nightEndHour` 6, read off the latest
  event hour. `lightsMode` auto|always|never.
- **What is lit** (`lightsDetail`): `route` (default) lights only what a car uses - the middle
  aisle of its zone, plus the bay light over the spot it is heading for; a car leaving lights
  the aisle only. `group` sends one command per zone (all ten). Route needs light positions:
  `placementFromLevelsDir()` in topology.ts reads `Lights[]` + `ParkingSpots[]` from the level
  file and calls a light "road" when it sits between the zone two rows of bays - verified
  against the real lvl2.json: ZONE1 4 road/6 bay, ZONE2 3/7, ZONE3 4/6. Without the level
  file it falls back to group.
- **Holds**: a light stays on `lightsHoldGameS` (20) after the last car needed it so a stream
  does not flicker it; if nothing moves anywhere for `lightsIdleOffGameS` (300) every light
  goes off regardless, holds cleared - that also catches a dropped command.
- A group command operates every light in the group including a broken one (a penalty), so a
  group with a part out of service is switched light by light instead.
- On-time is usage in game hours, like fans. Snapshot: `subsystems.environment.lights`
  {on,total,mode,detail,night,hour,reason} + per-zone lights_on/lights.
- Tests: `test/components.test.ts` describe "lights" (11), `test/lights.test.ts` (6 geometry).
- **Manual control** (like gates): `POST /api/control/devices/(fan|light)/:name/(on|off|auto)`,
  operator+, audited as `fan.on` etc. On/Off take a part out of automatic control until
  Automatic hands it back; holds live in `Environment.holds` and show in
  `subsystems.environment.holds`. Dashboard: "Fans & lights" card on the Equipment page with
  On/Off/Automatic per part plus "Return all N to automatic". A hold *on* always stands (an
  idle fan only costs wear), but a fan held OFF is refused - and released if it is already
  held - while its zone is above the CO level: that is the "High CO gas level" penalty.
  Routing: `Subsystem.control()` returns null for parts it does not own, so the controller
  offers the command to each subsystem in turn (gates and spots stay on the controller).
- **Repair**: fans repair normally (`/exhaust-fans/{n}/repair`), refused while running.
  **Lights cannot be repaired at all** - probed live 2026-09-20: `/lights/{n}/repair`,
  `/lights/group/{g}/repair` and `/lights/{n}/fix` all 404 while the fan one answers 201.
  So "Report fault" on a light raises an open `light_fault` incident (one per light, audited
  as `light.fault_reported`) instead of inventing a command. Both buttons live in the
  Fans & lights card and in the Equipment health table.
- Names mean nothing: lights are `t_0..t_11` and `light13..light41`, fans `f_0/f_1` and
  `fan0..fan9` - two naming batches from the level editor. The level file's `LightType`
  agrees exactly with our geometry: every `Spot` light is an aisle light, every `Wall` one
  is over the bays (30/30 on lvl2).
- **A group command is all-or-nothing**, so it cannot say "all on except this one": while a
  whole group was switched together it undid an operator's hold on the very next tick, and a
  light could not be switched at all from the dashboard (found 2026-09-20 in the audit log -
  `light.off t_0` ok, light back on seconds later). The group command is now only sent while
  every light in the group is usable and wants the same state; otherwise they go one by one.
  An ungrouped light (`group: ""`) is switched individually too - it used to be skipped.
- Reporting a light faulty also opens a `waiting_for_clearance` maintenance job, so the work
  shows on the Maintenance page. Without it the button changed nothing an operator could see.
- **Still to do**: show it in `tools/live.ts`; verify live at night
  (or with `GPA_LIGHTS_MODE=always`) that the right lights follow the cars.

## Other open items
- Team split: B environment (lights), C RBAC (enforce ROLE_PERMISSIONS: repair +
  reports.financial), login attempts table + last 3 after login, audit log, rejected-webhook
  page; D penalties page, components page, daily/financial reports, presentation.
- Manual-parked-car scenario (car appears at an exit with no record): currently "adopted" and
  billed from the event's planned minutes / 1 minute. Decide a policy (flag, keep gate shut,
  flat/max fee or operator-entered amount, audit entry, operator override).
- `controller.ts` still has `#region agent log` blocks posting to 127.0.0.1:7502 (from another
  debugging tool) - remove when nobody needs them.

## Working conventions
- Don't commit or push unless asked; branch off `main` for new work.
- Comments explain *why*, citing the run that found the bug; settings go in `config.ts` +
  `.env.example`; every simulator quirk gets a test; verify with live data (`report:*`).
- Never hardcode timing in real seconds: add a `*GameS` setting.
- Windows: PowerShell 5.1; files use CRLF (git autocrlf).

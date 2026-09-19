# track2_parking_sys

Grand Park Auto control centre (IoT hackathon, Track 2).
TypeScript · Fastify · React/Vite · SQLite, as an npm workspace.

> The Python prototype this was ported from lives on branch `miro_testing`.

## Setup

Requires Node 22+ (developed on 24).

```
npm install
copy .env.example .env      (optional - only to override defaults)
```

In the simulator's `settings/settings.json` set:

```
"WebhookUrl": "http://127.0.0.1:8000/webhook"
```

Use `127.0.0.1`, not `localhost`: on Windows `localhost` adds ~2 s to every call.
The simulator only reads its settings at startup.

Point the server at that same settings folder in your `.env`, so it knows the game speed
from the first car:

```
GPA_SIM_LEVELS_DIR=C:/path/to/ParkingSimulator-win-x64/settings
```

Choose the first admin's password before the first start (otherwise one is generated and
printed once in the server log):

```
GPA_ADMIN_PASSWORD=something-long
```

## Run

1. Start the server first, so no arriving car goes unseen: `npm run dev`
2. Start a level in the simulator. The server detects which level is loaded and picks
   the matching `topology/*.json`; restarts and level switches are picked up automatically.
3. Dashboard: `npm run dev:web` and open http://localhost:5173 - or `npm run build` once and
   the server serves it at http://127.0.0.1:8000 itself.

For a local simulator run from Git Bash, use `npm run dev:sim`. It starts the configured
`ParkingSimulator.exe`, captures its output in `logs/simulator.log`, and runs the backend
with output captured in `logs/server.log`. Select Level 2 and press Start in the simulator
window; the simulator does not expose a REST command for choosing a level.

> **Never run the live server in watch mode.** `npm run dev:watch` restarts the server on
> every source change; each restart during a run loses the webhooks sent while it is down.
> A restart in the middle of a run is survivable (the server replays its recent events *and*
> commands), but it is not free. Use `npm run dev` / `npm start` for simulator runs.

Forgot the admin password? `npm run user:password -w server -- admin "new password"`.

## Dashboard & roles

Sign in with a dashboard account (the admin creates the others under **Admin**).

| | Operator | Admin |
|---|:-:|:-:|
| **Overview** - occupancy, zones, gates, entry queue, cars inside, live activity | ✓ | ✓ |
| **Operations** - hold a gate open/closed, return it to automatic, start gate/spot maintenance | ✓ | ✓ |
| **Logs** - search visits (arrival, parking time, departure, charges), simulator events, commands | ✓ | ✓ |
| **Statistics** - traffic, revenue, outcomes, stay lengths, spot usage, penalties, gate cycles, command health | ✓ | ✓ |
| **Equipment** - CO safety, zone restrictions, component health and usage | ✓ | ✓ |
| **Maintenance** - preventive, breakdown and uncertain-outcome repair jobs | ✓ | ✓ |
| **Incidents** - unresolved exceptions, evidence and audited resolution | ✓ | ✓ |
| **Penalties** - accepted simulator penalties and fine evidence | ✓ | ✓ |
| **Reports** - dynamic daily operations reports; financial reports/export | ✓ | ✓ |
| Close / reopen an entrance | | ✓ |
| **Admin** - users (create, role, disable, reset password), resync, audit trail, configuration | | ✓ |

- Every permission is enforced by the server; the dashboard only hides what a role cannot use.
- Level 2 automatically switches to strict signed-webhook intake when an `lvl2`/`lvl3` topology is loaded;
  rejected deliveries remain in the raw event log and do not affect occupancy, revenue, penalties or reports.
- A manual/unknown visit is held at the exit until an operator records duration evidence or an admin authorizes
  an adjustment/emergency release. Invoice intent and uncertain simulator command outcomes survive restart.
- Manual commands the simulator would penalise are refused with the reason: operating a
  broken gate, repairing an occupied spot or a gate a car is passing.
- A held gate stays as the operator left it until **Automatic** hands it back.
- Every manual command is stored with who sent it (Admin → Audit trail).
- Sessions: HttpOnly, SameSite=Strict cookie; only a hash of the token is stored; passwords
  are scrypt-hashed; repeated failed sign-ins are throttled. Changing a user's password,
  role or disabling them signs them out everywhere.

| API | Role |
|---|---|
| `POST /api/auth/login`, `/logout`, `GET /api/auth/me` | - |
| `GET /api/state`, `/api/stream` (server-sent events), `/api/timeseries`, `/api/stats?minutes=` | operator |
| `GET /api/sessions`, `/api/events`, `/api/actions` (`?plate= &status= &class= &since= &before=`) | operator |
| `GET /api/equipment`, `/api/maintenance`, `/api/incidents`, `/api/penalties`, `/api/auth/login-attempts` | operator |
| `POST /api/equipment/:id/maintenance`, `/api/incidents/:id/resolve`, unknown-visit review | operator |
| `GET /api/reports/daily` (operations) and `/api/reports/daily/export` | operator |
| `POST /api/control/gates/:name/(open\|close\|auto\|repair)`, `/api/control/spots/:name/repair` | operator |
| `POST /api/control/entries/:spot/(open\|close)`, `/api/resync`, `GET /api/config`, `/api/users` (+ `POST`, `PATCH /:id`) | admin |
| Financial daily reports/export, visit adjustments, emergency releases, audit and security login history | admin |
| `POST /webhook` | public (the simulator) |
| `/debug/*` | this machine, or an admin |

## Scripts (repo root)

| Command | What |
|---|---|
| `npm run dev` | server for simulator runs |
| `npm run dev:sim` | start the local simulator and server, capturing both logs under `logs/` |
| `npm start` | server |
| `npm run dev:web` | dashboard dev server (proxies `/api` to the server) |
| `npm run build` | build the dashboard into `web/dist` |
| `npm test` | controller, webhook and HTTP tests against a fake simulator |
| `npm run test:level2` | focused Level 2 acceptance suite |
| `npm run simulate:level2` | unattended deterministic Level 2 replay; writes `logs/level2-acceptance.log` |
| `npm run typecheck` | typecheck every package |
| `npm run smoke` | live check: API both ways + webhook delivery (`-- --gates` to cycle a gate) |
| `npm run single-car` | drive one car by hand (server must run with `GPA_CONTROLLER_ENABLED=false`) |
| `npm run topology -- --levels-dir "<sim>/settings"` | regenerate `topology/*.json` from the simulator's layouts |
| `npm run fake-sim -w server` | a stand-in simulator API on :9899 for dashboard work (`GPA_SIM_BASE_URL=http://127.0.0.1:9899/api/v1`) |
| `npm run report:gates \| report:turnaways \| report:gaps \| report:timeline -w server` | reports from the database |
| `npm run report:plate -w server -- "ABC 123"` | one plate's full history |

Dashboard chart gallery (no server or sign-in needed): run `npm run dev:web` and open
http://localhost:5173/gallery.html - every chart rendered from `web/dev-fixtures` (a real run).

## Configuration

All settings are in `server/src/config.ts` (zod schema: typed, validated, with defaults
and a comment each). Override them in `.env` or as environment variables with the `GPA_`
prefix, e.g. `GPA_BILLING_ROUNDING=ceil`. See `.env.example`.

Simulator strings (event classes, spot purposes, penalty texts...) are defined once in
`shared/src/protocol.ts`. Which gate serves which entry/exit is in `topology/*.json`,
one file per level.

## Layout

| Path | What |
|---|---|
| `shared/src/protocol.ts` | every literal the simulator sends or expects, and its payload shapes |
| `shared/src/api.ts` | our HTTP API types - server and dashboard both compile against them |
| `server/src/controller.ts` | car park logic: per-lane entry queues, gates, billing, payments, recovery |
| `server/src/components.ts` | Level 2 health, usage counters, preventive maintenance and repair recovery |
| `server/src/environment.ts` | zone CO/fan control, night lighting and admission restrictions |
| `server/src/topology.ts` | discovers entry/exit lanes and pairs them with gates |
| `server/src/allocation.ts` | spot allocation strategies (`GPA_ALLOCATION_STRATEGY`) |
| `server/src/billing.ts` | parking charge rules |
| `server/src/store.ts` | SQLite: event inbox, visits, commands, components, invoices/payments, incidents, audit and login history |
| `server/src/webhook.ts` | webhook parsing, signature check, dedupe, sequence tracking |
| `server/src/simClient.ts` | simulator REST API client |
| `server/src/app.ts` | Fastify routes |
| `server/test/` | Vitest suites |
| `server/tools/` | live tools (smoke test, single-car diagnostic, topology builder) |
| `web/` | React dashboard (starter) |
| `topology/` | one layout file per level |
| `data/` | runtime: SQLite database (git-ignored) |

## Simulator behaviour the controller relies on

Learned from live runs; each has a test in `server/test/controller.test.ts`.

- Level 1 webhooks are unsigned (`Signature: null`); the MD5 check is ready for later levels.
- `detectedCars` in `list-parking-spots` is a count, not a list of plates.
- Parked cars drive to an exit on their own; we never send `goto exit`.
- Charging the instant a car reaches the exit is rejected - wait ~1.5 s.
- The simulator checks the bill against the **planned** minutes, so billing is right at
  any game speed.
- Webhook timestamps are wall-clock, but cars, gates and sensors move in game time, and the
  speed can change while the simulator runs (Shift+PgUp). Every timer and timeout that
  waits on the simulator is set in **game seconds** (`*_GAME_S`) and measured on a game clock
  (`server/src/gameClock.ts`) that runs at the current speed and **stops while the game is
  paused** (no webhook for `GPA_PAUSE_AFTER_SILENCE_S`). The speed is `GPA_GAME_SPEED` if
  set; else read from gate timing right after a change (a barrier move takes a fixed ~0.5
  game-s, so its real duration reveals a new speed within a few gate cycles); else learned
  from completed stays; else `GameSpeedMultiplier` from `settings.json`; else 1.0.
  `/api/state` shows it as `time_scale` and `time_scale_source`;
  `npm run report:speed -w server -- 21:00 21:30` replays a run through the estimator.
- **Level 2: parts break by themselves** (gate1 broke a minute into the first run, fine 20).
  Operating or repairing a broken, under-repair or in-use part is a penalty, so the
  controller never opens a gate that is not ok, and `server/src/components.ts` repairs every
  broken gate, spot and fan as soon as nothing uses it (`GPA_AUTO_REPAIR`), then resumes
  whatever waited on it. Usage and breakdown history are stored (`components`,
  `component_events`), served at `GET /api/components` and shown on the Operations page.
  New features plug in through `server/src/subsystems.ts` instead of growing controller.ts.
- The simulator acknowledges every `goto` but **silently drops some** (~15% of those sent
  while another car's event fires). The car just sits on its sensor, holding its lane and
  open gate. A car that has not driven off `GPA_GOTO_CONFIRM_GAME_S` after its goto gets
  it again (entry dispatch, exit release and turn-away alike), up to `GPA_MAX_GOTO_RESENDS`
  times. Unconfirmed gate opens and closes are re-sent too.
- From a spot next to the exit, the exit `CarIn` arrives ~0.2 s *before* the spot `CarOut`.
- An `open` sent while a gate is still closing is silently ignored.
- The simulator autosaves cars into its `lvl*.json` and reuses plates across restarts.
- Spots beyond the exit sensor (S15, S30 on Level 1) are reached by driving over it: a car on
  its way in fires exit CarIn/CarOut before it parks. These are ignored while a car is still
  driving in.
- A car sent to an occupied spot is fined *and parks there anyway*, so a spot can hold two
  cars. Spots track every car in them, and an "occupied spot" penalty marks the spot taken
  and redirects the car to a free one.
- Level 2 zones are enclosed: `lane_zone_first_free` deliberately allocates only inside
  the zone belonging to the entry lane. The supplied simulator `settings/lvl2.json` has
  three entry sensors but its car emitters are `A -> P2` and `39 -> 45`; it does not
  generate traffic at `ENTRY2` or `ENTRY3`. That is why a run can show Zone 1 traffic
  only. Do not change to a cross-zone allocator unless the simulator routes are verified
  reachable; otherwise cars sent across the enclosure receive reachability penalties.
- Webhooks are at-most-once and can arrive out of order (a Level 1 run: 1 of 3,406 lost,
  7 reordered), and a simulator restart makes cars vanish without events. Car records
  whose closing event never arrives are retired: when another car parks in their spot,
  when they reach an exit, or after a timeout (`GPA_RELEASE_TIMEOUT_GAME_S`,
  `GPA_PARKED_OVERSTAY_GAME_S`, `GPA_STALE_CAR_GAME_S`). A lost exit event can therefore
  never hold an exit gate open. Retired records count as `ghosts_retired` and are stored
  with status `lost`. `npm run report:gaps -w server` shows silences and lost events.

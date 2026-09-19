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
| **Components** - broken/worn components, usage cycles, CO per zone, lights & fans | ✓ | ✓ |
| Tune CO thresholds, daylight window and service intervals live (Components → Control settings) | | ✓ |
| **Logs** - search visits (arrival, parking time, departure, charges), simulator events, commands | ✓ | ✓ |
| **Statistics** - traffic, revenue, outcomes, stay lengths, spot usage, penalties, gate cycles, command health | ✓ | ✓ |
| Close / reopen an entrance | | ✓ |
| **Admin** - users (create, role, disable, reset password), resync, audit trail, configuration | | ✓ |

- Every permission is enforced by the server; the dashboard only hides what a role cannot use.
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
| `POST /api/control/gates/:name/(open\|close\|auto\|repair)`, `/api/control/spots/:name/repair`, `/api/control/devices/(light\|fan)/:name/(on\|off\|auto\|repair)` | operator |
| `POST /api/control/entries/:spot/(open\|close)`, `/api/resync`, `GET /api/config`, `/api/users` (+ `POST`, `PATCH /:id`), `GET/PATCH /api/settings`, `DELETE /api/settings/:key` | admin |
| `POST /webhook` | public (the simulator) |
| `/debug/*` (incl. `/debug/signature`, `/debug/ventilation`) | this machine, or an admin |

## Scripts (repo root)

| Command | What |
|---|---|
| `npm run dev` | server with reload on change |
| `npm start` | server |
| `npm run dev:web` | dashboard dev server (proxies `/api` to the server) |
| `npm run build` | build the dashboard into `web/dist` |
| `npm test` | controller, webhook and HTTP tests against a fake simulator |
| `npm run typecheck` | typecheck every package |
| `npm run smoke` | live check: API both ways + webhook delivery (`-- --gates` to cycle a gate) |
| `npm run probe:lvl2 -w server` | read-only Level 2 discovery: lights, fans, zones, day/night and wear fields, unassigned gates |
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
| `server/src/topology.ts` | discovers entry/exit lanes and pairs them with gates |
| `server/src/allocation.ts` | spot allocation strategies (`GPA_ALLOCATION_STRATEGY`) |
| `server/src/components.ts` | usage cycles, preventive maintenance arithmetic, CO hysteresis, daylight |
| `server/src/billing.ts` | parking charge rules |
| `server/src/store.ts` | SQLite: `events`, `sessions`, `actions`, `component_wear`, `runtime_settings` tables |
| `server/src/webhook.ts` | webhook parsing, signature check, dedupe, sequence tracking |
| `server/src/simClient.ts` | simulator REST API client |
| `server/src/app.ts` | Fastify routes |
| `server/test/` | Vitest suites |
| `server/tools/` | live tools (smoke test, single-car diagnostic, topology builder) |
| `web/` | React dashboard (starter) |
| `topology/` | one layout file per level |
| `data/` | runtime: SQLite database (git-ignored) |

## Components: wear, maintenance, air and light (Level 2)

Gates, parking spots, lights and exhaust fans are tracked as one set of components
(`server/src/components.ts`, **Components** in the dashboard).

- **Usage cycles** are counted per component and persisted in `component_wear`, because
  preventive maintenance decides on cumulative wear and a restart mid-run must not reset
  the service clock. A gate cycle is one *confirmed open* (counting the close as well would
  double every gate's wear for one use); a spot cycle is one car parked; a light or fan
  counts on/off switches and accumulates on-time in game seconds.
  Replayed events are **not** counted again - the book already holds them, and counting
  during replay doubled every figure.
- **Broken components are repaired automatically** as soon as the simulator reports them
  (`GPA_AUTO_REPAIR_BROKEN`), ahead of any preventive work and regardless of the per-zone
  budget: nothing a broken component serves works until it is fixed. A broken gate is
  therefore always repairable, by hand too - only a car *crossing a working gate* blocks a
  repair. (Treating a waiting queue as "in use" deadlocked a broken entry gate: the queue
  could only drain through the gate that was broken, so the repair was refused forever.)
  The only in-use rule the spec actually states is `Penalty_RepairAnOccupiedSpot`.
- **Preventive maintenance** repairs what is past its service interval, worst-worn first,
  but only while the component is idle: repairing a gate a car is passing or an occupied
  spot is itself a penalty. `GPA_MAINT_MAX_CONCURRENT_PER_ZONE` limits how many components
  *we* take out of service in a zone at once; components that are already broken do not
  count, or one stuck failure would veto preventive work in its zone forever.
- **A fan with no zone serves the whole park** and follows any zone that needs ventilation.
  The simulator really does report zoneless components - its own `list-exhaust-fans`
  example is `"name": "fan0", "zoneParent": ""` - and treating those as unmatched meant a
  fan that could never be switched on however high CO went. Zone names are matched
  case- and whitespace-insensitively for the same reason.
- **Clicking On or Off takes a device out of automatic control** until *Automatic* hands
  it back - the same contract gates have, so a manual decision is not undone a second
  later. It is easy to do by accident while testing and then puzzling (the CO and daylight
  rules appear to stop working), so the Components page shows a banner naming every held
  device and a one-click "Return all to automatic".
- **A hold can never keep a fan off while its zone is polluted.** Ventilation is a safety
  function: `Penalty_ZonePollutedWithHighCO` fires when a zone is high and the fans are
  not running, and nothing used to reconsider a hold, so one forgotten click caused that
  penalty for the rest of the run. Switching a fan off is now refused while its zone is
  above the threshold, and a hold taken while the air was clean is released (loudly) if the
  zone later goes bad. A hold *on* always stands - an idle fan only costs usage cycles.
- **Ventilation and lighting are re-asserted on every tick**, not only when a CO reading
  crosses a threshold. A transition gives a fan exactly one chance to be switched, and
  anything that blocked that one attempt (the fan momentarily broken, a dropped command,
  a sync still in flight) left it wrong until the *next* crossing - which with a low stop
  threshold may never come, because a busy zone simply stays above it. Re-asserting is
  cheap: a device already in the wanted state costs nothing.
- **`GET /debug/ventilation`** walks the whole chain and names where it stops: fans
  discovered, CO events seen, zones wanting ventilation, and per fan whether it should be
  on and what is blocking it.
- **Every device says why it is in its current state** (`reason` on `/api/state`, shown
  under each device on the Components page): broken, held, no reading for its zone, below
  the threshold, or extracting. "Off" alone does not say which of those applies.
- **`GPA_MAINT_MAX_AGE_S`** services every component a fixed time after its last repair,
  whatever its usage. Off by default (the simulator breaks things by usage, not age), but
  set it to 60 to watch the whole maintenance loop run during a test without driving
  hundreds of gate cycles first.
- **The simulator only sends `carbon_monoxide_event` at Mid (~50) and above.** Below that
  it reports nothing, so a webhook-only system cannot see a zone at 5, 20 or 40 - and a
  threshold set under Mid can never fire, however it is configured. `GPA_ZONE_POLL_GAME_S`
  polls `GET /list-zones` (which carries `gasCarbonMonoxideLevel` and `risk` for every
  zone) to read those levels directly, and doubles as a safety net when a CO webhook is
  lost. On by default (every 10 game-s). The docs say to call list-* only at load or after a crash, which is right for spots, barriers, lights and fans - those change only when something breaks, and a webhook says so. CO is the exception: it changes continuously, the only push arrives at Mid and above, and an unventilated zone is a penalty. Set 0 to rely on webhooks alone.
- **Carbon monoxide** drives that zone's exhaust fans, with hysteresis: on at
  `GPA_CO_ON_PPM`, off only below `GPA_CO_OFF_PPM`. One threshold makes the fans chatter
  around the boundary, and every flip is a usage cycle.
- **Lights** follow a daylight window read from the `ServerDateTime` on events - no endpoint
  is known to report the simulator's in-world hour. If `npm run probe:lvl2 -w server` turns
  up a real daylight field on a Level 2 map, drive the lights from that instead.
- A sync takes the simulator's word for every device's state and then re-asserts what the
  air and daylight need, since those loops otherwise only act on a transition.
- Lights and fans are optional throughout: a level that reports none simply never ventilates
  or switches lights, and nothing else changes.

## Simulator behaviour the controller relies on

Learned from live runs; each has a test in `server/test/controller.test.ts`.

- Level 1 webhooks are unsigned (`Signature: null`); the MD5 check is ready for later levels.
  Level 2 signs them, so set `GPA_REQUIRE_SIGNATURE=true`. The scheme (MD5 over every
  non-`Signature` value, sorted by field name, joined with `|`) matches the documented
  worked example but has never met a live signed event, so switching it on is guarded:
  until one signature verifies, `GPA_SIGNATURE_GRACE_N` failing events are still processed
  and flagged rather than dropped, and any other known scheme that reproduces the digest
  is adopted automatically. `GET /debug/signature` shows the scheme in use, the grace left
  and — for each failure — the exact text that was hashed next to the digest received.
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
- Webhooks are at-most-once and can arrive out of order (a Level 1 run: 1 of 3,406 lost,
  7 reordered), and a simulator restart makes cars vanish without events. Car records
  whose closing event never arrives are retired: when another car parks in their spot,
  when they reach an exit, or after a timeout (`GPA_RELEASE_TIMEOUT_GAME_S`,
  `GPA_PARKED_OVERSTAY_GAME_S`, `GPA_STALE_CAR_GAME_S`). A lost exit event can therefore
  never hold an exit gate open. Retired records count as `ghosts_retired` and are stored
  with status `lost`. `npm run report:gaps -w server` shows silences and lost events.

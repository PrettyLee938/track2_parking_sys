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

## Run

1. Start the server first, so no arriving car goes unseen: `npm run dev`
2. Start a level in the simulator. The server detects which level is loaded and picks
   the matching `topology/*.json`; restarts and level switches are picked up automatically.
3. Dashboard (optional): `npm run dev:web`, then open http://localhost:5173

| URL | What |
|---|---|
| http://127.0.0.1:8000/api/state | live state (what the dashboard renders) |
| http://127.0.0.1:8000/api/sessions?plate=ABC | finished visits from the database |
| http://127.0.0.1:8000/debug/config | effective settings |

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
| `npm run single-car` | drive one car by hand (server must run with `GPA_CONTROLLER_ENABLED=false`) |
| `npm run topology -- --levels-dir "<sim>/settings"` | regenerate `topology/*.json` from the simulator's layouts |

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
| `server/src/billing.ts` | parking charge rules |
| `server/src/store.ts` | SQLite: `events`, `sessions`, `actions` tables |
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
- Webhook timestamps are wall-clock, but cars, gates and sensors move in game time. Every
  timer that waits on the simulator (gate close, billing delay, gate/dispatch timeouts,
  silence detection) is set in **game seconds** (`*_GAME_S`) and converted with the current
  game speed: `GPA_GAME_SPEED` if set, else learned from completed stays (follows
  Shift+PgUp), else `GameSpeedMultiplier` from the simulator's `settings.json`, else 1.0.
  `/api/state` shows it as `time_scale` and `time_scale_source`.
- From a spot next to the exit, the exit `CarIn` arrives ~0.2 s *before* the spot `CarOut`.
- An `open` sent while a gate is still closing is silently ignored.
- The simulator autosaves cars into its `lvl*.json` and reuses plates across restarts.

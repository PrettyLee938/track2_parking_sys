# Cleanup progress

## Findings

- The repository is an npm workspace with three packages: `shared`, `server`, and `web`.
- The simulator-facing server is the source of truth for parking behavior. Webhooks enter `Controller.submit`, are serialized by `SerialQueue`, and become state transitions, simulator commands, feed items, and persisted records.
- `server/src/controller.ts` was 1,266 lines and mixed domain state, startup/replay, event routing, entry/exit flows, gates, billing, penalties, timers, manual controls, and snapshots.
- `server/src/store.ts` was 427 lines and mixed schema/migrations, event/session/action queries, statistics, and users/auth sessions.
- `web/src/components/charts.tsx` was 269 lines and mixed shared tables, chart math, SVG charts, and stacked bars.
- Tests cover the controller, webhook intake, and authentication. Current baseline: 81 tests pass and all three workspace type checks pass.
- The branch also has untracked local artifacts from earlier work (`.agents`, `.scratch`, `graphify-out`, `skills-lock.json`, and `src`). They are not part of this cleanup and will not be deleted.

## Refactoring approach

1. Extract stable domain models and clock helpers without changing behavior.
2. Split controller orchestration from feature handlers: startup/replay, entry/parking, exit/billing, recovery/penalties, controls, and presentation snapshots.
3. Split persistence by responsibility behind the existing `Store` interface.
4. Split dashboard chart primitives into focused modules.
5. Split tests by behavior and keep every TypeScript/TSX/CSS source and test file below 200 lines.
6. Run tests, type checks, and the web build after every meaningful step.

## Changes made

- Added `server/src/parking/clock.ts` for simulator timestamps, integer parsing, and median/time helpers.
- Added `server/src/parking/state.ts` for `Spot`, `Gate`, lane records, car records, timers, and public-car projection.
- Added `server/src/parking/timeScale.ts` for game-speed precedence, learning, and simulator-settings refresh.
- Added `server/src/parking/readModel.ts` for zone summaries, occupancy sampling, and dashboard snapshots.
- Added focused parking modules for commands, gates, controls, entry/exit flows, event routing, penalties, recovery, timers, sync, replay, lifecycle, and controller state.
- Split HTTP registration into `server/src/routes/` by webhook, auth, state, logs, controls, admin, and debug/static serving.
- Split SQLite schema, statistics, and user/session persistence into `server/src/storage/`; `Store` remains the stable facade used by the app and controller.
- Split shared API contracts by state, auth, control, and logs/statistics; `shared/src/api.ts` remains a re-export facade.
- Split dashboard charts and styles into focused files while preserving the existing import paths.
- Split controller and HTTP tests into eleven behavior-focused files; all source and test files now stay under 200 lines.
- Added a dependency-free `npm run lint` check for the file-size invariant, trailing whitespace, and generated shell-literal artifacts.
- Kept `server/src/controller.ts` as the compatibility facade for the existing `Controller` interface and tests.

## Verification

- Baseline recorded before refactoring: `npm test` (81 passed), `npm run typecheck` (shared/server/web passed).
- After all extractions: `npm.cmd install` (lockfile up to date), `npm.cmd run lint` (clean), `npm.cmd test` (81 passed across 11 files), `npm.cmd run typecheck` (shared/server/web passed), `npm.cmd run build` (Vite production build passed), and `git diff --check` (clean).
- The Windows `npm` failure was PowerShell selecting the blocked `npm.ps1`; `npm.cmd` is the working command on this machine.

## Remaining

- Cleanup implementation and verification are complete; the remaining untracked local artifacts are intentionally untouched.

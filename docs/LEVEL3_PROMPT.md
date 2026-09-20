# Devin prompt — Level 3

Paste the block below into Devin as the task. It assumes Devin has the repo and can read
`docs/LEVEL3_CONTEXT.md`. Adjust the branch names if yours differ.

---

## The prompt

> **Project:** Grand Park Auto — a Node/TypeScript control system for a simulated car park
> (hackathon Track 2). Repo: `track2_parking_sys`, npm workspaces (`shared`, `server`, `web`),
> Node >= 22.
>
> **First: read `docs/LEVEL3_CONTEXT.md` in the repo, completely, before writing any code.** It
> describes the architecture, the simulator's contract, the Level 3 map, and exactly what
> already exists for each requirement. Then read `CLAUDE.md`, `server/src/controller.ts`,
> `server/src/components.ts`, `server/src/webhook.ts`, `server/src/app.ts` and
> `server/test/helpers.ts`. Do not restate the context back to me — start from it.
>
> **Branch:** create `level3` from `miro_level2_integrated`. Open one PR per work item below,
> in the order given; do not bundle unrelated work.
>
> **Setup and verification (this is the only verification available to you):**
> ```
> npm install
> npm run typecheck     # must stay clean across all three workspaces
> npm test              # vitest; 142 tests pass today and must keep passing
> ```
> You **cannot run the Parking Simulator** — it is a Windows app on my machine, so no live
> webhooks and no REST API. Everything you build must be proven with unit tests using the
> existing fake simulator harness in `server/test/helpers.ts` (extend it; do not create a
> second harness). `server/tools/fakeSim.ts` is a REST stand-in you may extend for manual
> checks of the web app.
>
> **Hard rules (the context file explains why — breaking these breaks a working system):**
> 1. All state changes stay on the single `SerialQueue`. Get throughput from cheaper handlers
>    and batched calls, never from a second writer.
> 2. No real-second timeouts. Game speed changes live; use game seconds (`*GameS`) and
>    `engine.later()`.
> 3. New behaviour goes in a new `Subsystem` file registered in `createSubsystems()`, not into
>    `controller.ts` (already 1900 lines).
> 4. Simulator strings only in `shared/src/protocol.ts`; our API types only in
>    `shared/src/api.ts`, and keep the web app compiling against them.
> 5. Every new setting lives in `server/src/config.ts` + `.env.example`, `GPA_` prefixed, and
>    **defaults to today's behaviour** so anything new can be switched off mid-run.
> 6. Same code must still run Levels 1 and 2 — behaviour comes from the level file, never from
>    a hardcoded level number.
> 7. Each fix or feature ships with tests; comments explain *why*, not *what*.
>
> **Work items, in priority order.** Section numbers refer to `docs/LEVEL3_CONTEXT.md` §7.
>
> 1. **Cleanup + burst safety (§7.6).** Delete the 8 `#region agent log` blocks in
>    `controller.ts` that `fetch()` to `127.0.0.1:7502` on every event. Add queue
>    instrumentation (depth, oldest waiting task, handler duration) to the snapshot and the
>    dashboard. Make `/webhook` acknowledge immediately and process asynchronously if it does
>    not already. Add a test: 40 cars leaving in the same tick each produce exactly one charge
>    and one release, in order, with nothing dropped.
> 2. **Webhook security + admin page (§7.7).** Add a `tampered` classification (same `EventId`,
>    different payload hash — `event_identities` already stores the hash), durable dedupe
>    across restarts, a replay window on `ServerDateTime`, and per-source rate limiting. Store
>    every rejection with its reason and payload. Build the dedicated admin page listing
>    invalid / unsigned / duplicate / tampered deliveries with filters, counters and payload
>    drill-down.
> 3. **Spot sensor abnormalities and maintenance mode (§7.2).** Detect the abnormality
>    signals listed in the context file, take the spot out of allocation, record an incident
>    with evidence and confidence plus a `maintenance_jobs` row, show it on the dashboard, and
>    return the spot to service automatically once it reads clean (or on operator action).
>    Implement it as our own soft lock; if the Level 3 API turns out to have a maintenance
>    endpoint, call it behind a flag — ask me, do not guess.
> 4. **Double-parking early warning (§7.9)** and **vehicle locator (§7.10).** Detect both
>    double-parking cases, warn before the simulator fines us where possible. For the locator:
>    one endpoint + search page returning where a car is now, where it was assigned versus
>    where it actually parked, its invoice/payment state and its event timeline
>    (`server/tools/plateHistory.ts` already assembles most of this — lift it into the store).
> 5. **Suspicious payments (§7.3).** Extend fake-payment handling to the other fraud shapes
>    (wrong amount, replayed event, two payments against one invoice, payment with no open
>    invoice, payment for a car not at an exit). One scoring place, an incident with evidence
>    for each, re-ask for payment, and never release an unpaid car.
> 6. **Gate failure resilience and zone distribution at scale (§7.1, §7.4).** Carry
>    `ZoneType` (indoor "Closed" / outdoor "Open") into the topology; make allocation aware of
>    7 zones, of dual-exit zones, and of exit-gate health; make sure the environment subsystem
>    never tries to run lights or fans in outdoor zones (they have none); add entry-side
>    failover and a visible "degraded lane" state.
> 7. **Performance and responsiveness (§7.5).** Build the snapshot once per tick and share it
>    across SSE clients, send deltas with periodic full resyncs, add ETag/304 on `/api/state`,
>    consistent pagination and caps on list endpoints, confirm SQLite WAL and indexes, cap the
>    in-memory ring buffers, and virtualise the big tables and the 250-spot grid in the web app.
>    Add `server/tools/loadTest.ts` (N webhooks/second + M SSE clients) and put **before/after
>    numbers in the PR description** — the brief explicitly asks for optimisation evidence.
> 8. **Component summary views (§7.8), reports and audit trail (§7.11).** Per-zone and per-kind
>    rollups (total / available / broken / under maintenance / due for preventive repair) with
>    drill-down; audit every new action with actor, permission, target, result and reason;
>    extend the daily report with incidents, fraud attempts, maintenance and availability per
>    zone, wear, revenue and uncollected amounts, penalties. Enforce `ROLE_PERMISSIONS` —
>    repair and financial reports are Admin-only.
>
> **Deliverable for each PR:** what changed, how you verified it, what could not be verified
> without the simulator, new settings and their defaults, and any question from
> `docs/LEVEL3_CONTEXT.md` §9 that blocked you. Update `CLAUDE.md` at the end of each PR with
> what is new and what still needs a live run.
>
> If a requirement is ambiguous, implement the conservative option (never release a car, never
> operate a part that might be broken, never drop an event) and say so in the PR.

---

## Notes for you (not for Devin)

* Devin has no simulator, so items **1, 2, 5, 7** are the ones it can finish properly on its
  own; **3, 4, 6, 8** will need one live run each from the team to confirm.
* Answer §9 of the context file for Devin as soon as you can — especially whether
  `goto <plate> <ExitSpotName>` works, since item 6 depends on it.
* Keep `GPA_SIGNATURE_MODE=strict` and re-run `report:penalties` after each merged PR; the
  penalty count is the only real score.

# Track 2 Grand Park Auto management system

## Problem Statement

The team needs a working Level 1 web-based parking management system for the Grand Park Auto simulator. The system must operate the simulator through its REST API, consume and authenticate simulator webhooks, persist the resulting operational history, and give an operator a truthful dashboard for parking, equipment, payments, incidents, and recovery.

The challenge rewards correct behavior rather than a superficial dashboard. A wrong allocation, an unsafe gate or fan action, an incorrect invoice, a duplicated payment, an unverified command result, or a fabricated payment can create penalties. The system therefore needs one deterministic control boundary that can explain every decision and recover safely when the simulator or the backend restarts.

The team is four people: Mohamad, Miro, Hashmat, and Song. The implementation must be practical to run on one Windows machine with the simulator and backend local to that machine, while still providing a browser dashboard that teammates can use over the local network.

## Solution

Build a TypeScript modular monolith that exposes a browser-facing HTTP API and SSE stream, connects to the simulator through a single `SimulatorGateway` boundary, and stores durable state in SQLite. The gateway handles simulator login, protected REST commands and reads, webhook delivery, signature verification, event deduplication, sequence handling, and reconciliation. A deterministic domain controller consumes accepted events, applies parking and safety rules, writes an append-only audit trail, and emits commands through a durable outbox.

The Level 1 baseline includes arrival and allocation, entry and exit gate flows, normal and electric parking, deterministic billing, payment validation, departure, component monitoring, maintenance and carbon-monoxide rules, event and search logging, authentication, and Admin/Operator permissions. The dashboard must distinguish desired, accepted, confirmed, pending, rejected, and unknown external actions. Simulator evidence confirms state; a successful HTTP `201` only means the simulator accepted a request.

Operators always obey the parking and equipment rules. An Admin can authorize a narrowly scoped business exception for one unpaid departure after the car is at the exit spot and an invoice exists, but the exception never bypasses equipment or occupancy restrictions and never changes the fact that payment was not received. The exception requires Admin password re-entry, a reason, explicit confirmation, one active authorization per parking session, and an append-only audit record. It is consumed only when the simulator confirms departure.

The controller automatically reconciles after reconnect and resumes only after the same simulator run, car, session, and component state are established. New commands are rejected while connectivity or run identity is unknown. If the run remains ambiguous, automation pauses until an Admin chooses to continue the reconciled run or close it and start a new run. A new run makes the old run read-only, preserves unresolved sessions and command outcomes for review, and carries no reservations, invoices, payments, or override state into the new run.

Jev from TypeSafe AI is deferred. The supplied challenge requirements do not require semantic AI, and exact event and penalty codes are safer to handle with direct mappings and deterministic rules. Jev may be added later only if real operator notes reveal a recurring ambiguous-text classification problem and a small comparison against a lookup/keyword baseline demonstrates value. It must never decide money, allocation, safety, equipment operation, payment validity, or recovery.

## User Stories

1. As an Operator, I want to sign in with an application account, so that actions are attributable to a person.
2. As an Admin, I want to seed the first account from local configuration and require a password change, so that the system has no committed default credentials.
3. As an Admin, I want to create and disable Operator accounts, so that access follows the team’s operational responsibilities.
4. As an Operator, I want my session to expire after 30 minutes of inactivity or explicit logout, so that an unattended dashboard cannot keep issuing commands.
5. As an Admin, I want a backend restart to invalidate all browser sessions, so that stale credentials cannot resume after recovery.
6. As an Operator, I want to see the current simulator run and connection state, so that stale or uncertain data cannot look live.
7. As an Operator, I want to see every parking spot with its suitability, occupancy, reservation, maintenance, and availability status, so that I can choose a legal space.
8. As an Operator, I want arriving cars and their parking-session identity shown separately from plate numbers, so that returning cars do not merge into an earlier visit.
9. As an Operator, I want the system to rank legal parking spots deterministically, so that allocation is repeatable and explainable.
10. As an Operator, I want electric cars assigned only to suitable electric-capable spots when charging is required, so that the simulator does not penalize a wrong spot type.
11. As an Operator, I want accessible requirements respected during allocation, so that an accessible car is not placed in an unsuitable spot.
12. As an Operator, I want the system to reject an occupied, broken, under-maintenance, or otherwise ineligible spot, so that a command cannot create a parking penalty.
13. As an Operator, I want an entry request to be accepted only when a legal destination, route, and gate state are available, so that the car can enter safely.
14. As an Operator, I want gate operations to respect opening, closing, and occupancy state, so that barriers are never commanded in an unsafe condition.
15. As an Operator, I want the dashboard to show a command as pending until simulator evidence confirms it, so that I do not assume a request succeeded.
16. As an Operator, I want a failed or unknown command to remain visible with its evidence, so that I can reconcile it rather than silently retrying a potentially duplicated action.
17. As an Operator, I want lights controlled according to zone and operating conditions, so that the facility meets the simulator’s lighting requirements without unnecessary commands.
18. As an Operator, I want fans controlled from zone carbon-monoxide readings and fan state, so that high CO conditions are handled without violating equipment rules.
19. As an Operator, I want broken components and maintenance state visible, so that I can avoid unsafe operations and plan repairs.
20. As an Operator, I want predictive-maintenance recommendations based on usage history, so that preventive work can be scheduled without pretending it is a repair completion.
21. As an Operator, I want a repair command to stay pending until a `component_fixed` event arrives, so that HTTP acceptance is not mistaken for physical repair.
22. As an Operator, I want an invoice calculated from the simulator-verified parking and electricity rules, so that the customer is charged the correct amount.
23. As an Operator, I want parking and electricity amounts represented exactly and rounded only at the defined billing boundary, so that floating-point error cannot create penalties.
24. As an Operator, I want payments validated against the current parking session and invoice, so that a notification for another visit cannot authorize departure.
25. As an Operator, I want duplicate, early, late, or otherwise invalid payments rejected and audited, so that the session remains truthful.
26. As an Operator, I want an exit car held until payment is validated or an explicit Admin exception is active, so that unpaid departure is never silently treated as paid.
27. As an Admin, I want to authorize one unpaid departure only after the car is at the exit spot and an invoice has a missing, invalid, or unresolved payment, so that exceptions are limited to the documented business case.
28. As an Admin, I want to re-enter my password, provide a reason, and confirm an unpaid-release authorization, so that the exception is deliberate and attributable.
29. As an Operator, I want to see an Admin override and its reason in the session timeline, so that the operational history is transparent.
30. As an Admin, I want concurrent unpaid-release requests to use first-writer-wins semantics, so that a session cannot receive competing active authorizations.
31. As an Admin, I want an unused unpaid-release authorization invalidated if valid payment arrives before departure, so that the normal paid flow takes precedence.
32. As an Operator, I want an Admin-authorized unpaid departure to retain unpaid status, so that the system never fabricates a payment or receipt.
33. As an Operator, I want a departure authorization consumed only after confirmed simulator departure, so that a failed gate action does not consume the exception.
34. As an Operator, I want the event timeline to show webhook evidence, commands, invoices, payments, penalties, overrides, and corrections, so that every decision can be audited.
35. As an Operator, I want to search events and sessions by plate, event type, component, sequence, and time, so that I can diagnose an incident quickly.
36. As an Operator, I want duplicate webhook deliveries ignored without losing the original evidence, so that retries do not duplicate a payment or state transition.
37. As an Operator, I want out-of-order events retained and reconciled using sequence information, so that transient delivery order does not corrupt the session.
38. As an Operator, I want a webhook with an invalid signature rejected and recorded as a security incident, so that forged state cannot enter the controller.
39. As an Operator, I want webhook sequence gaps and resets visible, so that the controller can pause when evidence is incomplete.
40. As an Operator, I want the system to reconcile simulator state after reconnect, so that automatic resume is based on evidence rather than optimism.
41. As an Operator, I want new commands rejected while the simulator connection or run identity is unknown, so that a timeout cannot cause an accidental duplicate action.
42. As an Admin, I want to choose between continuing a reconciled run and closing it when identity remains ambiguous, so that a simulator reset cannot merge unrelated sessions.
43. As an Operator, I want a closed run to remain read-only with unresolved sessions and commands visible, so that recovery work is not erased.
44. As an Operator, I want a new run to start without old reservations, invoices, payments, or overrides, so that one simulator run cannot contaminate another.
45. As an Admin, I want audit corrections recorded as new linked records, so that a revised interpretation never edits or deletes original evidence.
46. As an Operator, I want the dashboard to work when Jev is disabled or unavailable, so that internet access is not part of the parking control loop.
47. As a future enhancement owner, I want Jev to classify only genuinely ambiguous operator text, so that an AI feature has a measurable purpose and a deterministic fallback.
48. As a future enhancement evaluator, I want Jev results shown with uncertainty and compared with a baseline, so that an uncertain judgment cannot masquerade as an authoritative decision.
49. As Mohamad, I want ownership of the backend integration and any future Jev adapter, so that the simulator boundary and external dependencies have one accountable owner.
50. As Miro, I want ownership of the browser dashboard and operator experience, so that UI state clearly reflects the controller’s evidence and permissions.
51. As Hashmat, I want ownership of allocation, session lifecycle, gates, billing, maintenance, CO, and lighting policies, so that challenge rules are encoded consistently.
52. As Song, I want ownership of simulator operation, fixtures, replay, fault injection, CI, and independent evaluation, so that the team can reproduce and trust its results.
53. As a team member, I want the simulator and backend to run on one Windows machine first, so that connection and recovery behavior are reproducible before LAN sharing.
54. As a team member, I want recorded simulator fixtures and a repeatable demo setup, so that development and judging do not depend on an uncontrolled live run.

## Implementation Decisions

- Use TypeScript on Node.js 24 LTS for the backend and React with Vite for the dashboard. Use Fastify for HTTP, SQLite for durable local state, SSE for live dashboard updates, Vitest for unit/integration tests, and Playwright for browser acceptance tests.
- Keep one modular monolith with explicit modules for simulator integration, authentication, event ingestion, run management, parking allocation, session and gate control, billing and payment, maintenance and environment, audit/search, and dashboard delivery. Do not split services while the core control boundary is still being proven.
- Introduce one highest-level external seam named `SimulatorGateway` in the design. It owns simulator login, bearer-token handling, REST reads and commands, webhook verification, event normalization, and reconciliation. Tests should replace this seam with a fixture/replay implementation rather than mocking domain internals.
- Run the local backend on `127.0.0.1:3000` and the simulator on `127.0.0.1:9898` during first integration. Bind the dashboard to the local network only after the same-machine flow is reliable. The webhook receiver must be started before the simulator and must be configured with the backend webhook URL.
- Use the simulator’s `/api/v1` login and protected endpoints through the gateway. Discover parking spots, barriers, lights, fans, alarms, zones, and level metadata once per run and persist the observed snapshot. Do not infer reachability from component names; use the level topology exposed by the simulator and verify it experimentally.
- Authenticate every webhook by excluding `Signature`, sorting the remaining fields alphabetically, joining their values with `|`, and comparing the lowercase MD5 digest. Store the raw payload, calculated digest, and validation result. Reject invalid signatures before domain processing.
- Give every accepted webhook an inbox record keyed by event identity. Use `EventId` for idempotency, retain `SequenceId`, detect gaps and resets, and preserve out-of-order evidence for reconciliation. Do not process a duplicate as a new payment, departure, repair, or penalty.
- Process accepted events through a deterministic reducer/policy layer. Treat webhook evidence as authoritative for physical state; treat REST command acceptance as an intent acknowledgement. Persist a command outbox with correlation data, retry policy, and an unknown outcome when the final result cannot be established.
- Use a durable SQLite transaction for state changes and audit records. Never hold a database transaction open while waiting on simulator or Jev network calls. Keep the audit trail append-only; corrections link to their original records.
- Model a car’s plate number separately from its parking session. A returning car must receive a new session identity. Model parking spots separately from entry and exit spots, and barriers separately from those detection points.
- Allocation must filter illegal candidates first, then rank valid candidates with a transparent deterministic policy. It must respect spot type, accessibility, charging requirements, occupancy, maintenance, component health, route reachability, and zone safety. Do not reserve a spot until the corresponding simulator evidence makes the reservation valid.
- Session and gate transitions must be explicit. Entry, parking, payment, exit, and departure are separate evidence-backed transitions. A gate action may not proceed when the barrier, route, occupancy, or safety state makes it illegal.
- Billing must be implemented as deterministic code using exact fixed-point arithmetic and simulator-verified semantics. Do not use the simulator’s planned parking duration as a substitute for observed billing rules. Establish and fixture the rounding boundary, parking/electricity split, and charging behavior from live simulator observations before finalizing those policies.
- Payment validation must bind a payment to the current session and invoice. Keep invoice, payment notification, validation decision, and departure outcome as separate facts. Never mark a payment as valid solely because a notification arrived.
- Apply equipment, occupancy, routing, maintenance, CO, and lighting restrictions to both roles. Operators have no business-exception authority. Admin authority is limited to the explicit unpaid-release workflow and administrative account management.
- Require Admin password re-entry, reason, and confirmation for an unpaid-release authorization. Allow one current authorization per session with first-writer-wins concurrency. Invalidate an unused authorization when valid payment arrives. Consume it only on confirmed departure, and preserve the unpaid outcome.
- Reconcile on reconnect before automatic resume. Reject new commands while connectivity or run identity is unknown. If identity is ambiguous after reconciliation, pause and require an Admin decision to continue the reconciled run or close it. No manual resume click is needed after a successful reconciliation.
- On run closure, mark the old run read-only and preserve unresolved sessions and command outcomes as recovery-needed or abandoned according to evidence. Start the new run with no carried-over reservations, invoices, payments, or override authorizations. Do not silently merge reused car plates or component names.
- Seed the first Admin from local environment configuration, require a password change, and never commit credentials. Store passwords as secure hashes. Create Operators through the Admin UI or API. Invalidate all application sessions on backend restart.
- The dashboard must display connection health, current run, event lag, spot map/table, session state, component health, invoices, payments, penalties, pending/unknown commands, and audit history. Disable or hide actions that the current role, evidence, or safety state cannot perform. Show Jev UI only if the enhancement is later justified and enabled.
- Assign ownership as follows: Mohamad owns backend foundation, simulator integration, integration acceptance, and any future Jev adapter; Miro owns dashboard and operator experience; Hashmat owns parking allocation, session/gate lifecycle, billing/payment, maintenance, CO, and lighting rules; Song owns simulator operations, fixtures/replay, fault injection, CI, reliability testing, and independent Jev evaluation if it is later enabled.
- Do not add Jev to the baseline. If a semantic need is demonstrated, use the server-side TypeSafe endpoint or official JavaScript SDK with a server-only `TYPESAFE_API_KEY`, bounded text/structured state, typed category output, visible uncertainty, a feature flag, timeout/rate-limit handling, and deterministic fallback. Keep all authoritative numerical and safety decisions in ordinary code.
- Before finalizing rule code, verify the simulator facts that are not established by the written specification: billing clock and rounding, electricity usage split, topology and reachability, webhook retry and sequence-reset behavior, command idempotency, low-CO recovery telemetry, night definition, maintenance thresholds, level identity, and judging weights. Capture the observations as fixtures and contract tests.

## Testing Decisions

- Tests verify externally observable behavior at the highest useful seam. Prefer the `SimulatorGateway` boundary with recorded REST/webhook fixtures and a replay simulator over mocks of reducers, repositories, or UI components. Add a full-stack HTTP/SSE seam and a browser seam only where they prove behavior that the gateway tests cannot.
- There is no prior application test suite to preserve; the repository currently contains planning and domain documentation rather than implementation. The first tests establish the project’s testing conventions.
- Test webhook signature validation with the documented sorted-field MD5 algorithm, valid payloads, altered fields, missing signatures, duplicate deliveries, out-of-order sequence IDs, sequence gaps, and run resets.
- Test simulator gateway contracts for login, bearer-token use, protected reads, command acknowledgement, timeouts, malformed responses, and reconciliation. Verify that REST acceptance does not produce confirmed physical state without event evidence.
- Test allocation with normal, electric, accessible, occupied, broken, under-maintenance, unreachable, unsafe-zone, and concurrent-arrival fixtures. Assert the chosen spot and the reason it was eligible.
- Test session and gate transitions for entry, parking, payment-before-exit, exit, confirmed departure, rejected gate action, pending command, unknown command, and duplicate/out-of-order evidence.
- Test billing and payment with exact arithmetic, rounding boundaries, normal and electric usage, duplicate payment, payment for another session, invalid amount, early payment, late payment, and unresolved notification. Assert that invoice, validation, and departure remain separate records.
- Test the Admin unpaid-release workflow for role rejection, missing invoice, car not at exit, missing reason, failed password re-entry, concurrent first-writer-wins authorization, valid payment invalidation, restart/reconciliation survival, confirmed departure consumption, failed departure non-consumption, and preserved unpaid status.
- Test maintenance, CO, lights, and gates for broken/fixed events, repair acknowledgement versus repair evidence, threshold behavior, high-CO fan response, low-CO recovery, zone isolation, and the rule that neither role bypasses physical restrictions.
- Test recovery with backend restart, simulator disconnect, reconnect, event replay, duplicate replay, command timeout, sequence gap, ambiguous run identity, Admin continue decision, run closure, new run isolation, and append-only audit correction. Assert no duplicate external command is emitted from uncertain state.
- Test authentication and authorization for Admin and Operator permissions, password change, account creation, idle expiration, explicit logout, restart invalidation, forbidden override attempts, and audit attribution.
- Test search and dashboard behavior through HTTP/SSE and Playwright: stale/disconnected state is visible, pending and unknown commands are distinct, audit evidence is searchable, controls are disabled when ineligible, and Admin-only actions are not exposed as executable Operator actions.
- If Jev is later enabled, test it separately from the control loop with labeled ambiguous-text fixtures, a deterministic baseline, timeout/rate-limit/no-key behavior, low-confidence output, unavailable provider, adversarial text, and the requirement that parking continues safely with no AI result. Do not accept Jev tests as a substitute for core parking or reliability coverage.
- Completion requires a successful full Normal and Electric simulator lifecycle, no challenge penalties in the demonstrated run, a repeatable fixture/replay run, recovery tests passing, and a browser demo that clearly explains observed evidence, targets, synthetic tests, and any remaining simulator facts.

## Out of Scope

- Level 2 and Level 3 optimization beyond what is needed to keep the Level 1 architecture extensible.
- A microservice deployment, cloud hosting, multi-tenant account model, mobile application, or production-scale distributed database.
- Computer vision, ANPR, image/audio/video interpretation, or using Jev to infer plates or physical state.
- Jev in the baseline release, an AI-generated control decision, or any AI feature without a measured semantic need and fallback.
- Admin bypasses for gates, occupancy, routing, component health, carbon monoxide, maintenance, lighting, or any other physical interlock.
- Editing or deleting event evidence, manufacturing payments, carrying state across an ambiguous simulator run, or treating an HTTP acknowledgement as physical confirmation.
- A schedule or effort estimate; work is split by ownership and dependency instead.
- Credentials, API keys, simulator passwords, generated databases, build artifacts, and local environments committed to the repository.

## Further Notes

The first integration should use the downloaded Windows simulator with the backend on the same machine. Start the webhook listener first, configure the simulator to call it, log in through the gateway, discover the level, and record fixtures before building rule-specific optimizations. The team should work in a dedicated implementation branch after the documentation is committed, with Mohamad coordinating integration and the other three owners working against the shared gateway and domain contracts.

The challenge specification and the simulator are the source of truth for runtime facts. Where the written specification is silent, the implementation must measure the simulator behavior and record the result rather than inventing a rule. The core system must remain safe, auditable, and useful with Jev disabled and without internet access.

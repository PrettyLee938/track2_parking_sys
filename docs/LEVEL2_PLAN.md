# Level 2 implementation and completion plan

## 1. Objective, decisions, and current evidence

Complete every requirement in Level 2 while retaining the existing TypeScript, Fastify, React/Vite, SQLite, and Postman workflow. The requirements are in `../../Level2.pdf`; simulator commands and event definitions are in `../../Track 2 specs.pdf`.

The implementation must manage three enclosed zones, concurrent entrances and exits, different vehicle types, equipment failures, maintenance, ventilation, lighting, authenticated users, and auditable financial records.

### Decisions agreed during planning

| Decision | Selected behavior |
|---|---|
| Visit with no trustworthy parking history | Treat as an unknown visit, not automatically as a confirmed unpaid departure. Reconstruct from evidence; an operator documents a duration estimate, and an admin alone may approve a financial adjustment, waiver, or emergency release. |
| Financial reports | Admin only. Operators retain operational reports and individual visit information. |
| Dashboard roles | Keep Operator and Admin; add a least-privilege Maintenance role for equipment and assigned maintenance work. Consider a read-only Auditor only if reporting/audit needs justify another account type. |
| Daily reporting period | Simulator calendar day, with the time source and its confidence shown. |
| CO recovery verification | After a calibrated ventilation interval, make a logged one-shot zone-reading request; only fresh low readings allow automatic recovery. Failed or high readings keep ventilation on and trigger review, not a polling loop. |
| Undocumented simulator behavior | Measure it in isolated practice runs before enabling the corresponding automation. |

### Existing implementation to retain

The repository already provides zone-aware allocation, gate control, planned-duration billing, payment checks, webhook logging, two user roles, manual repairs for gates and spots, event replay, and live dashboard updates.

Extend these capabilities rather than replacing the application framework.

### Evidence that influences this design

The inspected SQLite capture contains 509 events, 305 command records, and 38 completed paid visits. It contains no Level 2 CO or component-failure events, so it cannot establish maintenance thresholds or ventilation behavior.

Two details are particularly relevant:

- Cars `TRT 573` and `ARV 321` crossed the exit sensor before parking in S15. An “exit event without payment” rule would incorrectly flag those inbound journeys.
- `BKK 645` paid and received departure commands but has no recorded exit event. `gateB` has no recorded closure for approximately the remaining 171 seconds of the capture. This does not prove the physical cause, but it is a required recovery test.

The current controller also has cleanup paths that delete a car without clearing its exit-lane membership. This can leave stale state that prevents gate closure.

## Implementation checkpoint — `H_Level2`

This checkpoint records what is implemented in the current branch and what still blocks a Level 2 completion claim.

**Implemented and covered by automated tests:** Level 2 webhook acceptance/deduplication and durable intake; visit/invoice/command recovery; per-lane exit ownership and tailgate incidents; unknown-visit and uncertain-reservation review; durable manual-occupancy quarantine with fresh empty-sensor plus physical-clearance review; Admin/Operator/Maintenance permissions; claimable, assigned maintenance jobs; gate drain-before-repair; spot/gate/fan repairs; typed light/fan/zone parsing and equipment views; CO-triggered ventilation, admission restriction, and reasoned one-shot recovery checks; accepted-reading peak CO reporting; penalties, audit, incident, and provisional daily-report views; billing-rate matrix, unknown-visit billing hold, queued-arrival abandonment, and login-history restart regression tests. Level 2 admissions now keep waiting cars queued during a High/Critical CO restriction; replayed occupants are retained when a zero detector count conflicts with visit history; and an exit passage's physical-clearance timer is re-armed after restart. Admins can also persist/invalidate a manually calibrated simulator-calendar projection and run label, with append-only audit records and per-process fail-closed behavior. Tested lighting policy/movement helpers are present but not yet connected to simulator commands. A 23-request Postman smoke collection is included in `postman/`.

**Still required before Level 2 can be called complete:**

- Run the simulator against the actual Level 2 settings and execute the acceptance scenarios in Section 6. The current test suite uses deterministic fakes; no live simulator acceptance run has been performed.
- Calibrate CO ventilation duration, component wear/failure limits, repair timing, and simulator day/night/time behavior. `GPA_CO_MINIMUM_VENTILATION_GAME_S` remains unset, so the API deliberately refuses to clear a CO restriction until calibrated.
- Implement and validate automatic day/night lighting policy, moving-vehicle tracking for lights, and accumulated on-time/runtime metrics. The local simulator contract has light on/off endpoints but no authoritative calendar/day-night source, no scoped light repair endpoint, and no usage counter in its documented light-list example or checked-in Level 2 light rows. Current equipment pages keep absent simulator usage counters unknown; they do not invent runtime or trigger preventive work from uncalibrated thresholds.
- The Admin manual simulator-clock projection, append-only audit trail, and current-process invalidation are implemented. The manually entered run label is not simulator-verified, and daily reports remain server-UTC and provisional rather than simulator-day/run reports.
- The Track 2 contract provides speed multipliers and wall-clock webhook timestamps, but no authoritative simulator calendar/day-night source. Its light API supports on/off only; no scoped light-repair API or documented runtime counter is available. Keep those facts explicit, and require a calibrated admin anchor before enabling unattended lighting.
- Replace the current serial controller command path with the planned bounded dispatcher across independent equipment, after preserving its state/command ordering guarantees.
- Complete the remaining acceptance scenarios, run the Postman collection against a configured local Level 2 instance, and reconcile financial totals against a representative Level 2 run.

Accordingly, passing typecheck, tests, and build is necessary but not sufficient for completion. See the acceptance list in Section 6 for the live evidence still needed.

## 2. Architecture and implementation foundations

### 2.1 Separate the decisions into subsystems

Keep one authoritative controller, but move decision logic into focused services:

| Subsystem | Responsibility |
|---|---|
| Webhook intake | Validate signatures and payloads, persist deliveries, prevent duplicate processing. |
| Visit and reservation manager | Track a visit, its location evidence, parking reservation, and final outcome. |
| Lane and passage controller | Serialize movements through each entrance and exit gate. |
| Billing and payment service | Calculate invoices, record payment evidence, authorize departure. |
| Equipment registry | Track gates, spots, lights, fans, availability, and usage. |
| Maintenance scheduler | Select work, obtain exclusive use of equipment, and track repair completion. |
| Zone environment controller | Decide lighting, ventilation, and zone admission status. |
| Incident analyzer | Detect inconsistencies, reconstruct timelines, and record resolutions. |
| Reporting service | Produce operational and financial reports from accepted records. |
| Authentication and audit service | Enforce permissions and persist security and administrative activity. |

All subsystems use the same persisted state and decision queue. They must not independently send conflicting commands to the simulator.

### 2.2 Process events and commands durably

Use this processing contract:

1. Persist the incoming delivery and validation result.
2. For an accepted event, transactionally update domain state and record any intended commands.
3. Commit the transaction before contacting the simulator.
4. Send commands through a dispatcher.
5. Feed command results and subsequent simulator events back through the controller queue.

This fixes the current ambiguity where a request can reach the simulator before the server records what it intended.

Command records need an explicit status:

`pending`, `sending`, `acknowledged`, `confirmed`, `rejected`, or `outcome_unknown`.

An HTTP success and a confirmed physical action are different facts. For example, a gate is confirmed open by its gate event; a repair finishes on `component_fixed`.

On restart, a command left in `sending` becomes `outcome_unknown`. Never blindly resend a charge or repair.

Do not hold the controller’s state queue while waiting several seconds for network calls. Use bounded command concurrency across independent resources, initially four concurrent requests, with one outstanding command per resource. Commands must recheck their preconditions before dispatch.

### 2.3 Give each visit its own identity

Introduce a `visit_id` independent of the license plate.

A plate can return, be reused after a simulator restart, or have delayed events from an earlier visit. Payment and release authority must belong to a visit, not merely to a plate.

Also introduce:

- `run_id`: one identified simulator run.
- `reservation_id`: one assignment of a space to a visit.
- `invoice_id`: one logical invoice, including explicitly rejected revisions.
- `passage_id`: one authorized movement through a gate.
- `command_id`: one recorded command intent.
- `incident_id`: one investigation or operational exception.

Every timer and delayed command carries the relevant visit, passage, and state version. If that state has changed, the timer becomes a no-op.

### 2.4 Separate three notions of time

The existing Level 1 event timestamps in the inspected capture match real local time. They do not establish the simulator’s day/night clock.

Implement separate clocks:

| Clock | Used for |
|---|---|
| Real UTC time | HTTP latency, authentication expiry, audit records, webhook reception. |
| Simulation elapsed time | Vehicle movement, gate clearance, equipment runtime, physical-action deadlines. |
| Simulator calendar time | Day/night lighting and daily report boundaries. |

Parking duration additionally needs the effect of `ParkingSpeedMuliplier`, which must not be applied to gate movement or equipment wear.

Persist clock anchors and changes. Reconstruct historical durations using the clock segments that applied at the time, rather than multiplying an old duration by the current speed.

Webhook silence is ambiguous: it may indicate a pause, an outage, or a quiet car park. Treat it as uncertain connectivity; do not use it alone to release reservations, declare a zone safe, or erase equipment runtime.

### 2.5 Persist enough state for reliable recovery

Use additive SQLite migrations. Preserve existing historical tables and records.

Add logical storage for:

- Simulator runs and clock segments.
- Raw webhook deliveries and processing status.
- Active visits and state transitions.
- Reservations and gate passages.
- Equipment state, usage counters, and runtime intervals.
- Maintenance jobs and policy versions.
- Invoices, payment evidence, and approved adjustments.
- Command intents and outcomes.
- Login attempts and administrative audit entries.
- Incidents, evidence links, and resolutions.

Use transactions and uniqueness constraints to enforce:

- At most one active reservation for a spot.
- At most one active passage owner per lane: only one vehicle at a time may be authorized through a particular gate; other lanes remain independent.
- One application of each accepted simulator event.
- One recognized payment settlement per invoice.
- No duplicate maintenance job for the same component.

Historical records with missing facts remain explicitly unknown. A migration must not invent zero usage, reliable timestamps, or payment confirmation.

## 3. Design for every Level 2 requirement

### Requirement 1 — Continue normal operations while handling failures

**Implementation**

Maintain independent operating state for each zone and lane: `normal`, `restricted`, `draining`, or `unavailable`.

A broken gate stops dispatch through its lane. A broken or uncertain spot is removed from allocation immediately. An unsafe zone stops accepting new cars while existing exits continue where physically possible.

The other zones continue operating.

**Decisions**

- Retain zone-local allocation because Level 2 zones are enclosed.
- Disable automatic operation of a lane whose gate mapping is unresolved.
- Never assume an unconfirmed gate has opened after a timeout.
- Do not reroute cars to another zone or exit unless a reachable route has been verified.
- Every transition to restricted operation creates an incident with a reason.

After repair, re-evaluate waiting vehicles and zone restrictions before resuming.

**Acceptance**

Breaking one zone’s entrance gate must not interrupt arrivals, payments, or departures in another zone.

---

### Requirement 2 — Monitor usage cycles and runtime, including lighting

**Implementation**

The equipment registry stores lifetime usage and usage since the last confirmed repair.

| Component | Measurements |
|---|---|
| Gate | Confirmed opens, closes, complete cycles, and interrupted movements. |
| Parking spot | Confirmed occupancy cycles and occupancy duration. |
| Light | On-time, switching count, and zone/group membership. |
| Exhaust fan | On-time, switching count, and availability. |

Count physical transitions, not command retries. Deduplicate event effects.

The simulator’s exact interpretation of gate and spot usage must be measured during calibration. Keep both raw transition counts and the derived maintenance metric.

**Lighting rule**

Lights are requested on when the zone is in simulator nighttime and has moving vehicles. They are requested off during daytime, and after a calibrated clearance period when nighttime movement ends.

Track moving visits as a set:

- Entry dispatch starts movement.
- Parking confirmation ends inbound movement.
- Spot departure starts outbound movement.
- Confirmed departure ends outbound movement.

This prevents one parked car from turning off lights needed by another moving car.

Before nighttime entry dispatch, request the zone’s lights on. Use group commands when every light in the group needs the same state.

A missing movement event creates uncertainty; it must not silently clear the moving set.

**Electricity accounting**

Show equipment runtime. Only calculate energy or cost when a documented wattage or tariff exists; otherwise label the values unavailable.

---

### Requirement 3 — Perform preventive maintenance efficiently

**Implementation**

Use a persisted maintenance job lifecycle:

`scheduled → waiting_for_clearance → requested → in_progress → completed`

Additional states: `failed`, `outcome_unknown`, and `cancelled`.

Each component policy contains its usage metric, failure limit, preventive threshold, expected repair duration, and evidence source.

**Threshold decision**

Use organizer-supplied limits when available. Otherwise, measure supported component classes in isolated practice runs.

For measured limits, begin with maintenance due at 80% of the lowest observed failure limit. Account for already committed movements before accepting another use. This is an initial policy, not a claim about the simulator’s hidden thresholds.

Unknown existing wear must be marked unknown. Establish a baseline through a safe preventive repair or verified simulator data.

**Scheduling rules**

- Spot: stop allocating it when maintenance becomes due; wait until occupancy and reservation are both clear.
- Gate: pause new passages on the affected lane. If its active crossing is still safe and the gate works, let that crossing finish; if the gate has failed mid-crossing, freeze that lane and resolve the vehicle safely before repair. Repair only after the lane/gate is clear. Other working lanes continue independently; reroute only to a verified reachable, safe route.
- Fan: defer preventive repair while CO is elevated or uncertain; normally repair at most one fan per zone at a time.
- Limit ordinary preventive work to one component per zone at a time.
- Allow emergency restoration to take precedence, while preserving component safety checks.
- Rotate eligible parking assignments toward lower wear after satisfying vehicle compatibility.

Reset usage only on confirmed repair completion, not when the repair request is sent.

**Unsupported capability**

The supplied API documents no light-repair endpoint. Monitor light runtime and failures, expose an unsupported-repair incident, and verify this limitation during calibration. Do not invent an endpoint.

---

### Requirement 4 — Detect, record, and display unavailable components

**Implementation**

Extend component handling to all four equipment classes. The existing generic “gate, otherwise spot” behavior is insufficient for fans and lights.

Represent availability separately from physical state:

- Healthy.
- Maintenance due.
- Draining for maintenance.
- Repair requested.
- Under maintenance.
- Broken.
- State unknown.

A delayed `component_fixed` must not override a newer failure. Use accepted event ordering and the active maintenance job to determine which incident it resolves.

**Dashboard**

Add an Equipment page with zone/type filters, availability, usage, repair status, last confirmation, and the reason a component is unavailable.

Overview shows usable capacity separately from occupied, reserved, uncertain, and out-of-service capacity.

**Acceptance**

Restarting the server during a repair restores the persisted job and keeps the component unavailable. On startup, reconcile the job with simulator events/state; do not assume it finished, issue a duplicate repair, allocate the component, or operate it until completion/healthy state is confirmed (or an audited recovery decision is made).

---

### Requirement 5 — Monitor CO and operate exhaust fans

**Implementation**

Store the latest accepted CO reading, danger level, source event, and freshness for each zone.

Initial policy:

- At CO ≥ 50, or a signed `Mid`, `High`, or `Critical` event, turn on every available fan in that zone.
- At `High` or `Critical`, suspend new admissions to the zone.
- If required fans are unavailable, raise a critical incident and restrict admissions.
- Never operate a broken or repairing fan.
- Avoid repeated on commands when the desired state has not changed.

**Recovery decision**

The documentation says readings are emitted only at `Mid` and above. Therefore, silence does not establish recovery.

After a calibrated minimum ventilation interval (established in isolated simulator tests, not guessed):

1. Make one logged, one-shot `list-zones` request to verify the current zone reading; this is needed because a low-CO recovery event may not be emitted.
2. If the reading is fresh, below 40, and the minimum run period has elapsed, stop the fans and clear the CO-based admission restriction.
3. If the reading is still elevated, the request fails, or freshness/state is uncertain, keep healthy fans running and keep the restriction/incident in place. An operator can request another logged one-shot check after further ventilation; do not run frequent or indefinite polling.

The off threshold of 40 provides hysteresis below the documented warning threshold of 50. It is an application policy.

Coalesce recovery checks when multiple zones need verification. Do not turn this into a periodic polling loop.

**Acceptance**

Test rising CO, oscillation near the threshold, lost low-level notifications, fan failure during ventilation, and a failed recovery query.

---

### Requirement 6 — Estimate duration and charge different vehicle types correctly

**Implementation**

Keep an explicit billing basis on every invoice:

- Trusted planned duration.
- Valid measured duration.
- Operator-approved duration.
- Admin-approved adjustment or waiver.

For normal simulator visits, retain planned-duration billing where calibration confirms the Level 1 behavior. Preserve measured duration for comparison and anomaly detection.

Rates remain:

- Normal: one credit per billable minute.
- Accessible: the same parking rate.
- Electric: twice the parking rate.
- Separate electricity charge: zero unless the simulator supplies a supported usage measurement and rate. This is a separate utility line item, not the electric vehicle's 2x parking tariff; do not estimate electricity from parking duration or vehicle type.

Do not charge electricity merely because a car is electric.

Store money in integer minor units. Validate amounts as finite, nonnegative decimal values.

**Invoice safety**

Persist the intended invoice before the HTTP charge request. A network timeout becomes `outcome_unknown`; it is not permission to send another invoice.

A valid payment can settle an outstanding invoice even if its HTTP response was lost. A correction is permitted only after an explicit, correlated rejection; record the rejected revision and its replacement.

Do not recognize repeated matching payment events as additional revenue.

Unknown parking history follows Requirement 14. Remove the silent one-minute fallback for these visits.

---

### Requirement 7 — Store operational events and important activities

**Implementation**

Persist raw simulator deliveries, accepted state transitions, reservations, passages, equipment changes, maintenance jobs, invoices, payment evidence, command outcomes, and operator actions.

Every decision records:

- Triggering event or user action.
- Relevant visit, component, lane, and zone.
- Previous state and resulting state.
- Rule or policy version.
- Reason.
- Resulting command IDs.

This makes explanations such as “why was this car turned away?” answerable directly from the database.

Maintain separate real reception time and simulator time.

**Reporting integrity**

Rejected, unsigned, duplicate, or otherwise unprocessed deliveries remain visible in diagnostic logs but do not contribute to occupancy, revenue, penalties, usage, or business statistics.

The existing statistics queries need this distinction; counting every raw event can inflate totals.

---

### Requirement 8 — Enforce RBAC for repairs and financial reports

Use explicit permissions underneath the existing roles. Add a Maintenance account type for dashboard users assigned to equipment work; enforce permissions in the API, not only by hiding controls in the UI. Migrate existing accounts without changing their current Operator/Admin permissions.

| Capability | Operator | Maintenance | Admin |
|---|:---:|:---:|:---:|
| View operational state and individual visits | Yes | Limited to information needed for assigned work | Yes |
| View/request/track equipment work | Yes | Yes | Yes |
| Start an eligible repair through the shared safety-gated scheduler | No | Yes | Yes |
| View operational daily reports | Yes | Maintenance-only view | Yes |
| Resolve an unknown duration with evidence | Yes | No | Yes |
| Acknowledge operational incidents | Yes | Equipment incidents only | Yes |
| View/export aggregate financial reports | No | No | Yes |
| Change maintenance, billing, or clock policies | No | No | Yes |
| Waive or override a charge | No | No | Yes |
| Emergency unpaid release | No | No | Yes |
| Manage accounts and review security audit | No | No | Yes |

Enforce permissions in Fastify, including SSE and existing statistics endpoints.

Operators must not obtain admin financial aggregates through alternate API routes, exports, or hidden fields.

An ordinary manual gate-open command must not bypass the exit passage/payment interlock. A deliberate emergency release is a separate admin action with a mandatory reason.

Every manual action still passes equipment and occupancy checks.

---

### Requirement 9 — Record successful and failed logins; show the last three

**Implementation**

Persist every attempt, including invalid credentials, disabled accounts, and throttled attempts.

Record attempted username, matched user ID when available, success/failure category, real UTC time, and request source information. Never store submitted passwords or session tokens.

After successful login, display the previous three attempts for that account, excluding the current successful attempt. Show success/failure and local display time.

Unknown-user attempts are retained for the admin security audit.

Keep generic failure messages so account existence is not revealed.

**Acceptance**

Verify history across restart, case-insensitive usernames, lockout attempts, disabled accounts, and access controls between users.

---

### Requirement 10 — Process only signed webhooks and log unsigned ones

**Implementation**

Introduce explicit Level 1 and Level 2 operating profiles.

- Level 1 retains unsigned-event compatibility.
- Level 2 requires a valid signature from startup.
- Automatic level detection must never lower the signature requirement.

Use the documented MD5 calculation over original field values, preserving numeric text. Validate before changing sequence tracking, simulator liveness, or any domain state.

Persist all rejected deliveries with their rejection reason.

Response policy:

- Valid accepted delivery or an exact duplicate: HTTP 200.
- Missing/invalid signature in Level 2: HTTP 401.
- Malformed payload: HTTP 400.
- Persistence failure: HTTP 503, with no business action.

Make duplicate prevention survive server restarts. A repeated event ID with a different payload is a conflict incident.

The specified hash contains no shared secret, so it does not itself prove the sender’s identity. For the supplied local setup, restrict webhook ingress to loopback. Do not claim this checksum alone prevents deliberate forgery.

---

### Requirement 11 — Maintain audit logs

**Implementation**

Add append-only application audit records for:

- User creation, role changes, password resets, and disabling.
- Policy and clock changes.
- Repairs and maintenance decisions.
- Manual component commands and denied attempts.
- Invoice adjustments, waivers, and emergency releases.
- Reconciliation and simulator-run changes.
- Incident resolutions and report exports.

Record actor, permission, target, reason, before/after values, result, and related evidence IDs.

Keep business audit entries separate from raw simulator events and network command logs.

Require a reason for actions that change financial outcomes or assert a missing physical fact.

This is an application audit trail; do not describe an ordinary editable SQLite file as cryptographically tamper-proof.

---

### Requirement 12 — Dedicated penalties page

**Implementation**

Create a Penalties page backed by accepted, deduplicated simulator penalty events.

Support filters for simulator day, run, zone, component, vehicle, reason, and resolution status.

Each penalty detail shows:

- Exact simulator message and fine.
- Related visit/component.
- Events and commands surrounding the penalty.
- Suspected cause and confidence.
- Recovery action.
- Linked incident and resolution notes.

Keep simulator penalties separate from locally detected incidents. A suspected tailgate is not automatically a simulator-issued fine.

If a component failure and a penalty event describe the same financial charge, correlate them instead of adding both amounts blindly. Ambiguous costs remain flagged rather than silently double-counted.

---

### Requirement 13 — Dynamic daily reports

**Implementation**

Default to a simulator day within a selected run. Keep real-time audit timestamps separately.

Operational reports include:

- Arrivals, admissions, completed departures, turnaways, and abandoned visits.
- Occupancy, reservations, uncertainty, and unavailable capacity.
- Queue and exit waiting times.
- Equipment usage, downtime, completed repairs, and overdue maintenance.
- CO incidents, peak readings, and ventilation runtime.
- Lighting runtime and daytime-operation exceptions.
- Penalties, unverified exits, command failures, and unresolved incidents.

Admin financial reports additionally include:

- Invoices issued.
- Verified payments received.
- Outstanding and uncertain payment outcomes.
- Repair costs and simulator fines.
- Approved waivers and adjustments.
- Net recorded receipts after known costs.

Do not label the last figure “profit” when electricity or other costs are unavailable.

Refresh reports from the application’s database every ten seconds while the page is open; this does not poll the simulator.

Allow CSV export of the same filtered report, with permission checks and audit logging. Include run, day, time basis, and generation timestamp.

Split runtime and occupancy intervals at simulator midnight. Attribute payments to their payment day, not the visit’s arrival day.

If calendar time is uncalibrated, clearly mark reports provisional. Never silently substitute the computer’s date.

---

### Requirement 14 — A manually parked car reaches the exit without history

**Implementation**

Create an `unknown_visit` incident and hold that car's exit passage. "Unknown visit" means the system cannot reliably connect the car at the exit to a visit, parking start/duration, invoice, or payment; it does not by itself mean the driver escaped without paying.

Attempt reconstruction using accepted evidence:

1. Earlier arrival or parking events.
2. Recorded reservation and movement commands.
3. Recovery records from the same run.
4. Reliable planned-duration information.
5. Operator evidence.

Show the operator what is known, missing, and contradictory.

The operator may enter a parking duration or parking-start estimate with a reason. The normal rate table computes the proposed charge; the operator cannot freely set a discount.

If the car is still present, use the reconstructed/proposed duration to issue the normal invoice and require valid payment before ordinary release. Admin may approve a reasoned amount adjustment, waiver, or emergency release; every exception is audited. If the car has already left, keep an unverified-departure incident until delayed evidence is considered. A correlated signed simulator escape penalty is evidence of a confirmed escape; otherwise absence of a payment event alone is not proof of nonpayment. Record and investigate the incident rather than pretending the departed car paid or creating an unsupported retroactive charge.

Persist the decision, evidence, and billing basis before issuing a charge.

If evidence remains insufficient while the car is present, do not invent a duration, reuse another visit's payment, or silently let the car leave; keep the lane safe and request operator/admin review.

A manually occupied spot with no functioning sensor cannot be discovered from nonexistent telemetry. Support a manual occupancy report that quarantines the spot, and resolve it through an audited observation. Do not claim that software can automatically detect an entirely unobserved vehicle.

## 4. Vehicle, reservation, and exit edge cases

### 4.1 A queued car is assigned a space but leaves without parking

The intended lifecycle is:

`queued → reserved → entering → occupied → completed`

Exceptional branches include `cancelled_before_entry`, `abandoned`, and `location_unknown`.

**Reservation timing**

A queued car has an admission position but no physical space reservation. Reserve a specific spot only when its lane is ready to dispatch.

At admission, account for compatibility across already queued cars. Use a small deterministic matching check between queued vehicle types and eligible spots so a general car does not consume capacity that is the only option for another vehicle.

Allocation order:

1. Reachable zone.
2. Healthy, confirmed available spot.
3. Exact vehicle-type spot before generic.
4. Lower maintenance wear.
5. Stable spot-name ordering as a tie-breaker.

**What happens when the car leaves?**

| Evidence | Reservation action |
|---|---|
| Car leaves while still queued | Remove it from the queue; no physical reservation exists. |
| Reserved, but dispatch was definitely cancelled before any movement command could execute | Cancel and free the reservation. |
| Car is confirmed parked in another spot | Transfer occupancy to the observed spot and cancel its old reservation. |
| Car is confirmed to have left the facility | Cancel its reservation after resolving any outstanding movement command. |
| Entry `CarOut` occurs, but no parking event follows | Mark the car entering; keep the reservation. Entry `CarOut` alone does not distinguish entry from abandonment. |
| Travel deadline expires | Mark the reservation uncertain and stop allocating that space. Investigate. |
| Late parking event arrives | Convert the reservation to occupied, even if an incident was already opened. |

**Timeout policy**

Use a route-specific travel deadline measured in game time. Start with a provisional 60-game-second deadline in the test profile. For the live profile, use the larger of 15 game seconds or twice the measured p99 travel time from at least 30 successful trips.

Expiry triggers investigation, not automatic reuse.

A zero occupancy count alone is insufficient: the original car may still be moving toward the spot. Release only after its movement is resolved and vacancy is established.

Where telemetry cannot establish this, an operator performs an audited clearance confirmation.

### 4.2 Two cars wait at the same exit; one pays

"At most one active passage per lane" means each physical entrance/exit lane has at most one authorized vehicle crossing at a time. That vehicle owns the lane's open/payment/departure/clearance cycle. It does not mean the whole car park has one global passage: independent gates can serve their own queues concurrently. This software interlock detects and limits tailgating but cannot physically prevent a car following through one open barrier.

Replace the exit lane’s current collection of releasing plates with:

- An ordered queue of exit visits.
- One active passage.
- One passage owner.
- Confirmed gate state.
- Clearance and recovery state.

Normal flow:

1. Car A becomes the exit queue head.
2. Confirm A is at the payment position and the sensor has settled.
3. Issue A’s invoice.
4. Accept payment only for A’s active invoice.
5. Create a passage owned by A.
6. Open the gate and wait for confirmation.
7. Send departure only for A.
8. Observe A’s exit event.
9. Wait the calibrated physical-clearance interval.
10. Close and confirm the gate.
11. Start the next passage.

Do not invoice or release B while A’s passage is active. If B nevertheless submits a valid payment, record it against B’s invoice where applicable, but do not grant another passage until A’s cycle has closed.

Separate exits may operate concurrently, and a maintenance outage pauses only the affected lane. Keep routing arrivals/exits through other gates that are confirmed operational; redirect affected-lane traffic only if a reachable and safe alternate route has been verified.

**Important physical limit**

One barrier can be physically followed through. With only an upstream sensor and no independent downstream clearance/vehicle-separation mechanism, software cannot guarantee that B never follows A.

The implementation can reduce exposure, prohibit unauthorized commands, detect suspicious passages, and provide evidence. Absolute prevention would require additional simulator support or physical infrastructure, which is outside this software implementation.

Do not shorten the clearance delay simply to catch a follower; that can close the barrier on the authorized car.

### 4.3 A paid car never reports leaving

At a configurable passage deadline, initially 30 game seconds:

- Mark the passage uncertain.
- Stop granting additional passages through that gate.
- Cancel duplicate pending callbacks.
- Reconcile sensor/gate state as incident recovery.
- Close only when clearance is established.
- Otherwise require operator clearance.

A missing event must not leave an invisible lane membership holding the gate open indefinitely.

Every visit cleanup path calls one transactional cleanup operation that resolves its queue membership, reservation, timers, and passage. Direct deletion from the active-car map is prohibited.

After every transition and at startup, verify that every active passage references an existing visit or an explicit recovery incident.

### 4.4 Detect tailgating through log analysis

Build a timeline for each run, visit, lane, and gate-open interval.

Correlate:

- Entry, parking, and exit observations.
- Invoice intent and charge outcome.
- Valid payment evidence.
- Passage ownership.
- Open/close commands and confirmed gate transitions.
- Departure commands.
- Penalties and operator overrides.

Detect these conditions:

| Condition | Classification |
|---|---|
| Exit sensor crossing while traveling to a verified parking destination | Inbound pass-through, not an unpaid departure. |
| More than one completed departure during one authorized opening | Shared-opening anomaly; inspect each visit’s payment and passage. |
| Departure with no matching payment or waiver evidence | Unverified exit; escalate after allowing for delayed events. |
| Signed escape penalty correlated to the visit | Confirmed simulator escape. |
| Gate remains open after its passage is complete | Gate-state incident. |
| Payment exists but no matching invoice | Unallocated payment incident. |
| Visit disappears while its passage remains active | State-integrity incident. |
| Reservation expires without parking or departure evidence | Uncertain-location incident. |

Use sequence numbers, state transitions, and route context. Do not use only wall-clock proximity or plate matching.

For an inbound pass-through (including an S15-style crossing on the way to a reserved spot), retain the sensor event in the timeline but do not create a departure, invoice, penalty, or exit-gate authorization. Classify a crossing as a departure only when the visit is known to be inside/on an exit route and its movement/exit state supports that interpretation. If route context is ambiguous, hold automatic action and create an incident for review.

Allow a short two-real-second grace period for event reordering before escalating a provisional unmatched exit. Late evidence can resolve an incident, but the original detection remains in its audit history.

“No payment event found” is absence of evidence, not proof that a driver did not pay.

### 4.5 Other required edge cases

| Case | Required response |
|---|---|
| Duplicate event after server restart | Persist delivery; do not apply its effects again. |
| Old event for a reused plate | Associate with its original visit where possible; otherwise quarantine as ambiguous. |
| Payment arrives before HTTP charge response | Match the persisted invoice intent and settle it. |
| Charge request times out | Preserve outcome unknown; no blind retry. |
| Underpayment, overpayment, negative, or malformed amount | Record evidence; deny automatic passage. |
| Same payment repeated with a different event ID | Do not increase recognized revenue or create another passage. |
| Spot breaks while a car is driving toward it | Quarantine destination; redirect only when a safe reachable alternative and command outcome are established. |
| Two cars appear in one spot | Preserve both occupants; free only when all occupancy is resolved. |
| Delayed spot event arrives after exit processing | Record the fact without regressing the visit state. |
| Gate breaks during passage | Freeze new passages on that lane; if a car is mid-crossing, resolve its safety/location first. Keep other gates running. Repair only after lane clearance; do not issue more gate commands to a failed component. |
| Repair response is lost | Keep job uncertain; do not submit a second repair blindly. |
| Simulation speed changes | Use the appropriate clock segment; do not apply today’s speed to historical intervals. |
| Simulator restarts with the same layout | Detect uncertainty and establish a new run through corroborated evidence/operator confirmation, not silence alone. |
| Database unavailable | Stop new automated decisions that cannot be recorded; report failure visibly. |
| Manual control races automation | Route both through the same state queue and version checks. |

## 5. API, shared types, and dashboard changes

Extend the existing API rather than introducing a separate service.

| Interface | Purpose |
|---|---|
| `GET /api/state` and `/api/stream` | Add equipment, zone environment, reservation confidence, exit queue/passage, incidents, and clock confidence. Apply role filtering. |
| `GET /api/equipment` | Filter component state and usage. |
| `POST /api/equipment/:id/maintenance` | Request a repair through the shared scheduler. |
| `GET /api/maintenance` | Job status and history. |
| `GET /api/incidents` | Filter unresolved and historical incidents. |
| `GET /api/incidents/:id` | Evidence timeline and current recovery options. |
| `POST /api/incidents/:id/resolve` | Audited, permission-checked resolution. |
| `POST /api/visits/:id/duration-review` | Operator submits evidence and duration for an unknown visit. |
| `POST /api/visits/:id/adjustment` | Admin financial adjustment or waiver. |
| `POST /api/visits/:id/emergency-release` | Explicit admin exception with reason. |
| `GET /api/auth/login-attempts?limit=3` | Current user’s previous login attempts. |
| `GET /api/audit` | Admin security and administrative audit. |
| `GET /api/penalties` | Dedicated penalty records and evidence. |
| `GET /api/reports/daily?run_id=…&date=…&kind=operations\|financial` | Daily report with server-side permissions. |
| `GET /api/reports/daily/export?...` | Corresponding CSV export. |
| Admin policy and clock configuration endpoints | Versioned, audited policy changes and simulator clock anchoring. |

Use shared TypeScript types and runtime validation for all new request bodies.

Manual mutation requests carry a request ID, expected state version, and reason where required. Return HTTP 409 for stale state or an unsafe operation.

Add typed simulator responses for lights, fans, zones, and alarms. Normalize spot detection whether the simulator returns counts or plate arrays; preserve which representation was supplied.

Keep the existing Overview, Operations, Logs, Statistics, and Admin pages. Add Equipment, Maintenance, Incidents, Penalties, and Daily Reports as focused views. Show Maintenance users only the equipment/jobs and operational information needed for their work. Financial report controls appear only for admin, backed by server enforcement.

Replace the existing localhost diagnostic POSTs with the structured decision and incident records.

## 6. Implementation order, calibration, and acceptance

### Phase 1 — Establish simulator capabilities and regression fixtures

Prepare a separate calibration profile with its own database and simulator settings/ports. Clearly label these runs so their penalties and costs cannot enter judged-run reports.

Record:

- Actual Level 2 payloads and signature behavior.
- Vehicle types, spot compatibility, and reachable routes.
- Whether charging itself causes movement or whether `leavepark` is required.
- Exit sensor position relative to physical clearance.
- Gate open/close behavior and ignored commands.
- Entry-to-spot travel times.
- Gate/spot failure metrics and fan runtime limits.
- Repair duration and counter-reset semantics.
- CO event frequency and behavior below 50.
- Simulator calendar source, day/night boundaries, pauses, and speed changes.
- The independent effect of parking-speed acceleration.
- Whether light repair is supported anywhere in the supplied contract.

Measure failure limits on at least three instances/runs per supported component class. Store the observations and resulting policy values.

If no calendar API/event exists, implement an admin-set simulator clock anchor and calibrated calendar rate, with manual re-anchoring after restart and visible confidence. Unknown calendar state restricts unattended lighting operation until resolved.

If a required simulator capability truly does not exist, document the exact limitation and available operator workflow. Do not claim that a made-up endpoint completes the requirement.

### Phase 2 — Build persistence and trust boundaries

Implement migrations, visit/run identity, durable inbox processing, command intents, strict Level 2 signatures, login history, permissions, and audit records.

Take a SQLite-consistent backup before migration. Preserve the original database for rollback.

Create sanitized replay fixtures from the inspected Level 1 run, including the S15 pass-through cases and the missing-exit case.

### Phase 3 — Harden visits, reservations, exits, and billing

Implement explicit reservation uncertainty, passage ownership, transactional cleanup, invoice/payment persistence, and unknown-visit review.

These are prerequisites for maintenance because equipment cannot be safely removed from service while vehicle ownership is ambiguous.

### Phase 4 — Add equipment and environmental automation

Implement component tracking, usage counters, preventive jobs, lighting, CO ventilation, admission restrictions, and repair recovery.

Enable automation only for calibrated capabilities.

### Phase 5 — Complete dashboards, reports, and diagnostics

Add the operational pages, dedicated penalties view, daily reports, CSV exports, last-three-login display, and linked evidence timelines.

Prepare a Postman collection covering both simulator authentication and application cookie authentication, with example operator/admin flows and signed/unsigned webhook tests.

### Phase 6 — Prove completion

Retain the existing test suite, updating tests that currently encode unsafe Level 1 behavior, such as assuming a gate has opened without confirmation.

Add deterministic simulator scenarios and a richer fake simulator capable of:

- Delayed, duplicated, reordered, and lost webhooks.
- Acknowledged-but-ignored commands.
- Commands that execute even when the HTTP response is lost.
- Equipment failures and repair completion.
- Multiple vehicles at one sensor.
- Clock changes and pauses.
- CO progression and silent recovery below threshold.

Required acceptance scenarios:

1. Three zones simultaneously accept, park, charge, and release compatible vehicles.
2. A queued car abandons without consuming a parking space.
3. A dispatched car disappears; its reservation becomes uncertain and is not double-booked.
4. A delayed parking event correctly resolves that reservation.
5. Two cars reach one exit; only one owns the active passage.
6. A follower leaves through an open gate; the timeline detects an unverified/unauthorized passage without confusing it with S15-style inbound transit.
7. A paid car’s final webhook is lost; stale lane membership cannot hold the gate open indefinitely.
8. Payment succeeds after the charge HTTP response is lost; no second invoice is sent.
9. Duplicate payment deliveries do not duplicate revenue.
10. Preventive repair waits for occupancy, reservations, and active passages to clear.
11. Repairing or losing one gate pauses only its lane; other verified-working gates continue serving their own queues.
12. Fan failure during high CO restricts admission while healthy zones continue.
13. Missing low-CO webhooks do not cause premature fan shutdown; failed/high/stale one-shot recovery checks keep fans on and raise an incident.
14. Lights operate correctly across simulator day/night transitions and concurrent vehicle movements.
15. Restart during a visit, payment, passage, and repair reconstructs state without duplicate external effects or premature component reuse.
16. Unsigned/invalid Level 2 events are logged but do not affect domain state or reports.
17. Operator and Maintenance attempts to export finances, change policies, waive charges, or bypass payment receive authorization errors; Maintenance can only initiate eligible equipment work through scheduler checks.
18. Previous login attempts survive restart and remain private to the appropriate user/admin.
19. An unknown visit is reconstructed or resolved through the approved operator/admin workflow; confirmed escape and merely missing payment evidence remain distinct.
20. Daily reports reconcile to accepted ledger entries across simulator midnight.
21. Replaying the same accepted history produces the same state and financial totals.

Final verification commands remain:

```bash
npm run typecheck
npm test
npm run build
```

Then run live acceptance across at least one simulator day/night cycle and one preventive-maintenance cycle for each supported component class. Include a loaded three-zone run and deliberate recovery scenarios.

Level 2 is complete when every requirement above has implementation evidence, an exercised acceptance scenario, and a working operator view; calibrated limitations are explicit; financial reports reconcile; and the application never silently treats uncertain occupancy, command execution, or payment as confirmed.

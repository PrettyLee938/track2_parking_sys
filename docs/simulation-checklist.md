# Simulation reliability checklist

This checklist follows the Level 1 workflow from the simulator contract. Run it
after changing the speed multiplier or the simulator settings.

## Start and connection

- [x] Start the backend first. `GET /ready` reports `status: ready`, a simulator
  `runId`, and `discoveryComplete: true`.
- [x] Start the simulator with `WebhookUrl` set to
  `http://127.0.0.1:3000/webhooks/simulator`.
- [x] Check `GET http://127.0.0.1:9898/api/v1/status`; it must report an active
  game.
- [x] Keep the simulator and backend on the same Windows machine for the first
  run. The backend accepts local unsigned webhooks only when the simulator URL
  is local; non-local webhooks still require a valid signature.

## Entry and parking

- [x] `EventController.apply` sends `car_spot_action` events to
  `ParkingService.handleEntryEvent` before updating the parking state.
- [x] `ParkingService.reserveArrival` chooses a legal reachable spot and marks
  it reserved before any car command is sent.
- [x] `ParkingService.requestEntryGate` opens the configured `ENTRY_GATE_NAME`
  only when the gate is available.
- [x] `ParkingService.dispatchPendingEntries` sends one idempotent
  `car.goto/{spot}` command after the gate-open event.
- [x] A `Park/CarIn` event changes the session to `parked`, marks the spot
  occupied, and clears the reservation.
- [x] A full or unsuitable lot records an arrival rejection and marks the event
  processed; it cannot stall later events.
- [x] Duplicate, out-of-order, invalid-signature, and concurrent webhooks are
  covered by the test suite and do not create duplicate commands.

## Exit, billing, and departure

- [x] An `ExitSpot/CarIn` event changes the session to `at-exit` and frees the
  old parking spot so another car can use it.
- [x] The operator calculates the simulator charge and calls
  `POST /api/v1/parking/sessions/:id/charge` with `parkingCost` and
  `chargingCost`. `PaymentService.requestCharge` stores the invoice and sends
  the simulator's `/charge?...` command exactly once.
- [x] A matching `payment_made` webhook marks the invoice paid. The backend
  then sends `goto/leavepark`; it does not invent a payment or guess an amount.
- [x] A `CarOut` event changes the session to `departed`, clears any active
  admin override, and releases the spot.
- [x] An incorrect amount, duplicate payment, payment without an invoice, or
  departure without payment is rejected and audited.
- [x] An admin can use the re-authenticated unpaid-release flow for a real
  business exception. Operators cannot use that override.

## Speed and recovery checks

- [x] The local simulator copy is configured to `ParkingSpeedMuliplier: 5`,
  `GameSpeedMultiplier: 5`, and a one-minute parking interval for fast tests.
  These settings are ignored by Git and remain local to the downloaded
  simulator.
- [x] The webhook route serializes event application. A 5x run completed with
  no pending events after the fix; unit coverage verifies concurrent delivery.
- [x] Commands are persisted before and after the simulator call. Accepted,
  rejected, and unknown outcomes remain visible for reconciliation.
- [x] Backend restart, simulator disconnect, reconnect, replay, sequence gaps,
  run identity changes, and session invalidation have regression coverage.
- [ ] For a final penalty-free run, start a fresh Level 1 simulator state and
  complete the operator charge step for every car. A restored practice database
  contains historical penalty records, so its penalty count is not a clean
  judging result.

## Commands for a manual run

```bash
cd /c/Moha/Projects/hack_my_iot_challenge
npm install
npm run dev
```

In a second Git Bash window:

```bash
cd /c/Moha/Projects/hack_my_iot_challenge/src/ParkingSimulator-win-x64
./ParkingSimulator.exe
```

Verify the two services:

```bash
curl -sS http://127.0.0.1:3000/ready
curl -sS http://127.0.0.1:9898/api/v1/status
```

Run the automated checklist with:

```bash
cd /c/Moha/Projects/hack_my_iot_challenge
npm run check
```

`npm run check` currently passes TypeScript compilation, the 200-line file
limit, and 36 Vitest tests.

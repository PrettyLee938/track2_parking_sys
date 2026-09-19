/**
 * Drive ONE waiting car through the full lifecycle by hand, step by step, and report
 * what the simulator does at each stage. A diagnostic for when the controller misbehaves.
 *
 *   open entry gate -> goto spot -> close gate -> spot CarIn ... spot CarOut
 *   -> exit CarIn -> charge -> payment_made -> goto leavepark -> exit CarOut
 *
 * Uses the first entry lane of the site topology and whichever exit the car picks.
 * Requires the app running in PASSIVE mode, or the controller will fight this script:
 *   GPA_CONTROLLER_ENABLED=false npm run dev      then      npm run single-car
 */
import { CarType, Destination, Direction, EventClass, GateState, SpotPurpose } from "@gpa/shared";
import { chargingCost, parkingCost } from "../src/billing";
import { simSecondsBetween } from "../src/controller";
import type { EventRecord } from "../src/store";
import { readSimGameSpeed } from "../src/config";
import { cfg, recentEvents, resolveSite, sim, sleep, waitFor } from "./site";

const UNPROMPTED_EXIT_WAIT_S = 30; // observed spot->exit drive: median 5s, max 9.2s
// Game seconds -> real milliseconds, at the configured or simulator-settings game speed.
const speed = cfg.gameSpeed ?? readSimGameSpeed(cfg.simSettingsFile) ?? 1;
const realMs = (gameS: number) => (gameS / speed) * 1000;
const T0 = Date.now();
const log = (msg: string) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
const fail = (msg: string): never => { log(msg); process.exit(1); };

const carEvent = (plate: string | null, spots: string | Set<string>, direction: string) => (e: EventRecord) =>
  e.EventClass === EventClass.CarSpotAction && (typeof spots === "string" ? e.SpotName === spots : spots.has(String(e.SpotName))) &&
  e.Direction === direction && (plate === null || e.CarPlateNumber === plate);
const gateEvent = (name: string, action: string) => (e: EventRecord) =>
  e.EventClass === EventClass.GateAction && e.Name === name && e.Action === action;

const site = await resolveSite();
const entry = site.entry_lanes[0];
const exitGates = new Map(site.exit_lanes.map((l) => [l.spot, l.gate]));
log(`Site '${site.name}': using entry ${entry.spot} (gate ${entry.gate}); exits ${[...exitGates.keys()].sort()}`);
const recent = await recentEvents();
const seen = new Set(recent.map((e) => e.EventId!).filter(Boolean));

// Earliest car at the entry with no CarOut, within the patience window.
const left = new Set(recent.filter(carEvent(null, entry.spot, Direction.Out)).map((e) => e.CarPlateNumber));
let car: EventRecord | null | undefined = recent.filter(carEvent(null, entry.spot, Direction.In)).find(
  (e) => !left.has(e.CarPlateNumber) && Date.now() - Date.parse(e._received_at) < realMs(cfg.entryPatienceGameS));
if (!car) {
  log(`No car waiting at ${entry.spot} - waiting for the next arrival...`);
  car = (await waitFor(carEvent(null, entry.spot, Direction.In), 30, seen)) ?? fail("no arrival");
}
const plate = String(car.CarPlateNumber), carType = String(car.CarType || CarType.Normal);
log(`Car ${plate} (${carType}), planned stay ${car.PlannedParkingDurationInMinutes} min`);

const free = (await sim.listParkingSpots()).filter((s) => s.purpose === SpotPurpose.Park && !s.detectedCars && !s.broken &&
  !s.isUnderMaintenance && (s.parkingForCarType === CarType.Any || s.parkingForCarType === carType) &&
  (!entry.zone || s.zoneParent === entry.zone));
if (!free.length) fail("No free spot!");
const spot = free[0].name;
log(`Chose spot ${spot} (${free.length} free in zone ${entry.zone || "any"})`);

// 1) entry
if (entry.gate) {
  await sim.openGate(entry.gate); log(`-> open ${entry.gate}`);
  if (await waitFor(gateEvent(entry.gate, GateState.Open), 15, seen)) log(`<- ${entry.gate} Open`);
}
await sim.carGoto(plate, spot); log(`-> goto ${plate} ${spot}`);
if (await waitFor(carEvent(plate, entry.spot, Direction.Out), 30, seen)) log(`<- ${plate} left ${entry.spot}`);
if (entry.gate) {
  await sleep(realMs(cfg.gateCloseDelayGameS));
  await sim.closeGate(entry.gate); log(`-> close ${entry.gate}`);
}

// 2) parking
const eIn = (await waitFor(carEvent(plate, spot, Direction.In), 90, seen)) ?? fail("spot CarIn timeout");
const planned = Number(eIn.PlannedParkingDurationInMinutes);
log(`<- ${plate} parked in ${spot} at sim ${eIn.ServerDateTime} (planned ${planned} min)`);
const eOut = (await waitFor(carEvent(plate, spot, Direction.Out), planned * 60 + 180, seen)) ?? fail("spot CarOut timeout");
const parkedS = simSecondsBetween(eIn.ServerDateTime, eOut.ServerDateTime) ?? 0;
log(`<- ${plate} left ${spot} after ${parkedS.toFixed(0)}s wall-clock (${(parkedS / 60).toFixed(2)} min)`);

// 3) exit: does the car head to an exit by itself?
const exitSpots = new Set(exitGates.keys());
let eExit = await waitFor(carEvent(plate, exitSpots, Direction.In), UNPROMPTED_EXIT_WAIT_S, seen);
if (!eExit) {
  await sim.carGoto(plate, Destination.Exit); log(`-> goto ${plate} exit`);
  eExit = (await waitFor(carEvent(plate, exitSpots, Direction.In), 90, seen)) ?? fail("exit CarIn timeout");
}
const exitSpot = String(eExit.SpotName), exitGate = exitGates.get(exitSpot);
log(`<- ${plate} reached ${exitSpot} (gate ${exitGate})`);

await sleep(realMs(cfg.exitChargeDelayGameS));
const parking = parkingCost(parkedS, planned, carType, cfg), electric = chargingCost(carType, cfg);
await sim.carCharge(plate, parking, electric);
log(`-> charge ${plate} parkingCost=${parking} chargingCost=${electric} (rounding=${cfg.billingRounding}, planned ${planned})`);

const pay = await waitFor((e) => e.EventClass === EventClass.PaymentMade && e.CarPlateNumber === plate, 60, seen);
if (pay) {
  const matches = Math.abs(Number(pay.Amount) - (parking + electric)) <= cfg.paymentTolerance;
  log(`<- payment_made Amount=${pay.Amount} -> ${matches ? "MATCHES" : "MISMATCH (fake?)"}`);
}
if (exitGate) { await sim.openGate(exitGate); log(`-> open ${exitGate}`); }
await sim.carGoto(plate, Destination.LeavePark); log(`-> goto ${plate} leavepark`);
if (await waitFor(carEvent(plate, exitSpot, Direction.Out), 60, seen)) log(`<- ${plate} left the car park. DONE`);

const penalties = (await recentEvents()).filter((e) => e.EventClass === EventClass.Penalty && seen.has(e.EventId!));
log(`Penalty events seen: ${penalties.length}`);
for (const p of penalties) log(`   ${p.Reason} fine=${p.FineAmount}`);
process.exit(0);

"""Drive ONE waiting car through the full lifecycle by hand, step by step, and report
what the simulator does at each stage. A diagnostic for when the controller misbehaves.

  open entry gate -> goto spot -> close gate -> spot CarIn ... spot CarOut
  -> exit CarIn -> charge -> payment_made -> goto leavepark -> exit CarOut

Uses the first entry lane of the site topology and whichever exit the car picks.
Requires the app running in PASSIVE mode, or the controller will fight this script:
  set GPA_CONTROLLER_ENABLED=false, start the app, then from the repo root:
  .venv\\Scripts\\python -m tools.single_car_test
"""
import json
import sys
import time
from datetime import datetime

import httpx

from app import billing
from app.config import settings
from app.protocol import (SIM_TIME_FORMAT, CarType, Destination, Direction, EventClass, GateState,
                          SpotPurpose)
from app.sim_client import SimClient
from tools.site import resolve_site

LISTENER = f"http://127.0.0.1:{settings.app_port}"
UNPROMPTED_EXIT_WAIT_S = 30   # observed spot->exit drive: median 5s, max 9.2s
T0 = time.time()


def log(msg):
    print(f"[+{time.time() - T0:6.1f}s] {msg}", flush=True)


def wait_event(pred, timeout, what):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for e in httpx.get(f"{LISTENER}/debug/recent", params={"n": 200}).json():
            if e.get("EventId") not in seen and pred(e):
                seen.add(e["EventId"])
                return e
        time.sleep(0.3)
    log(f"TIMEOUT after {timeout}s waiting for {what}")
    return None


def car_event(plate, spots, direction):
    spots = {spots} if isinstance(spots, str) else set(spots)
    return lambda e: (e.get("EventClass") == EventClass.CAR_SPOT_ACTION and e.get("SpotName") in spots
                      and e.get("Direction") == direction and (plate is None or e.get("CarPlateNumber") == plate))


def gate_event(name, action):
    return lambda e: e.get("EventClass") == EventClass.GATE_ACTION and e.get("Name") == name and e.get("Action") == action


def oldest_waiting_car(entry_spot):
    """Earliest plate with an entry CarIn and no CarOut, seen within the patience window."""
    arrivals, left = {}, set()
    with open(settings.event_log_path, encoding="utf-8") as f:
        for line in f:
            e = json.loads(line)
            if e.get("EventClass") != EventClass.CAR_SPOT_ACTION or e.get("SpotName") != entry_spot:
                continue
            if e["Direction"] == Direction.IN:
                arrivals[e["CarPlateNumber"]] = e
            else:
                left.add(e["CarPlateNumber"])
    now = time.time()
    waiting = [e for p, e in arrivals.items() if p not in left
               and now - datetime.fromisoformat(e["_received_at"]).timestamp() < settings.entry_patience_s]
    return min(waiting, key=lambda e: int(e["SequenceId"])) if waiting else None


sim = SimClient()
site = resolve_site(sim)
entry = site.entry_lanes[0]
exit_gates = {l.spot: l.gate for l in site.exit_lanes}
log(f"Site '{site.name}': using entry {entry.spot} (gate {entry.gate}); exits {sorted(exit_gates)}")
seen = {e.get("EventId") for e in httpx.get(f"{LISTENER}/debug/recent", params={"n": 200}).json()}

car = oldest_waiting_car(entry.spot)
if not car:
    log(f"No car waiting at {entry.spot} - waiting for the next arrival...")
    car = wait_event(car_event(None, entry.spot, Direction.IN), 30, "an arrival")
    if not car:
        sys.exit(1)
plate, car_type = car["CarPlateNumber"], car.get("CarType") or CarType.NORMAL
log(f"Car {plate} ({car_type}), planned stay {car['PlannedParkingDurationInMinutes']} min")

free = [s for s in sim.list_parking_spots() if s["purpose"] == SpotPurpose.PARK and not s["detectedCars"]
        and not s["broken"] and not s["isUnderMaintenance"]
        and s["parkingForCarType"] in (CarType.ANY, car_type)
        and (not entry.zone or s["zoneParent"] == entry.zone)]
if not free:
    log("No free spot!"); sys.exit(1)
spot = free[0]["name"]
log(f"Chose spot {spot} ({len(free)} free in zone {entry.zone or 'any'})")

# 1) entry
if entry.gate:
    sim.open_gate(entry.gate); log(f"-> open {entry.gate}")
    wait_event(gate_event(entry.gate, GateState.OPEN), 15, f"{entry.gate} Open") and log(f"<- {entry.gate} Open")
sim.car_goto(plate, spot); log(f"-> goto {plate} {spot}")
if wait_event(car_event(plate, entry.spot, Direction.OUT), 30, "entry CarOut"):
    log(f"<- {plate} left {entry.spot}")
if entry.gate:
    time.sleep(settings.gate_close_delay_s)
    sim.close_gate(entry.gate); log(f"-> close {entry.gate}")

# 2) parking
e_in = wait_event(car_event(plate, spot, Direction.IN), 90, "spot CarIn")
if not e_in: sys.exit(1)
planned = int(e_in["PlannedParkingDurationInMinutes"])
log(f"<- {plate} parked in {spot} at sim {e_in['ServerDateTime']} (planned {planned} min)")
e_out = wait_event(car_event(plate, spot, Direction.OUT), planned * 60 + 180, "spot CarOut")
if not e_out: sys.exit(1)
parked_s = (datetime.strptime(e_out["ServerDateTime"], SIM_TIME_FORMAT)
            - datetime.strptime(e_in["ServerDateTime"], SIM_TIME_FORMAT)).total_seconds()
log(f"<- {plate} left {spot} after {parked_s:.0f}s sim time ({parked_s / 60:.2f} min)")

# 3) exit: does the car head to an exit by itself?
e_exit = wait_event(car_event(plate, exit_gates, Direction.IN), UNPROMPTED_EXIT_WAIT_S, "exit CarIn (unprompted)")
if not e_exit:
    sim.car_goto(plate, Destination.EXIT); log(f"-> goto {plate} exit")
    e_exit = wait_event(car_event(plate, exit_gates, Direction.IN), 90, "exit CarIn")
    if not e_exit: sys.exit(1)
exit_spot, exit_gate = e_exit["SpotName"], exit_gates[e_exit["SpotName"]]
log(f"<- {plate} reached {exit_spot} (gate {exit_gate})")

time.sleep(settings.exit_charge_delay_s)
parking = billing.parking_cost(parked_s, planned, car_type)
electric = billing.charging_cost(car_type)
sim.car_charge(plate, parking, electric)
log(f"-> charge {plate} parkingCost={parking} chargingCost={electric} "
    f"(rounding={settings.billing_rounding}, measured {parked_s / 60:.2f} min, planned {planned})")

pay = wait_event(lambda e: e.get("EventClass") == EventClass.PAYMENT_MADE and e.get("CarPlateNumber") == plate,
                 60, "payment")
if pay:
    ok = abs(float(pay["Amount"]) - (parking + electric)) <= settings.payment_tolerance
    log(f"<- payment_made Amount={pay['Amount']} -> {'MATCHES' if ok else 'MISMATCH (fake?)'}")

if exit_gate:
    sim.open_gate(exit_gate); log(f"-> open {exit_gate}")
sim.car_goto(plate, Destination.LEAVE_PARK); log(f"-> goto {plate} leavepark")
if wait_event(car_event(plate, exit_spot, Direction.OUT), 60, "exit CarOut"):
    log(f"<- {plate} left the car park. DONE")

pen = [e for e in httpx.get(f"{LISTENER}/debug/recent", params={"n": 200}).json()
       if e.get("EventClass") == EventClass.PENALTY and e.get("EventId") in seen | {None}]
log(f"Penalty events seen: {len(pen)}")
for p in pen:
    log(f"   {p.get('Reason')} fine={p.get('FineAmount')}")

"""The car park brain (workstream 1).

Webhooks are queued by the web layer and processed here, one at a time, on a single
worker thread. All state lives in this object and is only mutated on that thread,
so handlers never race each other. The web layer reads it through snapshot().

The site is a set of lanes discovered at startup (see app/topology.py): every entry
sensor has its own FIFO queue and barrier, every exit sensor its own barrier.

Car lifecycle:
  entry CarIn   -> queue on that lane; turn away with 'leavepark' if no spot will be left
  (dispatch)    -> reserve a spot, open the lane's gate, on gate Open: goto <spot>
  entry CarOut  -> dispatch the lane's next car, else close its gate after a delay
  spot CarIn    -> occupied, parking starts (sim time)
  spot CarOut   -> spot free, parking ends; the car drives to an exit by itself
  exit CarIn    -> charge exactly once, after the sensor settles
  payment_made  -> amount == invoice ? open that exit's gate, goto leavepark : hold
  exit CarOut   -> session finished and stored; close the exit gate after a delay
"""
from __future__ import annotations

import json
import logging
import queue
import re
import statistics
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable

import httpx

from app import allocation, billing, store, topology
from app.config import Settings, settings as default_settings
from app.protocol import (CORRECT_AMOUNT_PATTERN, SIM_TIME_FORMAT, CarType, ComponentType, Destination,
                          Direction, EventClass, GateState, PenaltyReason, SpotPurpose)
from app.sim_client import SimClient, SimError

log = logging.getLogger("controller")


def sim_seconds_between(start: str | None, end: str | None) -> float | None:
    if not start or not end:
        return None
    return (datetime.strptime(end, SIM_TIME_FORMAT) - datetime.strptime(start, SIM_TIME_FORMAT)).total_seconds()


# =============================================================================
# state
# =============================================================================
@dataclass
class Spot:
    name: str
    zone: str
    purpose: str                      # SpotPurpose
    car_type: str                     # CarType the spot is for (Any = every car)
    broken: bool = False
    maintenance: bool = False
    occupant: str | None = None       # plate physically in the spot ("?" = unknown car)
    reserved_for: str | None = None   # plate sent here but not arrived yet
    detected: int = 0                 # car count from the last list-parking-spots

    @property
    def available(self) -> bool:
        return (self.purpose == SpotPurpose.PARK and not self.broken and not self.maintenance
                and self.occupant is None and self.reserved_for is None)

    def accepts(self, car_type: str) -> bool:
        return self.car_type == CarType.ANY or self.car_type.lower() == (car_type or "").lower()


@dataclass
class Gate:
    name: str
    zone: str
    state: str = GateState.CLOSED
    broken: bool = False
    maintenance: bool = False
    on_open: list = field(default_factory=list, repr=False)  # callbacks run once Open
    open_requested_at: float | None = field(default=None, repr=False)
    open_retries: int = field(default=0, repr=False)

    @property
    def operable(self) -> bool:
        return not self.broken and not self.maintenance


@dataclass
class EntryLane:
    spot: str
    gate: str | None
    zone: str
    queue: deque = field(default_factory=deque)   # plates waiting, FIFO
    current: str | None = None                    # plate dispatched, not yet off the sensor


@dataclass
class ExitLane:
    spot: str
    gate: str | None
    zone: str
    releasing: set = field(default_factory=set)   # paid plates sent to leavepark, not out yet


@dataclass
class Car:
    plate: str
    car_type: str
    planned_minutes: int | None
    status: str                       # queued, dispatching, dispatched, entering, parked, to_exit,
                                      # at_exit, invoiced, payment_mismatch, released,
                                      # turned_away, neglected, lost, gone
    entry_lane: str | None = None
    exit_lane: str | None = None
    arrived_at: str | None = None     # sim time at entry CarIn
    spot: str | None = None
    parked_at: str | None = None
    left_spot_at: str | None = None
    exit_at: str | None = None
    charge_parking: float | None = None
    charge_electric: float | None = None
    charge_attempts: int = 0
    charge_override: float | None = None   # amount the simulator told us is correct
    paid: float | None = None
    payment_ok: bool | None = None
    left_at: str | None = None
    # bookkeeping (real clock)
    arrived_real: float | None = field(default=None, repr=False)
    dispatched_real: float | None = field(default=None, repr=False)
    parked_real: float | None = field(default=None, repr=False)
    left_spot_real: float | None = field(default=None, repr=False)
    dispatch_retries: int = field(default=0, repr=False)
    charge_scheduled: bool = field(default=False, repr=False)


_INTERNAL_CAR_FIELDS = ("arrived_real", "dispatched_real", "parked_real", "left_spot_real",
                        "dispatch_retries", "charge_scheduled")
_AT_EXIT_STATES = ("at_exit", "invoiced", "payment_mismatch", "released")
_ENTRY_STATES = ("dispatching", "dispatched")
_DEAD_STATES = ("turned_away", "neglected", "lost", "unknown")


# =============================================================================
# controller
# =============================================================================
class Controller:
    def __init__(self, sim: SimClient, cfg: Settings | None = None,
                 topologies: list[topology.Topology] | None = None):
        self.sim = sim
        self.cfg = cfg or default_settings
        self.allocator = allocation.get(self.cfg.allocation_strategy)
        self._topology_candidates = topologies   # injected (tests); else loaded from disk

        self.lock = threading.RLock()
        self.q: queue.Queue = queue.Queue()
        self.synced = False
        self.replaying = False   # rebuilding state from the log: no commands, no timers
        self._replayed_ids: set = set()
        self._stop = threading.Event()
        self._last_resync_request = 0.0
        self._last_event_real: float | None = None

        self.topology: topology.Topology | None = None
        self.spots: dict[str, Spot] = {}
        self.gates: dict[str, Gate] = {}
        self.entry_lanes: dict[str, EntryLane] = {}
        self.exit_lanes: dict[str, ExitLane] = {}
        self.cars: dict[str, Car] = {}            # active cars by plate
        self.recent_paid: dict[str, float] = {}   # plate -> when its paid session ended
        # game seconds per real second, learned from completed stays
        self._scale_samples: deque[float] = deque(maxlen=self.cfg.time_scale_samples)
        self.timers: list[tuple[float, str, Callable]] = []

        self.completed: deque[dict] = deque(maxlen=self.cfg.completed_sessions_size)
        self.feed: deque[dict] = deque(maxlen=self.cfg.feed_size)
        self.counters = {"arrived": 0, "admitted": 0, "turned_away": 0, "neglected": 0,
                         "exited": 0, "revenue": 0.0, "payment_mismatches": 0, "repeat_exits": 0,
                         "escaped": 0, "penalties": 0, "fines": 0.0, "command_errors": 0}

    @property
    def time_scale(self) -> float:
        """Game seconds per real second (= the simulator's GameSpeedMultiplier)."""
        if self._scale_samples:
            return statistics.median(self._scale_samples)
        return self.cfg.initial_time_scale

    def _learn_time_scale(self, car: Car):
        # A car stays exactly its planned game minutes, so planned / measured-real
        # recovers the game speed without it having to be configured anywhere.
        if car.planned_minutes and car.parked_real and car.left_spot_real:
            real_s = car.left_spot_real - car.parked_real
            if real_s > 5:
                ratio = car.planned_minutes * 60 / real_s
                if 0.1 < ratio < 20:
                    self._scale_samples.append(ratio)

    # -------------------------------------------------------------------------
    # lifecycle
    # -------------------------------------------------------------------------
    def start(self):
        threading.Thread(target=self._worker, name="controller", daemon=True).start()
        threading.Thread(target=self._ticker, name="controller-tick", daemon=True).start()

    def stop(self):
        self._stop.set()

    def submit(self, event: dict):
        self.q.put(("event", event))

    def request_resync(self):
        self.q.put(("resync", None))

    def _ticker(self):
        while not self._stop.wait(self.cfg.tick_interval_s):
            self.q.put(("tick", None))

    def _worker(self):
        # Events arriving before the first sync wait in the queue; processing them
        # against an empty map would turn every car away.
        while not self._stop.is_set() and not self.synced:
            try:
                with self.lock:
                    self.sync(replay_log=self.cfg.event_log_path)
            except (SimError, httpx.HTTPError) as e:
                log.warning("sync failed (%s), retrying in 2s", e)
                self._stop.wait(2)
        while not self._stop.is_set():
            kind, payload = self.q.get()
            try:
                with self.lock:
                    if kind == "event":
                        self.handle(payload)
                    elif kind == "tick":
                        self.tick()
                    elif kind == "resync":
                        self.sync()
            except Exception:
                log.exception("controller failed on %s %s", kind, payload)

    # -------------------------------------------------------------------------
    # sync (list-* endpoints are costly: startup, level change or crash only)
    # -------------------------------------------------------------------------
    def sync(self, replay_log: Path | None = None):
        """Load spots and gates from the simulator, resolve the site topology and, on
        first start, rebuild car state by replaying our event log."""
        live_spots = self.sim.list_parking_spots()
        live_gates = self.sim.list_barriers()

        entry = {s["name"] for s in live_spots if s.get("purpose") == SpotPurpose.ENTRY}
        exit_ = {s["name"] for s in live_spots if s.get("purpose") == SpotPurpose.EXIT}
        level_changed = self.topology is not None and not self.topology.matches(entry, exit_)
        if self.topology is None or level_changed:
            if level_changed:
                self.note("warn", "site layout changed (new level?) - resetting state")
                self._reset()
            self.topology = topology.resolve(live_spots, live_gates, self.cfg.topology_dir,
                                             self.cfg.sim_levels_dir, self.cfg.topology_max_gate_distance,
                                             candidates=self._topology_candidates)
            self.entry_lanes = {l.spot: EntryLane(l.spot, l.gate, l.zone) for l in self.topology.entry_lanes}
            self.exit_lanes = {l.spot: ExitLane(l.spot, l.gate, l.zone) for l in self.topology.exit_lanes}

        first = not self.synced
        for s in live_spots:
            spot = self.spots.get(s["name"]) or Spot(s["name"], s.get("zoneParent") or "", s["purpose"],
                                                     s.get("parkingForCarType") or CarType.ANY)
            spot.broken, spot.maintenance = s["broken"], s["isUnderMaintenance"]
            spot.detected = s.get("detectedCars") or 0   # a count on Level 1, not a list of plates
            self.spots[spot.name] = spot
        if first and replay_log:
            self.replay(replay_log)
        # Live state wins over anything replayed.
        for g in live_gates:
            gate = self.gates.get(g["name"]) or Gate(g["name"], g.get("zoneParent") or "")
            gate.state, gate.broken, gate.maintenance = g["state"], g["broken"], g["isUnderMaintenance"]
            self.gates[gate.name] = gate
        self.reconcile(startup=first or level_changed)
        self.synced = True

        park = [s for s in self.spots.values() if s.purpose == SpotPurpose.PARK]
        self.note("info", f"Synced '{self.topology.name}': {len(self.entry_lanes)} entries, "
                          f"{len(self.exit_lanes)} exits, {len(park)} park spots "
                          f"({sum(1 for s in park if s.available)} free); tracking {len(self.cars)} cars")
        for lane in self.entry_lanes.values():
            self.pump_entry(lane)
        if self.cfg.close_idle_gates_on_sync:
            for name in {l.gate for l in [*self.entry_lanes.values(), *self.exit_lanes.values()] if l.gate}:
                self.close_gate_if_idle(name)

    def _reset(self):
        self.spots, self.gates, self.cars, self.timers = {}, {}, {}, []
        self.entry_lanes, self.exit_lanes = {}, {}

    def replay(self, path: Path):
        """Feed recent logged events back through the handlers with commands disabled."""
        cutoff = time.time() - self.cfg.replay_window_s
        records = []
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if r.get("_accepted", True) and (_ts(r.get("_received_at")) or 0) >= cutoff:
                        records.append(r)
        except FileNotFoundError:
            return
        newest = max((_ts(r.get("_received_at")) or 0 for r in records), default=0)
        if time.time() - newest > self.cfg.replay_max_gap_s:
            log.info("event log is %s old - simulator likely restarted since; starting fresh",
                     f"{time.time() - newest:.0f}s" if newest else "empty/too")
            return
        self.replaying = True
        try:
            for r in records:
                self.handle(r)
        finally:
            self.replaying = False
        log.info("replayed %d events from %s", len(records), path)

    def reconcile(self, startup: bool = True):
        """Make replayed/remembered state agree with what the sensors report right now.
        startup=False (a live resync) leaves lanes alone: a car may be mid-dispatch."""
        if startup:
            self._reconcile_lanes()
        for s in self.spots.values():
            if s.purpose != SpotPurpose.PARK:
                continue
            if s.detected and not s.occupant:
                s.occupant = "?"
            elif not s.detected and s.occupant:
                car = self.cars.get(s.occupant)
                if car and car.status == "parked":
                    self._drop(car.plate)
                s.occupant = None

        for car in list(self.cars.values()):
            sensor = self.spots.get(car.exit_lane) if car.exit_lane else None
            if car.status in _AT_EXIT_STATES and not (sensor and sensor.detected):
                self._drop(car.plate)
            elif car.status == "at_exit":
                self.schedule_charge(car.plate, self.cfg.exit_charge_delay_s)
            elif car.status == "released":
                self.release(car)
            elif car.status in _DEAD_STATES:
                self._drop(car.plate)

    def _reconcile_lanes(self):
        now = time.time()
        for s in self.spots.values():   # nobody is mid-dispatch after a (re)start
            s.reserved_for = None

        for lane in self.entry_lanes.values():
            sensor = self.spots.get(lane.spot)
            if lane.current:
                car = self.cars.get(lane.current)
                if car and car.status in _ENTRY_STATES:
                    self._drop(car.plate)
                lane.current = None
            keep = deque()
            for plate in lane.queue:
                car = self.cars.get(plate)
                alive = (car and sensor and sensor.detected
                         and now - (car.arrived_real or 0) < self.cfg.entry_patience_s / self.time_scale)
                (keep.append if alive else self._drop)(plate)
            lane.queue = keep

    # -------------------------------------------------------------------------
    # event routing
    # -------------------------------------------------------------------------
    def handle(self, e: dict):
        # Events that arrived during startup are both in the replayed log and in the
        # live queue; process each only once.
        eid = e.get("EventId")
        if self.replaying:
            self._replayed_ids.add(eid)
        elif eid and eid in self._replayed_ids:
            return
        if not self.replaying:
            now = time.time()
            if self._last_event_real and now - self._last_event_real > self.cfg.resync_after_silence_s:
                # The simulator was probably restarted or reloaded while we kept running.
                self._maybe_resync(f"no events for {now - self._last_event_real:.0f}s")
            self._last_event_real = now

        ec = e.get("EventClass")
        if ec == EventClass.CAR_SPOT_ACTION:
            self._route_car_event(e)
        elif ec == EventClass.GATE_ACTION:
            self.on_gate(e)
        elif ec == EventClass.PAYMENT_MADE:
            self.on_payment(e)
        elif ec in (EventClass.COMPONENT_BROKEN, EventClass.COMPONENT_FIXED):
            self.on_component(e, broken=(ec == EventClass.COMPONENT_BROKEN))
        elif ec == EventClass.PENALTY:
            self.on_penalty(e)

    def _route_car_event(self, e: dict):
        name, spot_type = e.get("SpotName"), e.get("SpotType")
        car_in = e.get("Direction") == Direction.IN
        if name in self.entry_lanes:
            lane = self.entry_lanes[name]
            (self.on_entry_in if car_in else self.on_entry_out)(e, lane)
        elif name in self.exit_lanes:
            lane = self.exit_lanes[name]
            (self.on_exit_in if car_in else self.on_exit_out)(e, lane)
        elif spot_type == SpotPurpose.PARK:
            (self.on_spot_in if car_in else self.on_spot_out)(e)
        elif spot_type in (SpotPurpose.ENTRY, SpotPurpose.EXIT) and not self.replaying:
            self._maybe_resync(f"event from unknown {spot_type} {name}")

    def _maybe_resync(self, why: str):
        """An entry/exit we don't know means the layout changed: reload it (rate-limited)."""
        if time.time() - self._last_resync_request > 10:
            self._last_resync_request = time.time()
            self.note("warn", f"{why} - resyncing")
            self.request_resync()

    # -------------------------------------------------------------------------
    # entry
    # -------------------------------------------------------------------------
    def on_entry_in(self, e, lane: EntryLane):
        plate = e["CarPlateNumber"]
        stale = self.cars.get(plate)
        if stale:
            if any(plate in l.queue or l.current == plate for l in self.entry_lanes.values()):
                return   # repeated sensor event for a car already being handled
            # A car at an entry is outside the car park, so any other record for this
            # plate is stale (plates are reused, e.g. after a simulator restart).
            self.note("warn", f"{plate} arrived at {lane.spot} while recorded as '{stale.status}' - "
                              f"replacing stale record")
            self._forget(stale)
        car = Car(plate, e.get("CarType") or CarType.NORMAL, _int(e.get("PlannedParkingDurationInMinutes")),
                  "queued", entry_lane=lane.spot, arrived_at=e.get("ServerDateTime"),
                  arrived_real=_ts(e.get("_received_at")) or time.time())
        self.cars[plate] = car
        self.counters["arrived"] += 1

        # Spots are reserved at dispatch time, so every car already queued for the same
        # pool of spots still needs one.
        free = len(self.allocator.candidates(car.car_type, lane.zone, self.spots.values()))
        waiting = sum(len(l.queue) for l in self.entry_lanes.values()
                      if self.allocator.shares_pool(l.zone, lane.zone))
        if free - waiting <= 0:
            self.turn_away(car, "no free spot")
            return
        lane.queue.append(plate)
        self.note("info", f"{plate} arrived at {lane.spot} ({car.car_type}, planned {car.planned_minutes}m), "
                          f"queue={len(lane.queue)}")
        self.pump_entry(lane)

    def pump_entry(self, lane: EntryLane):
        """Dispatch the head of the lane's queue if the lane is free."""
        if lane.current or not lane.queue:
            return
        gate = self.gates.get(lane.gate) if lane.gate else None
        if lane.gate and (gate is None or not gate.operable):
            return   # holding the queue; on_component() pumps again once the gate is fixed
        plate = lane.queue.popleft()
        car = self.cars[plate]
        spot = self.allocator.choose(car.car_type, lane.zone, self.spots.values())
        if spot is None:
            self.turn_away(car, "no suitable spot")
            self.pump_entry(lane)
            return
        spot.reserved_for = plate
        car.spot, car.status = spot.name, "dispatching"
        car.dispatched_real = time.time()
        lane.current = plate
        send = lambda: self._send_to_spot(plate, lane)
        self.when_gate_open(gate, send) if gate else send()

    def _send_to_spot(self, plate: str, lane: EntryLane):
        car = self.cars.get(plate)
        if car is None or lane.current != plate:
            return
        if self.cmd("goto", self.sim.car_goto, plate, car.spot):
            car.status = "dispatched"
            car.dispatched_real = time.time()
            self.counters["admitted"] += 1
            self.note("info", f"{plate} -> {car.spot}")

    def on_entry_out(self, e, lane: EntryLane):
        plate = e["CarPlateNumber"]
        car = self.cars.get(plate)
        if plate == lane.current:
            car.status = "entering"
            lane.current = None
            if lane.queue:
                self.pump_entry(lane)
            else:
                self.later(self.cfg.gate_close_delay_s, f"close {lane.gate}",
                           lambda: self.close_gate_if_idle(lane.gate))
        elif plate in lane.queue:
            lane.queue.remove(plate)
            car.status = "neglected"
            self.counters["neglected"] += 1
            self.note("warn", f"{plate} gave up waiting at {lane.spot}")
            self.finish(car, e)
        elif car and car.status == "turned_away":
            self.finish(car, e)

    def turn_away(self, car: Car, reason: str):
        car.status = "turned_away"
        self.counters["turned_away"] += 1
        self.note("warn", f"{car.plate} turned away: {reason}")
        self.cmd("goto", self.sim.car_goto, car.plate, Destination.LEAVE_PARK)

    # -------------------------------------------------------------------------
    # parking spots
    # -------------------------------------------------------------------------
    def on_spot_in(self, e):
        plate, name = e["CarPlateNumber"], e["SpotName"]
        spot = self.spots.get(name) or self.spots.setdefault(
            name, Spot(name, "", SpotPurpose.PARK, CarType.ANY))
        car = self.cars.get(plate) or self._adopt(e)
        if car.spot and car.spot != name:
            self.note("warn", f"{plate} parked in {name}, was sent to {car.spot}")
            other = self.spots.get(car.spot)
            if other and other.reserved_for == plate:
                other.reserved_for = None
        if spot.reserved_for == plate:
            spot.reserved_for = None
        spot.occupant = plate
        car.spot, car.status, car.parked_at = name, "parked", e.get("ServerDateTime")
        car.parked_real = _ts(e.get("_received_at"))
        car.planned_minutes = _int(e.get("PlannedParkingDurationInMinutes")) or car.planned_minutes
        lane = self.entry_lanes.get(car.entry_lane or "")
        if lane and lane.current == plate:   # parked without an entry CarOut we saw
            lane.current = None
            self.pump_entry(lane)
        self.note("info", f"{plate} parked in {name}")

    def on_spot_out(self, e):
        plate, name = e["CarPlateNumber"], e["SpotName"]
        spot = self.spots.get(name)
        if spot and spot.occupant in (plate, "?"):
            spot.occupant = None
        car = self.cars.get(plate) or self._adopt(e)
        car.left_spot_at = e.get("ServerDateTime")
        car.left_spot_real = _ts(e.get("_received_at"))
        self._learn_time_scale(car)
        # Only advance the state. From a spot right next to an exit (S15 on Level 1)
        # the exit CarIn arrives ~0.2s BEFORE this CarOut; overwriting "at_exit" here
        # would cancel the pending charge and the car escapes unpaid.
        if car.status in ("parked", "unknown"):
            car.status = "to_exit"
        self.note("info", f"{plate} left {name}")
        for lane in self.entry_lanes.values():   # a spot just freed up
            self.pump_entry(lane)

    # -------------------------------------------------------------------------
    # exit & payment
    # -------------------------------------------------------------------------
    def on_exit_in(self, e, lane: ExitLane):
        plate = e["CarPlateNumber"]
        car = self.cars.get(plate) or self._adopt(e)
        car.exit_lane, car.exit_at = lane.spot, e.get("ServerDateTime")
        if car.charge_parking is not None:
            return  # already invoiced: charging twice is a penalty
        if car.entry_lane is None and car.plate in self.recent_paid:
            # Paid moments ago and never came back through an entry: the same session
            # looping (seen with cars restored from a simulator save), not a new one.
            self.counters["repeat_exits"] += 1
            self.note("warn", f"{plate} back at {lane.spot} after paying, without entering - "
                              f"not billing again, releasing")
            car.payment_ok = True
            self.release(car)
            return
        car.status = "at_exit"
        # Charging the instant the sensor fires is rejected ("Car should be charged at
        # the exit"): give the car a moment to settle on the exit spot.
        self.schedule_charge(plate, self.cfg.exit_charge_delay_s)

    def schedule_charge(self, plate: str, delay_s: float):
        car = self.cars.get(plate)
        if self.replaying or car is None or car.charge_scheduled:
            return   # after a replay, reconcile() schedules charges for cars still at an exit
        car.charge_scheduled = True
        self.later(delay_s, f"charge {plate}", lambda: self._charge(plate))

    def _charge(self, plate: str):
        car = self.cars.get(plate)
        if car is None:
            return
        car.charge_scheduled = False
        if car.status != "at_exit" or car.charge_parking is not None:
            return
        car.charge_attempts += 1
        game_s = self._parked_game_seconds(car)
        if car.charge_override is not None:
            parking, basis = car.charge_override, "amount stated by simulator"
        else:
            if game_s is None and not car.planned_minutes:
                self.note("warn", f"{plate}: no parking times and no planned duration, billing 1 minute")
            parking = billing.parking_cost(game_s or 60, car.planned_minutes, car.car_type, self.cfg)
            basis = (f"planned {car.planned_minutes}m, measured "
                     + (f"{game_s / 60:.2f}" if game_s is not None else "?") + " game-min")
        electric = billing.charging_cost(car.car_type, self.cfg)
        if self.cmd("charge", self.sim.car_charge, plate, parking, electric):
            car.charge_parking, car.charge_electric, car.status = parking, electric, "invoiced"
            self.note("info", f"{plate} invoiced {parking + electric:.2f} ({basis})")
        # On an HTTP failure we do NOT retry: the charge may have registered, and a second
        # one is a penalty. A rejection arrives as a penalty event instead (on_penalty).

    def _parked_game_seconds(self, car: Car) -> float | None:
        """How long the car was parked, in game time."""
        if car.parked_real and car.left_spot_real:
            real_s = car.left_spot_real - car.parked_real
        else:
            real_s = sim_seconds_between(car.parked_at, car.left_spot_at)   # wall-clock stamps
        return real_s * self.time_scale if real_s is not None else None

    def on_payment(self, e):
        plate = e["CarPlateNumber"]
        amount = float(e.get("Amount") or 0)
        car = self.cars.get(plate)
        if car is None or car.charge_parking is None:
            self.note("warn", f"payment {amount:.2f} from {plate} with no invoice - ignored")
            return
        expected = car.charge_parking + (car.charge_electric or 0)
        car.paid = amount
        if abs(amount - expected) <= self.cfg.payment_tolerance:
            car.payment_ok = True
            self.counters["revenue"] += amount
            self.release(car)
        else:
            car.payment_ok, car.status = False, "payment_mismatch"
            self.counters["payment_mismatches"] += 1
            self.note("error", f"{plate} paid {amount:.2f}, invoice {expected:.2f} - NOT releasing")

    def release(self, car: Car):
        car.status = "released"
        lane = self.exit_lanes.get(car.exit_lane or "")
        if lane:
            lane.releasing.add(car.plate)
        gate = self.gates.get(lane.gate) if lane and lane.gate else None
        leave = lambda: self.cmd("goto", self.sim.car_goto, car.plate, Destination.LEAVE_PARK)
        if lane and lane.gate and (gate is None or not gate.operable):
            self.note("warn", f"exit gate {lane.gate} not operable - {car.plate} waits")
            return
        self.when_gate_open(gate, leave) if gate else leave()

    def on_exit_out(self, e, lane: ExitLane):
        plate = e["CarPlateNumber"]
        car = self.cars.get(plate) or self._adopt(e)
        if car.status != "released":
            self.counters["escaped"] += 1
            self.note("error", f"{plate} left without being released (status {car.status})")
        lane.releasing.discard(plate)
        self.counters["exited"] += 1
        self.finish(car, e)
        self.later(self.cfg.gate_close_delay_s, f"close {lane.gate}", lambda: self.close_gate_if_idle(lane.gate))

    # -------------------------------------------------------------------------
    # penalties, gates & components
    # -------------------------------------------------------------------------
    def on_penalty(self, e):
        self.counters["penalties"] += 1
        self.counters["fines"] += float(e.get("FineAmount") or 0)
        reason = e.get("Reason") or ""
        self.note("error", f"PENALTY {e.get('FineAmount')}: {reason} ({e.get('ComponentName')})")

        car = self._car_by_component(e.get("ComponentName"))
        if not car or car.status != "invoiced":
            return
        lowered = reason.lower()
        if PenaltyReason.CHARGE_NOT_AT_EXIT in lowered:
            # Rejected for timing: the car is still at the exit without an invoice.
            self._rebill(car, override=None)
        elif PenaltyReason.CHARGED_WRONGLY in lowered and self.cfg.recharge_on_wrong_amount:
            # Rejected for amount, and the simulator says what it should be. Left alone the
            # car never pays, sits on the exit sensor and blocks every car behind it.
            m = re.search(CORRECT_AMOUNT_PATTERN, reason)
            if m:
                self._rebill(car, override=float(m.group(1)))

    def _rebill(self, car: Car, override: float | None):
        car.charge_parking = car.charge_electric = None
        car.charge_override = override
        car.status = "at_exit"
        if car.charge_attempts < self.cfg.max_charge_attempts:
            self.schedule_charge(car.plate, self.cfg.exit_charge_retry_s)
        else:
            self.note("error", f"{car.plate}: invoice rejected {car.charge_attempts}x, giving up")

    def _car_by_component(self, name: str | None) -> Car | None:
        """Penalties name cars without the space ('QNL430' for 'QNL 430')."""
        if not name:
            return None
        key = name.replace(" ", "")
        return next((c for p, c in self.cars.items() if p.replace(" ", "") == key), None)

    def on_gate(self, e):
        gate = self.gates.get(e["Name"]) or self.gates.setdefault(e["Name"], Gate(e["Name"], ""))
        gate.state = e["Action"]
        if gate.state == GateState.OPEN:
            self._gate_opened(gate)
        elif gate.state == GateState.CLOSED and gate.on_open:
            # An "open" sent while the gate was still closing is silently dropped by the
            # simulator: ask again now that it has finished closing.
            self._request_open(gate)

    def _gate_opened(self, gate: Gate):
        gate.open_requested_at, gate.open_retries = None, 0
        callbacks, gate.on_open = gate.on_open, []
        for fn in callbacks:
            fn()

    def when_gate_open(self, gate: Gate, fn: Callable):
        if gate.state == GateState.OPEN:
            fn()
            return
        gate.on_open.append(fn)
        if gate.state != GateState.OPENING:
            self._request_open(gate)
        elif gate.open_requested_at is None:
            gate.open_requested_at = time.time()   # opening per sync: still arm the timeout

    def _request_open(self, gate: Gate):
        if self.cmd("open", self.sim.open_gate, gate.name):
            gate.state = GateState.OPENING
            gate.open_requested_at = time.time()

    def _check_gate_timeouts(self, now: float):
        """The simulator does not always confirm an opening: re-send once, then assume open."""
        for gate in self.gates.values():
            if not gate.on_open or gate.open_requested_at is None:
                continue
            if now - gate.open_requested_at < self.cfg.gate_open_timeout_s:
                continue
            if gate.open_retries == 0:
                gate.open_retries = 1
                self.note("warn", f"{gate.name} did not confirm opening, re-sending open")
                self._request_open(gate)
            else:
                self.note("warn", f"{gate.name} still unconfirmed, assuming it is open")
                gate.state = GateState.OPEN
                self._gate_opened(gate)

    def gate_busy(self, name: str) -> bool:
        return (any(l.gate == name and (l.current or l.queue) for l in self.entry_lanes.values())
                or any(l.gate == name and l.releasing for l in self.exit_lanes.values()))

    def close_gate_if_idle(self, name: str | None):
        gate = self.gates.get(name) if name else None
        if (gate and gate.operable and not self.gate_busy(name) and not gate.on_open
                and gate.state in (GateState.OPEN, GateState.OPENING)):
            if self.cmd("close", self.sim.close_gate, name):
                gate.state = GateState.CLOSING

    def on_component(self, e, broken: bool):
        name, kind = e.get("Name"), e.get("Type")
        target = self.gates.get(name) if kind == ComponentType.BARRIER_GATE else self.spots.get(name)
        if target is not None:
            target.broken = broken
            if not broken:
                target.maintenance = False
        self.note("error" if broken else "info", f"{kind} {name} {'BROKEN' if broken else 'fixed'}")
        if not broken:
            for lane in self.entry_lanes.values():
                self.pump_entry(lane)

    # -------------------------------------------------------------------------
    # housekeeping
    # -------------------------------------------------------------------------
    def tick(self):
        now = time.time()
        due = [t for t in self.timers if t[0] <= now]
        self.timers = [t for t in self.timers if t[0] > now]
        for _, _, fn in due:
            fn()
        self._check_gate_timeouts(now)
        for lane in self.entry_lanes.values():
            self._check_dispatch_timeout(lane, now)
        horizon = now - self.cfg.repeat_exit_window_s
        self.recent_paid = {p: t for p, t in self.recent_paid.items() if t >= horizon}

    def _check_dispatch_timeout(self, lane: EntryLane, now: float):
        car = self.cars.get(lane.current) if lane.current else None
        if not (car and car.dispatched_real and now - car.dispatched_real > self.cfg.entry_dispatch_timeout_s):
            return
        if car.dispatch_retries < self.cfg.max_dispatch_retries:
            car.dispatch_retries += 1
            car.dispatched_real = now
            self.note("warn", f"{car.plate} has not left {lane.spot}, re-sending goto {car.spot}")
            self._send_to_spot(car.plate, lane)
            return
        self.note("error", f"{car.plate} stuck at {lane.spot}, releasing the lane")
        spot = self.spots.get(car.spot)
        if spot and spot.reserved_for == car.plate:
            spot.reserved_for = None
        car.status, car.spot = "lost", None
        lane.current = None
        self.pump_entry(lane)

    def later(self, delay_s: float, label: str, fn: Callable):
        if self.replaying:
            return   # reconcile() re-arms whatever is still relevant after a replay
        self.timers.append((time.time() + delay_s, label, fn))

    def _adopt(self, e) -> Car:
        """A car we have no record of (e.g. it arrived before we started)."""
        plate = e["CarPlateNumber"]
        car = Car(plate, e.get("CarType") or CarType.NORMAL,
                  _int(e.get("PlannedParkingDurationInMinutes")), "unknown")
        self.cars[plate] = car
        self.note("warn", f"adopted unknown car {plate} at {e.get('SpotName')}")
        return car

    def _drop(self, plate: str):
        self.cars.pop(plate, None)

    def _forget(self, car: Car):
        """Remove a car record and anything it still holds (spot, lanes)."""
        for s in self.spots.values():
            if s.occupant == car.plate:
                s.occupant = None
            if s.reserved_for == car.plate:
                s.reserved_for = None
        for lane in self.exit_lanes.values():
            lane.releasing.discard(car.plate)
        self._drop(car.plate)

    def finish(self, car: Car, e: dict):
        car.left_at = e.get("ServerDateTime")
        if car.status not in ("neglected", "turned_away", "lost"):
            car.status = "gone"
        if car.payment_ok:
            self.recent_paid[car.plate] = time.time()
        session = self._public(car)
        session["parked_seconds"] = sim_seconds_between(car.parked_at, car.left_spot_at)
        self.completed.append(session)
        if not self.replaying:   # already stored the first time round
            store.record_session(session)
        self.cars.pop(car.plate, None)

    def cmd(self, what: str, fn: Callable, *args) -> bool:
        if self.replaying:
            return True   # the command was sent the first time round
        t0 = time.perf_counter()
        ok, err = True, None
        try:
            fn(*args)
        except (SimError, httpx.HTTPError) as ex:
            ok, err = False, str(ex)
            self.counters["command_errors"] += 1
            self.note("error", f"command {what}{args} failed: {err}")
        store.record_action({"at": datetime.now().isoformat(timespec="milliseconds"), "cmd": what,
                             "args": [str(a) for a in args], "ok": ok, "error": err,
                             "ms": round((time.perf_counter() - t0) * 1000, 1)})
        return ok

    def note(self, level: str, msg: str):
        if self.replaying:
            return
        self.feed.append({"at": datetime.now().isoformat(timespec="seconds"), "level": level, "msg": msg})
        {"info": log.info, "warn": log.warning, "error": log.error}.get(level, log.info)(msg)

    @staticmethod
    def _public(car: Car) -> dict:
        return {k: v for k, v in asdict(car).items() if k not in _INTERNAL_CAR_FIELDS}

    # -------------------------------------------------------------------------
    # read model for the web layer
    # -------------------------------------------------------------------------
    def snapshot(self) -> dict:
        with self.lock:
            zones: dict[str, dict] = {}
            for s in self.spots.values():
                if s.purpose != SpotPurpose.PARK:
                    continue
                z = zones.setdefault(s.zone or "-", {"total": 0, "occupied": 0, "reserved": 0,
                                                     "free": 0, "out_of_service": 0})
                z["total"] += 1
                if s.broken or s.maintenance:
                    z["out_of_service"] += 1
                elif s.occupant:
                    z["occupied"] += 1
                elif s.reserved_for:
                    z["reserved"] += 1
                else:
                    z["free"] += 1
            return {
                "synced": self.synced,
                "time_scale": round(self.time_scale, 3),
                "topology": {"name": self.topology.name, "source": self.topology.source} if self.topology else None,
                "zones": zones,
                "spots": [asdict(s) | {"available": s.available}
                          for s in sorted(self.spots.values(),
                                          key=lambda s: (s.purpose, allocation.spot_number(s.name)))],
                "gates": [{"name": g.name, "zone": g.zone, "state": g.state, "broken": g.broken,
                           "maintenance": g.maintenance} for g in self.gates.values()],
                "entry_lanes": [{"spot": l.spot, "gate": l.gate, "zone": l.zone,
                                 "queue": list(l.queue), "current": l.current} for l in self.entry_lanes.values()],
                "exit_lanes": [{"spot": l.spot, "gate": l.gate, "zone": l.zone,
                                "releasing": sorted(l.releasing)} for l in self.exit_lanes.values()],
                "active_cars": [self._public(c) for c in self.cars.values()],
                "recent_sessions": list(self.completed)[-50:],
                "counters": dict(self.counters),
                "feed": list(self.feed)[-100:],
            }


def _ts(iso: str | None) -> float | None:
    try:
        return datetime.fromisoformat(iso).timestamp()
    except (TypeError, ValueError):
        return None


def _int(v) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None

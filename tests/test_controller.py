"""Controller logic against a fake simulator (no network).

Run from the repo root:  .venv\\Scripts\\python -m tests.test_controller
(pytest also works if installed:  .venv\\Scripts\\python -m pytest -q)
"""
import itertools
import json
import os
import tempfile
from datetime import datetime

os.environ["GPA_DATA_DIR"] = tempfile.mkdtemp(prefix="gpa-test-")

from app import allocation, topology  # noqa: E402
from app.config import Settings  # noqa: E402
from app.controller import Controller  # noqa: E402
from app.topology import LaneDef, Topology  # noqa: E402

_seq = itertools.count(1)

# One-zone site like Level 1
LVL1 = Topology("test-lvl1", [LaneDef("ENTRY1", "gateA", "ZONE1")], [LaneDef("EXIT_EXIT", "gateB", "ZONE1")])
# Two independent zones like Level 2
TWO_ZONES = Topology("test-2zones",
                     [LaneDef("ENTRY1", "g1", "ZONE1"), LaneDef("ENTRY2", "g3", "ZONE2")],
                     [LaneDef("EXIT_EXIT", "g2", "ZONE1"), LaneDef("Exit67", "g4", "ZONE2")])


def spot(name, purpose="Park", zone="ZONE1", car_type="Any", detected=0):
    return {"name": name, "purpose": purpose, "parkingForCarType": car_type, "zoneParent": zone,
            "detectedCars": detected, "broken": False, "isUnderMaintenance": False}


def gate(name, state="Closed", zone="ZONE1"):
    return {"name": name, "zoneParent": zone, "broken": False, "isUnderMaintenance": False, "state": state}


class FakeSim:
    def __init__(self, spots, gates):
        self.calls, self._spots, self._gates = [], spots, gates

    @classmethod
    def lvl1(cls, n_spots=3):
        return cls([spot(f"S{i}") for i in range(1, n_spots + 1)]
                   + [spot("ENTRY1", "EntrySpot", zone=""), spot("EXIT_EXIT", "ExitSpot")],
                   [gate("gateA", "Closed"), gate("gateB", "Open"), gate("gateC", "Open", zone="")])

    def list_parking_spots(self): return self._spots
    def list_barriers(self):      return self._gates
    def open_gate(self, n):       self.calls.append(("open", n))
    def close_gate(self, n):      self.calls.append(("close", n))
    def car_goto(self, p, d):     self.calls.append(("goto", p, d))
    def car_charge(self, p, pc, cc): self.calls.append(("charge", p, pc, cc))


SPOT_TYPES = {"ENTRY1": "EntrySpot", "ENTRY2": "EntrySpot", "EXIT_EXIT": "ExitSpot", "Exit67": "ExitSpot"}


def car_ev(plate, spot_name, direction, t, planned="2", car_type="Normal"):
    return {"EventClass": "car_spot_action", "CarPlateNumber": plate, "SpotName": spot_name,
            "SpotType": SPOT_TYPES.get(spot_name, "Park"), "CarType": car_type, "Direction": direction,
            "PlannedParkingDurationInMinutes": planned, "EventId": f"e{next(_seq)}",
            "ServerDateTime": f"2026-09-19 {t}"}


def gate_ev(name, action):
    return {"EventClass": "gate_action", "Name": name, "Action": action, "EventId": f"e{next(_seq)}"}


def pay_ev(plate, amount):
    return {"EventClass": "payment_made", "CarPlateNumber": plate, "Amount": f"{amount:.2f}",
            "Reason": "Car Payment", "EventId": f"e{next(_seq)}"}


def penalty_ev(component, reason="Car should be charged at the exit."):
    return {"EventClass": "penalty", "Reason": reason, "FineAmount": "10", "Type": "Car",
            "ComponentName": component, "EventId": f"e{next(_seq)}"}


def make(sim=None, topo=LVL1, **cfg):
    sim = sim or FakeSim.lvl1()
    cfg.setdefault("close_idle_gates_on_sync", False)   # keeps call logs simple; tested separately
    c = Controller(sim, cfg=Settings(**cfg), topologies=[topo])
    c.sync()
    return c, sim


def fire_timers(c):
    """Run every pending timer now, regardless of its delay."""
    c.timers = [(0, label, fn) for _, label, fn in c.timers]
    c.tick()


def charges(sim):
    return [x for x in sim.calls if x[0] == "charge"]


def gotos(sim):
    return [x for x in sim.calls if x[0] == "goto"]


def park_and_reach_exit(c, plate="A"):
    for ev in (gate_ev("gateA", "Open"), car_ev(plate, "ENTRY1", "CarIn", "10:00:00"),
               car_ev(plate, "ENTRY1", "CarOut", "10:00:02"), car_ev(plate, "S1", "CarIn", "10:00:05"),
               car_ev(plate, "S1", "CarOut", "10:03:05"), car_ev(plate, "EXIT_EXIT", "CarIn", "10:03:10")):
        c.handle(ev)


# ---------------------------------------------------------------------------
# lifecycle
# ---------------------------------------------------------------------------
def test_full_lifecycle():
    c, sim = make()
    c.handle(car_ev("AAA 1", "ENTRY1", "CarIn", "10:00:00"))
    assert sim.calls == [("open", "gateA")]                      # waits for Open before goto
    c.handle(gate_ev("gateA", "Open"))
    assert sim.calls[-1] == ("goto", "AAA 1", "S1")
    assert c.spots["S1"].reserved_for == "AAA 1"
    c.handle(car_ev("AAA 1", "ENTRY1", "CarOut", "10:00:02"))
    c.handle(car_ev("AAA 1", "S1", "CarIn", "10:00:05"))
    assert c.spots["S1"].occupant == "AAA 1" and c.spots["S1"].reserved_for is None
    c.handle(car_ev("AAA 1", "S1", "CarOut", "10:02:07"))       # 122 s parked
    c.handle(car_ev("AAA 1", "EXIT_EXIT", "CarIn", "10:02:15", planned="0"))
    assert charges(sim) == []                                    # not the instant it arrives
    fire_timers(c)
    assert sim.calls[-1] == ("charge", "AAA 1", 2.0, 0.0)        # round(2.03) = 2
    c.handle(car_ev("AAA 1", "EXIT_EXIT", "CarIn", "10:02:16", planned="0"))
    fire_timers(c)
    assert len(charges(sim)) == 1                                # never charge twice
    c.handle(pay_ev("AAA 1", 2))
    assert sim.calls[-1] == ("goto", "AAA 1", "leavepark")        # gateB already Open
    c.handle(car_ev("AAA 1", "EXIT_EXIT", "CarOut", "10:02:18", planned="0"))
    assert "AAA 1" not in c.cars
    s = c.completed[-1]
    assert s["payment_ok"] is True and s["parked_seconds"] == 122
    assert s["entry_lane"] == "ENTRY1" and s["exit_lane"] == "EXIT_EXIT"
    assert c.counters["revenue"] == 2 and c.counters["escaped"] == 0


def test_queue_is_fifo_one_car_at_a_time():
    c, sim = make()
    c.handle(gate_ev("gateA", "Open"))
    c.handle(car_ev("A", "ENTRY1", "CarIn", "10:00:00"))
    c.handle(car_ev("B", "ENTRY1", "CarIn", "10:00:01"))
    assert gotos(sim) == [("goto", "A", "S1")]                   # B waits for A to clear
    c.handle(car_ev("A", "ENTRY1", "CarOut", "10:00:03"))
    assert gotos(sim)[-1] == ("goto", "B", "S2")
    assert ("close", "gateA") not in sim.calls                   # still busy, gate stays open


def test_full_park_turns_cars_away():
    c, sim = make(FakeSim.lvl1(n_spots=1))
    c.handle(gate_ev("gateA", "Open"))
    c.handle(car_ev("A", "ENTRY1", "CarIn", "10:00:00"))
    c.handle(car_ev("B", "ENTRY1", "CarIn", "10:00:01"))
    assert ("goto", "B", "leavepark") in sim.calls
    assert c.counters["turned_away"] == 1


def test_queued_spot_accounting_turns_away_early():
    # 1 free spot, A queued (gate still opening) -> B must be turned away, not queued
    c, sim = make(FakeSim.lvl1(n_spots=1))
    c.handle(car_ev("A", "ENTRY1", "CarIn", "10:00:00"))
    c.handle(car_ev("B", "ENTRY1", "CarIn", "10:00:01"))
    assert ("goto", "B", "leavepark") in sim.calls


def test_neglected_car_removed_from_queue():
    c, sim = make()
    c.handle(gate_ev("gateA", "Open"))
    c.handle(car_ev("A", "ENTRY1", "CarIn", "10:00:00"))
    c.handle(car_ev("B", "ENTRY1", "CarIn", "10:00:01"))
    c.handle(car_ev("B", "ENTRY1", "CarOut", "10:05:01"))        # gave up
    assert "B" not in c.entry_lanes["ENTRY1"].queue and c.counters["neglected"] == 1


# ---------------------------------------------------------------------------
# exit & payment
# ---------------------------------------------------------------------------
def test_fake_payment_not_released():
    c, sim = make()
    park_and_reach_exit(c)
    fire_timers(c)
    c.handle(pay_ev("A", 0.5))
    assert ("goto", "A", "leavepark") not in sim.calls
    assert c.cars["A"].status == "payment_mismatch" and c.counters["payment_mismatches"] == 1


def test_release_waits_for_closed_exit_gate():
    c, sim = make()
    c.gates["gateB"].state = "Closed"
    park_and_reach_exit(c)
    fire_timers(c)
    c.handle(pay_ev("A", 2))
    assert sim.calls[-1] == ("open", "gateB")
    c.handle(gate_ev("gateB", "Open"))
    assert sim.calls[-1] == ("goto", "A", "leavepark")


def test_rejected_charge_is_retried_then_abandoned():
    c, sim = make()
    park_and_reach_exit(c, "QNL 430")
    fire_timers(c)
    assert len(charges(sim)) == 1
    for attempt in (2, 3):
        c.handle(penalty_ev("QNL430"))                            # plate without the space
        assert c.cars["QNL 430"].status == "at_exit"
        fire_timers(c)
        assert len(charges(sim)) == attempt
    c.handle(penalty_ev("QNL430"))
    fire_timers(c)
    assert len(charges(sim)) == 3                                # max_charge_attempts
    assert c.counters["penalties"] == 3


def test_unrelated_penalty_does_not_recharge():
    c, sim = make()
    park_and_reach_exit(c)
    fire_timers(c)
    c.handle(penalty_ev("A", reason="Some other rule"))
    fire_timers(c)
    assert len(charges(sim)) == 1


def test_billing_settings_are_honoured():
    c, sim = make(billing_rounding="ceil", price_per_minute=2)
    park_and_reach_exit(c)                                        # parked exactly 180 s
    fire_timers(c)
    assert charges(sim)[-1] == ("charge", "A", 6.0, 0.0)


# ---------------------------------------------------------------------------
# multi-lane sites & topology
# ---------------------------------------------------------------------------
def two_zone_sim():
    return FakeSim([spot("S1", zone="ZONE1"), spot("S2", zone="ZONE1"),
                    spot("S3", zone="ZONE2"), spot("S4", zone="ZONE2", car_type="Electric"),
                    spot("ENTRY1", "EntrySpot", zone=""), spot("ENTRY2", "EntrySpot", zone=""),
                    spot("EXIT_EXIT", "ExitSpot", zone="ZONE1"), spot("Exit67", "ExitSpot", zone="ZONE2")],
                   [gate("g1"), gate("g2", "Open"), gate("g3", zone="ZONE2"), gate("g4", "Open", zone="ZONE2")])


def test_each_entry_lane_has_its_own_gate_queue_and_zone():
    c, sim = make(two_zone_sim(), TWO_ZONES)
    c.handle(car_ev("A", "ENTRY1", "CarIn", "10:00:00"))
    c.handle(car_ev("B", "ENTRY2", "CarIn", "10:00:00"))
    assert ("open", "g1") in sim.calls and ("open", "g3") in sim.calls
    c.handle(gate_ev("g1", "Open"))
    c.handle(gate_ev("g3", "Open"))
    assert ("goto", "A", "S1") in sim.calls                      # ZONE1 spot for the ZONE1 lane
    assert ("goto", "B", "S3") in sim.calls                      # ZONE2 spot, never the Electric one


def test_electric_car_prefers_charger_spot():
    c, sim = make(two_zone_sim(), TWO_ZONES)
    c.handle(gate_ev("g3", "Open"))
    c.handle(car_ev("E", "ENTRY2", "CarIn", "10:00:00", car_type="Electric"))
    assert ("goto", "E", "S4") in sim.calls


def test_exit_uses_the_gate_of_the_exit_reached():
    c, sim = make(two_zone_sim(), TWO_ZONES)
    c.gates["g4"].state = "Closed"
    for ev in (gate_ev("g3", "Open"), car_ev("B", "ENTRY2", "CarIn", "10:00:00"),
               car_ev("B", "S3", "CarIn", "10:00:05"), car_ev("B", "S3", "CarOut", "10:01:05"),
               car_ev("B", "Exit67", "CarIn", "10:01:10")):
        c.handle(ev)
    fire_timers(c)
    c.handle(pay_ev("B", 2))
    assert sim.calls[-1] == ("open", "g4")


def test_zone_full_turns_away_even_if_other_zone_has_room():
    c, sim = make(two_zone_sim(), TWO_ZONES)
    c.handle(gate_ev("g1", "Open"))
    for i, p in enumerate("ABC"):
        c.handle(car_ev(p, "ENTRY1", "CarIn", f"10:00:0{i}"))
    assert ("goto", "C", "leavepark") in sim.calls               # ZONE1 has only 2 spots


def test_any_zone_strategy_crosses_zones():
    c, sim = make(two_zone_sim(), TWO_ZONES, allocation_strategy="any_zone_first_free")
    c.handle(gate_ev("g1", "Open"))
    for i, p in enumerate("ABC"):
        c.handle(car_ev(p, "ENTRY1", "CarIn", f"10:00:0{i}"))
        c.handle(car_ev(p, "ENTRY1", "CarOut", f"10:00:1{i}"))
    assert ("goto", "C", "S3") in sim.calls


def test_unknown_entry_triggers_resync_and_level_change_resets():
    c, sim = make()
    c.handle(car_ev("Z", "ENTRY2", "CarIn", "10:00:00"))
    kind, _ = c.q.get_nowait()
    assert kind == "resync"
    c._topology_candidates = [TWO_ZONES]
    sim._spots, sim._gates = two_zone_sim()._spots, two_zone_sim()._gates
    c.sync()
    assert c.topology.name == "test-2zones" and set(c.entry_lanes) == {"ENTRY1", "ENTRY2"}


def test_topology_resolution_picks_matching_file_and_rejects_missing_gates():
    sim = FakeSim.lvl1()
    wrong = Topology("wrong", [LaneDef("ENTRY1", "nope", "")], [LaneDef("EXIT_EXIT", "gateB", "")])
    t = topology.resolve(sim._spots, sim._gates, topology_dir=tempfile.mkdtemp(), sim_levels_dir=None,
                         max_gate_distance=400, candidates=[TWO_ZONES, wrong, LVL1])
    assert t.name == "test-lvl1"


def test_topology_falls_back_to_gateless_lanes():
    sim = FakeSim.lvl1()
    t = topology.resolve(sim._spots, sim._gates, topology_dir=tempfile.mkdtemp(), sim_levels_dir=None,
                         max_gate_distance=400)
    assert t.source == "fallback" and t.entry_lanes[0].gate is None


def test_committed_topology_files_are_valid():
    for t in topology.load_dir(Settings().topology_dir):
        assert t.entry_lanes and t.exit_lanes, t.name
        gates = [l.gate for l in t.entry_lanes + t.exit_lanes if l.gate]
        assert len(gates) == len(set(gates)), f"{t.name}: a gate serves two lanes"


def test_bad_allocation_strategy_is_rejected():
    try:
        allocation.get("nope")
    except ValueError as e:
        assert "lane_zone_first_free" in str(e)
    else:
        raise AssertionError("expected ValueError")


# ---------------------------------------------------------------------------
# recovery
# ---------------------------------------------------------------------------
def test_startup_replay_recovers_queue_and_exit():
    path = os.path.join(tempfile.mkdtemp(), "events.jsonl")
    now = datetime.now().isoformat(timespec="milliseconds")
    history = [car_ev("Q", "ENTRY1", "CarIn", "10:00:00"),                   # waiting at entry
               car_ev("X", "ENTRY1", "CarIn", "09:59:00"), car_ev("X", "ENTRY1", "CarOut", "09:59:02"),
               car_ev("X", "S2", "CarIn", "09:59:05"), car_ev("X", "S2", "CarOut", "10:01:05"),
               car_ev("X", "EXIT_EXIT", "CarIn", "10:01:10"),                 # stuck at exit, unbilled
               car_ev("P", "ENTRY1", "CarIn", "09:58:00"), car_ev("P", "ENTRY1", "CarOut", "09:58:02"),
               car_ev("P", "S1", "CarIn", "09:58:05")]                        # parked
    with open(path, "w", encoding="utf-8") as f:
        for e in history:
            f.write(json.dumps({"_received_at": now, "_accepted": True, **e}) + "\n")

    sim = FakeSim.lvl1()
    for s in sim._spots:
        s["detectedCars"] = 1 if s["name"] in ("ENTRY1", "EXIT_EXIT", "S1") else 0
    c = Controller(sim, cfg=Settings(), topologies=[LVL1])
    c.sync(replay_log=path)

    lane = c.entry_lanes["ENTRY1"]
    assert c.cars["P"].status == "parked" and c.spots["S1"].occupant == "P"
    assert c.spots["S2"].occupant is None                         # X left it
    assert list(lane.queue) == [] and lane.current == "Q"         # Q dispatched after recovery
    assert sim.calls[0] == ("open", "gateA")                      # no replayed commands re-sent
    fire_timers(c)
    assert ("charge", "X", 2.0, 0.0) in sim.calls                 # X finally billed
    c.handle(history[0])                                          # also in the live queue
    assert list(lane.queue) == []                                 # ...but processed once


def test_stale_log_is_not_replayed():
    path = os.path.join(tempfile.mkdtemp(), "events.jsonl")
    old = datetime.fromtimestamp(datetime.now().timestamp() - 25 * 60).isoformat(timespec="milliseconds")
    with open(path, "w", encoding="utf-8") as f:
        for e in (car_ev("P", "ENTRY1", "CarIn", "09:58:00"), car_ev("P", "S1", "CarIn", "09:58:05"),
                  car_ev("X", "EXIT_EXIT", "CarIn", "10:01:10")):
            f.write(json.dumps({"_received_at": old, "_accepted": True, **e}) + "\n")
    sim = FakeSim.lvl1()
    for s in sim._spots:
        s["detectedCars"] = 1 if s["name"] in ("EXIT_EXIT", "S1") else 0
    c = Controller(sim, cfg=Settings(), topologies=[LVL1])
    c.sync(replay_log=path)
    fire_timers(c)
    assert c.cars == {} and charges(sim) == []                    # nothing resurrected or billed


# ---------------------------------------------------------------------------
# simulator quirks
# ---------------------------------------------------------------------------
def test_looping_paid_car_is_not_billed_twice():
    c, sim = make()
    park_and_reach_exit(c)
    fire_timers(c)
    c.handle(pay_ev("A", 2))
    c.handle(car_ev("A", "EXIT_EXIT", "CarOut", "10:03:12"))
    assert len(charges(sim)) == 1
    # the same car "leaves its spot" and reaches the exit again without ever entering
    c.handle(car_ev("A", "S1", "CarOut", "10:05:00"))
    c.handle(car_ev("A", "EXIT_EXIT", "CarIn", "10:05:00"))
    fire_timers(c)
    assert len(charges(sim)) == 1
    assert gotos(sim)[-1] == ("goto", "A", "leavepark")
    assert c.counters["repeat_exits"] == 1


def test_returning_customer_through_entry_is_billed_again():
    c, sim = make()
    park_and_reach_exit(c)
    fire_timers(c)
    c.handle(pay_ev("A", 2))
    c.handle(car_ev("A", "EXIT_EXIT", "CarOut", "10:03:12"))
    for ev in (car_ev("A", "ENTRY1", "CarIn", "10:10:00"), car_ev("A", "ENTRY1", "CarOut", "10:10:02"),
               car_ev("A", "S1", "CarIn", "10:10:05"), car_ev("A", "S1", "CarOut", "10:11:05"),
               car_ev("A", "EXIT_EXIT", "CarIn", "10:11:10")):
        c.handle(ev)
    fire_timers(c)
    assert len(charges(sim)) == 2                                 # a genuine new session


def test_exit_event_before_spot_out_still_bills():
    # From S15 (next to the exit) the simulator reports EXIT CarIn ~0.2s BEFORE S15 CarOut.
    c, sim = make()
    for ev in (gate_ev("gateA", "Open"), car_ev("Y", "ENTRY1", "CarIn", "10:00:00"),
               car_ev("Y", "ENTRY1", "CarOut", "10:00:02"), car_ev("Y", "S1", "CarIn", "10:00:05"),
               car_ev("Y", "EXIT_EXIT", "CarIn", "10:03:05"), car_ev("Y", "S1", "CarOut", "10:03:05")):
        c.handle(ev)
    assert c.cars["Y"].status == "at_exit"
    fire_timers(c)
    assert charges(sim) == [("charge", "Y", 2.0, 0.0)]
    c.handle(pay_ev("Y", 2))
    assert gotos(sim)[-1] == ("goto", "Y", "leavepark")


def test_no_goto_exit_commands_are_ever_sent():
    c, sim = make()
    park_and_reach_exit(c)
    c.timers = [(0, label, fn) for _, label, fn in c.timers]
    fire_timers(c)
    assert not any(x[0] == "goto" and x[2] == "exit" for x in sim.calls)


def at(real_ts: float) -> str:
    return datetime.fromtimestamp(real_ts).isoformat(timespec="milliseconds")


def test_billing_uses_planned_minutes_at_any_game_speed():
    # Game speed 1.7: a 4-minute planned stay lasts only 2.35 real minutes.
    c, sim = make()
    t0 = datetime.now().timestamp()
    for ev, ts in ((gate_ev("gateA", "Open"), t0), (car_ev("V", "ENTRY1", "CarIn", "10:00:00", planned="4"), t0),
                   (car_ev("V", "S1", "CarIn", "10:00:05", planned="4"), t0 + 5),
                   (car_ev("V", "S1", "CarOut", "10:02:26", planned="4"), t0 + 5 + 141),
                   (car_ev("V", "EXIT_EXIT", "CarIn", "10:02:30", planned="0"), t0 + 150)):
        c.handle({**ev, "_received_at": at(ts)})
    fire_timers(c)
    assert charges(sim) == [("charge", "V", 4.0, 0.0)]
    assert abs(c.time_scale - 240 / 141) < 0.01                   # learned ~1.70 from that stay


def test_measured_billing_is_scaled_by_learned_game_speed():
    c, sim = make(billing_rounding="round")
    t0 = datetime.now().timestamp()
    for i in range(3):   # three stays at game speed 2.0 teach the scale
        p = f"L{i}"
        c.handle({**car_ev(p, "S2", "CarIn", "09:00:00", planned="2"), "_received_at": at(t0)})
        c.handle({**car_ev(p, "S2", "CarOut", "09:01:00", planned="2"), "_received_at": at(t0 + 60)})
    assert abs(c.time_scale - 2.0) < 1e-9
    c.handle({**car_ev("M", "S1", "CarIn", "10:00:00", planned="0"), "_received_at": at(t0)})
    c.handle({**car_ev("M", "S1", "CarOut", "10:01:30", planned="0"), "_received_at": at(t0 + 90)})
    c.handle({**car_ev("M", "EXIT_EXIT", "CarIn", "10:01:35", planned="0"), "_received_at": at(t0 + 95)})
    fire_timers(c)
    assert ("charge", "M", 3.0, 0.0) in sim.calls                 # 90 real s x 2.0 = 3 game min


def test_wrong_amount_penalty_rebills_with_stated_amount():
    c, sim = make()
    park_and_reach_exit(c, "VVV 071")
    fire_timers(c)
    assert charges(sim)[-1] == ("charge", "VVV 071", 2.0, 0.0)
    c.handle(penalty_ev("VVV071", "Car is being charged wrongly with amount: (2.00). "
                                  "Car type is (Normal) so charge should be: (4.00)"))
    fire_timers(c)
    assert charges(sim)[-1] == ("charge", "VVV 071", 4.0, 0.0)
    c.handle(pay_ev("VVV 071", 4))
    assert gotos(sim)[-1] == ("goto", "VVV 071", "leavepark")


def test_open_dropped_while_closing_is_resent_on_closed():
    c, sim = make()
    c.handle(gate_ev("gateA", "Open"))
    c.handle(car_ev("A", "ENTRY1", "CarIn", "10:00:00"))
    c.handle(car_ev("A", "ENTRY1", "CarOut", "10:00:02"))
    fire_timers(c)                                                # -> close gateA
    assert sim.calls[-1] == ("close", "gateA")
    c.handle(car_ev("B", "ENTRY1", "CarIn", "10:00:03"))         # arrives while closing
    assert sim.calls[-1] == ("open", "gateA")                     # the sim will ignore this one
    c.handle(gate_ev("gateA", "Closed"))
    assert sim.calls[-1] == ("open", "gateA") and sim.calls.count(("open", "gateA")) == 2
    c.handle(gate_ev("gateA", "Open"))
    assert gotos(sim)[-1] == ("goto", "B", "S2")


def test_reused_plate_at_entry_replaces_stale_record():
    # VKW 194: stuck at the exit in an old session, then the restarted simulator sent a
    # new car with the same plate as its first arrival - it must be admitted.
    c, sim = make()
    park_and_reach_exit(c, "VKW 194")
    fire_timers(c)
    assert c.cars["VKW 194"].status == "invoiced"
    c.handle(car_ev("VKW 194", "ENTRY1", "CarIn", "11:00:00"))
    assert c.cars["VKW 194"].status in ("dispatching", "dispatched")
    assert c.cars["VKW 194"].charge_parking is None                # a fresh session
    assert gotos(sim)[-1][0:2] == ("goto", "VKW 194")


def test_repeated_entry_event_for_queued_car_is_ignored():
    c, sim = make()
    c.handle(car_ev("A", "ENTRY1", "CarIn", "10:00:00"))
    c.handle(car_ev("A", "ENTRY1", "CarIn", "10:00:01"))
    assert c.counters["arrived"] == 1 and sim.calls == [("open", "gateA")]


def test_silence_triggers_resync_without_disturbing_a_dispatch():
    c, sim = make()
    c.handle(car_ev("A", "ENTRY1", "CarIn", "10:00:00"))           # A is mid-dispatch
    c._last_event_real -= c.cfg.resync_after_silence_s + 1
    c.handle(gate_ev("gateA", "Open"))
    assert c.q.get_nowait()[0] == "resync"
    c.sync()                                                         # the live resync
    assert c.entry_lanes["ENTRY1"].current == "A" and c.spots["S1"].reserved_for == "A"


def test_idle_open_gates_are_closed_on_sync():
    sim = FakeSim.lvl1()                                             # gateB starts Open
    Controller(sim, cfg=Settings(), topologies=[LVL1]).sync()
    assert ("close", "gateB") in sim.calls
    assert ("close", "gateC") not in sim.calls                       # not on any lane: left alone


def test_unconfirmed_gate_is_retried_then_assumed_open():
    c, sim = make()
    c.handle(car_ev("A", "ENTRY1", "CarIn", "10:00:00"))
    assert sim.calls == [("open", "gateA")]
    gate = c.gates["gateA"]
    gate.open_requested_at -= c.cfg.gate_open_timeout_s + 1       # no Open event arrives
    c.tick()
    assert sim.calls[-1] == ("open", "gateA") and len(sim.calls) == 2
    gate.open_requested_at -= c.cfg.gate_open_timeout_s + 1
    c.tick()
    assert sim.calls[-1] == ("goto", "A", "S1")                   # lane keeps moving


if __name__ == "__main__":
    failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print("PASS", name)
            except Exception as e:  # noqa: BLE001
                failed += 1
                print("FAIL", name, type(e).__name__, e)
    raise SystemExit(1 if failed else 0)

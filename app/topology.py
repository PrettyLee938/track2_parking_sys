"""Site layout: which gate serves which entry/exit sensor, and which zone it leads to.

The simulator API lists spots and gates but never says which gate belongs to which
entry/exit spot. That pairing is described in topology/*.json, one file per site
(level). At startup the controller lists the live entry/exit spots and picks the
file whose spot sets match exactly, so switching levels needs no code or config change.

A topology file can be written by hand, or generated from the simulator's level
layouts with `python -m tools.build_topology` (pairs each sensor with its nearest gate).
"""
from __future__ import annotations

import json
import logging
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path

from app.protocol import SpotPurpose

log = logging.getLogger("topology")


@dataclass(frozen=True)
class LaneDef:
    spot: str            # entry/exit sensor name
    gate: str | None     # barrier the car passes; None = no barrier on this lane
    zone: str            # zone this lane serves ("" = unknown)


@dataclass
class Topology:
    name: str
    entry_lanes: list[LaneDef]
    exit_lanes: list[LaneDef]
    source: str = ""
    notes: dict = field(default_factory=dict)

    @property
    def entry_spots(self) -> set[str]:
        return {l.spot for l in self.entry_lanes}

    @property
    def exit_spots(self) -> set[str]:
        return {l.spot for l in self.exit_lanes}

    def matches(self, entry_spots: set[str], exit_spots: set[str]) -> bool:
        return self.entry_spots == entry_spots and self.exit_spots == exit_spots

    @classmethod
    def from_dict(cls, d: dict, source: str = "") -> Topology:
        return cls(name=d["name"],
                   entry_lanes=[LaneDef(l["spot"], l.get("gate"), l.get("zone", "")) for l in d["entry_lanes"]],
                   exit_lanes=[LaneDef(l["spot"], l.get("gate"), l.get("zone", "")) for l in d["exit_lanes"]],
                   source=source, notes=d.get("notes", {}))

    def to_dict(self) -> dict:
        return {"name": self.name,
                "entry_lanes": [asdict(l) for l in self.entry_lanes],
                "exit_lanes": [asdict(l) for l in self.exit_lanes],
                "notes": self.notes}


# ---------------------------------------------------------------------------
# loading
# ---------------------------------------------------------------------------
def load_dir(directory: Path) -> list[Topology]:
    found = []
    for path in sorted(Path(directory).glob("*.json")):
        try:
            found.append(Topology.from_dict(json.loads(path.read_text(encoding="utf-8")), source=str(path)))
        except (ValueError, KeyError) as e:
            log.error("ignoring bad topology file %s: %s", path, e)
    return found


def derive_from_level_file(path: Path, max_gate_distance: float) -> Topology:
    """Pair every entry/exit sensor with its nearest gate using the level's coordinates.
    Pairs are claimed closest-first so two sensors never share a gate."""
    level = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    gates = {g["Name"]: g for g in level.get("Gates", [])}
    sensors = [s for s in level.get("ParkingSpots", [])
               if s.get("Purpose") in (SpotPurpose.ENTRY, SpotPurpose.EXIT)]

    pairs = sorted(((math.dist((s["X"], s["Y"]), (g["X"], g["Y"])), s["Name"], g["Name"])
                    for s in sensors for g in gates.values()))
    sensor_gate: dict[str, tuple[str, float]] = {}
    used_gates: set[str] = set()
    for dist, sensor, gate in pairs:
        if dist > max_gate_distance:
            break
        if sensor in sensor_gate or gate in used_gates:
            continue
        sensor_gate[sensor] = (gate, dist)
        used_gates.add(gate)

    entry, exit_, distances = [], [], {}
    for s in sensors:
        gate, dist = sensor_gate.get(s["Name"], (None, None))
        zone = s.get("ZoneParent") or (gates[gate].get("ZoneParent") if gate else "") or ""
        lane = LaneDef(s["Name"], gate, zone)
        (entry if s["Purpose"] == SpotPurpose.ENTRY else exit_).append(lane)
        distances[s["Name"]] = round(dist, 1) if dist is not None else None
    unpaired = sorted(set(gates) - used_gates)
    return Topology(name=Path(path).stem, entry_lanes=entry, exit_lanes=exit_,
                    source=f"derived:{path}",
                    notes={"generated_from": Path(path).name, "gate_distance": distances,
                           "gates_not_on_a_lane": unpaired})


# ---------------------------------------------------------------------------
# resolution against the live simulator
# ---------------------------------------------------------------------------
def resolve(live_spots: list[dict], live_gates: list[dict], topology_dir: Path,
            sim_levels_dir: Path | None, max_gate_distance: float,
            candidates: list[Topology] | None = None) -> Topology:
    """Pick the topology matching the running level. Order: explicit candidates,
    topology_dir files, then layouts derived from sim_levels_dir. Falls back to
    gate-less lanes (logged loudly) so the app still starts."""
    entry = {s["name"] for s in live_spots if s.get("purpose") == SpotPurpose.ENTRY}
    exit_ = {s["name"] for s in live_spots if s.get("purpose") == SpotPurpose.EXIT}
    gate_names = {g["name"] for g in live_gates}

    pools = [candidates or [], load_dir(topology_dir)]
    if sim_levels_dir:
        pools.append(_derive_all(sim_levels_dir, max_gate_distance))
    for pool in pools:
        for topo in pool:
            if topo.matches(entry, exit_):
                missing = {l.gate for l in topo.entry_lanes + topo.exit_lanes if l.gate} - gate_names
                if missing:
                    log.error("topology %s names gates the simulator does not have: %s", topo.name, missing)
                    continue
                log.info("using topology %s (%s)", topo.name, topo.source)
                return topo

    log.error("no topology matches entries=%s exits=%s - running WITHOUT gate control. "
              "Add a file to %s (python -m tools.build_topology) or set GPA_SIM_LEVELS_DIR.",
              sorted(entry), sorted(exit_), topology_dir)
    zone_of = {s["name"]: s.get("zoneParent") or "" for s in live_spots}
    return Topology("unresolved",
                    [LaneDef(n, None, zone_of[n]) for n in sorted(entry)],
                    [LaneDef(n, None, zone_of[n]) for n in sorted(exit_)],
                    source="fallback")


def _derive_all(levels_dir: Path, max_gate_distance: float) -> list[Topology]:
    out = []
    for path in sorted(Path(levels_dir).glob("lvl*.json")):
        try:
            out.append(derive_from_level_file(path, max_gate_distance))
        except (ValueError, KeyError) as e:
            log.error("cannot derive topology from %s: %s", path, e)
    return out

"""Generate topology/*.json from the simulator's level layouts (settings/lvl*.json).

Each entry/exit sensor is paired with its nearest gate (closest pairs first, one
gate per sensor, within --max-distance). Review the output - especially the
gate_distance notes - and commit it; the app picks the matching file at startup.

Run from the repo root:
  .venv\\Scripts\\python -m tools.build_topology --levels-dir "C:/.../ParkingSimulator-win-x64/settings"
"""
import argparse
import json
from pathlib import Path

from app.config import settings
from app.topology import derive_from_level_file


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--levels-dir", type=Path, default=settings.sim_levels_dir, required=settings.sim_levels_dir is None,
                    help="simulator settings folder containing lvl*.json (default: GPA_SIM_LEVELS_DIR)")
    ap.add_argument("--out", type=Path, default=settings.topology_dir, help="output folder (default: GPA_TOPOLOGY_DIR)")
    ap.add_argument("--max-distance", type=float, default=settings.topology_max_gate_distance)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    for path in sorted(args.levels_dir.glob("lvl*.json")):
        topo = derive_from_level_file(path, args.max_distance)
        target = args.out / f"{topo.name}.json"
        target.write_text(json.dumps(topo.to_dict(), indent=2) + "\n", encoding="utf-8")
        unpaired = [l.spot for l in topo.entry_lanes + topo.exit_lanes if not l.gate]
        print(f"{target}: {len(topo.entry_lanes)} entries, {len(topo.exit_lanes)} exits"
              + (f"  WARNING no gate for {unpaired}" if unpaired else ""))
        for lane in topo.entry_lanes + topo.exit_lanes:
            print(f"   {lane.spot:10} -> {str(lane.gate):7} zone={lane.zone or '-':6} "
                  f"dist={topo.notes['gate_distance'][lane.spot]}")


if __name__ == "__main__":
    main()

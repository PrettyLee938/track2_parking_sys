/**
 * Generate topology/*.json from the simulator's level layouts (settings/lvl*.json).
 *
 * Each entry/exit sensor is paired with its nearest gate (closest pairs first, one gate
 * per sensor, within --max-distance). Review the output - especially gate_distance -
 * and commit it; the app picks the matching file at startup.
 *
 *   npm run topology -- --levels-dir "C:/.../ParkingSimulator-win-x64/settings"
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadDotEnv, loadSettings } from "../src/config";
import { deriveFromLevelFile } from "../src/topology";

loadDotEnv();
const cfg = loadSettings();
const { values } = parseArgs({
  options: {
    "levels-dir": { type: "string", default: cfg.simLevelsDir },
    out: { type: "string", default: cfg.topologyDir },
    "max-distance": { type: "string", default: String(cfg.topologyMaxGateDistance) },
  },
});
const levelsDir = values["levels-dir"];
if (!levelsDir) {
  console.error("--levels-dir is required (or set GPA_SIM_LEVELS_DIR)");
  process.exit(2);
}
const out = path.resolve(values.out!);
mkdirSync(out, { recursive: true });

for (const file of readdirSync(levelsDir).filter((f) => /^lvl.*\.json$/.test(f)).sort()) {
  const topo = deriveFromLevelFile(path.join(levelsDir, file), Number(values["max-distance"]));
  const { source, ...toWrite } = topo;
  const target = path.join(out, `${topo.name}.json`);
  writeFileSync(target, JSON.stringify(toWrite, null, 2) + "\n");
  const lanes = [...topo.entry_lanes, ...topo.exit_lanes];
  const unpaired = lanes.filter((l) => !l.gate).map((l) => l.spot);
  console.log(`${target}: ${topo.entry_lanes.length} entries, ${topo.exit_lanes.length} exits` +
    (unpaired.length ? `  WARNING no gate for ${unpaired.join(", ")}` : ""));
  const dist = topo.notes!.gate_distance as Record<string, number | null>;
  for (const l of lanes) console.log(`   ${l.spot.padEnd(10)} -> ${String(l.gate).padEnd(7)} zone=${(l.zone || "-").padEnd(6)} dist=${dist[l.spot]}`);
}

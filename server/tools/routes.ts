/**
 * Routes from every entrance to every zone, read from the simulator's level files: which
 * entry gates a car drives through (in order) and which entry sensors it passes.
 *   npm run report:routes -w server
 */
import { cfg } from "./site";
import { loadDir, routesFromLevelsDir } from "../src/topology";

if (!cfg.simLevelsDir) { console.error("set GPA_SIM_LEVELS_DIR to the simulator's settings folder"); process.exit(1); }
for (const t of loadDir(cfg.topologyDir)) {
  const routes = routesFromLevelsDir(cfg.simLevelsDir, t);
  console.log(`\n${t.name}`);
  if (!routes) { console.log("  no matching level file"); continue; }
  for (const [entry, zones] of Object.entries(routes)) {
    for (const [zone, r] of Object.entries(zones)) {
      console.log(`  ${entry.padEnd(7)} -> ${zone.padEnd(6)} gates ${r.gates.join(" > ") || "-"}   passes sensors ${r.sensors.join(", ")}`);
    }
  }
}

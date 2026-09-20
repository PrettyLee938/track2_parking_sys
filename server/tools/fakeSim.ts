/**
 * A stand-in for the simulator's REST API, for working on the dashboard without it.
 * Serves a Level 1-like layout (30 spots, ENTRY1/EXIT_EXIT, gateA/gateB/gateC) with some
 * spots occupied, accepts every command, and sends no webhooks.
 *
 *   npm run fake-sim -w server            (listens on 9899)
 *   then start the server with GPA_SIM_BASE_URL=http://127.0.0.1:9899/api/v1
 */
import { createServer } from "node:http";

const level3 = process.argv.includes("level3");
const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 9899);
const zones = level3 ? ["ZONE1", "ZONE2", "ZONE3", "ZONE4", "ZONE5", "ZONE6", "ZONE7"] : ["ZONE1"];
const spots = level3 ? [
  ...Array.from({ length: 250 }, (_, i) => ({ name: `S${i + 1}`, purpose: "Park", parkingForCarType: i % 17 === 0 ? "Electric" : i % 23 === 0 ? "Accessible" : "Any",
    zoneParent: zones[Math.floor(i / 36) % zones.length], detectedCars: 0, broken: false, isUnderMaintenance: false })),
  ...["ENTRY1", "ENTRY2", "ENTRY3", "Entry104", "OENTRY1", "OENTRY2", "OENTRY3", "OENTRY4"].map((name) => ({ name, purpose: "EntrySpot", parkingForCarType: "Any", zoneParent: "", detectedCars: 0, broken: false, isUnderMaintenance: false })),
  ...["EXIT_EXIT", "Exit67", "Exit100", "Exit103", "Exit187", "Exit188", "Exit191", "Exit192", "Exit234", "Exit235"].map((name, i) => ({ name, purpose: "ExitSpot", parkingForCarType: "Any", zoneParent: zones[i % zones.length], detectedCars: 0, broken: false, isUnderMaintenance: false })),
] : [
  ...Array.from({ length: 30 }, (_, i) => ({ name: `S${i + 1}`, purpose: "Park", parkingForCarType: "Any", zoneParent: "ZONE1",
    detectedCars: [2, 3, 5, 8, 9, 12, 14, 17, 20, 21, 25, 28].includes(i + 1) ? 1 : 0, broken: false, isUnderMaintenance: i + 1 === 23 })),
  { name: "ENTRY1", purpose: "EntrySpot", parkingForCarType: "Any", zoneParent: "", detectedCars: 0, broken: false, isUnderMaintenance: false },
  { name: "EXIT_EXIT", purpose: "ExitSpot", parkingForCarType: "Any", zoneParent: "ZONE1", detectedCars: 0, broken: false, isUnderMaintenance: false },
];
const gates = level3 ? Array.from({ length: 19 }, (_, i) => ({ name: `gate${i + 1}`, zoneParent: zones[i % zones.length], broken: false, isUnderMaintenance: false, state: i % 2 ? "Open" : "Closed" })) : [
  { name: "gateA", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, state: "Closed" },
  { name: "gateB", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, state: "Closed" },
  { name: "gateC", zoneParent: "", broken: false, isUnderMaintenance: false, state: "Open" },
];
const lights = level3 ? zones.slice(0, 3).flatMap((zone) => Array.from({ length: 10 }, (_, i) => ({ name: `light-${zone}-${i + 1}`, group: zone, zoneParent: zone, isOn: false }))) : [];
const fans = level3 ? zones.slice(0, 3).flatMap((zone) => Array.from({ length: 4 }, (_, i) => ({ name: `fan-${zone}-${i + 1}`, zoneParent: zone, broken: false, isUnderMaintenance: false, isOn: false }))) : [];
const air = zones.map((name) => ({ name, gasCarbonMonoxideLevel: 20, risk: "Safe" }));

createServer((req, res) => {
  const url = req.url ?? "";
  const send = (code: number, body?: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  if (url.endsWith("/auth/login")) return send(200, { token: "fake-token" });
  if (url.endsWith("/list-parking-spots")) return send(200, spots);
  if (url.endsWith("/list-barriers")) return send(200, gates);
  if (url.endsWith("/list-lights")) return send(200, lights);
  if (url.endsWith("/list-exhaust-fans")) return send(200, fans);
  if (url.endsWith("/list-zones")) return send(200, air);
  if (url.includes("/list-")) return send(200, []);
  console.log(`${req.method} ${url}`);
  return send(201);
}).listen(port, "127.0.0.1", () => console.log(`fake simulator (${level3 ? "level3" : "level1"}) on http://127.0.0.1:${port}/api/v1`));

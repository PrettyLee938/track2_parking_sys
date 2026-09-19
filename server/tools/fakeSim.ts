/**
 * A stand-in for the simulator's REST API, for working on the dashboard without it.
 * Serves a Level 1-like layout (30 spots, ENTRY1/EXIT_EXIT, gateA/gateB/gateC) with some
 * spots occupied, accepts every command, and sends no webhooks.
 *
 *   npm run fake-sim -w server            (listens on 9899)
 *   then start the server with GPA_SIM_BASE_URL=http://127.0.0.1:9899/api/v1
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 9899);
const spots = [
  ...Array.from({ length: 30 }, (_, i) => ({ name: `S${i + 1}`, purpose: "Park", parkingForCarType: "Any", zoneParent: "ZONE1",
    detectedCars: [2, 3, 5, 8, 9, 12, 14, 17, 20, 21, 25, 28].includes(i + 1) ? 1 : 0, broken: false, isUnderMaintenance: i + 1 === 23 })),
  { name: "ENTRY1", purpose: "EntrySpot", parkingForCarType: "Any", zoneParent: "", detectedCars: 0, broken: false, isUnderMaintenance: false },
  { name: "EXIT_EXIT", purpose: "ExitSpot", parkingForCarType: "Any", zoneParent: "ZONE1", detectedCars: 0, broken: false, isUnderMaintenance: false },
];
const gates = [
  { name: "gateA", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, state: "Closed" },
  { name: "gateB", zoneParent: "ZONE1", broken: false, isUnderMaintenance: false, state: "Closed" },
  { name: "gateC", zoneParent: "", broken: false, isUnderMaintenance: false, state: "Open" },
];
// Level 2 components, so the dashboard's Components page has something to show.
// One broken light on purpose: it should appear as out of service and never be operated.
const lights = [
  { name: "Light1", zoneParent: "ZONE1", isOn: false, broken: false, isUnderMaintenance: false },
  { name: "Light2", zoneParent: "ZONE1", isOn: false, broken: false, isUnderMaintenance: false },
  { name: "Light3", zoneParent: "ZONE2", isOn: true, broken: true, isUnderMaintenance: false },
];
const fans = [
  { name: "Fan1", zoneParent: "ZONE1", isOn: false, broken: false, isUnderMaintenance: false },
  { name: "Fan2", zoneParent: "ZONE2", isOn: false, broken: false, isUnderMaintenance: false },
  // Zoneless, exactly as the spec's own list-exhaust-fans example reports fan0. A fan like
  // this serves the whole park, so it must follow any zone that needs ventilation.
  { name: "fan0", zoneParent: "", isOn: false, broken: false, isUnderMaintenance: false },
];

// list-zones reports CO for every zone, including levels below Mid that the simulator
// would never send an event for. Rises slowly so a poll can be watched doing its job.
const zones = [
  { name: "ZONE1", gasCarbonMonoxideLevel: 0, risk: "Safe" },
  { name: "ZONE2", gasCarbonMonoxideLevel: 0, risk: "Safe" },
];
let co = 0;

createServer((req, res) => {
  const url = req.url ?? "";
  const send = (code: number, body?: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  if (url.endsWith("/auth/login")) return send(200, { token: "fake-token" });
  if (url.endsWith("/list-parking-spots")) return send(200, spots);
  if (url.endsWith("/list-barriers")) return send(200, gates);
  if (url.endsWith("/list-zones")) {
    co = (co + 3) % 90;
    zones[0].gasCarbonMonoxideLevel = co;
    zones[0].risk = co >= 50 ? "Mid" : "Safe";
    return send(200, zones);
  }
  if (url.endsWith("/list-lights")) return send(200, lights);
  if (url.endsWith("/list-exhaust-fans")) return send(200, fans);
  if (url.includes("/list-")) return send(200, []);

  // Lights and fans remember what they were told, so a resync reports the real state
  // (a static answer would silently undo every command the controller sent).
  const device = /\/(lights|exhaust-fans)\/([^/]+)\/(on|off)$/.exec(url);
  if (device) {
    const [, kind, name, action] = device;
    const target = (kind === "lights" ? lights : fans).find((d) => d.name === decodeURIComponent(name));
    if (!target) return send(404);
    if (target.broken) return send(400, { error: "component is broken" });
    target.isOn = action === "on";
    console.log(`${name} -> ${action}`);
    return send(201);
  }

  console.log(`${req.method} ${url}`);
  return send(201);
}).listen(port, "127.0.0.1", () => console.log(`fake simulator on http://127.0.0.1:${port}/api/v1`));

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

createServer((req, res) => {
  const url = req.url ?? "";
  const send = (code: number, body?: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  if (url.endsWith("/auth/login")) return send(200, { token: "fake-token" });
  if (url.endsWith("/list-parking-spots")) return send(200, spots);
  if (url.endsWith("/list-barriers")) return send(200, gates);
  if (url.includes("/list-")) return send(200, []);
  console.log(`${req.method} ${url}`);
  return send(201);
}).listen(port, "127.0.0.1", () => console.log(`fake simulator on http://127.0.0.1:${port}/api/v1`));

/** Shared helpers for the live tools: talk to the running app and the simulator. */
import { loadDotEnv, loadSettings } from "../src/config";
import { SimClient } from "../src/simClient";
import type { EventRecord } from "../src/store";
import { resolve } from "../src/topology";

loadDotEnv();
export const cfg = loadSettings();
export const sim = new SimClient(cfg);
export const LISTENER = `http://127.0.0.1:${cfg.appPort}`;

export async function resolveSite() {
  return resolve(await sim.listParkingSpots(), await sim.listBarriers(), {
    topologyDir: cfg.topologyDir, simLevelsDir: cfg.simLevelsDir, maxGateDistance: cfg.topologyMaxGateDistance,
  });
}

export async function recentEvents(n = 200): Promise<EventRecord[]> {
  return (await fetch(`${LISTENER}/debug/recent?n=${n}`)).json() as Promise<EventRecord[]>;
}

/** Waits for a not-yet-seen event matching pred; marks it seen. */
export async function waitFor(pred: (e: EventRecord) => boolean, timeoutS: number, seen: Set<string>): Promise<EventRecord | null> {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    for (const e of await recentEvents()) {
      if (e.EventId && !seen.has(e.EventId) && pred(e)) {
        seen.add(e.EventId);
        return e;
      }
    }
    await sleep(300);
  }
  return null;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

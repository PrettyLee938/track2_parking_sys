/**
 * Plug-in subsystems: how new features join the engine without editing controller.ts.
 *
 * A subsystem is handed the Engine (what the controller lets it see and do) and gets:
 *   onSync   after every (re)sync of the site - read list-* results here, not on a timer
 *            (the simulator charges for every list call)
 *   onEvent  every accepted webhook, after the controller itself handled it
 *   onTick   every tick (~0.5 s), with the game-clock time
 *   snapshot extra state for the dashboard, under StateSnapshot.subsystems[name]
 * All of them run on the controller's serial queue: no locking needed, and state never
 * changes under a handler's feet. While the engine replays its log after a restart
 * (engine.replaying), rebuild state only - engine.cmd() sends nothing then.
 *
 * To add one: implement Subsystem in its own file and add it to createSubsystems() below.
 * The environment (CO fans, lights) is the next planned one.
 */
import type { FeedLevel } from "@gpa/shared";
import type { ComponentRegistry } from "./components";
import type { Settings } from "./config";
import type { Car, EntryLane, ExitLane, Gate, Spot } from "./controller";
import type { EventRecord, Store } from "./store";
import type { GameClock } from "./gameClock";
import type { SimApi } from "./simClient";

export interface Subsystem {
  readonly name: string;
  onSync?(): Promise<void> | void;
  onEvent?(e: EventRecord): Promise<void> | void;
  onTick?(gameNow: number): Promise<void> | void;
  snapshot?(): unknown;
}

/** The controller as subsystems see it. */
export interface Engine {
  readonly cfg: Settings;
  readonly sim: SimApi;
  readonly store: Store;
  readonly clock: GameClock;
  /** Rebuilding state from the log after a restart: decide nothing, send nothing. */
  readonly replaying: boolean;
  readonly spots: Map<string, Spot>;
  readonly gates: Map<string, Gate>;
  readonly entryLanes: Map<string, EntryLane>;
  readonly exitLanes: Map<string, ExitLane>;
  readonly cars: Map<string, Car>;
  /** Every gate, spot, fan and light with health and usage (core, always present). */
  readonly components: ComponentRegistry;
  /** Dashboard feed + server log. */
  note(level: FeedLevel, msg: string): void;
  /** Send a simulator command, recorded in the actions log. Returns whether it was accepted. */
  cmd(what: string, fn: () => Promise<void>, args: (string | number)[], actor?: string | null): Promise<boolean>;
  /** Run fn after delayGameS of game time, on the serial queue. */
  later(delayGameS: number, label: string, fn: () => Promise<unknown> | unknown): void;
  /** Why this gate cannot be worked on right now (a car is passing through), or null. */
  gateInUse(name: string): string | null;
  /** A part came back into service: restart lanes and cars that were waiting for it. */
  resume(): Promise<void>;
}

/** Every subsystem, in the order they see events. */
export function createSubsystems(_engine: Engine): Subsystem[] {
  return [];
}

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
import type { ComponentKind, ControlResult, FeedLevel } from "@gpa/shared";
import type { ComponentRegistry } from "./components";
import type { Settings } from "./config";
import { DoubleParking } from "./doubleParking";
import { Environment } from "./environment";
import { SpotSensors } from "./sensorHealth";
import type { Car, EntryLane, ExitLane, Gate, Spot } from "./controller";
import type { EventRecord, Store } from "./store";
import type { SitePlacement, Topology } from "./topology";
import type { GameClock } from "./gameClock";
import type { SimApi } from "./simClient";

export interface Subsystem {
  readonly name: string;
  onSync?(): Promise<void> | void;
  onEvent?(e: EventRecord): Promise<void> | void;
  onTick?(gameNow: number): Promise<void> | void;
  /** The controller has reserved a spot for a car and is sending it there. Sensor health
   * uses it to notice spots that never report the car we sent them. */
  reserved?(spot: string, plate: string): void;
  snapshot?(): unknown;
  /**
   * Manual control from the dashboard, for the parts this subsystem owns - the environment
   * owns the exhaust fans and lights. Return null for anything it does not own so the
   * controller can offer it to the next subsystem; gates and spots stay on the controller.
   */
  control?(kind: ComponentKind, name: string, action: string, actor: string):
    Promise<ControlResult | null> | ControlResult | null;
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
  /** The site layout in use. Null until the first sync. Carries the level file it came
   * from, which is the only source of component coordinates (list-* has none). */
  readonly topology: Topology | null;
  /** Where lights and spots physically are, from that level file; null without one. */
  readonly placement: SitePlacement | null;
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
export function createSubsystems(engine: Engine): Subsystem[] {
  return [new SpotSensors(engine), new DoubleParking(engine), new Environment(engine)];
}

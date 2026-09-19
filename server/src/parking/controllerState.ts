import type {
  Counters, FeedItem, SessionView, TimeseriesPoint,
} from "@gpa/shared";
import { getAllocator, type Allocator } from "../allocation";
import { readSimGameSpeed, type Settings } from "../config";
import type { SimApi } from "../simClient";
import type { Store } from "../store";
import { SerialQueue, type TaskQueue } from "../serialQueue";
import { Gate, Spot, type Car, type EntryLane, type ExitLane, type Timer } from "./state";
import type { Topology } from "../topology";

export interface ControllerDeps {
  sim: SimApi;
  cfg: Settings;
  store: Store;
  log?: { info(message: string): void; warn(message: string): void; error(message: string): void };
  topologies?: Topology[];
  queue?: TaskQueue;
}

export class ControllerState {
  readonly cfg: Settings;
  readonly sim: SimApi;
  readonly store: Store;
  readonly log: ControllerDeps["log"] extends infer T ? NonNullable<T> : never;
  readonly allocator: Allocator;
  readonly topologyCandidates?: Topology[];
  readonly queue: TaskQueue;
  synced = false;
  replaying = false;
  replayPending = false;
  started = false;
  readonly replayedIds = new Set<string>();
  lastResyncRequest = 0;
  readonly unresolvedSpots = new Map<string, number>();
  lastEventReal: number | null = null;
  tickHandle: NodeJS.Timeout | null = null;
  tickPending = false;
  stopped = false;
  topology: Topology | null = null;
  spots = new Map<string, Spot>();
  gates = new Map<string, Gate>();
  entryLanes = new Map<string, EntryLane>();
  exitLanes = new Map<string, ExitLane>();
  cars = new Map<string, Car>();
  recentPaid = new Map<string, number>();
  scaleSamples: number[] = [];
  simSettingsSpeed: number | null = null;
  timers: Timer[] = [];
  completed: SessionView[] = [];
  feed: FeedItem[] = [];
  counters: Counters = {
    arrived: 0, admitted: 0, turned_away: 0, neglected: 0, exited: 0, revenue: 0,
    payment_mismatches: 0, repeat_exits: 0, ghosts_retired: 0, escaped: 0, penalties: 0,
    fines: 0, command_errors: 0,
  };
  timeseries: TimeseriesPoint[] = [];
  lastSampleReal = 0;

  constructor(deps: ControllerDeps) {
    this.sim = deps.sim;
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.log = (deps.log ?? console) as NonNullable<ControllerDeps["log"]>;
    this.allocator = getAllocator(this.cfg.allocationStrategy);
    this.topologyCandidates = deps.topologies;
    this.queue = deps.queue ?? new SerialQueue((error) => this.log.error(`controller task failed: ${(error as Error)?.stack ?? error}`));
    this.simSettingsSpeed = readSimGameSpeed(this.cfg.simSettingsFile);
  }
}

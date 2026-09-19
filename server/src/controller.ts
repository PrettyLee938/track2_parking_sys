import {
  type ControlResult, type FeedLevel, type GateAction, type StateSnapshot, type TimeScaleSource,
} from "@gpa/shared";
import { ControllerState, type ControllerDeps } from "./parking/controllerState";
import { nowSeconds as nowS } from "./parking/clock";
import { sample as sampleReadModel, snapshot as snapshotReadModel } from "./parking/readModel";
import { learnTimeScale, realSeconds, refreshSimSettingsSpeed, timeScale, timeScaleInfo } from "./parking/timeScale";
import { note } from "./parking/commands";
import { manualGate as runManualGate, manualSpotRepair as runManualSpotRepair, setEntryOpen as updateEntryOpen } from "./parking/controls";
import type { Logger } from "./parking/types";
import {
  checkGateTimeouts, closeGateIfIdle as closeIdleGate, gateBusy as isGateBusy,
  onComponent, whenGateOpen,
} from "./parking/gates";
import {
  pumpEntry as pumpEntryFlow, sendToSpot as sendToSpotFlow,
} from "./parking/entryFlow";
import {
  release as releaseCar,
  scheduleCharge as scheduleChargeFlow,
} from "./parking/exitFlow";
import { handleEvent as processEvent } from "./parking/events";
import {
  adopt as adoptCar, checkDispatchTimeout as checkDispatch, finish as finishCar, forget as forgetCar,
  sweepGhosts as sweepGhostsFlow,
} from "./parking/recovery";
import { later as scheduleLater, runDueTimers } from "./parking/timers";
import { reconcile as reconcileState, sync as syncState } from "./parking/sync";
import { replay as replayState } from "./parking/replay";
import { requestResync as requestControllerResync, start as startController, stop as stopController, submit as submitEvent } from "./parking/lifecycle";
import {
  Gate, Spot, newCar, publicCar,
  type Callback, type Car, type EntryLane, type ExitLane, type Timer,
} from "./parking/state";
import type { EventRecord } from "./store";

export { simSecondsBetween } from "./parking/clock";
export { Gate, Spot, newCar, publicCar } from "./parking/state";
export type { Callback, Car, EntryLane, ExitLane, Timer } from "./parking/state";

export type { Logger } from "./parking/types";

export type { ControllerDeps } from "./parking/controllerState";

export class Controller extends ControllerState {
  constructor(deps: ControllerDeps) {
    super(deps);
  }

  get timeScaleInfo(): { value: number; source: TimeScaleSource } {
    return timeScaleInfo(this);
  }

  get timeScale(): number {
    return timeScale(this);
  }

  real(gameS: number): number {
    return realSeconds(this, gameS);
  }

  learnTimeScale(car: Car) {
    learnTimeScale(this, car);
  }

  start(): void {
    startController(this);
  }

  stop(): void {
    stopController(this);
  }

  submit(e: EventRecord): void {
    submitEvent(this, e);
  }

  requestResync(): void {
    requestControllerResync(this);
  }

  async sync(opts: { replay?: boolean } = {}): Promise<void> {
    return syncState(this, opts);
  }

  refreshSimSettingsSpeed() {
    refreshSimSettingsSpeed(this);
  }

  async replay(): Promise<void> {
    return replayState(this);
  }

  async reconcile(startup = true): Promise<void> {
    return reconcileState(this, startup);
  }

  handle(e: EventRecord): Promise<void> {
    return processEvent(this, e);
  }

  async pumpEntry(lane: EntryLane): Promise<void> {
    return pumpEntryFlow(this, lane);
  }

  sendToSpot(plate: string, lane: EntryLane) { return sendToSpotFlow(this, plate, lane); }

  scheduleCharge(plate: string, delayS: number): void {
    return scheduleChargeFlow(this, plate, delayS);
  }

  async release(car: Car): Promise<void> {
    return releaseCar(this, car);
  }

  private async checkGateTimeouts(now: number) {
    return checkGateTimeouts(this, now);
  }

  gateBusy(name: string): boolean {
    return isGateBusy(this, name);
  }

  async closeGateIfIdle(name: string | null): Promise<void> {
    return closeIdleGate(this, name);
  }

  async whenGateOpen(gate: Gate, callback: Callback): Promise<void> {
    return whenGateOpen(this, gate, callback);
  }

  private async onComponent(e: EventRecord, broken: boolean) {
    return onComponent(this, e, broken);
  }

  async tick(): Promise<void> {
    const now = nowS();
    await runDueTimers(this, now);
    await this.checkGateTimeouts(now);
    for (const lane of this.entryLanes.values()) await this.checkDispatchTimeout(lane, now);
    await this.sweepGhosts(now);
    this.sample(now);
    const horizon = now - this.real(this.cfg.repeatExitWindowGameS);
    for (const [plate, t] of this.recentPaid) if (t < horizon) this.recentPaid.delete(plate);
  }

  private async checkDispatchTimeout(lane: EntryLane, now: number) {
    return checkDispatch(this, lane, now);
  }

  later(delayS: number, label: string, fn: Callback): void {
    scheduleLater(this, delayS, label, fn);
  }

  adopt(e: EventRecord): Car { return adoptCar(this, e); }

  forget(car: Car): void { return forgetCar(this, car); }

  private sweepGhosts(now: number) { return sweepGhostsFlow(this, now); }

  finish(car: Car, e: EventRecord): void { return finishCar(this, car, e); }

  note(level: FeedLevel, msg: string): void {
    note(this, level, msg);
  }

  exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.queue.run(fn);
  }

  async manualGate(name: string, action: GateAction, actor: string): Promise<ControlResult> {
    return runManualGate(this, name, action, actor);
  }

  async manualSpotRepair(name: string, actor: string): Promise<ControlResult> {
    return runManualSpotRepair(this, name, actor);
  }

  async setEntryOpen(spot: string, open: boolean, actor: string): Promise<ControlResult> {
    return updateEntryOpen(this, spot, open, actor);
  }

  private sample(now: number) {
    sampleReadModel(this, now);
  }

  snapshot(): StateSnapshot {
    return snapshotReadModel(this);
  }
}

import { readSimGameSpeed, type Settings } from "../config";
import { median } from "./clock";
import type { Car } from "./state";

export interface TimeScaleContext {
  readonly cfg: Pick<Settings, "gameSpeed" | "timeScaleMinSamples" | "timeScaleSamples" | "simSettingsFile">;
  scaleSamples: number[];
  simSettingsSpeed: number | null;
  note(level: "info", message: string): void;
}

export function timeScaleInfo(ctx: TimeScaleContext): { value: number; source: "configured" | "learned" | "simulator settings" | "default" } {
  if (ctx.cfg.gameSpeed) return { value: ctx.cfg.gameSpeed, source: "configured" };
  if (ctx.scaleSamples.length >= ctx.cfg.timeScaleMinSamples) return { value: median(ctx.scaleSamples), source: "learned" };
  if (ctx.simSettingsSpeed) return { value: ctx.simSettingsSpeed, source: "simulator settings" };
  return { value: 1, source: "default" };
}

export const timeScale = (ctx: TimeScaleContext): number => timeScaleInfo(ctx).value;
export const realSeconds = (ctx: TimeScaleContext, gameSeconds: number): number => gameSeconds / timeScale(ctx);

export function learnTimeScale(ctx: TimeScaleContext, car: Car): void {
  if (!car.planned_minutes || !car.parkedReal || !car.leftSpotReal) return;
  const realSeconds = car.leftSpotReal - car.parkedReal;
  const ratio = (car.planned_minutes * 60) / realSeconds;
  if (realSeconds <= 5 || ratio <= 0.1 || ratio >= 20) return;
  ctx.scaleSamples.push(ratio);
  if (ctx.scaleSamples.length > ctx.cfg.timeScaleSamples) ctx.scaleSamples.shift();
}

export function refreshSimSettingsSpeed(ctx: TimeScaleContext): void {
  const speed = readSimGameSpeed(ctx.cfg.simSettingsFile);
  if (speed && ctx.simSettingsSpeed && speed !== ctx.simSettingsSpeed) {
    ctx.note("info", `simulator game speed changed ${ctx.simSettingsSpeed} -> ${speed}; relearning`);
    ctx.scaleSamples = [];
  }
  ctx.simSettingsSpeed = speed;
}

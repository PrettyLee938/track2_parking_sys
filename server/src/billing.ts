/**
 * Parking charge rules. Rates and rounding come from settings (GPA_PRICE_PER_MINUTE,
 * GPA_ELECTRIC_MULTIPLIER, GPA_BILLING_ROUNDING).
 *
 * Durations passed in are GAME seconds (already scaled from wall-clock by the
 * controller's learned time scale).
 */
import { CarType } from "@gpa/shared";
import type { Settings } from "./config";

type BillingSettings = Pick<Settings, "billingRounding" | "pricePerMinute" | "electricMultiplier">;

export function billableMinutes(gameSeconds: number, plannedMinutes: number | null, cfg: BillingSettings): number {
  if (cfg.billingRounding === "planned" && plannedMinutes) return plannedMinutes;
  const minutes = gameSeconds / 60;
  if (cfg.billingRounding === "ceil") return Math.max(1, Math.ceil(minutes - 1e-9));
  return Math.max(1, Math.round(minutes));
}

export function parkingCost(gameSeconds: number, plannedMinutes: number | null, carType: string, cfg: BillingSettings): number {
  let cost = billableMinutes(gameSeconds, plannedMinutes, cfg) * cfg.pricePerMinute;
  if ((carType ?? "").toLowerCase() === CarType.Electric.toLowerCase()) cost *= cfg.electricMultiplier;
  return Math.round(cost * 100) / 100;
}

/**
 * No level so far reports how much electricity a car drew. Billing electricity that
 * was not used is a penalty (Penalty_ChargeCarForNoElectricityUsed), so this stays 0
 * until an event tells us the amount.
 */
export function chargingCost(_carType: string, _cfg: BillingSettings): number {
  return 0;
}

import { describe, expect, it } from "vitest";
import { chargingCost, parkingCost } from "../src/billing";

const base = { billingRounding: "ceil" as const, pricePerMinute: 1, electricMultiplier: 2 };

describe("Level 2 billing policy", () => {
  it("charges accessible parking at the normal rate and electric parking at 2x", () => {
    expect(parkingCost(120, 2, "Normal", base)).toBe(2);
    expect(parkingCost(120, 2, "Accessible", base)).toBe(2);
    expect(parkingCost(120, 2, "Electric", base)).toBe(4);
  });

  it("keeps the separate electricity line at zero without a supported usage basis", () => {
    expect(chargingCost("Electric", base)).toBe(0);
    expect(chargingCost("Normal", base)).toBe(0);
  });

  it("applies the configured rounding to measured duration without inventing a usage amount", () => {
    expect(parkingCost(61, null, "Normal", base)).toBe(2);
    expect(parkingCost(61, null, "Electric", base)).toBe(4);
  });
});

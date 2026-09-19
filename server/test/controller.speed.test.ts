import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, Controller, Store, getAllocator, loadSettings, REPO_ROOT, unknownSettingVars, loadDir, resolve, type Topology, at, carEv, FakeSim, feed, fireTimers, gateEv, LVL1, make, parkAndReachExit, payEv, penaltyEv, RecordingQueue, silentLog, testSettings, TWO_ZONES, twoZoneSim } from "./controllerSupport";
// ---------------------------------------------------------------------------
// game speed
// ---------------------------------------------------------------------------
describe("game speed", () => {
  const simSettings = (speed: number) => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "gpa-sim-")), "settings.json");
    writeFileSync(file, "\uFEFF" + JSON.stringify({ TeamName: "T", GameSpeedMultiplier: speed })); // the sim writes a BOM
    return file;
  };
  const dueIn = (c: Controller, label: string) => c.timers.find((t) => t.label === label)!.due - Date.now() / 1000;

  /** Three completed stays at the given game speed (planned 2 game-min each). */
  async function learnSpeed(c: Controller, speed: number) {
    const t0 = Date.now() / 1000, realS = 120 / speed;
    for (let i = 0; i < 3; i++) {
      await c.handle({ ...carEv(`L${speed}${i}`, "S3", "CarIn", "09:00:00", "2"), _received_at: at(t0) });
      await c.handle({ ...carEv(`L${speed}${i}`, "S3", "CarOut", "09:02:00", "2"), _received_at: at(t0 + realS) });
    }
  }

  it("scales simulator timers by the game speed", async () => {
    for (const speed of [0.5, 1, 2, 4]) {
      const { c } = await make({ cfg: { gameSpeed: speed } });
      await parkAndReachExit(c);
      expect(dueIn(c, "close gateA")).toBeCloseTo(c.cfg.gateCloseDelayGameS / speed, 1);
      expect(dueIn(c, "charge A")).toBeCloseTo(c.cfg.exitChargeDelayGameS / speed, 1);
    }
  });

  it("scales the gate-confirmation timeout by the game speed", async () => {
    const { c, sim } = await make({ cfg: { gameSpeed: 0.5 } }); // slow game: 6 game-s = 12 real s
    await c.handle(carEv("A", "ENTRY1", "CarIn", "10:00:00"));
    c.gates.get("gateA")!.openRequestedAt! -= 8; // 8 real s: too early to retry at half speed
    await c.tick();
    expect(sim.calls).toEqual([["open", "gateA"]]);
    c.gates.get("gateA")!.openRequestedAt! -= 5; // 13 real s
    await c.tick();
    expect(sim.calls).toEqual([["open", "gateA"], ["open", "gateA"]]);
  });

  it("takes the speed from, in order: configuration, learned stays, simulator settings, 1.0", async () => {
    expect((await make()).c.timeScaleInfo).toEqual({ value: 1, source: "default" });

    const { c } = await make({ cfg: { simSettingsFile: simSettings(1.7) } });
    expect(c.timeScaleInfo).toEqual({ value: 1.7, source: "simulator settings" });
    await learnSpeed(c, 2);
    expect(c.timeScaleInfo.source).toBe("learned");
    expect(c.timeScale).toBeCloseTo(2, 6);

    const fixed = (await make({ cfg: { gameSpeed: 3, simSettingsFile: simSettings(1.7) } })).c;
    await learnSpeed(fixed, 2);
    expect(fixed.timeScaleInfo).toEqual({ value: 3, source: "configured" });
  });

  it("relearns when the simulator is restarted at another speed", async () => {
    const file = simSettings(1.7);
    const { c } = await make({ cfg: { simSettingsFile: file } });
    await learnSpeed(c, 1.7);
    expect(c.timeScaleInfo.source).toBe("learned");
    writeFileSync(file, JSON.stringify({ GameSpeedMultiplier: 3 })); // restarted with a new speed
    await c.sync();
    expect(c.timeScaleInfo).toEqual({ value: 3, source: "simulator settings" });
  });

  it("flags GPA_ variables that match no setting (e.g. names from before the rename)", () => {
    expect(unknownSettingVars({ GPA_GATE_CLOSE_DELAY_S: "3", GPA_GATE_CLOSE_DELAY_GAME_S: "1.5", PATH: "x" }))
      .toEqual(["GPA_GATE_CLOSE_DELAY_S"]);
  });

  it("finds settings.json next to the level files", () => {
    const expected = path.join(path.resolve("C:/sim/settings"), "settings.json");
    expect(loadSettings({ GPA_SIM_LEVELS_DIR: "C:/sim/settings" }).simSettingsFile).toBe(expected);
    expect(testSettings({ simLevelsDir: path.resolve("C:/sim/settings") }).simSettingsFile).toBe(expected);
    expect(loadSettings({ GPA_SIM_LEVELS_DIR: "C:/sim/settings", GPA_SIM_SETTINGS_FILE: "C:/other.json" }).simSettingsFile)
      .toBe(path.resolve("C:/other.json")); // an explicit file wins
  });
});


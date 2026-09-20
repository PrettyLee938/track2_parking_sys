import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../src/app";
import { hashPassword } from "../src/auth";
import { Controller } from "../src/controller";
import { carEv, gateEv, LVL1, RecordingQueue, silentLog, testServer } from "./helpers";

const json = { "content-type": "application/json" };

describe("manual parking-spot occupancy quarantine", () => {
  it("lets an Operator report a physical observation, keeps the spot unavailable across sync/restart, and requires observed clearance", async () => {
    const { app, signIn, store, sim, controller, auth } = await testServer();
    const operator = await signIn("oper", "oper-password");
    const admin = await signIn("admin", "admin-password");
    const maintenanceHash = await hashPassword("maint-password");
    store.createUser("maint", maintenanceHash, "maintenance");
    const maintenance = await signIn("maint", "maint-password");

    const reportBody = { request_id: "manual-occupancy-report-1", expected_version: 0, observed_occupied: true,
      observation: "unidentified car physically seen in the bay", reason: "parking sensor is not reporting this car" };
    const forbidden = await app.inject({ method: "POST", url: "/api/spots/S1/manual-occupancy/report",
      headers: { cookie: maintenance, ...json }, payload: JSON.stringify(reportBody) });
    expect(forbidden.statusCode).toBe(403);

    const reported = await app.inject({ method: "POST", url: "/api/spots/S1/manual-occupancy/report",
      headers: { cookie: operator, ...json }, payload: JSON.stringify(reportBody) });
    expect(reported.statusCode).toBe(200);
    expect(reported.json()).toMatchObject({ ok: true });
    expect(controller.snapshot().spots.find((spot) => spot.name === "S1"))
      .toMatchObject({ manual_occupancy: true, manual_occupancy_version: 1, available: false, occupant: "?" });
    expect((await controller.manualSpotRepair("S1", "tech", "routine spot maintenance")).ok).toBe(false);
    await controller.handle(gateEv("gateA", "Open"));
    await controller.handle(carEv("MANUAL BAY TEST", "ENTRY1", "CarIn", "10:00:00"));
    expect(sim.gotos()).toContainEqual(["goto", "MANUAL BAY TEST", "S2"]);
    expect(sim.gotos().some((call) => call[1] === "MANUAL BAY TEST" && call[2] === "S1")).toBe(false);
    const manualIncident = store.getIncidentByCorrelation("manual_spot_occupancy", "S1")!;
    const genericResolve = await app.inject({ method: "POST", url: `/api/incidents/${manualIncident.id}/resolve`,
      headers: { cookie: admin, ...json }, payload: JSON.stringify({ reason: "attempted generic resolution" }) });
    expect(genericResolve.statusCode).toBe(409);

    // Simulator silence/zero detections cannot erase the durable human assertion.
    await controller.sync();
    expect(controller.snapshot().spots.find((spot) => spot.name === "S1"))
      .toMatchObject({ manual_occupancy: true, available: false });
    const restarted = new Controller({ sim, cfg: controller.cfg, store, log: silentLog,
      topologies: [LVL1], queue: new RecordingQueue() });
    await restarted.sync();
    expect(restarted.snapshot().spots.find((spot) => spot.name === "S1"))
      .toMatchObject({ manual_occupancy: true, manual_occupancy_version: 1, available: false });
    const restartedApp = Fastify();
    registerRoutes(restartedApp, { cfg: controller.cfg, controller: restarted, store, auth });

    const clearBody = { request_id: "manual-occupancy-clear-1", expected_version: 1, observed_clear: true,
      observation: "bay visually inspected and physically empty", reason: "vehicle has been confirmed to leave" };
    const stale = await restartedApp.inject({ method: "POST", url: "/api/spots/S1/manual-occupancy/clear",
      headers: { cookie: operator, ...json }, payload: JSON.stringify({ ...clearBody, expected_version: 0 }) });
    expect(stale.statusCode).toBe(409);
    expect(restarted.snapshot().spots.find((spot) => spot.name === "S1")?.manual_occupancy).toBe(true);

    // A physical-clearance report cannot overrule missing, duplicate, malformed, or
    // nonzero fresh simulator evidence. Failed attempts leave the quarantine intact.
    const originalSpots = sim.spots;
    const s1 = originalSpots.find((spot) => spot.name === "S1")!;
    const badInventories = [
      originalSpots.filter((spot) => spot.name !== "S1"),
      [...originalSpots, { ...s1 }],
      originalSpots.map((spot) => spot.name === "S1" ? { ...spot, detectedCars: undefined as unknown as number } : spot),
      originalSpots.map((spot) => spot.name === "S1" ? { ...spot, detectedCars: Number.NaN } : spot),
      originalSpots.map((spot) => spot.name === "S1" ? { ...spot, detectedCars: 1 } : spot),
    ];
    for (const badSpots of badInventories) {
      sim.spots = badSpots;
      const rejected = await restartedApp.inject({ method: "POST", url: "/api/spots/S1/manual-occupancy/clear",
        headers: { cookie: operator, ...json }, payload: JSON.stringify(clearBody) });
      expect(rejected.statusCode).toBe(409);
      expect(restarted.snapshot().spots.find((spot) => spot.name === "S1"))
        .toMatchObject({ manual_occupancy: true, available: false });
    }

    sim.spots = originalSpots;
    await restarted.sync();
    const cleared = await restartedApp.inject({ method: "POST", url: "/api/spots/S1/manual-occupancy/clear",
      headers: { cookie: admin, ...json }, payload: JSON.stringify(clearBody) });
    expect(cleared.statusCode).toBe(200);
    expect(restarted.snapshot().spots.find((spot) => spot.name === "S1"))
      .toMatchObject({ manual_occupancy: false, manual_occupancy_version: 2, available: true, occupant: null });
    expect(store.getIncidentByCorrelation("manual_spot_occupancy", "S1")).toBeUndefined();
    expect(store.searchAudit(100).map((entry) => entry.action)).toEqual(expect.arrayContaining([
      "spot.manual_occupancy.reported", "spot.manual_occupancy.cleared",
      "spot.manual_occupancy.report_attempt", "spot.manual_occupancy.clear_attempt",
    ]));
  });

  it("retries the same request idempotently and refuses to free an active reservation", async () => {
    const { app, signIn, controller } = await testServer();
    const operator = await signIn("oper", "oper-password");
    const body = { request_id: "occupancy-idempotency-1", expected_version: 0, observed_occupied: true,
      observation: "unidentified vehicle seen in spot", reason: "parking sensor is inoperative" };
    const first = await app.inject({ method: "POST", url: "/api/spots/S1/manual-occupancy/report",
      headers: { cookie: operator, ...json }, payload: JSON.stringify(body) });
    const retry = await app.inject({ method: "POST", url: "/api/spots/S1/manual-occupancy/report",
      headers: { cookie: operator, ...json }, payload: JSON.stringify(body) });
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(controller.snapshot().spots.find((spot) => spot.name === "S1")?.manual_occupancy_version).toBe(1);

    controller.spots.get("S2")!.reserved_for = "INBOUND";
    const reserved = await app.inject({ method: "POST", url: "/api/spots/S2/manual-occupancy/report",
      headers: { cookie: operator, ...json }, payload: JSON.stringify({ ...body, request_id: "occupancy-reserved-1" }) });
    expect(reserved.statusCode).toBe(409);
    expect(controller.snapshot().spots.find((spot) => spot.name === "S2"))
      .toMatchObject({ manual_occupancy: false, available: false, reserved_for: "INBOUND" });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { SessionView, SimEventBase } from "@gpa/shared";
import { hashPassword } from "../src/auth";
import type { EventRecord } from "../src/store";
import { testServer } from "./helpers";

const servers: Awaited<ReturnType<typeof testServer>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.app.close();
});

function session(plate: string, status: SessionView["status"]): SessionView {
  return {
    plate, car_type: "Normal", planned_minutes: 3, status,
    entry_lane: "ENTRY1", exit_lane: status === "gone" ? "EXIT_EXIT" : null,
    arrived_at: null, spot: status === "gone" ? "S1" : null, parked_at: null, left_spot_at: null, exit_at: null,
    charge_parking: null, charge_electric: null, charge_attempts: 0, charge_override: null,
    paid: null, payment_ok: null, left_at: null, parked_seconds: null,
  };
}

function acceptedEvent(event: SimEventBase, receivedAt = new Date().toISOString()): EventRecord {
  return { ...event, _received_at: receivedAt, _accepted: true };
}

describe("Level 2 reporting APIs", () => {
  it("lists accepted deduplicated penalties only and redacts fine values from operators", async () => {
    const server = await testServer();
    servers.push(server);
    server.store.createUser("maint", await hashPassword("maint-password"), "maintenance");
    const now = new Date().toISOString();
    server.store.recordEvent(acceptedEvent({ EventClass: "carbon_monoxide_event", EventId: "co-maint", CarbonMonoxideLevel: "27" }, now));
    server.store.recordEvent(acceptedEvent({ EventClass: "penalty", EventId: "penalty-1", Reason: "Exact simulator reason", FineAmount: "12.34", Type: "Car", ComponentName: "ABC123" }, now));
    server.store.recordEvent({ ...acceptedEvent({ EventClass: "penalty", EventId: "rejected-1", Reason: "Rejected reason", FineAmount: "99" }, now), _accepted: false });
    server.store.recordEvent({ ...acceptedEvent({ EventClass: "penalty", EventId: "duplicate-1", Reason: "Duplicate reason", FineAmount: "99" }, now), _duplicate: true });
    server.store.recordEvent({ ...acceptedEvent({ EventClass: "penalty", EventId: "conflict-1", Reason: "Conflicting reason", FineAmount: "99" }, now), _conflict: true });
    const incident = server.store.createOrUpdateIncident({ type: "penalty_review", correlationKey: "penalty-1", severity: "warning",
      summary: "Review accepted penalty" });

    const operatorCookie = await server.signIn("oper", "oper-password");
    const operatorResponse = await server.app.inject({ url: "/api/penalties?resolution_status=open", headers: { cookie: operatorCookie } });
    expect(operatorResponse.statusCode).toBe(200);
    expect(operatorResponse.json()).toMatchObject({
      time_basis: "server_utc_received_at_provisional", simulator_day: null, simulator_run_id: null, provisional: true,
      items: [{ event_id: "penalty-1", plate: "ABC123", message: "Exact simulator reason", fine_minor: null,
        fine_amount_raw: null, incident_id: incident.id, resolution_status: "open", run_id: null }],
    });

    const adminCookie = await server.signIn("admin", "admin-password");
    const adminResponse = await server.app.inject({ url: `/api/penalties?day=${new Date().toISOString().slice(0, 10)}`, headers: { cookie: adminCookie } });
    expect(adminResponse.statusCode).toBe(200);
    expect(adminResponse.json().items).toHaveLength(1);
    expect(adminResponse.json().items[0]).toMatchObject({ fine_minor: 1234, fine_amount_raw: "12.34" });

    const maintenanceCookie = await server.signIn("maint", "maint-password");
    expect((await server.app.inject({ url: "/api/penalties", headers: { cookie: maintenanceCookie } })).statusCode).toBe(403);
    const maintenanceReport = await server.app.inject({ url: `/api/reports/daily?day=${new Date().toISOString().slice(0, 10)}`, headers: { cookie: maintenanceCookie } });
    expect(maintenanceReport.statusCode).toBe(200);
    expect(maintenanceReport.json()).toMatchObject({ provisional: true, maintenance: { maintenance_requests: 0,
      completed_repairs_current_status: 0, active_jobs_current_status: 0, failed_jobs_current_status: 0,
      open_equipment_incidents_current_status: 0, co_events: 1, peak_co_level: 27 } });
    expect(maintenanceReport.json().financial).toBeUndefined();
    expect(maintenanceReport.json().operational).toBeUndefined();
    expect((await server.app.inject({ url: `/api/reports/daily?day=${new Date().toISOString().slice(0, 10)}&kind=operations`, headers: { cookie: maintenanceCookie } })).statusCode).toBe(403);
    expect((await server.app.inject({ url: `/api/reports/daily?day=${new Date().toISOString().slice(0, 10)}&kind=maintenance`, headers: { cookie: operatorCookie } })).statusCode).toBe(403);
    const maintenanceExport = await server.app.inject({ url: `/api/reports/daily/export?day=${new Date().toISOString().slice(0, 10)}`, headers: { cookie: maintenanceCookie } });
    expect(maintenanceExport.statusCode).toBe(200);
    expect(maintenanceExport.body).toContain("maintenance_requests");
    expect(maintenanceExport.body).not.toContain("arrivals");
    expect(maintenanceExport.body).not.toContain("verified_payments_minor");
  });

  it("returns bounded sanitized evidence, a uniquely related visit, and linked incident notes", async () => {
    const server = await testServer();
    servers.push(server);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    server.store.recordEvent(acceptedEvent({ EventClass: "car_spot_action", EventId: "nearby-1", CarPlateNumber: "ABC123",
      SpotName: "S2", SpotType: "Park", Direction: "CarIn" }, new Date(nowMs - 10_000).toISOString()));
    server.store.recordEvent(acceptedEvent({ EventClass: "penalty", EventId: "detail-penalty", Reason: "Simulator fine reason",
      FineAmount: "7.50", Type: "Car", ComponentName: "ABC123" }, now));
    const visitId = server.store.getOrCreateVisitId("entry-for-abc", "ABC123", new Date(nowMs - 30_000).toISOString());
    server.store.saveVisitState({ visit_id: visitId, plate: "ABC123", status: "parked", arrived_at: new Date(nowMs - 30_000).toISOString() });
    server.store.recordAction({ at: now, cmd: "openGate", args: ["gateA"], ok: true, error: null, ms: 3, actor: "oper" });
    const incident = server.store.createOrUpdateIncident({ type: "penalty_review", correlationKey: "detail-penalty",
      severity: "warning", summary: "Review simulator penalty", component: "C1", componentType: "Fan", zone: "Z1" });
    server.store.updateIncident(incident.id, "resolved", "admin", "Inspected equipment and recorded outcome.");

    const adminCookie = await server.signIn("admin", "admin-password");
    const penalty = server.store.searchAcceptedPenalties({ limit: 10 }).find((item) => item.event_id === "detail-penalty")!;
    const response = await server.app.inject({ url: `/api/penalties/${penalty.id}`, headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().item).toMatchObject({
      penalty: { event_id: "detail-penalty", message: "Simulator fine reason", fine_minor: 750, fine_amount_raw: "7.50" },
      related_visit: { visit_id: visitId, plate: "ABC123", status: "parked" }, visit_link: "linked",
      nearby_events: [{ event_id: "nearby-1", event_class: "car_spot_action", plate: "ABC123", spot: "S2", direction: "CarIn" },
        { event_id: "detail-penalty", event_class: "penalty" }],
      nearby_commands: [{ source: "action", cmd: "openGate", args: ["gateA"], outcome: "succeeded" }],
      suspected_cause: { assessment: "undetermined", confidence: "unknown" },
      recovery_action: { status: "unverified" },
      linked_incident: { id: incident.id, status: "resolved", latest_note: "Inspected equipment and recorded outcome.", component: "C1" },
    });
    expect(response.json().item.nearby_events.length).toBeLessThanOrEqual(20);
    expect(response.json().item.nearby_commands.length).toBeLessThanOrEqual(20);
  });

  it("redacts exact fine evidence for Operators and never exposes webhook secrets or payloads", async () => {
    const server = await testServer();
    servers.push(server);
    const now = new Date().toISOString();
    server.store.recordEvent({ ...acceptedEvent({ EventClass: "penalty", EventId: "redacted-detail", Reason: "Fine detail",
      FineAmount: "2.25", Type: "Car", ComponentName: "ABC123" }, now), _sig: "signature-must-not-appear", _raw_body: "raw-body-must-not-appear" });
    const penalty = server.store.searchAcceptedPenalties({ limit: 10 }).find((item) => item.event_id === "redacted-detail")!;
    const operatorCookie = await server.signIn("oper", "oper-password");
    const response = await server.app.inject({ url: `/api/penalties/${penalty.id}`, headers: { cookie: operatorCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().item.penalty).toMatchObject({ fine_minor: null, fine_amount_raw: null });
    const json = JSON.stringify(response.json());
    expect(json).not.toContain("signature-must-not-appear");
    expect(json).not.toContain("raw-body-must-not-appear");
    expect(response.json().item).not.toHaveProperty("sig");
    expect(response.json().item).not.toHaveProperty("payload");
    expect(response.json().item).not.toHaveProperty("raw_body");
  });

  it("does not retrieve rejected, duplicate, or conflicting penalty deliveries by ID", async () => {
    const server = await testServer();
    servers.push(server);
    const now = new Date().toISOString();
    const rejectedEventId = "not-accepted-detail";
    const duplicateEventId = "duplicate-detail";
    const conflictEventId = "conflict-detail";
    server.store.recordEvent({ ...acceptedEvent({ EventClass: "penalty", EventId: rejectedEventId, FineAmount: "1" }, now), _accepted: false });
    server.store.recordEvent({ ...acceptedEvent({ EventClass: "penalty", EventId: duplicateEventId, FineAmount: "1" }, now), _duplicate: true });
    server.store.recordEvent({ ...acceptedEvent({ EventClass: "penalty", EventId: conflictEventId, FineAmount: "1" }, now), _conflict: true });
    const operatorCookie = await server.signIn("oper", "oper-password");
    for (const eventId of [rejectedEventId, duplicateEventId, conflictEventId]) {
      const row = server.store.db.prepare("SELECT id FROM events WHERE event_id = ?").get(eventId) as { id: number };
      const response = await server.app.inject({ url: `/api/penalties/${row.id}`, headers: { cookie: operatorCookie } });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "penalty not found" });
    }
  });

  it("aggregates a provisional server-UTC report and exposes finance only to admins", async () => {
    const server = await testServer();
    servers.push(server);
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const event = (body: SimEventBase) => server.store.recordEvent(acceptedEvent(body, now));
    event({ EventClass: "car_spot_action", EventId: "arrive-1", CarPlateNumber: "A", SpotName: "ENTRY1", SpotType: "EntrySpot", Direction: "CarIn" });
    event({ EventClass: "car_spot_action", EventId: "admit-1", CarPlateNumber: "A", SpotName: "S1", SpotType: "Park", Direction: "CarIn" });
    event({ EventClass: "penalty", EventId: "fine-1", Reason: "test fine", FineAmount: "12.34" });
    event({ EventClass: "component_broken", EventId: "broken-1" });
    event({ EventClass: "component_fixed", EventId: "fixed-1" });
    event({ EventClass: "carbon_monoxide_event", EventId: "co-1", CarbonMonoxideLevel: "400", DangerLevel: "Critical" });
    event({ EventClass: "carbon_monoxide_event", EventId: "co-2", CarbonMonoxideLevel: 200, DangerLevel: "High" });
    server.store.recordEvent({ ...acceptedEvent({ EventClass: "penalty", EventId: "rejected-fine", FineAmount: "99" }, now), _accepted: false });
    server.store.recordEvent({ ...acceptedEvent({ EventClass: "penalty", EventId: "duplicate-fine", FineAmount: "99" }, now), _duplicate: true });
    server.store.recordEvent({ ...acceptedEvent({ EventClass: "carbon_monoxide_event", EventId: "co-rejected", CarbonMonoxideLevel: 900 }, now), _accepted: false });
    server.store.recordEvent({ ...acceptedEvent({ EventClass: "carbon_monoxide_event", EventId: "co-duplicate", CarbonMonoxideLevel: 800 }, now), _duplicate: true });
    event({ EventClass: "carbon_monoxide_event", EventId: "co-invalid", CarbonMonoxideLevel: "not-a-number" });
    server.store.recordSession(session("GONE", "gone"));
    server.store.recordSession(session("TURNED", "turned_away"));
    server.store.recordSession(session("ABANDONED", "neglected"));
    server.store.recordSession(session("LOST", "lost"));

    const settled = server.store.createInvoice({ visitId: "visit-paid", plate: "GONE", parking: 4.25, electricity: 0, billingBasis: "test" });
    server.store.updateInvoiceStatus(settled.id, "issued");
    server.store.settleInvoice(settled.id, 4.25, "payment-1");
    event({ EventClass: "payment_made", EventId: "payment-1", CarPlateNumber: "GONE", Amount: "4.25" });
    const outstanding = server.store.createInvoice({ visitId: "visit-outstanding", plate: "WAIT", parking: 2, electricity: 0, billingBasis: "test" });
    server.store.updateInvoiceStatus(outstanding.id, "issued");
    const uncertain = server.store.createInvoice({ visitId: "visit-uncertain", plate: "UNCERTAIN", parking: 3, electricity: 0, billingBasis: "test" });
    server.store.updateInvoiceStatus(uncertain.id, "outcome_unknown");
    const waived = server.store.createInvoice({ visitId: "visit-waived", plate: "WAIVED", parking: 1, electricity: 0, billingBasis: "test" });
    server.store.updateInvoiceStatus(waived.id, "waived");
    server.store.recordFinancialAdjustment({ requestId: "adjustment-1", visitId: "visit-paid", invoiceId: settled.id,
      plate: "GONE", kind: "adjustment", amountMinor: -50, reason: "Recorded refund adjustment", actor: "admin" });
    server.store.recordFinancialAdjustment({ requestId: "waiver-1", visitId: "visit-waived", invoiceId: waived.id,
      plate: "WAIVED", kind: "waiver", amountMinor: 0, reason: "Recorded invoice waiver", actor: "admin" });

    const operatorCookie = await server.signIn("oper", "oper-password");
    const operatorResult = await server.app.inject({ url: `/api/reports/daily?day=${today}`, headers: { cookie: operatorCookie } });
    expect(operatorResult.statusCode).toBe(200);
    const operational = operatorResult.json();
    expect(operational).toMatchObject({ requested_utc_day: today, simulator_calendar_status: "unavailable", simulator_day: null,
      simulator_run_id: null, provisional: true,
      operational: { arrivals: 1, admissions: 1, completed_departures: 1, turnaways: 1, abandoned_visits: 1, lost_visits: 1,
        accepted_simulator_penalties: 1, component_failure_events: 1, component_recovery_events: 1, co_events: 3, peak_co_level: 400 } });
    expect(operational.financial).toBeUndefined();
    expect(operational.unavailable_metrics.join(" ")).toContain("Simulator calendar day and simulator run identity");
    expect(operational.unavailable_metrics.join(" ")).not.toContain("Peak CO reading");

    const adminCookie = await server.signIn("admin", "admin-password");
    const adminResult = await server.app.inject({ url: `/api/reports/daily?date=${today}`, headers: { cookie: adminCookie } });
    expect(adminResult.statusCode).toBe(200);
    expect(adminResult.json().financial).toMatchObject({ invoices_created: 4, invoices_issued_current_status: 2,
      verified_payments_count: 1, verified_payments_minor: 425, outstanding_invoices_current_status: 2,
      uncertain_payment_outcomes_current_status: 1, waived_invoices_current_status: 1, waived_total_minor_current_status: 100,
      financial_adjustments_count: 1, financial_adjustments_amount_minor_recorded: -50,
      waiver_records_count: 1, waiver_amount_minor_recorded: 0,
      known_simulator_fines_minor: 1234, unknown_simulator_fine_amount_count: 0, receipts_after_known_simulator_fines_minor: -809 });

    expect((await server.app.inject({ url: "/api/reports/daily", headers: { cookie: operatorCookie } })).statusCode).toBe(400);
    expect((await server.app.inject({ url: "/api/reports/daily?day=2026-02-30", headers: { cookie: operatorCookie } })).statusCode).toBe(400);
    expect((await server.app.inject({ url: `/api/reports/daily?day=${today}&kind=financial`, headers: { cookie: operatorCookie } })).statusCode).toBe(403);
    expect((await server.app.inject({ url: `/api/reports/daily?day=${today}&run_id=unknown`, headers: { cookie: operatorCookie } })).statusCode).toBe(409);
  });

  it("exports the same report shape and audits downloads, while omitting financial data for operators", async () => {
    const server = await testServer();
    servers.push(server);
    const day = new Date().toISOString().slice(0, 10);
    const operatorCookie = await server.signIn("oper", "oper-password");
    const operatorExport = await server.app.inject({ url: `/api/reports/daily/export?day=${day}`, headers: { cookie: operatorCookie } });
    expect(operatorExport.statusCode).toBe(200);
    expect(operatorExport.headers["content-type"]).toContain("text/csv");
    expect(operatorExport.body).toContain("simulator_calendar_status");
    expect(operatorExport.body).not.toContain("verified_payments_minor");

    const adminCookie = await server.signIn("admin", "admin-password");
    const adminExport = await server.app.inject({ url: `/api/reports/daily/export?day=${day}`, headers: { cookie: adminCookie } });
    expect(adminExport.statusCode).toBe(200);
    expect(adminExport.body).toContain("verified_payments_minor");
    expect(server.store.searchAudit().filter((entry) => entry.action === "report.daily.export")).toHaveLength(2);
  });
});

# Level 2 Postman smoke collection

Import `Track2-Level2-Smoke.postman_collection.json` into Postman. It exercises the local Fastify app; it does not contain credentials, session cookies, or simulator secrets.

## Configure a private environment

Create a local Postman environment and set its `base_url` (default `http://127.0.0.1:8000`) plus the username/password pairs for the Operator, Maintenance, and Admin accounts. The app server default port is 8000; Vite's dashboard port 5173 is not the API server. Set passwords as local/current values and do not export or commit the environment. Other useful values:

- `utc_day`: optional `YYYY-MM-DD`; omitted/blank means today in UTC.
- `maintenance_component_type` and `maintenance_component`: use a real loaded `gate`, `spot`, or `fan` name. Light repair is not supported.
- `incident_id`: an existing incident ID if testing acknowledgement.
- `maintenance_job_id`: filled automatically after “Request maintenance work”; otherwise set an existing requested job ID.
- `zone_name`: a zone with an active CO ventilation requirement for the one-shot recovery check.
- `webhook_profile` and `require_signature`: set these to match the running server when checking unsigned webhook expectations.
- `simulator_run_id`, `simulator_time_iso`, `calendar_seconds_per_real_second`, `day_start_minute`, `night_start_minute`, and `simulator_clock_anchor_reason`: deliberate Admin-only inputs for the manual calendar workflow. Use a timestamp with an explicit numeric offset, e.g. `2026-09-20T18:30:00+08:00` (not `Z`); leave unset until an operator can observe the simulator and calibrate its rate.
- `simulator_clock_invalidation_reason`: why a manual clock projection is no longer trustworthy (pause, speed change, or uncertainty).

Postman stores the `HttpOnly` `gpa_session` cookie in its cookie jar. Stay on the same host/port while testing. Run the matching Login request before its protected requests: Operator for operational/report-operations and job creation, Maintenance for claim/start, and Admin for financial reports/export and `/api/audit`. Logging in as another role replaces the cookie for that host. Do not run all three login requests and then assume one role remains active.

## Suggested smoke order

1. Login as Operator, then call Who am I, Operations state, Equipment inventory, Zone CO safety state, and the operational daily report/export.
2. As Operator, optionally create a maintenance request with a real available component name. The response test saves its job ID in the collection variable.
3. Login as Maintenance, list jobs, claim the saved job, then start it. The simulator/controller may correctly refuse start with HTTP 409 if clearance or safety preconditions are not met.
4. Login as Admin to call the financial daily report/export and audit log. Financial responses are also enforced server-side. The simulator-clock status/anchor/invalidate requests are optional; use them only with an observed simulator timestamp and a calibrated rate.
5. Incident acknowledgement requires an existing `incident_id` and a reason of at least 8 characters. Acknowledgement is not generic incident resolution.

The reports and penalty date filters use server-received UTC timestamps provisionally. The Admin simulator-clock endpoint can hold an explicit manual projection, but it does not read simulator time or establish a simulator run identity; daily reports remain server-UTC and are not simulator-day reports. The projection becomes unavailable after a server restart and must be re-anchored; invalidate it after pauses, speed changes, or uncertainty. It is not integrated with unattended lighting. The CO recovery request is an explicit one-shot check: it may return 409 when not ready/unsafe or 503 when unsupported/unavailable, and those outcomes must not be treated as recovery.

## Webhook signature diagnostics

The signed and unsigned `test_webhook` examples use the current app contract. The signed request's pre-request script computes MD5 over the values of every field except `Signature`, sorted by field name and joined with `|`. `test_webhook` invokes no car/equipment handler, but an accepted event still participates in controller activity/silence detection and can trigger the configured resync after a long idle period. Run these only in an isolated smoke profile or with `GPA_CONTROLLER_ENABLED=false`. Both examples omit `SequenceId` so the test does not advance the sequence cursor.

`/webhook` is loopback-only by default. Send these from Postman Desktop on the same machine as the server (not a cloud agent). In `GPA_WEBHOOK_PROFILE=level2`, the signed request should return 200 and the unsigned one 401. With the permissive Level 1 profile, unsigned deliveries may return 200; the unsigned request test accepts the configured behavior.

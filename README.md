# Track 2 Grand Park Auto parking system

This repository contains the backend baseline for the Level 1 Grand Park Auto challenge. It is a TypeScript modular monolith with a Fastify HTTP boundary, SQLite persistence through Node 24’s SQLite API, and one `SimulatorGateway` seam for live or fixture-backed simulator access.

## Run locally

Use Node.js 24 or newer. Copy `.env.example` to `.env`, set the simulator credentials and the first Admin credentials locally, then install and start the backend:

```text
npm install
npm run dev
```

The backend listens on `http://127.0.0.1:3000` by default. Run the Windows simulator on port `9898` and configure its webhook URL as `http://127.0.0.1:3000/webhooks/simulator`. Start the backend before starting the simulator so the webhook receiver is ready. Keep credentials and the SQLite database outside Git.

Useful checks are:

```text
npm run check
npm test -- --run
```

The check includes TypeScript compilation, the authored source/test 200-line limit, and the full Vitest suite.

## Backend shape

Application code is grouped by responsibility: `domain` contains deterministic parking and billing policies, `simulator` contains the live and fixture gateway adapters, `db` contains migrations and SQLite access, `auth` contains application identity, `services` contain use-case controllers, and `api` contains the HTTP routes. Tests observe the public service or HTTP boundary; they do not mock internal collaborators.

The backend distinguishes simulator command acceptance from physical confirmation. Signed webhooks are deduplicated by event identity, sequence gaps remain visible, commands are durable, and reconnect reconciliation must complete before new actions resume. Admin unpaid-release authorization remains an auditable business exception and never fabricates payment or bypasses physical restrictions.

Jev is intentionally not part of the baseline control loop. The parking system remains usable with Jev disabled and without internet access.

# track2_parking_sys

Grand Park Auto control centre (IoT hackathon, Track 2).

## Setup

```
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env      (optional - only to override defaults)
```

In the simulator's `settings/settings.json` set:

```
"WebhookUrl": "http://127.0.0.1:8000/webhook"
```

Use `127.0.0.1`, not `localhost`: on Windows `localhost` adds ~2 s to every call.
The simulator only reads settings at startup.

## Run

1. Start the app first, so no arriving car goes unseen:
   `.venv\Scripts\python -m app`
2. Then start a level in the simulator. The app detects which level is loaded and
   picks the matching `topology/*.json`; switching levels is picked up automatically.

- Live state: http://127.0.0.1:8000/api/state
- Effective settings: http://127.0.0.1:8000/debug/config

## Configuration

All settings live in `app/config.py` (typed, validated, with defaults) and can be
overridden in `.env` or as environment variables with the `GPA_` prefix, e.g.
`GPA_BILLING_ROUNDING=ceil`. See `.env.example`.

Simulator strings (event classes, spot purposes, penalty texts...) are defined once in
`app/protocol.py`. Site layout (which gate serves which entry/exit) lives in
`topology/*.json`, one file per level. Regenerate them from the simulator's layouts with:

```
.venv\Scripts\python -m tools.build_topology --levels-dir "<simulator>/settings"
```

## Layout

| Path | What |
|---|---|
| `app/controller.py` | car park logic: per-lane entry queues, gates, billing, payments, recovery |
| `app/topology.py` | discovers entry/exit lanes and pairs them with gates |
| `app/allocation.py` | spot allocation strategies (`GPA_ALLOCATION_STRATEGY`) |
| `app/billing.py` | parking charge rules |
| `app/protocol.py` | every literal the simulator sends or expects |
| `app/config.py` | settings |
| `app/sim_client.py` | simulator REST API client |
| `app/webhook.py` | webhook parsing, signature check, dedupe, sequence tracking |
| `app/store.py` | persistence seam (JSON lines for now; database workstream replaces it) |
| `app/main.py` | FastAPI: `/webhook`, `/api/state`, `/api/resync`, `/debug/*` |
| `topology/` | one layout file per level |
| `tests/` | controller tests against a fake simulator: `python -m tests.test_controller` |
| `tools/` | live checks (`smoke_test`, `single_car_test`) and `build_topology` |

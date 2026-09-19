# Simulator REST API

Source: `Track 2 specs.pdf`, pages 13-23.

Base path: `/api/v1`.

## Authentication

```http
POST /api/v1/auth/login
Content-Type: application/json

{"Email":"<Name from settings.json>","Password":"<Password from settings.json>"}
```

The response is `200 OK` with `{"token":"<JWT>"}`. Every other listed
endpoint requires `Authorization: Bearer <JWT>`. Invalid credentials return
`401 Unauthorized`.

## Discovery and diagnostics

These calls describe the current level. The PDF says to use them once when a
level loads or after a crash/reconnect; periodic polling has a simulated cost.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/list-parking-spots` | Parking, entry, and exit spots, type, zone, occupancy, health. |
| `GET` | `/api/v1/list-barriers` | Barrier names, state, zone, health. |
| `GET` | `/api/v1/list-lights` | Light names, groups, zones, and on/off state. |
| `GET` | `/api/v1/list-exhaust-fans` | Fan names, zones, health, and on/off state. |
| `GET` | `/api/v1/list-alarms` | Components currently requiring maintenance. |
| `GET` | `/api/v1/list-zones` | Zone carbon-monoxide level and risk. |
| `GET` | `/api/v1/test` | Requests a test webhook and confirms the webhook URL. |

The exact `list-` prefix matters. The installed simulator returned `404` for
`/api/v1/parking-spots`, `/api/v1/barriers`, and similar guessed paths.

## Control endpoints

All control calls require a bearer token and have an empty request body unless
shown otherwise. Successful commands return `201 Created`.

| Action | Path |
| --- | --- |
| Open, close, repair gate | `POST /api/v1/barrier-gates/{name}/{open\|close\|repair}` |
| Turn a light on/off | `POST /api/v1/lights/{name}/{on\|off}` |
| Turn a light group on/off | `POST /api/v1/lights/group/{name}/{on\|off}` |
| Turn a fan on/off | `POST /api/v1/exhaust-fans/{name}/{on\|off}` |
| Repair a fan | `POST /api/v1/exhaust-fans/{name}/repair` |
| Repair a spot | `POST /api/v1/parking-spots/{name}/repair` |
| Move a car | `POST /api/v1/car/{plate}/goto/{destination}` |
| Charge a car | `POST /api/v1/car/{plate}/charge?parkingCost=0&chargingCost=0` |

For `goto`, `{destination}` is a parking spot name, `exit`, or `leavepark`.
The PDF warns that an occupied destination can create a penalty.

## Git Bash smoke test

```bash
BASE_URL="${SIMULATOR_BASE_URL:-http://127.0.0.1:9898}"
TOKEN=$(curl -sS -X POST "$BASE_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"Email\":\"$SIMULATOR_NAME\",\"Password\":\"$SIMULATOR_PASSWORD\"}" \
  | python -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -sS "$BASE_URL/api/v1/list-parking-spots" \
  -H "Authorization: Bearer $TOKEN"
curl -sS "$BASE_URL/api/v1/test" \
  -H "Authorization: Bearer $TOKEN"
```

Never expose the token in committed logs or screenshots.

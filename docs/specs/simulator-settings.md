# Simulator settings

Source: `Track 2 specs.pdf`, pages 35-36.

The simulator reads `Settings/settings.json` before startup. Preserve the key
spelling used by the simulator, including `ParkingSpeedMuliplier`.

## Safe local template

```json
{
  "TeamName": "YOUR_TEAM_NAME",
  "ListenAddress": "http://0.0.0.0:9898",
  "WebhookUrl": "http://127.0.0.1:3000/webhooks/simulator",
  "ParkingSpeedMuliplier": 1,
  "MinParkingTime": 1,
  "MaxParkingTime": 5,
  "Name": "YOUR_SIMULATOR_USERNAME",
  "Password": "YOUR_SIMULATOR_PASSWORD",
  "GameSpeedMultiplier": 1.0
}
```

Do not commit the real `Name` or `Password`. Keep them in a local `.env` file
for the backend and in the simulator's local settings file.

## Fields

| Field | Meaning |
| --- | --- |
| `TeamName` | Name identifying the participating team. |
| `ListenAddress` | Simulator REST address. `0.0.0.0:9898` accepts local network connections. |
| `WebhookUrl` | URL where simulator events are posted. |
| `GameSpeedMultiplier` | Overall simulation speed; `1` is normal. |
| `ParkingSpeedMuliplier` | Speed of entry, parking, and exit timing. |
| `MinParkingTime` | Minimum random planned parking duration in minutes. |
| `MaxParkingTime` | Maximum random planned parking duration in minutes. |
| `Name` | Username for simulator login. |
| `Password` | Password for simulator login. |

The supplied file also contains `lvl2Password` and `lvl3Password`; retain them
when the installed build provides them, but never put their values in Git.

## Git Bash checks

Run the backend from the repository root:

```bash
test -f .env || { echo "Create .env first"; exit 1; }
curl -i "$SIMULATOR_BASE_URL/api/v1/status"
```

The simulator must be running before the status check. The backend webhook
listener must be running before the simulator so that the configured URL is
reachable when the first event is emitted.

## Local-first connection values

Use these values for the first same-machine run:

```dotenv
SIMULATOR_BASE_URL=http://127.0.0.1:9898
SIMULATOR_NAME=YOUR_SIMULATOR_USERNAME
SIMULATOR_PASSWORD=YOUR_SIMULATOR_PASSWORD
```

Only after this loop works should `WebhookUrl` or the dashboard bind to a LAN
address. A `ListenAddress` of `0.0.0.0` does not make `127.0.0.1` webhook
traffic remote; it only controls where the simulator API listens.

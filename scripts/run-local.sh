#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # The repository .env contains simple KEY=value settings only.
  # shellcheck disable=SC1091
  source .env
  set +a
fi

SIMULATOR_EXE="${SIMULATOR_EXE:-/c/Users/malsabbagh/Downloads/ParkingSimulator-win-x64/ParkingSimulator-win-x64/ParkingSimulator.exe}"
SIMULATOR_DIR="$(dirname "$SIMULATOR_EXE")"
SIMULATOR_URL="${GPA_SIM_BASE_URL:-http://127.0.0.1:9898/api/v1}"
SIMULATOR_URL="${SIMULATOR_URL%/}"
LOG_DIR="${LOG_DIR:-$ROOT/logs}"
SIM_LOG="$LOG_DIR/simulator.log"
SERVER_LOG="$LOG_DIR/server.log"

mkdir -p "$LOG_DIR"
if [[ ! -f "$SIMULATOR_EXE" ]]; then
  echo "Simulator executable not found: $SIMULATOR_EXE" >&2
  echo "Set SIMULATOR_EXE to the ParkingSimulator.exe path." >&2
  exit 1
fi

simulator_running() {
  curl --silent --show-error --max-time 2 --output /dev/null \
    --write-out '%{http_code}' "$SIMULATOR_URL/test" | grep -Eq '^[2345][0-9][0-9]$'
}

sim_pid=""
cleanup() {
  if [[ -n "$sim_pid" ]]; then
    echo "Stopping simulator (PID $sim_pid)"
    taskkill.exe //PID "$sim_pid" //T //F >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if simulator_running; then
  echo "Using the simulator already listening at $SIMULATOR_URL"
else
  echo "Starting simulator; output: $SIM_LOG"
  (
    cd "$SIMULATOR_DIR"
    "$SIMULATOR_EXE" >"$SIM_LOG" 2>&1
  ) &
  sim_pid=$!

  for _ in {1..30}; do
    if simulator_running; then break; fi
    sleep 1
  done
  if ! simulator_running; then
    echo "Simulator did not open $SIMULATOR_URL within 30 seconds." >&2
    tail -n 80 "$SIM_LOG" >&2 || true
    exit 1
  fi
fi

echo "Simulator API is reachable. Select Level 2 and press Start in the simulator window."
echo "Backend output: $SERVER_LOG"
echo "Starting npm run dev..."
npm run dev 2>&1 | tee "$SERVER_LOG"

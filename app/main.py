"""FastAPI entry point: webhook intake + read API for the dashboard.

Run from the repo root:   .venv\\Scripts\\python -m app
"""
import logging
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, Request

from app import store
from app.config import settings
from app.controller import Controller
from app.sim_client import SimClient
from app.webhook import Intake, parse_raw

logging.basicConfig(level=settings.log_level.upper(),
                    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S")
logging.getLogger("httpx").setLevel(logging.WARNING)   # one line per sim call is noise
log = logging.getLogger("webhook")

intake = Intake()
controller = Controller(SimClient())
recent_events: deque[dict] = deque(maxlen=settings.recent_events_size)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if settings.controller_enabled:
        controller.start()
        log.info("controller started")
    else:
        log.warning("controller disabled: passive mode, events are logged but no commands are sent")
    yield
    controller.stop()


app = FastAPI(title="Grand Park Auto - control centre", lifespan=lifespan)


# ---------------------------------------------------------------------------
# simulator -> us
# ---------------------------------------------------------------------------
@app.post("/webhook")
async def webhook(request: Request):
    body = await request.body()
    received_at = datetime.now().isoformat(timespec="milliseconds")
    try:
        event = parse_raw(body)
    except ValueError:
        log.error("non-JSON webhook: %r", body[:300])
        return {"ok": False}

    meta = intake.check(event)
    record = {"_received_at": received_at, "_sig": meta["sig"], "_duplicate": meta["duplicate"],
              "_seq_note": meta["seq_note"], "_accepted": meta["accept"], **event}
    store.record_event(record)
    recent_events.append(record)

    if meta["seq_note"]:
        log.warning("sequence gap: %s", meta["seq_note"])
    if not meta["accept"]:
        log.warning("dropped %s (%s)", event.get("EventClass"),
                    "duplicate" if meta["duplicate"] else f"signature {meta['sig']}")
    elif settings.controller_enabled:
        controller.submit(record)   # processed on the controller thread; respond immediately
    return {"ok": True}


# ---------------------------------------------------------------------------
# read API (dashboard workstream builds on these)
# ---------------------------------------------------------------------------
@app.get("/api/state")
def state():
    """Everything the dashboard needs in one call: topology, zones, spots, gates,
    lanes, active cars, recent sessions, counters and activity feed."""
    return controller.snapshot()


@app.post("/api/resync")
def resync():
    """Re-read spots and gates from the simulator (costly - after a crash or level change)."""
    controller.request_resync()
    return {"ok": True}


# ---------------------------------------------------------------------------
# debug (used by tools/)
# ---------------------------------------------------------------------------
@app.get("/debug/stats")
def debug_stats():
    return {**intake.stats, "last_sequence_id": intake.last_seq,
            "controller_enabled": settings.controller_enabled, "queue_depth": controller.q.qsize()}


@app.get("/debug/recent")
def debug_recent(n: int = 20):
    return list(recent_events)[-n:]


@app.get("/debug/config")
def debug_config():
    """Effective settings (secrets masked) - check what the running instance uses."""
    return settings.model_dump(mode="json") | {"sim_password": "***"}

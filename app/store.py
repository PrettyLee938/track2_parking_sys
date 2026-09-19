"""Persistence seam.

TEMPORARY: appends JSON lines under GPA_DATA_DIR. The database workstream replaces
the bodies of these functions (same signatures) with real inserts; nothing else in
the app writes to disk.
"""
import json
import threading

from app.config import settings

_lock = threading.Lock()


def _append(name: str, record: dict):
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    with _lock, open(settings.data_dir / name, "a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")


def record_event(event: dict):
    """Every webhook received, with intake metadata (_sig, _duplicate, ...)."""
    _append(settings.event_log_path.name, event)


def record_session(session: dict):
    """A finished parking session: plate, car_type, lanes, spot, times, charge, payment."""
    _append("sessions.jsonl", session)


def record_action(action: dict):
    """A command we sent to the simulator, and whether it succeeded."""
    _append("actions.jsonl", action)

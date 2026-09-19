"""Webhook intake: parsing, signature check, dedupe and sequence tracking.

Kept separate from the controller so it can be unit-tested with plain dicts.
"""
import hashlib
import json
import threading

from app.config import settings


def parse_raw(body: bytes) -> dict:
    # Keep numbers as their original text so the signature is computed over exactly
    # what the simulator hashed (json floats would otherwise be re-formatted).
    return json.loads(body, parse_float=str, parse_int=str)


def compute_signature(payload: dict) -> str:
    """MD5 over the values of every field except Signature, ordered by field name."""
    joined = "|".join(str(payload[k]) for k in sorted(payload) if k != "Signature")
    return hashlib.md5(joined.encode("utf-8")).hexdigest()


def signature_status(payload: dict) -> str:
    """'valid' | 'unsigned' | 'invalid'. Level 1 sends Signature=null on every event."""
    received = payload.get("Signature")
    if not received:
        return "unsigned"
    return "valid" if compute_signature(payload) == str(received).lower() else "invalid"


class Intake:
    """Decides whether an incoming event should be processed, and keeps counters."""

    def __init__(self):
        self._lock = threading.Lock()
        self._seen_ids = set()
        self.last_seq = None
        self.stats = {"received": 0, "accepted": 0, "sig_valid": 0, "sig_unsigned": 0,
                      "sig_invalid": 0, "duplicates": 0, "seq_gaps": 0}

    def check(self, event: dict) -> dict:
        """Returns {'accept': bool, 'sig': str, 'duplicate': bool, 'seq_note': str}."""
        with self._lock:
            self.stats["received"] += 1
            sig = signature_status(event)
            self.stats[f"sig_{sig}"] += 1

            event_id = event.get("EventId")
            duplicate = bool(event_id) and event_id in self._seen_ids
            if duplicate:
                self.stats["duplicates"] += 1

            seq_note = ""
            seq = str(event.get("SequenceId", ""))
            seq = int(seq) if seq.isdigit() else None
            if not duplicate and seq is not None:
                if self.last_seq is not None and seq != self.last_seq + 1:
                    seq_note = f"expected {self.last_seq + 1}, got {seq}"
                    self.stats["seq_gaps"] += 1
                if self.last_seq is None or seq > self.last_seq:
                    self.last_seq = seq

            trusted = sig == "valid" or (sig == "unsigned" and not settings.require_signature)
            accept = trusted and not duplicate
            if accept:
                if event_id:
                    self._seen_ids.add(event_id)
                self.stats["accepted"] += 1
            return {"accept": accept, "sig": sig, "duplicate": duplicate, "seq_note": seq_note}

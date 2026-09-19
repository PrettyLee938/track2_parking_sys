"""End-to-end connectivity check: REST API in both directions + webhook delivery.

Prereqs: simulator running, the app (python -m app) running on APP_PORT, and the
simulator's settings.json WebhookUrl pointing at http://127.0.0.1:<port>/webhook.

Run from repo root:  .venv\\Scripts\\python -m tools.smoke_test [--gates]
"""
import sys
import time

import httpx

from app.config import settings
from app.protocol import EventClass, GateState, SpotPurpose
from app.sim_client import SimClient
from tools.site import resolve_site

LISTENER = f"http://127.0.0.1:{settings.app_port}"


def recent_events(n=100):
    return httpx.get(f"{LISTENER}/debug/recent", params={"n": n}).json()


def wait_for(pred, timeout=15.0, since_ids=frozenset()):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for e in recent_events():
            if e.get("EventId") not in since_ids and pred(e):
                return e
        time.sleep(0.25)
    return None


def main():
    ok = True
    def check(label, cond, detail=""):
        nonlocal ok
        ok &= bool(cond)
        print(f"  [{'PASS' if cond else 'FAIL'}] {label}{(' - ' + detail) if detail else ''}")

    print("1. Listener")
    try:
        httpx.get(f"{LISTENER}/debug/stats").raise_for_status()
        check("webhook listener reachable", True, LISTENER)
    except httpx.HTTPError as e:
        check("webhook listener reachable", False, str(e)); sys.exit(1)

    sim = SimClient()
    print("2. REST API (simulator -> us)")
    t = time.perf_counter(); sim.login()
    check("login", sim.token, f"{(time.perf_counter() - t) * 1000:.0f} ms")
    spots = sim.list_parking_spots()
    park = [s for s in spots if s["purpose"] == SpotPurpose.PARK]
    check("list-parking-spots", park, f"{len(park)} park spots, {len(spots) - len(park)} other")
    gates = {g["name"]: g for g in sim.list_barriers()}
    site = resolve_site(sim)
    GATE = next((l.gate for l in site.entry_lanes if l.gate), None)
    check("topology resolved", site.source != "fallback", f"{site.name}: {len(site.entry_lanes)} entries, {len(site.exit_lanes)} exits")
    check("list-barriers", GATE in gates, ", ".join(f"{n}={g['state']}" for n, g in gates.items()))

    print("3. Webhook delivery (simulator -> listener)")
    before = {e.get("EventId") for e in recent_events()}
    msg = sim.test_webhook()
    check("/test points at our listener", "127.0.0.1" in str(msg) or "localhost" in str(msg), msg)
    ev = wait_for(lambda e: e.get("EventClass") == EventClass.TEST, since_ids=before)
    check("test_webhook event received", ev, ev and f"seq={ev.get('SequenceId')}")
    # Level 1 sends Signature=null (even for /test once a level is running); only fail on a bad one.
    check("test_webhook signature not invalid", ev and ev.get("_sig") != "invalid",
          ev and ev.get("_sig"))

    print(f"4. Command round-trip on {GATE}")
    g = gates.get(GATE)
    if "--gates" not in sys.argv:
        print("  [SKIP] pass --gates to cycle the gate (only with CONTROLLER_ENABLED=0, "
              "or it interferes with the controller)")
    elif g is None:
        check(f"{GATE} present", False, "no level loaded? start Level 1 in the simulator window")
    elif g["broken"] or g["isUnderMaintenance"]:
        check(f"{GATE} operable", False, "broken/under maintenance - skipping (operating it is a penalty)")
    else:
        for action, call, target in (("open", sim.open_gate, GateState.OPEN), ("close", sim.close_gate, GateState.CLOSED)):
            before = {e.get("EventId") for e in recent_events()}
            t = time.perf_counter(); call(GATE)
            check(f"POST {action} accepted", True, f"{(time.perf_counter() - t) * 1000:.0f} ms")
            ev = wait_for(lambda e: e.get("EventClass") == EventClass.GATE_ACTION and e.get("Name") == GATE
                          and e.get("Action") == target, since_ids=before)
            check(f"gate_action {target} webhook", ev, ev and f"signature={ev.get('_sig')}")

    stats = httpx.get(f"{LISTENER}/debug/stats").json()
    print(f"\nListener stats: {stats}")
    print("\nALL PASS" if ok else "\nSOME CHECKS FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

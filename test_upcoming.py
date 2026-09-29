"""Advance notice for scheduled drops.

P-Bandai publishes a listing up to a day before it opens, carrying the exact
go-live timestamp:

    N9065181001  Waiting  CHANCE_TO_BUY_DRAWING,PRE_ORDER  starts +23.1h

Note the PRE_ORDER flag while still Waiting - naively that reads as "orderable
now", which would announce an open pre-order a day early. These cover the
advance notice, the reminder, and the go-live alert.

    python tests/test_upcoming.py
"""
import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import watcher  # noqa: E402
from watcher import Listing, classify, local_time_str, human_delta  # noqa: E402

CFG = {
    "ntfy": {"topic": "test", "priority": 4},
    "sources": [{"name": "test", "url": "https://example.invalid/x"}],
    "statuses": ["On", "Waiting"],
    "alert_on_restock": True,
    "alert_on_status_change": True,
    "include_lottery": True,
    "alert_new_when_unavailable": True,
    "alert_cooldown_hours": 6,
    "reminder_minutes": 60,
    "timezone": "America/New_York",
    # Fallback for hosts without tzdata (Windows). Linux runners use the
    # timezone above, which handles DST properly.
    "utc_offset_hours": -4,
    "heartbeat_hours": 0,
    "politeness_delay_seconds": 0,
}


def iso_in(**kw):
    return (datetime.now(timezone.utc) + timedelta(**kw)).isoformat().replace(
        "+00:00", "Z")


def listing(status, flags, start):
    return Listing(code="N9065181001", name="OP-16 Booster", url="u",
                   status=status, flags=list(flags), sale_start=start)


def main():
    results = []

    def check(label, got, want):
        ok = got == want
        results.append(ok)
        print(f"  [{'ok' if ok else 'FAIL'}] {label:52} -> {got!r}"
              + ("" if ok else f"  EXPECTED {want!r}"))

    print("\nadvance notice:\n")
    # The real case: Waiting + PRE_ORDER flag, 23h out.
    l = listing("Waiting", ["CHANCE_TO_BUY_DRAWING", "PRE_ORDER"], iso_in(hours=23))
    check("Waiting + PRE_ORDER 23h out is UPCOMING, not open",
          classify(l, None, CFG, frozenset()), "upcoming")

    l2 = listing("On", ["PRE_ORDER"], iso_in(hours=-1))
    check("already-started pre-order is a normal new listing",
          classify(l2, None, CFG, frozenset()), "new")

    print("\nreminder before the drop:\n")
    prev = {"status": "Waiting", "stock": "pre_order", "alerts": {}}
    l3 = listing("Waiting", ["PRE_ORDER"], iso_in(minutes=45))
    check("45 min out -> reminder", classify(l3, prev, CFG, frozenset()), "reminder")

    l4 = listing("Waiting", ["PRE_ORDER"], iso_in(hours=5))
    check("5 hours out -> no reminder yet",
          classify(l4, prev, CFG, frozenset()), None)

    check("reminder_minutes=0 disables it",
          classify(l3, prev, dict(CFG, reminder_minutes=0), frozenset()), None)

    print("\ngo-live:\n")
    prev_waiting = {"status": "Waiting", "stock": "pre_order", "alerts": {}}
    l5 = listing("On", ["PRE_ORDER"], iso_in(minutes=-2))
    check("Waiting -> On fires 'live'",
          classify(l5, prev_waiting, CFG, frozenset()), "live")

    ok = watcher.REASON_STYLE["live"][2] == 1
    results.append(ok)
    print(f"  [{'ok' if ok else 'FAIL'}] go-live is high priority")

    print("\nlocal time rendering (the drop lands at 10 PM Eastern):\n")
    rendered = local_time_str("2026-09-30T02:00:00Z", CFG)
    ok = "10:00 PM" in rendered
    results.append(ok)
    print(f"  [{'ok' if ok else 'FAIL'}] 02:00 UTC -> {rendered!r}")

    rendered_off = local_time_str("2026-09-30T02:00:00Z",
                                  {"utc_offset_hours": -4})
    ok = "10:00 PM" in rendered_off
    results.append(ok)
    print(f"  [{'ok' if ok else 'FAIL'}] offset fallback -> {rendered_off!r}")

    ok = local_time_str(None, CFG) == "unknown" and local_time_str("junk", CFG) == "unknown"
    results.append(ok)
    print(f"  [{'ok' if ok else 'FAIL'}] missing/garbage timestamps don't crash")

    for secs, want in [(90000, "1d 1h"), (3900, "1h 5m"), (300, "5m"), (-5, "0m")]:
        check(f"human_delta({secs})", human_delta(secs), want)

    print("\nfull timeline, one drop:\n")
    tmp = Path(tempfile.mkdtemp())
    watcher.STATE_PATH = tmp / "seen.json"
    sent = []
    watcher.notify = lambda l, cfg, reason, dry_run=False, prior_runs=None: (
        sent.append(reason) or True)

    def step(status, flags, start):
        watcher.fetch = lambda url, **kw: (
            "<html><script>PRELOAD_DATA = " + json.dumps(
                {"searchResult": {"productResults": {"totalCount": 1, "products": [{
                    "productCode": "N9065181001",
                    "productName": {"en": "OP-16 Booster"},
                    "saleStatus": status, "flags": flags,
                    "saleStartExpectedDt": start,
                    "fixedListPrice": {"amount": 120.0, "currency": "USD"}}]}}})
            + ";</script></html>")
        n = len(sent)
        watcher.run_once(CFG)
        return sent[n:]

    step("Waiting", ["PRE_ORDER"], iso_in(hours=30))          # seed, silent
    # A day out, seen for the first time after seeding -> handled by prev path.
    got = step("Waiting", ["PRE_ORDER"], iso_in(minutes=40))
    check("T-40m -> reminder", got, ["reminder"])
    got = step("On", ["PRE_ORDER"], iso_in(minutes=-1))
    check("go-live -> live", got, ["live"])
    got = step("On", ["PRE_ORDER"], iso_in(minutes=-5))
    check("still on sale -> quiet", got, [])

    passed = sum(results)
    print(f"\n{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())

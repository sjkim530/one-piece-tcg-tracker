"""Append the latest TCGCSV One Piece snapshot to the shared chart history."""

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen


HISTORY = Path(__file__).resolve().parent / "price-history"
BASE_URL = "https://tcgcsv.com"
CATEGORY = "/tcgplayer/68"
BUCKETS = 256
EPOCH = date(1970, 1, 1)


def download(path):
    request = Request(BASE_URL + path, headers={
        "User-Agent": "OPTCGQuant/2.19 (One Piece daily price history)",
    })
    with urlopen(request, timeout=25) as response:
        return response.read()


def feed_timestamp():
    stamp = datetime.fromisoformat(download("/last-updated.txt").decode().strip())
    if stamp.tzinfo is None:
        raise ValueError("TCGCSV build timestamp has no timezone")
    return stamp.astimezone(timezone.utc)


def results(path):
    payload = json.loads(download(path))
    if payload.get("success") is not True or not isinstance(payload.get("results"), list):
        raise ValueError(f"Unexpected TCGCSV response for {path}")
    return payload["results"]


def cents(value):
    if value is None:
        return None
    try:
        amount = Decimal(str(value))
        if amount.is_finite() and amount > 0:
            return int((amount * 100).to_integral_value(rounding=ROUND_HALF_UP)) or None
    except InvalidOperation:
        pass
    return None


def collect_quotes():
    groups = sorted({int(row["groupId"]) for row in results(CATEGORY + "/groups")})
    if not groups:
        raise ValueError("TCGCSV returned no One Piece groups")
    buckets = [{} for _ in range(BUCKETS)]
    for group in groups:
        time.sleep(.15)
        for row in results(f"{CATEGORY}/{group}/prices"):
            market = cents(row.get("marketPrice"))
            if market is None:
                continue
            product = int(row["productId"])
            key = f'{product}:{row.get("subTypeName") or ""}'
            buckets[product % BUCKETS][key] = [market, cents(row.get("lowPrice"))]
    if not any(buckets):
        raise ValueError("TCGCSV returned no One Piece prices")
    return buckets


def write_json(path, data):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")
    temp.replace(path)


def sync():
    status_path = HISTORY / "status.json"
    stamp = feed_timestamp()
    if status_path.exists():
        previous = datetime.fromisoformat(json.loads(status_path.read_text(encoding="utf-8"))["sourceUpdatedAt"])
        if previous >= stamp:
            print(f"Already saved the {previous.isoformat()} feed")
            return

    day = (stamp.date() - EPOCH).days
    # Check the existing archive before making the group requests.
    paths = [HISTORY / f"{bucket}.json" for bucket in range(BUCKETS)]
    archive = [json.loads(path.read_text(encoding="utf-8")) for path in paths]
    quotes = collect_quotes()
    if feed_timestamp() != stamp:
        raise RuntimeError("TCGCSV changed builds during collection. Retry the sync.")

    # The existing archive stores newest first. Also remove any same-day
    # entries from a manual backfill or from an interrupted earlier write.
    for path, old, fresh in zip(paths, archive, quotes):
        for key, series in old.items():
            for index in range(0, len(series), 3):
                if series[index] == day:
                    del series[index:index + 3]
                    break
                if series[index] < day:
                    break
        for key, prices in fresh.items():
            series = old.setdefault(key, [])
            index = next((i for i in range(0, len(series), 3) if series[i] < day), len(series))
            series[index:index] = [day, *prices]
        write_json(path, {key: series for key, series in old.items() if series})

    count = sum(map(len, quotes))
    write_json(status_path, {"sourceUpdatedAt": stamp.isoformat(), "quotes": count})
    print(f"Saved {count:,} One Piece prices from {stamp.isoformat()}")


if __name__ == "__main__":
    sync()

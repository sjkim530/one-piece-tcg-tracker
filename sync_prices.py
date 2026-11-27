"""Append the latest TCGCSV One Piece snapshot to the shared chart history."""

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json
import hashlib
from pathlib import Path
import subprocess
import time
from urllib.request import Request, urlopen


HISTORY = Path(__file__).resolve().parent / "price-history"
ROOT = Path(__file__).resolve().parent
METADATA = ROOT / "card-metadata.json"
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
    singles = {}
    metadata = {}
    for group in groups:
        time.sleep(.15)
        for row in results(f"{CATEGORY}/{group}/products"):
            product = single_metadata(row)
            if product:
                product_id, card_type, card = product
                singles[product_id] = card_type or "Other single"
                metadata[product_id] = card
        for row in results(f"{CATEGORY}/{group}/prices"):
            market = cents(row.get("marketPrice"))
            if market is None:
                continue
            product = int(row["productId"])
            key = f'{product}:{row.get("subTypeName") or ""}'
            buckets[product % BUCKETS][key] = [market, cents(row.get("lowPrice"))]
    if not any(buckets):
        raise ValueError("TCGCSV returned no One Piece prices")
    if not singles:
        raise ValueError("TCGCSV returned no classified One Piece singles")
    return buckets, singles, metadata


def single_metadata(row):
    fields = {entry["name"]: entry["value"] for entry in row.get("extendedData", [])}
    card_type = (fields.get("Card Type") or fields.get("CardType") or "").strip()
    number = (fields.get("Number") or "").strip()
    if not (card_type or number):
        return None
    card = {"card_name": row.get("name") or "", "rarity": (fields.get("Rarity") or "").strip(),
            "card_type": card_type}
    return str(int(row["productId"])), card_type, card


def collect_metadata():
    """Repair missing rarity data without rewriting an already-saved quote day."""
    groups = sorted({int(row["groupId"]) for row in results(CATEGORY + "/groups")})
    if not groups:
        raise ValueError("TCGCSV returned no One Piece groups")
    cards = {}
    for group in groups:
        time.sleep(.15)
        for row in results(f"{CATEGORY}/{group}/products"):
            product = single_metadata(row)
            if product:
                cards[product[0]] = product[2]
    if not cards:
        raise ValueError("TCGCSV returned no classified One Piece singles")
    return cards


def metadata_current(stamp):
    try:
        metadata = json.loads(METADATA.read_text(encoding="utf-8"))
        engine_hash = hashlib.sha256()
        for file in ("data.js", "engine.js"):
            engine_hash.update((ROOT / file).read_text(encoding="utf-8").encode("utf-8"))
        return (metadata.get("version") == 1 and bool(metadata.get("cards"))
                and datetime.fromisoformat(metadata["sourceUpdatedAt"]) == stamp
                and metadata.get("rarityEngineSha256") == engine_hash.hexdigest())
    except (OSError, ValueError, KeyError, TypeError):
        return False


def export_metadata(cards, stamp):
    # Canonical badge rules live in engine.js; do not duplicate them in Python.
    subprocess.run(["node", str(ROOT / "build-card-metadata.cjs"), "--stdin", "--output", str(METADATA)],
                   input=json.dumps({"sourceUpdatedAt": stamp.isoformat(), "cards": cards}),
                   text=True, check=True)


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
            if previous > stamp:
                if not metadata_current(previous):
                    raise RuntimeError("The catalog feed is older than saved prices; cannot refresh matching rarity metadata yet.")
                print(f"Already saved the newer {previous.isoformat()} feed")
                return
            if not metadata_current(stamp):
                metadata = collect_metadata()
                if feed_timestamp() != stamp:
                    raise RuntimeError("TCGCSV changed builds during metadata collection. Retry the sync.")
                export_metadata(metadata, stamp)
            print(f"Already saved the {previous.isoformat()} feed")
            return

    day = (stamp.date() - EPOCH).days
    # Check the existing archive before making the group requests.
    paths = [HISTORY / f"{bucket}.json" for bucket in range(BUCKETS)]
    archive = [json.loads(path.read_text(encoding="utf-8")) for path in paths]
    quotes, singles, metadata = collect_quotes()
    if feed_timestamp() != stamp:
        raise RuntimeError("TCGCSV changed builds during collection. Retry the sync.")
    export_metadata(metadata, stamp)

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
    write_json(HISTORY / "singles.json", {"sourceUpdatedAt": stamp.isoformat(), "products": singles})
    write_json(status_path, {"sourceUpdatedAt": stamp.isoformat(), "quotes": count})
    print(f"Saved {count:,} One Piece prices from {stamp.isoformat()}")


if __name__ == "__main__":
    sync()

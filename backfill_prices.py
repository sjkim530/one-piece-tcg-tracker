"""Build the static One Piece history from immutable daily TCGCSV archives."""

import argparse
import concurrent.futures
from datetime import date, timedelta
import json
from pathlib import Path
from threading import Lock
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import py7zr
from py7zr.io import BytesIOFactory


ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".price-cache"
OUTPUT = ROOT / "price-history"
BASE_URL = "https://tcgcsv.com/archive/tcgplayer"
ARCHIVE_START = date(2024, 2, 8)
BUCKETS = 256
download_lock = Lock()
next_request = 0.0
rate_limit = None


def open_archive(request):
    global next_request, rate_limit
    with download_lock:
        if rate_limit:
            raise rate_limit
        time.sleep(max(0, next_request - time.monotonic()))
        try:
            return urlopen(request, timeout=45)
        except HTTPError as error:
            if error.code == 429:
                rate_limit = error
            raise
        finally:
            next_request = time.monotonic() + 2.5


def read_archive(day, cached_only=False):
    filename = f"prices-{day}.ppmd.7z"
    archive = CACHE / filename
    if not archive.exists():
        if cached_only:
            return day, None
        request = Request(f"{BASE_URL}/{filename}", headers={
            "User-Agent": "OPTCGQuant/2.15 (One Piece price history)"
        })
        for attempt in range(3):
            try:
                with open_archive(request) as response:
                    data = response.read()
                temporary = archive.with_suffix(".partial")
                temporary.write_bytes(data)
                temporary.replace(archive)
                break
            except HTTPError as error:
                if error.code == 404:
                    return day, None
                if error.code == 429:
                    raise
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
            except OSError:
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)

    with py7zr.SevenZipFile(archive) as files:
        targets = [name for name in files.getnames()
                   if name.startswith(f"{day}/68/") and name.endswith("/prices")]
        factory = BytesIOFactory(20_000_000)
        files.extract(targets=targets, factory=factory)
    quotes = {}
    for target in targets:
        stream = factory.get(target)
        stream.seek(0)
        payload = json.loads(stream.read())
        if payload.get("success") is not True:
            raise ValueError(f"{day}: archive contains an unsuccessful price response")
        for row in payload["results"]:
            market = row.get("marketPrice")
            if market is None or market <= 0:
                continue
            market_cents = round(market * 100)
            if market_cents == 0:
                continue
            product = int(row["productId"])
            printing = row.get("subTypeName") or ""
            low = row.get("lowPrice")
            quotes[(product, printing)] = (
                market_cents, (round(low * 100) or None) if low is not None and low > 0 else None
            )
    if not quotes:
        raise ValueError(f"{day}: no One Piece market prices in the archive")
    return day, quotes


def write_json(path, data):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    temporary.replace(path)


def build_history(days, cached_only):
    series = [{} for _ in range(BUCKETS)]
    available = []
    limited = False
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for offset in range(0, len(days), 4):
            batch = days[offset:offset + 4]
            results = pool.map(lambda day: read_archive(day, cached_only or limited), batch)
            try:
                quotes_by_day = list(results)
            except HTTPError as error:
                if error.code != 429:
                    raise
                print("TCGCSV rate-limited downloads. Building from cached files.", flush=True)
                limited = True
                quotes_by_day = list(pool.map(lambda day: read_archive(day, True), batch))
            for day, quotes in quotes_by_day:
                if quotes is None:
                    continue
                ordinal = (day - date(1970, 1, 1)).days
                for (product, printing), (market, low) in quotes.items():
                    key = f"{product}:{printing}"
                    series[product % BUCKETS].setdefault(key, []).extend((ordinal, market, low))
                available.append(day)
            if (offset // 4 + 1) % 10 == 0:
                print(f"Processed {min(offset + 4, len(days))} of {len(days)} dates", flush=True)
    return series, available, limited


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", required=True, type=date.fromisoformat)
    parser.add_argument("--end", required=True, type=date.fromisoformat)
    parser.add_argument("--cached-only", action="store_true", help="Build from previously downloaded archives")
    args = parser.parse_args()
    if not ARCHIVE_START <= args.start <= args.end:
        parser.error(f"choose an ascending date range starting on or after {ARCHIVE_START}")

    CACHE.mkdir(exist_ok=True)
    OUTPUT.mkdir(exist_ok=True)
    # Recent prices are useful first if the archive service caps a run.
    days = [args.end - timedelta(days=offset) for offset in range((args.end - args.start).days + 1)]
    series, available, limited = build_history(days, args.cached_only)

    if not available:
        parser.exit(1, "No dated One Piece archives were found. Existing history was retained.\n")
    for bucket, prices in enumerate(series):
        write_json(OUTPUT / f"{bucket}.json", prices)
    print(f"Built {len(available)}/{len(days)} days from {available[-1]} to {available[0]}.")
    if limited:
        parser.exit(1, "Run again after the archive service cooldown to resume the backfill.\n")


if __name__ == "__main__":
    main()

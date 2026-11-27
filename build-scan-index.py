"""Build the on-device scanner's compact ORB artwork reference index.

Requires opencv-python-headless==4.12.0.88. No user photos are read here.
The cache belongs outside the published app; only scan-index/ is public.
"""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import struct
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parent
DEFAULT_PROXY = "https://optcg-quant-data.gomu-gomu-santoryu.workers.dev"
ORIGIN = "https://sjkim530.github.io"
ORB = {"nfeatures": 1000, "scaleFactor": 1.2, "nlevels": 8,
       "edgeThreshold": 15, "firstLevel": 0, "WTA_K": 2,
       "scoreType": 0, "patchSize": 31, "fastThreshold": 12}
LONG_SIDE = 420
FEATURES_PER_CARD = 96
GRID = (4, 6)
RECORD_BYTES = 36
CACHE_VERSION = "orb-4.12-long420-spatial-v2"


def fetch(url):
    """Bounded requests/retries, including a finite body-size limit."""
    for attempt in range(3):
        try:
            request = Request(url, headers={"User-Agent": "GrandLineVault-VisualIndex/1",
                                            "Origin": ORIGIN})
            with urlopen(request, timeout=25) as response:
                body = response.read(8_000_001)
            if len(body) > 8_000_000:
                raise ValueError("Reference response exceeds 8 MB")
            return body
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            if isinstance(error, HTTPError) and 400 <= error.code < 500 and error.code != 429:
                raise
            if attempt == 2:
                raise
            time.sleep(.4 * (attempt + 1))


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")
    temp.replace(path)


def parse_cards(body):
    cards = []
    for row in csv.DictReader(io.StringIO(body.decode("utf-8-sig"))):
        # Mirrors source.js isCard: numbered cards and unnumbered DON!! singles.
        if not (row.get("extNumber", "").strip() or row.get("extCardType", "").strip()):
            continue
        product_id = row.get("productId", "")
        if not product_id.isdigit():
            continue
        cards.append({"id": product_id, "name": row.get("name", ""),
                      "number": row.get("extNumber", ""), "image": row.get("imageUrl", ""),
                      "modified": row.get("modifiedOn", "")})
    return cards


def catalog(args):
    if args.catalog_dir:
        paths = sorted(args.catalog_dir.glob("*.csv"))
        if not paths:
            raise ValueError("No CSV catalogs found")
        rows = [card for path in paths for card in parse_cards(path.read_bytes())]
        return rows, {"mode": "local", "groups": len(paths)}
    payload = json.loads(fetch(args.proxy.rstrip("/") + "/groups"))
    if payload.get("success") is not True or not isinstance(payload.get("results"), list):
        raise ValueError("Invalid catalog groups response")
    groups = sorted({int(row["groupId"]) for row in payload["results"]})
    if not groups:
        raise ValueError("Empty catalog groups response")
    rows, failures = [], []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(fetch, args.proxy.rstrip("/") + f"/g/{group}"): group for group in groups}
        for job in as_completed(jobs):
            group = jobs[job]
            try:
                body = job.result()
                parsed = parse_cards(body)
                if not body.startswith(b"productId,") and not body.startswith(b"\xef\xbb\xbfproductId,"):
                    raise ValueError("Unexpected CSV headers")
                rows.extend(parsed)
            except Exception as error:
                failures.append({"group": group, "error": str(error)[:180]})
    # A failed set fetch must not quietly remove all of that set's references.
    if failures:
        raise RuntimeError("Catalog groups failed; previous index retained: " + json.dumps(failures))
    return rows, {"mode": "catalog", "groups": len(groups)}


def features(image_bytes):
    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None or min(image.shape) < 40:
        raise ValueError("Artwork is missing or too small")
    height, width = image.shape
    scale = LONG_SIDE / max(width, height)
    image = cv2.resize(image, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    height, width = image.shape
    keypoints, descriptors = cv2.ORB_create(**ORB).detectAndCompute(image, None)
    if descriptors is None or len(keypoints) < 8:
        raise ValueError("Artwork has too few visual features")
    selected = spatial_features(keypoints, width, height)
    records = bytearray()
    for position in selected:
        point, descriptor = keypoints[position], descriptors[position]
        x = max(0, min(65535, round(point.pt[0] / width * 65535)))
        y = max(0, min(65535, round(point.pt[1] / height * 65535)))
        records.extend(descriptor.tobytes())
        records.extend(struct.pack("<HH", x, y))
    return bytes(records), width, height, len(selected)


def spatial_features(keypoints, width, height):
    """Keep artwork features across the card instead of only dense rules text.

    ORB's globally strongest 96 points often all fall in the name/rules area.
    Round-robin selection from spatial cells keeps the same compact byte budget
    while giving the large artwork region a proportional share of references.
    """
    columns, rows = GRID
    cells = [[] for _ in range(columns * rows)]
    for position, point in enumerate(keypoints):
        x = min(columns - 1, max(0, int(point.pt[0] / width * columns)))
        y = min(rows - 1, max(0, int(point.pt[1] / height * rows)))
        cells[y * columns + x].append(position)
    for cell in cells:
        cell.sort(key=lambda i: (-keypoints[i].response, keypoints[i].pt[1], keypoints[i].pt[0], keypoints[i].octave))
    selected, level = [], 0
    while len(selected) < min(FEATURES_PER_CARD, len(keypoints)):
        for cell in cells:
            if level < len(cell):
                selected.append(cell[level])
                if len(selected) == FEATURES_PER_CARD:
                    return selected
        level += 1
    return selected


def reference(card, cache):
    image_url = card["image"].replace("_200w.jpg", "_400w.jpg")
    if not image_url.startswith("https://tcgplayer-cdn.tcgplayer.com/"):
        raise ValueError("No supported catalog artwork URL")
    profile = json.dumps({"version": CACHE_VERSION, "orb": ORB, "longSide": LONG_SIDE,
                          "features": FEATURES_PER_CARD, "grid": GRID,
                          "selection": "spatial-round-robin"}, sort_keys=True)
    signature = hashlib.sha256((profile + image_url + card["modified"]).encode()).hexdigest()
    path = cache / "features" / (card["id"] + ".json")
    if path.exists():
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
            blob = base64.b64decode(saved["data"], validate=True)
            if saved["signature"] == signature and len(blob) == saved["count"] * RECORD_BYTES:
                return blob, saved["width"], saved["height"], saved["count"], True
        except (ValueError, KeyError):
            pass
    blob, width, height, count = features(fetch(image_url))
    write_json(path, {"signature": signature, "data": base64.b64encode(blob).decode("ascii"),
                      "width": width, "height": height, "count": count})
    return blob, width, height, count, False


def pack_references(found):
    """Index identical feature records once without dropping printing IDs."""
    entries, binary, offset, aliases = [], bytearray(), 0, {}
    for product_id, (blob, width, height, count) in sorted(found.items(), key=lambda pair: int(pair[0])):
        key = (width, height, blob)
        if key in aliases:
            aliases[key].setdefault("aliases", []).append(product_id)
            continue
        entry = {"id": product_id, "offset": offset, "count": count, "width": width, "height": height}
        entries.append(entry)
        aliases[key] = entry
        binary.extend(blob)
        offset += count
    return entries, binary, offset


def build(args):
    cv2.setNumThreads(1)
    rows, source = catalog(args)
    cards = {card["id"]: card for card in rows}
    if args.limit:
        cards = dict(sorted(cards.items(), key=lambda pair: int(pair[0]))[:args.limit])
    if not cards:
        raise ValueError("Catalog contains no singles")
    print(f"Catalog: {len(cards)} unique singles across {source['groups']} groups", flush=True)
    found, failures, hits = {}, [], 0
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(reference, card, args.cache): card for card in cards.values()}
        for i, job in enumerate(as_completed(jobs), 1):
            card = jobs[job]
            try:
                blob, width, height, count, hit = job.result()
                found[card["id"]] = (blob, width, height, count)
                hits += int(hit)
            except Exception as error:
                failures.append({"id": card["id"], "number": card["number"], "error": str(error)[:180]})
            if i % 250 == 0 or i == len(cards):
                print(f"References {i}/{len(cards)}: {len(found)} indexed, {len(failures)} unavailable, {hits} cache hits", flush=True)
    if not found or len(found) / len(cards) < .9:
        raise RuntimeError("Less than 90% of catalog artwork indexed; previous index retained")
    entries, binary, offset = pack_references(found)
    args.output.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(binary).hexdigest()
    # The content hash prevents a new manifest from racing an old cached binary.
    filename = f"scan-vision-{digest[:16]}.bin"
    binary_path = args.output / filename
    temp = binary_path.with_suffix(".tmp")
    temp.write_bytes(binary)
    temp.replace(binary_path)
    manifest = {"version": 1, "descriptorBytes": 32, "recordBytes": RECORD_BYTES,
                "featuresPerCard": FEATURES_PER_CARD, "longSide": LONG_SIDE, "orb": ORB,
                "selection": {"method": "spatial-round-robin", "columns": GRID[0], "rows": GRID[1]},
                "binary": filename, "sha256": digest, "byteLength": len(binary),
                "builtAt": datetime.now(timezone.utc).isoformat(), "source": source,
                "coverage": {"catalogCards": len(cards), "indexedCards": len(found), "referenceImages": len(entries),
                             "unavailableCards": len(failures), "complete": not failures,
                             "failures": sorted(failures, key=lambda row: int(row["id"]))},
                "cards": entries}
    write_json(args.output / "manifest.json", manifest)
    # Only files generated by this script in its dedicated output directory.
    for obsolete in args.output.glob("scan-vision-*.bin"):
        if obsolete != binary_path:
            obsolete.unlink()
    print(f"Wrote {len(found)} cards / {len(entries)} reference images / {offset} features / {len(binary):,} bytes in {time.monotonic() - started:.1f}s ({hits} cached)", flush=True)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "scan-index")
    parser.add_argument("--cache", type=Path, default=ROOT.parent.parent / ".tools" / "optcg-vision-cache")
    parser.add_argument("--catalog-dir", type=Path, help="Read local CSV groups instead of downloading the catalog")
    parser.add_argument("--proxy", default=DEFAULT_PROXY)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--limit", type=int, help="Development only: limit the number of singles")
    args = parser.parse_args()
    if not 1 <= args.workers <= 12:
        parser.error("workers must be between 1 and 12")
    build(args)


if __name__ == "__main__":
    main()

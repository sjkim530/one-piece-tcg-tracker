#!/usr/bin/env python3
"""
Premium Bandai (US) listing watcher.

Polls a set of P-Bandai listing pages, detects newly-appeared products and
status changes, and pushes an alert to ntfy.sh (phone + desktop).

Data is read from what the pages already render server-side:
  * series pages carry a `PRELOAD_DATA = {...}` blob (title, code, price,
    sale status, sale-start time)
  * brand pages carry a JSON-LD ItemList (title + url)

Both are fetched over plain HTTP - no browser, no JS, no dependencies.

Usage:
    python watcher.py --once            # single pass (cron / CI)
    python watcher.py --loop 60         # poll forever, every 60s
    python watcher.py --seed            # record current listings, alert on none
    python watcher.py --once --dry-run  # print what would be sent
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import random
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
STATE_PATH = ROOT / "state" / "seen.json"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# Exit codes: 0 = ok, 1 = fatal config/setup error, 2 = all sources failed.
EXIT_OK, EXIT_CONFIG, EXIT_FETCH = 0, 1, 2


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
    print(f"[{ts}] {msg}", flush=True)


# --------------------------------------------------------------------------
# fetching
# --------------------------------------------------------------------------

def fetch(url: str, timeout: int = 45, retries: int = 3) -> str:
    """GET a URL, following the site's expectations. Retries on transient errors."""
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip",
    }
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return raw.decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001 - retry anything transient
            last = exc
            if attempt < retries:
                backoff = 2 ** attempt + random.uniform(0, 1)
                log(f"  fetch failed ({exc}); retry {attempt}/{retries - 1} in {backoff:.1f}s")
                time.sleep(backoff)
    raise RuntimeError(f"GET {url} failed after {retries} attempts: {last}")


def is_bot_challenge(html: str) -> bool:
    """P-Bandai serves an obfuscated JS interstitial (200, empty <title>) to
    clients it doesn't like. Detect it so we don't read it as 'no listings'."""
    return "<title></title>" in html and "PRELOAD_DATA" not in html


# --------------------------------------------------------------------------
# parsing
# --------------------------------------------------------------------------

# States you can act on. "lottery" is a draw entry rather than a purchase, so
# it's opt-out via config rather than lumped in unconditionally.
ALWAYS_ACTIONABLE = {"in_stock", "pre_order"}
LOTTERY = "lottery"


def actionable(stock: str, cfg: dict) -> bool:
    """Can the user do something about this listing right now?"""
    if stock in ALWAYS_ACTIONABLE:
        return True
    return stock == LOTTERY and cfg.get("include_lottery", True)


def stock_state(flags: list[str]) -> str:
    """Derive buyability from P-Bandai's flags.

    `saleStatus` is the *sale window*, not availability - an item can sit at
    saleStatus "On" while flagged OUT_OF_STOCK. Availability lives here, so
    this is what restock alerts key off.

    Buyable states are checked first: an item carrying both PRE_ORDER and a
    lottery flag is still orderable.
    """
    if "IN_STOCK" in flags:
        return "in_stock"
    if "PRE_ORDER" in flags:
        return "pre_order"
    if "OUT_OF_STOCK" in flags:
        return "out_of_stock"
    if "PRE_ORDER_CLOSED" in flags:
        return "closed"
    if "CHANCE_TO_BUY_DRAWING" in flags:
        return "lottery"
    return "unknown"


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def local_time_str(value: str | None, cfg: dict) -> str:
    """Render a sale time in the user's timezone.

    The runner is UTC, so "02:00" means nothing at a glance - it's 10 PM the
    previous evening in US Eastern, which is when these drops actually land.
    """
    dt = parse_dt(value)
    if not dt:
        return "unknown"
    tzname = cfg.get("timezone")
    if tzname:
        try:
            from zoneinfo import ZoneInfo
            local = dt.astimezone(ZoneInfo(tzname))
            return local.strftime("%a %b %d, %I:%M %p %Z")
        except Exception:  # noqa: BLE001
            # Windows ships no tzdata, so ZoneInfo raises there. Fall through
            # to the fixed offset rather than silently printing UTC, which
            # would be 10 hours off and look plausible.
            pass
    off = cfg.get("utc_offset_hours")
    if off is not None:
        local = dt + timedelta(hours=float(off))
        return local.strftime("%a %b %d, %I:%M %p ") + f"(UTC{float(off):+g})"
    return dt.strftime("%a %b %d, %H:%M UTC")


def human_delta(seconds: float) -> str:
    seconds = int(max(0, seconds))
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    mins = rem // 60
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {mins}m"
    return f"{mins}m"


def base_code(code: str) -> str:
    """Strip the run number off a product code.

    P-Bandai does not restock a listing - it publishes a NEW listing with a
    new code for each batch of inventory. The last three digits are the run
    number, and everything before it identifies the product:

        N2904549002  Chinese 3rd Anniversary Set   sale 2026-08-05
        N2904549003  Chinese 3rd Anniversary Set   sale 2026-08-25

    Confirmed by the internal ids too (NAP0465794002US -> NAP0465794003US).
    So "this product is available again" shows up as a new code sharing a
    base, NOT as a stock flag changing on the old one.

    Grouping on the code rather than the name is deliberate: re-runs often
    retitle themselves ("[September 2026 Delivery]" vs "[October 2026
    Delivery]") while keeping the same base code.

    Only codes matching the observed shape (a letter, then digits, with a
    3-digit run number) are grouped. Anything else is returned whole - it is
    far better to miss a grouping than to merge two unrelated products and
    fire a bogus restock alert.
    """
    if len(code) >= 8 and code[-3:].isdigit() and code[1:].isdigit():
        return code[:-3]
    return code


@dataclass
class Listing:
    code: str
    name: str
    url: str
    status: str | None = None          # Waiting | On | End  (sale window)
    price: float | None = None
    currency: str = "USD"
    sale_start: str | None = None
    flags: list[str] = field(default_factory=list)
    source: str = ""

    @property
    def stock(self) -> str:
        # in_stock | pre_order | lottery | out_of_stock | closed | unknown
        return stock_state(self.flags)

    def key(self) -> str:
        return self.code

    @property
    def base(self) -> str:
        return base_code(self.code)

    def starts_in(self) -> float | None:
        """Seconds until the sale opens; negative if it already has."""
        dt = parse_dt(self.sale_start)
        if not dt:
            return None
        return (dt - datetime.now(timezone.utc)).total_seconds()

    def is_upcoming(self) -> bool:
        secs = self.starts_in()
        return secs is not None and secs > 0

    def price_str(self) -> str:
        return f"${self.price:,.2f}" if self.price is not None else "price TBA"


def _extract_js_object(html: str, marker: str) -> dict | None:
    """Pull `marker = {...}` out of a <script> body by brace matching.

    Naive depth counting would break on braces inside strings, so this tracks
    string state and escapes.
    """
    idx = html.find(marker)
    if idx == -1:
        return None
    i = html.index("{", idx)
    start = i
    depth = 0
    in_str = False
    quote = ""
    escaped = False
    while i < len(html):
        ch = html[i]
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                in_str = False
        elif ch in "\"'":
            in_str = True
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(html[start:i + 1])
                except json.JSONDecodeError:
                    return None
        i += 1
    return None


def parse_preload(html: str, source: str) -> list[Listing]:
    """Series/search pages: PRELOAD_DATA.searchResult.productResults.products"""
    data = _extract_js_object(html, "PRELOAD_DATA")
    if not data:
        return []
    products = (
        data.get("searchResult", {})
            .get("productResults", {})
            .get("products")
    )
    if not products:
        return []

    out: list[Listing] = []
    for p in products:
        code = p.get("productCode")
        if not code:
            continue
        name = (p.get("productName") or {}).get("en") or "(untitled)"
        price_obj = p.get("fixedListPrice") or p.get("baseListPrice") or {}
        out.append(Listing(
            code=code,
            name=name.strip(),
            url=f"https://p-bandai.com/us/item/{code}",
            status=p.get("saleStatus"),
            price=price_obj.get("amount"),
            currency=price_obj.get("currency") or "USD",
            sale_start=p.get("saleStartExpectedDt"),
            flags=list(p.get("flags") or []),
            source=source,
        ))
    return out


_LD_RE = re.compile(
    r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>', re.S | re.I
)
_ITEM_URL_RE = re.compile(r"/us/item/([A-Za-z0-9]+)")


def parse_jsonld(html: str, source: str) -> list[Listing]:
    """Brand/shop pages: JSON-LD CollectionPage -> mainEntity.itemListElement"""
    out: list[Listing] = []
    seen: set[str] = set()
    for block in _LD_RE.findall(html):
        try:
            doc = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        for node in doc if isinstance(doc, list) else [doc]:
            if not isinstance(node, dict):
                continue
            entity = node.get("mainEntity") or node
            items = entity.get("itemListElement") if isinstance(entity, dict) else None
            for it in items or []:
                if not isinstance(it, dict):
                    continue
                url = it.get("url") or (it.get("item") or {}).get("@id", "")
                name = it.get("name") or (it.get("item") or {}).get("name")
                m = _ITEM_URL_RE.search(url or "")
                if not (m and name):
                    continue  # breadcrumbs and nav lists land here; skip them
                code = m.group(1)
                if code in seen:
                    continue
                seen.add(code)
                out.append(Listing(
                    code=code,
                    name=name.strip(),
                    url=f"https://p-bandai.com/us/item/{code}",
                    source=source,
                ))
    return out


def parse_listings(html: str, source: str) -> list[Listing]:
    """PRELOAD_DATA is richer, so prefer it; merge in any JSON-LD extras."""
    listings = parse_preload(html, source)
    known = {l.code for l in listings}
    for extra in parse_jsonld(html, source):
        if extra.code not in known:
            listings.append(extra)
    return listings


# --------------------------------------------------------------------------
# matching
# --------------------------------------------------------------------------

def normalize(text: str) -> str:
    """Casefold + strip accents/punctuation so 'ONE PIECE', 'One-Piece' and
    'one   piece' all compare equal."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^a-z0-9]+", " ", text.casefold())
    return f" {text.strip()} "


def matches(listing: Listing, match_cfg: dict) -> bool:
    keywords = match_cfg.get("keywords") or []
    exclude = match_cfg.get("exclude") or []
    mode = (match_cfg.get("mode") or "off").lower()

    hay = normalize(listing.name)

    for term in exclude:
        if normalize(term).strip() in hay:
            return False

    if mode == "off" or not keywords:
        # Sources are already scoped to what we care about, so everything
        # they list counts. This is the default, and it is deliberate:
        # see README - most One Piece products don't say "One Piece".
        return True

    hits = [normalize(k).strip() in hay for k in keywords]
    return all(hits) if mode == "all" else any(hits)


def classify(listing: Listing, prev: dict | None, cfg: dict,
             known_bases: frozenset[str] = frozenset()) -> str | None:
    """Decide whether a listing is worth a push, and why.

    Returns one of REASON_STYLE's keys, or None to stay quiet.

    Order matters: availability outranks a sale-window change, because it's
    the one the user can act on. Only one alert per listing per pass.
    """
    if prev is None:
        # Brand new to us. Stay quiet if it showed up already finished.
        if not status_allowed(listing, cfg):
            return None

        # A new code sharing a base with something we've already seen is the
        # same product listed again - i.e. fresh inventory. That is the real
        # restock signal on this site, and it is never suppressed for looking
        # sold-out: these windows are short and the stock flag is unreliable.
        if listing.base in known_bases:
            return "rerun"

        # The site publishes drops up to a day early, with the exact go-live
        # time. Say so, rather than claiming a pre-order is open when it does
        # not open for another 23 hours - these carry a PRE_ORDER flag while
        # still Waiting, which would otherwise read as "orderable now".
        if listing.is_upcoming():
            return "upcoming"

        if (not actionable(listing.stock, cfg)
                and not cfg.get("alert_new_when_unavailable", True)):
            return None
        return "new"

    was_stock = prev.get("stock", "unknown")
    was_status = prev.get("status")

    # Fires on any unactionable -> actionable move: a sold-out item returning,
    # a pre-order opening, or a lottery opening for entry.
    if (cfg.get("alert_on_restock", True)
            and actionable(listing.stock, cfg)
            and not actionable(was_stock, cfg)):
        return "restock"

    # Drop is imminent. Time-based rather than a transition, so the cooldown
    # is what keeps it to a single nudge. A wide window means a late-running
    # scheduler still delivers it in time to be useful.
    window = float(cfg.get("reminder_minutes", 60)) * 60
    if window > 0:
        secs = listing.starts_in()
        if secs is not None and 0 < secs <= window:
            return "reminder"

    if cfg.get("alert_on_status_change", True):
        if listing.status == "On" and was_status != "On":
            return "live"
        if listing.status == "Waiting" and was_status == "End":
            return "reopened"

    return None


def within_cooldown(prev: dict | None, reason: str, hours: float) -> bool:
    """Has this exact alert already fired for this listing recently?

    P-Bandai load-balances across backends that disagree about stock: the same
    URL can report PRE_ORDER and OUT_OF_STOCK seconds apart. That flapping
    would otherwise re-fire a restock alert every time the reply changed.

    Deliberately *not* solved by demanding repeated confirmation, which would
    delay or swallow a real drop. We alert on first sight and cap repeats.
    """
    if not prev or hours <= 0:
        return False
    stamp = (prev.get("alerts") or {}).get(reason)
    if not stamp:
        return False
    try:
        when = datetime.fromisoformat(stamp)
    except (ValueError, TypeError):
        return False
    return (datetime.now(timezone.utc) - when).total_seconds() < hours * 3600


def status_allowed(listing: Listing, cfg: dict) -> bool:
    """Keep only the sale statuses we care about (e.g. On = in stock,
    Waiting = pre-order, End = finished).

    We can't filter this server-side: the site's own `_f_productStatuses`
    param is disallowed by robots.txt, so we fetch the unfiltered page and
    drop the rest here.

    A listing with no status came from a JSON-LD source, which doesn't publish
    one. Those are allowed through rather than silently dropped - better a
    surplus alert than a missed drop.
    """
    allowed = cfg.get("statuses")
    if not allowed:
        return True
    if listing.status is None:
        return True
    return listing.status in allowed


# --------------------------------------------------------------------------
# state
# --------------------------------------------------------------------------

def load_state() -> dict:
    if not STATE_PATH.exists():
        return {"seen": {}, "created": datetime.now(timezone.utc).isoformat()}
    try:
        # utf-8-sig: tolerate a BOM, which Windows editors and PowerShell add.
        return json.loads(STATE_PATH.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError) as exc:
        log(f"WARNING: state unreadable ({exc}); starting fresh but NOT alerting "
            f"on the backlog")
        return {"seen": {}, "corrupt_recovered": True}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    state["updated"] = datetime.now(timezone.utc).isoformat()
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STATE_PATH)  # atomic; a killed run can't truncate the state


# --------------------------------------------------------------------------
# notification
# --------------------------------------------------------------------------

STOCK_LABEL = {
    "in_stock": "IN STOCK",
    "pre_order": "PRE-ORDER OPEN",
    "lottery": "LOTTERY ENTRY OPEN",
    "out_of_stock": "out of stock",
    "closed": "pre-order closed",
    "unknown": "unknown",
}

# reason -> (title prefix, ntfy tag/emoji, priority bump)
REASON_STYLE = {
    "rerun":    ("RESTOCKED - NEW LISTING", "fire", 1),
    "upcoming": ("UPCOMING DROP",     "calendar", 0),
    "reminder": ("OPENS SOON",        "alarm_clock", 1),
    "new":      ("New listing",       "package", 0),
    "restock":  ("AVAILABLE",         "fire",    1),
    # Go-live is the moment you can actually buy, so it matches a restock.
    "live":     ("ON SALE NOW",       "rocket",  1),
    "reopened": ("Pre-order reopened", "repeat", 0),
}

# A restock reads differently depending on what became available.
RESTOCK_PREFIX = {
    "in_stock": "BACK IN STOCK",
    "pre_order": "PRE-ORDER OPEN",
    "lottery": "LOTTERY OPEN - ENTER",
}

# A brand-new listing you can order *right now* is the highest-value alert
# there is. Make it unmistakable in the title rather than burying it in the
# body, and raise its priority to match a restock.
NEW_AVAILABLE_PREFIX = {
    "in_stock": "NEW - IN STOCK NOW",
    "pre_order": "NEW - PRE-ORDER OPEN",
    "lottery": "NEW - LOTTERY OPEN - ENTER",
}


def header_safe(text: str, limit: int = 120) -> str:
    """ntfy sends metadata in HTTP headers, which must be latin-1. Product
    names contain things like 'ν' and 'Ⅱ', so transliterate for the header
    (the body keeps the real UTF-8 name)."""
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit] or "New listing"


def push(cfg: dict, *, title: str, body: str, tag: str = "bell",
         priority: int | None = None, click: str | None = None,
         dry_run: bool = False) -> bool:
    """Send one ntfy message. Everything user-facing goes through here."""
    ntfy = cfg["ntfy"]
    topic = os.environ.get("NTFY_TOPIC") or ntfy.get("topic", "")
    server = (os.environ.get("NTFY_SERVER") or ntfy.get("server")
              or "https://ntfy.sh").rstrip("/")

    if not (dry_run or topic) or (not dry_run and topic.startswith("CHANGE-ME")):
        log("ERROR: no ntfy topic set (config.json ntfy.topic or $NTFY_TOPIC)")
        return False

    headers = {
        "User-Agent": "pbandai-watcher/1.0",
        "Content-Type": "text/plain; charset=utf-8",
        "Title": header_safe(title),
        "Priority": str(priority if priority is not None else ntfy.get("priority", 4)),
        "Tags": tag,
    }
    if click:
        headers["Click"] = click
        headers["Actions"] = f"view, Open listing, {click}"
    token = os.environ.get("NTFY_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    if dry_run:
        log(f"  [dry-run] would push -> {title}")
        return True

    try:
        req = urllib.request.Request(f"{server}/{topic}",
                                     data=body.encode("utf-8"),
                                     headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
        return True
    except Exception as exc:  # noqa: BLE001
        log(f"  ERROR: ntfy push failed: {exc}")
        return False


def notify(listing: Listing, cfg: dict, reason: str, dry_run: bool = False,
           prior_runs: list[str] | None = None) -> bool:
    bits = [listing.name, ""]
    if reason == "rerun":
        bits.append("This product has been listed AGAIN with a new product "
                    "code - P-Bandai does this when new inventory arrives.")
        if prior_runs:
            bits.append(f"Previous run(s): {', '.join(sorted(prior_runs))}")
        bits.append("")
    if listing.status:
        bits.append(f"Sale status: {listing.status}")
    secs = listing.starts_in()
    if secs is not None and secs > 0:
        # Not orderable yet - lead with when it will be, in local time.
        bits.append(f"OPENS: {local_time_str(listing.sale_start, cfg)}")
        bits.append(f"That is in {human_delta(secs)}.")
    else:
        bits.append(f"Stock: {STOCK_LABEL.get(listing.stock, listing.stock)}")
    if listing.price is not None:
        bits.append(f"Price: {listing.price_str()}")
    if listing.sale_start and not (secs and secs > 0):
        bits.append(f"Sale started: {local_time_str(listing.sale_start, cfg)}")
    if listing.flags:
        bits.append(f"Flags: {', '.join(listing.flags)}")
    bits += [f"Source: {listing.source}", listing.url]

    prefix, tag, bump = REASON_STYLE.get(reason, ("Update", "bell", 0))
    if reason in ("upcoming", "reminder"):
        when = local_time_str(listing.sale_start, cfg)
        prefix = (f"OPENS IN {human_delta(secs or 0)}" if reason == "reminder"
                  else f"OPENS {when}")
    elif reason == "restock":
        prefix = RESTOCK_PREFIX.get(listing.stock, prefix)
    elif reason == "rerun" and actionable(listing.stock, cfg):
        prefix = f"RESTOCKED - {STOCK_LABEL.get(listing.stock, '')}".strip(" -")
    elif reason == "new" and actionable(listing.stock, cfg):
        prefix = NEW_AVAILABLE_PREFIX.get(listing.stock, prefix)
        tag, bump = "fire", 1

    # A restock is the only one you can act on immediately, so it gets bumped
    # a priority level above the informational alerts.
    priority = min(5, int(cfg["ntfy"].get("priority", 4)) + bump)
    return push(cfg,
                title=f"{prefix}: {header_safe(listing.name, 90)}",
                body="\n".join(bits), tag=tag, priority=priority,
                click=listing.url, dry_run=dry_run)


# --------------------------------------------------------------------------
# main pass
# --------------------------------------------------------------------------

def run_once(cfg: dict, seed: bool = False, dry_run: bool = False) -> int:
    state = load_state()
    seen: dict = state.setdefault("seen", {})
    first_run = not seen
    # A fresh/corrupt state must not fire an alert per existing listing.
    quiet = seed or first_run or state.pop("corrupt_recovered", False)

    if quiet and not seed:
        log("No prior state - seeding silently (no alerts this pass).")
        # A watcher that re-seeds every run never alerts, and looks exactly
        # like a quiet week. If state was expected and isn't there, say so
        # out loud rather than failing silently.
        if not dry_run:
            push(cfg,
                 title="Watcher had no saved state - re-seeded",
                 body=("The watcher found no previous state and re-seeded, so "
                       "no alerts were sent this pass.\n\n"
                       "If you did not expect this, state/seen.json is not "
                       "persisting between runs and NO alerts will ever fire. "
                       "Check that the workflow's 'Persist seen-listings state' "
                       "step is succeeding."),
                 tag="warning", priority=4)

    match_cfg = cfg.get("match", {})
    delay = float(cfg.get("politeness_delay_seconds", 3))
    sources = [s for s in cfg["sources"] if s.get("enabled", True)]

    found_total = 0
    ok_sources = 0
    events: list[tuple[Listing, str]] = []
    rollback: dict[str, dict | None] = {}   # key -> prior record, for undo
    cooldown = float(cfg.get("alert_cooldown_hours", 6))
    suppressed = 0
    # Snapshot before this pass mutates `seen`, so a new run of a product we
    # already know is recognised as a re-listing rather than a new product.
    known_bases = frozenset(base_code(c) for c in seen)

    for n, src in enumerate(sources):
        name, url = src["name"], src["url"]
        log(f"Checking {name} -> {url}")
        try:
            html = fetch(url)
        except Exception as exc:  # noqa: BLE001
            log(f"  ERROR: {exc}")
            continue

        if is_bot_challenge(html):
            log("  ERROR: served a bot challenge, not the page. Skipping.")
            continue

        listings = parse_listings(html, name)
        if not listings:
            log("  WARNING: parsed 0 listings - the page layout may have changed.")
        ok_sources += 1
        found_total += len(listings)

        tracked = on_sale = available = 0
        for listing in listings:
            if not matches(listing, match_cfg):
                continue

            tracked += 1
            on_sale += status_allowed(listing, cfg)
            available += actionable(listing.stock, cfg)

            key = listing.key()
            prev = seen.get(key)

            # Every listing is recorded, including End/sold-out ones. That is
            # what makes a later transition *visible* - if we skipped them,
            # their stored state would freeze and a restock would look like
            # no change at all.
            reason = classify(listing, prev, cfg, known_bases)
            if reason and within_cooldown(prev, reason, cooldown):
                log(f"  (suppressed repeat '{reason}' for {key} - "
                    f"already alerted within {cooldown}h)")
                suppressed += 1
                reason = None
            if reason:
                events.append((listing, reason))

            rollback[key] = prev  # so a failed push can be undone exactly
            seen[key] = {
                "name": listing.name,
                "status": listing.status,
                "stock": listing.stock,
                "price": listing.price,
                "source": listing.source,
                "first_seen": (prev or {}).get(
                    "first_seen", datetime.now(timezone.utc).isoformat()
                ),
                # Timestamps of alerts already delivered, for the cooldown.
                "alerts": dict((prev or {}).get("alerts") or {}),
            }

        log(f"  {len(listings)} listing(s), {tracked} tracked, "
            f"{on_sale} on sale, {available} available to order")
        if n < len(sources) - 1 and delay:
            time.sleep(delay)

    if not ok_sources:
        log("FATAL: every source failed - leaving state untouched.")
        return EXIT_FETCH

    if quiet:
        log(f"Seeded {len(seen)} listing(s). Future arrivals will alert.")
    elif events:
        log(f"{len(events)} new event(s) -> pushing")
        for listing, reason in events:
            prior = [c for c in seen
                     if base_code(c) == listing.base and c != listing.code]
            ok = notify(listing, cfg, reason, dry_run=dry_run, prior_runs=prior)
            log(f"  {'sent' if ok else 'FAILED'}: [{reason}] {listing.name}")
            if ok:
                # Start the cooldown only on a delivered alert.
                stamp = datetime.now(timezone.utc).isoformat()
                alerts = seen[listing.key()].setdefault("alerts", {})
                alerts[reason] = stamp
                if reason == "new" and actionable(listing.stock, cfg):
                    # We've already said it's orderable. Don't let the site's
                    # flapping immediately follow up with a restock alert
                    # saying the same thing.
                    alerts["restock"] = stamp
            if not ok:
                # Undo the state write so this retries next pass. Restore the
                # exact prior record rather than deleting - dropping it would
                # turn a missed restock into a bogus "new listing" later.
                prior = rollback.get(listing.key())
                if prior is None:
                    seen.pop(listing.key(), None)
                else:
                    seen[listing.key()] = prior
    else:
        log(f"No new listings ({found_total} checked)"
            + (f", {suppressed} repeat(s) suppressed." if suppressed else "."))

    # Heartbeat: prove the watcher is alive on a schedule, so a silent day is
    # evidence of nothing new rather than evidence of nothing running.
    hb_hours = float(cfg.get("heartbeat_hours", 24))
    if hb_hours > 0 and not events and not dry_run:
        last = state.get("last_heartbeat")
        due = True
        if last:
            try:
                due = ((datetime.now(timezone.utc) - datetime.fromisoformat(last))
                       .total_seconds() >= hb_hours * 3600)
            except (ValueError, TypeError):
                due = True
        if due:
            avail = [r for r in seen.values() if actionable(r.get("stock", ""), cfg)]
            body = [f"Watching {len(seen)} listing(s) across "
                    f"{ok_sources}/{len(sources)} source(s).",
                    f"Orderable right now: {len(avail)}"]
            body += [f"  - {r.get('name', '?')[:60]}" for r in avail[:5]]
            body.append("\nNothing new since the last check.")
            if push(cfg, title=f"Watcher OK - {len(seen)} tracked, "
                               f"{len(avail)} orderable",
                    body="\n".join(body), tag="heartbeat", priority=1):
                state["last_heartbeat"] = datetime.now(timezone.utc).isoformat()
                log(f"  heartbeat sent ({hb_hours}h)")

    save_state(state)
    return EXIT_OK


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        log(f"FATAL: {CONFIG_PATH} not found")
        sys.exit(EXIT_CONFIG)
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        log(f"FATAL: config.json is not valid JSON: {exc}")
        sys.exit(EXIT_CONFIG)


def main() -> int:
    ap = argparse.ArgumentParser(description="Watch Premium Bandai US for new listings.")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--once", action="store_true", help="single pass then exit (default)")
    g.add_argument("--loop", type=int, metavar="SECONDS",
                   help="poll forever every SECONDS (use on an always-on host)")
    ap.add_argument("--seed", action="store_true",
                    help="record current listings without alerting")
    ap.add_argument("--dry-run", action="store_true", help="don't actually push")
    ap.add_argument("--test-notify", action="store_true",
                    help="send one test push and exit")
    args = ap.parse_args()

    cfg = load_config()

    if args.test_notify:
        demo = Listing(code="TEST0000", name="Test push from pbandai-watcher",
                       url="https://p-bandai.com/us/series/onepiece-series",
                       status="On", price=0.0, source="test")
        ok = notify(demo, cfg, "new", dry_run=args.dry_run)
        log("test push sent" if ok else "test push FAILED")
        return EXIT_OK if ok else EXIT_CONFIG

    if args.loop:
        log(f"Polling every {args.loop}s. Ctrl+C to stop.")
        while True:
            try:
                run_once(cfg, seed=args.seed, dry_run=args.dry_run)
            except KeyboardInterrupt:
                log("stopped")
                return EXIT_OK
            except Exception as exc:  # noqa: BLE001 - a watcher must not die
                log(f"ERROR: unexpected failure this pass: {exc}")
            args.seed = False  # only the first pass may seed
            time.sleep(args.loop)

    return run_once(cfg, seed=args.seed, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())

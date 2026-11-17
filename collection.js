/* ============================================================================
   OPTCG QUANT — collection.js
   Collection data model, Google Sheets sync, and portfolio math.
   No DOM access in this file.
   ========================================================================== */

const OQ_COLLECTION = (function (D, E) {
  'use strict';

  /* ==========================================================================
     MODEL

     collections: [{ id, name, kind:'keep'|'trade', createdAt, updatedAt, deleted }]
     items:       [{ id, colId, key, qty, cond, grader, grade, paid, note,
                     updatedAt, deleted }]

     `key` is TCGplayer's productId — a real primary key, unique across all
     6,798 cards. v1 used a "set_id|card_image_id|card_name" composite because
     optcgapi had nothing unique (card_set_id collided 723 times). Rows saved
     under the old composite are repointed by migrateKeys() below; `oldKey`
     keeps the original so a migration can be audited or undone.

     A graded card carries `grader` + `grade`; `cond` applies to raw copies
     only. There is no free market feed for graded prices, so `paid` (and the
     manual value on a graded row) is whatever you enter.
     ========================================================================== */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /**
   * `tradePct` is what a vendor actually pays against market — nobody trades
   * at 1:1 at a show, so a trade binder valued at full market is a number you
   * can never realise. Defaults to 80% for trade stock, 100% for keeps.
   */
  function newCollection(name, kind) {
    const now = Date.now();
    return { id: uid(), name: name, kind: kind || 'keep',
             tradePct: kind === 'trade' ? 80 : 100,
             createdAt: now, updatedAt: now, deleted: 0 };
  }

  /** Older rows predate tradePct; keeps are always 1:1. */
  const rateOf = col =>
    !col ? 100 : (col.tradePct == null ? (col.kind === 'trade' ? 80 : 100) : Number(col.tradePct));

  /* ==========================================================================
     V1 -> V2 KEY MIGRATION

     v1 rows are keyed "set_id|card_image_id|card_name", a composite invented
     because optcgapi had no unique id. v2 keys on TCGplayer's productId, which
     is a real primary key. Every saved row — local and in the sheet — has to
     be repointed, and rows are the only thing in this app that cannot be
     re-fetched, so the rule is: never guess, and never drop.

     Matching is on card NAME plus card NUMBER, both of which survived the
     source change intact. The image id carries a random suffix on variants
     ("OP04-056_p2", "OP16-011_l76oKss"); the part before the first underscore
     is the card number, which is what TCGplayer calls extNumber.

     Anything that does not match exactly one card is left untouched and
     reported, so it shows up in the UI for you to fix by hand rather than
     silently becoming a $0 row or disappearing.
     ========================================================================= */

  const isV1Key = key => typeof key === 'string' && key.indexOf('|') > -1;

  function splitV1Key(key) {
    if (!isV1Key(key)) return null;
    const a = key.indexOf('|');
    const b = key.indexOf('|', a + 1);
    if (a < 0 || b < 0) return null;
    return {
      setId: key.slice(0, a),
      imageId: key.slice(a + 1, b),
      name: key.slice(b + 1)
    };
  }

  /** "OP16-011_l76oKss" -> "OP16-011". Also tolerates a bare number. */
  const numberFrom = imageId => String(imageId || '').split('_')[0].toUpperCase();

  const numberedCard = /\b(?:OP|ST|EB|PRB)\d{2}-\d{3}\b|\bP-\d{3}\b/i;
  const nameKey = name => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  // The price provider later added "(Dash Pack)" to this EB-03 printing's name.
  const peronaDashPackKey = 'EB-03|EB03_OP09-034_p1|Perona - OP09-034';
  const needsKeyMigration = item => isV1Key(item.key) ||
    (item.oldKey === peronaDashPackKey && String(item.key) === '596960');

  function cardTitle(name, number) {
    const title = String(name || '').trim();
    const code = String(number || '').match(numberedCard)?.[0];
    if (!code || code !== number) return title;
    const serial = code.slice(-3);
    const cleaned = title
      .replace(new RegExp(`\\s*[-–—]\\s*${code}(?=\\s|$)`, 'gi'), '')
      .replace(new RegExp(`\\s*\\((?:${code}|${serial})\\)`, 'gi'), '')
      .trim();
    return cleaned || title;
  }

  function legacyIdentity(key) {
    const parts = splitV1Key(key);
    if (!parts) return null;
    const number = parts.imageId.replace(/_/g, ' ').match(numberedCard)?.[0].toUpperCase() ||
      parts.name.match(numberedCard)?.[0].toUpperCase() || '';
    return { ...parts, rawName: parts.name, name: cardTitle(parts.name, number), number,
      don: /^don!!(?:\s|$)/i.test(parts.name) };
  }

  function buildMatchIndex(cards) {
    const index = new Map();
    for (const c of cards) {
      const num = String(c.card_set_id || '').toUpperCase().trim();
      const don = c.card_type === 'DON!!' || c.rarity === 'DON';
      const name = nameKey(cardTitle(c.card_name, num));
      if (!name || (!num && !don)) continue;
      const key = name + '|' + (don ? 'DON' : num);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(c);
    }
    return index;
  }

  /**
   * Repoint v1 keys onto productIds.
   *
   * Returns { items, migrated, unmatched, ambiguous, alreadyV2 } — a NEW items
   * array, never a mutation of the input, so a caller that decides not to
   * commit the migration still holds intact data.
   */
  function migrateKeys(items, cards) {
    const idx = buildMatchIndex(cards);
    const dashPack = cards.find(card => String(card.id) === '675747' &&
      card.set_id === 'EB-03' && card.card_set_id === 'OP09-034');
    const out = [];
    const unmatched = [], ambiguous = [];
    let migrated = 0, alreadyV2 = 0;

    for (const it of items || []) {
      if (!needsKeyMigration(it)) { alreadyV2++; out.push(it); continue; }
      const legacyKey = isV1Key(it.key) ? it.key : it.oldKey;
      const parts = legacyIdentity(legacyKey);
      if (!parts) { unmatched.push(it); out.push(it); continue; }

      const candidates = idx.get(nameKey(parts.name) + '|' + (parts.don ? 'DON' : parts.number)) || [];
      const sameSet = candidates.filter(card => card.set_id === parts.setId);
      const pool = legacyKey === peronaDashPackKey ? (dashPack ? [dashPack] : []) :
        parts.don && !sameSet.length ? candidates : sameSet;
      const exactName = nameKey(parts.rawName);
      const exact = pool.filter(card => nameKey(card.card_name) === exactName);
      const hits = exact.length ? exact : pool;

      if (hits.length === 1) {
        // oldKey is kept so the migration is auditable and reversible, and so
        // a row that later turns out to be mismatched can be traced back.
        out.push(Object.assign({}, it, {
          key: String(hits[0].id), oldKey: legacyKey, updatedAt: Date.now()
        }));
        migrated++;
      } else if (hits.length > 1) {
        ambiguous.push({ item: it, candidates: hits.map(c => c.id) });
        out.push(it);
      } else {
        // 3.7.2 could link Perona to the base printing. Restore its original key if the Dash Pack is unavailable.
        const row = it.key === legacyKey ? it : { ...it, key: legacyKey, updatedAt: Date.now() };
        if (row !== it) migrated++;
        unmatched.push(row);
        out.push(row);
      }
    }
    return { items: out, migrated, unmatched, ambiguous, alreadyV2 };
  }

  /* ==========================================================================
     THE PERMANENT BINDERS ARE SINGULAR BY ID, NOT BY LUCK

     "Keeping" and "Trade / Sell" are created automatically on first run. v1
     minted them with a random uid(), which is fine on one device and wrong the
     moment there are two: each device generates its OWN pair before the first
     sync, then pulls the other device's pair, and merge — correctly — keeps
     all four, because to it they are four distinct rows.

     Fixed ids make them the same row everywhere, so the merge collapses them
     instead of duplicating them. Installs created before this still carry
     random ids, which is what dedupePermanent() repairs.
     ========================================================================= */
  const PERMANENT_ID = { keep: 'binder-keep', trade: 'binder-trade' };

  function newPermanent(kind) {
    const now = Date.now();
    return { id: PERMANENT_ID[kind], name: kind === 'keep' ? 'Keeping' : 'Trade / Sell',
             kind, tradePct: kind === 'trade' ? 80 : 100,
             locked: 1, createdAt: now, updatedAt: now, deleted: 0 };
  }

  const PERMANENT_NAME = { keep: 'keeping', trade: 'trade / sell' };

  /* Is this one of the two automatic binders?

     Deliberately NOT just `locked`. That flag has to survive a round-trip
     through Google Sheets, and an older deployed Apps Script whose COL_COLS
     predates the `locked` column drops it silently — the binders come back
     unlocked and the dedupe below skips them, so the duplicates you were told
     were fixed are still there.

     Three independent signals, any one of which is enough: the flag, the
     canonical fixed id, or the exact auto-generated name for that kind. The
     name test can in principle catch a binder you named "Keeping" yourself,
     but only if it also matches the kind AND there is more than one — which is
     the very situation you would want collapsed anyway. */
  function isPermanent(col, kind) {
    if (col.locked) return true;
    if (col.id === PERMANENT_ID[kind]) return true;
    return String(col.name || '').trim().toLowerCase() === PERMANENT_NAME[kind];
  }

  /**
   * Collapse duplicate permanent binders into one per kind.
   *
   * Survivor is the canonical fixed id if present, otherwise the OLDEST — the
   * one most likely to hold the real history. Every item in a losing binder is
   * moved across before that binder is tombstoned, so nothing is orphaned; an
   * item pointing at a deleted binder would simply vanish from the UI while
   * still occupying a row in the sheet.
   *
   * Returns new arrays. Never mutates the inputs.
   */
  function dedupePermanent(cols, items) {
    const out = cols.map(c => Object.assign({}, c));
    const moved = {};                       // losingId -> survivingId
    let mergedBinders = 0;

    for (const kind of ['keep', 'trade']) {
      const live = out.filter(c => !c.deleted && c.kind === kind && isPermanent(c, kind));
      if (live.length < 2) continue;

      const canonical = live.find(c => c.id === PERMANENT_ID[kind]);
      const survivor = canonical ||
        live.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];

      // Re-assert the flag on the survivor: if the sheet stripped it, this puts
      // it back so the next round-trip is not another rescue operation.
      if (!survivor.locked) { survivor.locked = 1; survivor.updatedAt = Date.now(); }

      for (const c of live) {
        if (c.id === survivor.id) continue;
        moved[c.id] = survivor.id;
        c.deleted = 1;
        c.updatedAt = Date.now();
        mergedBinders++;
      }
    }

    if (!mergedBinders) return { cols, items, mergedBinders: 0, movedItems: 0 };

    let movedItems = 0;
    const outItems = items.map(it => {
      if (!moved[it.colId]) return it;
      movedItems++;
      return Object.assign({}, it, { colId: moved[it.colId], updatedAt: Date.now() });
    });

    return { cols: out, items: outItems, mergedBinders, movedItems };
  }

  /**
   * `value` and `paid` are deliberately separate.
   *   value — what the card is worth. Live market for raw copies; entered by
   *           hand for graded ones, because no free feed carries graded prices.
   *   paid  — what it cost you. Cost basis, never a valuation.
   * Collapsing them into one field makes every gain/loss figure meaningless.
   */
  function newItem(colId, key, patch) {
    return Object.assign({
      id: uid(), colId: colId, key: key,
      qty: 1, cond: 'NM', grader: '', grade: '',
      value: null, paid: null, note: '',
      src: 'pull',                 // 'pull' | 'buy' — drives the rip scoreboard
      updatedAt: Date.now(), deleted: 0
    }, patch || {});
  }

  const isGraded = it => !!(it.grader && it.grade !== '' && it.grade != null);

  /** A sealed-product purchase you opened. The cost side of the rip scoreboard. */
  function newOpen(setId, boxes, cost) {
    return { id: uid(), setId: setId, boxes: Number(boxes) || 1,
             cost: Number(cost) || 0, date: new Date().toISOString().slice(0, 10),
             updatedAt: Date.now(), deleted: 0 };
  }

  /**
   * Did ripping actually pay?
   *
   * Only counts cards you marked as pulled from packs. Singles you bought are
   * not winnings — including them would let a shopping spree masquerade as good
   * luck. Sets where you logged opens but no pulls are reported honestly rather
   * than scored, because "spent $600, pulled $0" almost always means you have
   * not finished logging.
   */
  function scoreboard(opens, items, priceFor, setName, isBooster, setIdFor) {
    const bySet = {};
    const touch = id => (bySet[id] = bySet[id] || {
      setId: id, name: setName ? setName(id) : id,
      boxes: 0, spent: 0, pulledValue: 0, pulledCards: 0
    });

    for (const o of live(opens)) {
      const r = touch(o.setId);
      r.boxes += Number(o.boxes) || 0;
      r.spent += Number(o.cost) || 0;
    }
    for (const it of live(items)) {
      if (it.src !== 'pull') continue;
      // v1 encoded the set in the key; v2 keys are opaque productIds, so the
      // set has to come from the card record. Splitting the key here silently
      // produced a phantom set id once the keys changed.
      const setId = setIdFor(it.key);
      // Belt and braces against a card marked "pulled" that could never have
      // come from a pack — a promo or starter-deck row would otherwise invent
      // a phantom set with winnings and no spend, inflating the return.
      if (isBooster && !isBooster(setId)) continue;
      const r = touch(setId);
      const qty = Number(it.qty) || 0;
      const w = unitValue(it, priceFor);
      r.pulledCards += qty;
      if (w != null) r.pulledValue += w * qty;
    }

    const rows = Object.keys(bySet).map(k => {
      const r = bySet[k];
      r.net = r.pulledValue - r.spent;
      r.ret = r.spent > 0 ? r.pulledValue / r.spent - 1 : null;
      // Spent money but logged nothing: incomplete, not a loss.
      r.incomplete = r.spent > 0 && r.pulledCards === 0;
      return r;
    }).sort((a, b) => b.spent - a.spent);

    const tot = rows.reduce((a, r) => ({
      boxes: a.boxes + r.boxes, spent: a.spent + r.spent,
      pulledValue: a.pulledValue + r.pulledValue, pulledCards: a.pulledCards + r.pulledCards
    }), { boxes: 0, spent: 0, pulledValue: 0, pulledCards: 0 });
    tot.net = tot.pulledValue - tot.spent;
    tot.ret = tot.spent > 0 ? tot.pulledValue / tot.spent - 1 : null;

    return { rows, total: tot };
  }

  /* ==========================================================================
     MERGE — per-row last-write-wins.

     Storing one row per card (rather than a JSON blob in a single cell) is what
     makes real multi-device sync possible: two devices editing DIFFERENT cards
     both survive, because the merge is per row instead of per document. A blob
     would mean whoever saves second erases the other's work.

     Deletes are tombstones (deleted=1 + updatedAt). Dropping a row outright
     would let it resurrect from whichever device had not synced yet.
     ========================================================================== */
  function mergeRows(local, remote) {
    // A sync payload missing a key, or a proxy returning something unexpected,
    // used to throw "remote is not iterable" out of pullNow and abandon the
    // whole merge — including the arrays that DID arrive intact. Treat absent
    // as empty: nothing to merge is a valid state, a crash is not.
    if (!Array.isArray(local))  local = [];
    if (!Array.isArray(remote)) remote = [];

    const byId = {};
    for (const row of local)  { if (row && row.id != null) byId[row.id] = row; }
    for (const row of remote) {
      if (!row || row.id == null) continue;
      const mine = byId[row.id];
      if (!mine || (row.updatedAt || 0) > (mine.updatedAt || 0)) byId[row.id] = row;
    }
    return Object.keys(byId).map(k => byId[k]);
  }

  /** Tombstones are kept for sync correctness but never shown. */
  const live = rows => rows.filter(r => !r.deleted);

  /* ==========================================================================
     PORTFOLIO
     ========================================================================== */

  /** Sane quantity: a non-negative integer, never NaN, never absurd. */
  function qtyOf(it) {
    const n = Math.floor(Number(it && it.qty));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, 9999);
  }

  /**
   * Items that are live AND whose binder is live.
   *
   * A sync race makes these: device A deletes a binder while device B adds a
   * card to it. Merge keeps both — correctly, they are independent rows — and
   * the card becomes invisible in the UI while still counting toward your
   * total. The number says $X and you cannot find the cards.
   */
  function livePlaced(items, cols) {
    const ok = {};
    for (const c of live(cols)) ok[c.id] = true;
    return live(items).filter(it => ok[it.colId]);
  }

  /** The opposite set: live rows stranded on a deleted binder. */
  function orphans(items, cols) {
    const ok = {};
    for (const c of live(cols)) ok[c.id] = true;
    return live(items).filter(it => !ok[it.colId]);
  }

  function amount(value) {
    if (value == null || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function unitValue(it, priceFor) {
    const manual = amount(it.value);
    if (manual != null || isGraded(it)) return manual;
    const market = amount(priceFor(it.key, it.printing));
    return market > 0 ? market : null;
  }

  function valueOf(items, priceFor) {
    let raw = 0, graded = 0, cards = 0, unpriced = 0, cost = 0;
    let costedValue = 0, costedCards = 0, comparableCards = 0, comparableCost = 0;

    for (const it of live(items)) {
      const qty = qtyOf(it);
      const paid = amount(it.paid);
      const value = unitValue(it, priceFor);
      cards += qty;
      if (paid != null) {
        cost += paid * qty;
        costedCards += qty;
        if (value != null) {
          comparableCards += qty;
          comparableCost += paid * qty;
          costedValue += value * qty;
        }
      }

      if (value == null) unpriced += qty;
      else if (isGraded(it)) graded += value * qty;
      else raw += value * qty;
    }
    const gain = costedValue - comparableCost;
    return {
      raw, graded, total: raw + graded, cards, unpriced, cost,
      costedCards, costedValue, comparableCards, gain,
      gainPct: comparableCost > 0 ? gain / comparableCost : null,
      costComplete: costedCards === cards
    };
  }

  function holdingHistory(rows) {
    const latest = rows.reduce((day, row) => Math.max(day, row.points.at(-1)?.[0] ?? -Infinity), -Infinity);
    const basket = rows.filter(row => row.points.length && row.points.at(-1)[0] >= latest - 6);
    const totals = new Map();
    for (const { qty, points } of basket) {
      for (const [day, cents] of points) {
        const total = totals.get(day) || { cents: 0, quotes: 0 };
        total.cents += cents * qty;
        total.quotes++;
        totals.set(day, total);
      }
    }
    const points = [...totals].filter(([, day]) => day.quotes === basket.length)
      .sort(([a], [b]) => a - b).map(([day, total]) => [day, total.cents]);
    return { points, copies: basket.reduce((sum, row) => sum + row.qty, 0) };
  }

  /** Roll up duplicates so the UI shows one line per distinct card+state. */
  function group(items) {
    const out = {};
    for (const it of live(items)) {
      const gk = JSON.stringify([it.key, it.printing || null, it.cond, it.grader, it.grade]);
      if (!out[gk]) out[gk] = { key: it.key, printing: it.printing, cond: it.cond, grader: it.grader,
                                grade: it.grade, qty: 0, rows: [] };
      out[gk].qty += Number(it.qty) || 0;
      out[gk].rows.push(it);
    }
    return Object.keys(out).map(k => out[k]);
  }

  /* ==========================================================================
     SHEETS TRANSPORT

     The Apps Script /exec URL is a bearer key: anyone holding it can read and
     write the sheet. The repo is public, so it is never baked into source —
     it is pasted once per device and kept in localStorage. If it ever leaks,
     redeploy for a fresh URL.

     POST uses text/plain deliberately. An application/json body triggers a
     CORS preflight, and Apps Script does not answer OPTIONS.
     ========================================================================== */

  function validUrl(url) {
    return typeof url === 'string' && /^https:\/\/script\.google\.com\//.test(url);
  }

  /**
   * Work out WHY a connection failed.
   *
   * The browser reports every one of these as the same "Failed to fetch":
   * wrong URL shape, /dev instead of /exec, a deployment set to "Only myself"
   * (which redirects to a Google login page that carries no CORS headers), and
   * a genuinely offline device. A no-cors probe separates them — it succeeds
   * with an opaque response whenever the server is reachable at all, so if the
   * probe passes and the real request fails, the problem is permissions rather
   * than the address.
   */
  async function diagnose(url) {
    const say = (ok, code, msg, fix) => ({ ok, code, msg, fix });

    if (!url) return say(false, 'EMPTY', 'No URL entered.',
      'Paste the /exec URL from your Apps Script deployment.');

    if (!/^https:\/\/script\.google\.com\//.test(url)) {
      return say(false, 'NOT_SCRIPT_URL', 'That is not a script.google.com address.',
        'In Apps Script: Deploy → Manage deployments → copy the Web app URL.');
    }
    if (/\/dev(\?|$)/.test(url)) {
      return say(false, 'DEV_URL', 'That is the /dev URL, which only works while you are signed in.',
        'Use the /exec URL from Deploy → Manage deployments instead.');
    }
    if (!/\/exec(\?|$)/.test(url)) {
      return say(false, 'NOT_EXEC', 'The URL does not end in /exec.',
        'Copy the full Web app URL — it should end with /exec.');
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return say(false, 'OFFLINE', 'This device is offline.', 'Reconnect and try again.');
    }

    // Reachable at all? An opaque response still proves the host answered.
    let reachable = false;
    try {
      await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
      reachable = true;
    } catch (_) { /* leave false */ }

    try {
      const res = await fetch(url + (url.indexOf('?') > -1 ? '&' : '?') + 'action=pull',
                              { cache: 'no-store' });
      if (!res.ok) {
        return say(false, 'HTTP_' + res.status, 'The script answered with HTTP ' + res.status + '.',
          'Re-deploy the Web app and use the new /exec URL.');
      }
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) {}
      if (!data) {
        return say(false, 'NOT_JSON',
          'The script returned a page instead of data — usually a Google sign-in screen.',
          'Set "Who has access" to Anyone in Deploy → Manage deployments → edit.');
      }
      if (data.ok !== true) {
        return say(false, 'SCRIPT_ERROR', 'The script ran but reported: ' + (data.error || 'unknown'),
          'Check the Apps Script editor for the error, then re-deploy.');
      }
      return say(true, 'OK',
        'Connected. ' + (data.items || []).length + ' cards, ' +
        (data.collections || []).length + ' binders, ' + (data.opens || []).length + ' openings in the sheet.',
        '');
    } catch (err) {
      if (reachable) {
        return say(false, 'CORS_OR_PERMISSION',
          'The server answered but the browser blocked the response — the deployment is not public.',
          'Deploy → Manage deployments → edit (pencil) → set "Who has access" to ' +
          '"Anyone", then Deploy. Note this creates a NEW /exec URL — paste that one.');
      }
      return say(false, 'UNREACHABLE',
        'Could not reach script.google.com at all (' + err.message + ').',
        'Check the URL is complete, and that you are not behind a network that blocks Google.');
    }
  }

  async function pull(url) {
    if (!validUrl(url)) throw new Error('Not a Google Apps Script URL');
    const res = await fetch(url + (url.indexOf('?') > -1 ? '&' : '?') + 'action=pull');
    if (!res.ok) throw new Error('Sheet returned HTTP ' + res.status);
    const data = await res.json();
    if (!data || data.ok !== true) throw new Error((data && data.error) || 'Sheet rejected the read');
    return { collections: data.collections || [], items: data.items || [], opens: data.opens || [],
      binderFinishes: data.binderFinishes === true };
  }

  async function push(url, payload) {
    if (!validUrl(url)) throw new Error('Not a Google Apps Script URL');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids preflight
      body: JSON.stringify(Object.assign({ action: 'push' }, payload))
    });
    if (!res.ok) throw new Error('Sheet returned HTTP ' + res.status);
    const data = await res.json();
    // Validate the body, not just the status — Apps Script happily returns 200
    // with an HTML error page, which is how you get a false success tick.
    if (!data || data.ok !== true) throw new Error((data && data.error) || 'Sheet rejected the write');
    return data;
  }

  return {
    uid, newCollection, newItem, newOpen, isGraded, rateOf,
    mergeRows, live, livePlaced, orphans, qtyOf, amount, unitValue, valueOf, holdingHistory, group, scoreboard,
    migrateKeys, needsKeyMigration, isV1Key, splitV1Key, numberFrom, legacyIdentity, cardTitle,
    dedupePermanent, newPermanent, PERMANENT_ID, isPermanent,
    validUrl, diagnose, pull, push
  };
})(OQ_DATA, OQ_ENGINE);

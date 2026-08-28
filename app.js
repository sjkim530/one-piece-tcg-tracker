/* ============================================================================
   OPTCG QUANT — app.js
   State, persistence, rendering.
   ========================================================================== */

(function (D, E, C) {
  'use strict';

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const KEY = {
    cards:  'oq.cards.v1',
    boxes:  'oq.boxes.v1',
    perCase: 'oq.percase.v1',
    rates:  'oq.rates.v1',
    setRates: 'oq.setrates.v1',
    prefs:  'oq.prefs.v1',
    collapse: 'oq.collapse.v1',
    cols:   'oq.collections.v1',
    items:  'oq.items.v1',
    opens:  'oq.opens.v1',
    sync:   'oq.syncurl.v1',
    lastPush: 'oq.lastpush.v1',
    hist:   'oq.hist.v1'
  };

  /* ------------------------------------------------------------- storage -- */
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }
  /**
   * Returns false when the write did not happen.
   *
   * This used to swallow failures silently, which is fine for the card cache
   * (it just refetches) and NOT fine for the collection — a full localStorage
   * would drop your binder on the next reload with no warning at all. Callers
   * that hold user-entered data must check the result. saveCritical() does.
   */
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }

  let quotaWarned = false;
  /** For data the user typed and cannot recreate. Fails loudly, once. */
  function saveCritical(key, value) {
    if (save(key, value)) return true;

    // Most likely cause is the ~1.3MB card cache crowding a 5MB budget.
    // Dropping it is safe — it refetches — and usually frees enough room.
    try { localStorage.removeItem(KEY.cards); } catch (_) {}
    if (save(key, value)) return true;

    if (!quotaWarned) {
      quotaWarned = true;
      setSync('err', 'browser storage full');
      alert('Your browser storage is full, so this change could not be saved locally.\n\n' +
            'Connect Google Sheets on the My Collection tab to keep your data safe, ' +
            'or free up space for this site.');
    }
    return false;
  }

  /* --------------------------------------------------------------- state -- */
  const S = {
    cards: [],
    bySet: {},
    byKey: {},                       // cardKey -> card, for collection lookups
    tab: 'rip',
    boxes:  load(KEY.boxes, {}),     // setId -> user box price (Set Explorer only)
    perCase: load(KEY.perCase, {}),  // setId -> boxes per case, when it is not 12
    rates:    load(KEY.rates, {}),     // profile -> { perBox, packsPerBox }
    setRates: load(KEY.setRates, {}),  // setId   -> { perBox, packsPerBox }
    prefs:  load(KEY.prefs, { friction: 100, advanced: false }),
    ripSet: null, ripCard: null, ripSearch: '', ripRarity: 'all', ripColor: 'all',
    gridLimit: 150,                 // raised by the "show all" control
    sigSearch: '', sigRarity: 'all', sigColor: 'all',
    rateScope: null,                 // which scope the pull-rate editor is on
    sigAutoScanned: false,
    scanning: false, scanAbort: false,
    fetchedAt: null,
    indexCache: {},
    sort: { sets: { by: 'roi', dir: -1 }, sig: { by: 'rank', dir: -1 } },

    // ---- collection
    cols:    load(KEY.cols, []),
    items:   load(KEY.items, []),
    opens:   load(KEY.opens, []),
    curCol:  null,
    addSet:  null,
    addSearch: '',
    browseSets: null,
    syncUrl: load(KEY.sync, ''),
    lastPushAt: load(KEY.lastPush, 0),
    syncState: 'off',                // off | ok | busy | err
    syncMsg: '',
    pushTimer: null
  };

  /* ------------------------------------------------------------- helpers -- */
  const setMeta   = id => D.SETS.find(s => s.id === id) ||
                          (S.browseSets || []).find(s => s.id === id);
  const setName   = id => { const m = setMeta(id); return m ? m.name : id; };
  const setShort  = id => { const m = setMeta(id); return m ? m.short : id; };
  const profileOf = id => { const m = setMeta(id); return (m && m.profile) || 'STANDARD'; };

  /**
   * Effective pull-rate config for a set.
   *
   * Three layers, most specific wins:
   *   profile default -> your profile override -> your per-set override
   *
   * Per-set matters because sets genuinely differ: OP-01 to OP-03 have no SP
   * cards at all, OP-13 swapped Manga Rares for Super Alt Arts, and OP-14/15
   * are simply bigger sets. Pool SIZE is already per-set everywhere in the app
   * (a card's odds are rate ÷ pool ÷ packs), so a set with 5 Manga Rares
   * correctly gives each one a fifth of the odds. What this adds is per-set
   * control of the RATE itself.
   */
  function configFor(setId) {
    const prof  = profileOf(setId);
    const base  = D.PROFILES[prof];
    const pOver = S.rates[prof] || {};
    const sOver = S.setRates[setId] || {};
    return {
      profile: prof,
      label: base.label,
      verified: base.verified !== false,
      customised: !!S.setRates[setId],
      packsPerBox: sOver.packsPerBox != null ? sOver.packsPerBox
                 : pOver.packsPerBox != null ? pOver.packsPerBox
                 : base.packsPerBox,
      cardsPerPack: base.cardsPerPack,
      perBox: Object.assign({}, base.perBox, pOver.perBox || {}, sOver.perBox || {})
    };
  }

  /* Three tiers, most trustworthy first:
       1. what YOU typed        — you know what you actually paid
       2. TCGplayer's live box  — real market, new in v2
       3. the estimate in data.js — only when a set has no sealed listing at
          all, which happens for sold-out and not-yet-released sets

     Only tier 3 is marked EST. v1 marked everything EST because every box
     price was a hardcoded guess. */
  function boxPrice(setId) {
    if (S.boxes[setId] != null) return S.boxes[setId];
    const live = sealedPrice(setId, 'box');
    if (live != null) return live;
    const m = setMeta(setId);
    return m ? m.box : 0;
  }
  const boxIsEstimate = setId =>
    S.boxes[setId] == null && sealedPrice(setId, 'box') == null;

  /** Live case price. No estimate fallback — an unlisted case is simply unknown. */
  const casePrice = setId => sealedPrice(setId, 'case');

  /* Boxes in a sealed case. 12 is standard for OP boosters, but I have not
     verified it for Premium Boosters and the source does not state it, so it
     is editable per set rather than asserted. */
  const DEFAULT_PER_CASE = 12;
  const boxesPerCase = setId => Number(S.perCase[setId]) || DEFAULT_PER_CASE;

  /**
   * Is a case cheaper per box than buying boxes?
   *
   * Worth asking because the answer is not consistent — measured across the
   * catalogue it ranges from 27.6% cheaper (PRB-02) to 8.1% MORE expensive
   * (OP-13). Returns null when either price is missing rather than guessing.
   */
  function caseDeal(setId) {
    const box = sealedPrice(setId, 'box');
    const kase = casePrice(setId);
    if (!box || !kase) return null;

    const per = boxesPerCase(setId);
    const perBox = kase / per;
    const saving = 1 - (perBox / box);      // >0 means the case is cheaper
    return {
      box, case: kase, per, perBox, saving,
      // A few percent either way is noise against shipping and the cash
      // you tie up, so only a real gap is called either way.
      verdict: saving >= 0.05 ? 'case' : saving <= -0.05 ? 'boxes' : 'even'
    };
  }

  const priceOf = card => card.market_price || 0;

  /** Live market price for a collection row, via its stored composite key. */
  function priceForKey(key) {
    const c = S.byKey[key];
    return c ? (c.market_price || 0) : null;
  }

  function indexFor(setId) {
    if (S.indexCache[setId]) return S.indexCache[setId];
    const idx = E.buildSetIndex(setId, S.bySet[setId] || [], priceOf);
    S.indexCache[setId] = idx;
    return idx;
  }
  const invalidate = () => { S.indexCache = {}; };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * Size a card grid to show whole rows only.
   *
   * Tile height depends on column width (the art is aspect-ratio locked), so a
   * hard-coded max-height cannot stay right — 460px happened to slice the third
   * row in half. Measure a real tile and snap the container to N rows.
   */
  function fitGridRows(sel, rows) {
    const apply = () => {
      const grid = $(sel);
      if (!grid) return;
      const tile = grid.querySelector('.pick');
      if (!tile) { grid.style.maxHeight = ''; return; }
      const gap = parseFloat(getComputedStyle(grid).rowGap) || 10;
      const h = tile.getBoundingClientRect().height;
      if (!h) return;
      // Exactly N rows: no slack, or the next row peeks through and it reads
      // as a cut-off row rather than a scrollable list.
      grid.style.maxHeight = Math.round(rows * h + (rows - 1) * gap) + 'px';
      grid.classList.add('rows-set');
    };

    // Measure twice: once now, once after layout settles. The first pass runs
    // before the card images have sized, which reported tiles 10px taller and
    // left 2.1 rows showing instead of 2.
    apply();
    requestAnimationFrame(apply);
    const img = $(sel + ' .pick img');
    if (img && !img.complete) img.addEventListener('load', apply, { once: true });
  }

  /* Column count changes with width, which changes tile height. */
  let refitTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => {
      fitGridRows('#rip-grid', 2);
      fitGridRows('#add-grid', 3);
    }, 150);
  });

  /**
   * Card art, or a labelled placeholder when the source has none.
   * A handful of DON!! records come back with a null image; an <img> with an
   * empty src renders as an invisible gap that just looks like a bug.
   */
  function cardArt(card, extraClass) {
    const cls = extraClass ? ' ' + extraClass : '';
    const fl = artFlag(card);
    // A file exists, but it is the source's "coming soon" graphic wearing 30
    // different names. Drawing it would claim to show you a card it does not.
    if (!card.card_image || (fl && fl.kind === 0)) {
      return `<div class="noart${cls}" title="${esc(card.card_name)}">
        <span>no image</span></div>`;
    }
    return `<img class="${esc((extraClass || '').trim())}" src="${esc(card.card_image)}"
      alt="${esc(card.card_name)}" loading="lazy"
      onerror="this.outerHTML='&lt;div class=\\'noart${cls}\\'&gt;&lt;span&gt;no image&lt;/span&gt;&lt;/div&gt;'">`;
  }

  /** Rarity chip for a card thumbnail, sitting where the real card prints it. */
  function rarityChip(card) {
    const b = E.rarityBadge(card);
    return `<span class="rchip r-${esc(b.tone)}" title="${esc(b.label)}">` +
           `${b.star ? '<span class="star">★</span>' : ''}${esc(b.text)}</span>`;
  }

  /* ============================================================== DATA ==== */

  /**
   * DON!! cards come back in a different shape: no set_id, no card_set_id, and
   * the set only appears as a trailing code inside optcg_don_name, e.g.
   * "DON!! Card (Egghead) - The Azure Sea's Seven (OP14)".
   *
   * Reshaped here into the same record every other part of the app expects, so
   * nothing downstream needs to know DON!! cards are special.
   */
  function normaliseDons(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];

    // Fallback lookup by set NAME. The OP-16 alt-art DON!! is labelled
    // "DON!! Card (Alternate Art) - The Time of Battle" with no trailing code
    // at all, so code matching alone loses it entirely.
    const byName = {};
    for (const s of D.SETS) byName[s.name.toLowerCase()] = s.id;

    for (const d of rows) {
      const label = d.optcg_don_name || d.card_name || '';
      // Trailing "(CODE)" is the product it belongs to.
      const m = label.match(/\(([A-Z]{2,4}-?[A-Z0-9]{0,2})\)\s*$/);
      const code = m ? m[1] : null;
      let setId = code ? D.DON_SET_CODES[code] : null;

      if (!setId) {
        // " - <Set Name>" tail, with any trailing code stripped off.
        const tail = label.replace(/\s*\([^()]*\)\s*$/, '').split(' - ').pop();
        if (tail) setId = byName[tail.trim().toLowerCase()] || null;
      }

      // Which non-booster product is it from, if any?
      const product = D.DON_NON_BOOSTER.find(p => label.indexOf(p) > -1) || null;
      const booster = !!setId && !product;

      out.push({
        card_set_id: 'DON',
        card_image_id: d.card_image_id,
        card_name: d.card_name,
        // Unmapped DONs (promos, starter decks) are parked under their code so
        // they stay searchable instead of vanishing.
        set_id: setId || ('DON-' + (code || 'OTHER')),
        set_name: label,
        rarity: 'DON',
        market_price: d.market_price,
        inventory_price: d.inventory_price,
        card_color: '', card_type: 'DON!!',
        // 4 DON!! records ship with a null image upstream (incl. the OP-16
        // Gold alt-art). Normalised to '' so rendering can show a placeholder
        // rather than a blank hole.
        card_image: d.card_image || '',
        date_scraped: d.date_scraped,
        donBooster: booster,
        donProduct: product || (setId ? null : 'Promo or starter deck DON!!'),
        donVariant: /\(Gold\)/.test(d.card_name) ? 'Gold DON!!'
                  : /\(Silver\)/.test(d.card_name) ? 'Silver DON!!'
                  : /Manga/.test(d.card_name) ? 'Manga DON!!'
                  : /Alternate Art/.test(d.card_name) ? 'Alt Art DON!!' : 'DON!!'
      });
    }
    return out;
  }

  /* The card cache was 3,092 KB of a ~5 MB localStorage budget — 62% spent on
     one key, with the user's collection sharing the same quota. saveCritical()
     already drops this cache when a write fails, but living that close to the
     ceiling means the first symptom is a failed save of data you typed.

     Five fields, ~1.1 MB, are removed on the way in:
       card_image (485 KB)  derivable from id — it IS the id in a fixed URL
       set_name   (257 KB)  derivable from set_id via D.SETS
       direct_low (133 KB)  null on every single card; TCGplayer never fills it
       high_price (112 KB)  polluted with $9,999 placeholder listings and
                            deliberately never displayed
       printing   (112 KB)  read nowhere outside source.js

     Everything still needed is rebuilt on read, so the rest of the app never
     learns this happened. */
  const IMG_BASE = 'https://tcgplayer-cdn.tcgplayer.com/product/';

  function slimCard(c) {
    const o = Object.assign({}, c);
    delete o.card_image; delete o.set_name; delete o.printing;
    delete o.high_price; delete o.direct_low_price;
    // Only drop the image when it is exactly what we can rebuild.
    if (c.card_image !== IMG_BASE + c.id + '_400w.jpg') o.card_image = c.card_image;
    return o;
  }

  function fatCard(c) {
    if (c.card_image == null) c.card_image = IMG_BASE + c.id + '_400w.jpg';
    if (c.set_name == null) {
      const m = setMeta(c.set_id);
      c.set_name = m ? m.name : c.set_id;
    }
    return c;
  }

  async function fetchCards(force) {
    if (!force) {
      const cached = load(KEY.cards, null);
      // v1 rows are keyed on the old composite and carry no productId. Loading
      // them into a v2 app would look fine and be subtly wrong everywhere, so
      // a cache without ids is discarded and refetched rather than migrated.
      if (cached && cached.rows && cached.rows.length && cached.rows[0].id != null) {
        applyCards(cached.rows.map(fatCard), cached.at, cached.products || []);
        return { fromCache: true };
      }
    }
    // v2: one CSV per set from TCGCSV, through the Worker. source.js does the
    // parsing and shaping; this function only decides what to keep and when.
    //
    // The set list is built from the live group list rather than hardcoded, so
    // a set TCGplayer adds tomorrow shows up without a code change — it lands
    // in the promo namespace until it is given pull rates in data.js.
    const sets = await SRC.buildSets(D.SETS);
    const { cards, products, failed } = await SRC.loadAll(sets);

    if (!cards.length) {
      throw new Error(failed.length
        ? `No cards loaded. First failure: ${failed[0].set} — ${failed[0].error}`
        : 'No cards returned by the data source');
    }

    // A partial load is worth keeping — 83 of 84 sets is far better than
    // nothing — but it must not be cached as if it were complete, or one bad
    // afternoon would freeze a hole in the data until the next manual refresh.
    const complete = failed.length === 0;

    const at = new Date().toISOString();
    if (complete) save(KEY.cards, { at, rows: cards.map(slimCard), products });
    applyCards(cards, at, products);
    S.loadFailures = failed;
    return { fromCache: false, failed };
  }

  function applyCards(rows, at, products) {
    S.fetchedAt = at;
    S.bySet = {};
    S.byKey = {};
    // Dedupe is kept even though productId is unique, because it costs nothing
    // and the cost of being wrong is a card counted twice in its slot pool,
    // which quietly skews that slot's average and every EV built on it.
    const deduped = [];
    for (const c of rows) {
      const k = E.cardKey(c);
      if (S.byKey[k]) continue;
      S.byKey[k] = c;
      deduped.push(c);
      (S.bySet[c.set_id] = S.bySet[c.set_id] || []).push(c);
    }
    S.cards = deduped;

    // Sealed products, indexed by set. v1 had none of this — box prices were
    // hardcoded estimates in data.js.
    S.products = products || [];
    S.sealedBySet = {};
    for (const p of S.products) {
      (S.sealedBySet[p.set_id] = S.sealedBySet[p.set_id] || []).push(p);
    }

    S.browseSets = null;        // rebuilt lazily from the new card data
    invalidate();
  }

  /* Live sealed price for a set, or null when TCGplayer has no listing —
     a set can be sold out, or not on sale yet. Callers fall back to the
     estimate in data.js and mark it EST. */
  /* Share of a set's cards that carry a market price. */
  function pricedShare(setId) {
    const rows = S.bySet[setId] || [];
    if (!rows.length) return 0;
    let n = 0;
    for (const c of rows) if (c.market_price > 0) n++;
    return n / rows.length;
  }

  /* The newest set worth LANDING on.

     "Newest" alone is wrong. TCGplayer creates product records for a set
     before it has data: OP-17 arrives with 45 cards, 3 of them priced, and
     images that return 403 — so defaulting to it meant a first-time user
     opened the app on a grid of empty placeholders with no numbers. Walk back
     from the newest until a set has enough real data to be worth showing. */
  function defaultSetId(sets) {
    if (!sets || !sets.length) return null;
    for (let i = sets.length - 1; i >= 0; i--) {
      if (pricedShare(sets[i].id) >= 0.5) return sets[i].id;
    }
    return sets[sets.length - 1].id;
  }

  function sealedPrice(setId, kind) {
    // Called from boxPrice, which renders before the first load completes.
    const list = (S.sealedBySet && S.sealedBySet[setId]) || [];
    const hit = list.find(p => p.kind === kind && p.market_price > 0);
    return hit ? hit.market_price : null;
  }

  /* Wrong-artwork flagging is GONE in v2, and that is the point.
     optcgapi stored one picture per card NUMBER, so 55 cards were served
     another printing's artwork and 30 more got a "coming soon" placeholder;
     imgflags.js existed to own up to that. TCGplayer stores one picture per
     PRODUCT, so OP-16 Vista and Vista (TR) are different files — verified.
     Nothing left to flag, so the flag is deleted rather than left returning
     null forever. */
  const artFlag = () => null;
  const artFlagText = () => '';

  /**
   * Booster products only. Everything that computes odds, box EV or supply
   * signals uses this — a starter deck has no pull rate and a judge card
   * cannot come out of a pack.
   */
  function liveSets() {
    return D.SETS.filter(s => (S.bySet[s.id] || []).length > 0);
  }

  /**
   * Every product with cards, including starter decks and promos, for
   * browsing and collecting. Built from the fetched data rather than a
   * hardcoded list so new decks appear without a code change.
   */
  function browseSets() {
    if (S.browseSets) return S.browseSets;

    const extra = [];
    const seen = {};
    for (const c of S.cards) {
      if (!c.productKind || seen[c.set_id]) continue;
      seen[c.set_id] = true;
      extra.push({
        id: c.set_id,
        name: c.productKind === 'promo' ? 'Promos, winners, judge & event cards'
                                        : (c.set_name || c.set_id),
        short: c.productKind === 'promo' ? 'PROMO' : c.set_id.replace('-', ''),
        kind: c.productKind
      });
    }
    extra.sort((a, b) => a.kind === b.kind ? a.id.localeCompare(b.id)
                                           : (a.kind === 'promo' ? -1 : 1));
    S.browseSets = liveSets().concat(extra);
    return S.browseSets;
  }

  /* ========================================================== RIP vs BUY == */

  const poolOf = setId => indexFor(setId).all;

  /**
   * Every card in a product, for browsing and collecting — including the ones
   * that can never be pulled. buildSetIndex deliberately drops promos, box
   * toppers and non-booster DON!!, which is right for odds and wrong for a
   * collection: you still own the judge card.
   */
  function browsePool(setId) {
    const meta = setMeta(setId);
    if (meta && meta.kind && meta.kind !== 'booster') {
      const ck = 'browse|' + setId;
      if (S.indexCache[ck]) return S.indexCache[ck];
      /* Same unpriced-card problem as buildSetIndex, minus the slots: promos
         and deck cards have no pull slot to average over, so the proxy is the
         average of priced cards sharing the same printed RARITY in this group.
         An unpriced SEC then ranks with the other SECs instead of below every
         common in the set. */
      const rows = (S.bySet[setId] || []).map(c => ({
        card: c, key: E.cardKey(c), price: priceOf(c),
        slot: null, variantLabel: E.classify(c).variantLabel || null
      }));
      const byRarity = {};
      for (const r of rows) {
        if (!(r.price > 0)) continue;
        const k = r.card.rarity || '?';
        (byRarity[k] = byRarity[k] || []).push(r.price);
      }
      // Same fallback as buildSetIndex: a rarity where nothing is priced would
      // otherwise average to zero and sink every card in it.
      const allPriced = rows.filter(r => r.price > 0).map(r => r.price);
      const groupAvg = allPriced.length
        ? allPriced.reduce((x, y) => x + y, 0) / allPriced.length : 0;
      const avgFor = k => {
        const a = byRarity[k];
        return a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : groupAvg;
      };
      for (const r of rows) {
        r.unpriced = !(r.price > 0);
        r.sortPrice = r.unpriced ? avgFor(r.card.rarity || '?') : r.price;
      }
      rows.sort((a, b) => b.sortPrice - a.sortPrice);
      S.indexCache[ck] = rows;
      return rows;
    }
    const idx = indexFor(setId);
    // Booster sets: pullable cards first, then the excluded ones so a box
    // topper you own is still findable.
    return idx.all.concat(idx.excluded.map(x => {
      const price = priceOf(x.card);
      return { card: x.card, key: E.cardKey(x.card), price,
               unpriced: !(price > 0), sortPrice: price,
               slot: null, variantLabel: x.reason || null };
    }));
  }

  /**
   * With no query, show the selected set's pack pool.
   *
   * With a query, search EVERY set — because a card's number does not tell you
   * which pack it comes out of. OP08-106 Nami (SP) is pulled from OP-09 boxes,
   * so hunting for it inside OP-08 finds nothing. Searching only the open set
   * hides exactly the cards people go looking for.
   */
  /** Everything in scope, before the rarity and colour filters are applied. */
  function ripBasePool() {
    const q = S.ripSearch.trim().toLowerCase();
    let rows;
    if (!q) {
      rows = poolOf(S.ripSet);
    } else {
      rows = [];
      for (const s of liveSets()) {
        for (const e of poolOf(s.id)) {
          if (e.card.card_name.toLowerCase().includes(q) ||
              e.card.card_set_id.toLowerCase().includes(q)) {
            rows.push(Object.assign({ fromSet: s.id }, e));
          }
        }
      }
    }
    return rows;
  }

  const isBoosterSet = id => D.SETS.some(s => s.id === id);

  function ripCardOptions() {
    const q = S.ripSearch.trim().toLowerCase();
    const slot = S.ripRarity || 'all';
    let rows;

    if (!q) {
      rows = browsePool(S.ripSet);
    } else {
      // Search spans EVERY group — boosters, decks and promos alike.
      rows = [];
      for (const s of browseSets()) {
        for (const e of browsePool(s.id)) {
          if (e.card.card_name.toLowerCase().includes(q) ||
              e.card.card_set_id.toLowerCase().includes(q)) {
            rows.push(Object.assign({ fromSet: s.id }, e));
          }
        }
      }
    }
    // Chase tiers are what you actually hunt; commons make the list unusable.
    if (slot === 'chase') rows = rows.filter(e =>
      ['SEC', 'ALT', 'SP', 'MANGA', 'ULTRA', 'TR'].indexOf(e.slot) > -1);
    else if (slot !== 'all') rows = rows.filter(e => e.slot === slot);

    // Colour stacks with rarity rather than replacing it. Multicolour cards
    // match every colour they contain, which is how a player thinks about them.
    const col = S.ripColor || 'all';
    if (col !== 'all') {
      rows = rows.filter(e => hasColor(e.card, col));
    }

    // Sort on the same key the pools use, so an unpriced chase keeps its
    // place instead of dropping to the bottom the moment a filter is applied.
    rows.sort((a, b) => (b.sortPrice != null ? b.sortPrice : b.price)
                      - (a.sortPrice != null ? a.sortPrice : a.price));
    return rows;
  }

  /** Could this card have come out of a booster pack at all? */
  function isPullable(key) {
    const card = S.byKey[key];
    if (!card) return false;
    const meta = D.SETS.find(s => s.id === card.set_id);
    return !!meta && E.classify(card).slot !== null;
  }

  const hasColor = (card, color) =>
    (card.card_color || '').split(/\s+/).indexOf(color) > -1;

  /**
   * Both filters stack, so each is counted against the OTHER's current
   * selection — picking Red then opening Rarity shows how many Red alt arts
   * exist, not how many alt arts exist overall.
   */
  function renderRarityFilter() {
    const raritySel = $('#rip-rarity'), colorSel = $('#rip-color');
    if (!raritySel || !colorSel) return;

    const base = ripBasePool();
    const color = S.ripColor || 'all';
    const slot = S.ripRarity || 'all';
    const chaseKeys = ['SEC', 'ALT', 'SP', 'MANGA', 'ULTRA', 'TR'];

    // ---- rarity options, counted within the chosen colour
    const forRarity = color === 'all' ? base : base.filter(e => hasColor(e.card, color));
    const rCounts = {};
    for (const e of forRarity) rCounts[e.slot] = (rCounts[e.slot] || 0) + 1;
    const chaseCount = chaseKeys.reduce((s, k) => s + (rCounts[k] || 0), 0);

    const rOpts = [
      `<option value="all">All rarities (${forRarity.length})</option>`,
      `<option value="chase">Chase only (${chaseCount})</option>`
    ];
    for (const sl of D.SLOTS) {
      if (!rCounts[sl.key]) continue;                 // hide what is not there
      rOpts.push(`<option value="${esc(sl.key)}">${esc(sl.label)} (${rCounts[sl.key]})</option>`);
    }
    raritySel.innerHTML = rOpts.join('');
    raritySel.value = slot;
    // The chosen rarity may not exist in this colour — fall back rather than
    // silently showing an empty grid.
    if (raritySel.value !== slot) { S.ripRarity = 'all'; raritySel.value = 'all'; }

    // ---- colour options, counted within the chosen rarity
    const forColor = slot === 'all' ? base
      : slot === 'chase' ? base.filter(e => chaseKeys.indexOf(e.slot) > -1)
      : base.filter(e => e.slot === slot);
    const cCounts = {};
    for (const e of forColor) {
      for (const c of D.COLORS) if (hasColor(e.card, c)) cCounts[c] = (cCounts[c] || 0) + 1;
    }
    const cOpts = [`<option value="all">All colours (${forColor.length})</option>`];
    for (const c of D.COLORS) {
      if (!cCounts[c]) continue;
      cOpts.push(`<option value="${esc(c)}">${esc(c)} (${cCounts[c]})</option>`);
    }
    colorSel.innerHTML = cOpts.join('');
    colorSel.value = color;
    if (colorSel.value !== color) { S.ripColor = 'all'; colorSel.value = 'all'; }
  }

  function renderRipControls() {
    /* Every group, not just the 22 rippable boosters.

       This tab is where you look a card up, and until now it could only see
       booster sets — so starter decks, promos, judge and winner cards, event
       packs, Dash Packs and anniversary sets were all unreachable, even though
       the app had already loaded them. 6,798 cards were in memory and 3,600 of
       them could not be found. */
    const sets = browseSets();
    if (!S.ripSet || !sets.some(s => s.id === S.ripSet)) S.ripSet = defaultSetId(liveSets());

    // A set TCGplayer has created but not populated is marked, so choosing it
    // and finding empty art and no numbers is an informed decision rather than
    // a bug you have to diagnose.
    $('#rip-set').innerHTML = sets.map(s =>
      `<option value="${esc(s.id)}"${s.id === S.ripSet ? ' selected' : ''}>${
        esc(s.short)} · ${esc(s.name)}${
        isBoosterSet(s.id) && pricedShare(s.id) < 0.5 ? ' — no data yet' : ''}</option>`
    ).join('');

    const thin = isBoosterSet(S.ripSet) && pricedShare(S.ripSet) < 0.5;
    const note = $('#rip-thin');
    if (note) {
      note.innerHTML = thin
        ? `<div class="note warn small" style="margin-bottom:10px">
             <b>${esc(setShort(S.ripSet))} has almost no data yet.</b> TCGplayer lists the cards
             but has not published prices or artwork for most of them, so odds and value here
             are not meaningful. Nothing is broken — the set is simply too new.</div>`
        : '';
    }

    renderRarityFilter();
    const opts = ripCardOptions();
    if (!S.ripCard || !opts.some(o => o.key === S.ripCard)) S.ripCard = opts.length ? opts[0].key : null;

    // A card game deserves card art, not a 155-row text dropdown. Same grid
    // component as the collection picker, so both places behave identically.
    const searching = !!S.ripSearch.trim();
    $('#rip-count').textContent = opts.length
      ? opts.length + (searching ? ' across all sets' : ' cards') : '';

    /* A listbox, not a pile of divs.

       These were <div class="pick"> with a click handler: no tabindex, no
       role, no accessible name — the card name lived only in `title`. Picking
       a card is the whole point of this tab and it was mouse-only, and silent
       to a screen reader.

       Roving tabindex rather than tabindex="0" on all 150: making every tile a
       tab stop would put 150 presses between the filters and the rest of the
       page. One stop enters the grid, arrows move inside it — the standard
       listbox pattern.

       The aria-label carries everything the tile shows visually plus the name,
       so the <img> inside stays alt="" on purpose: labelling both would make a
       screen reader announce the card twice. */
    const grid = $('#rip-grid');
    grid.setAttribute('role', 'listbox');
    grid.setAttribute('aria-label', 'Cards' + (searching ? ' matching your search' : ' in this set'));

    /* The cap used to be a bare slice(0, 150) with nothing said about it.

       Cards are sorted by price descending, so the cull always fell on the
       CHEAPEST — and an unpriced card sorts as $0. That is exactly backwards
       for a chase: OP-13's Red Super Alternate Art Luffy and Ace have no
       market price yet because they barely trade, so they sorted last and were
       cut, while the app cheerfully said "177 cards". Across the catalogue
       2,951 cards were unreachable this way, 2,322 of them promos.

       Still capped, because PROMO is 2,472 tiles and rendering every image at
       once is slow — but the count is now honest and the rest is one click. */
    const limit = S.gridLimit;
    const shown = Math.min(opts.length, limit);
    grid.innerHTML = opts.slice(0, limit).map(e => {
      const fl = artFlag(e.card);
      const selected = e.key === S.ripCard;
      const from = e.fromSet
        ? (isBoosterSet(e.fromSet) ? ', pulled from ' + setShort(e.fromSet) + ' packs'
                                   : ', from ' + setShort(e.fromSet))
        : '';
      const label = `${e.card.card_name}${e.variantLabel ? ', ' + e.variantLabel : ''}` +
                    `, ${e.card.card_set_id}, ${e.unpriced ? 'no market price yet' : E.money(e.price)}${from}` +
                    `${fl ? '. ' + artFlagText(fl) : ''}`;
      return `
      <div class="pick${selected ? ' sel' : ''}${fl ? ' badart' : ''}"
           role="option"
           aria-selected="${selected}"
           tabindex="${selected ? '0' : '-1'}"
           aria-label="${esc(label)}"
           data-key="${esc(e.key)}"
           data-set="${esc(e.fromSet || S.ripSet)}">
        ${cardArt(e.card)}
        <div class="pmeta"><span class="pp${e.unpriced ? ' nopx' : ''}">${
          e.unpriced ? 'no price' : E.money(e.price)}</span>${rarityChip(e.card)}</div>
        <div class="pn">${searching ? esc(setShort(e.fromSet)) + ' · ' : ''}${esc(e.card.card_set_id)}</div>
      </div>`;
    }).join('') || `<div class="small muted">No cards match.</div>`;

    const more = $('#rip-more');
    if (more) {
      more.innerHTML = opts.length > shown
        ? `<button class="btn ghost small" id="rip-showall">
             Showing ${shown} of ${opts.length} — show the rest</button>`
        : '';
      const b = $('#rip-showall');
      if (b) b.addEventListener('click', () => { S.gridLimit = Infinity; renderRip(); });
    }

    // Nothing selected yet (an empty filter, say) still needs a way in.
    if (!grid.querySelector('.pick[tabindex="0"]')) {
      const first = grid.querySelector('.pick');
      if (first) first.tabIndex = 0;
    }

    const pickCard = el => {
      if (el.dataset.key === S.ripCard) return;
      // A search hit may live in a different set's pool — follow it there, or
      // the odds lookup would run against the wrong box.
      if (el.dataset.set && el.dataset.set !== S.ripSet) S.ripSet = el.dataset.set;
      S.ripCard = el.dataset.key;
      renderRip();
      const sel = $('#rip-grid .pick.sel');
      if (sel) sel.scrollIntoView({ block: 'nearest' });

      /* On a phone the answer renders ~800px below the fold, so tapping a card
         looked like it did nothing until you scrolled most of a screen. On a
         wide layout the panel is already beside the grid, so scrolling there
         would yank the page for no reason — hence the width check, not a
         blanket scroll. */
      if (window.matchMedia('(max-width: 860px)').matches) {
        const out = $('#rip-out');
        if (out) {
          const before = window.scrollY;
          out.scrollIntoView({ behavior: 'smooth', block: 'start' });
          // Smooth scrolling is a silent no-op in some engines — measured here,
          // where it left scrollY at 0 while a plain call moved 771px. Landing
          // the user nowhere is far worse than landing them there abruptly, so
          // if nothing has moved shortly after, do it the guaranteed way.
          setTimeout(() => {
            if (Math.abs(window.scrollY - before) < 8) {
              out.scrollIntoView({ block: 'start' });
            }
          }, 350);
        }
      }
    };

    $$('#rip-grid .pick').forEach(el => el.addEventListener('click', () => pickCard(el)));

    /* Keyboard operation of the grid.

       Enter/Space select, arrows move. Arrow keys only move FOCUS and the
       roving tabindex — they do not select, so arrowing across 150 cards does
       not re-render the odds panel 150 times. Home/End jump to the ends, which
       matters when the grid is the whole set. */
    const gridEl = $('#rip-grid');
    if (gridEl) gridEl.addEventListener('keydown', ev => {
      const tile = ev.target.closest('.pick');
      if (!tile) return;

      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();
        pickCard(tile);
        return;
      }

      const tiles = [...gridEl.querySelectorAll('.pick')];
      const i = tiles.indexOf(tile);
      if (i < 0) return;

      // Column count comes from the rendered grid, so Up/Down move a visual
      // row rather than a guessed one — the grid reflows between phone and
      // desktop and a hardcoded stride would jump to the wrong card.
      const cols = Math.max(1, getComputedStyle(gridEl).gridTemplateColumns.split(' ').filter(Boolean).length);

      let next = null;
      if (ev.key === 'ArrowRight') next = tiles[i + 1];
      else if (ev.key === 'ArrowLeft') next = tiles[i - 1];
      else if (ev.key === 'ArrowDown') next = tiles[Math.min(i + cols, tiles.length - 1)];
      else if (ev.key === 'ArrowUp') next = tiles[Math.max(i - cols, 0)];
      else if (ev.key === 'Home') next = tiles[0];
      else if (ev.key === 'End') next = tiles[tiles.length - 1];
      else return;

      if (!next) return;
      ev.preventDefault();
      tile.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    });

    fitGridRows('#rip-grid', 2);
  }

  /**
   * Verdict from odds and price alone — no box cost, no resale assumptions.
   *
   * The question "should I rip or buy this card" really only needs two facts:
   * how many packs it takes to expect one, and what the card costs. Thresholds
   * are in boxes because that is the unit you actually buy in.
   */
  function oddsVerdict(expectedPacks, packsPerBox, single) {
    const boxes = expectedPacks / packsPerBox;
    if (single < 2)  return { code: 'TRIVIAL',  title: 'NOT A CHASE' };
    if (boxes <= 2)  return { code: 'RIP',      title: 'RIP FOR IT' };
    if (boxes <= 10) return { code: 'COINFLIP', title: 'YOUR CALL' };
    return { code: 'BUY', title: 'BUY THE SINGLE' };
  }

  /* Everything sealed for the current set: what it costs, whether a case beats
     boxes, what the cards inside are worth, and the products v1 could not see
     at all (Double Pack Sets, sleeved packs, DON!! packs). */
  function renderSealed() {
    const out = $('#sealed-out');
    if (!out) return;
    const setId = S.ripSet;
    const list = (S.sealedBySet[setId] || []).filter(p => p.market_price > 0);

    if (!list.length) {
      out.innerHTML = `<div class="panel" style="margin-bottom:18px"><div class="panel-b small muted">
        No sealed product listed for ${esc(setShort(setId))} — usually means it is sold out
        or not on sale yet. Box price falls back to the estimate in settings.</div></div>`;
      return;
    }

    const deal = caseDeal(setId);
    const idx = indexFor(setId);
    const cfg = configFor(setId);
    const evBox = idx ? E.evaluate(idx, cfg).evBox : null;
    const box = sealedPrice(setId, 'box');

    // Order the way you would actually shop: biggest commitment first.
    const rank = { case: 0, box: 1, display: 2, deck: 3, sleevedpack: 4, pack: 5, other: 6 };
    list.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || b.market_price - a.market_price);

    const dealBox = !deal ? '' : `
      <div class="verdict ${deal.verdict === 'case' ? 'RIP' : deal.verdict === 'boxes' ? 'BUY' : 'COINFLIP'}"
           style="text-align:left;margin-bottom:14px">
        <div class="lbl">Case or boxes</div>
        <div class="big">${
          deal.verdict === 'case'  ? `Buy the case — ${E.pct(deal.saving, 0)} cheaper per box`
        : deal.verdict === 'boxes' ? `Buy boxes — the case costs ${E.pct(-deal.saving, 0)} more per box`
        :                            'Either — under 5% apart'}</div>
        <div class="sub">
          A case is <b>${E.money(deal.case)}</b> for <b>${deal.per}</b> boxes, so
          <b>${E.money(deal.perBox)}</b> each against <b>${E.money(deal.box)}</b> buying singly.
          ${boxesPerCase(setId) === DEFAULT_PER_CASE
            ? `<span class="muted">Assumes ${DEFAULT_PER_CASE} boxes per case — change it in Settings if this product differs.</span>` : ''}
        </div>
      </div>`;

    // The comparison you asked for: two measured numbers, no projection.
    const evBlock = (box && evBox != null) ? `
      <div class="grid g-2" style="gap:12px;margin-bottom:12px">
        ${stat('Box costs', E.money(box), 'live TCGplayer market')}
        ${stat('Cards inside are worth', E.money(evBox),
               'modelled from pull rates', evBox >= box ? 'hero' : '')}
      </div>
      <div class="small muted" style="margin-bottom:14px;line-height:1.5">
        ${evBox >= box
          ? `The cards model out <b class="up">${E.money(evBox - box)}</b> above what the box costs.`
          : `The box costs <b class="down">${E.money(box - evBox)}</b> more than the cards model out to.`}
        Both numbers are real, but they are not the same kind of number: the box price is
        what the market charges today, the card value is an <em>average</em> across the
        whole set — most boxes land under it, a few far above. It also assumes you sell
        everything at market, which no one does.
      </div>` : '';

    out.innerHTML = `
      <div class="panel" data-collapse="sealed" data-collapse-mobile style="margin-bottom:18px">
        <div class="panel-h"><h2>Sealed — ${esc(setShort(setId))}</h2>
          <span class="small muted" style="margin-left:auto">${list.length} product${list.length === 1 ? '' : 's'}</span>
        </div>
        <div class="panel-b">
          ${dealBox}
          ${evBlock}
          <div class="tbl-scroll"><table class="tbl">
            <thead><tr><th>Product</th><th class="num">Market</th><th class="num">Lowest</th><th></th></tr></thead>
            <tbody>${list.map(p => `
              <tr>
                <td>${esc(p.name)}</td>
                <td class="num"><b>${E.money(p.market_price)}</b></td>
                <td class="num muted">${p.low_price ? E.money(p.low_price) : '—'}</td>
                <td class="num">${p.buy_url
                  ? `<a class="btn ghost small" href="${esc(p.buy_url)}" target="_blank" rel="noopener nofollow">Buy</a>`
                  : ''}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
        </div>
      </div>`;
    wireCollapsibles();
  }

  /* The card page for anything you cannot pull from a pack.

     Same layout as the odds page minus the probability block: art, rarity,
     both prices, the supply read and a buy link. Everything you would want
     when price-checking a promo or a starter-deck card. */
  function renderPriceOnlyCard(out, why) {
    const card = S.byKey[S.ripCard];
    if (!card) { out.innerHTML = panelMsg('Pick a card.'); return; }

    const sig    = E.spreadSignal(card);
    const single = priceOf(card);
    const owned  = ownedSummary(S.ripCard);
    const badge  = E.rarityBadge(card);
    const origin = card.originSet ? ' · ' + card.originSet : '';

    out.innerHTML = `
      <div class="panel" style="margin-bottom:18px">
        <div class="panel-b">
          <div class="cardhero">
            ${card.card_image
              ? `<img src="${esc(card.card_image)}" alt="${esc(card.card_name)}" loading="lazy"
                     class="zoomable" id="hero-img" tabindex="0" role="button" title="Click to enlarge">`
              : `<div class="noart" id="hero-img"><span>no image<br>available</span></div>`}
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
                <span class="tag">${esc(badge.label || badge.text)}</span>
                <span class="mono small muted">${esc(card.card_set_id || '')}</span>
                ${owned ? `<span class="tag" style="color:var(--up);border-color:#2a6b4a">✓ you own ${owned.qty}</span>` : ''}
              </div>
              <h3 class="cardtitle" title="${esc(card.card_name)}">${esc(card.card_name)}</h3>
              <div class="small muted setline">${esc(setShort(card.set_id))}${esc(origin)}</div>

              <div class="grid g-2" style="gap:12px;margin:12px 0 8px">
                ${stat('Market price', E.money(single), 'recent sold average')}
                ${stat('Lowest listing', sig ? E.money(sig.inventory) : '—',
                       sig ? 'cheapest listed now' : 'no listing data')}
              </div>
              ${sig ? `<div class="small muted" style="margin-bottom:14px">
                Listing is <b>${E.pct(sig.ratio, 0)}</b> of market — <b>${esc(sig.state)}</b> supply.</div>` : ''}
              ${card.buy_url ? `<a class="btn primary" href="${esc(card.buy_url)}" target="_blank"
                   rel="noopener nofollow" style="display:inline-block">View on TCGplayer</a>` : ''}
            </div>
          </div>

          <div class="note small" style="margin-top:16px">
            <b>No pack odds for this card.</b>
            ${esc(why || 'It comes from a starter deck, promo, event or other sealed product rather than a booster pack, so there is nothing to calculate odds against.')}
            Price and supply above are live.
          </div>
        </div>
      </div>`;

    const hero = $('#hero-img');
    if (hero && card.card_image) {
      hero.addEventListener('click', () => openLightbox(card));
      hero.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(card); }
      });
    }
  }

  function renderRip() {
    renderRipControls();
    renderSealed();
    const out = $('#rip-out');

    if (!S.ripSet || !S.ripCard) {
      out.innerHTML = panelMsg('Pick a card to see its odds and price trend.');
      return;
    }

    /* A promo, a deck card or a box topper has no pack odds — there is no pack.
       That used to dead-end on "not in this set's pack pool", which is true and
       useless: you came to look the card up, and the price is the answer. Show
       the card and its market data, and say plainly why there are no odds. */
    if (!isBoosterSet(S.ripSet)) { renderPriceOnlyCard(out); return; }

    const idx  = indexFor(S.ripSet);
    const cfg  = configFor(S.ripSet);
    const prob = E.perPackProbability(idx, cfg, S.ripCard);

    if (!prob) { renderPriceOnlyCard(out, 'This card is in the set but not in its pack pool — a box topper, promo insert or similar.'); return; }

    const card   = prob.entry.card;
    const single = prob.entry.price;
    const packs  = cfg.packsPerBox;

    if (prob.impossible) {
      out.innerHTML = panelMsg(
        `<b>${esc(card.card_name)}</b> sits in the <b>${esc(prob.slot)}</b> slot, which your current pull
         rates set to zero per box — so it cannot be pulled from this product at all.
         If that is wrong, raise it in Settings.`);
      return;
    }

    const expectedPacks = 1 / prob.p;
    const packsFor = q => Math.log(1 - q) / Math.log(1 - prob.p);
    const packs90 = packsFor(0.9);
    const pPerBox = 1 - Math.pow(1 - prob.p, packs);
    const boxesToHit = expectedPacks / packs;

    const v = oddsVerdict(expectedPacks, packs, single);

    const verdictLine =
      v.code === 'TRIVIAL'
        ? `At <b>${E.money(single)}</b> this card costs about the same as a pack. There is no chase to run —
           buy it, and rip for the cards actually worth hunting.`
      : v.code === 'RIP'
        ? `About <b>${boxesToHit.toFixed(1)} boxes</b> to expect one. That is well inside normal ripping,
           so you will run into it on your own.`
      : v.code === 'COINFLIP'
        ? `About <b>${boxesToHit.toFixed(1)} boxes</b> to expect one. Reachable if you were opening this set
           anyway — a bad plan if you are only after this card.`
        : `About <b>${Math.round(boxesToHit)} boxes</b> to expect one, and <b>${Math.round(packs90 / packs)}</b>
           to be 90% sure. Those are lottery odds. At <b>${E.money(single)}</b>, buy it.`;

    const owned = ownedSummary(S.ripCard);
    const sig = E.spreadSignal(card);
    const fitNote = configWarning(idx, cfg);
    const heroFlag = artFlag(card);

    out.innerHTML = `
      <div class="panel" style="margin-bottom:18px">
        <div class="panel-b">
          <div class="cardhero">
            ${card.card_image && !(heroFlag && heroFlag.kind === 0)
              ? `<img src="${esc(card.card_image)}" alt="${esc(card.card_name)}" loading="lazy"
                     class="zoomable${heroFlag ? ' badart-img' : ''}" id="hero-img" tabindex="0" role="button"
                     title="Click to enlarge">`
              : `<div class="noart" id="hero-img" title="${esc(card.card_name)} — no image in the source data">
                   <span>no image<br>available</span></div>`}
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
                <span class="tag slot-${esc(prob.slot)}">${esc(prob.entry.variantLabel || (D.RARITY[prob.slot] || {}).label || prob.slot)}</span>
                <span class="mono small muted">${esc(card.card_set_id)}</span>

                ${owned ? `<span class="tag" style="color:var(--up);border-color:#2a6b4a">✓ you own ${owned.qty}</span>` : ''}
                ${heroFlag
                  ? `<span class="tag est" title="${esc(artFlagText(heroFlag))}">⚠ ${
                       heroFlag.kind === 0 ? 'no artwork in source' : 'artwork is not this card'}</span>`
                  : ''}
              </div>
              <h3 class="cardtitle" title="${esc(card.card_name)}">${esc(card.card_name)}</h3>
              <div class="small muted setline">
                ${esc(setShort(S.ripSet))} · ${esc(setName(S.ripSet))}
                ${reprintNote(card, S.ripSet)}
              </div>
              ${heroFlag ? `<div class="artwarn">${esc(artFlagText(heroFlag))}</div>` : ''}

              <div class="grid g-2" style="gap:12px;margin-bottom:8px">
                ${stat('Market price', E.money(single),
                       'recent sold average, near mint')}
                ${stat('Lowest listing', sig ? E.money(sig.inventory) : '—',
                       sig ? 'cheapest listed now · condition unknown' : 'no listing data')}
              </div>
              <div class="small muted" style="margin-bottom:14px;line-height:1.5">
                ${sig ? `Listing is <b>${E.pct(sig.ratio, 0)}</b> of market — <b>${esc(sig.state)}</b> supply. ` : ''}
                ${card.alt_printing ? `<br><b>${esc(card.alt_printing.printing)} printing:</b> ` +
                  `${E.money(card.alt_printing.market)}` +
                  ` <span class="muted">— TCGplayer lists both under one product id; the figure above is the Normal printing.</span>` : ''}
                <span title="Market price is TCGplayer's weighted average of recent completed sales. The listing is the cheapest copy for sale right now — no condition breakdown is published, so it is whatever the seller listed. The gap between them widens with price: at $500+ the median card is listed AT or above its sold average.">
                  Why these differ ⓘ</span>
              </div>
              ${card.buy_url ? `
                <a class="btn primary" href="${esc(card.buy_url)}" target="_blank" rel="noopener nofollow"
                   style="margin-bottom:14px;display:inline-block">View on TCGplayer</a>` : ''}

              <div class="verdict ${v.code}" style="text-align:left">
                <div class="lbl">Verdict</div>
                <div class="big">${v.title}</div>
                <div class="sub">${verdictLine}</div>
                ${owned ? `<div class="sub muted" style="margin-top:9px;font-size:12.5px">
                  You already have <b>${owned.qty}</b> in ${esc(owned.where)}.</div>` : ''}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="grid g-3" style="margin-bottom:18px">
        ${stat('Odds per pack', E.odds(prob.p), `${E.pct(prob.p, 3)} · ${prob.poolSize} cards share the ${esc(prob.slot)} slot`)}
        ${stat('Chance per box', E.pct(pPerBox), `${packs} packs per box`)}
        ${stat('Boxes to 90% odds', Math.ceil(packs90 / packs).toLocaleString(), `${Math.round(packs90).toLocaleString()} packs`)}
      </div>

      ${fitNote}

      <div class="note small" style="margin-top:18px">
        Odds assume every card in the <b>${esc(prob.slot)}</b> slot is equally likely — Bandai does not publish
        per-card weighting, so nobody can do better than that. Real boxes are also not independent:
        hits are distributed per box, which makes a single box slightly more predictable than this model,
        and a long chase across many boxes slightly less.
      </div>`;

    const hero = $('#hero-img');
    // A placeholder has nothing to enlarge, so it is not made clickable.
    if (hero && card.card_image) {
      hero.addEventListener('click', () => openLightbox(card));
      hero.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(card); }
      });
    }
  }

  /* ---- full-size card view ---------------------------------------------- */
  function openLightbox(card) {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-bg lightbox" id="lb">
        <figure class="lb-fig">
          <img src="${esc(card.card_image)}" alt="${esc(card.card_name)}"
               onerror="this.style.visibility='hidden'">
          <figcaption>
            <b>${esc(card.card_name)}</b>
            <span>${esc(card.card_set_id)} · ${esc(setName(card.set_id))}</span>
          </figcaption>
        </figure>
        <button class="lb-close" id="lb-close" aria-label="Close">×</button>
      </div>`;

    const close = () => {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      const hero = $('#hero-img');
      if (hero) hero.focus();          // put focus back where it came from
    };
    const onKey = e => { if (e.key === 'Escape') close(); };

    document.addEventListener('keydown', onKey);
    $('#lb-close').addEventListener('click', close);
    // Click the backdrop to dismiss, but not the card itself.
    $('#lb').addEventListener('click', e => { if (e.target.id === 'lb') close(); });
    $('#lb-close').focus();
  }

  /**
   * A card numbered for one set but pulled from another's packs.
   *
   * This is normal — SP and reprint chases are seeded into later sets — but it
   * is genuinely confusing, because looking for OP08-106 Nami (SP) inside OP-08
   * finds nothing: it comes out of OP-09 boxes. Say so on the card rather than
   * letting the number and the set silently disagree.
   */
  function reprintNote(card, setId) {
    // DON!! cards carry no set number, so there is nothing to disagree about.
    if (card.rarity === 'DON') return '';
    const numbered = (card.card_set_id || '').split('-')[0];
    const from = String(setId).replace('-', '').replace(/EB0?4$/, '');
    if (!numbered || numbered === from) return '';
    return `<br><span class="tag est" style="margin-top:5px;display:inline-block">
      numbered ${esc(numbered)} · pulled from ${esc(setShort(setId))} packs</span>`;
  }

  /** Do I already own this card, and where? Drives the "you own N" badge. */
  function ownedSummary(key) {
    const mine = C.live(S.items).filter(it => it.key === key);
    if (!mine.length) return null;
    const qty = mine.reduce((s, it) => s + (Number(it.qty) || 0), 0);
    if (!qty) return null;
    const names = [];
    for (const it of mine) {
      const col = S.cols.find(c => c.id === it.colId);
      const n = col ? col.name : 'a binder';
      if (names.indexOf(n) === -1) names.push(n);
    }
    return { qty, where: names.join(' and ') };
  }

  /**
   * Banner for products whose pack structure Bandai never published, or whose
   * pull-rate config does not fit the set's actual card pool.
   */
  function configWarning(idx, cfg) {
    const fit = E.configFit(idx, cfg);
    if (cfg.verified && fit.ok && !fit.issues.length) return '';

    const bits = [];
    if (!cfg.verified) {
      bits.push(`<b>${esc(cfg.label)} structure is not officially documented.</b>
        Pack and box counts are confirmed, but the rarity split per pack is inferred from the
        set's own card pool. Treat this set's expected value as a rough read, not a number to
        buy a case on.`);
    }
    for (const i of fit.issues) bits.push(esc(i.message));

    return `<div class="note warn small" style="margin-bottom:18px">${bits.join('<br>')}</div>`;
  }

  const panelMsg = html => `<div class="panel"><div class="panel-b muted">${html}</div></div>`;

  function stat(k, v, s, cls) {
    return `<div class="stat${cls ? ' ' + cls : ''}">
      <div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  }

  /* ======================================================= SET EXPLORER == */

  function setRows() {
    return liveSets().map(s => {
      const idx  = indexFor(s.id);
      const cfg  = configFor(s.id);
      const ev   = E.evaluate(idx, cfg);
      const conc = E.chaseConcentration(idx, cfg, 5);
      const box  = boxPrice(s.id);
      return {
        id: s.id, name: s.name, short: s.short,
        box, evBox: ev.evBox, evPack: ev.evPack,
        roi: box > 0 ? ev.evBox / box - 1 : null,
        conc: conc.share,
        // idx.all is sorted by price descending, so [0] IS the most expensive
        // card. This used to read conc.all[0], which is sorted by EV
        // CONTRIBUTION (copies per box x price) — so a cheap card with good
        // odds outranked the real chase and OP-09 reported $120 instead of
        // its $5,500 Gol.D.Roger (Manga).
        best: idx.all.length ? idx.all[0].price : 0,
        bestCard: idx.all.length ? idx.all[0] : null,
        // What one copy of every card at or above the floor would cost you.
        over5: idx.all.reduce((s, e) => e.price >= 5 ? s + e.price : s, 0),
        over5Count: idx.all.reduce((n, e) => e.price >= 5 ? n + 1 : n, 0),
        cards: (S.bySet[s.id] || []).length,
        est: boxIsEstimate(s.id),
        case_: casePrice(s.id),
        unverified: !cfg.verified || !E.configFit(idx, cfg).ok
      };
    });
  }

  function renderSets() {
    const tbody = $('#sets-tbl tbody');
    const rows = setRows();
    const { by, dir } = S.sort.sets;
    rows.sort((a, b) => {
      const av = a[by], bv = b[by];
      if (av == null) return 1;
      if (bv == null) return -1;
      return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * dir;
    });

    $('#sets-sub').textContent = rows.length + ' sets · ' + S.cards.length.toLocaleString() + ' cards';
    tbody.innerHTML = rows.map(r => `
      <tr class="clickable" data-set="${esc(r.id)}">
        <td><button type="button" class="rowlink" data-set="${esc(r.id)}">
          <b>${esc(r.short)}</b> <span class="muted small">${esc(r.name)}</span></button>
          ${r.unverified ? ' <span class="tag est">? unverified pack structure</span>' : ''}</td>
        <td class="num" data-l="Box price">${E.money(r.box)}${r.est ? ' <span class="tag est">EST</span>' : ''}</td>
        <td class="num" data-l="Case">${r.case_ == null ? '<span class="muted">—</span>' : E.money(r.case_)}</td>
        <td class="num" data-l="EV / box">${E.money(r.evBox)}</td>
        <td class="num" data-l="EV / pack">${E.money(r.evPack)}</td>
        <td class="num ${r.roi == null ? '' : r.roi >= 0 ? 'up' : 'down'}">
          <b>${r.roi == null ? '—' : (r.roi >= 0 ? '+' : '') + E.pct(r.roi, 0)}</b></td>
        <td class="num">
          <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
            <span>${E.pct(r.conc, 0)}</span>
            <span class="bar brass" style="width:52px"><i style="width:${Math.min(100, r.conc * 100).toFixed(0)}%"></i></span>
          </div></td>
        <td class="num">${E.money(r.best)}${r.bestCard
          ? `<div class="small muted" style="font-weight:400">${esc(r.bestCard.card.card_name.slice(0, 22))}</div>` : ''}</td>
        <td class="num">${E.money(r.over5)}
          <div class="small muted" style="font-weight:400">${r.over5Count} cards</div></td>
        <td class="num muted">${r.cards}</td>
      </tr>`).join('');

    /* The whole row stays clickable for the mouse, but the actionable element
       is now a real <button> in the first cell — so it is reachable by Tab,
       activates on Enter/Space for free, and announces as a button with the
       set name rather than being an invisible click target on a <tr>. */
    const openSet = setId => {
      S.ripSet = setId; S.ripCard = null; S.ripSearch = '';
      const q = $('#rip-search'); if (q) q.value = '';
      switchTab('rip');
    };
    $$('#sets-tbl tbody .rowlink').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); openSet(b.dataset.set); }));
    $$('#sets-tbl tbody tr').forEach(tr =>
      tr.addEventListener('click', () => openSet(tr.dataset.set)));
  }

  /* ============================================================ SIGNALS == */

  /* Rank drives the default sort: actionable and confirmed first, noise last. */
  const TAG_RANK = { BUY: 5, TRIM: 4, HOLD: 3, WATCH: 2, AVOID: 1, STALE: -1 };

  function signalRows() {
    // Thresholds are relative to each price band, computed from the whole
    // catalogue rather than the filtered view — otherwise raising the price
    // filter would move the goalposts and re-label the same cards.
    const bands = E.spreadBands(S.cards);

    const min  = Number($('#sig-min').value) || 0;
    const q    = S.sigSearch.trim().toLowerCase();
    const slot = S.sigRarity || 'all';
    const colr = S.sigColor || 'all';
    const chaseKeys = ['SEC', 'ALT', 'SP', 'MANGA', 'ULTRA', 'TR'];

    // Which cards do I own, and which are earmarked to sell?
    const ownedAny = {}, ownedTrade = {};
    for (const it of C.live(S.items)) {
      ownedAny[it.key] = true;
      const col = S.cols.find(c => c.id === it.colId);
      if (col && col.kind === 'trade') ownedTrade[it.key] = true;
    }

    const out = [];
    for (const s of liveSets()) {
      // Pre-sorted by price descending, so the first entry below the floor
      // means every remaining entry is too.
      const entries = indexFor(s.id).all;
      for (const e of entries) {
        {
          if (e.price < min) break;

          if (q && !(e.card.card_name.toLowerCase().includes(q) ||
                     String(e.card.card_set_id || '').toLowerCase().includes(q))) continue;

          if (slot === 'chase') { if (chaseKeys.indexOf(e.slot) < 0) continue; }
          else if (slot !== 'all' && e.slot !== slot) continue;

          // Multicolour cards match every colour they contain.
          if (colr !== 'all' && !hasColor(e.card, colr)) continue;

          const sig = E.spreadSignal(e.card);
          if (!sig) continue;
          const age = E.staleness(e.card, null);

          // v2 has no price history: TCGCSV publishes today's build and
          // discards yesterday's. actionTag already treats a null history as
          // "unconfirmed" and degrades BUY to WATCH, which is the honest
          // reading when momentum cannot be checked at all.
          const hist = null;

          const tag = E.actionTag({
            band: E.bandFor(bands, e.card.market_price),
            sig, age, hist,
            owned: !!ownedAny[e.key],
            ownedTrade: !!ownedTrade[e.key]
          });

          out.push({
            entry: e, sig, setId: s.id, hist, tag,
            market: sig.market, inv: sig.inventory, mid: sig.mid,
            ratio: sig.ratio, score: sig.score, age,
            change: hist ? hist.changePct : null,
            rank: tag ? (TAG_RANK[tag.code] || 0) : 0
          });
        }
      }
    }
    return out;
  }


  function renderSignals() {
    fillSignalFilters();
    const tbody = $('#sig-tbl tbody');
    const stats = $('#sig-stats');

    const rows = signalRows();
    // v1 dropped rows whose price was over STALE_DAYS old. TCGplayer publishes
    // no per-card scrape time, so that check cannot run and every row would
    // count as fresh — reporting "0 too stale" would be a check pretending to
    // happen. The whole catalogue is one daily build, so freshness is uniform.
    const bargains = rows.filter(r => r.tag && r.tag.code === 'BUY');
    const noCheap  = rows.filter(r => r.tag && r.tag.label === 'NO CHEAP COPY');
    const spread = rows.filter(r => r.sig).length;

    stats.innerHTML =
      stat('Cards tracked', rows.length.toLocaleString(), 'priced in today’s build') +
      stat('Bargains', bargains.length.toLocaleString(),
           'cheapest decile for their price band', 'hero') +
      stat('No cheap copy', noCheap.length.toLocaleString(),
           'every listing above the sold average') +
      stat('Priced', spread.toLocaleString(), 'both market and listing available');

    // v2 reads supply only. The momentum half of the old model is gone with
    // the history feed, so every call rests on the listing-to-market spread
    // alone — which is why BUY now needs a wider gap to fire than it did when
    // a rising 13-day trend could corroborate it.
    $('#sig-legend').innerHTML =
      `<b>BARGAIN</b> listed in the cheapest 10% for its price range, and you do
         not own it ·
       <b>TRIM</b> in your trade binder and being undercut that hard ·
       <b>HOLD</b> you own it and nobody is undercutting you ·
       <b>NO CHEAP COPY</b> every listing sits above the sold average — hard to
         buy near market, which is <em>not</em> the same as a buy.
       Thresholds are per price band, measured from the live catalogue, because
       the listing-to-market ratio rises with price: at $500+ the median card
       already lists above market, so one fixed cut-off would just select
       expensive cards. TCGplayer publishes no price history, so nothing here
       says which way a price is moving — and a very cheap listing may simply
       be a damaged copy. Check before you buy.`;

    const { by, dir } = S.sort.sig;
    rows.sort((a, b) => {
      const av = a[by], bv = b[by];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;          // nulls last regardless of direction
      if (bv == null) return -1;
      return (av - bv) * dir;
    });

    tbody.innerHTML = rows.slice(0, 400).map(r => {
      const c = r.entry.card;
      const isStale = r.tag && r.tag.code === 'STALE';
      return `<tr class="clickable${isStale ? ' rowstale' : ''}"
                  data-key="${esc(r.entry.key)}" data-set="${esc(r.setId)}">
        <td><button type="button" class="rowlink" data-key="${esc(r.entry.key)}" data-set="${esc(r.setId)}">
          <span class="cardcell">
            <img src="${esc(c.card_image)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
            <span class="nm"><b>${esc(c.card_name)}</b><span>${esc(c.card_set_id)}</span></span>
          </span>
        </button></td>
        <td data-l="Set"><span class="tag">${esc(setShort(r.setId))}</span></td>
        <td class="num" data-l="Market">${E.money(r.market)}</td>
        <td class="num muted" data-l="Floor">${E.money(r.inv)}</td>
        <td class="num muted" data-l="Mid">${r.mid ? E.money(r.mid) : '—'}</td>
        <td class="num" data-l="Floor / market">${E.pct(r.ratio, 0)}</td>
        <td class="num" data-l="Supply">${isStale ? '<span class="badge-state st-NORMAL">—</span>'
                                  : `<span class="badge-state st-${r.sig.state}">${r.sig.state}</span>`}</td>
        <td class="num why" data-l="Call">${r.tag
          ? `<span class="call call-${r.tag.code}">${r.tag.label}</span>
             <span class="whytxt">${esc(r.tag.why)}</span>`
          : '<span class="muted">—</span>'}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="8" class="muted">Nothing matches those filters.</td></tr>`;

    const openCard = (setId, key) => {
      S.ripSet = setId; S.ripCard = key; S.ripSearch = '';
      const q = $('#rip-search'); if (q) q.value = '';
      switchTab('rip');
    };
    $$('#sig-tbl tbody .rowlink').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); openCard(b.dataset.set, b.dataset.key); }));
    $$('#sig-tbl tbody tr[data-key]').forEach(tr =>
      tr.addEventListener('click', () => openCard(tr.dataset.set, tr.dataset.key)));
  }

  /* =========================================================== SETTINGS == */

  /* ---- data source ------------------------------------------------------ */

  const DATA_URL_KEY = 'optcg.dataUrl';

  function renderDataSource() {
    const input = $('#data-url');
    if (!input) return;
    input.value = localStorage.getItem(DATA_URL_KEY) || '';

    const state = $('#src-state');
    if (!state) return;
    if (SRC.isMock()) {
      state.innerHTML = '<span class="tag est">local snapshot</span>';
      state.title = 'No Worker configured — reading the development snapshot in mockapi/, ' +
                    'which is not deployed. Set a Worker URL for live prices.';
    } else {
      state.innerHTML = '<span class="tag" style="color:var(--up);border-color:#2a6b4a">live</span>';
      state.title = SRC.base();
    }
  }

  async function testDataSource(url) {
    const msg = $('#data-msg');
    const clean = (url || '').trim().replace(/\/+$/, '');
    if (!clean) { msg.innerHTML = '<span class="down">Enter a URL first.</span>'; return false; }

    msg.textContent = 'Testing…';
    try {
      // /updated is the cheapest endpoint and proves three things at once: the
      // Worker is reachable, its CORS headers are right, and it can talk to
      // TCGCSV. A failure here is why the app would otherwise boot empty.
      const r = await fetch(clean + '/updated', { cache: 'no-store' });
      if (!r.ok) {
        msg.innerHTML = `<span class="down">Worker replied HTTP ${r.status}.</span> ` +
          (r.status === 403 ? 'Its ALLOWED_ORIGINS does not include this site.' :
           r.status === 404 ? 'URL reached something, but not this Worker.' : '');
        return false;
      }
      const stamp = (await r.text()).trim();
      msg.innerHTML = `<span class="up">Connected.</span> ` +
        `<span class="muted">TCGCSV last rebuilt ${esc(stamp)}.</span>`;
      return true;
    } catch (err) {
      // Nearly always CORS or a typo; "Failed to fetch" alone tells you neither.
      msg.innerHTML = `<span class="down">Could not reach it.</span> ` +
        `<span class="muted">${esc(String(err.message || err))} — check the URL is exactly ` +
        `what wrangler printed, and that the Worker is deployed.</span>`;
      return false;
    }
  }

  function renderSettings() {
    renderDataSource();

    // ---- box prices
    $('#box-editor').innerHTML = liveSets().map(s => {
      const est = boxIsEstimate(s.id);
      return `<label class="fld" style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <span style="flex:1;margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink-2)">
          <b style="color:var(--ink)">${esc(s.short)}</b> ${esc(s.name)}
          ${est ? '<span class="tag est">EST</span>' : ''}
        </span>
        <input type="number" class="box-in" data-set="${esc(s.id)}" min="0" step="1"
               value="${boxPrice(s.id)}" style="width:110px;text-align:right;
               ${est ? '' : 'border-color:var(--brass);color:var(--brass)'}">
        <input type="number" class="case-in" data-set="${esc(s.id)}" min="1" max="48" step="1"
               title="Boxes per sealed case. 12 is standard for OP boosters, but this is not published anywhere, so change it if a product differs."
               value="${boxesPerCase(s.id)}" style="width:62px;text-align:right;
               ${S.perCase[s.id] ? 'border-color:var(--brass);color:var(--brass)' : ''}">
      </label>`;
    }).join('');

    $$('.case-in').forEach(inp => inp.addEventListener('change', () => {
      const v = Math.round(Number(inp.value));
      // Out of range is a typo, not a real product. Put the field back rather
      // than storing a number that would silently distort the case verdict.
      if (!Number.isFinite(v) || v < 1 || v > 48) { renderSettings(); return; }
      if (v === DEFAULT_PER_CASE) delete S.perCase[inp.dataset.set];
      else S.perCase[inp.dataset.set] = v;
      save(KEY.perCase, S.perCase);
      renderSettings(); renderActive();
    }));

    $$('.box-in').forEach(inp => inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (isNaN(v) || v < 0) { renderSettings(); return; }
      S.boxes[inp.dataset.set] = v;
      save(KEY.boxes, S.boxes);
      renderSettings(); renderActive();
    }));

    // ---- pull rates
    const profSel = $('#pr-profile');
    if (!profSel.dataset.ready) {
      profSel.innerHTML =
        Object.keys(D.PROFILES).map(p =>
          `<option value="profile:${p}">${esc(D.PROFILES[p].label)} — all sets</option>`).join('') +
        `<option disabled>──────────</option>` +
        liveSets().map(s =>
          `<option value="set:${esc(s.id)}">${esc(s.short)} · ${esc(s.name)}${S.setRates[s.id] ? ' ✎' : ''}</option>`).join('');
      profSel.dataset.ready = '1';
      // Rebuilding the options resets the selection, which would bounce you
      // back to the profile every time you edited a per-set rate.
      if (S.rateScope) profSel.value = S.rateScope;
    }

    const scope   = profSel.value || 'profile:STANDARD';
    S.rateScope   = scope;
    const isSet   = scope.indexOf('set:') === 0;
    const scopeId = scope.slice(scope.indexOf(':') + 1);
    const prof    = isSet ? profileOf(scopeId) : scopeId;
    const base    = D.PROFILES[prof];

    // Editing a set shows its effective rates — profile defaults until you
    // change something, at which point only that set diverges.
    const eff    = isSet ? configFor(scopeId)
                         : Object.assign({}, base, S.rates[prof] || {},
                             { perBox: Object.assign({}, base.perBox, (S.rates[prof] || {}).perBox || {}) });
    const perBox = eff.perBox;
    const packs  = eff.packsPerBox;
    const setIdx = isSet ? indexFor(scopeId) : null;

    $('#rate-editor').innerHTML =
      `<label class="fld" style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="flex:1;margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink-2)">
          <b style="color:var(--ink)">Packs per box</b></span>
        <input type="number" id="pr-packs" min="1" step="1" value="${packs}" style="width:110px;text-align:right">
      </label>` +
      D.SLOTS.map(sl => {
        const inPool = setIdx && setIdx.slots[sl.key] ? setIdx.slots[sl.key].count : null;
        // When editing one set, show how many cards actually sit in each slot.
        // A rate for a slot this set does not have is just noise.
        const note = setIdx
          ? (inPool ? `<span class="small muted">${inPool} cards</span>`
                    : `<span class="small muted" style="opacity:.5">none in set</span>`)
          : '';
        return `
        <label class="fld" style="display:flex;align-items:center;gap:10px;margin-bottom:7px${
          setIdx && !inPool ? ';opacity:.4' : ''}">
          <span style="flex:1;margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink-2)">
            <span class="tag slot-${esc(sl.key)}">${esc(sl.label)}</span> ${note}</span>
          <input type="number" class="rate-in" data-slot="${esc(sl.key)}" min="0" step="0.01"
                 value="${perBox[sl.key] || 0}" style="width:110px;text-align:right">
        </label>`; }).join('');

    const total = D.SLOTS.reduce((s, sl) => s + (perBox[sl.key] || 0), 0);
    const should = packs * base.cardsPerPack;
    const off = Math.abs(total - should);
    $('#rate-sum').innerHTML =
      (isSet
        ? `Editing <b>${esc(setShort(scopeId))}</b> only.${eff.customised
             ? ' <span style="color:var(--brass)">Customised — no longer follows the profile.</span>'
             : ' Currently following the profile default; change any number to diverge.'}<br>`
        : `Editing every <b>${esc(base.label)}</b> set. Per-set overrides win over this.<br>`) +
      `Slots total <b class="mono">${total.toFixed(2)}</b> cards per box; the box physically holds
       <b class="mono">${should}</b>. ` +
      (off > 1
        ? `<span class="down">Off by ${off.toFixed(2)} — your EV will be skewed.</span>`
        : `<span class="up">Balanced.</span>`) +
      (isSet && eff.customised
        ? ` <button class="btn ghost small" id="pr-clear-set" style="margin-left:8px">Revert to profile</button>` : '');

    const commit = () => {
      const next = {};
      $$('.rate-in').forEach(i => { next[i.dataset.slot] = Math.max(0, parseFloat(i.value) || 0); });
      const packsPerBox = Math.max(1, parseInt($('#pr-packs').value, 10) || base.packsPerBox);
      if (isSet) {
        S.setRates[scopeId] = { perBox: next, packsPerBox };
        save(KEY.setRates, S.setRates);
        $('#pr-profile').dataset.ready = '';   // refresh the ✎ marker
      } else {
        S.rates[prof] = { perBox: next, packsPerBox };
        save(KEY.rates, S.rates);
      }
      invalidate();
      renderSettings(); renderActive();
    };
    $$('.rate-in').forEach(i => i.addEventListener('change', commit));
    $('#pr-packs').addEventListener('change', commit);
    const clr = $('#pr-clear-set');
    if (clr) clr.addEventListener('click', () => {
      delete S.setRates[scopeId];
      save(KEY.setRates, S.setRates);
      $('#pr-profile').dataset.ready = '';
      invalidate(); renderSettings(); renderActive();
    });

    // ---- data info
    $('#data-info').innerHTML =
      `<b>${S.cards.length.toLocaleString()}</b> cards across <b>${liveSets().length}</b> sets.<br>
       Last fetched: <b>${S.fetchedAt ? new Date(S.fetchedAt).toLocaleString() : 'never'}</b>.<br>
       Source: <a href="https://tcgcsv.com/" target="_blank" rel="noopener">tcgcsv.com</a> — TCGplayer English prices, rebuilt daily.`;

  }

  /* ========================================================== COLLECTION == */

  /**
   * First run gets the two binders that actually change the advice, and they
   * are permanent — the whole app splits on keep vs trade (the supply signal
   * scope, the trade rate, the "you already own this" check), so losing either
   * one would leave features with nowhere to point.
   */
  function ensureCollections() {
    const live = S.cols.filter(c => !c.deleted);
    let changed = false;

    if (!live.length) {
      // Fixed ids, not uid(): two devices creating these before their first
      // sync would otherwise mint four distinct binders and merge would keep
      // all of them. See C.PERMANENT_ID.
      S.cols.push(C.newPermanent('keep'));
      S.cols.push(C.newPermanent('trade'));
      changed = true;
    } else {
      // Migration for binders created before locking existed: the oldest of
      // each kind becomes the permanent one.
      for (const kind of ['keep', 'trade']) {
        const ofKind = live.filter(c => c.kind === kind);
        if (!ofKind.length) {
          S.cols.push(C.newPermanent(kind));
          changed = true;
        } else if (!ofKind.some(c => c.locked)) {
          ofKind.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          ofKind[0].locked = 1;
          ofKind[0].updatedAt = Date.now();
          changed = true;
        }
      }
    }
    if (changed) saveCritical(KEY.cols, S.cols);
  }

  /* Merge duplicate permanent binders, then persist.

     Has to run after a PULL as well as at boot: the duplicates arrive from the
     sheet, so a boot-only fix would clean this device and then re-import the
     mess on the next sync. Merged rows are stamped so the collapse propagates
     to every other device instead of each one fixing itself locally. */
  function collapsePermanent(reason) {
    const res = C.dedupePermanent(S.cols, S.items);
    if (!res.mergedBinders) return 0;
    S.cols = res.cols;
    S.items = res.items;
    saveCritical(KEY.cols, S.cols);
    saveCritical(KEY.items, S.items);
    console.info('[optcg] merged duplicate permanent binders', {
      reason, binders: res.mergedBinders, itemsMoved: res.movedItems });
    S.binderMerge = { at: Date.now(), binders: res.mergedBinders, items: res.movedItems };
    return res.mergedBinders;
  }

  const liveCols = () => S.cols.filter(c => !c.deleted);
  const itemsIn  = id => C.live(S.items).filter(it => it.colId === id);

  function currentCol() {
    const cols = liveCols();
    if (!cols.length) return null;
    let c = cols.find(x => x.id === S.curCol);
    if (!c) { c = cols[0]; S.curCol = c.id; }
    return c;
  }

  /* The v1 -> v2 key migration, reported rather than assumed.

     A migration that silently half-worked is the worst outcome here, because
     an unmatched row still displays — it just shows no price and no art, and
     you would have to notice that yourself. So: say what happened, name the
     rows that need a human, and stay on screen until dismissed. */
  function renderMigrationReport() {
    const host = $('#mig-report');
    if (!host) return;

    const r = S.migrationReport || load('optcg.migrationReport', null);
    if (!r || (S.migrationDismissed)) { host.innerHTML = ''; return; }

    const stuck = (r.unmatched || 0) + (r.ambiguous || 0);
    if (!r.migrated && !stuck) { host.innerHTML = ''; return; }

    host.innerHTML = `
      <div class="note ${stuck ? 'warn' : ''} small" style="margin-bottom:14px">
        <b>Collection updated for v2.</b>
        ${r.migrated ? `${r.migrated} row${r.migrated === 1 ? '' : 's'} repointed to the new
          card ids and queued for the next Sheets push.` : ''}
        ${stuck ? `<br><b>${stuck} row${stuck === 1 ? '' : 's'} could not be matched</b> and
          ${stuck === 1 ? 'was' : 'were'} left exactly as ${stuck === 1 ? 'it was' : 'they were'} —
          nothing was deleted. ${r.ambiguous ? `${r.ambiguous} matched more than one card. ` : ''}
          Re-add ${stuck === 1 ? 'it' : 'them'} by hand and delete the old row.
          ${r.examples && r.examples.length
            ? `<br><span class="mono muted" style="font-size:11px">${
                 r.examples.map(esc).join('<br>')}</span>` : ''}`
          : ' Everything matched.'}
        <br><button class="btn ghost small" id="mig-dismiss" style="margin-top:8px">Dismiss</button>
      </div>`;

    const btn = $('#mig-dismiss');
    if (btn) btn.addEventListener('click', () => {
      S.migrationDismissed = true;
      try { localStorage.removeItem('optcg.migrationReport'); } catch (_) {}
      renderMigrationReport();
    });
  }

  /* Cards stranded on a deleted binder.

     Excluding them from the totals is correct but not sufficient — silently
     dropping value the user entered is its own bug. Surfaced with a one-click
     move into Keeping so they can be recovered rather than merely hidden. */
  function renderStranded(rows) {
    const host = $('#stranded-report');
    if (!host) return;
    if (!rows || !rows.length) { host.innerHTML = ''; return; }

    host.innerHTML = `
      <div class="note warn small" style="margin-bottom:14px">
        <b>${rows.length === 1 ? 'A card' : rows.length + ' cards'} lost
        ${rows.length === 1 ? 'its' : 'their'} binder.</b>
        This happens when one device deletes a binder while another adds to it.
        They are not counted in the totals below, because they are not in any
        binder — but nothing has been deleted.
        <br><button class="btn small" id="stranded-fix" style="margin-top:8px">
          Move ${rows.length === 1 ? 'it' : 'them'} to Keeping</button>
      </div>`;

    const btn = $('#stranded-fix');
    if (btn) btn.addEventListener('click', () => {
      const keep = liveCols().find(c => c.kind === 'keep');
      if (!keep) return;
      for (const it of rows) { it.colId = keep.id; it.updatedAt = Date.now(); }
      persistCollection();
      renderCollection();
    });
  }

  function renderCollection() {
    ensureCollections();
    const col = currentCol();
    renderBinders();
    renderSyncPanel();
    renderMigrationReport();

    // ---- headline numbers across every binder
    // Only cards in a binder that still exists. A sync race can strand rows on
    // a deleted binder: invisible in every binder, yet still inflating the
    // headline total, so the number disagreed with everything you could see.
    const placed = C.livePlaced(S.items, S.cols);
    renderStranded(C.orphans(S.items, S.cols));
    const all = C.valueOf(placed, priceForKey);
    const keepIds  = liveCols().filter(c => c.kind === 'keep').map(c => c.id);
    const tradeIds = liveCols().filter(c => c.kind === 'trade').map(c => c.id);
    const keep  = C.valueOf(placed.filter(i => keepIds.indexOf(i.colId) > -1), priceForKey);
    const trade = C.valueOf(placed.filter(i => tradeIds.indexOf(i.colId) > -1), priceForKey);

    // Trade stock valued at what a vendor would actually give for it. Each
    // binder carries its own rate because not every buyer offers the same.
    let tradeAtRate = 0;
    for (const c of liveCols()) {
      if (c.kind !== 'trade') continue;
      tradeAtRate += C.valueOf(itemsIn(c.id), priceForKey).total * (C.rateOf(c) / 100);
    }
    const blendedRate = trade.total > 0 ? Math.round(tradeAtRate / trade.total * 100) : null;

    $('#col-stats').innerHTML =
      stat('Total value', E.money(all.total), `${all.cards.toLocaleString()} cards at market`, 'hero') +
      stat('Keeping', E.money(keep.total), `${keep.cards.toLocaleString()} cards`) +
      stat('Trade / Sell', E.money(tradeAtRate),
           trade.total > 0
             ? `${E.money(trade.total)} market · at ${blendedRate}%`
             : `${trade.cards.toLocaleString()} cards`) +
      stat('Spent', all.cost > 0 ? E.money(all.cost) : '—',
           all.cost > 0
             ? `${all.gain >= 0 ? 'up' : 'down'} ${E.money(Math.abs(all.gain))}` +
               `${all.gainPct != null ? ' (' + E.pct(all.gainPct, 0) + ')' : ''}` +
               `${all.costComplete ? '' : ` · on ${all.costedCards} of ${all.cards} cards`}`
             : 'add what you paid to track this');

    renderAddGrid();
    renderScoreboard();
    renderColTable(col);
  }

  /* Show the live box price as the cost placeholder for the selected set. */
  function syncOpenCostHint() {
    const sel = $('#op-set'), cost = $('#op-cost');
    if (!sel || !cost) return;
    const boxes = Math.max(1, parseInt(($('#op-boxes') || {}).value, 10) || 1);
    const live = sealedPrice(sel.value, 'box');
    cost.placeholder = live ? Math.round(live * boxes) : '150';
    const hint = $('#op-cost-hint');
    if (hint) {
      hint.textContent = live
        ? `market is ${E.money(live)}/box` + (boxes > 1 ? ` · ${E.money(live * boxes)} for ${boxes}` : '')
        : 'no live box price for this set';
    }
  }

  /* ---- rip scoreboard ---------------------------------------------------- */
  function renderScoreboard() {
    const sel = $('#op-set');
    if (sel && sel.dataset.filled !== '1') {
      sel.innerHTML = liveSets().map(s =>
        `<option value="${esc(s.id)}">${esc(s.short)} · ${esc(s.name)}</option>`).join('');
      sel.dataset.filled = '1';
      // Prefill the cost from the live box price so logging an opening is two
      // fields instead of three. Only ever a PLACEHOLDER, never a value: what
      // you actually paid is the whole point of this number, and quietly
      // filling in market price would turn the scoreboard into a comparison
      // of market against itself.
      sel.addEventListener('change', syncOpenCostHint);
    }
    syncOpenCostHint();

    const sb = C.scoreboard(S.opens, S.items, priceForKey, setShort,
                            id => !!D.SETS.find(s => s.id === id),
                            key => (S.byKey[key] || {}).set_id || '');
    const body = $('#score-body');
    if (!body) return;

    if (!sb.rows.length) {
      $('#score-sub').textContent = '';
      body.innerHTML = `<div class="small muted">
        Log a box you opened and mark its pulls, and this will tell you whether ripping has
        actually beaten buying singles — using what you really paid, not a model.</div>`;
      return;
    }

    const t = sb.total;
    $('#score-sub').innerHTML = `${t.boxes} boxes · ${E.money(t.spent)} spent`;

    // Spent money but logged nothing yet is unfinished bookkeeping, not a 100%
    // loss. Showing −100% here would be technically true and completely wrong.
    const pending = t.spent > 0 && t.pulledCards === 0;

    body.innerHTML = `
      <div class="grid g-4" style="gap:10px;margin-bottom:14px">
        ${stat('Spent on sealed', E.money(t.spent), `${t.boxes} boxes`)}
        ${stat('Pulled', pending ? '—' : E.money(t.pulledValue),
               pending ? 'nothing logged yet' : `${t.pulledCards} cards logged`)}
        ${pending
          ? stat('Net', '—', 'log your pulls to see this', 'hero')
          : stat('Net', (t.net >= 0 ? '+' : '−') + E.money(Math.abs(t.net)),
                 t.ret != null ? (t.ret >= 0 ? '+' : '') + E.pct(t.ret, 0) + ' return' : '', 'hero')}
        ${stat('Per box', (pending || !t.boxes) ? '—' : E.money(t.pulledValue / t.boxes), 'average pulled')}
      </div>
      <div class="tbl-scroll" style="max-height:260px">
        <table class="tbl"><thead><tr>
          <th>Set</th><th class="num">Boxes</th><th class="num">Spent</th>
          <th class="num">Pulled</th><th class="num">Net</th><th></th>
        </tr></thead><tbody>
        ${sb.rows.map(r => `<tr>
          <td><b>${esc(r.name)}</b></td>
          <td class="num">${r.boxes || '—'}</td>
          <td class="num">${E.money(r.spent)}</td>
          <td class="num">${E.money(r.pulledValue)}</td>
          <td class="num ${r.incomplete ? 'muted' : r.net >= 0 ? 'up' : 'down'}">
            <b>${r.incomplete ? '—' : (r.net >= 0 ? '+' : '−') + E.money(Math.abs(r.net))}</b></td>
          <td class="num small muted">${r.incomplete ? 'no pulls logged yet' : ''}</td>
        </tr>`).join('')}
        </tbody></table>
      </div>
      <div class="small muted" style="margin-top:10px">
        Only cards marked <b>pulled</b> count as winnings — singles you bought are not luck.
        Set a row to <b>bought</b> in the Cards table below to exclude it.
      </div>`;
  }

  function renderBinders() {
    const cols = liveCols();
    const cur = currentCol();

    $('#col-list').innerHTML = cols.map(c => {
      const v = C.valueOf(itemsIn(c.id), priceForKey);
      const rate = C.rateOf(c);
      const isTrade = c.kind === 'trade';
      return `<button class="binder" data-col="${esc(c.id)}" aria-selected="${c.id === S.curCol}">
        <span class="bn"><b>${esc(c.name)}${c.locked
            ? '<span class="lockicon" title="Permanent binder">🔒</span>' : ''}</b>
          <span>${(D.COLLECTION_KINDS[c.kind] || {}).label || c.kind} · ${v.cards} cards${
            isTrade && rate !== 100 ? ` · ${rate}% of market` : ''}</span></span>
        <span class="bv">${E.money(isTrade ? v.total * rate / 100 : v.total)}${
          isTrade && rate !== 100
            ? `<span class="small muted" style="display:block;font-weight:400">${E.money(v.total)} mkt</span>` : ''}</span>
      </button>`;
    }).join('')
    + (cur && cur.kind === 'trade' ? `
      <label class="fld" style="margin:12px 0 4px">
        <span>What this buyer pays, as % of market</span>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="range" id="trade-pct" min="10" max="100" step="5" value="${C.rateOf(cur)}">
          <b class="mono" id="trade-pct-v" style="min-width:44px;text-align:right">${C.rateOf(cur)}%</b>
        </div>
      </label>
      <div class="small muted" style="margin-bottom:8px">
        Vendors and traders rarely go 1:1. Set this per binder — a shop offering 60%
        and a friend trading at 90% can be separate binders.
      </div>` : '')
    + (cur && cur.locked
        ? `<div class="small muted" style="margin-top:8px;display:flex;gap:6px;align-items:center">
             <span style="opacity:.7">🔒</span>
             <span>This binder is permanent — keep and trade split drives the trade rate,
                   the supply signal scope and the "you already own this" check.</span>
           </div>`
        : cols.length > 1
          ? `<button class="btn ghost small" id="col-del" style="width:100%;margin-top:6px">Delete this binder</button>`
          : '');

    const pct = $('#trade-pct'), pctV = $('#trade-pct-v');
    if (pct) {
      // Live label while dragging, commit on release — otherwise every step
      // would rewrite the binder and schedule a sheet push.
      pct.addEventListener('input', () => { pctV.textContent = pct.value + '%'; });
      pct.addEventListener('change', () => {
        const c = currentCol();
        if (!c) return;
        c.tradePct = parseInt(pct.value, 10);
        c.updatedAt = Date.now();
        persistCollection();
        renderCollection();
      });
    }

    $$('#col-list .binder').forEach(b => b.addEventListener('click', () => {
      S.curCol = b.dataset.col; renderCollection();
    }));
    const del = $('#col-del');
    if (del) del.addEventListener('click', () => {
      const col = currentCol();
      // Belt and braces: the button is not rendered for locked binders, but a
      // delete path should never rely on the UI having hidden it.
      if (!col || col.locked) return;
      const n = itemsIn(col.id).length;
      if (!confirm(`Delete "${col.name}"${n ? ' and its ' + n + ' cards' : ''}?`)) return;
      col.deleted = 1; col.updatedAt = Date.now();
      for (const it of itemsIn(col.id)) { it.deleted = 1; it.updatedAt = Date.now(); }
      S.curCol = null;
      persistCollection();
      renderCollection();
    });
  }

  /* ---- tap-to-add grid --------------------------------------------------- */
  function renderAddGrid() {
    // Collections include everything you can own, not just what you can pull.
    const sets = browseSets();
    if (!S.addSet || !sets.some(s => s.id === S.addSet)) {
      const boosters = liveSets();
      S.addSet = boosters.length ? defaultSetId(boosters) : (sets[0] && sets[0].id);
    }

    const sel = $('#add-set');
    if (sel.dataset.filled !== '1' || sel.value !== S.addSet) {
      const group = (label, list) => list.length
        ? `<optgroup label="${esc(label)}">` + list.map(s =>
            `<option value="${esc(s.id)}"${s.id === S.addSet ? ' selected' : ''}>${esc(s.short)} · ${esc(s.name)}</option>`
          ).join('') + '</optgroup>' : '';
      sel.innerHTML =
        group('Booster sets', sets.filter(s => s.kind === 'booster')) +
        group('Promos & event cards', sets.filter(s => s.kind === 'promo')) +
        group('Starter decks', sets.filter(s => s.kind === 'deck'));
      sel.dataset.filled = '1';
    }

    const col = currentCol();
    $('#add-target').textContent = col ? 'adding to ' + col.name : '';

    const min = Number($('#add-min').value) || 0;
    const q = S.addSearch.trim().toLowerCase();

    // Search spans every product; browsing shows the chosen one. A promo you
    // are hunting for is rarely filed where you would guess.
    let pool = q
      ? browseSets().reduce((acc, s) => acc.concat(browsePool(s.id)), [])
      : browsePool(S.addSet);
    pool = pool.filter(e => e.price >= min);
    if (q) pool = pool.filter(e =>
      e.card.card_name.toLowerCase().includes(q) || e.card.card_set_id.toLowerCase().includes(q));
    pool.sort((a, b) => b.price - a.price);
    if (q) {
      // A cross-product search can return thousands; the grid is a picker,
      // not a catalogue.
      pool = pool.slice(0, 200);
    }

    // In THIS binder = tap removes. In another binder = worth knowing, but the
    // tap still adds here. Conflating the two made the toggle unpredictable.
    const here = {}, elsewhere = {};
    for (const it of C.live(S.items)) {
      if (it.colId === (col && col.id)) here[it.key] = (here[it.key] || 0) + (Number(it.qty) || 0);
      else elsewhere[it.key] = true;
    }

    $('#add-grid').innerHTML = pool.slice(0, 120).map(e => {
      const n = here[e.key] || 0;
      const cls = n ? ' owned' : (elsewhere[e.key] ? ' elsewhere' : '');
      return `
      <div class="pick${cls}" data-key="${esc(e.key)}"
           title="${esc(e.card.card_name)}${n ? ' — in this binder, tap to remove' : elsewhere[e.key] ? ' — in another binder' : ''}">
        ${cardArt(e.card)}
        ${n > 1 ? `<span class="qtybadge">${n}</span>` : ''}
        <div class="pmeta"><span class="pp${e.unpriced ? ' nopx' : ''}">${
          e.unpriced ? 'no price' : E.money(e.price)}</span>${rarityChip(e.card)}</div>
        <div class="pn">${esc(e.card.card_set_id)}</div>
      </div>`; }).join('') || `<div class="small muted">Nothing at that filter.</div>`;

    $$('#add-grid .pick').forEach(el => el.addEventListener('click', () => toggleCard(el.dataset.key)));
    fitGridRows('#add-grid', 3);
  }

  /**
   * Toggle, not increment. Tapping a card adds it once; tapping again removes
   * it. Quantity is edited in the table, deliberately — a mis-aimed tap on a
   * grid of 120 images should never silently inflate a count you cannot see.
   *
   * Only ever touches the plain raw row. A graded or condition-flagged copy of
   * the same card is a separate record and is left alone.
   */
  function toggleCard(key) {
    const col = currentCol();
    if (!col) return;
    const hit = C.live(S.items).find(it =>
      it.colId === col.id && it.key === key && !it.grader && it.cond === 'NM');

    if (hit) { hit.deleted = 1; hit.updatedAt = Date.now(); }
    else {
      // Promos, starter decks and event cards cannot be pulled from a pack, so
      // they must not default to "pulled" — that would credit a $3,499
      // Regionals card you bought as ripping profit in the scoreboard.
      S.items.push(C.newItem(col.id, key, { src: isPullable(key) ? 'pull' : 'buy' }));
    }

    persistCollection();
    renderCollection();
  }

  /* ---- the binder table -------------------------------------------------- */
  function renderColTable(col) {
    const tbody = $('#col-tbl tbody');
    if (!col) { tbody.innerHTML = ''; return; }

    const rows = itemsIn(col.id).slice().sort((a, b) => {
      const pa = priceForKey(a.key) || 0, pb = priceForKey(b.key) || 0;
      return (pb * (b.qty || 0)) - (pa * (a.qty || 0));
    });
    const v = C.valueOf(itemsIn(col.id), priceForKey);

    // Binders this card could move to. Deciding to sell something you kept is
    // routine, and the delete-and-re-add workaround destroyed seven fields —
    // including cost basis and the pulled/bought flag, which would have
    // recounted a bought card as a pull and inflated the rip scoreboard.
    const others = liveCols().filter(c => c.id !== col.id);

    const rate = C.rateOf(col);
    const traded = col.kind === 'trade' && rate !== 100;

    $('#col-title').textContent = col.name;
    $('#col-sub').innerHTML =
      `${v.cards} cards · ${traded ? '' : '<b>'}${E.money(v.total)}${traded ? ' market' : '</b>'}` +
      (traded ? ` · <b style="color:var(--brass)">${E.money(v.total * rate / 100)} at ${rate}%</b>` : '') +
      (v.unpriced ? ` · <span class="muted">${v.unpriced} unpriced</span>` : '');

    tbody.innerHTML = rows.map(it => {
      const card = S.byKey[it.key];
      const graded = C.isGraded(it);
      const manual = it.value != null && it.value !== '';
      // Graded copies have no feed, so they show an input until you value them.
      const each = manual ? Number(it.value) : (graded ? null : priceForKey(it.key));
      const qty = Number(it.qty) || 0;
      return `<tr data-id="${esc(it.id)}">
        <td><div class="cardcell">
          <img src="${esc(card ? card.card_image : '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
          <div class="nm"><b>${esc(card ? card.card_name : it.key)}</b>
            <span>${esc(card ? card.card_set_id : '')}</span></div>
        </div></td>
        <td data-l="Set"><span class="tag">${esc(card ? setShort(card.set_id) : '—')}</span></td>
        <td data-l="State">
          <select class="it-grader" data-id="${esc(it.id)}" style="width:auto;display:inline-block;padding:4px 6px;font-size:12px">
            <option value="">Raw</option>
            ${D.GRADERS.map(g => `<option value="${g}"${it.grader === g ? ' selected' : ''}>${g}</option>`).join('')}
          </select>
          ${graded
            ? `<select class="it-grade" data-id="${esc(it.id)}" style="width:auto;display:inline-block;padding:4px 6px;font-size:12px">
                 ${[10,9.5,9,8.5,8,7,6,5,4,3,2,1].map(g =>
                   `<option value="${g}"${String(it.grade) === String(g) ? ' selected' : ''}>${g}</option>`).join('')}
               </select>`
            : `<select class="it-cond" data-id="${esc(it.id)}" style="width:auto;display:inline-block;padding:4px 6px;font-size:12px">
                 ${D.CONDITIONS.map(c => `<option value="${c.code}"${it.cond === c.code ? ' selected' : ''}>${c.code}</option>`).join('')}
               </select>`}
        </td>
        <td class="num" data-l="Qty"><input type="number" class="it-qty" data-id="${esc(it.id)}" min="0" step="1"
             value="${qty}" style="width:62px;text-align:right;padding:4px 6px;font-size:12px"></td>
        <td class="num" data-l="Each">${graded || manual
            ? `<input type="number" class="it-value" data-id="${esc(it.id)}" min="0" step="0.01"
                 placeholder="${graded ? 'graded $' : 'market'}" value="${manual ? it.value : ''}"
                 style="width:88px;text-align:right;padding:4px 6px;font-size:12px"
                 title="${graded ? 'No free feed for graded prices — enter what it is worth' : 'Overrides the live market price'}">`
            : E.money(each)}</td>
        <td class="num" data-l="Paid ea."><input type="number" class="it-paid" data-id="${esc(it.id)}" min="0" step="0.01"
             placeholder="—" value="${it.paid == null ? '' : it.paid}"
             style="width:80px;text-align:right;padding:4px 6px;font-size:12px"
             title="What you paid, per copy"></td>
        <td class="num" data-l="Value"><b>${each == null ? '—' : E.money(each * qty)}</b></td>
        <td class="num acts" data-l="">
          <select class="it-src" data-id="${esc(it.id)}" title="Pulled cards count as winnings in the scoreboard"
                  style="width:auto;display:inline-block;padding:4px 6px;font-size:12px">
            <option value="pull"${it.src !== 'buy' ? ' selected' : ''}>pulled</option>
            <option value="buy"${it.src === 'buy' ? ' selected' : ''}>bought</option>
          </select>
          ${others.length ? `
          <select class="it-move" data-id="${esc(it.id)}" title="Move to another binder, keeping everything"
                  style="width:auto;display:inline-block;padding:4px 6px;font-size:12px">
            <option value="">move…</option>
            ${others.map(o => `<option value="${esc(o.id)}">→ ${esc(o.name)}</option>`).join('')}
          </select>` : ''}
          <button class="btn ghost small it-del" data-id="${esc(it.id)}">×</button></td>
      </tr>`;
    }).join('') || `<tr><td colspan="8" class="muted">
        No cards yet — tap one from the grid above.</td></tr>`;

    const find = id => S.items.find(x => x.id === id);
    const touch = it => { it.updatedAt = Date.now(); persistCollection(); renderCollection(); };

    /**
     * Bound what a number field will accept.
     *
     * Unbounded inputs let a held keypress turn a binder into $1.1bn, and a
     * negative cost basis makes the scoreboard's return meaningless. Values
     * are clamped rather than rejected so the edit is never silently lost.
     */
    const clamp = (raw, max) => {
      const n = parseFloat(raw);
      if (isNaN(n)) return null;
      return Math.min(Math.max(n, 0), max);
    };
    const MAX_QTY = 9999, MAX_MONEY = 1000000;

    $$('.it-qty').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      const n = clamp(el.value, MAX_QTY);
      if (n === null) { renderCollection(); return; }
      if (n === 0) { it.deleted = 1; } else { it.qty = Math.round(n); }
      touch(it);
    }));
    $$('.it-cond').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.cond = el.value; touch(it);
    }));
    $$('.it-grader').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.grader = el.value;
      // Graded copies have no market feed, so a fresh grade starts unpriced
      // and waits for you to enter what it is worth.
      it.grade = el.value ? (it.grade || 10) : '';
      touch(it);
    }));
    $$('.it-grade').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.grade = el.value; touch(it);
    }));
    $$('.it-paid').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.paid = clamp(el.value, MAX_MONEY); touch(it);
    }));
    $$('.it-value').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.value = clamp(el.value, MAX_MONEY); touch(it);
    }));
    $$('.it-src').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.src = el.value; touch(it);
    }));
    $$('.it-move').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id);
      const dest = el.value;
      if (!it || !dest) return;

      // If the destination already holds this exact card in the same state,
      // fold the quantities together instead of leaving two identical rows.
      const twin = C.live(S.items).find(x =>
        x.id !== it.id && x.colId === dest && x.key === it.key &&
        x.cond === it.cond && x.grader === it.grader &&
        String(x.grade) === String(it.grade) && x.src === it.src);

      if (twin) {
        twin.qty = (Number(twin.qty) || 0) + (Number(it.qty) || 0);
        // Keep a cost basis if only one side had one; sum when both do.
        if (it.paid != null) twin.paid = (twin.paid != null) ? twin.paid : it.paid;
        twin.updatedAt = Date.now();
        it.deleted = 1;
        it.updatedAt = Date.now();
      } else {
        it.colId = dest;
        it.updatedAt = Date.now();
      }
      persistCollection();
      renderCollection();
    }));
    $$('.it-del').forEach(el => el.addEventListener('click', () => {
      const it = find(el.dataset.id); if (!it) return;
      it.deleted = 1; touch(it);
    }));
  }

  /* ---- persistence + sync ------------------------------------------------ */
  function persistCollection() {
    saveCritical(KEY.cols, S.cols);
    saveCritical(KEY.items, S.items);
    saveCritical(KEY.opens, S.opens);
    schedulePush();
  }

  function setSync(state, msg) {
    S.syncState = state; S.syncMsg = msg || '';
    const chip = $('#sync-chip');
    if (chip) chip.innerHTML =
      `<span class="sync-dot ${state === 'ok' ? 'on' : state === 'busy' ? 'busy' : state === 'err' ? 'err' : ''}"></span>
       <span>${esc(msg || (state === 'off' ? 'Sheets off' : state))}</span>`;
    const p = $('#sync-state');
    if (p) p.textContent = msg || state;
  }

  function schedulePush() {
    if (!S.syncUrl) return;
    clearTimeout(S.pushTimer);
    // Debounced: typing a quantity should not fire a write per keystroke.
    S.pushTimer = setTimeout(pushNow, 2500);
  }

  /**
   * Push only what changed.
   *
   * This used to send the ENTIRE collection on every debounced save, and the
   * Apps Script rewrote every row it already had. Editing one quantity in a
   * 200-card binder meant 200 sheet writes. Rows are now filtered to those
   * touched since the last confirmed push.
   */
  async function pushNow(force) {
    if (!S.syncUrl) return;

    // The manual "Save now" button forces a full resend — otherwise clicking it
    // when nothing is dirty would report "up to date" and look broken.
    const since = force ? 0 : (S.lastPushAt || 0);
    const dirty = rs => rs.filter(r => (r.updatedAt || 0) > since);
    const payload = {
      collections: dirty(S.cols),
      items: dirty(S.items),
      opens: dirty(S.opens)
    };
    const count = payload.collections.length + payload.items.length + payload.opens.length;
    if (!count) { setSync('ok', 'up to date'); return; }

    setSync('busy', `saving ${count}…`);
    // Stamped before the request: anything edited mid-flight keeps a newer
    // updatedAt and is caught by the next push rather than being skipped.
    const stamp = Date.now();
    try {
      await C.push(S.syncUrl, payload);
      S.lastPushAt = stamp;
      save(KEY.lastPush, stamp);
      setSync('ok', 'saved');
    } catch (err) {
      setSync('err', err.message);
    }
  }

  /**
   * Drop tombstones nobody needs any more.
   *
   * Deleted rows must linger or they resurrect from a device that has not
   * synced yet — but "not synced in three months" is not a scenario worth
   * carrying forever, and without this every deletion is permanent payload.
   */
  function compactTombstones() {
    const cutoff = Date.now() - 90 * 86400000;
    const keep = r => !r.deleted || (r.updatedAt || 0) > cutoff;
    const before = S.items.length + S.cols.length + S.opens.length;
    S.items = S.items.filter(keep);
    S.cols  = S.cols.filter(keep);
    S.opens = S.opens.filter(keep);
    const after = S.items.length + S.cols.length + S.opens.length;
    if (after !== before) {
      save(KEY.items, S.items); save(KEY.cols, S.cols); save(KEY.opens, S.opens);
    }
  }

  async function pullNow(silent) {
    if (!S.syncUrl) return;
    setSync('busy', 'loading…');
    try {
      const remote = await C.pull(S.syncUrl);
      S.cols  = C.mergeRows(S.cols, remote.collections);
      S.items = C.mergeRows(S.items, remote.items);
      S.opens = C.mergeRows(S.opens, remote.opens);
      save(KEY.cols, S.cols); save(KEY.items, S.items); save(KEY.opens, S.opens);
      // The sheet is where duplicates come from, so collapse after every pull.
      ensureCollections();
      collapsePermanent('pull');
      setSync('ok', 'synced');
      if (!silent) renderCollection();
      else if (S.tab === 'collection') renderCollection();
    } catch (err) {
      setSync('err', err.message);
    }
  }

  function renderSyncPanel() {
    const body = $('#sync-panel');
    if (!body) return;
    body.innerHTML = `
      <div class="note small" style="margin-bottom:12px">
        Your collection saves to a Google Sheet you own, so it survives a cleared browser
        and follows you across devices. The repo is public, so the script URL is
        <b>not baked into the code</b> — paste it once per browser. Treat it like a
        password: anyone with the URL can read and write your sheet.
      </div>
      <label class="fld"><span>Apps Script /exec URL</span>
        <input type="text" id="sync-url" placeholder="https://script.google.com/macros/s/…/exec"
               value="${esc(S.syncUrl)}"></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <button class="btn primary" id="sync-save">Connect</button>
        <button class="btn" id="sync-test">Test connection</button>
        <button class="btn" id="sync-pull"${S.syncUrl ? '' : ' disabled'}>Load from Sheet</button>
        <button class="btn" id="sync-push"${S.syncUrl ? '' : ' disabled'}>Save now</button>
      </div>
      <div class="small muted" id="sync-state">${esc(S.syncMsg || S.syncState)}</div>
      <div id="sync-diag" style="margin-top:10px"></div>
      <details class="adv" style="margin-top:12px">
        <summary>How to set the sheet up</summary>
        <div class="small muted" style="line-height:1.65;padding:4px 2px">
          1. New Google Sheet, leave it empty.<br>
          2. Extensions → Apps Script, paste in <code>apps-script.js</code> from this project, save.<br>
          3. Deploy → New deployment → Web app. Execute as <b>Me</b>, access <b>Anyone</b>.<br>
          4. Copy the <code>/exec</code> URL and paste it above.<br><br>
          "Anyone" is safe only because the URL is unguessable — treat it like a password.
          If it ever leaks, redeploy for a fresh one.
        </div>
      </details>`;

    $('#sync-save').addEventListener('click', async () => {
      const url = $('#sync-url').value.trim();
      if (url && !C.validUrl(url)) { setSync('err', 'Not a script.google.com URL'); return; }
      S.syncUrl = url; save(KEY.sync, url);
      if (!url) { setSync('off', 'Sheets off'); return; }
      // Pull first so connecting a populated sheet never clobbers it with an
      // empty local copy — merge is per row, so both sides survive.
      await pullNow(false);
      await pushNow(true);
      renderCollection();
    });
    $('#sync-pull').addEventListener('click', () => pullNow(false));
    $('#sync-push').addEventListener('click', () => pushNow(true));

    $('#sync-test').addEventListener('click', async () => {
      const btn = $('#sync-test'), out = $('#sync-diag');
      const url = ($('#sync-url').value || '').trim();
      btn.disabled = true; btn.textContent = 'Testing…';
      out.innerHTML = `<div class="small muted">Checking…</div>`;
      const d = await C.diagnose(url);
      btn.disabled = false; btn.textContent = 'Test connection';
      out.innerHTML = `
        <div class="note ${d.ok ? '' : 'warn'} small">
          <strong>${d.ok ? '✓ ' : '✕ '}${esc(d.msg)}</strong>
          ${d.fix ? `<div style="margin-top:6px">${esc(d.fix)}</div>` : ''}
          <div class="muted" style="margin-top:6px;font-family:var(--mono);font-size:11px">
            code: ${esc(d.code)}</div>
        </div>`;
    });
  }

  /* ========================================================= COLLAPSING ==
     A phone shows roughly one panel per screen, so a tab with six panels is
     six screens of scrolling to reach anything. Panels marked data-collapse
     get a tappable header and remember their state.

       data-collapse="key"             collapsible, state saved under key
       data-collapse-mobile           starts closed on a narrow screen only
       data-collapse-default-closed   starts closed everywhere
     ====================================================================== */

  const MOBILE = () => window.matchMedia('(max-width: 760px)').matches;

  function wireCollapsibles() {
    const state = load(KEY.collapse, {});

    $$('[data-collapse]').forEach(panel => {
      const key = panel.getAttribute('data-collapse');
      if (panel.dataset.collapseWired) return;
      panel.dataset.collapseWired = '1';

      let closed;
      if (Object.prototype.hasOwnProperty.call(state, key)) {
        closed = !!state[key];                       // your choice always wins
      } else {
        closed = panel.hasAttribute('data-collapse-default-closed') ||
                 (panel.hasAttribute('data-collapse-mobile') && MOBILE());
      }
      panel.classList.toggle('collapsed', closed);

      const head = panel.querySelector('.panel-h');
      if (!head) return;
      head.classList.add('collapsible');
      head.setAttribute('role', 'button');
      head.setAttribute('tabindex', '0');

      const toggle = () => {
        const nowClosed = !panel.classList.contains('collapsed');
        panel.classList.toggle('collapsed', nowClosed);
        const s = load(KEY.collapse, {});
        s[key] = nowClosed;
        save(KEY.collapse, s);
      };
      head.addEventListener('click', e => {
        // Let the controls inside a header keep working.
        if (e.target.closest('button, select, input, a')) return;
        toggle();
      });
      head.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  }

  /* =============================================================== SHELL == */

  function switchTab(tab) {
    S.tab = tab;
    $$('#tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('.view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== tab));
    renderActive();
    wireCollapsibles();
    window.scrollTo({ top: 0, behavior: 'smooth' });

  }

  /**
   * Renders are wrapped because a single bad card record should not blank the
   * whole tab with nothing but a console error the user will never open.
   * Failing visibly beats failing silently.
   */
  function renderActive() {
    const fns = {
      rip: renderRip, collection: renderCollection,
      sets: renderSets, signals: renderSignals, settings: renderSettings
    };
    const fn = fns[S.tab];
    if (!fn) return;
    const banner = $('#render-error');
    try {
      fn();
      if (banner) banner.classList.add('hidden');
    } catch (err) {
      /* NEVER overwrite the view's markup here.

         This used to do `view.innerHTML = '<error panel>'`, which destroyed
         #rip-set, #rip-grid and every other element wire() had bound a
         listener to. The tab could then never render again — not after the
         cause was fixed, not after reloading the data — because the elements
         it renders INTO no longer existed. A page reload was the only way
         back, and nothing on screen said so.

         The error goes in a separate banner instead. The view keeps its
         markup and its listeners, so the next successful render just works. */
      if (banner) {
        banner.classList.remove('hidden');
        banner.innerHTML = `
          <div class="note warn small">
            <b>The ${esc(S.tab)} tab could not be drawn.</b>
            ${esc(err && err.message ? err.message : String(err))}
            <br><span class="muted">Your collection is not affected. This usually clears once
            the card data loads — check Settings → Data source.</span>
          </div>`;
      }
      if (window.console) console.error('[optcg-quant] render failed:', S.tab, err);
    }
  }

  /* Bind a handler by selector, tolerating a missing element.

     Every listener in wire() used to be `$('#id').addEventListener(...)`. If
     one id was absent — a half-finished upload, a stale cached index.html, an
     element renamed in markup but not here — that line threw, wire() aborted,
     and EVERY control below it silently went dead. The symptom is a UI that
     looks fine and does nothing, which is the worst kind to diagnose.

     Now a missing element is reported once and the rest still binds. */
  function on(sel, ev, fn, opts) {
    const el = typeof sel === 'string' ? $(sel) : sel;
    if (!el) { console.warn('[optcg] cannot bind ' + ev + ' — no element for ' + sel); return null; }
    el.addEventListener(ev, fn, opts);
    return el;
  }

  function wire() {
    $$('#tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

    on('#rip-set', 'change', e => {
      S.ripSet = e.target.value; S.ripCard = null; S.gridLimit = 150; renderRip();
    });
    on('#rip-rarity', 'change', e => {
      S.ripRarity = e.target.value; S.ripCard = null; S.gridLimit = 150; renderRip();
    });
    on('#rip-color', 'change', e => {
      S.ripColor = e.target.value; S.ripCard = null; S.gridLimit = 150; renderRip();
    });
    // Debounced: each keystroke re-picks the top match, which is a different
    // card and therefore a different history lookup. No point chasing every
    // intermediate spelling of "shanks".
    let searchTimer = null;
    on('#rip-search', 'input', e => {
      const v = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        S.ripSearch = v; S.ripCard = null; S.gridLimit = 150; renderRip();
      }, 180);
    });
    // ---- collection
    on('#col-new', 'click', () => {
      const name = prompt('Name this binder', 'New binder');
      if (!name) return;
      const kind = confirm('Is this trade / sell stock?\n\nOK = Trade / Sell, Cancel = Keeping')
        ? 'trade' : 'keep';
      const col = C.newCollection(name.trim(), kind);
      S.cols.push(col); S.curCol = col.id;
      persistCollection(); renderCollection();
    });
    on('#op-add', 'click', () => {
      const setId = $('#op-set').value;
      const boxes = Math.min(Math.max(parseInt($('#op-boxes').value, 10) || 0, 0), 999);
      const cost  = parseFloat($('#op-cost').value);
      if (!setId || boxes < 1) { alert('Enter how many boxes you opened (1–999).'); return; }
      if (isNaN(cost) || cost < 0 || cost > 1000000) {
        alert('Enter what you paid for those boxes.'); return;
      }
      S.opens.push(C.newOpen(setId, boxes, cost));
      $('#op-cost').value = '';
      persistCollection(); renderCollection();
    });
    on('#add-set', 'change', e => { S.addSet = e.target.value; renderAddGrid(); });
    on('#add-min', 'change', renderAddGrid);
    let addTimer = null;
    on('#add-search', 'input', e => {
      const v = e.target.value;
      clearTimeout(addTimer);
      addTimer = setTimeout(() => { S.addSearch = v; renderAddGrid(); }, 180);
    });

    on('#sig-min', 'change', renderSignals);
    let sigTimer;
    on('#sig-search', 'input', e => {
      const v = e.target.value;
      // Debounced like the rip search: 333 rows re-rank on every keystroke.
      clearTimeout(sigTimer);
      sigTimer = setTimeout(() => { S.sigSearch = v; renderSignals(); }, 180);
    });
    on('#sig-rarity', 'change', e => { S.sigRarity = e.target.value; renderSignals(); });
    on('#sig-colour', 'change', e => { S.sigColor = e.target.value; renderSignals(); });

    $$('#sets-tbl th.sortable').forEach(th => th.addEventListener('click', () => {
      const by = th.dataset.sort;
      S.sort.sets = { by, dir: S.sort.sets.by === by ? -S.sort.sets.dir : -1 };
      renderSets();
    }));
    $$('#sig-tbl th.sortable').forEach(th => th.addEventListener('click', () => {
      const by = th.dataset.sort;
      S.sort.sig = { by, dir: S.sort.sig.by === by ? -S.sort.sig.dir : -1 };
      renderSignals();
    }));

    on('#pr-profile', 'change', renderSettings);
    on('#reset-boxes', 'click', () => {
      S.boxes = {}; S.perCase = {};
      save(KEY.boxes, S.boxes); save(KEY.perCase, S.perCase);
      renderSettings(); renderActive();
    });

    on('#data-test', 'click', () => testDataSource($('#data-url').value));

    on('#data-save', 'click', async () => {
      const url = $('#data-url').value.trim().replace(/\/+$/, '');
      const msg = $('#data-msg');

      // Clearing the field is a legitimate action — it drops back to the local
      // snapshot, which is how development works.
      if (!url) {
        localStorage.removeItem(DATA_URL_KEY);
        msg.innerHTML = '<span class="muted">Cleared. Using the local snapshot.</span>';
        renderDataSource();
        return;
      }
      // Refuse to save something that does not work. Saving a bad URL and
      // reloading would empty the app and look like data loss.
      if (!(await testDataSource(url))) return;

      localStorage.setItem(DATA_URL_KEY, url);
      msg.textContent = 'Saved. Reloading card data…';
      try {
        // The cached rows came from the old source; force a full refetch.
        try { localStorage.removeItem(KEY.cards); } catch (_) {}
        await fetchCards(true);
        invalidate(); renderDataSource(); renderSettings(); renderActive();
        // The boot banner is stale the moment data arrives.
        $('#boot-error').classList.add('hidden');
        const rerr = $('#render-error');
        if (rerr) rerr.classList.add('hidden');
        msg.innerHTML = `<span class="up">Loaded ${S.cards.length.toLocaleString()} cards ` +
                        `and ${S.products.length} sealed products.</span>`;
      } catch (err) {
        msg.innerHTML = `<span class="down">Saved, but loading failed: ${esc(err.message)}</span>`;
      }
    });
    on('#reset-rates', 'click', () => {
      const v = $('#pr-profile').value || '';
      const id = v.slice(v.indexOf(':') + 1);
      if (v.indexOf('set:') === 0) { delete S.setRates[id]; save(KEY.setRates, S.setRates); }
      else                         { delete S.rates[id];    save(KEY.rates, S.rates); }
      $('#pr-profile').dataset.ready = '';
      invalidate(); renderSettings(); renderActive();
    });
    on('#clear-all', 'click', () => {
      // Deliberately does NOT touch the collection — losing a binder to a
      // settings-reset button would be unforgivable.
      if (!confirm('Reset box prices and pull rates to defaults?\n\nYour collection and cached card data are not touched.')) return;
      S.boxes = {}; S.rates = {}; S.setRates = {}; S.prefs = { friction: 100, advanced: false };
      [KEY.boxes, KEY.rates, KEY.setRates, KEY.prefs].forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
      $('#pr-profile').dataset.ready = '';
      invalidate(); renderSettings(); renderActive();
    });
    on('#refresh-data', 'click', async () => {
      const btn = $('#refresh-data');
      btn.disabled = true; btn.textContent = 'Refreshing…';
      try { await fetchCards(true); invalidate(); renderSettings(); renderActive(); }
      catch (err) { alert('Refresh failed: ' + err.message); }
      btn.disabled = false; btn.textContent = 'Refresh prices';
    });
    on('#retry', 'click', boot);
  }

  /* Rarity and colour options for Signals, counted against the price floor
     currently in force so the numbers match what the table will actually show.
     Each list is counted WITHIN the other's selection, same as Rip vs Buy. */
  function fillSignalFilters() {
    const raritySel = $('#sig-rarity'), colourSel = $('#sig-colour');
    if (!raritySel || !colourSel) return;

    const min = Number(($('#sig-min') || {}).value) || 0;
    const chaseKeys = ['SEC', 'ALT', 'SP', 'MANGA', 'ULTRA', 'TR'];
    const pool = [];
    for (const s of liveSets()) {
      for (const e of indexFor(s.id).all) {
        if (e.price < min) break;
        pool.push(e);
      }
    }

    const slot = S.sigRarity || 'all', colr = S.sigColor || 'all';

    const forRarity = colr === 'all' ? pool : pool.filter(e => hasColor(e.card, colr));
    const rCounts = {};
    for (const e of forRarity) rCounts[e.slot] = (rCounts[e.slot] || 0) + 1;
    const chaseCount = chaseKeys.reduce((n, k) => n + (rCounts[k] || 0), 0);

    const rOpts = [`<option value="all">All rarities (${forRarity.length})</option>`];
    if (chaseCount) rOpts.push(`<option value="chase">Chase only (${chaseCount})</option>`);
    for (const sl of D.SLOTS) {
      if (!rCounts[sl.key]) continue;
      rOpts.push(`<option value="${esc(sl.key)}">${esc(sl.label)} (${rCounts[sl.key]})</option>`);
    }
    raritySel.innerHTML = rOpts.join('');
    raritySel.value = slot;
    // Raising the price floor can empty a rarity — fall back rather than
    // showing an empty table with a filter that looks active.
    if (raritySel.value !== slot) { S.sigRarity = 'all'; raritySel.value = 'all'; }

    const forColour = slot === 'all' ? pool
      : slot === 'chase' ? pool.filter(e => chaseKeys.indexOf(e.slot) > -1)
      : pool.filter(e => e.slot === slot);
    const cCounts = {};
    for (const e of forColour) {
      for (const c of D.COLORS) if (hasColor(e.card, c)) cCounts[c] = (cCounts[c] || 0) + 1;
    }
    const cOpts = [`<option value="all">All colours (${forColour.length})</option>`];
    for (const c of D.COLORS) {
      if (!cCounts[c]) continue;
      cOpts.push(`<option value="${esc(c)}">${esc(c)} (${cCounts[c]})</option>`);
    }
    colourSel.innerHTML = cOpts.join('');
    colourSel.value = colr;
    if (colourSel.value !== colr) { S.sigColor = 'all'; colourSel.value = 'all'; }
  }

  function fillSetPickers() { /* Signals no longer has a set picker. */ }

  /* A pending write must not die with the tab. sendBeacon survives unload where
     fetch does not. */
  function flushOnExit() {
    window.addEventListener('pagehide', () => {
      if (!S.syncUrl || !S.pushTimer) return;
      try {
        navigator.sendBeacon(S.syncUrl, new Blob(
          [JSON.stringify({ action: 'push', collections: S.cols, items: S.items })],
          { type: 'text/plain;charset=utf-8' }));
      } catch (_) {}
    });
  }

  /* ================================================================ BOOT == */

  /* Repoint v1 collection rows onto productIds, once, on the first v2 boot.

     Runs after the cards are loaded because it needs them to match against,
     and before any render, so nothing ever paints a v1 key as a $0 unknown
     card. Rows that cannot be matched are LEFT ALONE and surfaced — a wrong
     match is worse than an unmigrated row, because the row still looks fine
     while pointing at the wrong card.

     migrateKeys() stamps updatedAt on every row it repoints, which is exactly
     what the sync treats as dirty, so the corrected keys ride up to the sheet
     on the next push. Without that this device would be migrated while every
     other one kept pulling the old keys back down. Row `id` is unchanged, so
     the sheet updates rows in place rather than duplicating them. */
  function runKeyMigration() {
    const v1 = S.items.filter(it => C.isV1Key(it.key));
    if (!v1.length) return;

    const res = C.migrateKeys(S.items, S.cards);
    S.items = res.items;
    S.migrationReport = {
      at: Date.now(),
      migrated: res.migrated,
      unmatched: res.unmatched.length,
      ambiguous: res.ambiguous.length,
      examples: res.unmatched.slice(0, 8).map(it => it.key)
    };

    if (res.migrated) persistCollection();
    save('optcg.migrationReport', S.migrationReport);
    console.info('[optcg] collection key migration:', S.migrationReport);
  }

  /* Build the per-set indexes during idle time instead of on first use.

     Measured: the first visit to Signals cost 67ms because it built all 22 set
     indexes synchronously, then 7ms for every visit after — so it was one-time
     work landing at the worst possible moment, mid-tap. On a phone that is the
     difference between a tab that opens and a tab that hitches.

     One set per idle callback, so a slow device never gets a long task; if
     requestIdleCallback is missing the whole thing is simply skipped and the
     old lazy path still works. */
  function prewarmIndexes() {
    if (typeof requestIdleCallback !== 'function') return;
    const queue = liveSets().map(s => s.id);
    const step = deadline => {
      while (queue.length && (deadline.timeRemaining() > 4 || deadline.didTimeout)) {
        indexFor(queue.shift());
      }
      if (queue.length) requestIdleCallback(step, { timeout: 2000 });
    };
    requestIdleCallback(step, { timeout: 2000 });
  }

  async function boot() {
    $('#boot').classList.remove('hidden');
    $('#boot-error').classList.add('hidden');
    $('#app').classList.add('hidden');

    /* WIRE FIRST, LOAD SECOND.

       These used to be the other way round, and it produced a dead app that
       looked alive. With no Worker URL configured the data fetch throws, boot
       jumped to the catch, and wire() never ran — so no tab ever got a click
       listener. The tab bar lives in the page header, OUTSIDE #app, so it
       stayed visible and simply did nothing.

       Worse, it was a trap with no way out: the error told you to open
       Settings -> Data source, which is precisely the screen you could not
       reach, because reaching it needed the wiring that never happened.

       Nothing in wire() depends on card data, so there is no reason for it to
       wait on the network. Wire the UI, then load. If loading fails you get a
       usable app with an explanation, and you can go and fix the cause. */
    try {
      ensureCollections();
      fillSetPickers();
      wire();
      flushOnExit();
      setSync(S.syncUrl ? 'ok' : 'off', S.syncUrl ? 'connected' : 'Sheets off');
    } catch (err) {
      // If even this fails the app is unusable, so say so plainly.
      $('#boot').classList.add('hidden');
      $('#boot-error').classList.remove('hidden');
      $('#boot-error-msg').textContent = 'The app failed to start: ' + (err && err.message || err);
      return;
    }

    try {
      const r = await fetchCards(false);
      if (r.fromCache) {
        // Cache is warm — show it instantly, then quietly freshen in the background.
        fetchCards(true).then(() => { invalidate(); renderActive(); }).catch(() => {});
      }
      collapsePermanent('boot');
      runKeyMigration();
      compactTombstones();

      $('#boot').classList.add('hidden');
      $('#app').classList.remove('hidden');
      switchTab('rip');

      // Sheets is the source of truth across devices, so reconcile on every
      // load. Render first so a slow sheet never blocks the app.
      if (S.syncUrl) pullNow(true);

      prewarmIndexes();
    } catch (err) {
      // Data failed, but the UI is already wired — so land the user ON the
      // settings tab, where the fix is, instead of on a dead end.
      $('#boot').classList.add('hidden');
      $('#app').classList.remove('hidden');
      $('#boot-error').classList.remove('hidden');
      switchTab('settings');

      const noSource = SRC.isMock();
      $('#boot-error-msg').innerHTML = noSource
        ? 'No data source is configured.<br><span class="small muted">This app reads ' +
          'TCGplayer prices through a small Cloudflare Worker. Deploy <code>worker/worker.js</code>, ' +
          'then open Settings → Data source and paste its URL. See DEPLOY.md.</span>'
        : esc(err.message) + '<br><span class="small muted">Data source: ' +
          esc(SRC.base()) + '</span>';
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})(OQ_DATA, OQ_ENGINE, OQ_COLLECTION);

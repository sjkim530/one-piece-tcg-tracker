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
    comps:  'oq.ebayComps.v1',
    watch:  'oq.watchlist.v1',
    opens:  'oq.opens.v1',
    collection: 'oq.collection.v2',
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
   * would drop your binder on the next reload with no warning at all.
   */
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }

  const collectionFields = ['cols', 'items', 'opens'];
  const collectionState = () => load(KEY.collection, null) || {
    rows: Object.fromEntries(collectionFields.map(key => [key, load(KEY[key], [])])),
    watch: load(KEY.watch, []), comps: load(KEY.comps, [])
  };
  let committedCollection = collectionState();

  function userRecords(snapshot, name) {
    const rows = snapshot[name] ?? load(KEY[name], []);
    return Array.isArray(rows) ? rows : [];
  }

  function backupData() {
    const snapshot = collectionState();
    return { ...snapshot.rows, watch: userRecords(snapshot, 'watch'), comps: userRecords(snapshot, 'comps') };
  }

  const backup = OQ_BACKUP.create({ read: backupData,
    identity: () => collectionState().backupId, status: renderBackupStatus });

  /* --------------------------------------------------------------- state -- */
  const S = {
    cards: [],
    bySet: {},
    byKey: {},                       // cardKey -> card, for collection lookups
    tab: 'catalog',
    boxes:  load(KEY.boxes, {}),     // setId -> user box price (Set Explorer only)
    perCase: load(KEY.perCase, {}),  // setId -> boxes per case, when it is not 12
    rates:    load(KEY.rates, {}),     // profile -> { perBox, packsPerBox }
    setRates: load(KEY.setRates, {}),  // setId   -> { perBox, packsPerBox }
    prefs:  load(KEY.prefs, { friction: 100, advanced: false }),
    ripSet: null, ripCard: null, ripSearch: '', ripRarity: 'all', ripColor: 'all',
    gridLimit: 150,                 // raised by the "show all" control
    rateScope: null,                 // which scope the pull-rate editor is on
    fetchedAt: null,
    indexCache: {},
    sort: { sets: { by: 'roi', dir: -1 } },

    // ---- collection
    ...structuredClone(committedCollection.rows),
    curCol:  null,
    addSet:  null,
    addSearch: '',
    browseSets: null
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
      verified: base.verified !== false && setMeta(setId)?.verified !== false,
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

  function holdingPrinting(item, card = S.byKey[item.key]) {
    return item.printing || (card?.alt_printing ? null : (card?.printing ?? null));
  }

  function priceForKey(key, finish) {
    const card = S.byKey[key];
    const printing = holdingPrinting({ key, printing: finish }, card);
    if (!card || printing == null) return null;
    const price = printing === card.printing ? card.market_price :
      printing === card.alt_printing?.printing ? card.alt_printing.market : null;
    return price > 0 ? price : null;
  }

  const holdingKey = (key, printing) => JSON.stringify([String(key), printing]);

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
     one key, with the user's collection sharing the same quota.

     Four fields are removed on the way in:
       card_image (485 KB)  derivable from id — it IS the id in a fixed URL
       set_name             only when exactly derivable from D.SETS
       direct_low (133 KB)  null on every single card; TCGplayer never fills it
       high_price (112 KB)  polluted with $9,999 placeholder listings and
                            deliberately never displayed

     Everything still needed is rebuilt on read, so the rest of the app never
     learns this happened. */
  const IMG_BASE = 'https://tcgplayer-cdn.tcgplayer.com/product/';
  const CATALOG_SCHEMA = 4;

  function slimCard(c) {
    const o = Object.assign({}, c);
    delete o.card_image;
    const set = D.SETS.find(s => s.id === c.set_id);
    if (set && set.name === c.set_name) delete o.set_name;
    delete o.high_price; delete o.direct_low_price;
    // Only drop the image when it is exactly what we can rebuild.
    if (c.card_image !== IMG_BASE + c.id + '_400w.jpg') o.card_image = c.card_image;
    return o;
  }

  function fatCard(c) {
    if (c.card_image == null) c.card_image = IMG_BASE + c.id + '_400w.jpg';
    if (c.set_name == null) {
      const m = D.SETS.find(s => s.id === c.set_id);
      c.set_name = m ? m.name : c.set_id;
    }
    return c;
  }

  function cachedCatalog() {
    const cached = load(KEY.cards, null);
    // Schemas 2 and 3 have usable card identities, but need an online rebuild
    // for current set classification and names. Never borrow another source.
    return cached && Array.isArray(cached.rows) && cached.rows.length &&
      cached.feed?.source === SRC.base() && [2, 3, CATALOG_SCHEMA].includes(cached.feed.schema)
      ? cached : null;
  }

  function useCachedCards(cached, stale) {
    const cards = cached.rows.map(c => fatCard({ ...c }));
    const products = cached.products || [];
    const feed = { ...cached.feed, stale: !!stale };
    applyCards(cards, cached.at, products, feed);
    S.loadFailures = [];
    if (!stale && cards[0].printing !== undefined) saveDailyPrices(feed, cards, products);
    return { fromCache: true };
  }

  async function fetchCards(force) {
    const cached = cachedCatalog();
    if (!force && cached?.feed.schema === CATALOG_SCHEMA) return useCachedCards(cached, false);
    // v2: one CSV per set from TCGCSV, through the Worker. source.js does the
    // parsing and shaping; this function only decides what to keep and when.
    //
    // New booster groups remain browsable without inventing pull rates.
    try {
      return await fetchCurrentCards(await SRC.loadUpdated());
    } catch (error) {
      if (cached && cached.feed.source === SRC.base()) return useCachedCards(cached, true);
      throw error;
    }
  }

  async function refreshCachedCards() {
    try {
      const updated = await SRC.loadUpdated();
      if (!updated) throw new Error('Feed update time unavailable');
      if (S.catalogFeed?.schema === CATALOG_SCHEMA && S.catalogFeed.updated === updated && S.catalogFeed.source === SRC.base() &&
          !S.loadFailures?.length && !S.catalogFeed.stale) return;
      return await fetchCurrentCards(updated);
    } catch (error) {
      if (!S.cards.length || S.catalogFeed?.source !== SRC.base()) throw error;
      S.catalogFeed = { ...S.catalogFeed, stale: true };
      return { fromCache: true };
    }
  }

  async function fetchCurrentCards(updated) {
    const source = SRC.base();
    const mock = SRC.isMock();
    const sets = await SRC.buildSets(D.SETS);
    const result = await SRC.loadAll(sets);
    const { cards, products, failed } = result;

    if (!cards.length) {
      throw new Error(failed.length
        ? `No cards loaded. First failure: ${failed[0].set} — ${failed[0].error}`
        : 'No cards returned by the data source');
    }

    // A partial load is worth keeping — 83 of 84 sets is far better than
    // nothing — but it must not be cached as if it were complete, or one bad
    // afternoon would freeze a hole in the data until the next manual refresh.
    const complete = failed.length === 0;
    let migrationPending = false;

    if (!complete) {
      // Several event groups share PROMO, and some decks share a set ID. Keep
      // missing rows conservatively in failed namespaces; fresh IDs win.
      const previous = S.catalogFeed?.source === source && S.cards.length
        ? { rows: S.cards, products: S.products, feed: S.catalogFeed } : cachedCatalog();
      // Older catalogs can misclassify a future booster as PROMO. Until a
      // complete refresh, its old namespace cannot identify which group failed.
      migrationPending = [2, 3].includes(previous?.feed?.schema) || !!previous?.feed?.migrationPending;
      const failedSets = new Set(failed.map(f => f.set));
      const cardKeys = new Set(cards.map(E.cardKey));
      const productIds = new Set(products.map(p => String(p.id)));
      for (const card of previous?.rows || []) {
        if ((migrationPending || failedSets.has(card.set_id)) && !cardKeys.has(E.cardKey(card))) {
          cards.push(fatCard({ ...card }));
          cardKeys.add(E.cardKey(card));
        }
      }
      for (const product of previous?.products || []) {
        if ((migrationPending || failedSets.has(product.set_id)) && !productIds.has(String(product.id))) {
          products.push(product);
          productIds.add(String(product.id));
        }
      }
    }

    const at = new Date().toISOString();
    const feed = { updated, mock, source, schema: CATALOG_SCHEMA, partial: !complete, migrationPending };
    if (complete) save(KEY.cards, { at, rows: cards.map(slimCard), products, feed });
    applyCards(cards, at, products, feed);
    if (complete) saveDailyPrices(feed, cards, products);
    S.loadFailures = failed;
    return { fromCache: false, failed };
  }

  function saveDailyPrices(feed, cards, products) {
    S.historyWrite = OQ_HISTORY.record(feed, cards, products).catch(error => {
      console.warn('[optcg] could not save daily prices', error);
    });
    return S.historyWrite;
  }

  function applyCards(rows, at, products, feed) {
    S.fetchedAt = at;
    S.catalogFeed = feed;
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
    S.catalogIndex = null;

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
            <thead><tr><th>Product</th><th class="num">Market</th><th class="num">Lowest</th><th>Price history</th><th></th></tr></thead>
            <tbody>${list.map(p => `
              <tr>
                <td>${esc(p.name)}</td>
                <td class="num" data-l="Market price"><b>${E.money(p.market_price)}</b></td>
                <td class="num muted" data-l="Lowest listing">${p.low_price ? E.money(p.low_price) : '—'}</td>
                <td data-l="Price history"><button class="btn small" type="button" data-sealed-history="${esc(p.id)}">Chart</button></td>
                <td class="num">${p.buy_url
                  ? `<a class="btn ghost small" href="${esc(p.buy_url)}" target="_blank" rel="noopener nofollow">Buy</a>`
                  : ''}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
        </div>
      </div>`;
    out.querySelectorAll('[data-sealed-history]').forEach(button => button.addEventListener('click', () => {
      const product = list.find(item => String(item.id) === button.dataset.sealedHistory);
      const dialog = $('#sealed-history-dialog');
      $('#sealed-history-title').textContent = product.name;
      dialog.showModal();
      const chart = $('#sealed-history-chart');
      if (product.printing == null) chart.textContent = 'Refresh card data to identify this product for the chart.';
      else showPriceHistory(chart, product.id, [product.printing]);
    }));
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
      const col = S.cols.find(c => sameBinder(c.id, it.colId));
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

  let sealedRun;
  let openSealedSet;
  let marketSummary;

  function loadMarketSummary(today) {
    const feedStamp = S.catalogFeed?.updated;
    if (marketSummary?.today !== today || marketSummary.feedStamp !== feedStamp) marketSummary = null;
    if (!marketSummary) {
      const request = { today, feedStamp };
      request.result = fetch('./market-summary.json', { cache: 'no-cache' }).then(async response => {
        if (!response.ok) throw new Error('Market summary unavailable');
        const summary = await response.json();
        if (summary.version !== OQ_MARKET.summaryVersion || !Number.isSafeInteger(summary.day) || !summary.rows ||
            Math.floor(Date.parse(summary.sourceUpdatedAt) / 86400000) !== summary.day) {
          throw new Error('Invalid market summary');
        }
        const currentDay = Math.floor(Date.parse(feedStamp) / 86400000);
        if (summary.day > today || summary.day < today - 3 ||
            (!S.catalogFeed?.mock && summary.day < currentDay)) throw new Error('Market summary is out of date');
        return summary;
      }).catch(() => {
        if (marketSummary === request) marketSummary = null;
        return null;
      });
      marketSummary = request;
    }
    return marketSummary.result;
  }

  function summaryRow(summary, card, printing = card.printing) {
    return summary.rows[card.id + ':' + printing];
  }

  function applySealedSummary(run, summary, boxes, pools) {
    const singlesBySet = new Map(pools);
    run.calls = new Map();
    run.singlesPrices = new Map();
    const movesByDay = new Map();
    for (const box of boxes) {
      const quote = summaryRow(summary, box)?.sealed || {};
      const offset = summary.day - quote.day;
      const key = box.set_id + ':' + quote.day;
      const singles = singlesBySet.get(box.set_id) || [];
      if (!movesByDay.has(key) && quote.day >= run.today - 3 && quote.day <= run.today) {
        const prices = new Map();
        const moves = [];
        for (const { card } of singles) {
          const [price, move] = summaryRow(summary, card)?.recent?.[offset] || [];
          if (price != null) prices.set(E.cardKey(card), price / 100);
          if (move != null) moves.push(move);
        }
        run.singlesPrices.set(key, prices);
        movesByDay.set(key, moves);
      }
      run.calls.set(String(box.id), OQ_MARKET.analyzeSealedQuote(quote, run.today, movesByDay.get(key) || [], singles.length));
    }
  }

  function sealedBoxes(setId) {
    const listing = product => product.low_price > 0 ? product.low_price : Infinity;
    return (S.sealedBySet?.[setId] || []).filter(product => product.kind === 'box')
      .sort((a, b) => listing(a) - listing(b) || Number(a.id) - Number(b.id));
  }

  function loadSealedCalls() {
    const today = Math.floor(Date.now() / 86400000);
    if (sealedRun?.cards === S.cards && sealedRun.today === today) return;
    const run = sealedRun = { cards: S.cards, today };
    const sets = liveSets();
    const boxes = sets.flatMap(set => sealedBoxes(set.id)).filter(box => box.printing != null);
    const pools = sets.map(set => [set.id, indexFor(set.id).all]);
    const scan = (entries, evaluate) => OQ_HISTORY.scan(entries, evaluate, () => {});
    (async () => {
      const summary = await loadMarketSummary(today);
      if (sealedRun !== run) return;
      if (summary) {
        applySealedSummary(run, summary, boxes, pools);
        return;
      }
      await S.historyWrite;
      const quotes = await scan(boxes.map(box => ({ card: box, printing: box.printing })),
        ({ card }, points) => ({ box: card, points }));
      if (sealedRun !== run) return;
      const daysBySet = new Map();
      for (const { box, points } of quotes.rows) {
        const day = points.at(-1)?.[0];
        if (day == null || day > today || today - day > 3) continue;
        if (!daysBySet.has(box.set_id)) daysBySet.set(box.set_id, new Set());
        daysBySet.get(box.set_id).add(day);
      }
      const entries = pools.flatMap(([setId, pool]) => daysBySet.has(setId)
        ? pool.filter(entry => entry.card.printing != null).map(({ card }) => ({
          card, printing: card.printing, setId
        })) : []);
      const moves = new Map();
      const prices = run.singlesPrices = new Map();
      const singles = await scan(entries, ({ card, setId }, points) => {
        for (const day of daysBySet.get(setId)) {
          const key = setId + ':' + day;
          const quote = points.findLast(point => point[0] <= day);
          if (quote?.[0] === day) {
            if (!prices.has(key)) prices.set(key, new Map());
            prices.get(key).set(E.cardKey(card), quote[1] / 100);
          }
          const move = OQ_MARKET.marketWindow(points, day);
          if (move != null) {
            if (!moves.has(key)) moves.set(key, []);
            moves.get(key).push(move);
          }
        }
      });
      if (sealedRun !== run) return;
      const counts = new Map(pools.map(([id, pool]) => [id, pool.length]));
      run.calls = new Map(quotes.rows.map(({ box, points }) => [String(box.id),
        OQ_MARKET.analyzeSealed(points, today, moves.get(box.set_id + ':' + points.at(-1)?.[0]) || [],
          counts.get(box.set_id))]));
      run.incomplete = quotes.unavailable || singles.unavailable ||
        quotes.storageUnavailable || singles.storageUnavailable;
    })().catch(error => {
      run.error = true;
      console.warn('[optcg] sealed analysis failed', error);
    }).finally(() => {
      if (sealedRun !== run || S.tab !== 'sets') return;
      updateSealedCalls();
      if ($('#set-analysis-dialog').open) renderSetAnalysis();
    });
  }

  function sealedCall(box) {
    if (!box) return { call: 'Insufficient data', reason: 'No booster box was found for this set.' };
    if (box.printing == null) return { call: 'Insufficient data', reason: 'Refresh the catalog to identify this box printing.' };
    if (sealedRun.error) return { call: 'Insufficient data', reason: 'The price history could not load.' };
    if (!sealedRun.calls) return { call: 'Loading…', reason: 'Loading box and singles history.' };
    return sealedRun.calls.get(String(box.id)) || { call: 'Insufficient data', reason: 'No box history is available.' };
  }

  const sealedLabels = { Buy: 'Discount candidate', Pass: 'Price caution', Watch: 'Watch' };

  function updateSealedCalls() {
    $$('[data-set-call]').forEach(button => {
      const box = sealedBoxes(button.dataset.setCall)[0];
      const { call } = sealedCall(box);
      button.textContent = sealedLabels[call] || call;
      button.dataset.call = call;
      button.title = box?.name || 'Set analysis';
      button.setAttribute('aria-label', `${sealedLabels[call] || call} · ${box?.name || setName(button.dataset.setCall)}`);
    });
    $('#sets-analysis-status').textContent = sealedRun.error ? 'The analysis could not load.' :
      sealedRun.incomplete ? 'Some price history could not load.' : '';
    $('#sets-analysis-retry').hidden = !(sealedRun.error || sealedRun.incomplete);
  }

  function renderSetAnalysis() {
    const { id } = openSealedSet;
    const box = sealedBoxes(id).find(product => String(product.id) === $('#set-box-product').value);
    const analysis = sealedCall(box);
    const money = cents => cents == null ? '—' : E.money(cents / 100, 2);
    const trend = value => value == null ? '—' : (value > 0 ? '+' : '') + E.pct(value);
    const prices = sealedRun.singlesPrices?.get(id + ':' + analysis.day);
    const index = E.buildSetIndex(id, S.bySet[id] || [], card => prices?.get(E.cardKey(card)) || 0);
    const config = configFor(id);
    const ev = E.evaluate(index, config).evBox;
    const concentration = E.chaseConcentration(index, config, 5);
    const modelFits = E.configFit(index, config).ok;
    const coverage = index.all.length ? index.all.filter(entry => entry.price > 0).length / index.all.length : 0;
    const listing = analysis.listing;
    const evWithoutTopFive = ev - concentration.top.reduce((sum, pull) => sum + pull.value, 0);
    let opening = analysis.call === 'Loading…' ? 'Loading…' : 'Insufficient data';
    const today = Math.floor(Date.now() / 86400000);
    const fresh = analysis.day >= today - 3 && analysis.day <= today;
    if (fresh && modelFits && coverage >= .6 && ev > 0 && listing > 0) {
      opening = listing > ev * 100 ? 'Listing above gross EV' :
        listing > evWithoutTopFive * 100 ? 'Gross EV depends on chase cards' : 'Listing below adjusted gross EV';
    }
    $('#set-analysis-body').innerHTML = `
      <section class="price-history">
        <div class="history-toolbar"><h3>Sealed price</h3>
          <strong class="market-call" data-call="${esc(analysis.call)}">${esc(sealedLabels[analysis.call] || analysis.call)}</strong></div>
        <p class="small">${esc(analysis.reason)}</p>
        <dl class="market-evidence">
          <div><dt>Market price</dt><dd>${money(analysis.market)}</dd></div>
          <div><dt>Lowest listing</dt><dd>${money(listing)}</dd></div>
          <div><dt>90-day box median</dt><dd>${money(analysis.median)}</dd></div>
          <div><dt>Listing vs. 90-day median</dt><dd>${listing > 0 && analysis.median > 0 ? trend(listing / analysis.median - 1) : '—'}</dd></div>
          <div><dt>Box trend over 30 days</dt><dd>${trend(analysis.momentum)}</dd></div>
          <div><dt>Median singles trend over 30 days</dt><dd>${trend(analysis.singles)}</dd></div>
          <div><dt>TCGplayer quote date</dt><dd>${analysis.day == null ? '—' : esc(OQ_HISTORY.dateLabel(analysis.day))}</dd></div>
        </dl>
        ${analysis.buyPrice != null ? `<p class="small">The discount rule looks for <b>${money(analysis.buyPrice)}</b> or less when the box trend is down no more than 10% and singles are down no more than 5%. The price caution starts at <b>${money(analysis.passPrice)}</b>. These sealed rules are exploratory and have yet to be backtested.</p>` : ''}
        ${analysis.singlesCount ? `<p class="small muted">Singles trend uses ${analysis.matched} of ${analysis.singlesCount} pullable printings with comparable price history.</p>` : ''}
      </section>
      <section class="price-history">
        <div class="history-toolbar"><h3>Opening value estimate</h3><strong>${opening}</strong></div>
        ${modelFits && ev > 0 ? `<p class="small">Estimated contents average <b>${E.money(ev, 2)}</b> per box before costs, or <b>${E.money(evWithoutTopFive, 2)}</b> excluding the five largest priced contributors. Those five account for ${E.pct(concentration.share, 0)} of expected value from individually priced cards.</p>
        <ul class="small">${concentration.top.filter(pull => pull.value > 0).map(pull =>
          `<li>${esc(pull.entry.card.card_name)} · ${E.money(pull.value, 2)} expected value per box</li>`).join('')}</ul>` : ''}
        <p class="small muted">${!modelFits ? 'The pull-rate model does not fit the catalog. ' : !config.verified ? 'Pull rates for this set are estimated. ' : ''}The model assumes equal odds within each pull slot. Gross value is before selling fees and shipping. ${E.pct(coverage, 0)} of pullable cards have a price on the box quote date. A comparison requires at least 60% and a recent quote.</p>
      </section>`;
    const chartKey = JSON.stringify([box?.id, box?.printing, S.fetchedAt]);
    if (openSealedSet.chartKey === chartKey) return;
    openSealedSet.chartKey = chartKey;
    const chart = $('#set-analysis-chart');
    if (box?.printing != null) showPriceHistory(chart, box.id, [box.printing]);
    else chart.replaceChildren();
  }

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
    loadSealedCalls();
    const tbody = $('#sets-tbl tbody');
    const rows = setRows();
    const { by, dir } = S.sort.sets;
    $('#sets-sort').value = by + ':' + dir;
    $$('#sets-tbl th[data-sort]').forEach(th => th.setAttribute('aria-sort',
      th.dataset.sort === by ? (dir === 1 ? 'ascending' : 'descending') : 'none'));
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
        <td data-l="Sealed call"><button class="btn small market-call" type="button" data-set-call="${esc(r.id)}"></button></td>
        <td class="num" data-l="Box price"><span>${E.money(r.box)}${r.est ? ' <span class="tag est">EST</span>' : ''}</span></td>
        <td class="num" data-l="Case">${r.case_ == null ? '<span class="muted">—</span>' : E.money(r.case_)}</td>
        <td class="num" data-l="EV / box">${E.money(r.evBox)}</td>
        <td class="num" data-l="EV / pack">${E.money(r.evPack)}</td>
        <td data-l="Return" class="num ${r.roi == null ? '' : r.roi >= 0 ? 'up' : 'down'}">
          <b>${r.roi == null ? '—' : (r.roi >= 0 ? '+' : '') + E.pct(r.roi, 0)}</b></td>
        <td class="num" data-l="Top-5 share">
          <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
            <span>${E.pct(r.conc, 0)}</span>
            <span class="bar brass" style="width:52px"><i style="width:${Math.min(100, r.conc * 100).toFixed(0)}%"></i></span>
          </div></td>
        <td class="num" data-l="Biggest hit"><div>${E.money(r.best)}${r.bestCard
          ? `<div class="small muted">${esc(r.bestCard.card.card_name.slice(0, 22))}</div>` : ''}</div></td>
        <td class="num" data-l="Singles ≥$5"><div>${E.money(r.over5)}
          <div class="small muted">${r.over5Count} cards</div></div></td>
        <td class="num muted" data-l="Cards">${r.cards}</td>
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
    $$('[data-set-call]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      const id = button.dataset.setCall;
      openSealedSet = { id };
      $('#set-analysis-title').textContent = setName(id);
      const select = $('#set-box-product');
      catalogOptions(select, sealedBoxes(id).map(box => [String(box.id), box.name]));
      select.selectedIndex = 0;
      $('#set-box-picker').hidden = !select.options.length;
      $('#set-analysis-chart').replaceChildren();
      renderSetAnalysis();
      $('#set-analysis-dialog').showModal();
    }));
    $$('#sets-tbl tbody tr').forEach(tr =>
      tr.addEventListener('click', () => openSet(tr.dataset.set)));
    updateSealedCalls();
    if ($('#set-analysis-dialog').open) renderSetAnalysis();
  }

  /* ============================================================ SIGNALS == */

  const scannerPage = 48;
  const signalLabels = {
    'Buy Now': 'Buy candidate',
    'Sell Now': 'Review for sale',
    Hold: 'Hold',
    'Insufficient data': 'No clear signal'
  };
  const scannerOrder = ['Sell Now', 'Buy Now', 'Hold', 'Insufficient data'];
  let scannerLimit = scannerPage;
  let scannerRun;

  function renderSignals() {
    const today = Math.floor(Date.now() / 86400000);
    if (scannerRun?.cards !== S.cards || scannerRun.today !== today) {
      scannerRun = { cards: S.cards, today };
      catalogOptions($('#sig-set'), [['', 'All sets'], ...browseSets().map(set => [set.id, set.name])]);
      const rarities = [...new Set(S.cards.map(card => E.rarityBadge(card).label))].sort();
      catalogOptions($('#sig-rarity'), [['', 'All rarities'], ...rarities.map(rarity => [rarity, rarity])]);
      scanSignals(scannerRun);
    }
    renderScannerResults();
  }

  async function scanSignals(run) {
    try {
      const summary = await loadMarketSummary(run.today);
      if (!summary) await S.historyWrite;
      const entries = run.cards.flatMap(card => {
        const printings = new Set([card.printing, card.alt_printing?.printing].filter(value => value != null));
        if (!printings.size) printings.add(null);
        return [...printings].map(printing => ({
          card, printing, key: E.cardKey(card), rarity: E.rarityBadge(card).label,
          id: JSON.stringify([String(card.id), printing])
        }));
      });
      const evaluate = (entry, points) => {
        points = entry.printing == null ? [] : points;
        const savedSummary = summary && entry.printing != null
          ? summaryRow(summary, entry.card, entry.printing) : null;
        const latest = savedSummary?.latest || points.at(-1);
        const analysis = savedSummary && latest[0] >= run.today - 3 && latest[0] <= run.today
          ? savedSummary.analysis : OQ_MARKET.analyze(latest ? (summary ? [latest] : points) : [], run.today);
        return {
          ...entry, analysis, latest,
          search: searchWords([entry.card.card_name, entry.card.card_set_id, entry.rarity].join(' ')),
          number: searchWords(entry.card.card_set_id).replace(/ /g, '')
        };
      };
      const progress = (done, total) => {
        if (scannerRun === run && (done % 16 === 0 || done === total)) {
          $('#sig-status').textContent = `Scanning price history (${done} of ${total})…`;
        }
      };
      const result = summary ? { rows: entries.map(entry => evaluate(entry, [])) } :
        await OQ_HISTORY.scan(entries, evaluate, progress);
      if (scannerRun !== run) return;
      Object.assign(run, result);
      run.summaryDay = summary?.day;
      renderScannerResults();
      renderSignalTracking(run);
    } catch (error) {
      if (scannerRun !== run) return;
      run.error = true;
      renderScannerResults();
      console.warn('[optcg] market scan failed', error);
    }
  }

  async function renderSignalTracking(run) {
    const host = $('#sig-tracking');
    host.textContent = 'Loading forward results…';
    try {
      const response = await fetch('./signal-performance.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error('Report unavailable');
      const report = await response.json();
      if (report.version !== 1 || !Array.isArray(report.results)) throw new Error('Unknown report format');
      if (scannerRun !== run) return;
      if (!report.trackedDays) {
        host.textContent = 'Forward tracking starts with the first daily job that observes a new price snapshot.';
        return;
      }
      const pct = value => value == null ? '—' : E.pct(value, 1);
      const stamp = Math.floor(Date.parse(report.sourceUpdatedAt) / 86400000);
      host.innerHTML = `<p>Tracking since ${esc(OQ_HISTORY.dateLabel(report.start))} ·
        ${Number(report.trackedDays)} of ${stamp - Number(report.start) + 1} UTC dates recorded ·
        Report through ${esc(OQ_HISTORY.dateLabel(stamp))}</p>` +
        report.results.map(row => `<div class="signal-performance-row">
          <strong>${esc(signalLabels[row.call])} · ${Number(row.horizon)} days</strong>
          <p>${Number(row.total)} flags · ${Number(row.pending)} pending · ${Number(row.missing)} without an exact forward quote</p>
          <p>${Number(row.hits)} of ${Number(row.measured)} moved in the flagged direction across
            ${Number(row.printings)} printings and ${Number(row.signalDays)} dates. Median market move ${pct(row.medianMove)}.</p>
          <p>${row.matched ? `${pct(row.matchedHits / row.matched)} vs. ${pct(row.baseline)} for matched peers (${Number(row.matched)} comparisons).` : 'No matched comparison yet.'}
            ${row.netCount ? `Median modeled ${row.call === 'Buy Now' ? 'resale return' : 'change in net proceeds from waiting'} ${pct(row.medianNet)} (${Number(row.netCount)} observations).` : ''}</p>
        </div>`).join('');
    } catch {
      if (scannerRun === run) host.textContent = 'The forward report is unavailable. It is published by the daily price job.';
    }
  }

  function scannerExplanation(analysis) {
    const note = `<span class="small muted">${analysis.evidence === 'limited' ? '<strong>Limited evidence.</strong> ' : ''}${esc(analysis.reason)}</span>`;
    if (!analysis.eligible || analysis.call !== 'Hold') return note;
    const money = cents => E.money(cents / 100, 2);
    const listRange = rule => `${money(rule.minListing)}–${money(rule.maxListing)} at this Market Price`;
    const directions = [
      { name: signalLabels['Buy Now'], rule: analysis.buy, limit: 'or less', trend: '+5% or higher' },
      { name: signalLabels['Sell Now'], rule: analysis.sell, limit: 'or more', trend: '−5% or lower' }
    ];
    const nearest = directions.find(({ rule }) => [rule.priceMet, rule.trendMet, rule.listingMet].filter(Boolean).length === 2);
    if (!nearest) return note;
    const { name, rule, limit, trend } = nearest;
    const needs = [];
    if (!rule.priceMet) needs.push(`Market Price of ${money(rule.price)} ${limit}`);
    if (!rule.trendMet) needs.push(`30-day trend of ${trend}`);
    if (!rule.listingMet) needs.push(`listing within ${listRange(rule)}`);
    return note + `<span class="small scanner-condition"><strong>${name}</strong> needs ${esc(needs.join(' · '))}</span>`;
  }

  function renderScannerResults() {
    const run = scannerRun;
    const status = $('#sig-status');
    const results = $('#sig-results');
    const counts = $('#sig-counts');
    const more = $('#sig-more');
    const retry = $('#sig-retry');
    retry.hidden = !(run?.error || run?.unavailable || run?.storageUnavailable);
    if (!run?.rows) {
      status.textContent = run?.error ? 'Could not complete the scan.' : 'Loading price history…';
      results.replaceChildren();
      counts.replaceChildren();
      $('#sig-tracking').textContent = '';
      more.hidden = true;
      return;
    }
    const ownedOnly = $('#sig-scope').value === 'owned';
    const owned = ownedOnly ? new Set(C.livePlaced(S.items, S.cols)
      .map(item => holdingKey(item.key, holdingPrinting(item)))) : null;
    const call = $('#sig-call').value;
    const set = $('#sig-set').value;
    const rarity = $('#sig-rarity').value;
    const min = $('#sig-min').valueAsNumber * 100;
    const max = $('#sig-max').valueAsNumber * 100;
    const query = searchWords($('#sig-search').value);
    const tokens = query ? query.split(' ') : [];
    const compact = tokens.join('');
    const totals = Object.fromEntries(scannerOrder.map(label => [label, 0]));
    const filtered = [];
    for (const row of run.rows) {
      const market = row.latest?.[1];
      if ((owned && !owned.has(holdingKey(row.key, row.printing))) ||
          (set && row.card.set_id !== set) || (rarity && row.rarity !== rarity) ||
          (Number.isFinite(min) && (market == null || market < Math.round(min))) ||
          (Number.isFinite(max) && (market == null || market > Math.round(max))) ||
          (query && !row.number.startsWith(compact) && !tokens.every(token => row.search.includes(token)))) continue;
      totals[row.analysis.call]++;
      if (!call || call === row.analysis.call) filtered.push(row);
    }
    filtered.sort((a, b) => scannerOrder.indexOf(a.analysis.call) - scannerOrder.indexOf(b.analysis.call) ||
      Math.abs(b.analysis.momentum || 0) - Math.abs(a.analysis.momentum || 0) ||
      (b.latest?.[1] || 0) - (a.latest?.[1] || 0) || a.id.localeCompare(b.id));
    counts.innerHTML = scannerOrder.map(label => `<button class="btn market-call" data-call="${esc(label)}"
      aria-pressed="${label === call}">${esc(signalLabels[label])} · ${totals[label].toLocaleString()}</button>`).join('');
    const unavailable = run.unavailable ? ` ${run.unavailable} archive groups could not load.` : '';
    const storage = run.storageUnavailable ? ' Browser snapshots could not load.' : '';
    const snapshot = run.summaryDay == null ? '' : ' Daily snapshot ' + OQ_HISTORY.dateLabel(run.summaryDay) + '.';
    status.textContent = `${filtered.length.toLocaleString()} matching printings.` + snapshot + unavailable + storage;
    const display = filtered.slice(0, scannerLimit);
    results.innerHTML = display.map(row => {
      const { card, analysis, latest } = row;
      const label = [card.card_set_id, card.set_name || setName(card.set_id), row.rarity, row.printing].filter(Boolean).join(' · ');
      return `<button class="scanner-card signal-row" type="button" data-id="${esc(row.id)}">
        <span class="signal-art">${cardArt(card)}</span>
        <span class="signal-identity"><strong>${esc(card.card_name)}</strong>
          <span class="small muted">${esc(label)}</span>
          <span class="market-call" data-call="${esc(analysis.call)}">${esc(signalLabels[analysis.call])}</span>
        </span>
        <span class="signal-quote">
          <span class="small muted">TCGplayer Market Price</span>
          <strong>${latest ? E.money(latest[1] / 100, 2) : 'Unavailable'}</strong>
          <span class="small muted">${latest ? esc(OQ_HISTORY.dateLabel(latest[0])) +
            (latest[0] < run.today - 3 ? ' · Stale quote' : '') : 'No recorded quote'}</span>
          ${latest?.[2] > 0 ? `<span class="small">Low listing ${E.money(latest[2] / 100, 2)}</span>` : ''}
          ${analysis.horizon ? `<span class="small">${analysis.horizon}-day trend ${analysis.momentum > 0 ? '+' : ''}${E.pct(analysis.momentum, 2)}</span>` : ''}
        </span>
        <span class="signal-rules">${scannerExplanation(analysis)}</span>
      </button>`;
    }).join('') || '<p class="muted">No printings match these filters.</p>';
    more.hidden = filtered.length <= scannerLimit;
  }

  function wireSignals() {
    const reset = () => { scannerLimit = scannerPage; renderSignals(); };
    for (const filter of ['scope', 'call', 'set', 'rarity']) on('#sig-' + filter, 'change', reset);
    for (const filter of ['search', 'min', 'max']) on('#sig-' + filter, 'input', reset);
    on('#sig-counts', 'click', event => {
      const button = event.target.closest('[data-call]');
      if (!button) return;
      const select = $('#sig-call');
      select.value = select.value === button.dataset.call ? '' : button.dataset.call;
      reset();
      $('#sig-counts').querySelector(`[data-call="${button.dataset.call}"]`)?.focus();
    });
    on('#sig-retry', 'click', () => { scannerRun = null; reset(); });
    on('#sig-more', 'click', () => {
      const previous = scannerLimit;
      scannerLimit += scannerPage;
      renderScannerResults();
      $('#sig-results').children[previous]?.focus();
    });
    on('#sig-results', 'click', event => {
      const button = event.target.closest('[data-id]');
      if (!button) return;
      const row = scannerRun.rows.find(item => item.id === button.dataset.id);
      if (row) openCatalogCard(row.key, row.printing);
    });
  }

  /* =========================================================== SETTINGS == */

  /* ---- data source ------------------------------------------------------ */

  function renderDataSource() {
    const input = $('#data-url');
    if (!input) return;
    input.value = SRC.configuredBase();
    if (SRC.defaultBase !== './mockapi') input.placeholder = SRC.defaultBase;

    const state = $('#src-state');
    if (!state) return;
    if (SRC.isMock()) {
      state.innerHTML = '<span class="tag est">local snapshot</span>';
      state.title = 'Reading the local development snapshot in mockapi/. Set a Worker URL for live prices.';
    } else {
      state.innerHTML = '<span class="tag">Worker feed</span>';
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
       ${esc(catalogDate())}.<br>
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
    return changed;
  }

  /* Consolidate duplicate permanent binders from older versions. */
  function collapsePermanent(reason) {
    const res = C.dedupePermanent(S.cols, S.items);
    if (!res.mergedBinders) return 0;
    S.cols = res.cols;
    S.items = res.items;
    console.info('[optcg] merged duplicate permanent binders', {
      reason, binders: res.mergedBinders, itemsMoved: res.movedItems });
    S.binderMerge = { at: Date.now(), binders: res.mergedBinders, items: res.movedItems };
    return res.mergedBinders;
  }

  const liveCols = () => S.cols.filter(c => !c.deleted);
  // Older backups can use numeric binder IDs. HTML control values are strings.
  const sameBinder = (first, second) => first != null && second != null && String(first) === String(second);
  const itemsIn = id => C.live(S.items).filter(it => sameBinder(it.colId, id));

  function currentCol() {
    const cols = liveCols();
    if (!cols.length) return null;
    let c = cols.find(x => sameBinder(x.id, S.curCol));
    if (!c) { c = cols.find(col => col.kind === 'keep') || cols[0]; S.curCol = c.id; }
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
        <b>Older binder entries</b>
        ${r.migrated ? `<br>${r.migrated} ${r.migrated === 1 ? 'entry linked' : 'entries linked'} to the current catalog.` : ''}
        ${stuck ? `<br><b>${stuck} row${stuck === 1 ? '' : 's'} could not be matched</b> and
          ${stuck === 1 ? 'was' : 'were'} left exactly as ${stuck === 1 ? 'it was' : 'they were'} —
          nothing was deleted. ${r.ambiguous ? `${r.ambiguous} matched more than one card. ` : ''}
          Re-add ${stuck === 1 ? 'it' : 'them'} by hand and delete the old row.
          ${r.examples && r.examples.length
            ? `<br><span class="mono muted" style="font-size:11px">${
                 r.examples.map(key => {
                   const item = C.legacyIdentity(key);
                   return esc(item ? [item.name, item.number].filter(Boolean).join(' · ') : 'Unlinked card');
                 }).join('<br>')}</span>` : ''}`
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

  let collectionHistoryRun;

  function renderCollectionHistory(items) {
    const holdings = new Map();
    for (const item of items) {
      const card = S.byKey[item.key];
      const qty = C.qtyOf(item);
      const printing = holdingPrinting(item, card);
      if (!card || !qty || printing == null || C.isGraded(item) || (item.cond && item.cond !== 'NM')) continue;
      const key = holdingKey(card.id, printing);
      const row = holdings.get(key) || { card, printing, qty: 0 };
      row.qty += qty;
      holdings.set(key, row);
    }
    const copies = items.reduce((sum, item) => sum + C.qtyOf(item), 0);
    const day = Math.floor(Date.now() / 86400000);
    const signature = JSON.stringify([day, copies, [...holdings.values()]
      .map(row => [row.card.id, row.printing, row.qty]).sort()]);
    if (collectionHistoryRun?.signature === signature && collectionHistoryRun.catalog === S.byKey) return;

    const run = { signature, catalog: S.byKey };
    collectionHistoryRun = run;
    const chart = $('#col-history');
    const coverage = $('#col-history-coverage');
    coverage.textContent = '';
    const pending = Promise.resolve(S.historyWrite).then(() => OQ_HISTORY.scan([...holdings.values()], (row, points) => ({
      ...row, points, signal: OQ_MARKET.analyze(points, day)
    }), () => {})).then(result => {
      const history = C.holdingHistory(result.rows);
      if (collectionHistoryRun === run) {
        run.signals = new Map(result.rows.map(row => [holdingKey(row.card.id, row.printing), row.signal]));
        run.partial = result.unavailable > 0 || result.storageUnavailable;
        coverage.textContent = copies
          ? `${history.copies.toLocaleString()} of ${copies.toLocaleString()} copies tracked. The chart uses today’s raw near-mint quantities and TCGplayer market references for each finish. A day appears when every tracked finish has a quote.`
          : '';
        refreshCollectionSignals();
      }
      return {
        ...history, archiveUnavailable: result.unavailable > 0, storageUnavailable: result.storageUnavailable,
        emptyMessage: !copies ? 'Add cards to start tracking your collection.' :
          !history.points.length ? 'No common price dates for your tracked holdings yet.' : ''
      };
    });
    OQ_HISTORY.holdingsChart(chart, pending).catch(() => {
      if (collectionHistoryRun !== run) return;
      run.signals = new Map();
      run.partial = true;
      chart.querySelector('[role="status"]').textContent = 'Could not load collection history.';
      refreshCollectionSignals();
    });
  }

  function renderCollection() {
    const col = currentCol();
    renderBinders();
    renderMigrationReport();

    // ---- headline numbers across every binder
    // Only cards in a binder that still exists. A sync race can strand rows on
    // a deleted binder: invisible in every binder, yet still inflating the
    // headline total, so the number disagreed with everything you could see.
    const placed = C.livePlaced(S.items, S.cols);
    renderStranded(C.orphans(S.items, S.cols));
    const all = C.valueOf(placed, priceForKey);

    // Trade stock valued at what a vendor would actually give for it. Each
    // binder carries its own rate because not every buyer offers the same.
    let tradeAtRate = 0;
    for (const c of liveCols()) {
      if (c.kind !== 'trade') continue;
      tradeAtRate += C.valueOf(itemsIn(c.id), priceForKey).total * (C.rateOf(c) / 100);
    }
    const gain = (all.gain > 0 ? '+' : all.gain < 0 ? '−' : '') + E.money(Math.abs(all.gain), 2);

    $('#col-stats').innerHTML =
      stat('Collection reference value', all.cards > all.unpriced ? E.money(all.total, 2) : '—',
        `${all.cards.toLocaleString()} copies${all.unpriced ? ` · ${all.unpriced.toLocaleString()} unpriced` : ''}`, 'hero') +
      stat('Recorded cost', all.costedCards ? E.money(all.cost, 2) : '—',
        `${all.costedCards.toLocaleString()} of ${all.cards.toLocaleString()} copies`) +
      stat('Unrealized gain / loss', all.comparableCards ? gain : '—',
        all.comparableCards
          ? `${all.comparableCards.toLocaleString()} of ${all.cards.toLocaleString()} copies` +
            (all.gainPct == null ? '' : ` · ${all.gainPct > 0 ? '+' : ''}${E.pct(all.gainPct, 1)}`)
          : 'Requires a value and recorded cost', all.gain > 0 ? 'collection-up' : all.gain < 0 ? 'collection-down' : '') +
      stat('Estimated trade value', E.money(tradeAtRate, 2), 'At your binder trade rates');

    renderCollectionHistory(placed);
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
          <td class="num" data-l="Boxes">${r.boxes || '—'}</td>
          <td class="num" data-l="Spent">${E.money(r.spent)}</td>
          <td class="num" data-l="Pulled value">${E.money(r.pulledValue)}</td>
          <td data-l="Net" class="num ${r.incomplete ? 'muted' : r.net >= 0 ? 'up' : 'down'}">
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
      return `<button type="button" class="binder" data-col="${esc(c.id)}" aria-pressed="${sameBinder(c.id, S.curCol)}" aria-controls="binder-holdings">
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
    const col = currentCol();
    $('#add-target').textContent = col ? 'adding to ' + col.name : '';
    if (!$('.collection-add').open) return;
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

    const here = {}, elsewhere = {};
    for (const it of C.live(S.items)) {
      if (sameBinder(it.colId, col?.id)) {
        if (isQuickAddItem(it)) here[it.key] = (here[it.key] || 0) + 1;
      } else elsewhere[it.key] = true;
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

  function isQuickAddItem(item) {
    const card = S.byKey[item.key];
    return card && holdingPrinting(item, card) === card.printing &&
      item.cond === 'NM' && !item.grader && C.qtyOf(item) === 1 &&
      C.amount(item.paid) == null && C.amount(item.value) == null && !item.note;
  }

  function toggleCard(key) {
    const col = currentCol();
    if (!col) return;
    const hit = C.live(S.items).find(it =>
      sameBinder(it.colId, col.id) && String(it.key) === key && isQuickAddItem(it));

    if (hit) { hit.deleted = 1; hit.updatedAt = Date.now(); }
    else {
      // Promos, starter decks and event cards cannot be pulled from a pack, so
      // they must not default to "pulled" — that would credit a $3,499
      // Regionals card you bought as ripping profit in the scoreboard.
      S.items.push(C.newItem(col.id, key, { printing: S.byKey[key]?.printing, src: isPullable(key) ? 'pull' : 'buy' }));
    }

    persistCollection();
    renderCollection();
  }

  /* ---- the binder table -------------------------------------------------- */
  function isSellNow(item) {
    return C.qtyOf(item) > 0 && !C.isGraded(item) && (!item.cond || item.cond === 'NM') &&
      collectionHistoryRun?.signals?.get(holdingKey(item.key, holdingPrinting(item)))?.call === 'Sell Now';
  }

  function renderCollectionSignals(items) {
    const button = $('#col-sell');
    const selling = items.filter(isSellNow);
    const count = new Set(selling.map(item => holdingKey(item.key, holdingPrinting(item)))).size;
    button.textContent = collectionHistoryRun?.signals ? `Review for sale (${count})` : signalLabels['Sell Now'];
    button.disabled = !collectionHistoryRun?.signals || !items.length;
    $('#col-signal-status').textContent = items.length
      ? collectionHistoryRun?.partial ? 'Some signals are unavailable.' :
        !collectionHistoryRun?.signals ? 'Checking market signals…' : ''
      : '';
    const eligible = new Set(selling.map(item => String(item.id)));
    $$('[data-sell-badge]', $('#view-collection')).forEach(badge => { badge.hidden = !eligible.has(badge.dataset.sellBadge); });
  }

  function refreshCollectionSignals() {
    if (S.tab !== 'collection') return;
    const col = currentCol();
    if ($('#col-sell').getAttribute('aria-pressed') === 'true') renderColTable(col);
    else renderCollectionSignals(col ? itemsIn(col.id) : []);
  }

  function renderColTable(col) {
    const tbody = $('#col-tbl tbody');
    const gallery = $('#binder-gallery');
    if (!col) { tbody.innerHTML = gallery.innerHTML = ''; return; }

    const items = itemsIn(col.id);
    const query = searchWords($('#col-query').value);
    const tokens = query ? query.split(' ') : [];
    const sort = $('#col-sort').value;
    const sellOnly = $('#col-sell').getAttribute('aria-pressed') === 'true';
    const rows = items.filter(item => !sellOnly || isSellNow(item)).map(it => {
      const card = S.byKey[it.key];
      const legacy = card ? null : C.legacyIdentity(it.key);
      const number = card?.card_type === 'DON!!' ? 'DON!!' : card?.card_set_id || legacy?.number || (legacy?.don ? 'DON!!' : '');
      const title = card ? C.cardTitle(card.card_name, number) : legacy?.name || 'Unlinked card';
      return { it, card, title, number, qty: C.qtyOf(it), each: C.unitValue(it, priceForKey) };
    }).filter(({ title, number }) => {
      if (!query) return true;
      const numberKey = searchWords(number).replace(/ /g, '');
      return numberKey.startsWith(tokens.join('')) || tokens.every(token => (searchWords(title) + ' ' + numberKey).includes(token));
    }).sort((a, b) => {
      const byName = () => a.title.localeCompare(b.title);
      if (sort === 'name') return byName();
      if (sort === 'qty') return b.qty - a.qty || byName();
      return (b.each ?? -1) * b.qty - (a.each ?? -1) * a.qty || byName();
    });
    const v = C.valueOf(items, priceForKey);

    // Binders this card could move to. Deciding to sell something you kept is
    // routine, and the delete-and-re-add workaround destroyed seven fields —
    // including cost basis and the pulled/bought flag, which would have
    // recounted a bought card as a pull and inflated the rip scoreboard.
    const others = liveCols().filter(c => !sameBinder(c.id, col.id));

    const rate = C.rateOf(col);
    const traded = col.kind === 'trade' && rate !== 100;

    $('#col-title').textContent = col.name;
    $('#col-sub').innerHTML =
      `${v.cards} cards · ${traded ? '' : '<b>'}${E.money(v.total)}${traded ? ' reference' : '</b>'}` +
      (traded ? ` · <b style="color:var(--brass)">${E.money(v.total * rate / 100)} at ${rate}%</b>` : '') +
      (v.unpriced ? ` · <span class="muted">${v.unpriced} unpriced</span>` : '');
    $('#col-price-source').textContent = ['Raw values use market references across conditions. Manual values override them.',
      catalogDate()].filter(Boolean).join(' ');

    gallery.innerHTML = rows.map(({ it, card, title, number, each, qty }) => {
      const state = C.isGraded(it) ? [it.grader, it.grade].join(' ') : it.cond;
      const printing = holdingPrinting(it, card);
      const finishLabel = printing == null && card?.alt_printing
        ? 'Confirm finish in Edit' : printing || (card ? 'Finish unavailable' : 'Catalog match needed');
      return `<article class="binder-card">
        ${card ? `<button class="binder-art" type="button" data-key="${esc(it.key)}" data-printing="${esc(printing)}" aria-label="View ${esc(title)}">${cardArt(card)}</button>`
          : '<div class="binder-art noart"><span>Artwork unavailable</span></div>'}
        <div class="binder-card-info"><span class="binder-number">${esc(number)}</span><strong>${esc(title)}</strong>
          <span class="small muted">${esc(finishLabel)} · ${esc(state || 'Raw')} · ${qty} ${qty === 1 ? 'copy' : 'copies'}</span>
          <div class="binder-values"><b>${each == null ? 'Unpriced' : E.money(each * qty, 2) + (qty > 1 ? ' <small>total</small>' : '')}</b>
          ${each != null && qty > 1 ? `<span class="small muted">${E.money(each, 2)} each</span>` : ''}</div>
          <span class="market-call" data-call="Sell Now" data-sell-badge="${esc(it.id)}" hidden>Review for sale</span>
        </div>
      </article>`;
    }).join('') || '<p class="catalog-empty">' + (items.length ? 'No cards match these filters.' : 'This binder is empty. Find cards to start your collection.') + '</p>';

    tbody.innerHTML = rows.map(({ it, card, title, number, each, qty }) => {
      const graded = C.isGraded(it);
      const manual = C.amount(it.value);
      const printing = holdingPrinting(it, card);
      const finishes = [card?.printing, card?.alt_printing?.printing].filter(Boolean);
      return `<tr data-id="${esc(it.id)}">
        <td><div class="cardcell">
          ${card?.card_image ? `<img src="${esc(card.card_image)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ''}
          <div class="nm">${card ? `<button type="button" class="collection-card-link" data-key="${esc(it.key)}" data-printing="${esc(printing)}">${esc(title)}</button>` : `<b>${esc(title)}</b>`}
            <span>${esc(number)}</span>
            <button type="button" class="market-call collection-card-sell" data-call="Sell Now"
              data-sell-badge="${esc(it.id)}" data-key="${esc(it.key)}" data-printing="${esc(printing)}" hidden>Review for sale</button></div>
        </div></td>
        <td data-l="Set"><span class="tag">${esc(card ? setShort(card.set_id) : '—')}</span></td>
        <td data-l="State"><div class="holding-state">
          ${finishes.length > 1 || printing && !finishes.includes(printing)
            ? `<select class="it-printing" data-id="${esc(it.id)}" aria-label="Finish">
                 <option value="" disabled${printing ? '' : ' selected'}>Confirm finish</option>
                 ${printing && !finishes.includes(printing) ? `<option selected disabled>${esc(printing)} · unavailable</option>` : ''}
                 ${finishes.map(finish => `<option value="${esc(finish)}"${printing === finish ? ' selected' : ''}>${esc(finish)}</option>`).join('')}
               </select>`
            : printing ? `<span class="holding-finish">${esc(printing)}</span>` : ''}
          <select class="it-grader" data-id="${esc(it.id)}" aria-label="Grading company">
            <option value="">Raw</option>
            ${D.GRADERS.map(g => `<option value="${g}"${it.grader === g ? ' selected' : ''}>${g}</option>`).join('')}
          </select>
          ${graded
            ? `<select class="it-grade" data-id="${esc(it.id)}" aria-label="Grade">
                 ${[10,9.5,9,8.5,8,7,6,5,4,3,2,1].map(g =>
                   `<option value="${g}"${String(it.grade) === String(g) ? ' selected' : ''}>${g}</option>`).join('')}
               </select>`
            : `<select class="it-cond" data-id="${esc(it.id)}" aria-label="Condition">
                 ${D.CONDITIONS.map(c => `<option value="${c.code}"${it.cond === c.code ? ' selected' : ''}>${c.code}</option>`).join('')}
               </select>`}
        </div></td>
        <td class="num" data-l="Qty"><input type="number" class="it-qty" data-id="${esc(it.id)}" min="0" step="1"
             value="${qty}" style="width:62px;text-align:right;padding:4px 6px;font-size:12px"></td>
        <td class="num" data-l="Each">${graded || manual != null
            ? `<input type="number" class="it-value" data-id="${esc(it.id)}" min="0" step="0.01"
                 placeholder="${graded ? 'graded $' : 'market'}" value="${manual ?? ''}"
                 style="width:88px;text-align:right;padding:4px 6px;font-size:12px"
                 title="${graded ? 'No free feed for graded prices — enter what it is worth' : 'Overrides the live market price'}">`
            : each == null ? '—' : E.money(each, 2)}</td>
        <td class="num" data-l="Paid ea."><input type="number" class="it-paid" data-id="${esc(it.id)}" min="0" step="0.01"
             placeholder="—" value="${C.amount(it.paid) ?? ''}"
             style="width:80px;text-align:right;padding:4px 6px;font-size:12px"
             title="What you paid, per copy"></td>
        <td class="num" data-l="Value"><b>${each == null ? '—' : E.money(each * qty, 2)}</b></td>
        <td class="num acts" data-l="">
          <select class="it-src" data-id="${esc(it.id)}" aria-label="Acquired by" title="Pulled cards count as winnings in the scoreboard">
            <option value="pull"${it.src !== 'buy' ? ' selected' : ''}>pulled</option>
            <option value="buy"${it.src === 'buy' ? ' selected' : ''}>bought</option>
          </select>
          ${others.length ? `
          <select class="it-move" data-id="${esc(it.id)}" aria-label="Move to another binder">
            <option value="">move…</option>
            ${others.map(o => `<option value="${esc(o.id)}">→ ${esc(o.name)}</option>`).join('')}
          </select>` : ''}
          <button class="btn ghost small it-del" data-id="${esc(it.id)}">×</button></td>
      </tr>`;
    }).join('') || `<tr><td colspan="8" class="muted">${!items.length
      ? 'This binder is empty. Find cards to add or open Quick add.'
      : sellOnly && !collectionHistoryRun?.signals ? 'Checking market signals…' : 'No cards match these filters.'}</td></tr>`;
    renderCollectionSignals(items);

    const find = id => S.items.find(x => String(x.id) === id);
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
    $$('.it-printing').forEach(el => el.addEventListener('change', () => {
      const it = find(el.dataset.id); if (!it || !el.value) return;
      it.printing = el.value; touch(it);
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
      const dest = liveCols().find(col => sameBinder(col.id, el.value));
      if (!it || !dest) return;

      // Preserve distinct purchase lots, valuations and notes.
      const twin = C.live(S.items).find(x =>
        x.id !== it.id && sameBinder(x.colId, dest.id) && String(x.key) === String(it.key) &&
        holdingPrinting(it) != null && holdingPrinting(x) === holdingPrinting(it) &&
        x.cond === it.cond && x.grader === it.grader &&
        String(x.grade) === String(it.grade) && x.src === it.src &&
        C.amount(x.paid) === C.amount(it.paid) && C.amount(x.value) === C.amount(it.value) &&
        (x.note || '') === (it.note || '') && C.qtyOf(x) + C.qtyOf(it) <= MAX_QTY);

      if (twin) {
        twin.qty = C.qtyOf(twin) + C.qtyOf(it);
        twin.updatedAt = Date.now();
        it.deleted = 1;
        it.updatedAt = Date.now();
      } else {
        it.colId = dest.id;
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

  /* ---- persistence and backup -------------------------------------------- */
  function persistCollection() {
    const disk = collectionState();
    const rows = {};
    for (const key of collectionFields) {
      const before = new Map(committedCollection.rows[key].map(row => [row.id, JSON.stringify(row)]));
      const changed = S[key].filter(row => before.get(row.id) !== JSON.stringify(row));
      rows[key] = C.mergeRows(changed, disk.rows[key]);
    }
    const next = { rows, watch: userRecords(disk, 'watch'), comps: userRecords(disk, 'comps') };
    if (!writeCollection(next)) {
      applyCollection(disk);
      alert('Your collection change could not be saved. Free up browser storage and try again.');
      return false;
    }
    applyCollection(next);
    return true;
  }

  function writeCollection(snapshot) {
    snapshot.backupId = collectionState().backupId || C.uid();
    if (!save(KEY.collection, snapshot)) {
      try { localStorage.removeItem(KEY.cards); } catch (_) {}
      if (!save(KEY.collection, snapshot)) return false;
    }
    // The original keys remain readable until the replacement is durable.
    for (const key of [...collectionFields, 'watch', 'comps']) {
      try { localStorage.removeItem(KEY[key]); } catch (_) {}
    }
    backup.change();
    return true;
  }

  function applyCollection(snapshot) {
    committedCollection = snapshot;
    Object.assign(S, structuredClone(snapshot.rows));
  }

  function saveUserRecords(name, rows) {
    const disk = collectionState();
    return writeCollection({ rows: disk.rows, watch: userRecords(disk, 'watch'),
      comps: userRecords(disk, 'comps'), [name]: rows });
  }

  function renderBackupStatus({ state, message, last, filename }) {
    $('#backup-status').textContent = filename ? message + ' ' + filename : message;
    const detail = $('#backup-last');
    detail.hidden = !last;
    if (last) detail.textContent = 'Last backed up ' + new Date(last).toLocaleString();
    const connect = $('#backup-connect');
    connect.hidden = !backup.supported || state === 'saving';
    connect.textContent = filename ? 'Choose backup file' : 'Enable automatic backup';
    $('#backup-reconnect').hidden = state !== 'permission' || !filename;
    $('#backup-download').hidden = backup.supported && !['permission', 'error'].includes(state);
    const chip = $('#backup-chip');
    const labels = { ready: 'Backup on', saving: 'Backing up', permission: 'Backup paused', error: 'Backup paused' };
    const dot = { ready: 'on', saving: 'busy', permission: 'err', error: 'err' };
    chip.hidden = !labels[state];
    chip.innerHTML = labels[state] ? `<span class="sync-dot ${dot[state]}"></span><span>${labels[state]}</span>` : '';
  }

  function wireBackup() {
    const input = $('#backup-file');
    const preview = $('#backup-preview');
    const status = $('#backup-restore-status');
    let selection = 0;
    let candidate;
    function clearPreview() {
      selection++;
      candidate = null;
      preview.hidden = true;
      status.textContent = '';
    }
    on('#backup-connect', 'click', backup.connect);
    on('#backup-reconnect', 'click', backup.reconnect);
    on('#backup-download', 'click', backup.download);
    on('#backup-restore', 'click', () => input.click());
    on('#backup-cancel', 'click', () => {
      clearPreview();
      $('#backup-restore').focus();
    });
    on(input, 'change', async () => {
      const file = input.files[0];
      input.value = '';
      clearPreview();
      if (!file) return;
      const attempt = selection;
      try {
        const data = await OQ_BACKUP.readFile(file);
        if (attempt !== selection) return;
        candidate = data;
        const copies = C.live(data.items).reduce((sum, item) => sum + C.qtyOf(item), 0);
        $('#backup-preview-text').textContent = `Replace this device’s saved data with ${C.live(data.cols).length} binders, ` +
          `${copies.toLocaleString()} card copies, ${C.live(data.opens).length} opening entries, ` +
          `${data.watch.length} watch targets, and ${data.comps.length} eBay sales?`;
        preview.hidden = false;
        $('#backup-cancel').focus();
      } catch (error) {
        if (attempt === selection) status.textContent = error instanceof SyntaxError
          ? 'This is not a readable JSON backup.' : error.message;
      }
    });
    on('#backup-apply', 'click', () => {
      if (!candidate) return;
      const { watch, comps, ...rows } = candidate;
      const next = { rows, watch, comps };
      if (!writeCollection(next)) {
        status.textContent = 'Restore could not be saved. Free up browser storage and try again.';
        return;
      }
      applyCollection(next);
      runKeyMigration();
      S.curCol = null;
      clearPreview();
      status.textContent = 'Backup restored on this device.';
      $('#backup-restore').focus();
    });
    if (!backup.supported) {
      renderBackupStatus({ state: 'unsupported', message: 'Use Download backup to save a copy in this browser.' });
    }
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

  /* ============================================================= CATALOG == */

  const CATALOG_PAGE = 48;
  const featuredPrintings = ['453506', '454666', '453509'];
  const catalogFilters = ['set', 'rarity', 'type', 'color'];
  let catalogLimit = CATALOG_PAGE;
  let catalogCardKey = null;
  let catalogHistoryKey = null;
  let catalogPrinting;
  let compsKey;
  let watchEditorKey;
  let watchRun;

  const printingKey = (id, printing) => JSON.stringify([String(id), printing]);
  const watchMoney = cents => cents == null ? '—' :
    (cents < 0 ? '−' : '') + E.money(Math.abs(cents) / 100, 2);

  function watchedCards() {
    return userRecords(collectionState(), 'watch');
  }

  function renderWatchEditor(card, reset = false) {
    const editor = $('#watch-editor');
    editor.hidden = catalogPrinting == null;
    const key = editor.hidden ? null : printingKey(card.id, catalogPrinting);
    if (!reset && key === watchEditorKey) return;
    watchEditorKey = key;
    if (editor.hidden) return;
    const saved = watchedCards().find(row => row.key === key);
    const form = $('#watch-form');
    form.elements.buy.value = saved?.buy == null ? '' : saved.buy / 100;
    form.elements.sell.value = saved?.sell == null ? '' : saved.sell / 100;
    form.elements.shipping.value = (saved?.shipping ?? OQ_MARKET.defaultShipping) / 100;
    $('#watch-editor-title').textContent = saved ? 'Edit Watchlist targets' : 'Set price targets';
    $('#watch-printing').textContent = catalogPrinting || 'Default printing';
    $('#watch-editor-status').textContent = '';
    $('#watch-remove').hidden = !saved;
  }

  function refreshWatchlist() {
    const rows = watchedCards();
    const today = Math.floor(Date.now() / 86400000);
    const signature = JSON.stringify([today, rows]);
    if (watchRun?.signature === signature && watchRun.catalog === S.byKey) {
      if (S.tab === 'watchlist') renderWatchlist();
      return;
    }

    const entries = rows.map(row => ({
      ...row, card: S.byKey[row.id],
      status: OQ_MARKET.watchTargets(row, null, today)
    }));
    const run = { signature, catalog: S.byKey, entries };
    watchRun = run;
    const available = entries.filter(row => row.card &&
      [row.card.printing, row.card.alt_printing?.printing].includes(row.printing));
    run.loading = available.length > 0;
    renderWatchlist();
    if (!run.loading) return;

    Promise.resolve(S.historyWrite).then(() => OQ_HISTORY.scan(available, (row, points) => ({
      ...row, quote: points.at(-1), status: OQ_MARKET.watchTargets(row, points.at(-1), today)
    }), () => {})).then(result => {
      const quotes = new Map(result.rows.map(row => [row.key, row]));
      run.entries = entries.map(row => quotes.get(row.key) || row);
      run.partial = result.unavailable > 0 || result.storageUnavailable;
    }).catch(() => { run.partial = true; }).finally(() => {
      run.loading = false;
      if (watchRun === run) renderWatchlist();
    });
  }

  function renderWatchlist() {
    const { entries, loading, partial } = watchRun;
    const hit = row => row.status.buyHit || row.status.sellHit;
    const hits = entries.filter(hit).length;
    $('#watch-tab-count').textContent = hits ? ` (${hits})` : '';
    if (S.tab !== 'watchlist') return;
    $('#watch-status').textContent = entries.length
      ? (loading ? 'Checking daily prices…' :
        `${hits} of ${entries.length} watched printings at target.${partial ? ' Some price history could not load.' : ''}`) +
        ' Targets are saved in this browser.'
      : 'Open a card from Card Search and set a buy or sell target to start your Watchlist.';
    const sales = compSales();
    const today = todayLocal();
    $('#watch-results').innerHTML = entries.slice().sort((a, b) => Number(hit(b)) - Number(hit(a)))
      .map(row => {
        const { card, quote, status } = row;
    const { count, median } = OQ_MARKET.summarizeComps(
          sales.filter(sale => sale.key === row.key && sale.condition === 'NM'), today);
        const quoteLabel = quote
          ? OQ_HISTORY.dateLabel(quote[0]) + (status.fresh ? '' : ' · Stale quote')
          : loading ? 'Checking prices…' : 'Daily quote unavailable';
        const targetLabel = reached => status.fresh ? (reached ? 'Target met' : 'Waiting') : 'Awaiting fresh quote';
        return `<article class="scanner-card watch-card">
          <h2>${esc(card?.card_name || row.name)}</h2>
          <div class="small muted">${esc([row.number, card?.set_name || row.set, row.printing || 'Default printing'].filter(Boolean).join(' · '))}</div>
          <p class="small muted">${esc(quoteLabel)}</p>
          <p class="small">Market ${watchMoney(quote?.[1])} · Lowest listing ${watchMoney(quote?.[2])}</p>
          ${row.buy != null ? `<p class="small">Buy at ${watchMoney(row.buy)} or less · <span ${status.buyHit ? 'data-hit' : ''}>${
            status.fresh && !(quote?.[2] > 0) ? 'Listing unavailable' : targetLabel(status.buyHit)}</span></p>` : ''}
          ${row.sell != null ? `<p class="small">Sell for ${watchMoney(row.sell)} net · <span ${status.sellHit ? 'data-hit' : ''}>${targetLabel(status.sellHit)}</span>
            <br><span class="muted">Estimated net ${watchMoney(status.net)} · ${watchMoney(row.shipping)} shipping cost</span></p>` : ''}
          <p class="small muted">eBay Near Mint · ${count ? watchMoney(median) + ' median · ' + count + ' logged' : 'No logged sales'} in 90 days</p>
          <div>${card && [card.printing, card.alt_printing?.printing].includes(row.printing)
            ? `<button class="btn small" type="button" data-watch-edit="${esc(row.key)}">View / edit targets</button>`
            : `<button class="btn small" type="button" data-watch-remove="${esc(row.key)}">Remove unavailable printing</button>`}</div>
        </article>`;
      }).join('');
  }

  function removeWatchTarget(key) {
    if (!saveUserRecords('watch', watchedCards().filter(row => row.key !== key))) return false;
    refreshWatchlist();
    return true;
  }

  function wireWatchlist() {
    const status = $('#watch-editor-status');
    on('#watch-form', 'submit', event => {
      event.preventDefault();
      const card = S.byKey[catalogCardKey];
      if (!card || catalogPrinting == null) return;
      const fields = event.currentTarget.elements;
      const cents = field => field.value === '' ? null : Math.round(field.valueAsNumber * 100);
      const buy = cents(fields.buy);
      const sell = cents(fields.sell);
      if (buy == null && sell == null) {
        status.textContent = 'Enter a buy target, a sell target, or both.';
        return;
      }
      const key = printingKey(card.id, catalogPrinting);
      const row = { key, id: String(card.id), name: card.card_name, number: card.card_set_id,
        set: card.set_name, printing: catalogPrinting, buy, sell,
        shipping: cents(fields.shipping) ?? OQ_MARKET.defaultShipping };
      if (!saveUserRecords('watch', [...watchedCards().filter(saved => saved.key !== key), row])) {
        status.textContent = 'Could not save the targets. Free up browser storage and try again.';
        return;
      }
      renderWatchEditor(card, true);
      refreshWatchlist();
      status.textContent = 'Targets saved.';
    });
    on('#watch-remove', 'click', () => {
      if (!removeWatchTarget(watchEditorKey)) {
        status.textContent = 'Could not remove the targets. Try again.';
        return;
      }
      renderWatchEditor(S.byKey[catalogCardKey], true);
      $('#watch-editor-title').focus();
      status.textContent = 'Removed from Watchlist.';
    });
    on('#watch-search', 'click', () => {
      switchTab('catalog');
      $('#catalog-query').focus({ preventScroll: true });
    });
    on('#watch-results', 'click', event => {
      const button = event.target.closest('[data-watch-edit], [data-watch-remove]');
      if (!button) return;
      if (button.dataset.watchRemove) {
        if (!removeWatchTarget(button.dataset.watchRemove)) $('#watch-status').textContent = 'Could not remove the targets. Try again.';
        else $('#watch-search').focus();
        return;
      }
      const row = watchedCards().find(row => row.key === button.dataset.watchEdit);
      if (!row) return;
      openCatalogCard(row.id, row.printing);
      showCardSection('watch');
      $('#watch-editor-title').focus();
    });
  }

  const compConditions = D.CONDITIONS.map(({ code, label }) => [code, label]);
  const todayLocal = () => {
    const now = new Date();
    return new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };

  function compSales() {
    return userRecords(collectionState(), 'comps');
  }

  function compGroup(sale) {
    return sale.condition === 'graded' ? sale.grader + ' ' + sale.grade : sale.condition;
  }

  function renderCompGroups(selected = $('#comps-group').value) {
    const grades = [...new Set(compSales().filter(sale => sale.key === compsKey && sale.condition === 'graded')
      .map(compGroup))].sort();
    const select = $('#comps-group');
    catalogOptions(select, [...compConditions, ...grades.map(grade => [grade, grade])]);
    select.value = [...select.options].some(option => option.value === selected) ? selected : 'NM';
  }

  function renderCompSummary(card, sales = compSales()) {
    const group = $('#comps-group').value;
    const matching = sales.filter(sale => sale.key === compsKey && compGroup(sale) === group)
      .sort((a, b) => b.sold.localeCompare(a.sold));
    const { count, median, latest, age } = OQ_MARKET.summarizeComps(matching, todayLocal());
    const alt = card.alt_printing?.printing === catalogPrinting ? card.alt_printing : null;
    const market = alt ? alt.market : card.market_price;
    const money = cents => E.money(cents / 100, 2);
    $('#comps-summary').innerHTML = `
      <div><dt>eBay median · last 90 days</dt><dd>${median == null ? '—' : money(median)}</dd>
        <span class="small muted">${count} logged ${count === 1 ? 'sale' : 'sales'} · shipping included${latest ? ' · Latest ' + esc(latest) : ''}
          ${count > 0 && count < 3 ? ' · Small sample' : ''}${age > 30 ? ' · No sale in the last 30 days' : ''}</span></div>
      <div><dt>TCGplayer Market Price</dt><dd>${catalogPrice(market)}</dd>
        <span class="small muted">Printing-level quote. This feed has no condition or grade breakdown.</span></div>`;
    $('#comps-sales').innerHTML = matching.map(sale => `<li class="small">
      <strong>${money(sale.price + sale.shipping)}</strong>
      <span class="muted">${esc(sale.sold)} · ${money(sale.price)} + ${money(sale.shipping)} shipping</span>
      ${/^\d{9,15}$/.test(sale.itemId || '') ? `<a href="https://www.ebay.com/itm/${sale.itemId}" target="_blank" rel="noopener noreferrer">Listing ↗</a>` : ''}
      <button type="button" class="btn ghost small" data-comp-remove="${esc(sale.id)}">Remove</button>
    </li>`).join('');
    const nearMint = OQ_MARKET.summarizeComps(sales.filter(sale => sale.key === compsKey && sale.condition === 'NM'), todayLocal());
    const evidence = $('#catalog-comp-evidence');
    evidence.textContent = nearMint.count
      ? `eBay Near Mint · ${nearMint.count} logged ${nearMint.count === 1 ? 'sale' : 'sales'} in 90 days · Latest ${nearMint.latest}` +
        (nearMint.count < 3 ? ' · Small sample' : '') + (nearMint.age > 30 ? ' · No sale in the last 30 days' : '')
      : 'eBay Near Mint · No logged sales in the last 90 days.';
  }

  function syncCompGrade() {
    const fields = $('#comps-add').elements;
    const graded = fields.condition.value === 'graded';
    for (const field of [fields.grader, fields.grade]) {
      field.closest('label').hidden = field.disabled = !graded;
      field.required = graded;
    }
  }

  function renderCatalogComps(card) {
    const host = $('#catalog-comps');
    host.hidden = catalogPrinting == null;
    if (host.hidden) {
      compsKey = null;
      $('#catalog-comp-evidence').textContent = '';
      return;
    }
    const key = printingKey(card.id, catalogPrinting);
    if (key !== compsKey) {
      compsKey = key;
      const form = $('#comps-add');
      form.reset();
      form.elements.sold.max = form.elements.sold.value = todayLocal();
      form.elements.condition.value = 'NM';
      $('#comps-entry').open = false;
      $('#comps-status').textContent = '';
      syncCompGrade();
      renderCompGroups('NM');
    }
    $('#comps-printing').textContent = [card.card_set_id, card.set_name, catalogPrinting || 'Default printing']
      .filter(Boolean).join(' · ') + ' · Saved on this browser';
    $('#comps-search').href = OQ_MARKET.ebaySoldSearch(card, catalogPrinting);
    renderCompSummary(card);
  }

  function wireCatalogComps() {
    const form = $('#comps-add');
    const { sold, price, shipping, condition, grader, grade, listing } = form.elements;
    catalogOptions(condition, [...compConditions, ['graded', 'Graded']]);
    catalogOptions(grader, [['', 'Choose grader'], ...D.GRADERS.map(name => [name, name])]);
    const status = $('#comps-status');
    on('#comps-entry', 'toggle', () => { sold.max = todayLocal(); });
    on('#comps-group', 'change', () => {
      status.textContent = '';
      renderCompSummary(S.byKey[catalogCardKey]);
    });
    condition.addEventListener('change', syncCompGrade);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const card = S.byKey[catalogCardKey];
      if (!card || !compsKey || !form.reportValidity()) return;
      if (sold.value > todayLocal()) {
        status.textContent = 'Enter a sale date up to today.';
        return;
      }
      const link = listing.value.trim();
      const itemId = link ? OQ_MARKET.ebayItemId(link) : null;
      if (link && !itemId) {
        status.textContent = 'Enter an ebay.com item URL or leave the field blank.';
        return;
      }
      const sales = compSales();
      if (itemId && sales.some(sale => sale.key === compsKey && sale.itemId === itemId)) {
        status.textContent = 'That listing is already saved for this printing.';
        return;
      }
      const sale = {
        id: C.uid(), key: compsKey, sold: sold.value, condition: condition.value,
        price: Math.round(price.valueAsNumber * 100), shipping: Math.round(shipping.valueAsNumber * 100), itemId
      };
      if (sale.condition === 'graded') Object.assign(sale, { grader: grader.value, grade: grade.valueAsNumber });
      if (!saveUserRecords('comps', [...sales, sale])) {
        status.textContent = 'Could not save the sale. Free up browser storage and try again.';
        return;
      }
      price.value = shipping.value = listing.value = '';
      sold.value = todayLocal();
      renderCompGroups(compGroup(sale));
      renderCompSummary(card);
      status.textContent = 'Sale saved.';
    });
    on('#comps-sales', 'click', event => {
      const button = event.target.closest('[data-comp-remove]');
      const card = S.byKey[catalogCardKey];
      if (!button || !card || !compsKey) return;
      const remaining = compSales().filter(sale => sale.key !== compsKey || sale.id !== button.dataset.compRemove);
      if (!saveUserRecords('comps', remaining)) {
        status.textContent = 'Could not remove the sale. Try again.';
        return;
      }
      renderCompGroups();
      renderCompSummary(card, remaining);
      $('#comps-group').focus();
      status.textContent = 'Sale removed.';
    });
  }

  function showPriceHistory(container, id, printings, onPrintingChange, initialPrinting) {
    const pending = S.historyWrite || Promise.resolve();
    // Let an in-flight snapshot commit before reading the latest day.
    const loading = document.createElement('p');
    loading.className = 'small muted';
    loading.textContent = 'Loading prices…';
    container.replaceChildren(loading);
    pending.then(() => {
      if (loading.parentElement === container) {
        OQ_HISTORY.chart(container, id, [...new Set(printings)], onPrintingChange, initialPrinting);
      }
    });
  }

  const searchWords = value => String(value || '').normalize('NFKD').toLowerCase()
    .replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const catalogPrice = value => value > 0 ? E.money(value) : 'Unavailable';

  function catalogDate() {
    const feed = S.catalogFeed;
    if (!feed) return '';
    const date = new Date(feed.updated || NaN);
    const label = feed.mock ? 'Local sample · TCGplayer' : 'TCGplayer via TCGCSV';
    const status = (feed.partial ? ' · Partial update; some sets may use saved prices' : '') +
      (feed.stale ? ' · Refresh unavailable; using saved data' : '');
    if (!Number.isFinite(date.getTime())) return label + ' · Snapshot date unavailable' + status;
    return label + ' · ' + date.toLocaleDateString(undefined, {
      timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric'
    }) + (Date.now() - date.getTime() > 36 * 3600000 ? ' · Update overdue' : '') + status;
  }

  function catalogOptions(select, options) {
    const value = select.value;
    select.replaceChildren(...options.map(([id, label]) => new Option(label, id)));
    if (options.some(([id]) => String(id) === value)) select.value = value;
  }

  function renderCatalog() {
    const sets = browseSets();
    const setLabels = new Map(sets.map(set => [set.id, set.name]));
    if (!S.catalogIndex) {
      S.catalogIndex = S.cards.map(card => {
        const badge = E.rarityBadge(card);
        const name = searchWords(card.card_name);
        const number = searchWords(card.card_set_id).replace(/ /g, '');
        return {
          card, badge, name, number, title: C.cardTitle(card.card_name, card.card_set_id),
          terms: searchWords([card.card_name, card.card_set_id, card.set_id,
            card.set_name, setLabels.get(card.set_id), badge.label, card.card_type,
            card.subtypes, card.attribute, card.rulesText].join(' '))
        };
      });
    }
    const distinct = values => [...new Set(values.filter(Boolean))].sort().map(value => [value, value]);
    const rows = S.catalogIndex;
    catalogOptions($('#catalog-set'), [['', 'All sets'], ...sets.map(set => [set.id, set.short + ' · ' + set.name])]);
    catalogOptions($('#catalog-rarity'), [['', 'All rarities'], ...distinct(rows.map(row => row.badge.label))]);
    catalogOptions($('#catalog-type'), [['', 'All types'], ...distinct(rows.map(row => row.card.card_type))]);
    catalogOptions($('#catalog-color'), [['', 'All colors'], ...distinct(['Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow'])]);
    $('#catalog-date').textContent = catalogDate();
    $('#featured-cards').innerHTML = featuredPrintings.map(key => {
      const card = S.byKey[key];
      if (!card?.card_image) return '';
      return `<button class="featured-card" type="button" data-key="${esc(key)}"
        aria-label="View ${esc(card.card_name)}">${cardArt(card)}</button>`;
    }).join('');
    renderCatalogResults();
    if ($('#catalog-dialog').open) renderCatalogCard();
  }

  function renderCatalogResults(append = false) {
    const [set, rarity, type, color] = catalogFilters.map(filter => $('#catalog-' + filter).value);
    const query = searchWords($('#catalog-query').value);
    const tokens = query ? query.split(' ') : [];
    const code = query.replace(/ /g, '');
    const sort = $('#catalog-sort').value;
    const matches = [];
    const rows = S.catalogIndex || [];
    const matchesIdentity = row => row.number.startsWith(code) || tokens.every(token => row.name.includes(token));
    const identitySearch = query && rows.some(matchesIdentity);
    for (const row of rows) {
      const { card } = row;
      if (set && card.set_id !== set || rarity && row.badge.label !== rarity ||
          type && card.card_type !== type || color && !hasColor(card, color)) continue;
      let score = 0;
      if (query) {
        if (code === row.number) score = 4;
        else if (query === row.name) score = 3;
        else if (row.name.startsWith(query) || row.number.startsWith(code)) score = 2;
        else if (identitySearch ? matchesIdentity(row) : tokens.every(token => row.terms.includes(token))) score = 1;
        else continue;
      }
      matches.push({ row, score });
    }
    matches.sort((a, b) => {
      const first = a.row.card;
      const second = b.row.card;
      const byName = () => first.card_name.localeCompare(second.card_name) ||
        a.row.number.localeCompare(b.row.number);
      if (sort === 'name') return byName();
      if (sort === 'match' && a.score !== b.score) return b.score - a.score;
      const priceA = first.market_price || 0;
      const priceB = second.market_price || 0;
      if (!priceA || !priceB) return Number(!!priceB) - Number(!!priceA) || byName();
      return (sort === 'price-low' ? priceA - priceB : priceB - priceA) || byName();
    });
    const count = [set, rarity, type, color].filter(Boolean).length;
    $('#catalog-results-title').textContent = !query ? 'Browse cards' :
      (!identitySearch && matches.length ? 'Card text matches' : 'Search results');
    $('#catalog-filter-count').textContent = count ? '(' + count + ')' : '';
    $('#catalog-clear').hidden = count === 0;
    $('#catalog-count').textContent = matches.length
      ? `${Math.min(catalogLimit, matches.length).toLocaleString()} of ${matches.length.toLocaleString()} printings`
      : 'No matching cards';
    const grid = $('#catalog-grid');
    const start = append ? grid.children.length : 0;
    const markup = matches.slice(start, catalogLimit).map(({ row }) => {
      const { card } = row;
      return `<button class="catalog-tile" type="button" data-key="${esc(E.cardKey(card))}">
        <span class="catalog-frame">${cardArt(card, 'catalog-art')}${rarityChip(card)}</span>
        <span class="catalog-tile-body">
          <span class="catalog-tile-number">${esc(card.card_set_id || card.set_id)}</span>
          <strong>${esc(row.title)}</strong>
          <span class="catalog-tile-meta">${esc(card.set_name || setName(card.set_id))}</span>
          <span class="catalog-tile-price">${catalogPrice(card.market_price)}</span>
        </span>
      </button>`;
    }).join('');
    if (append) {
      grid.insertAdjacentHTML('beforeend', markup);
      grid.children[start]?.focus();
    } else grid.innerHTML = markup || '<p class="catalog-empty">No matching cards. Try a different name, card number, or filter.</p>';
    $('#catalog-more').hidden = matches.length <= catalogLimit;
  }

  function renderCatalogCard() {
    const card = S.byKey[catalogCardKey];
    if (!card) {
      $('#catalog-dialog').close();
      return;
    }
    const badge = E.rarityBadge(card);
    const number = String(card.card_set_id || '').toUpperCase();
    const reprints = /^([A-Z]+\d{2})-\d{3}$/.test(number)
      ? [...new Set(S.cards.filter(other => ['PRB-01', 'PRB-02'].includes(other.set_id) &&
          other.set_id !== card.set_id && other.card_set_id?.toUpperCase() === number).map(other => other.set_id))]
      : [];
    const printings = card.printing == null ? null :
      [card.printing, ...(card.alt_printing ? [card.alt_printing.printing] : [])];
    if (!printings?.includes(catalogPrinting)) catalogPrinting = card.printing;
    $('#catalog-finish-field').hidden = !printings || printings.length < 2;
    catalogOptions($('#catalog-finish'), (printings || []).map(finish => [finish, finish || 'Default finish']));
    $('#catalog-finish').value = catalogPrinting ?? '';
    const artwork = cardArt(card, 'catalog-art');
    $('#catalog-preview').innerHTML = card.card_image && artFlag(card)?.kind !== 0
      ? `<button class="artwork-preview" type="button" data-enlarge-artwork
          aria-label="Enlarge artwork for ${esc(C.cardTitle(card.card_name, card.card_set_id))}">
          ${artwork}<span>View larger</span></button>` : artwork;
    $('#catalog-card').innerHTML = `<div class="card-identity">
        <div class="small muted">${esc(card.card_set_id || card.set_id)} · ${esc(badge.label)}</div>
        <h2 id="catalog-card-title">${esc(C.cardTitle(card.card_name, card.card_set_id))}</h2>
        <p class="small muted">${esc(card.set_name || setName(card.set_id))}</p>
        ${reprints.length ? `<p class="small muted">Same card number also in ${esc(reprints.join(', '))}. Compare the exact artwork and finish before using a price.</p>` : ''}
    </div>`;
    $('#catalog-prices').innerHTML = `<dl class="catalog-quotes">
          <div><dt>Market price</dt><dd id="catalog-detail-market"></dd></div>
          <div><dt>Lowest listing</dt><dd id="catalog-detail-low"></dd></div>
        </dl>
        <p class="small muted catalog-quote-source">${esc(catalogDate())}</p>
        <div class="catalog-quote-actions">
        ${card.buy_url ? `<a href="${esc(card.buy_url)}" target="_blank" rel="noopener noreferrer">View on TCGplayer</a>` : ''}
        ${isPullable(catalogCardKey) ? '<button class="btn" id="catalog-rip" type="button">Rip vs Buy</button>' : ''}
        </div>`;
    renderCatalogQuotes(card);
    renderGameplay(card);
    renderCatalogComps(card);
    renderWatchEditor(card);
    const historyKey = JSON.stringify([catalogCardKey, catalogPrinting, S.fetchedAt]);
    if (catalogHistoryKey !== historyKey) {
      catalogHistoryKey = historyKey;
      $('#catalog-market').textContent = printings ? 'Loading market analysis…' : '';
      if (printings) {
        showPriceHistory($('#catalog-history'), card.id, [catalogPrinting], renderCardMarket);
      } else $('#catalog-history').textContent = 'Refresh card data to identify the printing for this chart.';
    }
    catalogOptions($('#catalog-binder'), C.live(S.cols).map(col => [col.id, col.name]));
    const rip = $('#catalog-rip');
    if (rip) rip.addEventListener('click', () => {
      S.ripSet = card.set_id;
      S.ripCard = catalogCardKey;
      S.ripSearch = '';
      S.ripRarity = S.ripColor = 'all';
      $('#rip-search').value = '';
      $('#catalog-dialog').close();
      switchTab('rip');
    });
    renderCatalogOwnership();
  }

  function renderCatalogQuotes(card) {
    const alt = catalogPrinting === card.alt_printing?.printing ? card.alt_printing : null;
    $('#catalog-detail-market').textContent = catalogPrice(alt ? alt.market : card.market_price);
    $('#catalog-detail-low').textContent = catalogPrice(alt ? alt.low : card.inventory_price);
  }

  function renderGameplay(card) {
    const fields = [
      ['Type', card.card_type], ['Color', card.card_color], ['Cost', card.cost], ['Life', card.life],
      ['Power', card.power], ['Counter', card.counter], ['Attribute', card.attribute], ['Traits', card.subtypes]
    ].filter(([, value]) => value);
    const bandai = 'https://en.onepiece-cardgame.com';
    $('#catalog-gameplay').innerHTML = `
      ${fields.length ? `<dl class="market-evidence">${fields.map(([label, value]) =>
        `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>` : ''}
      ${card.rulesText ? `<h3>Card text</h3><p class="card-effect">${esc(card.rulesText)}</p>
        <p class="small muted">Text via TCGplayer. Check Bandai’s English reference for official wording and updates.</p>`
        : '<p class="small muted">Card text is unavailable in the catalog feed.</p>'}
      <h3>Bandai’s English reference</h3>
      <ul class="gameplay-links">
        <li><a href="${bandai}/cardlist/" target="_blank" rel="noopener noreferrer">Official card list</a></li>
        <li><a href="${bandai}/rules/" target="_blank" rel="noopener noreferrer">Rules and card rulings</a></li>
        <li><a href="${bandai}/rules/errata_card/" target="_blank" rel="noopener noreferrer">Card errata</a></li>
        <li><a href="${bandai}/news/restriction.html" target="_blank" rel="noopener noreferrer">Banned and restricted cards</a></li>
        <li><a href="${bandai}/products/" target="_blank" rel="noopener noreferrer">Product releases</a></li>
        <li><a href="${bandai}/events/" target="_blank" rel="noopener noreferrer">Organized play events</a></li>
      </ul>`;
  }

  function openCatalogCard(key, printing) {
    if (!S.byKey[key]) return;
    catalogCardKey = key;
    catalogPrinting = printing;
    watchEditorKey = null;
    showCardSection('market');
    catalogHistoryKey = null;
    $('#catalog-quantity').value = '1';
    renderCatalogCard();
    $('#catalog-dialog').showModal();
  }

  function showCardSection(section) {
    $$('#card-sections button').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.cardSection === section));
    });
    $$('[data-card-pane]', $('#catalog-dialog')).forEach(pane => {
      pane.hidden = pane.dataset.cardPane !== section;
    });
    $('#watch-editor').open = section === 'watch';
  }

  function renderCardMarket({ printing, points }) {
    const host = $('#catalog-market');
    const today = Math.floor(Date.now() / 86400000);
    const call = OQ_MARKET.analyze(points, today);
    const money = cents => E.money(cents / 100, 2);
    const last = points.at(-1);
    const date = last ? OQ_HISTORY.dateLabel(last[0]) : '';
    const range = values => values.map(money).join(' – ');
    const pct = value => (value > 0 ? '+' : '') + E.pct(value, 2);
    host.innerHTML = `
      <div class="history-toolbar">
        <h3>Market analysis${printing ? ' · ' + esc(printing) : ''}</h3>
        <strong class="market-call" data-call="${esc(call.call)}">${esc(signalLabels[call.call])}</strong>
      </div>
      <p class="small">${esc(call.reason)}</p>
      ${call.evidence === 'limited' ? '<p class="small muted">Limited evidence · Recent price history supports a Hold review.</p>' : ''}
      ${date ? `<p class="small muted">TCGplayer price history · ${esc(date)}${last[0] < today - 3 ? ' · Stale quote' : ''}</p>` : ''}
      ${call.market ? `
        <dl class="market-evidence">
          <div><dt>Analyzed Market Price</dt><dd>${money(call.market)}</dd></div>
          <div><dt>Analyzed lowest listing</dt><dd>${call.low > 0 ? money(call.low) : 'Unavailable'}</dd></div>
          <div><dt>${call.horizon}-day momentum</dt><dd>${pct(call.momentum)}</dd></div>
          ${call.low > 0 ? `<div><dt>Lowest listing vs. market</dt><dd>${pct(call.low / call.market - 1)}</dd></div>` : ''}
          ${call.evidence === 'full' ? `
          <div><dt>Typical 90-day range</dt><dd>${range(call.recentRange)}</dd></div>
          <div><dt>Typical one-year range</dt><dd>${range(call.year)}</dd></div>` : ''}
        </dl>` : ''}
      ${call.eligible ? `
        <details class="small market-rules">
          <summary>What would change the call?</summary>
          <p>Buy at a Market Price of ${money(call.buy.price)} or less with momentum of +5% or higher. The qualifying listing range is ${range([call.buy.minListing, call.buy.maxListing])} at the latest Market Price.</p>
          <p>Sell at a Market Price of ${money(call.sell.price)} or more with momentum of −5% or lower. The qualifying listing range is ${range([call.sell.minListing, call.sell.maxListing])} at the latest Market Price.</p>
          <p class="muted">Calls require a market price of at least $10 and distinct buy and sell thresholds. The ranges show the 10th–90th percentiles of observed prices. Momentum compares two seven-day medians about a month apart. Buy calls flag potential collection purchases. Sale volume and time to sell are unavailable.</p>
        </details>` : ''}
      ${last ? `
        <details class="small market-rules"${call.call === 'Sell Now' ? ' open' : ''}>
          <summary>Estimate sale proceeds</summary>
          <div class="market-evidence">
            <label class="fld"><span>Sale price ($)</span><input data-sale type="number" min="0.01" step="0.01" value="${(last[1] / 100).toFixed(2)}"></label>
            <label class="fld"><span>Your shipping cost ($)</span><input data-shipping type="number" min="0" step="0.01" value="${(OQ_MARKET.defaultShipping / 100).toFixed(2)}"></label>
          </div>
          <p>Estimated net <strong data-net aria-live="polite"></strong></p>
          <p class="muted">One US Marketplace Level 1–4 sale with seller-paid shipping, before buyer tax. <a href="https://help.tcgplayer.com/hc/en-us/articles/201357836-TCGplayer-Fees" target="_blank" rel="noopener noreferrer">TCGplayer fee schedule</a></p>
        </details>` : ''}
      <p class="small muted">Experimental flags use TCGplayer price snapshots. Sales volume, condition-specific quotes, and time to sell are unavailable in this feed. <a href="MARKET-BACKTEST.md" target="_blank" rel="noopener noreferrer">Backtest results</a></p>`;
    if (!last) return;
    const sale = host.querySelector('[data-sale]');
    const shipping = host.querySelector('[data-shipping]');
    const net = host.querySelector('[data-net]');
    const update = () => {
      const price = sale.valueAsNumber;
      const cost = shipping.valueAsNumber;
      net.textContent = Number.isFinite(price) && price > 0 && Number.isFinite(cost) && cost >= 0
        ? money(OQ_MARKET.saleProceeds(Math.round(price * 100), Math.round(cost * 100))) : '—';
    };
    sale.addEventListener('input', update);
    shipping.addEventListener('input', update);
    update();
  }

  function renderCatalogOwnership(message = '') {
    const card = S.byKey[catalogCardKey];
    const printing = catalogPrinting ?? card?.printing;
    const label = printing || 'Finish unavailable';
    const binder = $('#catalog-binder').value;
    $('#catalog-add button[type="submit"]').disabled = !binder || printing == null;
    const count = itemsIn(binder).filter(item => String(item.key) === catalogCardKey &&
        holdingPrinting(item, card) === printing)
      .reduce((total, item) => total + Number(item.qty || 0), 0);
    $('#catalog-ownership').textContent = message || (count
      ? `${label} · ${count} in this binder`
      : `${label} · Add raw near-mint copies. Edit condition, grade, or purchase details in My Collection.`);
  }

  function wireArtworkViewer() {
    const dialog = $('#artwork-dialog');
    const viewport = $('#artwork-viewport');
    const image = $('#artwork-image');
    const status = $('#artwork-status');
    const zoomOut = $('#artwork-zoom-out');
    const zoomIn = $('#artwork-zoom-in');
    const fit = $('#artwork-fit');
    let zoom = 1;
    let ready = false;
    let returnFocus;

    function sizeImage() {
      zoomOut.disabled = !ready || zoom <= 1;
      zoomIn.disabled = !ready || zoom >= 3;
      fit.disabled = !ready;
      $('#artwork-zoom-level').textContent = zoom === 1 ? 'Fit' : `${zoom}×`;
      if (!ready) return;
      const ratio = image.naturalWidth / image.naturalHeight;
      const width = Math.min(Math.max(1, viewport.clientWidth - 32), Math.max(1, viewport.clientHeight - 32) * ratio);
      image.style.width = `${width * zoom}px`;
    }

    function changeZoom(next) {
      const old = zoom;
      const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / Math.max(1, viewport.scrollWidth);
      const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / Math.max(1, viewport.scrollHeight);
      zoom = Math.max(1, Math.min(3, next));
      sizeImage();
      if (zoom === 1) viewport.scrollTo(0, 0);
      else if (zoom !== old) viewport.scrollTo(centerX * viewport.scrollWidth - viewport.clientWidth / 2,
        centerY * viewport.scrollHeight - viewport.clientHeight / 2);
    }

    on('#catalog-preview', 'click', event => {
      const trigger = event.target.closest('[data-enlarge-artwork]');
      const card = S.byKey[catalogCardKey];
      if (!trigger || !card?.card_image) return;
      returnFocus = trigger;
      ready = false;
      zoom = 1;
      image.hidden = true;
      image.removeAttribute('src');
      image.style.width = '';
      status.hidden = false;
      status.textContent = 'Loading artwork…';
      $('#artwork-title').textContent = C.cardTitle(card.card_name, card.card_set_id);
      $('#artwork-number').textContent = [card.card_set_id || card.set_id, card.set_name || setName(card.set_id)].join(' · ');
      image.alt = `${C.cardTitle(card.card_name, card.card_set_id)} · ${card.card_set_id || card.set_id}`;
      sizeImage();
      dialog.showModal();
      viewport.scrollTo(0, 0);
      image.src = card.card_image;
    });
    image.addEventListener('load', () => {
      if (!dialog.open || !image.naturalWidth) return;
      ready = true;
      image.hidden = false;
      status.hidden = true;
      sizeImage();
    });
    image.addEventListener('error', () => {
      if (!dialog.open || !image.hasAttribute('src')) return;
      ready = false;
      image.hidden = true;
      status.hidden = false;
      status.textContent = 'Artwork could not load. Close this view and try again when connected.';
      sizeImage();
    });
    zoomOut.addEventListener('click', () => changeZoom(zoom - .5));
    zoomIn.addEventListener('click', () => changeZoom(zoom + .5));
    fit.addEventListener('click', () => changeZoom(1));
    on('#artwork-close', 'click', () => dialog.close());
    // Only a gesture that starts and ends on the backdrop dismisses the view.
    let backdropPress = false;
    dialog.addEventListener('pointerdown', event => { backdropPress = event.target === dialog; });
    dialog.addEventListener('click', event => {
      if (backdropPress && event.target === dialog) dialog.close();
      backdropPress = false;
    });
    dialog.addEventListener('close', () => {
      ready = false;
      zoom = 1;
      image.removeAttribute('src');
      image.hidden = true;
      viewport.scrollTo(0, 0);
      if ($('#catalog-dialog').open) {
        const trigger = returnFocus?.isConnected ? returnFocus : $('#catalog-preview [data-enlarge-artwork]');
        trigger?.focus({ preventScroll: true });
      }
      returnFocus = null;
    });
    $('#catalog-dialog').addEventListener('close', () => { if (dialog.open) dialog.close(); });
    window.addEventListener('resize', () => { if (dialog.open) sizeImage(); });
  }

  function wireCardScan() {
    const dialog = $('#scan-dialog'), video = $('#scan-video');
    const viewfinder = $('#scan-viewfinder'), entry = $('#scan-entry');
    const options = $('#scan-options'), controls = $('#scan-controls');
    const capture = $('#scan-capture'), camera = $('#scan-camera'), file = $('#scan-file');
    const number = $('#scan-number'), star = $('#scan-star');
    const status = $('#scan-status'), results = $('#scan-results');
    const more = $('#scan-more');
    let matchLimit = 24;
    const quality = $('#scan-quality'), automatic = $('#scan-auto');
    const sample = document.createElement('canvas');
    let sampleContext;
    try { sampleContext = sample.getContext('2d', { willReadFrequently: true }); } catch (_) { /* Manual capture remains available. */ }
    let stream, job, cameraRequest, previewTimer, recognizer, probeController, probeTask;
    let cameraSession = 0, capturing = false, previewStartedAt = 0;
    let lastVideoTime, lastFrameAt = 0, nextProbeAt = 0;
    let previousMatch = null, analysisUnavailable = false, recognized = null;
    let previousEvidence = null, missedProbes = 0, autoPaused = false;
    let autoStartedAt = null, autoPauseMessage = '';

    function cameraMode(active) {
      dialog.classList.toggle('camera-active', active);
      entry.hidden = options.hidden = active;
      viewfinder.hidden = controls.hidden = quality.hidden = !active;
      capture.disabled = true;
    }
    function stopCamera() {
      cameraSession++;
      clearTimeout(previewTimer); previewTimer = null;
      probeController?.abort(); recognizer?.close();
      recognizer = probeController = probeTask = null;
      previousMatch = previousEvidence = null; missedProbes = 0; lastVideoTime = undefined; autoStartedAt = null;
      sample.width = sample.height = 0;
      cameraRequest = null;
      stream?.getTracks().forEach(track => track.stop());
      stream = null; video.srcObject = null;
      camera.disabled = false;
      cameraMode(false);
    }
    function showQuality(message, state) {
      if (quality.textContent !== message) quality.textContent = message;
      quality.dataset.state = state;
    }
    function showProbeProgress(task) {
      const elapsed = performance.now() - task.startedAt;
      showQuality(elapsed >= 10000 ? 'This scan is taking longer. You can tap Scan card or cancel and try a closer photo.'
        : elapsed >= 5000 ? 'Still reading the card. Keep its text visible; Scan card is available at any time.'
        : task.phase, 'matching');
    }
    function pauseAutomatic(message) {
      automatic.checked = false; autoPaused = true; autoPauseMessage = message;
      probeController?.abort(); recognizer?.close();
      recognizer = probeController = probeTask = null;
      previousMatch = previousEvidence = null;
      showQuality(message, 'manual');
    }
    function automaticBudgetExpired() {
      if (!automatic.checked || autoStartedAt == null || performance.now() - autoStartedAt < 20000) return false;
      pauseAutomatic('Automatic matching paused after 20 seconds. Move closer, then enable Auto capture to retry, or tap Scan card.');
      return true;
    }
    function frameAvailable() {
      return video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    }
    function fullFrame() {
      return OQ_SCAN.picture(video, { width: video.videoWidth, height: video.videoHeight }, [0, 0, 1, 1],
        Math.min(1, 2400 / Math.max(video.videoWidth, video.videoHeight)));
    }
    function showMatches(evidence) {
      const keys = new Set(evidence.numbers.map(OQ_SCAN.normalize));
      const ids = new Set((evidence.candidates || []).map(candidate => String(candidate.id)));
      const ranking = new Map((evidence.candidates || []).map((candidate, i) => [String(candidate.id), i]));
      let matches = S.cards.filter(card => keys.size ? keys.has(OQ_SCAN.normalize(card.card_set_id)) : ids.has(String(card.id)))
        .map(card => ({ card, badge: E.rarityBadge(card) }));
      if (star.checked) matches = matches.filter(match => match.badge.star);
      matches.sort((a, b) => (ranking.get(String(a.card.id)) ?? 0) - (ranking.get(String(b.card.id)) ?? 0));
      results.innerHTML = matches.slice(0, matchLimit).map(({ card, badge }) => `
        <button class="catalog-tile" type="button" data-key="${esc(E.cardKey(card))}">
          ${cardArt(card, 'catalog-art')}
          <span class="catalog-tile-body"><strong>${esc(C.cardTitle(card.card_name, card.card_set_id))}</strong>
            <span class="small muted">${esc(card.card_set_id)} · ${esc(badge.label)}</span>
            <span class="catalog-tile-meta">${esc(card.set_name)}</span></span>
        </button>`).join('');
      const basis = keys.size ? (evidence.recoveredNumbers?.length ? ' Card number recovered from noisy text; check it against the card.' : '')
        : ' Matches are based on the card name; the number was not confirmed.';
      const starNote = star.checked ? ' Star present: showing only catalog printings marked with a star.' : '';
      const unknown = !keys.size && evidence.readNumbers?.length
        ? ` Read ${evidence.readNumbers.join(', ')}, which is not in the loaded catalog.` : '';
      more.hidden = matches.length <= matchLimit;
      status.textContent = matches.length
        ? `${matches.length > matchLimit ? 'Showing ' + matchLimit + ' of ' + matches.length : matches.length} possible ${matches.length === 1 ? 'printing' : 'printings'}. Confirm the artwork and card number.${basis}${unknown}${starNote}`
        : star.checked ? 'No starred printing is marked for these matches. Clear Star present to review all possible printings.'
          : evidence.readNumbers?.length
          ? `Read ${evidence.readNumbers.join(', ')}, but no matching card is in the loaded catalog. Check the number or refresh card data.`
          : 'No card identified yet. Try a closer, steadier view or enter the card number below.';
    }
    function acceptEvidence(evidence) {
      recognized = evidence;
      matchLimit = 24;
      number.value = evidence.numbers[0] || evidence.readNumbers?.[0] || '';
      star.checked = evidence.starred === true;
      showMatches(evidence);
    }
    async function scan(makeFrame) {
      job?.abort();
      const task = job = new AbortController();
      let frame;
      recognized = null; results.replaceChildren(); more.hidden = true; number.value = ''; star.checked = false;
      status.textContent = 'Preparing the scan…';
      try {
        frame = await makeFrame();
        if (task.signal.aborted) return;
        const result = await OQ_SCAN.recognize(frame, task.signal, stage => {
          if (!task.signal.aborted) status.textContent = stage === 'recognizing text' ? 'Reading card text…' : 'Loading the scanner…';
        }, { cards: S.cards, isStarred: card => E.rarityBadge(card).star });
        if (!task.signal.aborted) acceptEvidence(result);
      } catch (_) {
        if (!task.signal.aborted) status.textContent = 'Could not scan this photo. Try again or enter the card number below.';
      } finally {
        if (frame) frame.width = frame.height = 0;
        if (job === task) job = null;
      }
    }
    async function probe(session) {
      if (probeTask || !automatic.checked || !stream || !frameAvailable()) return;
      const enhanced = missedProbes >= 2 || previousEvidence?.enhanced === true;
      if (autoStartedAt == null) autoStartedAt = performance.now();
      const task = probeTask = { startedAt: performance.now(), phase: enhanced
        ? 'Trying a more detailed scan…' : 'Looking for a card number or name…' };
      let frame, usedRecognizer;
      try {
        frame = fullFrame();
        if (!recognizer) {
          probeController = new AbortController();
          recognizer = OQ_SCAN.createRecognizer(probeController.signal, stage => {
            if (session !== cameraSession || !automatic.checked || !probeTask) return;
            probeTask.phase = stage === 'recognizing text' ? (missedProbes >= 2
              ? 'Trying a more detailed scan…' : 'Looking for a card number or name…')
              : 'Loading the scanner. Keep one card visible…';
            showProbeProgress(probeTask);
          }, { cards: S.cards, isStarred: card => E.rarityBadge(card).star });
        }
        usedRecognizer = recognizer;
        showProbeProgress(task);
        const evidence = await usedRecognizer.recognize(frame, { probe: true, enhanced });
        if (session !== cameraSession || !dialog.open || document.hidden || !automatic.checked) return;
        if (automaticBudgetExpired()) return;
        // Two separate advancing camera observations must agree. OCR passes over
        // the same frozen frame do not count as separate observations.
        const signature = evidence.numbers.length ? 'number:' + [...evidence.numbers].sort().join(',')
          : evidence.name && !evidence.readNumbers.length ? 'name:' + evidence.name : null;
        if (signature && previousMatch === signature) {
          // A high-resolution pass also checks the printing star, even when
          // the smaller probes already read the card number.
          const alreadyDetailed = evidence.enhanced && previousEvidence?.enhanced;
          const confirmedStar = evidence.numbers.length && evidence.starred === true && previousEvidence?.starred === true;
          task.phase = alreadyDetailed || confirmedStar ? 'Card identified. Preparing possible printings…'
            : 'Card found. Checking its number and printing star…';
          showProbeProgress(task);
          // Two color-enhanced name observations already support a candidate
          // list. Repeating the entire slow manual pipeline cannot prove a
          // printing from unreadable text, so leave the uncertainty visible.
          const finalEvidence = alreadyDetailed || confirmedStar ? evidence : await usedRecognizer.recognize(frame, { probe: true, enhanced: true, confirm: true });
          if (session !== cameraSession || document.hidden || !automatic.checked) return;
          if (automaticBudgetExpired()) return;
          if (evidence.numbers.length && finalEvidence.numbers.length &&
              !finalEvidence.numbers.some(code => evidence.numbers.includes(code))) {
            previousMatch = null;
            showQuality('A different card was read. Keep one card visible to confirm.', 'searching');
            return;
          }
          if (!finalEvidence.numbers.length && (finalEvidence.readNumbers.length || !finalEvidence.candidates.length ||
              !finalEvidence.name || finalEvidence.name !== evidence.name)) {
            previousMatch = null;
            showQuality(finalEvidence.readNumbers.length
              ? 'Card number read, but it is not in the catalog. Try Scan card to review.'
              : 'Could not confirm the card. Keep it visible or try Scan card.', 'searching');
            return;
          }
          capturing = true;
          stopCamera(); acceptEvidence(finalEvidence); status.focus({ preventScroll: true });
          return;
        }
        previousMatch = signature;
        previousEvidence = signature ? evidence : null;
        missedProbes = signature ? 0 : missedProbes + 1;
        if (missedProbes >= 4) {
          pauseAutomatic('Could not identify this view automatically. Move closer, then enable Auto capture to retry, or tap Scan card.');
          return;
        }
        nextProbeAt = performance.now() + (signature ? 350 : 1800);
        showQuality(signature ? 'Possible card found. Keep it visible to confirm…' : evidence.readNumbers.length
          ? 'Card number read, but it is not in the catalog. Try Scan card to review.'
          : 'No match yet. Move closer or tilt to make the text clearer.', signature ? 'confirming' : 'searching');
      } catch (_) {
        if (session === cameraSession && automatic.checked && recognizer === usedRecognizer) {
          analysisUnavailable = true;
          showQuality('Automatic matching unavailable · Tap Scan card to retry', 'manual');
        }
      } finally {
        if (frame) frame.width = frame.height = 0;
        if (probeTask === task) {
          probeTask = null;
          if (nextProbeAt < performance.now()) nextProbeAt = performance.now() + 1800;
        }
      }
    }
    function preview(session) {
      if (session !== cameraSession || !stream || !dialog.open || document.hidden) return;
      const now = performance.now(); capture.disabled = !frameAvailable();
      automaticBudgetExpired();
      if (probeTask) showProbeProgress(probeTask);
      if (!frameAvailable()) {
        previousMatch = null;
        showQuality(now - previewStartedAt < 3000 ? 'Starting camera preview…' :
          'No camera frames yet. Cancel and reopen the camera, or choose a photo.', 'warming');
      } else if (!sampleContext || analysisUnavailable) {
        showQuality('Automatic matching unavailable · Tap Scan card when ready', 'manual');
      } else if (lastVideoTime === video.currentTime) {
        if (now - lastFrameAt > 1500) {
          previousMatch = null;
          showQuality('Camera preview paused. Cancel and reopen the camera, or choose a photo.', 'warming');
        }
      } else {
        lastVideoTime = video.currentTime; lastFrameAt = now;
        try {
          sample.width = 160; sample.height = Math.max(80, Math.round(160 * video.videoHeight / video.videoWidth));
          sampleContext.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, sample.width, sample.height);
          const result = OQ_SCAN.analyzeFrame(sampleContext.getImageData(0, 0, sample.width, sample.height));
          if (result.state !== 'ready') {
            previousMatch = null;
            if (!probeTask) showQuality(result.message, result.state);
          } else if (!automatic.checked) {
            showQuality(autoPaused ? autoPauseMessage
              : 'Auto capture off · Tap Scan card when ready', 'manual');
          } else if (!probeTask && now >= nextProbeAt) {
            probe(session);
          }
        } catch (_) {
          analysisUnavailable = true;
          showQuality('Automatic matching unavailable · Tap Scan card when ready', 'manual');
        }
      }
      previewTimer = setTimeout(() => preview(session), 160);
    }
    on('#scan-open', 'click', () => {
      recognized = null; matchLimit = 24; more.hidden = true;
      number.value = status.textContent = ''; star.checked = false; results.replaceChildren();
      $('.scan-content', dialog).scrollTop = 0; dialog.showModal();
    });
    function closeScanner() { job?.abort(); stopCamera(); file.value = ''; dialog.close(); }
    on('#scan-close', 'click', closeScanner);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeScanner(); });
    camera.addEventListener('click', async () => {
      job?.abort(); stopCamera(); capturing = false;
      const request = cameraRequest = {}; camera.disabled = true; status.textContent = 'Waiting for camera access…';
      try {
        const next = await navigator.mediaDevices.getUserMedia({ video: {
          facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (!dialog.open || document.hidden || cameraRequest !== request) { next.getTracks().forEach(track => track.stop()); return; }
        stream = next; video.srcObject = stream;
        next.getVideoTracks()[0]?.addEventListener('ended', () => {
          if (stream !== next) return;
          stopCamera(); status.textContent = 'Camera disconnected. Reopen it or choose a photo.'; status.focus();
        }, { once: true });
        cameraMode(true); previewStartedAt = lastFrameAt = performance.now();
        nextProbeAt = 0; analysisUnavailable = false; autoPaused = false;
        showQuality('Starting camera preview…', 'warming'); $('#scan-cancel-camera').focus({ preventScroll: true });
        try {
          Promise.resolve(video.play()).catch(() => {
            if (stream !== next || !dialog.open || cameraRequest !== request) return;
            stopCamera(); status.textContent = 'Camera preview could not start. Tap Use camera to retry or choose a photo.';
          });
        } catch (_) { stopCamera(); status.textContent = 'Camera preview could not start. Tap Use camera to retry or choose a photo.'; return; }
        preview(cameraSession);
      } catch (_) {
        if (dialog.open && cameraRequest === request) { camera.disabled = false; status.textContent = 'Camera unavailable. Choose a photo or enter a card number.'; }
      }
    });
    on('#scan-cancel-camera', 'click', () => { stopCamera(); status.textContent = ''; camera.focus(); });
    function captureFrame() {
      if (capturing || !stream || !dialog.open || document.hidden || !frameAvailable()) return;
      capturing = true;
      let frame;
      try { frame = fullFrame(); }
      catch (_) { capturing = false; showQuality('Could not capture this frame. Try Scan card again.', 'manual'); return; }
      stopCamera(); scan(() => frame); status.focus({ preventScroll: true });
    }
    capture.addEventListener('click', captureFrame);
    automatic.addEventListener('change', () => {
      previousMatch = previousEvidence = null; missedProbes = 0; autoPaused = false; autoStartedAt = null;
      if (!automatic.checked) {
        probeController?.abort(); recognizer?.close(); recognizer = null; probeController = null;
        showQuality('Auto capture off · Tap Scan card when ready', 'manual');
      } else { analysisUnavailable = false; nextProbeAt = 0; }
    });
    function suspendScanner() {
      if (job && !stream && !cameraRequest) { job.abort(); status.textContent = 'Scan paused. Retake the photo or enter a card number.'; }
      if (!stream && !cameraRequest) return;
      stopCamera(); job?.abort(); status.textContent = 'Camera paused. Tap Use camera to resume.';
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) suspendScanner(); });
    window.addEventListener('pagehide', () => { job?.abort(); suspendScanner(); });
    dialog.addEventListener('close', () => { job?.abort(); stopCamera(); });
    file.addEventListener('change', () => {
      const photo = file.files[0]; file.value = ''; if (!photo) return;
      stopCamera(); scan(async () => {
        const bitmap = await createImageBitmap(photo);
        try { return OQ_SCAN.picture(bitmap, bitmap, [0, 0, 1, 1], Math.min(1, 2800 / Math.max(bitmap.width, bitmap.height))); }
        finally { bitmap.close(); }
      });
    });
    on('#scan-lookup', 'submit', event => {
      event.preventDefault(); job?.abort(); stopCamera();
      matchLimit = 24;
      recognized = { numbers: [number.value], readNumbers: [number.value], candidates: [], starred: star.checked };
      showMatches(recognized);
    });
    star.addEventListener('change', () => { if (recognized) showMatches(recognized); });
    more.addEventListener('click', () => {
      if (!recognized) return;
      matchLimit += 24;
      showMatches(recognized);
    });
    results.addEventListener('click', event => {
      const match = event.target.closest('[data-key]'); if (!match) return;
      closeScanner(); openCatalogCard(match.dataset.key);
    });
  }

  function wireCatalog() {
    wireArtworkViewer();
    wireCardScan();
    wireCatalogComps();
    wireWatchlist();
    on('#card-sections', 'click', event => {
      const button = event.target.closest('[data-card-section]');
      if (button) showCardSection(button.dataset.cardSection);
    });
    const compact = matchMedia('(max-width: 1050px)');
    const syncFilters = () => { $('.catalog-filters').open = !compact.matches; };
    syncFilters();
    compact.addEventListener('change', syncFilters);
    const reset = () => {
      catalogLimit = CATALOG_PAGE;
      renderCatalogResults();
    };
    on('#catalog-query', 'input', reset);
    for (const filter of [...catalogFilters, 'sort']) on('#catalog-' + filter, 'change', reset);
    on('#catalog-clear', 'click', () => {
      for (const filter of catalogFilters) $('#catalog-' + filter).value = '';
      reset();
      $('#catalog-set').focus({ preventScroll: true });
    });
    on('#catalog-more', 'click', () => {
      catalogLimit += CATALOG_PAGE;
      renderCatalogResults(true);
    });
    on('#catalog-grid', 'click', event => {
      const tile = event.target.closest('button[data-key]');
      if (!tile) return;
      openCatalogCard(tile.dataset.key);
    });
    on('#featured-cards', 'click', event => {
      const tile = event.target.closest('button[data-key]');
      if (tile) openCatalogCard(tile.dataset.key);
    });
    on('#catalog-close', 'click', () => $('#catalog-dialog').close());
    on('#sealed-history-close', 'click', () => $('#sealed-history-dialog').close());
    on('#catalog-binder', 'change', () => renderCatalogOwnership());
    on('#catalog-finish', 'change', event => {
      catalogPrinting = event.currentTarget.value;
      renderCatalogCard();
    });
    on('#catalog-add', 'submit', event => {
      event.preventDefault();
      const binder = liveCols().find(col => sameBinder(col.id, $('#catalog-binder').value));
      const qty = $('#catalog-quantity').valueAsNumber;
      const card = S.byKey[catalogCardKey];
      const printing = catalogPrinting ?? card?.printing;
      if (!binder || !card || printing == null || (printing !== card.printing && printing !== card.alt_printing?.printing) ||
          !Number.isInteger(qty) || qty < 1 || qty > 9999) return;
      S.items.push(C.newItem(binder.id, catalogCardKey, { qty, printing, src: 'buy' }));
      if (!persistCollection()) {
        renderCatalogOwnership('Could not save. Free up browser storage and try again.');
        return;
      }
      S.curCol = binder.id;
      renderCatalogOwnership(`Added ${qty}${printing ? ' ' + printing : ''} to ${binder.name}.`);
      if (S.tab === 'signals' && $('#sig-scope').value === 'owned') renderScannerResults();
    });
  }

  /* =============================================================== SHELL == */

  function switchTab(tab) {
    S.tab = tab;
    $('#nav-toggle').setAttribute('aria-expanded', 'false');
    $$('#tabs button').forEach(button => {
      const active = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && button.offsetParent) {
        const nav = $('#tabs');
        const bounds = nav.getBoundingClientRect();
        const item = button.getBoundingClientRect();
        if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right;
        if (item.left < bounds.left) nav.scrollLeft += item.left - bounds.left;
      }
    });
    $$('.view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== tab));
    renderActive();
    wireCollapsibles();
    window.scrollTo({ top: 0, behavior: 'instant' });

  }

  /**
   * Renders are wrapped because a single bad card record should not blank the
   * whole tab with nothing but a console error the user will never open.
   * Failing visibly beats failing silently.
   */
  function renderActive() {
    const fns = {
      catalog: renderCatalog,
      watchlist: refreshWatchlist,
      rip: renderRip, collection: renderCollection,
      sets: renderSets, signals: renderSignals, settings: renderSettings
    };
    const fn = fns[S.tab];
    if (!fn) return;
    const banner = $('#render-error');
    try {
      fn();
      if (S.tab !== 'watchlist') refreshWatchlist();
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

  function wireSelectLabels() {
    if (!CSS.supports('appearance', 'base-select') || !CSS.supports('selector(::picker(select))')) return;
    function addLabel(select) {
      if (select.multiple || select.size > 1 || select.firstElementChild?.matches('button')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.append(document.createElement('selectedcontent'));
      select.prepend(button);
    }
    $$('select').forEach(addLabel);
    // Several views replace their options or render new selects after a data refresh.
    new MutationObserver(records => {
      for (const { target, addedNodes } of records) {
        if (target instanceof HTMLSelectElement) addLabel(target);
        else for (const node of addedNodes) {
          if (node instanceof HTMLSelectElement) addLabel(node);
          else if (node instanceof HTMLElement) $$('select', node).forEach(addLabel);
        }
      }
    }).observe($('#app'), { childList: true, subtree: true });
  }

  function wire() {
    wireSelectLabels();
    wireBackup();
    const tabs = $$('#tabs button');
    tabs.forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
    on('#nav-toggle', 'click', event => {
      const button = event.currentTarget;
      const expanding = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(expanding));
      if (expanding) $('#tabs [aria-selected="true"]')?.focus();
    });
    on('#tabs', 'click', () => {
      if ($('#nav-toggle').offsetWidth) $('#nav-toggle').focus();
    });
    document.addEventListener('click', event => {
      const toggle = $('#nav-toggle');
      if (toggle.getAttribute('aria-expanded') !== 'true' || event.target.closest('#nav-toggle, #tabs')) return;
      toggle.setAttribute('aria-expanded', 'false');
      if ($('#tabs').contains(document.activeElement)) toggle.focus();
    });
    on('#collection-mode', 'click', event => {
      const button = event.target.closest('[data-binder-mode]');
      if (!button) return;
      const editing = button.dataset.binderMode === 'table';
      $$('#collection-mode button').forEach(option => {
        option.setAttribute('aria-pressed', String(option === button));
      });
      $('#binder-gallery').hidden = editing;
      $('#binder-table').hidden = !editing;
    });
    on('#binder-gallery', 'click', event => {
      const button = event.target.closest('[data-key]');
      if (button) openCatalogCard(button.dataset.key, button.dataset.printing);
    });
    on('#tabs', 'keydown', event => {
      const toggle = $('#nav-toggle');
      if (event.key === 'Escape' && toggle.offsetWidth) {
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
        return;
      }
      const index = tabs.indexOf(event.target);
      if (index < 0) return;
      const next = { ArrowRight: (index + 1) % tabs.length, ArrowDown: (index + 1) % tabs.length,
        ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowUp: (index + tabs.length - 1) % tabs.length,
        Home: 0, End: tabs.length - 1 }[event.key];
      if (!Number.isInteger(next)) return;
      event.preventDefault();
      switchTab(tabs[next].dataset.tab);
      if (toggle.offsetWidth) toggle.setAttribute('aria-expanded', 'true');
      tabs[next].focus();
    });
    on('#brand-home', 'click', () => {
      switchTab('catalog');
      $('#catalog-query').focus({ preventScroll: true });
    });
    wireCatalog();

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
    on('#col-list', 'click', event => {
      const button = event.target.closest('button[data-col]');
      if (!button) return;
      const binder = liveCols().find(col => sameBinder(col.id, button.dataset.col));
      if (!binder) return;
      if (!sameBinder(S.curCol, binder.id)) {
        S.curCol = binder.id;
        $('#col-query').value = '';
        $('#col-sell').setAttribute('aria-pressed', 'false');
        renderCollection();
      }
      if (MOBILE()) {
        const heading = $('#col-title');
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: 'start' });
      } else {
        $('#col-list .binder[aria-pressed="true"]')?.focus({ preventScroll: true });
      }
    });
    on('#col-search-catalog', 'click', () => {
      switchTab('catalog');
      $('#catalog-query').focus({ preventScroll: true });
    });
    on('.collection-add', 'toggle', e => {
      if (e.currentTarget.open) renderAddGrid();
    });
    on('#col-query', 'input', () => renderColTable(currentCol()));
    on('#col-sort', 'change', () => renderColTable(currentCol()));
    on('#col-sell', 'click', e => {
      e.currentTarget.setAttribute('aria-pressed', String(e.currentTarget.getAttribute('aria-pressed') !== 'true'));
      renderColTable(currentCol());
    });
    on('#col-tbl', 'click', e => {
      const button = e.target.closest('button[data-key]');
      if (button) openCatalogCard(button.dataset.key, button.dataset.printing);
    });
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
      if (persistCollection()) $('#op-cost').value = '';
      renderCollection();
    });
    on('#add-set', 'change', e => { S.addSet = e.target.value; renderAddGrid(); });
    on('#add-min', 'change', renderAddGrid);
    let addTimer = null;
    on('#add-search', 'input', e => {
      const v = e.target.value;
      clearTimeout(addTimer);
      addTimer = setTimeout(() => { S.addSearch = v; renderAddGrid(); }, 180);
    });

    wireSignals();

    const setSortHeaders = $$('#sets-tbl th[data-sort]');
    catalogOptions($('#sets-sort'), setSortHeaders.flatMap(th => {
      const by = th.dataset.sort;
      const label = th.textContent.trim();
      return by === 'name' ? [[by + ':1', 'Set name (A–Z)'], [by + ':-1', 'Set name (Z–A)']]
        : [[by + ':-1', label + ' (high to low)'], [by + ':1', label + ' (low to high)']];
    }));
    on('#sets-sort', 'change', event => {
      const [by, dir] = event.currentTarget.value.split(':');
      S.sort.sets = { by, dir: Number(dir) };
      renderSets();
    });
    setSortHeaders.forEach(th => th.addEventListener('click', () => {
      const by = th.dataset.sort;
      S.sort.sets = { by, dir: S.sort.sets.by === by ? -S.sort.sets.dir : -1 };
      renderSets();
    }));
    on('#set-analysis-close', 'click', () => $('#set-analysis-dialog').close());
    on('#set-box-product', 'change', renderSetAnalysis);
    on('#sets-analysis-retry', 'click', () => {
      sealedRun = null;
      renderSets();
    });
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

      const candidate = url || SRC.defaultBase;
      if (candidate !== './mockapi' && !(await testDataSource(candidate))) return;

      if (url) localStorage.setItem(SRC.dataUrlKey, url);
      else localStorage.removeItem(SRC.dataUrlKey);
      msg.textContent = 'Saved. Reloading card data…';
      try {
        // The cached rows came from the old source; force a full refetch.
        try { localStorage.removeItem(KEY.cards); } catch (_) {}
        await fetchCards(true);
        runKeyMigration();
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
      try { await fetchCards(true); runKeyMigration(); invalidate(); renderSettings(); renderActive(); }
      catch (err) { alert('Refresh failed: ' + err.message); }
      btn.disabled = false; btn.textContent = 'Refresh prices';
    });
    on('#retry', 'click', boot);
  }

  /* ================================================================ BOOT == */

  /* Repoint v1 collection rows onto productIds, once, on the first v2 boot.

     Runs after the cards are loaded because it needs them to match against,
     and before any render, so nothing ever paints a v1 key as a $0 unknown
     card. Rows that cannot be matched are LEFT ALONE and surfaced — a wrong
     match is worse than an unmigrated row, because the row still looks fine
     while pointing at the wrong card.

     The original row ID keeps the holding and its other details intact. */
  function runKeyMigration() {
    if (!S.cards.length || !S.items.some(it => !it.deleted && C.needsKeyMigration(it))) return;

    const res = C.migrateKeys(S.items, S.cards);
    S.items = res.items;
    S.migrationReport = {
      at: Date.now(),
      migrated: res.migrated,
      unmatched: res.unmatched.length,
      ambiguous: res.ambiguous.length,
      examples: res.unmatched.slice(0, 8).map(it => it.key)
    };

    if (res.migrated && !persistCollection()) {
      S.migrationReport = null;
      return;
    }
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

  let wired = false;
  async function boot() {
    const sharedUpdate = $('#shared-history-update');
    OQ_HISTORY.sharedStatus().then(stamp => {
      const date = new Date(stamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      const stale = Date.now() - stamp > 36 * 60 * 60 * 1000;
      sharedUpdate.textContent = 'Shared price history updated ' + date + (stale ? ' · Update overdue' : '');
    }).catch(() => {
      sharedUpdate.textContent = 'Shared price history update time unavailable';
    });
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
      if (!wired) {
        wire();
        window.addEventListener('storage', event => {
          if (event.key !== KEY.collection) return;
          applyCollection(collectionState());
          backup.change();
          if (['collection', 'signals', 'watchlist'].includes(S.tab)) renderActive();
          if ($('#catalog-dialog').open) renderCatalogOwnership();
        });
        wired = true;
        document.addEventListener('visibilitychange', () => backup.refresh());
      }
      if (ensureCollections() || !committedCollection.backupId) persistCollection();
      backup.refresh();
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
        refreshCachedCards().then(() => { runKeyMigration(); invalidate(); renderActive(); }).catch(() => {});
      }
      if (collapsePermanent('boot')) persistCollection();
      runKeyMigration();

      $('#boot').classList.add('hidden');
      $('#app').classList.remove('hidden');
      switchTab('catalog');

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
        ? 'The local sample could not load. Start the local server or enter a Worker URL in Settings.'
        : esc(err.message) + '<br><span class="small muted">Data source: ' +
          esc(SRC.base()) + '</span>';
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})(OQ_DATA, OQ_ENGINE, OQ_COLLECTION);

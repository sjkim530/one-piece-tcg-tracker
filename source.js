/* source.js — where card data comes from in v2.
   ============================================================================

   v1 read optcgapi: four JSON catalogues, two price fields, one image per card
   NUMBER rather than per printing. v2 reads TCGplayer's own catalogue through
   TCGCSV, one CSV per set, proxied by the Worker in worker/.

   What that buys, all measured rather than assumed:
     7,200 products against 5,292        (and OP-17, which optcgapi lacks)
     627 sealed products incl. 19 booster boxes and 19 cases — v1 had none
     five price points against two
     correct artwork per printing        (v1 served the plain card's picture
                                          for 55 cards and a "coming soon"
                                          graphic for 30 more)

   What it costs: no price history. TCGCSV publishes today's build and discards
   yesterday's, so the trend chart is gone, and with it the per-card "priced N
   days ago" badge — TCGplayer exposes no per-card scrape time. Deliberate
   trade, see the changelog.

   This file does fetching and shaping only. Nothing here touches the DOM, and
   nothing decides what a card is worth; that stays in engine.js.
*/

window.SRC = (function () {
  'use strict';

  /* ------------------------------------------------------------------ CSV -- */

  /* A real RFC 4180 parser, not a split on newlines.

     That shortcut looks fine until you hit a card with rules text, because the
     Description column contains commas, doubled quotes AND literal newlines
     inside its quotes — "[On Play] <strong>...</strong>: Draw 1 card.<br>" runs
     across lines in the raw file. Splitting on \n tears those rows in half and
     silently shifts every column after it. */
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;

    // A leading BOM would otherwise become part of the first header name,
    // making the 'productId' lookup miss on every row.
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    for (let i = 0; i < text.length; i++) {
      const c = text[i];

      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
          else inQuotes = false;
        } else field += c;
        continue;
      }

      if (c === '"') { inQuotes = true; continue; }
      if (c === ',') { row.push(field); field = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += c;
    }
    // Final row, unless the file ended with a clean newline.
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    if (!rows.length) return [];
    const head = rows[0];
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      if (rows[r].length === 1 && rows[r][0] === '') continue;   // blank line
      const o = {};
      for (let c = 0; c < head.length; c++) o[head[c]] = rows[r][c];
      out.push(o);
    }
    return out;
  }

  /* ------------------------------------------------------------- transport -- */

  /* The Worker's base URL. Not in source — it is per-deployment, and keeping
     it in localStorage means the same committed files work against the local
     snapshot, a dev Worker and the real one without editing anything.

     Falls back to the on-disk snapshot in mockapi/, which mirrors the Worker's
     routes exactly, so the app is fully usable before the Worker exists. */
  function base() {
    const u = (localStorage.getItem('optcg.dataUrl') || '').trim();
    return u ? u.replace(/\/+$/, '') : './mockapi';
  }

  function isMock() { return base() === './mockapi'; }

  async function get(path) {
    const r = await fetch(base() + path, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
    return r;
  }

  async function loadUpdated() {
    try { return (await (await get('/updated')).text()).trim(); }
    catch (e) { return null; }
  }

  async function loadGroups() {
    const j = await (await get('/groups')).json();
    return j.results || [];
  }

  /* --------------------------------------------------------------- mapping -- */

  const num = v => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  /* TCGplayer serves _200w thumbnails in the catalogue. The same path with
     _400w is a real file (verified) and is what the card page wants; the grid
     is happy with either, so we take the sharper one everywhere. */
  const bigImage = u => (u || '').replace(/_200w\.jpg$/, '_400w.jpg');

  /* A row is a CARD if it has a card number OR a card type; a sealed PRODUCT
     has neither.

     The card-number test alone is not enough, and getting this wrong is
     expensive: DON!! cards ship with an EMPTY extNumber and would every one of
     them be filed as sealed product, silently deleting 242 cards including the
     $86 Gold ones. They do carry extCardType "DON!!". Booster boxes, cases,
     packs and deck displays carry neither field. */
  function isCard(row) {
    return !!((row.extNumber || '').trim() || (row.extCardType || '').trim());
  }

  const isDon = row => (row.extCardType || '').trim() === 'DON!!';

  /* DON!! variant, read from the name.

     Kept identical to v1's wording because engine.js prints it and rarityBadge
     switches on it; changing the strings here would change what the badge says
     without anyone touching the badge. */
  function donVariant(name) {
    if (/\(Gold\)/.test(name))          return 'Gold DON!!';
    if (/\(Silver\)/.test(name))        return 'Silver DON!!';
    if (/Manga/.test(name))             return 'Manga DON!!';
    if (/Alternate Art/.test(name))     return 'Alt Art DON!!';
    return 'DON!!';
  }

  function toCard(row, set) {
    const don = isDon(row);
    if (don) {
      return {
        id: row.productId,
        card_name: row.name,
        card_set_id: row.extNumber || row.productId,
        set_id: set.id,
        set_name: set.name,
        // engine.js branches on rarity === 'DON'. TCGplayer files these under
        // PR or DON!! depending on the group, so it is normalised here rather
        // than teaching the engine about two more spellings.
        rarity: 'DON',
        card_color: (row.extColor || '').trim(),
        card_type: 'DON!!',
        card_image: bigImage(row.imageUrl),
        buy_url: row.url || '',
        printing: row.subTypeName || '',
        donBooster: set.kind === 'booster',
        donProduct: set.kind === 'booster' ? null : set.name,
        donVariant: donVariant(row.name),
        productKind: set.kind === 'booster' ? undefined : set.kind,
        originSet: set.origin,
        market_price: num(row.marketPrice),
        inventory_price: num(row.lowPrice),
        mid_price: num(row.midPrice),
        high_price: num(row.highPrice),
        direct_low_price: num(row.directLowPrice)
      };
    }
    return {
      // TCGplayer's productId is genuinely unique. v1 had to build a composite
      // key because card_set_id collided 723 times, card_image_id 41 times, and
      // set+image still collided 28 times. All of that goes away here.
      id: row.productId,
      card_name: row.name,
      card_set_id: row.extNumber,
      set_id: set.id,
      set_name: set.name,
      rarity: (row.extRarity || '').trim(),
      card_color: (row.extColor || '').trim(),
      card_type: (row.extCardType || '').trim(),
      card_image: bigImage(row.imageUrl),
      buy_url: row.url || '',
      printing: row.subTypeName || '',

      // Non-booster provenance, same contract as v1: undefined for pack cards,
      // 'deck' or 'promo' otherwise, with the originating set kept separately
      // so a judge card still shows where its art came from without being
      // dropped into that set's pull pool.
      productKind: set.kind === 'booster' ? undefined : set.kind,
      originSet: set.origin,

      // Five price points where v1 had two. market_price and inventory_price
      // keep their v1 names so the engine and collection code need no edits;
      // inventory_price is TCGplayer's low, the closest analogue to the
      // "cheapest listed right now" number v1 showed.
      market_price: num(row.marketPrice),
      inventory_price: num(row.lowPrice),
      mid_price: num(row.midPrice),
      high_price: num(row.highPrice),
      direct_low_price: num(row.directLowPrice)
    };
  }

  function toProduct(row, set) {
    return {
      id: row.productId,
      name: row.name,
      set_id: set.id,
      image: bigImage(row.imageUrl),
      buy_url: row.url || '',
      market_price: num(row.marketPrice),
      low_price: num(row.lowPrice),
      mid_price: num(row.midPrice),
      high_price: num(row.highPrice),
      kind: productKind(row.name)
    };
  }

  /* Sealed products are only distinguishable by name — TCGplayer has no type
     field for them. Order matters: "Booster Box Case" contains "Booster Box",
     so the case test has to run first or every case is filed as a box. */
  function productKind(name) {
    const n = (name || '').toLowerCase();
    if (/booster box case/.test(n))      return 'case';
    if (/booster box/.test(n))           return 'box';
    if (/sleeved booster pack/.test(n))  return 'sleevedpack';
    if (/booster pack/.test(n))          return 'pack';
    if (/starter deck|structure deck/.test(n)) return 'deck';
    if (/display/.test(n))               return 'display';
    return 'other';
  }

  /* ------------------------------------------------------------- set list -- */

  /* Turn TCGCSV's 84 groups into the set namespace the rest of the app speaks.

     v1 got this namespace from optcgapi and had to fight it: promos arrived
     carrying their ORIGINATING set id, which collided with booster ids and
     dropped judge and regional cards into booster pull pools, inflating their
     EV. 296 promos also shared a card_image_id with a booster card. Building
     the namespace ourselves means those collisions cannot occur — a group is
     one thing, and we decide what it is.

     Three kinds:
       booster  a rippable set, listed in data.js with pull rates and a profile
       deck     a starter/ultra deck; real cards, but never pulled from packs
       promo    everything else — promotion cards, pre-release, release event,
                anniversary, demo deck, revision packs, collection sets

     Anything new TCGplayer adds lands in `promo` rather than vanishing, which
     is the safe direction: it stays searchable and collectable, it just does
     not contribute to any set's pull odds. */
  function classifyGroup(group, boosterSets) {
    const booster = boosterSets.find(s => s.group === group.groupId);
    if (booster) {
      return Object.assign({}, booster, { kind: 'booster', origin: undefined });
    }

    const abbr = (group.abbreviation || '').trim();

    // "ST-29", "ST-01 PRE", "ST-13". The pre-release printings are separate
    // products but belong with their deck for browsing purposes.
    const st = abbr.match(/^ST-?(\d{1,2})/);
    if (st) {
      const id = 'ST-' + st[1].padStart(2, '0');
      return { id, group: group.groupId, name: group.name, short: id,
               kind: 'deck', origin: abbr };
    }

    return { id: PROMO_SET, group: group.groupId, name: group.name,
             short: abbr || group.name, kind: 'promo', origin: abbr || group.name };
  }

  const PROMO_SET = 'PROMO';

  /* Every group, classified. Booster sets keep their data.js metadata. */
  async function buildSets(boosterSets) {
    const groups = await loadGroups();
    return groups.map(g => classifyGroup(g, boosterSets));
  }

  /* ------------------------------------------------------------------ load -- */

  /* One set's worth of data: one HTTP request, one CSV, cards and sealed
     products separated.

     A product can appear twice, once per printing (Normal and Foil). We keep
     whichever row actually carries a market price, preferring the priced one,
     so a card is never shown as $0 because we happened to pick its unpriced
     printing. */
  async function loadSet(set) {
    const text = await (await get('/g/' + set.group)).text();
    const rows = parseCsv(text);

    /* One productId, two printings.

       90 products across the catalogue ship as a Normal AND a Foil row under
       the SAME productId, and both carry a price — often wildly different:
       Boa Hancock (Sealed Battle 2024 Vol. 2) is $9.27 Normal against $176.58
       Foil, a 19x spread. This used to keep whichever row appeared first in
       the CSV, so the price shown was decided by file order.

       Now it is deterministic: Normal wins, because that is the printing
       people mean by "the card" and the one most likely to be in a binder.
       The other printing is not discarded — it rides along as `alt` so the
       card page can show both rather than quietly picking one. */
    const pick = {}, products = {};
    for (const row of rows) {
      if (!row.productId) continue;
      const isC = isCard(row);
      const key = row.productId;
      const store = isC ? pick : products;
      const prev = store[key];

      if (!prev) { store[key] = row; continue; }

      const prevPriced = num(prev.marketPrice) != null;
      const thisPriced = num(row.marketPrice) != null;

      if (thisPriced && !prevPriced) { store[key] = row; continue; }  // priced beats unpriced
      if (!thisPriced) continue;

      // Both priced: prefer Normal, deterministically.
      const prevNormal = (prev.subTypeName || '') === 'Normal';
      const thisNormal = (row.subTypeName || '') === 'Normal';
      if (thisNormal && !prevNormal) store[key] = row;
    }

    // Attach the printing we did not choose, so nothing is silently dropped.
    const alts = {};
    for (const row of rows) {
      if (!row.productId || !isCard(row)) continue;
      const chosen = pick[row.productId];
      if (!chosen || chosen === row) continue;
      if (num(row.marketPrice) == null) continue;
      alts[row.productId] = { printing: row.subTypeName || 'Other',
                              market: num(row.marketPrice), low: num(row.lowPrice) };
    }

    return {
      cards: Object.keys(pick).map(k => {
        const c = toCard(pick[k], set);
        if (alts[k]) c.alt_printing = alts[k];
        return c;
      }),
      products: Object.keys(products).map(k => toProduct(products[k], set))
    };
  }

  /* Every set the app knows about, loaded in parallel.

     Parallel is safe here in a way it would not be against TCGCSV directly:
     these all hit the Worker, which serves them from its edge cache and only
     touches upstream once a day. Failures are reported per set rather than
     failing the whole load, so one bad set cannot leave the app with nothing. */
  async function loadAll(sets, onProgress) {
    let done = 0;
    const results = await Promise.all(sets.map(async set => {
      try {
        const r = await loadSet(set);
        return { set, ok: true, cards: r.cards, products: r.products };
      } catch (err) {
        return { set, ok: false, error: String(err), cards: [], products: [] };
      } finally {
        done++;
        if (onProgress) onProgress(done, sets.length);
      }
    }));

    const cards = [], products = [], failed = [];
    for (const r of results) {
      if (!r.ok) failed.push({ set: r.set.id, error: r.error });
      cards.push.apply(cards, r.cards);
      products.push.apply(products, r.products);
    }
    return { cards, products, failed };
  }

  return {
    parseCsv, loadSet, loadAll, loadGroups, loadUpdated, buildSets, classifyGroup,
    toCard, toProduct, productKind, bigImage, isCard, isDon, donVariant,
    base, isMock, PROMO_SET
  };
})();

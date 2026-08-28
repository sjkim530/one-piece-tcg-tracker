/* ============================================================================
   OPTCG QUANT — engine.js
   All the math. No DOM access in this file.
   ========================================================================== */

const OQ_ENGINE = (function (D) {
  'use strict';

  /* ==========================================================================
     1. CARD CLASSIFICATION
     ========================================================================== */

  /**
   * Pull the variant markers out of a card name.
   * Only exact whitelisted tags count — "(Galdino)" and "(001)" are not variants.
   */
  function parseVariants(cardName) {
    const found = [];
    const re = /\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(cardName)) !== null) {
      const tag = m[1].trim();
      if (Object.prototype.hasOwnProperty.call(D.VARIANT_TAGS, tag)) found.push(tag);
    }
    return found;
  }

  /**
   * Decide which pull slot a card occupies.
   * Highest-ranked variant wins: "Shanks (Parallel) (Manga) (Alternate Art)"
   * is a Manga Rare, not a Parallel.
   * Returns null for anything that cannot come out of a sealed pack.
   */
  function classify(card) {
    const tags = parseVariants(card.card_name);
    const isPromo = card.rarity === 'PR';

    // DON!! cards arrive from a separate endpoint already marked pullable or
    // not — most ship in Double Pack Sets and promos rather than boosters.
    if (card.rarity === 'DON') {
      if (!card.donBooster) {
        return { slot: null, reason: card.donProduct || 'Not a booster DON!!', tags };
      }
      // Gold and Silver DON!! are a separate printing, not a lucky draw from
      // the ordinary pool. In PRB-01 the Gold ones average $131 against $1.98
      // for plain — treating them as one slot made the average meaningless.
      const premium = /\((?:Gold|Silver)\)/.test(card.card_name);
      return { slot: premium ? 'DONGOLD' : 'DON',
               variantLabel: card.donVariant || 'DON!!', tags };
    }

    let best = null;
    for (const tag of tags) {
      const def = D.VARIANT_TAGS[tag];
      if (!def || !def.slot) continue;
      if (def.slot === 'EXCLUDE') return { slot: null, reason: def.label, tags };
      if (!best || def.rank > D.VARIANT_TAGS[best].rank) best = tag;
    }

    if (isPromo) return { slot: null, reason: 'Promo', tags };

    if (best) {
      return { slot: D.VARIANT_TAGS[best].slot, variantLabel: D.VARIANT_TAGS[best].label, tags };
    }
    // No variant marker — it sits in its printed base rarity slot.
    if (Object.prototype.hasOwnProperty.call(D.RARITY, card.rarity)) {
      return { slot: card.rarity, variantLabel: null, tags };
    }
    return { slot: null, reason: 'Unknown rarity ' + card.rarity, tags };
  }

  /**
   * What the card actually shows in its bottom-right corner, plus which
   * physical treatment it carries.
   *
   * `text` is the PRINTED rarity, which is not the same as the chase tier —
   * "Kuzan (Manga)" is stamped R and sells for $1,060. `tone` is the treatment
   * that makes it valuable and drives the colour. `star` mirrors the real card:
   * parallels and alternate arts print a ★ above the rarity letter.
   */
  function rarityBadge(card) {
    const cls = classify(card);
    const tags = cls.tags || [];
    const has = t => tags.indexOf(t) > -1;

    if (card.rarity === 'DON') {
      const gold = /\(Gold\)/.test(card.card_name);
      const silver = /\(Silver\)/.test(card.card_name);
      return {
        text: 'DON', star: /Alternate Art|Manga/.test(card.card_name),
        tone: gold ? 'GOLD' : silver ? 'SILVER' : 'DON',
        label: cls.variantLabel || 'DON!!'
      };
    }

    let tone = card.rarity || 'C';
    if (cls.slot === 'MANGA')      tone = 'MANGA';
    else if (cls.slot === 'SP')    tone = 'SP';
    else if (cls.slot === 'TR')    tone = 'TR';
    else if (cls.slot === 'ULTRA') tone = has('Silver') ? 'SILVER' : 'GOLD';

    // SP and TR are printed designations in their own right — an SP card is
    // stamped SP, not the base rarity it was reprinted from. Everything else
    // shows the base letter, because that IS what the corner says.
    let text = card.rarity || '?';
    if (has('SP') || has('SPR')) text = 'SP';
    else if (has('TR'))          text = 'TR';

    // The ★ marks an alternate-art treatment. Manga Rares and the Super Alt /
    // Gold / Silver tier are alternate arts too, so they carry it — only the
    // plain base printings and SP's own designation go without.
    const star = cls.slot === 'ALT' || cls.slot === 'MANGA' || cls.slot === 'ULTRA';

    return {
      text: text,
      star: star,
      tone: tone,
      label: cls.variantLabel || (D.RARITY[card.rarity] || {}).label || card.rarity
    };
  }

  /**
   * Stable unique key.
   *
   * Neither id field is unique on its own, and this bites hard:
   *   card_set_id   — 723 collisions (a card and its Box Topper share one)
   *   card_image_id —  41 collisions (OP07-076 is a $0.25 common in OP-07,
   *                    a $1.69 Pirate Foil in PRB-02, AND a $0.30 reprint)
   *   set + image   —  28 collisions (Jolly Roger Foil vs Alternate Art)
   *
   * set + image + name leaves exactly one collision across all 3,485 cards,
   * and that one is a genuine duplicate row in the source data — two identical
   * Gecko Moria entries at the same price — so collapsing it is harmless.
   *
   * Anything less than this and clicking an expensive variant silently
   * resolves to the cheap card that shares its id.
   *
   * v2 UPDATE: none of that is needed any more. TCGplayer's productId is a
   * genuine primary key — verified unique across all 6,798 cards in all 84
   * groups, zero collisions — so the composite is only kept as a fallback for
   * v1 rows still sitting in localStorage or the sheet, which is what the
   * collection migration reads.
   */
  function cardKey(card) {
    if (card.id != null && card.id !== '') return String(card.id);
    return card.set_id + '|' + (card.card_image_id || card.card_set_id) + '|' + card.card_name;
  }

  /* ==========================================================================
     2. SET INDEXING
     ========================================================================== */

  /**
   * Group one set's cards into pull slots and compute per-slot averages.
   * `priceOf` lets the caller swap in region overrides.
   */
  function buildSetIndex(setId, cards, priceOf) {
    const pools = {};
    const excluded = [];

    for (const card of cards) {
      const cls = classify(card);
      if (!cls.slot) { excluded.push({ card, reason: cls.reason }); continue; }
      (pools[cls.slot] = pools[cls.slot] || []).push({
        card,
        key: cardKey(card),
        slot: cls.slot,
        variantLabel: cls.variantLabel,
        price: priceOf(card)
      });
    }

    /* Fallback for a slot where NOTHING is priced.

       The per-slot average only works if at least one card in that slot has a
       price. OP-17 has two SP cards printed at PR rarity and both are
       unpriced, so their slot averaged to zero and they sank right back to the
       bottom — the exact bug this is meant to fix, one level down. The
       set-wide average of priced cards is a blunter guess but a far better one
       than zero. */
    const everyPriced = [];
    for (const key of Object.keys(pools)) {
      for (const e of pools[key]) if (e.price > 0) everyPriced.push(e.price);
    }
    const setAvg = everyPriced.length
      ? everyPriced.reduce((a, b) => a + b, 0) / everyPriced.length : 0;

    const slots = {};
    const all = [];
    for (const key of Object.keys(pools)) {
      const entries = pools[key];

      /* AN UNPRICED CARD IS NOT A CHEAP CARD.

         Sorting on raw price put every card TCGplayer has no sold average for
         at $0 — dead last. That is precisely backwards, because the cards
         without a price are the ones too scarce to have traded: OP-17 has 11
         SP cards and only 3 carry a price, so 8 of them sank to positions
         164-176 of 177 and fell off the end of the grid. Same for OP-13's Red
         Super Alternate Art Luffy and Ace.

         So an unpriced card is ranked by what its SLOT is worth in this set
         instead. We do not know what that Luffy sells for, but we know it is
         a Super Alt Art, and Super Alt Arts here average four figures — that
         is a far better guess than zero. `price` is untouched for display;
         only the sort key changes, and `unpriced` lets the UI say so. */
      const priced = entries.filter(e => e.price > 0);
      const avgPriced = priced.length
        ? priced.reduce((s, e) => s + e.price, 0) / priced.length : 0;
      for (const e of entries) {
        e.unpriced = !(e.price > 0);
        e.sortPrice = e.unpriced ? (avgPriced || setAvg) : e.price;
      }

      const total = entries.reduce((s, e) => s + e.price, 0);
      entries.sort((a, b) => b.sortPrice - a.sortPrice);
      slots[key] = {
        key,
        entries,
        count: entries.length,
        // Averages stay based on REAL prices only — letting a proxy feed back
        // into the average that produced it would drift the set's EV.
        avgPrice: priced.length ? avgPriced : 0,
        maxPrice: entries.length ? Math.max.apply(null, entries.map(e => e.price)) : 0,
        unpricedCount: entries.length - priced.length
      };
      for (const e of entries) all.push(e);
    }
    // Flat, pre-sorted view of every pullable card in the set. Callers used to
    // rebuild this by walking every slot on every render — the Signals tab did
    // it across all 21 sets each time a filter changed.
    all.sort((a, b) => b.sortPrice - a.sortPrice);
    return { setId, slots, all, excluded, cards };
  }

  /* ==========================================================================
     3. EXPECTED VALUE
     ========================================================================== */

  /**
   * EV of a sealed box = sum over slots of (expected copies per box) x
   * (average market price of that slot's pool).
   *
   * Uniform-within-slot is an assumption, not a fact — Bandai does not publish
   * per-card weighting. It is the standard approach and it is what makes the
   * "chase concentration" number worth reading: the more the slot's value sits
   * in one card, the more the average lies to you.
   */
  function evaluate(index, config) {
    const perBox = config.perBox;
    const breakdown = [];
    let evBox = 0;

    for (const slotDef of D.SLOTS) {
      const key = slotDef.key;
      const expected = perBox[key] || 0;
      const pool = index.slots[key];
      if (!expected || !pool || !pool.count) continue;
      const value = expected * pool.avgPrice;
      evBox += value;
      breakdown.push({
        key, label: slotDef.label,
        expectedPerBox: expected,
        poolSize: pool.count,
        avgPrice: pool.avgPrice,
        maxPrice: pool.maxPrice,
        value,
        // How top-heavy this slot is: 1.0 means one card carries the whole slot.
        concentration: pool.avgPrice > 0 ? pool.maxPrice / (pool.avgPrice * pool.count) : 0
      });
    }

    breakdown.sort((a, b) => b.value - a.value);
    const packs = config.packsPerBox || 24;
    return {
      evBox,
      evPack: evBox / packs,
      packsPerBox: packs,
      breakdown,
      // Share of total box EV coming from the single most valuable slot.
      topSlotShare: evBox > 0 && breakdown.length ? breakdown[0].value / evBox : 0
    };
  }

  /**
   * Does this pull-rate config actually describe this set's card pool?
   *
   * Catches the failure mode where a slot is assigned copies per box but the
   * set has no such cards (or only a handful), which silently redistributes
   * value and produces confident nonsense. Cheap insurance against every
   * future set that ships with a structure nobody documented.
   */
  function configFit(index, config) {
    const issues = [];
    let counted = 0;

    for (const slotDef of D.SLOTS) {
      const key = slotDef.key;
      const expected = config.perBox[key] || 0;
      counted += expected;
      const pool = index.slots[key];
      // Only a material rate matters. Plenty of sets legitimately have no
      // Manga or Gold cards at all; a 0.01/box rate against an empty pool
      // contributes nothing and is not a problem worth shouting about.
      // Threshold of 5, not 1. A slot claiming five or more cards a box that
      // the set does not contain means the config describes the wrong product
      // — that is how the Extra Booster mismatch (72 uncommons per box, set
      // has none) surfaced. One missing DON!! is a gap in the source data, not
      // a broken structure, and evaluate() already ignores empty pools.
      if (expected >= 5 && (!pool || !pool.count)) {
        issues.push({
          severity: 'error', slot: key,
          message: `Config expects ${expected} ${slotDef.label} per box, but this set has none — the structure does not match this product.`
        });
      } else if (expected === 0 && pool && pool.count) {
        // The inverse mistake, and the one that hid a bug: the set HAS these
        // cards but the rate says zero, so the app reports them as impossible
        // to pull and drops their value from EV entirely. Silent until you
        // click one and it tells you the card cannot exist.
        issues.push({
          severity: 'error', slot: key,
          message: `This set has ${pool.count} ${slotDef.label} card${pool.count === 1 ? '' : 's'}, but your rate is 0 per box — they are treated as impossible to pull.`
        });
      } else if (expected >= 1 && pool && pool.count < 3) {
        issues.push({
          severity: 'warn', slot: key,
          message: `Only ${pool.count} ${slotDef.label} card${pool.count === 1 ? '' : 's'} in the pool — the average is one card.`
        });
      }
    }

    const capacity = (config.packsPerBox || 24) * (config.cardsPerPack || 12);
    const drift = counted - capacity;
    if (Math.abs(drift) > 1) {
      issues.push({
        severity: 'error', slot: null,
        message: `Slots total ${counted.toFixed(2)} cards but the box holds ${capacity}.`
      });
    }
    return { issues, counted, capacity, ok: !issues.some(i => i.severity === 'error') };
  }

  /**
   * Chase concentration across the whole set: what fraction of total box EV is
   * carried by the top N cards. High = lottery ticket, low = grindy value set.
   */
  function chaseConcentration(index, config, topN) {
    topN = topN || 5;
    const contributions = [];
    for (const slotDef of D.SLOTS) {
      const key = slotDef.key;
      const expected = config.perBox[key] || 0;
      const pool = index.slots[key];
      if (!expected || !pool || !pool.count) continue;
      // Each card in the slot is equally likely, so each contributes
      // (expected / poolSize) copies per box.
      const copiesEach = expected / pool.count;
      for (const e of pool.entries) {
        contributions.push({ entry: e, value: copiesEach * e.price });
      }
    }
    contributions.sort((a, b) => b.value - a.value);
    const total = contributions.reduce((s, c) => s + c.value, 0);
    const top = contributions.slice(0, topN);
    const topValue = top.reduce((s, c) => s + c.value, 0);
    return {
      total,
      top,
      share: total > 0 ? topValue / total : 0,
      all: contributions
    };
  }

  /* ==========================================================================
     4. RIP vs BUY
     ========================================================================== */

  /**
   * Per-pack probability of pulling one specific card.
   * Assumes uniform distribution inside the card's slot.
   */
  function perPackProbability(index, config, targetKey) {
    for (const slotDef of D.SLOTS) {
      const key = slotDef.key;
      const pool = index.slots[key];
      if (!pool) continue;
      const hit = pool.entries.find(e => e.key === targetKey);
      if (!hit) continue;
      const expectedPerBox = config.perBox[key] || 0;
      if (!expectedPerBox) return { p: 0, slot: key, poolSize: pool.count, entry: hit, impossible: true };
      const packs = config.packsPerBox || 24;
      const copiesPerBox = expectedPerBox / pool.count;
      return {
        p: copiesPerBox / packs,
        slot: key,
        poolSize: pool.count,
        expectedPerBox,
        copiesPerBox,
        entry: hit,
        impossible: false
      };
    }
    return null;
  }

  /**
   * The core question: is chasing this card cheaper than just buying it?
   *
   * The honest version has to credit the value of everything ELSE you open.
   * Ripping N packs costs N x packPrice but returns N x evPack in other cards,
   * so the true cost of the chase is N x (packPrice - evPack).
   */
  function ripVsBuy(opts) {
    const { p, packPrice, evPack, singlePrice, sellFriction } = opts;
    if (!p || p <= 0) return null;

    const friction = sellFriction == null ? 0.15 : sellFriction;
    // What you actually realise selling the rest of the pulls, after fees/shipping.
    const realisedPerPack = evPack * (1 - friction);
    const netPerPack = packPrice - realisedPerPack;

    const expectedPacks = 1 / p;
    const packsFor = q => Math.log(1 - q) / Math.log(1 - p);

    // A card that costs less than a couple of packs is not a chase, whatever
    // the expected value says. Telling someone to rip a case for a $3 single
    // is technically defensible and practically useless.
    const trivial = singlePrice > 0 && singlePrice < packPrice * 2;

    const grossCost = expectedPacks * packPrice;
    const netCost = expectedPacks * netPerPack;

    return {
      p,
      expectedPacks,
      expectedBoxes: expectedPacks / (opts.packsPerBox || 24),
      packs50: packsFor(0.5),
      packs90: packsFor(0.9),
      pPerBox: 1 - Math.pow(1 - p, opts.packsPerBox || 24),
      grossCost,
      netCost,
      realisedPerPack,
      netPerPack,
      singlePrice,
      // Negative edge means ripping is the cheaper route to the card.
      edge: netCost - singlePrice,
      edgePct: singlePrice > 0 ? (netCost - singlePrice) / singlePrice : null,
      trivial,

      // Two honest ways to read the same chase, for two different people.
      //
      // simpleVerdict compares what you would SPEND on product against the
      // single's price. That is the right lens for a collector who keeps what
      // they open — the other cards are not income, they are more collection.
      //
      // netVerdict credits the resale value of everything else you pull. That
      // is the right lens only if you actually sell it.
      //
      // Chasing one specific card almost always loses on the simple lens, and
      // that is not a bug — it is the answer that saves money.
      simpleVerdict: trivial ? 'TRIVIAL' : (grossCost < singlePrice ? 'RIP' : 'BUY'),
      netVerdict:    trivial ? 'TRIVIAL' : (netCost   < singlePrice ? 'RIP' : 'BUY'),
      grossEdge: grossCost - singlePrice,

      // If netPerPack <= 0 the packs pay for themselves; the chase is free.
      freeRoll: netPerPack <= 0
    };
  }

  /* ==========================================================================
     5. SUPPLY / DEMAND SIGNAL

     There is no free eBay listing-count or PSA population feed, so TCGQuant's
     literal inputs are not reproducible. What IS available on every card is
     both a lowest-listing price and a recent-sold market price.

     The gap between them is a real supply signal:
       - inventory well BELOW market  -> plenty of cheap listings, soft supply
       - inventory pushing UP TO market -> cheap copies drying up, tightening
     ========================================================================== */

  function spreadSignal(entryOrCard) {
    const c = entryOrCard.card || entryOrCard;
    const inv = c.inventory_price;
    const mkt = c.market_price;
    if (!mkt || mkt <= 0 || inv == null || inv <= 0) return null;

    const ratio = inv / mkt;               // 1.0 = floor has met the market
    const discount = 1 - ratio;            // how far below market you can buy

    /* v2: the mid price separates real supply from one cheap outlier.

       `low` is a single listing and can be anybody's mispriced copy. `mid` is
       the middle of the listings, so when low sits far under mid the cheap
       copy is an outlier, not the market — OP-16 "Zehahahahaha!" reads low
       $106 against mid $154 on a $128 market, which looks like a discount and
       is really one seller. Comparing mid to market asks the honest question:
       what does the BODY of the listings think this is worth? */
    const mid = c.mid_price;
    const midRatio = (mid && mid > 0) ? mid / mkt : null;
    // A low far beneath the mid is one listing, not depth.
    const thinLow = (mid && mid > 0) ? (inv / mid) < 0.75 : false;

    /* A floor several times market is not a signal, it is a junk listing.

       92 cards (1.5%) sit at 3x or more; the worst is Riku Doldo III, a $4.76
       common whose only listing is $2,608 — and its MID is the same number,
       which is the tell: there is exactly one copy for sale and it is priced
       for nobody. Ranking these produces confident nonsense at the top of
       every ratio sort.

       3x is the cut because the most extreme legitimate band behaviour
       measured was p90 = 2.68 among $500+ cards, so this sits just above the
       real world rather than clipping it. */
    const absurd = ratio >= ABSURD_RATIO;

    /* DRY is a state v1 could not express. When the CHEAPEST copy on the
       market is above the sold average, there is nothing left to buy at a
       sensible price — OP-16 Sakazuki (Manga) sells for $1,224 and the
       cheapest listing is $1,696. That is categorically different from
       "tightening", and lumping the two together is what made the call list
       59% of the board. */
    let state, score;
    if (ratio >= 1.0)       { state = 'DRY';     score = 10; }
    else if (ratio >= 0.95) { state = 'TIGHT';   score = 9; }
    else if (ratio >= 0.85) { state = 'FIRMING'; score = 7; }
    else if (ratio >= 0.70) { state = 'NORMAL';  score = 5; }
    else if (ratio >= 0.50) { state = 'SOFT';    score = 3; }
    else                    { state = 'LOOSE';   score = 1; }

    return { ratio, discount, state: absurd ? 'NOFLOOR' : state,
             score: absurd ? 0 : score, inventory: inv, market: mkt,
             mid: mid || null, midRatio, thinLow, absurd };
  }

  /**
   * Mechanical action flag. Not advice — a rule you can read and disagree with.
   *
   * Two independent facts have to agree before anything is flagged:
   *   supply   — is the listing floor closing on the market price
   *   momentum — is the 13-day price actually moving
   *
   * Supply alone is not enough. A floor above market can mean a card is running,
   * or it can mean one stale overpriced listing on a card nobody has touched in
   * six months. Requiring momentum to confirm kills most of that noise, and
   * anything scraped more than STALE_DAYS ago is refused outright rather than
   * dressed up as a signal.
   */
  const STALE_DAYS = 30;

  /* No fixed ratio can work here, and two failed attempts proved it.

     The listing-to-market ratio is strongly PRICE-DEPENDENT. Measured across
     6,211 priced cards:

       band        n     p10    p50    p90
       $5-20     806    0.65   0.87   1.22
       $20-100   568    0.72   0.94   1.66
       $100-500  267    0.73   0.97   1.80
       $500+     134    0.86   1.13   2.68

     A $500+ card whose cheapest copy sits at 1.13x market is at its band's
     MEDIAN — perfectly ordinary. A $5 card at the same ratio is an outlier.
     Any single threshold therefore just selects for expensive cards: 0.95
     flagged 195 of 333 rows, and 1.0 flagged 129, because at $100+ half the
     band already sits above market.

     So the thresholds are computed from the loaded data at runtime, per band,
     and a card is judged only against its own peers. That self-calibrates as
     the market moves and, by construction, keeps the shortlist near a tenth of
     the rows instead of a third. */
  /* Above this the cheapest listing is not a price, it is somebody's
     placeholder. See spreadSignal. */
  const ABSURD_RATIO = 3;

  const PRICE_BANDS = [0, 5, 20, 100, 500, Infinity];

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    return sorted[Math.floor((sorted.length - 1) * p)];
  }

  /**
   * Per-band ratio percentiles, computed from whatever cards are loaded.
   * Bands with too few cards to be meaningful are left null and the caller
   * falls back to reporting nothing rather than inventing a threshold.
   */
  function spreadBands(cards) {
    const buckets = PRICE_BANDS.slice(0, -1).map((min, i) => ({
      min, max: PRICE_BANDS[i + 1], ratios: []
    }));

    for (const c of cards) {
      const card = c.card || c;
      const mkt = card.market_price, low = card.inventory_price;
      if (!mkt || mkt <= 0 || low == null || low <= 0) continue;
      const b = buckets.find(x => mkt >= x.min && mkt < x.max);
      if (b) b.ratios.push(low / mkt);
    }

    return buckets.map(b => {
      const sorted = b.ratios.sort((x, y) => x - y);
      // Under ~20 samples a decile is noise, not a threshold.
      const enough = sorted.length >= 20;
      return {
        min: b.min, max: b.max, n: sorted.length,
        p10: enough ? percentile(sorted, 0.10) : null,
        p90: enough ? percentile(sorted, 0.90) : null
      };
    });
  }

  const bandFor = (bands, market) =>
    (bands || []).find(b => market >= b.min && market < b.max) || null;

  function actionTag(o) {
    const sig = o.sig, age = o.age, h = o.hist;

    if (age != null && age > STALE_DAYS) {
      return { code: 'STALE', label: 'STALE',
               why: `Last priced ${age} days ago — no read worth trusting.` };
    }

    const tight = sig && sig.ratio >= 0.85;
    const loose = sig && sig.ratio < 0.70;

    // A frozen series carries no momentum information — treating 13 repeats of
    // one number as "price is flat" would confidently mislabel a card nobody
    // has repriced in months.
    if (h && h.frozen) {
      return { code: 'STALE', label: 'NO TREND',
               why: 'Price has not moved for 13 straight days — almost certainly not repriced rather than genuinely stable.' };
    }

    /* SUPPLY-ONLY LADDER — the v2 path.

       TCGplayer publishes no price history, so momentum can never confirm a
       call. v1 required both (tight supply AND a rising trend); keeping that
       rule with h permanently null made BUY, HOLD, TRIM and AVOID unreachable
       and left the tab reporting "0 calls" forever while the legend still
       advertised them.

       So supply carries the call alone, and the bar is raised to compensate.
       `tight` at 0.85 was a shortlist threshold when a trend had to agree with
       it; on its own it is too loose to act on. CALL_RATIO is the point where
       the cheapest copy on the market has essentially caught up with the sold
       average — there is no cheap copy left to buy, which is a supply fact and
       needs no trend to be true. */
    if (!h) {
      /* THE BUY SIGNAL IS A LOW RATIO, NOT A HIGH ONE.

         v1 called "cheapest copy near market" a buy, because a rising 13-day
         trend confirmed the price was climbing to meet the listings. With no
         history that confirmation is gone, and the signal inverts: a cheapest
         listing far ABOVE the sold average means every copy on sale is priced
         over what people actually pay — that is a reason not to buy, not a
         reason to buy.

         What the spread alone genuinely supports is the opposite tail: a copy
         listed well BELOW what the card has been selling for. Trafalgar Law
         (119) (Manga) sells at $715 with a copy listed at $300. That is a fact
         about today's board and needs no trend to be actionable. */
      // No usable floor -> no verdict. Silence beats a confident wrong answer.
      if (sig.absurd) return null;

      const band = o.band;
      if (!band || band.p10 == null) return null;   // no basis, so say nothing

      const pct = Math.round(sig.ratio * 100);
      const cheap = sig.ratio <= band.p10;          // bottom decile of its band
      const scarce = band.p90 != null && sig.ratio >= band.p90;

      if (o.ownedTrade && cheap && !sig.thinLow) {
        return { code: 'TRIM', label: 'TRIM',
                 why: `You hold this to sell and copies are listed at ${pct}% of market — among the most undercut in its price range, and it is not one stray listing.` };
      }
      if (cheap && !o.owned) {
        return { code: 'BUY', label: 'BARGAIN',
                 why: `Listed at ${pct}% of what it has been selling for — the cheapest decile for cards in this price range.` +
                      (sig.thinLow ? ' Only one cheap copy, well under the rest, so check its condition before trusting it.' : '') };
      }
      if (scarce && o.owned) {
        return { code: 'HOLD', label: 'HOLD',
                 why: `Nobody is undercutting you — the cheapest copy listed is ${pct}% of market, the top decile for this price range.` };
      }
      if (scarce) {
        return { code: 'WATCH', label: 'NO CHEAP COPY',
                 why: `Every copy on sale is above the sold average (cheapest is ${pct}%). Hard to buy near market — not a bargain, and with no price history there is nothing to say it is climbing.` };
      }
      return null;
    }

    const rising  = h.changePct >  0.03;
    const falling = h.changePct < -0.03;
    const move = (h.changePct >= 0 ? '+' : '') + (h.changePct * 100).toFixed(1) + '% in 13 days';

    if (o.ownedTrade && loose && falling) {
      return { code: 'TRIM', label: 'TRIM',
               why: `You hold this to sell. Plenty of cheap copies and ${move} — the exit is closing.` };
    }
    if (o.owned && tight && rising) {
      return { code: 'HOLD', label: 'HOLD',
               why: `You own it, cheap copies are drying up and it is ${move}. Not the moment to sell.` };
    }
    if (!o.owned && tight && rising) {
      return { code: 'BUY', label: 'MUST BUY',
               why: `Floor at ${Math.round(sig.ratio * 100)}% of market and ${move}. Supply tightening while the price moves.` };
    }
    if (tight)  return { code: 'WATCH', label: 'WATCH',
                         why: `Supply tightening but price is flat (${move}).` };
    if (loose && falling) return { code: 'AVOID', label: 'SOFT',
                         why: `Cheap copies everywhere and ${move}.` };
    return null;
  }

  /** Days since this card's price was last scraped. Stale data lies. */
  /* v2 NOTE: this returns null for every card from TCGCSV, because TCGplayer
     publishes no per-card scrape time — only a whole-catalogue build stamp.
     It is kept because actionTag() and the tests still exercise the guard, and
     because it degrades correctly: a null age means "cannot tell", not "fresh".
     Anything user-facing that promised a STALE verdict has been removed rather
     than left claiming a check that can no longer run. */
  function staleness(card, today) {
    if (!card.date_scraped) return null;
    const then = new Date(card.date_scraped + 'T00:00:00');
    const now = today ? new Date(today) : new Date();
    if (isNaN(then.getTime())) return null;
    return Math.round((now - then) / 86400000);
  }

  /* ==========================================================================
     6. PRICE HISTORY (13-day window from the twoweeks endpoint)
     ========================================================================== */

  function parseHistory(row) {
    const series = [];
    for (let i = 13; i >= 1; i--) {
      const v = row['Day' + i + '_Market_Price'];
      if (typeof v === 'number' && v > 0) series.push(v);
    }
    if (typeof row.market_price === 'number' && row.market_price > 0) series.push(row.market_price);
    if (series.length < 2) return null;

    const first = series[0];
    const last = series[series.length - 1];
    const mean = series.reduce((s, v) => s + v, 0) / series.length;
    const variance = series.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / series.length;

    // Every value identical across 13 days does NOT mean a stable price — for
    // cards nobody has rescraped, the endpoint simply replays the last known
    // figure (a 392-day-old SPR returns the same number thirteen times).
    // Flat and frozen look the same in the data and mean opposite things, so
    // they must not be reported as "no movement".
    const frozen = series.every(v => v === first);

    return {
      series,
      first, last, frozen,
      change: last - first,
      changePct: first > 0 ? (last - first) / first : 0,
      min: Math.min.apply(null, series),
      max: Math.max.apply(null, series),
      volatility: mean > 0 ? Math.sqrt(variance) / mean : 0
    };
  }

  /* ==========================================================================
     7. HELPERS
     ========================================================================== */

  function money(n, dp) {
    if (n == null || isNaN(n)) return '—';
    const d = dp == null ? (Math.abs(n) >= 100 ? 0 : 2) : dp;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function pct(n, dp) {
    if (n == null || isNaN(n)) return '—';
    return (n * 100).toFixed(dp == null ? 1 : dp) + '%';
  }

  /** "1 in 340 packs" reads better than "0.29%" when the number is tiny. */
  function odds(p) {
    if (!p || p <= 0) return '—';
    const one = 1 / p;
    if (one < 2) return (p * 100).toFixed(1) + '% per pack';
    return '1 in ' + (one < 20 ? one.toFixed(1) : Math.round(one).toLocaleString()) + ' packs';
  }

  return {
    parseVariants, classify, cardKey, rarityBadge,
    buildSetIndex, evaluate, chaseConcentration, configFit,
    perPackProbability, ripVsBuy,
    spreadSignal, staleness, parseHistory, actionTag, STALE_DAYS, spreadBands, bandFor, PRICE_BANDS, ABSURD_RATIO,
    money, pct, odds
  };
})(OQ_DATA);

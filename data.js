/* ============================================================================
   OPTCG QUANT — data.js
   Static configuration: sets, product profiles, pull rates, box prices, regions.

   Everything in here is a DEFAULT. The app writes user overrides to
   localStorage and those always win. Nothing here is treated as gospel.
   ========================================================================== */

const OQ_DATA = (function () {
  'use strict';

  /* --------------------------------------------------------------------------
     ENGLISH ONLY.
     JP / CN / KR were dropped deliberately. No free API carries their prices:
     Yuyutei and CardRush have no public API, every keyed alternative
     (tcgapi.dev, one-piece-api, tcgpricelookup) needs a secret that cannot
     live in a public GitHub Pages repo, and manual-only regions were dead
     weight in the UI. English has a real live feed, so that is the whole app.
     -------------------------------------------------------------------------- */

  /* Grading companies, for cards you own. There is no free market feed for
     graded prices either, so a graded card's value is whatever you enter. */
  const GRADERS = ['PSA', 'BGS', 'CGC', 'SGC', 'TAG', 'ACE'];

  /* Raw card conditions, TCGplayer's ladder. */
  const CONDITIONS = [
    { code: 'NM', label: 'Near Mint' },
    { code: 'LP', label: 'Lightly Played' },
    { code: 'MP', label: 'Moderately Played' },
    { code: 'HP', label: 'Heavily Played' },
    { code: 'DMG', label: 'Damaged' }
  ];

  /* The two things a collected card can be doing for you. */
  const COLLECTION_KINDS = {
    keep:  { code: 'keep',  label: 'Keeping',   hint: 'Cards you are holding. Not for sale.' },
    trade: { code: 'trade', label: 'Trade / Sell', hint: 'Liquid stock. Watch the supply signal on these.' }
  };

  /* --------------------------------------------------------------------------
     VARIANT TAGS
     The API's `rarity` field is the card's BASE rarity, not the variant's.
     "Kuzan (Manga)" comes back as rarity "R" even though it is a $1000 chase.
     So the real rarity tier has to be parsed out of the card name.

     Only these exact parentheticals count as variant markers — plenty of cards
     carry parentheticals that are just character disambiguators ("(Galdino)")
     or card numbers ("(001)").
     -------------------------------------------------------------------------- */
  const VARIANT_TAGS = {
    // --- ultra tier: the rarest chases in the game, one per several cases.
    // These MUST be matched before "Alternate Art" or they fall through into
    // their printed base rarity and get modelled as ordinary Secret Rares —
    // which puts an $8,000 card in a slot you hit 0.75 times a box.
    'Red Super Alternate Art': { slot: 'ULTRA', label: 'Red Super Alt Art', rank: 130 },
    'Gold':                    { slot: 'ULTRA', label: 'Gold',              rank: 125 },
    'Super Alternate Art':     { slot: 'ULTRA', label: 'Super Alt Art',     rank: 120 },
    'Silver':                  { slot: 'ULTRA', label: 'Silver',            rank: 115 },

    'Manga':            { slot: 'MANGA', label: 'Manga Rare',       rank: 100 },
    'SPR':              { slot: 'SP',    label: 'Special Rare',     rank: 90 },
    'SP':               { slot: 'SP',    label: 'Special Rare',     rank: 90 },
    'Parallel':         { slot: 'ALT',   label: 'Parallel',         rank: 60 },
    'Alternate Art':    { slot: 'ALT',   label: 'Alternate Art',    rank: 60 },
    'Full Art':         { slot: 'ALT',   label: 'Full Art',         rank: 60 },
    'Gem':              { slot: 'ALT',   label: 'Gem',              rank: 58 },
    'Textured Foil':    { slot: 'FOIL',  label: 'Textured Foil',    rank: 55 },
    'Pirate Foil':      { slot: 'FOIL',  label: 'Pirate Foil',      rank: 55 },
    'Jolly Roger Foil': { slot: 'FOIL',  label: 'Jolly Roger Foil', rank: 55 },
    // Not pulled from sealed booster packs — must be excluded from pack EV or
    // it silently inflates every number in the app.
    'Box Topper':             { slot: 'EXCLUDE', label: 'Box Topper',   rank: 0 },
    'Dash Pack':              { slot: 'EXCLUDE', label: 'Dash Pack',    rank: 0 },
    'Wanted Poster':          { slot: 'EXCLUDE', label: 'Wanted Poster', rank: 0 },
    'Gold-Stamped Signature': { slot: 'EXCLUDE', label: 'Prize Card',   rank: 0 },
    // A reprint is just a normal card of its printed rarity.
    'Reprint':          { slot: null,   label: 'Reprint',           rank: 0 }
  };

  /* Base rarity codes as they appear in the API. */
  const RARITY = {
    C:   { label: 'Common',        rank: 10 },
    UC:  { label: 'Uncommon',      rank: 20 },
    R:   { label: 'Rare',          rank: 30 },
    SR:  { label: 'Super Rare',    rank: 50 },
    L:   { label: 'Leader',        rank: 40 },
    SEC: { label: 'Secret Rare',   rank: 80 },
    TR:  { label: 'Treasure Rare', rank: 95 },
    PR:  { label: 'Promo',         rank: 0 }   // never pack-pulled
  };

  /* Display order + colour keys for slots. */
  const SLOTS = [
    { key: 'C',     label: 'Common' },
    { key: 'UC',    label: 'Uncommon' },
    { key: 'R',     label: 'Rare' },
    { key: 'L',     label: 'Leader' },
    { key: 'SR',    label: 'Super Rare' },
    { key: 'SEC',   label: 'Secret Rare' },
    { key: 'ALT',   label: 'Alt Art / Parallel' },
    { key: 'SP',    label: 'Special Rare' },
    { key: 'MANGA', label: 'Manga Rare' },
    { key: 'ULTRA', label: 'Super Alt / Gold' },
    { key: 'TR',    label: 'Treasure Rare' },
    { key: 'DON',    label: 'DON!!' },
    { key: 'DONGOLD', label: 'Gold / Silver DON!!' },
    { key: 'FOIL',  label: 'Foil' }
  ];

  /* --------------------------------------------------------------------------
     DON!! CARDS
     Live on their own endpoint with a different schema — no set_id at all, the
     set is only present inside `optcg_don_name` as a trailing code, e.g.
     "DON!! Card (Egghead) - The Azure Sea's Seven (OP14)".

     Most DON!! cards are NOT booster pulls. They ship in Double Pack Sets,
     Tin Packs, Devil Fruits Collections, anniversary packs and tournament
     prizes. Only the alt-art/foil DONs seeded into boosters belong in pack EV,
     so anything matching these product markers is browsable but excluded from
     the pull pool.
     -------------------------------------------------------------------------- */
  const DON_NON_BOOSTER = [
    'Double Pack Set', 'Special DON!! Set', 'Special DON!! Card Pack',
    'Tin Pack Set', 'Devil Fruits Collection', 'Anniversary',
    'Tournament', 'Championship', 'World Final', 'Demo Deck', 'Celebration Pack'
  ];

  /* Trailing set code in optcg_don_name -> our set ids. Codes we do not map
     (OP-PR promos, ST-xx starter decks, OPDD demo) are simply not boosters. */
  const DON_SET_CODES = {
    OP01: 'OP-01', OP02: 'OP-02', OP03: 'OP-03', OP04: 'OP-04', OP05: 'OP-05',
    OP06: 'OP-06', OP07: 'OP-07', OP08: 'OP-08', OP09: 'OP-09', OP10: 'OP-10',
    OP11: 'OP-11', OP12: 'OP-12', OP13: 'OP-13', OP14: 'OP14-EB04',
    OP15: 'OP15-EB04', OP16: 'OP-16',
    'EB-01': 'EB-01', 'EB-02': 'EB-02', 'EB-03': 'EB-03',
    'PRB-01': 'PRB-01', 'PRB-02': 'PRB-02'
  };

  /* --------------------------------------------------------------------------
     PRODUCT PROFILES — expected cards per sealed box, by slot.

     Bandai does not publish pull rates. Community estimates disagree with each
     other (6 vs 8 SR per box, 0.5 vs 1 SEC per box, "case" = 4/6/12 boxes
     depending who you ask). What follows is a consensus set of numbers chosen
     so that the slot counts actually SUM to the real card count in a box —
     a constraint most published tables quietly violate.

     These are estimates. Tune them in Settings to match what you actually pull.
     -------------------------------------------------------------------------- */
  const PROFILES = {
    // The chase-tier rates (SP / MANGA / ULTRA) are both the least certain and
    // the most EV-sensitive numbers in the whole app — a set's expected value
    // can swing by half on the manga rate alone. Treat them as dials, not facts.
    STANDARD: {
      label: 'Standard Booster',
      verified: true,
      packsPerBox: 24,
      cardsPerPack: 12,
      // DON: 1 — boosters seed roughly one special/alt-art DON!! per box.
      // Taken out of the common count so the box still holds 288 cards.
      perBox: { C: 167, UC: 72, R: 26, L: 12, SR: 7, SEC: 0.75, ALT: 2,
                SP: 0.083, MANGA: 0.033, ULTRA: 0.01, TR: 0.04,
                DON: 1, DONGOLD: 0.1, FOIL: 0 }
    },
    // Extra Boosters are 24-pack boxes, but their card pools are structured
    // differently — EB-02 contains no uncommons at all — and Bandai publishes
    // no slot breakdown. Pack count is confirmed; the split below is inferred
    // from each set's actual card pool and should be treated as rough.
    EXTRA: {
      label: 'Extra Booster',
      verified: false,
      packsPerBox: 24,
      cardsPerPack: 12,
      perBox: { C: 179, UC: 0, R: 78, L: 2, SR: 25, SEC: 0.75, ALT: 2,
                SP: 0.2, MANGA: 0.03, ULTRA: 0.01, TR: 0,
                DON: 1, DONGOLD: 0.1, FOIL: 0 }
    },
    // Premium Boosters are 20 packs of 10 cards (200 per box), with roughly
    // two Jolly Roger foils per pack. Pack structure is confirmed; the rarity
    // split is inferred.
    PREMIUM: {
      label: 'Premium Booster',
      verified: false,
      packsPerBox: 20,
      cardsPerPack: 10,
      // Premium displays ship 2 foil DON!! cards alongside the 20 packs.
      // Those two are the ordinary ones; Gold DON!! is a separate chase and
      // gets its own rate — pooling them made a $2 card and a $729 card
      // equally likely and put 36% of the box's value on that mistake.
      perBox: { C: 77.5, UC: 40, R: 26, L: 0.5, SR: 10, SEC: 1.5, ALT: 2.4,
                SP: 0.06, MANGA: 0.04, ULTRA: 0.01, TR: 0.04,
                DON: 2, DONGOLD: 0.2, FOIL: 40 }
    }
  };

  /* --------------------------------------------------------------------------
     SETS
     `id` matches the API's set_id exactly (including its two odd hybrid ids).
     `box` is an ESTIMATED sealed English booster box price in USD — these move
     constantly, so they are marked estimated until you edit them.
     -------------------------------------------------------------------------- */
  /* The rippable booster sets.

     `id` is kept from v1 on purpose even though the data source changed: it is
     what settings, box-price overrides and the selected set are stored under,
     so renaming it would quietly reset preferences that are already saved.

     `group` is the TCGplayer groupId this set maps to on TCGCSV — the join key
     for everything v2 fetches.

     `box` is now only a FALLBACK. Real box and case prices come from the
     sealed products in each set's own feed; this number is used when a set has
     no sealed listing (sold out, or not yet on sale) and is what the EST tag
     marks. */
  const SETS = [
    { id: 'OP-01',     group: 3188,  name: 'Romance Dawn',                   short: 'OP01', profile: 'STANDARD', box: 1150 },
    { id: 'OP-02',     group: 17698, name: 'Paramount War',                  short: 'OP02', profile: 'STANDARD', box: 500 },
    { id: 'OP-03',     group: 22890, name: 'Pillars of Strength',            short: 'OP03', profile: 'STANDARD', box: 350 },
    { id: 'OP-04',     group: 23024, name: 'Kingdoms of Intrigue',           short: 'OP04', profile: 'STANDARD', box: 270 },
    { id: 'OP-05',     group: 23213, name: 'Awakening of the New Era',       short: 'OP05', profile: 'STANDARD', box: 320 },
    { id: 'OP-06',     group: 23272, name: 'Wings of the Captain',           short: 'OP06', profile: 'STANDARD', box: 260 },
    { id: 'EB-01',     group: 23333, name: 'Memorial Collection',            short: 'EB01', profile: 'EXTRA',    box: 280 },
    { id: 'OP-07',     group: 23387, name: '500 Years in the Future',        short: 'OP07', profile: 'STANDARD', box: 210 },
    { id: 'OP-08',     group: 23462, name: 'Two Legends',                    short: 'OP08', profile: 'STANDARD', box: 230 },
    { id: 'OP-09',     group: 23589, name: 'Emperors in the New World',      short: 'OP09', profile: 'STANDARD', box: 175 },
    { id: 'OP-10',     group: 23766, name: 'Royal Blood',                    short: 'OP10', profile: 'STANDARD', box: 185 },
    { id: 'PRB-01',    group: 23496, name: 'Premium Booster — The Best',     short: 'PRB01', profile: 'PREMIUM', box: 140 },
    { id: 'OP-11',     group: 24241, name: 'A Fist of Divine Speed',         short: 'OP11', profile: 'STANDARD', box: 165 },
    { id: 'EB-02',     group: 23834, name: 'Anime 25th Collection',          short: 'EB02', profile: 'EXTRA',    box: 500 },
    { id: 'OP-12',     group: 24302, name: 'Legacy of the Master',           short: 'OP12', profile: 'STANDARD', box: 150 },
    { id: 'PRB-02',    group: 24305, name: 'Premium Booster — The Best Vol.2', short: 'PRB02', profile: 'PREMIUM', box: 120 },
    { id: 'OP-13',     group: 24303, name: 'Carrying On His Will',           short: 'OP13', profile: 'STANDARD', box: 150 },
    { id: 'OP14-EB04', group: 24537, name: "The Azure Sea's Seven",          short: 'OP14', profile: 'STANDARD', box: 140 },
    { id: 'EB-03',     group: 24545, name: 'One Piece Heroines Edition',     short: 'EB03', profile: 'EXTRA',    box: 300 },
    { id: 'OP15-EB04', group: 24637, name: "Adventure on Kami's Island",     short: 'OP15', profile: 'STANDARD', box: 130 },
    { id: 'OP-16',     group: 24664, name: 'The Time of Battle',             short: 'OP16', profile: 'STANDARD', box: 150 },
    // New in v2. optcgapi never carried OP-17 at all — its database stops at
    // OP-15 by their own description, and OP-16 arrived only partially.
    { id: 'OP-17',     group: 24736, name: "The World's Strongest Warriors", short: 'OP17', profile: 'STANDARD', box: 110 },
    { id: 'OP-18',     group: 24833, name: 'The Dominance of God', short: 'OP18', profile: 'STANDARD', box: 0, verified: false }
  ];

  /* Everything above is sealed booster product. Starter decks and promos are
     added at runtime from their own endpoints and marked differently, because
     they must never enter pack odds or box EV. */
  SETS.forEach(s => { s.kind = 'booster'; });

  /* Everything that is not a booster product. Browsable and collectable, but
     never part of pack odds or box EV — you cannot pull a judge card. */
  const PROMO_SET = 'PROMO';

  /* card_color is space-separated for multicolour cards ("Green Red"), so
     filtering matches by inclusion — a Green/Red card belongs under both. */
  const COLORS = ['Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow'];

  /* v2 takes its data from TCGCSV through the Worker; see source.js. The old
     optcgapi endpoints are gone rather than kept "just in case" — a dead URL
     left in a config table is an invitation to accidentally read from it. */

  return { GRADERS, CONDITIONS, COLLECTION_KINDS, VARIANT_TAGS, RARITY, SLOTS,
           PROFILES, SETS, DON_NON_BOOSTER, DON_SET_CODES, PROMO_SET, COLORS };
})();

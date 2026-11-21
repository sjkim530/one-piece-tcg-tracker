/* Cache regressions. Run with node tests-cache.cjs; no browser or network. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const app = read('app.js');
// Exercise the app's real cache/loading code without booting its UI.
const cacheCode = app.slice(app.indexOf("  const IMG_BASE ="), app.indexOf('  function pricedShare('));
const dateCode = app.slice(app.indexOf('  function catalogDate('), app.indexOf('  function catalogOptions('));
assert.ok(cacheCode.includes('async function fetchCurrentCards'));
assert.ok(dateCode.includes('function catalogDate'));

const source = 'https://feed.example';
const updated = '2026-11-20T20:06:21Z';
const card = (id, set_id, extra = {}) => ({ id, set_id, printing: 'Normal',
  card_name: id, set_name: set_id, market_price: 10,
  card_image: `https://tcgplayer-cdn.tcgplayer.com/product/${id}_400w.jpg`, ...extra });
const product = (id, set_id, market_price = 90) => ({ id, set_id, market_price });
const snapshot = (schema = 4, rows = [card('old', 'OP-01')], products = []) => ({
  at: '2026-11-19T20:00:00Z', rows, products,
  feed: { source, schema, updated, mock: false }
});

function harness(cached = null) {
  const writes = [], history = [];
  const S = { cards: [], products: [] };
  const SRC = { base: () => source, isMock: () => false,
    loadUpdated: async () => updated, buildSets: async () => [],
    loadAll: async () => ({ cards: [card('fresh', 'OP-01')], products: [], failed: [] }) };
  const ctx = { console, S, SRC, KEY: { cards: 'cards' },
    load: () => structuredClone(cached),
    save: (key, value) => writes.push(structuredClone(value)),
    OQ_HISTORY: { record: async (...args) => history.push(structuredClone(args)) },
    invalidate() {} };
  vm.createContext(ctx);
  vm.runInContext(read('data.js') + '\n' + read('engine.js') +
    '\nconst D = OQ_DATA, E = OQ_ENGINE;\n' + cacheCode + '\n' + dateCode +
    '\nglobalThis.api = { slimCard, fatCard, fetchCards, fetchCurrentCards, refreshCachedCards, catalogDate };', ctx);
  return { ...ctx.api, S, SRC, writes, history };
}

test('cached names and custom artwork survive a roundtrip', () => {
  const h = harness();
  for (const row of [
    card('deck', 'ST-29', { set_name: 'A new starter deck' }),
    card('future', 'OP-19', { set_name: 'A future booster' }),
    card('event', 'PROMO', { set_name: 'OP18 Release Event Cards' }),
    card('custom', 'OP-01', { set_name: 'Special provenance', card_image: 'custom.jpg' })
  ]) {
    const restored = h.fatCard(h.slimCard(row));
    assert.equal(restored.set_name, row.set_name);
    assert.equal(restored.card_image, row.card_image);
  }
});

test('registered set names still compress and rebuild', () => {
  const h = harness();
  const row = card('registered', 'OP-01', { set_name: 'Romance Dawn' });
  const slim = h.slimCard(row);
  assert.equal(slim.set_name, undefined);
  assert.equal(h.fatCard(slim).set_name, row.set_name);
});

test('current cache starts immediately without requesting the feed', async () => {
  const h = harness(snapshot());
  h.SRC.loadUpdated = () => { throw new Error('Must not request network'); };
  assert.equal((await h.fetchCards(false)).fromCache, true);
  assert.equal(h.S.cards[0].id, 'old');
  assert.equal(h.S.catalogFeed.stale, false);
  assert.equal(h.history.length, 1);
});

for (const schema of [2, 3]) {
  test(`schema ${schema} cache refreshes online to recover classification and names`, async () => {
    const h = harness(snapshot(schema));
    assert.equal((await h.fetchCards(false)).fromCache, false);
    assert.equal(h.S.cards[0].id, 'fresh');
    assert.equal(h.writes[0].feed.schema, 4);
  });

  test(`schema ${schema} cache remains available offline without new history`, async () => {
    const h = harness(snapshot(schema));
    // loadUpdated returns null on actual Worker failure; group loading rejects.
    h.SRC.loadUpdated = async () => null;
    h.SRC.buildSets = async () => { throw new Error('Offline'); };
    assert.equal((await h.fetchCards(false)).fromCache, true);
    assert.equal(h.S.cards[0].id, 'old');
    assert.equal(h.S.catalogFeed.schema, schema);
    assert.equal(h.history.length, 0);
    assert.equal(h.writes.length, 0);
    assert.match(h.catalogDate(), /Refresh unavailable; using saved data/);
  });
}

test('forced refresh failure falls back to same-source cache', async () => {
  const h = harness(snapshot());
  h.SRC.loadUpdated = async () => { throw new Error('Offline'); };
  assert.equal((await h.fetchCards(true)).fromCache, true);
  assert.equal(h.S.cards[0].id, 'old');
  assert.equal(h.history.length, 0);
  assert.match(h.catalogDate(), /using saved data/);
});

test('unrelated or incompatible caches cannot serve as offline fallback', async () => {
  for (const cache of [{ ...snapshot(), feed: { source: 'https://other.example', schema: 4 } }, snapshot(1)]) {
    const h = harness(cache);
    h.SRC.loadUpdated = async () => { throw new Error('Offline'); };
    await assert.rejects(h.fetchCards(false), /Offline/);
    assert.equal(h.S.cards.length, 0);
  }
});

test('partial refresh retains failed-set cards and sealed products but prefers fresh IDs', async () => {
  const h = harness();
  h.S.cards = [card('failed', 'OP-01'), card('fresh', 'OP-02', { market_price: 1 }),
    card('removed', 'OP-02'), card('promo-old', 'PROMO'), card('promo-new', 'PROMO')];
  h.S.products = [product('failed-box', 'OP-01'), product('fresh-box', 'OP-02', 1)];
  h.S.catalogFeed = snapshot().feed;
  h.SRC.loadAll = async () => ({
    cards: [card('fresh', 'OP-02', { market_price: 20 }), card('promo-new', 'PROMO', { market_price: 30 })],
    products: [product('fresh-box', 'OP-02', 100)],
    failed: [{ set: 'OP-01', error: 'Timeout' }, { set: 'PROMO', error: 'Timeout' }]
  });
  await h.fetchCurrentCards(updated);
  assert.deepEqual(Array.from(h.S.cards, c => c.id), ['fresh', 'promo-new', 'failed', 'promo-old']);
  assert.equal(h.S.cards[0].market_price, 20);
  assert.equal(h.S.cards[1].market_price, 30);
  assert.deepEqual(Array.from(h.S.products, p => p.id), ['fresh-box', 'failed-box']);
  assert.equal(h.S.products[0].market_price, 100);
  assert.ok(h.S.byKey.failed);
  assert.equal(h.S.loadFailures.length, 2);
  assert.equal(h.S.catalogFeed.partial, true);
  assert.equal(h.writes.length, 0);
  assert.equal(h.history.length, 0);
  assert.match(h.catalogDate(), /Partial update; some sets may use saved prices/);
});

test('cold partial refresh also retains failed namespaces from compatible disk cache', async () => {
  const h = harness(snapshot(3, [card('old', 'OP-01')]));
  h.SRC.loadAll = async () => ({ cards: [card('fresh', 'OP-02')], products: [],
    failed: [{ set: 'OP-01', error: 'Timeout' }] });
  await h.fetchCards(false);
  assert.deepEqual(Array.from(h.S.cards, c => c.id), ['fresh', 'old']);
  assert.equal(h.history.length, 0);
  assert.equal(h.writes.length, 0);
});

for (const schema of [2, 3]) {
  test(`partial schema ${schema} migration retains misclassified booster cards until complete recovery`, async () => {
    const h = harness(snapshot(schema, [
      card('legacy-op18', 'PROMO', { originSet: 'OP18', card_set_id: 'OP18-001' }),
      card('fresh', 'PROMO', { market_price: 1 })
    ], [product('legacy-box', 'PROMO')]));
    h.SRC.loadAll = async () => ({ cards: [card('fresh', 'OP-02', { market_price: 20 })],
      products: [], failed: [{ set: 'OP-18', error: 'Timeout' }] });
    await h.fetchCards(false);
    assert.deepEqual(Array.from(h.S.cards, c => c.id), ['fresh', 'legacy-op18']);
    assert.equal(h.S.cards[0].market_price, 20);
    assert.equal(h.S.products[0].id, 'legacy-box');
    assert.ok(h.S.byKey['legacy-op18']);
    assert.equal(h.S.catalogFeed.migrationPending, true);
    // A second partial attempt must not forget that the retained namespace is old.
    await h.refreshCachedCards();
    assert.ok(h.S.byKey['legacy-op18']);
    assert.equal(h.writes.length, 0);
    assert.equal(h.history.length, 0);
    h.SRC.loadAll = async () => ({ cards: [card('legacy-op18', 'OP-18')], products: [], failed: [] });
    await h.refreshCachedCards();
    assert.equal(h.S.byKey['legacy-op18'].set_id, 'OP-18');
    assert.equal(h.S.catalogFeed.migrationPending, false);
    assert.equal(h.S.cards.length, 1);
    assert.equal(h.S.products.length, 0);
    assert.equal(h.writes.length, 1);
    assert.equal(h.history.length, 1);
  });
}

test('partial refresh never merges rows from another source', async () => {
  const h = harness({ ...snapshot(), feed: { source: 'https://other.example', schema: 4 } });
  h.S.cards = [card('other', 'OP-01')];
  h.S.catalogFeed = { source: 'https://other.example' };
  h.SRC.loadAll = async () => ({ cards: [card('fresh', 'OP-02')], products: [],
    failed: [{ set: 'OP-01', error: 'Timeout' }] });
  await h.fetchCurrentCards(updated);
  assert.deepEqual(Array.from(h.S.cards, c => c.id), ['fresh']);
});

test('successful recovery clears warnings and publishes only the complete new snapshot', async () => {
  const h = harness();
  h.S.cards = [card('old', 'OP-01')];
  h.S.catalogFeed = { ...snapshot().feed, partial: true, stale: true };
  h.S.loadFailures = [{ set: 'OP-01', error: 'Timeout' }];
  await h.refreshCachedCards();
  assert.deepEqual(Array.from(h.S.cards, c => c.id), ['fresh']);
  assert.equal(h.S.catalogFeed.partial, false);
  assert.equal(h.S.catalogFeed.stale, undefined);
  assert.equal(h.S.loadFailures.length, 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.history.length, 1);
  assert.doesNotMatch(h.catalogDate(), /saved|Partial update/);
});

test('total background failure retains loaded holdings and surfaces saved-data status', async () => {
  const h = harness();
  h.S.cards = [card('old', 'OP-01')];
  h.S.catalogFeed = { ...snapshot().feed, updated: '2026-11-19T20:00:00Z' };
  h.SRC.loadAll = async () => ({ cards: [], products: [], failed: [{ set: 'OP-01', error: 'Timeout' }] });
  await h.refreshCachedCards();
  assert.equal(h.S.cards[0].id, 'old');
  assert.match(h.catalogDate(), /using saved data/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.history.length, 0);
});

test('unavailable update timestamp marks the warm cache as saved data', async () => {
  const h = harness(snapshot());
  await h.fetchCards(false);
  h.SRC.loadUpdated = async () => null;
  await h.refreshCachedCards();
  assert.equal(h.S.cards[0].id, 'old');
  assert.match(h.catalogDate(), /Refresh unavailable; using saved data/);
});

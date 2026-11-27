/* Card-add feedback must follow durable persistence. Run node tests-feedback.cjs. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness({ legacy = false } = {}) {
  const nodes = new Map(), handlers = new Map(), timers = new Map();
  let sequence = 0, saves = 0, failure = false;
  function $(selector) {
    if (legacy && selector === '#catalog-add-status') return null;
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', dataset: {}, value: '', disabled: false, focus() {} });
    return nodes.get(selector);
  }
  $('#catalog-binder').value = 'keep'; $('#catalog-quantity').valueAsNumber = 2;
  const card = { printing: 'Foil' }, state = { byKey: { card }, items: [], tab: 'catalog', curCol: null };
  const context = vm.createContext({ $, S: state, console,
    catalogCardKey: 'card', catalogPrinting: 'Foil', catalogFilters: [], CATALOG_PAGE: 48,
    C: { newItem: (colId, key, options) => ({ colId, key, ...options }) },
    itemsIn: binder => state.items.filter(item => item.colId === binder),
    holdingPrinting: item => item.printing, liveCols: () => [{ id: 'keep', name: 'Keeping' }],
    sameBinder: (a, b) => a === b,
    persistCollection() { saves++; if (failure) state.items = []; return !failure; },
    on: (selector, type, handler) => handlers.set(selector + ':' + type, handler),
    setTimeout(fn) { timers.set(++sequence, fn); return sequence; }, clearTimeout(id) { timers.delete(id); },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    wireArtworkViewer() {}, wireCardScan() {}, wireCatalogComps() {}, wireWatchlist() {},
    showCardSection() {}, renderCatalogResults() {}, openCatalogCard() {}, renderScannerResults() {}
  });
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const feedback = source.slice(source.indexOf('  let catalogFeedbackTimer;'), source.indexOf('  function wireArtworkViewer()'));
  const wiring = source.slice(source.indexOf('  function wireCatalog()'), source.indexOf('  /* =============================================================== SHELL'));
  vm.runInContext(feedback + '\n' + wiring + '\nfunction renderCatalogCard(){renderCatalogOwnership();}\nwireCatalog();renderCatalogOwnership();', context);
  function emit(selector, type) { handlers.get(selector + ':' + type)({ preventDefault() {}, currentTarget: $(selector) }); }
  return { $, state, emit, timers, context, fail() { failure = true; }, saves: () => saves };
}

test('successful durable add shows adjacent confirmation and prevents a rapid duplicate submit', () => {
  const h = harness(); h.emit('#catalog-add', 'submit');
  assert.equal(h.saves(), 1); assert.equal(h.state.items[0].qty, 2);
  assert.match(h.$('#catalog-add-status').textContent, /Added 2 copies to Keeping. Saved on this device/);
  assert.equal(h.$('#catalog-add-status').dataset.state, 'success');
  const button = h.$('#catalog-add button[type="submit"]');
  assert.match(button.textContent, /Added to Collection/); assert.equal(button.disabled, true);
  h.emit('#catalog-add', 'submit'); assert.equal(h.saves(), 1);
  for (const callback of h.timers.values()) callback();
  assert.equal(button.textContent, 'Add to Collection'); assert.equal(button.disabled, false);
});

test('failed add never produces success feedback or the added button label', () => {
  const h = harness(); h.fail(); h.emit('#catalog-add', 'submit');
  assert.equal(h.saves(), 1); assert.equal(h.state.items.length, 0); assert.equal(h.state.curCol, null);
  assert.equal(h.$('#catalog-add-status').dataset.state, 'error');
  assert.match(h.$('#catalog-add-status').textContent, /Could not save/);
  assert.equal(h.$('#catalog-add button[type="submit"]').textContent, 'Add to Collection');
  assert.equal(h.timers.size, 0);
});

test('failure after a successful add clears its old green status and reset timer', () => {
  const h = harness(); h.emit('#catalog-add', 'submit');
  h.emit('#catalog-quantity', 'input'); h.fail(); h.emit('#catalog-add', 'submit');
  assert.equal(h.saves(), 2); assert.equal(h.timers.size, 0);
  assert.equal(h.$('#catalog-add-status').dataset.state, 'error');
  assert.doesNotMatch(h.$('#catalog-add-status').textContent, /Saved on this device/);
  assert.equal(h.$('#catalog-add button[type="submit"]').dataset.saved, undefined);
});

test('quantity, binder, finish and card changes clear stale confirmation', () => {
  for (const change of [
    h => h.emit('#catalog-quantity', 'input'), h => h.emit('#catalog-binder', 'change'),
    h => { h.$('#catalog-finish').value = 'Foil'; h.emit('#catalog-finish', 'change'); },
    h => vm.runInContext('renderCatalogOwnership()', h.context)
  ]) {
    const h = harness(); h.emit('#catalog-add', 'submit'); change(h);
    assert.equal(h.$('#catalog-add-status').textContent, '');
    assert.equal(h.$('#catalog-add-status').dataset.state, undefined); assert.equal(h.timers.size, 0);
    assert.equal(h.$('#catalog-add button[type="submit"]').disabled, false);
  }
});

test('cached older markup can still add and display confirmation without the new status node', () => {
  const h = harness({ legacy: true }); h.emit('#catalog-add', 'submit');
  assert.equal(h.saves(), 1);
  assert.match(h.$('#catalog-ownership').textContent, /Saved on this device/);
  assert.match(h.$('#catalog-add button[type="submit"]').textContent, /Added to Collection/);
  h.emit('#catalog-quantity', 'input'); h.fail(); h.emit('#catalog-add', 'submit');
  assert.match(h.$('#catalog-ownership').textContent, /Could not save/);
});

test('early settings initialization tolerates old markup and contains a backup wiring failure', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const start = source.indexOf('  async function boot()');
  const initialization = source.slice(start, source.indexOf('    const sharedUpdate', start));
  for (const failing of [false, true]) {
    const status = { textContent: '' }; let refreshed = false;
    const context = vm.createContext({
      $: selector => selector === '#backup-status' ? status : null, APP_VERSION: 'old-executed-build', wired: false,
      wireBackup() { if (failing) throw Error('Unavailable'); }, backup: { refresh() { refreshed = true; } }
    });
    await vm.runInContext(initialization + '\n}\nboot();', context);
    assert.equal(refreshed, !failing);
    if (failing) assert.match(status.textContent, /Reload the app/);
  }
});

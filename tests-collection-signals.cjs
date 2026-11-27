/* Exact-finish collection verdict and badge regressions. No browser/network needed. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function harness() {
  const nodes = new Map(), badges = [];
  function $(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', disabled: false });
    return nodes.get(selector);
  }
  const card = { id: 7, printing: 'Foil', alt_printing: { printing: 'Normal' } };
  const S = { byKey: { '7': card } };
  const run = { signals: new Map() };
  const context = vm.createContext({ S, $, $$: () => badges,
    C: { qtyOf: item => item.qty ?? 1, isGraded: item => !!item.grader },
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    signalLabels: { 'Sell Now': 'Review for sale' }, collectionHistoryRun: run,
    fetch() { throw Error('Collection badges must reuse the existing scan'); }
  });
  const printing = source.slice(source.indexOf('  function holdingPrinting('), source.indexOf('  function priceForKey('));
  const helpers = source.slice(source.indexOf('  function collectionSignal('), source.indexOf('  function refreshCollectionSignals('));
  vm.runInContext(printing + '\nconst holdingKey=(key,printing)=>JSON.stringify([String(key),printing]);\n' + helpers, context);
  const api = vm.runInContext('({collectionSignal,collectionSignalBadge,isSellNow,renderCollectionSignals})', context);
  const key = finish => JSON.stringify(['7', finish]);
  const item = (id = 'a', finish = 'Foil') => ({ id, key: '7', printing: finish, qty: 1, cond: 'NM' });
  function badge(id, tagName = 'SPAN') {
    const node = { tagName, dataset: { collectionSignal: id }, setAttribute(name, value) { this[name] = value; } };
    badges.push(node); return node;
  }
  return { api, context, S, run, key, item, badge, $ };
}

test('Buy/Sell/Hold use exact catalog ID and finish without leaking another finish verdict', () => {
  const h = harness();
  for (const [call, label] of [['Buy Now', 'Buy'], ['Sell Now', 'Sell'], ['Hold', 'Hold']]) {
    h.run.signals.set(h.key('Foil'), { call, reason: 'Evidence for this finish.' });
    h.run.signals.set(h.key('Normal'), { call: 'Sell Now', reason: 'Other finish.' });
    const before = JSON.stringify(h.S), item = h.item();
    assert.equal(h.api.collectionSignal(item).label, label);
    assert.match(h.api.collectionSignal(item).reason, /Raw near-mint Foil/);
    assert.equal(h.api.collectionSignal(h.item('normal', 'Normal')).label, 'Sell');
    assert.equal(JSON.stringify(h.S), before); assert.equal(item.qty, 1);
  }
});

test('loading, insufficient evidence and missing history remain distinct and never become Hold', () => {
  const h = harness(), item = h.item();
  vm.runInContext('collectionHistoryRun={}', h.context);
  assert.equal(h.api.collectionSignal(item).label, 'Checking');
  vm.runInContext('collectionHistoryRun={signals:new Map()}', h.context);
  assert.equal(h.api.collectionSignal(item).label, 'Unavailable');
  vm.runInContext(`collectionHistoryRun.signals.set(${JSON.stringify(h.key('Foil'))},{call:'Insufficient data',reason:'Too few quotes.'})`, h.context);
  assert.equal(h.api.collectionSignal(item).label, 'No clear signal');
  assert.match(h.api.collectionSignal(item).reason, /Too few quotes/);
});

test('graded, non-NM, unlinked, unknown finish and zero-copy holdings do not inherit raw NM signals', () => {
  const h = harness(); h.run.signals.set(h.key('Foil'), { call: 'Sell Now', reason: 'Raw market.' });
  for (const extra of [{ grader: 'PSA', grade: 10 }, { cond: 'LP' }, { key: 'missing' }, { printing: 'Nonexistent' }, { qty: 0 }]) {
    const result = h.api.collectionSignal({ ...h.item(), ...extra });
    assert.equal(result.label, 'Unavailable'); assert.notEqual(result.call, 'Sell Now');
  }
  const missingFinish = h.item(); delete missingFinish.printing;
  assert.equal(h.api.collectionSignal(missingFinish).label, 'Unavailable');
  assert.match(h.api.collectionSignal({ ...h.item(), grader: 'PSA' }).reason, /grade or condition/);
});

test('both view badges carry verdict colors and an escaped accessible explanation; edit badge preserves card click data', () => {
  const h = harness(); h.run.signals.set(h.key('Foil'), { call: 'Buy Now', reason: 'Low <market> & rising.' });
  const gallery = h.api.collectionSignalBadge(h.item());
  const edit = h.api.collectionSignalBadge(h.item(), true);
  for (const html of [gallery, edit]) {
    assert.match(html, /data-call="Buy Now"/); assert.match(html, />Buy</);
    assert.match(html, /data-collection-signal="a"/); assert.match(html, /aria-label="Buy\. Raw near-mint Foil/);
    assert.match(html, /Low &lt;market&gt; &amp; rising/); assert.doesNotMatch(html, /hidden/);
  }
  assert.match(gallery, /^<span .*role="img"/);
  assert.match(edit, /^<button type="button"/); assert.match(edit, /data-key="7" data-printing="Foil"/);
});

test('async refresh updates gallery and edit badges and preserves unique-finish Review for sale counts', () => {
  const h = harness(), items = [h.item('a'), h.item('b'), h.item('c', 'Normal'), { ...h.item('graded'), grader: 'PSA' }];
  const gallery = h.badge('a'), edit = h.badge('a', 'BUTTON'), normal = h.badge('c');
  h.run.signals.set(h.key('Foil'), { call: 'Sell Now', reason: 'Sell evidence.' });
  h.run.signals.set(h.key('Normal'), { call: 'Hold', reason: 'Hold evidence.' });
  h.api.renderCollectionSignals(items);
  assert.equal(h.$('#col-sell').textContent, 'Review for sale (1)');
  assert.equal(gallery.textContent, 'Sell'); assert.equal(edit.textContent, 'Sell'); assert.equal(normal.textContent, 'Hold');
  assert.match(edit['aria-label'], /View card details/); assert.equal(h.api.isSellNow(items[3]), false);
  h.run.signals.set(h.key('Foil'), { call: 'Buy Now', reason: 'Buy evidence.' }); h.api.renderCollectionSignals(items);
  assert.equal(h.$('#col-sell').textContent, 'Review for sale (0)');
  assert.equal(gallery.textContent, 'Buy'); assert.equal(edit.dataset.call, 'Buy Now');
});

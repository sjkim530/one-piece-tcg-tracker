/* Rarity-aware market policy and offline/live parity. Run node tests-market.cjs. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const market = require('./market-analysis');
const today = 20200;
const stamp = new Date(today * 86400000).toISOString();
function sellSeries(price = 100) {
  return Array.from({ length: 201 }, (_, day) => [today - 200 + day,
    day >= 194 ? price : day >= 167 && day <= 173 ? Math.round(price * 1.8)
      : Math.max(1, Math.round(price * (.4 + day % 40 / 100))), price]);
}
function buySeries(price = 1000) {
  return Array.from({ length: 201 }, (_, day) => [today - 200 + day,
    day >= 194 ? price : day >= 167 && day <= 173 ? Math.round(price * .8)
      : Math.round(price * (1.4 + day % 40 / 100)), Math.round(price * .9)]);
}
function engine() {
  const context = vm.createContext({});
  for (const file of ['data.js', 'engine.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
  return vm.runInContext('OQ_ENGINE', context);
}

test('R sale eligibility changes exactly at $1 while timing gates stay unchanged', () => {
  const below = market.analyze(sellSeries(99), today, 'R');
  const at = market.analyze(sellSeries(100), today, 'R');
  assert.equal(below.call, 'Hold'); assert.equal(below.sellEligible, false);
  assert.match(below.sellReason, /at least \$1/);
  assert.equal(at.call, 'Sell Now'); assert.equal(at.sellEligible, true); assert.equal(at.buyEligible, true);
  for (const rarity of ['SR', 'SEC', 'SP', 'TR', 'L', 'PR', 'DON']) {
    assert.equal(market.analyze(sellSeries(20), today, rarity).call, 'Sell Now', rarity);
    assert.equal(market.eligibility(1, rarity).sellEligible, true, rarity + ' positive-cent policy');
  }
});

test('C/UC, unknown rarity and nonpositive price are excluded from both directions', () => {
  for (const rarity of ['C', 'UC', '', '?', undefined, 'new-unknown-rarity']) {
    for (const series of [sellSeries(50000), buySeries(50000)]) {
      const verdict = market.analyze(series, today, rarity);
      assert.equal(verdict.call, 'Hold', String(rarity));
      assert.equal(verdict.sellEligible, false); assert.equal(verdict.buyEligible, false);
    }
  }
  for (const price of [0, -1, NaN, Infinity]) {
    assert.equal(market.eligibility(price, 'SR').sellEligible, false);
    assert.equal(market.eligibility(price, 'SR').buyEligible, false);
    assert.notEqual(market.analyze(sellSeries(price), today, 'SR').call, 'Sell Now');
  }
});

test('printed rarity uses canonical SP/TR overrides while starred C/UC/R keep base restrictions', () => {
  const E = engine();
  for (const rarity of ['C', 'UC', 'R']) {
    const badge = E.rarityBadge({ card_name: 'Example (Alternate Art)', rarity });
    assert.equal(badge.text, rarity); assert.equal(badge.star, true);
    assert.equal(market.analyze(sellSeries(99), today, badge.text).sellEligible, false);
    assert.equal(market.analyze(buySeries(99), today, badge.text).buyEligible, false);
  }
  for (const [tag, card] of [['SP', { card_name: 'Example (SP)', rarity: 'C' }], ['TR', { card_name: 'Example', rarity: 'TR' }]]) {
    const badge = E.rarityBadge(card);
    assert.equal(badge.text, tag);
    assert.equal(market.analyze(sellSeries(20), today, badge.text).call, 'Sell Now');
  }
});

test('sub-$10 Buy uses the same rarity policy as Sell, including the exact R $1 boundary', () => {
  assert.equal(market.strategy, 'rarity-trades-v1');
  assert.equal(market.analyze(buySeries(99), today, 'R').call, 'Hold');
  assert.equal(market.analyze(buySeries(100), today, 'R').call, 'Buy Now');
  for (const rarity of ['SR', 'SEC', 'SP', 'TR', 'L', 'PR', 'DON']) {
    const verdict = market.analyze(buySeries(20), today, rarity);
    assert.equal(verdict.call, 'Buy Now', rarity);
    assert.equal(verdict.buyEligible, verdict.sellEligible);
    assert.equal(market.eligibility(1, rarity).buyEligible, true);
  }
});

test('new Buy eligibility does not bypass freshness, history, rising momentum, lower percentile or listing gates', () => {
  const points = buySeries(100);
  assert.equal(market.analyze(points, today + 4, 'R').call, 'Insufficient data');
  assert.notEqual(market.analyze(points.slice(-18), today, 'R').call, 'Buy Now');
  for (const low of [49, 96]) {
    const changed = points.map(point => point.slice()); changed.at(-1)[2] = low;
    assert.notEqual(market.analyze(changed, today, 'R').call, 'Buy Now');
  }
  for (const low of [50, 95]) {
    const changed = points.map(point => point.slice()); changed.at(-1)[2] = low;
    assert.equal(market.analyze(changed, today, 'R').call, 'Buy Now');
  }
  const falling = points.map(point => point.slice());
  for (let i = 167; i <= 173; i++) falling[i][1] = 180;
  assert.notEqual(market.analyze(falling, today, 'R').call, 'Buy Now');
  const aboveRange = points.map((point, i) => [point[0], i < 167 || i > 173 && i < 194 ? 40 + i % 40 : point[1], point[2]]);
  assert.notEqual(market.analyze(aboveRange, today, 'R').call, 'Buy Now');
});

test('freshness, history, falling momentum, upper percentile and 90–125% listing gates remain required', () => {
  const points = sellSeries();
  assert.equal(market.analyze(points, today + 4, 'SR').call, 'Insufficient data');
  assert.notEqual(market.analyze(points.slice(-18), today, 'SR').call, 'Sell Now');
  for (const low of [89, 126]) {
    const changed = points.map(point => point.slice()); changed.at(-1)[2] = low;
    assert.notEqual(market.analyze(changed, today, 'SR').call, 'Sell Now');
  }
  for (const low of [90, 125]) {
    const changed = points.map(point => point.slice()); changed.at(-1)[2] = low;
    assert.equal(market.analyze(changed, today, 'SR').call, 'Sell Now');
  }
  const rising = points.map(point => point.slice());
  for (let i = 167; i <= 173; i++) rising[i][1] = 50;
  assert.notEqual(market.analyze(rising, today, 'SR').call, 'Sell Now');
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optcg-market-'));
  for (const file of ['market-analysis.js', 'build-market-summary.cjs', 'track-market-signals.cjs']) fs.copyFileSync(path.join(__dirname, file), path.join(dir, file));
  const archive = path.join(dir, 'price-history'); fs.mkdirSync(archive);
  const cards = { '1': { rarity: 'R' }, '2': { rarity: 'SR' }, '3': { rarity: 'C' }, '5': { rarity: 'R' }, '6': { rarity: 'SR' } };
  const series = { '1:Foil': sellSeries(100), '2:Foil': sellSeries(20), '3:Foil': sellSeries(50000), '4:Foil': sellSeries(100), '5:Foil': sellSeries(100).slice(-18), '6:Foil': buySeries(20) };
  fs.writeFileSync(path.join(archive, 'status.json'), JSON.stringify({ sourceUpdatedAt: stamp }));
  fs.writeFileSync(path.join(archive, 'singles.json'), JSON.stringify({ sourceUpdatedAt: stamp, products: { 1: 'Character', 2: 'Character', 3: 'Character', 4: 'Character', 6: 'Character' } }));
  fs.writeFileSync(path.join(dir, 'card-metadata.json'), JSON.stringify({ version: 1, sourceUpdatedAt: stamp, cards }));
  for (let bucket = 0; bucket < 256; bucket++) fs.writeFileSync(path.join(archive, bucket + '.json'), JSON.stringify(bucket ? {} : Object.fromEntries(
    Object.entries(series).map(([key, points]) => [key, points.slice().reverse().flat()]))));
  const run = file => execFileSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { dir, series, cards, run, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('precomputed summary equals live analysis with identical canonical rarity and price data', () => {
  const f = fixture();
  try {
    f.run('build-market-summary.cjs');
    const summary = JSON.parse(fs.readFileSync(path.join(f.dir, 'market-summary.json')));
    assert.equal(summary.version, market.summaryVersion); assert.equal(summary.strategy, market.strategy);
    for (const [key, points] of Object.entries(f.series)) {
      const live = market.analyze(points, today, f.cards[key.split(':')[0]]?.rarity);
      assert.deepEqual(summary.rows[key].analysis, live);
    }
    assert.equal(summary.rows['2:Foil'].analysis.call, 'Sell Now');
    assert.equal(summary.rows['3:Foil'].analysis.call, 'Hold');
    assert.equal(summary.rows['4:Foil'].analysis.sellEligible, false);
    assert.equal(summary.rows['5:Foil'].analysis.evidence, 'limited');
    assert.equal(summary.rows['5:Foil'].analysis.rarity, 'R');
    assert.equal(summary.rows['6:Foil'].analysis.call, 'Buy Now');
  } finally { f.clean(); }
});

test('new tracker flags follow rarity policy and old same-day snapshots stay byte-for-byte untouched', () => {
  const f = fixture();
  try {
    f.run('track-market-signals.cjs');
    const file = path.join(f.dir, 'signal-ledger', today + '.json');
    const snapshot = JSON.parse(fs.readFileSync(file));
    assert.equal(snapshot.strategy, market.strategy);
    assert.deepEqual(snapshot.calls.map(row => row.key).sort(), ['1:Foil', '2:Foil', '6:Foil']);
    const report = JSON.parse(fs.readFileSync(path.join(f.dir, 'signal-performance.json')));
    assert.equal(report.version, 2); assert.equal(report.strategy, market.strategy); assert.equal(report.trackedDays, 1);
    for (const strategy of [undefined, 'rarity-sell-v1']) {
      const old = JSON.stringify({ version: 1, strategy, day: today, calls: [{ key: '3:Foil', call: 'Sell Now' }], peers: {} });
      fs.writeFileSync(file, old); f.run('track-market-signals.cjs');
      assert.equal(fs.readFileSync(file, 'utf8'), old);
      const legacy = JSON.parse(fs.readFileSync(path.join(f.dir, 'signal-performance.json')));
      assert.equal(legacy.trackedDays, 0); assert.equal(legacy.legacyDays, 1);
      assert.ok(legacy.results.every(row => row.total === 0));
    }
  } finally { f.clean(); }
});

test('headless publication fails rather than silently treating stale metadata as current', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.dir, 'card-metadata.json'), JSON.stringify({ version: 1, sourceUpdatedAt: 'old', cards: f.cards }));
    for (const file of ['build-market-summary.cjs', 'track-market-signals.cjs']) {
      assert.throws(() => f.run(file), /Current card rarity metadata/);
    }
  } finally { f.clean(); }
});

test('equivalent timestamp offsets refer to the same metadata snapshot', () => {
  const f = fixture();
  try {
    const offset = new Date(Date.parse(stamp) - 5 * 3600000).toISOString().replace('Z', '-05:00');
    fs.writeFileSync(path.join(f.dir, 'card-metadata.json'), JSON.stringify({ version: 1, sourceUpdatedAt: offset, cards: f.cards }));
    f.run('build-market-summary.cjs'); f.run('track-market-signals.cjs');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'signal-performance.json'))).trackedDays, 1);
  } finally { f.clean(); }
});

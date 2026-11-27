const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { canonicalMetadata, writeMetadata, rarityEngineSha256 } = require('./build-card-metadata.cjs');

const stamp = '2026-11-26T20:05:59+00:00';
const rarity = card => canonicalMetadata({ '1': card }, stamp).cards['1'].rarity;

test('alternate artwork keeps the printed common and uncommon rarity', () => {
  assert.equal(rarity({ card_name: 'Kuro (Alternate Art)', rarity: 'C' }), 'C');
  assert.equal(rarity({ card_name: 'Nami (Parallel) (Gold)', rarity: 'UC' }), 'UC');
});

test('SP and SPR override base rarity; printed TR remains TR', () => {
  assert.equal(rarity({ card_name: 'Luffy (SP)', rarity: 'C' }), 'SP');
  assert.equal(rarity({ card_name: 'Luffy (SPR)', rarity: 'UC' }), 'SP');
  assert.equal(rarity({ card_name: 'Luffy', rarity: 'TR' }), 'TR');
});

test('raw unnumbered DON products match the live source normalization', () => {
  assert.equal(rarity({ card_name: 'DON!! Card (Gold)', card_type: 'DON!!', rarity: '' }), 'DON');
});

test('unknown printed rarity remains explicitly unknown', () => {
  for (const raw of ['', '?', 'Mystery', 'Rare']) assert.equal(rarity({ card_name: 'Unknown card', rarity: raw }), null);
});

test('metadata preserves source instants and publishes only canonical codes', () => {
  const offsetStamp = '2026-11-26T15:05:59-05:00';
  const output = canonicalMetadata({ '1': { card_name: 'Private fixture name', rarity: 'R' } }, offsetStamp);
  assert.equal(output.sourceUpdatedAt, offsetStamp);
  assert.equal(Date.parse(output.sourceUpdatedAt), Date.parse(stamp));
  assert.deepEqual(output.cards, { '1': { rarity: 'R' } });
  assert.equal(output.rarityEngineSha256, rarityEngineSha256);
  assert.deepEqual(output.coverage, { products: 1, unknownRarity: 0 });
});

test('invalid or empty catalogs cannot replace existing metadata', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'optcg-metadata-'));
  const output = path.join(folder, 'metadata.json');
  try {
    fs.writeFileSync(output, 'existing');
    assert.throws(() => writeMetadata(output, canonicalMetadata({}, stamp)), /nonempty/);
    assert.throws(() => canonicalMetadata({ bad: { rarity: 'R' } }, stamp), /Invalid/);
    assert.throws(() => canonicalMetadata({ '1': { rarity: 'R' } }, 'not-a-date'), /timestamp/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'existing');
  } finally { fs.rmSync(folder, { recursive: true }); }
});

test('the public metadata has complete code coverage and the current rarity engine hash', () => {
  const output = JSON.parse(fs.readFileSync(path.join(__dirname, 'card-metadata.json')));
  const cards = Object.values(output.cards);
  assert.equal(cards.length, output.coverage.products);
  assert.equal(cards.filter(card => !card.rarity).length, output.coverage.unknownRarity);
  assert.equal(output.rarityEngineSha256, rarityEngineSha256);
  assert.ok(cards.length > 0);
  assert.ok(Number.isFinite(Date.parse(output.sourceUpdatedAt)));
});

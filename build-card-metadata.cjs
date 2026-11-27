/* Export printed rarity through the same engine used by the live app. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = __dirname;
const proxy = 'https://optcg-quant-data.gomu-gomu-santoryu.workers.dev';
const origin = 'https://sjkim530.github.io';
const known = new Set(['C', 'UC', 'R', 'SR', 'SEC', 'SP', 'TR', 'L', 'PR', 'DON']);
const context = vm.createContext({ URL, location: new URL(origin), localStorage: { getItem: () => null } });
context.window = context;
const engineHash = crypto.createHash('sha256');
for (const file of ['data.js', 'engine.js', 'source.js']) {
  const code = fs.readFileSync(path.join(root, file));
  if (file !== 'source.js') engineHash.update(code.toString('utf8').replace(/\r\n/g, '\n'));
  vm.runInContext(code.toString('utf8'), context, { filename: file });
}
const rarityEngineSha256 = engineHash.digest('hex');
const engine = vm.runInContext('OQ_ENGINE', context);

function canonicalMetadata(rawCards, sourceUpdatedAt, source = { kind: 'TCGCSV product catalog' }) {
  if (!rawCards || typeof rawCards !== 'object' || Array.isArray(rawCards) || !Object.keys(rawCards).length) {
    throw new Error('Card metadata requires a nonempty product catalog');
  }
  if (typeof sourceUpdatedAt !== 'string' || !Number.isFinite(Date.parse(sourceUpdatedAt))) throw new Error('Invalid card metadata timestamp');
  const cards = {};
  let unknownRarity = 0;
  for (const [id, raw] of Object.entries(rawCards).sort(([a], [b]) => Number(a) - Number(b))) {
    if (!/^\d+$/.test(id) || !raw || typeof raw !== 'object') throw new Error('Invalid card metadata product');
    const card = { card_name: String(raw.card_name || ''), rarity: raw.card_type === 'DON!!' ? 'DON' : String(raw.rarity || '') };
    const badge = String(engine.rarityBadge(card).text || '').trim().toUpperCase();
    const rarity = known.has(badge) ? badge : null;
    if (!rarity) unknownRarity++;
    cards[id] = { rarity };
  }
  return { version: 1, sourceUpdatedAt, rarityEngineSha256, source,
    coverage: { products: Object.keys(cards).length, unknownRarity }, cards };
}

function writeMetadata(output, metadata) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = output + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(metadata) + '\n');
  fs.renameSync(temporary, output);
}

async function get(route) {
  const response = await fetch(proxy + route, { headers: { Origin: origin, 'User-Agent': 'GrandLineVault-CardMetadata/1' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Card catalog request failed: ' + route + ' (' + response.status + ')');
  return response;
}

function timestamp(raw) {
  const date = new Date(raw.trim());
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid catalog timestamp');
  return date.toISOString().replace(/\.000Z$/, '+00:00').replace(/Z$/, '+00:00');
}

async function bootstrap() {
  const stamp = timestamp(await (await get('/updated')).text());
  const payload = await (await get('/groups')).json();
  if (payload.success !== true || !Array.isArray(payload.results) || !payload.results.length) throw new Error('Invalid catalog groups');
  const groups = [...new Set(payload.results.map(group => String(group.groupId)))];
  if (groups.some(group => !/^\d+$/.test(group))) throw new Error('Invalid catalog group ID');
  const rawCards = {};
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, groups.length) }, async () => {
    while (next < groups.length) {
      const group = groups[next++];
      const rows = context.SRC.parseCsv(await (await get('/g/' + group)).text());
      if (!rows.length || rows.some(row => !row.productId)) throw new Error('Invalid catalog CSV for group ' + group);
      for (const row of rows) if (context.SRC.isCard(row)) {
        rawCards[String(row.productId)] = { card_name: row.name, rarity: (row.extRarity || '').trim(), card_type: (row.extCardType || '').trim() };
      }
    }
  }));
  if (timestamp(await (await get('/updated')).text()) !== stamp) throw new Error('Catalog changed during metadata collection; retry');
  return canonicalMetadata(rawCards, stamp, { kind: 'TCGCSV catalog through app proxy', groups: groups.length });
}

async function main() {
  const args = process.argv.slice(2);
  const stdin = args.includes('--stdin');
  const outputAt = args.indexOf('--output');
  if (outputAt >= 0 && !args[outputAt + 1]) throw new Error('--output requires a path');
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--output') { index++; continue; }
    if (args[index] !== '--stdin') throw new Error('Unknown metadata build argument');
  }
  const output = outputAt < 0 ? path.join(root, 'card-metadata.json') : path.resolve(args[outputAt + 1]);
  let metadata;
  if (stdin) {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    metadata = canonicalMetadata(input.cards, input.sourceUpdatedAt);
  } else metadata = await bootstrap();
  writeMetadata(output, metadata);
  console.log('Exported printed rarity for ' + metadata.coverage.products + ' products; ' + metadata.coverage.unknownRarity + ' unknown');
}

module.exports = { canonicalMetadata, writeMetadata, rarityEngineSha256 };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

const fs = require('node:fs');
const path = require('node:path');
const market = require('./market-analysis');

const archive = path.join(__dirname, 'price-history');
const { sourceUpdatedAt } = JSON.parse(fs.readFileSync(path.join(archive, 'status.json'), 'utf8'));
const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, 'card-metadata.json'), 'utf8'));
if (metadata.version !== 1 || !Number.isFinite(Date.parse(sourceUpdatedAt)) || Date.parse(metadata.sourceUpdatedAt) !== Date.parse(sourceUpdatedAt) || !metadata.cards) {
  throw new Error('Current card rarity metadata is required to publish the market summary');
}
const day = Math.floor(Date.parse(sourceUpdatedAt) / 86400000);
if (!Number.isSafeInteger(day)) throw new Error('Invalid history timestamp');

const rows = {};
for (let bucket = 0; bucket < 256; bucket++) {
  const prices = JSON.parse(fs.readFileSync(path.join(archive, bucket + '.json'), 'utf8'));
  for (const [key, flat] of Object.entries(prices)) {
    if (!flat.length || flat.length % 3) throw new Error('Invalid price series for ' + key);
    const points = [];
    for (let i = flat.length - 3; i >= 0; i -= 3) {
      const point = flat.slice(i, i + 3);
      const [date, price, low] = point;
      if (!Number.isSafeInteger(date) || date > day || date <= (points.at(-1)?.[0] ?? -Infinity) ||
          !Number.isSafeInteger(price) || price <= 0 || (low !== null && (!Number.isSafeInteger(low) || low <= 0))) {
        throw new Error('Invalid price point for ' + key);
      }
      points.push(point);
    }
    const latest = points.at(-1);
    const analysis = market.analyze(points, day, metadata.cards[key.split(':')[0]]?.rarity);
    const sealed = market.sealedQuote(points);
    const recent = [];
    for (let date = day; date >= day - 3; date--) {
      const quote = points.findLast(point => point[0] <= date);
      recent.push([quote?.[0] === date ? quote[1] : null, market.marketWindow(points, date)]);
    }
    rows[key] = { latest, analysis, sealed, recent };
  }
}
if (!Object.keys(rows).length) throw new Error('Market summary is empty');
const output = process.argv[2] || path.join(__dirname, 'market-summary.json');
fs.writeFileSync(output, JSON.stringify({ version: market.summaryVersion, strategy: market.strategy, day, sourceUpdatedAt, rows }) + '\n');
console.log('Published market summary for ' + Object.keys(rows).length + ' price series');

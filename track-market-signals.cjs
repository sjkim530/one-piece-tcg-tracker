/* Freeze daily candidates and their comparison groups before outcomes exist. */
const fs = require('node:fs');
const path = require('node:path');
const { analyze, strategy, saleProceeds, defaultShipping } = require('./market-analysis');

const archive = path.join(__dirname, 'price-history');
const ledgerDir = path.join(__dirname, 'signal-ledger');
const reportPath = process.argv[2] || path.join(__dirname, 'signal-performance.json');
const { sourceUpdatedAt } = JSON.parse(fs.readFileSync(path.join(archive, 'status.json')));
const today = Math.floor(Date.parse(sourceUpdatedAt) / 86400000);
if (!Number.isSafeInteger(today)) throw new Error('Invalid price snapshot date');
fs.mkdirSync(ledgerDir, { recursive: true });
const series = new Map();
for (let bucket = 0; bucket < 256; bucket++) {
  for (const [key, quotes] of Object.entries(JSON.parse(fs.readFileSync(path.join(archive, bucket + '.json'))))) {
    series.set(key, quotes);
  }
}

function quoteOn(key, day) {
  const quotes = series.get(key) || [];
  for (let i = 0; i < quotes.length && quotes[i] >= day; i += 3) {
    if (quotes[i] === day) return quotes[i + 1];
  }
  return null;
}

const ledgerPath = path.join(ledgerDir, today + '.json');
const metadata = path.join(archive, 'singles.json');
const rarityMetadata = JSON.parse(fs.readFileSync(path.join(__dirname, 'card-metadata.json')));
if (rarityMetadata.version !== 1 || !Number.isFinite(Date.parse(sourceUpdatedAt)) || Date.parse(rarityMetadata.sourceUpdatedAt) !== Date.parse(sourceUpdatedAt) || !rarityMetadata.cards) {
  throw new Error('Current card rarity metadata is required to track new market signals');
}
if (!fs.existsSync(ledgerPath) && fs.existsSync(metadata)) {
  const catalog = JSON.parse(fs.readFileSync(metadata));
  if (Date.parse(catalog.sourceUpdatedAt) === Date.parse(sourceUpdatedAt)) {
    const groups = new Map();
    const calls = [];
    for (const [key, quotes] of series) {
      const type = catalog.products[key.split(':')[0]];
      const [day, price, low] = quotes;
      if (!type || day !== today) continue;
      const group = JSON.stringify([type, Math.floor(Math.log2(price))]);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push([key, price]);
      const points = [];
      for (let i = quotes.length - 3; i >= 0; i -= 3) points.push(quotes.slice(i, i + 3));
      const { call } = analyze(points, today, rarityMetadata.cards[key.split(':')[0]]?.rarity);
      if (call === 'Buy Now' || call === 'Sell Now') calls.push({ key, call, price, low, group });
    }
    const used = new Set(calls.map(row => row.group));
    const peers = Object.fromEntries([...groups].filter(([group]) => used.has(group)));
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, strategy, day: today, calls, peers }) + '\n', { flag: 'wx' });
  }
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = numbers.slice().sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

const allDays = fs.readdirSync(ledgerDir).filter(name => /^\d+\.json$/.test(name)).sort()
  .map(name => JSON.parse(fs.readFileSync(path.join(ledgerDir, name))))
  .filter(snapshot => snapshot.version === 1);
const days = allDays.filter(snapshot => snapshot.strategy === strategy);
const legacyDays = allDays.length - days.length;
const results = [];
for (const horizon of [30, 90]) {
  for (const call of ['Buy Now', 'Sell Now']) {
    let total = 0, pending = 0, missing = 0, hits = 0;
    const moves = [], net = [], baselines = [];
    const matchedMoves = [], printings = new Set(), signalDays = new Set();
    const directional = (price, later) => call === 'Buy Now' ? later > price : later < price;
    for (const snapshot of days) {
      const target = snapshot.day + horizon;
      const sameCall = snapshot.calls.filter(event => event.call === call);
      const flagged = new Set(snapshot.calls.map(event => event.key));
      const peerRates = new Map();
      for (const event of sameCall) {
        total++;
        if (target > today) { pending++; continue; }
        const later = quoteOn(event.key, target);
        if (later == null) { missing++; continue; }
        moves.push(later / event.price - 1);
        const hit = Number(directional(event.price, later));
        hits += hit;
        printings.add(event.key);
        signalDays.add(snapshot.day);
        if (call === 'Buy Now') net.push(saleProceeds(later, defaultShipping) / event.low - 1);
        else {
          const nowNet = saleProceeds(event.price, defaultShipping);
          if (nowNet > 0) net.push(saleProceeds(later, defaultShipping) / nowNet - 1);
        }
        if (!peerRates.has(event.group)) {
          let count = 0, peerHits = 0;
          for (const [peer, start] of snapshot.peers[event.group] || []) {
            if (flagged.has(peer)) continue;
            const end = quoteOn(peer, target);
            if (end == null) continue;
            count++;
            peerHits += Number(directional(start, end));
          }
          peerRates.set(event.group, count >= 5 ? peerHits / count : null);
        }
        const rate = peerRates.get(event.group);
        if (rate != null) {
          baselines.push(rate);
          matchedMoves.push(hit);
        }
      }
    }
    results.push({ horizon, call, total, pending, missing, hits, measured: moves.length, matched: baselines.length,
      matchedHits: matchedMoves.reduce((sum, value) => sum + value, 0),
      baseline: baselines.length ? baselines.reduce((sum, value) => sum + value, 0) / baselines.length : null,
      medianMove: median(moves), medianNet: median(net), netCount: net.length,
      printings: printings.size, signalDays: signalDays.size });
  }
}

fs.writeFileSync(reportPath, JSON.stringify({
  version: 2, strategy, sourceUpdatedAt, start: days[0]?.day ?? null, trackedDays: days.length, legacyDays, results
}) + '\n');

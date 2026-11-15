// Run from any directory with node backtest-market.cjs.
const fs = require('node:fs');
const path = require('node:path');
const { analyze, saleProceeds, defaultShipping } = require('./market-analysis.js');

const horizons = [30, 90];
const results = Object.fromEntries(horizons.map(horizon => [horizon, {
  'Buy Now': [], 'Sell Now': [], Hold: []
}]));
const excluded = { noForwardQuote: {30: 0, 90: 0}, noCardMatch: 0 };

// Match known singles using the catalog parser. Exclude sealed products and
// alternate subtypes whose identity cannot be confirmed in the fixture.
async function run() {
  const vm = require('node:vm');
  const context = vm.createContext({
    location: new URL('http://localhost/'),
    localStorage: { getItem: () => null },
    fetch: async url => new Response(fs.readFileSync(path.join(__dirname, url)))
  });
  context.window = context;
  for (const file of ['data.js', 'source.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, {filename: file});
  }
  const sets = await context.SRC.buildSets(vm.runInContext('OQ_DATA.SETS', context));
  const { cards, failed } = await context.SRC.loadAll(sets);
  if (failed.length) throw new Error('The backtest requires the complete local catalog fixture.');
  const known = new Set(cards.flatMap(card => [
    card.id + ':' + card.printing,
    ...(card.alt_printing ? [card.id + ':' + card.alt_printing.printing] : [])
  ]));
  for (const file of fs.readdirSync(path.join(__dirname, 'price-history')).filter(name => /^\d+\.json$/.test(name))) {
    const bucket = JSON.parse(fs.readFileSync(path.join(__dirname, 'price-history', file), 'utf8'));
    for (const [key, flat] of Object.entries(bucket)) {
      if (!known.has(key)) {
        excluded.noCardMatch++;
        continue;
      }
      const points = [];
      for (let i = 0; i < flat.length; i += 3) points.push(flat.slice(i, i + 3));
      points.sort((a, b) => a[0] - b[0]);
      const byDay = new Map(points.map(point => [point[0], point[1]]));
      for (let i = 180; i < points.length; i++) {
        const [day, market, low] = points[i];
        if (day % 7 !== 4) continue; // Mondays
        const { call, evidence } = analyze(points.slice(0, i + 1), day);
        if (evidence !== 'full') continue;
        for (const horizon of horizons) {
          const later = byDay.get(day + horizon);
          if (!later) {
            excluded.noForwardQuote[horizon]++;
            continue;
          }
          results[horizon][call].push({
            change: later / market - 1,
            tradeReturn: call === 'Buy Now' ? saleProceeds(later, defaultShipping) / low - 1 : null
          });
        }
      }
    }
  }
  const median = values => {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const percent = value => (value * 100).toFixed(1) + '%';
  const report = [];
  for (const horizon of horizons) {
    for (const [call, sample] of Object.entries(results[horizon])) {
      const changes = sample.map(row => row.change);
      report.push({
        days: horizon, call, samples: sample.length,
        medianMarketMove: changes.length ? percent(median(changes)) : '—',
        directionHit: changes.length && call !== 'Hold' ? percent(changes.filter(
          change => call === 'Buy Now' ? change > 0 : change < 0
        ).length / changes.length) : '—',
        medianBuyNetReturn: changes.length && call === 'Buy Now'
          ? percent(median(sample.map(row => row.tradeReturn))) : '—'
      });
    }
  }
  console.table(report);
  console.log('Excluded', excluded);
}

run().catch(error => { console.error(error); process.exitCode = 1; });

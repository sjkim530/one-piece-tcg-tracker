/* Card market signals and single-item sale estimates. All prices are cents. */
const OQ_MARKET = (() => {
  'use strict';

  const defaultShipping = 500;
  const summaryVersion = 3;
  const strategy = 'rarity-trades-v1';
  const tradeRarities = new Set(['R', 'SR', 'SEC', 'SP', 'TR', 'L', 'PR', 'DON']);

  function eligibility(market, effectiveRarity) {
    const rarity = typeof effectiveRarity === 'string' ? effectiveRarity.trim().toUpperCase() : '';
    const positive = Number.isFinite(market) && market > 0;
    const sellEligible = positive && tradeRarities.has(rarity) && (rarity !== 'R' || market >= 100);
    const buyEligible = sellEligible;
    const buyReason = !positive ? 'Buy candidates require a positive Market Price.'
      : rarity === 'C' || rarity === 'UC' ? 'Common and Uncommon cards are excluded from buy candidates, including alternate art.'
      : !tradeRarities.has(rarity) ? 'Buy candidates need a known printed rarity.'
      : rarity === 'R' && market < 100 ? 'Rare cards need Market Price of at least $1 for a buy candidate.'
      : rarity === 'R' ? 'Rare meets the $1 buy-candidate minimum.'
      : 'This printed rarity qualifies for a buy candidate at any positive Market Price.';
    const sellReason = !positive ? 'Sale reviews require a positive Market Price.'
      : rarity === 'C' || rarity === 'UC' ? 'Common and Uncommon cards are excluded from sale reviews, including alternate art.'
      : !tradeRarities.has(rarity) ? 'Sale reviews need a known printed rarity.'
      : rarity === 'R' && market < 100 ? 'Rare cards need Market Price of at least $1 for a sale review.'
      : rarity === 'R' ? 'Rare meets the $1 sale-review minimum.'
      : 'This printed rarity qualifies for a sale review at any positive Market Price.';
    return { rarity, buyEligible, sellEligible, buyReason, sellReason };
  }

  function percentile(values, fraction) {
    const sorted = values.slice().sort((a, b) => a - b);
    const index = (sorted.length - 1) * fraction;
    const lower = Math.floor(index);
    return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
  }

  function ebaySoldSearch(card, printing) {
    const number = /^\d+$/.test(card.card_set_id) ? '' : card.card_set_id;
    const query = [card.card_name.replace(/[()]/g, ' '), number || card.set_name,
      card.alt_printing && printing !== 'Normal' ? printing : '', 'One Piece TCG English']
      .filter(Boolean).join(' ').replace(/\s+/g, ' ');
    const params = new URLSearchParams({ _nkw: query, LH_Sold: '1', LH_Complete: '1' });
    return 'https://www.ebay.com/sch/i.html?' + params;
  }

  function ebayItemId(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !/^(www\.)?ebay\.com$/.test(url.hostname)) return null;
      return url.pathname.match(/^\/itm\/(?:[^/]+\/)?(\d{9,15})\/?$/)?.[1] || null;
    } catch (_) { return null; }
  }

  function summarizeComps(sales, today) {
    const day = Date.parse(today) / 86400000;
    const recent = sales.filter(sale => {
      const age = day - Date.parse(sale.sold) / 86400000;
      return age >= 0 && age < 90;
    });
    const totals = recent.map(sale => sale.price + sale.shipping);
    const latest = recent.reduce((date, sale) => sale.sold > date ? sale.sold : date, '');
    return { count: totals.length, median: totals.length ? percentile(totals, .5) : null,
      latest, age: latest ? (Date.parse(today) - Date.parse(latest)) / 86400000 : null };
  }

  function saleProceeds(price, shipping) {
    // US Marketplace Level 1–4, one item, seller-paid shipping, before buyer tax.
    const commission = Math.min(7500, Math.round(price * .1075));
    const processing = Math.round(price * .025) + 30;
    return price - commission - processing - shipping;
  }

  function watchTargets(targets, quote, today) {
    const [day, market, low] = quote || [];
    const net = targets.sell != null && market > 0 ? saleProceeds(market, targets.shipping) : null;
    const fresh = day >= today - 3 && day <= today;
    return {
      net, fresh,
      buyHit: fresh && targets.buy != null && low > 0 && low <= targets.buy,
      sellHit: fresh && targets.sell != null && net != null && net >= targets.sell
    };
  }

  function analyze(points, today, effectiveRarity) {
    const last = points.at(-1);
    const insufficient = reason => ({ call: 'Insufficient data', reason });
    if (!last || last[0] > today || today - last[0] > 3) {
      return insufficient('Wait for a Market Price from the last four UTC dates.');
    }
    const [day, market, low] = last;
    if (!(Number.isFinite(market) && market > 0)) return insufficient('Wait for a positive Market Price.');
    const policy = eligibility(market, effectiveRarity);

    const history = [];
    const quarter = [];
    const recent = [];
    const prior = [];
    const twoWeeksAgo = [];
    let last21 = 1;
    let last40 = 1;
    for (let i = points.length - 2; i >= 0; i--) {
      const [pastDay, price] = points[i];
      const age = day - pastDay;
      if (age > 365) break;
      history.push(price);
      if (age <= 90) quarter.push(price);
      if (age <= 6) recent.push(price);
      if (age >= 27 && age <= 33) prior.push(price);
      if (age >= 11 && age <= 17) twoWeeksAgo.push(price);
      if (age <= 21) last21++;
      if (age <= 40) last40++;
    }
    recent.push(market);
    const enoughFor30 = recent.length >= 4 && prior.length >= 4;
    const full = history.length >= 180 && quarter.length >= 60 && enoughFor30;
    if (!full || !(low > 0)) {
      const horizon = enoughFor30 && (last40 >= 18 || full) ? 30 :
        last21 >= 10 && recent.length >= 4 && twoWeeksAgo.length >= 4 ? 14 : null;
      if (!horizon) {
        return insufficient('Too few recent prices for a trend. A short-term verdict needs at least 10 quotes and enough observations near both ends of a two-week comparison.');
      }
      const first = percentile(horizon === 30 ? prior : twoWeeksAgo, .5);
      const momentum = percentile(recent, .5) / first - 1;
      let reason = 'Recent prices are steady. Keep the card or wait for a better entry while the price history builds.';
      if (!(low > 0)) reason = 'A recent market trend is visible, but there is no current lowest listing. Check available copies and their condition before trading.';
      else if (momentum >= .05) reason = 'Recent prices are rising. If you already own it, keep it for now. If you’re buying, wait for a pullback or more price history.';
      else if (momentum <= -.05) reason = 'Recent prices are falling. Wait for prices to stabilize before buying. Review recent sold listings if you’re considering an exit.';
      return { ...policy, call: 'Hold', reason, day, market, low, momentum, horizon, evidence: 'limited' };
    }

    const recentMedian = percentile(recent, .5);
    const priorMedian = percentile(prior, .5);
    const momentum = (recentMedian - priorMedian) / priorMedian;
    const year = [percentile(history, .1), percentile(history, .9)];
    const recentRange = [percentile(quarter, .1), percentile(quarter, .9)];
    const buyPrice = Math.floor(Math.min(percentile(history, .35), percentile(quarter, .35)));
    const sellPrice = Math.ceil(Math.max(percentile(history, .65), percentile(quarter, .65)));
    const buy = {
      price: buyPrice, minListing: Math.ceil(market / 2), maxListing: Math.floor(market * 95 / 100),
      priceMet: market <= buyPrice, trendMet: momentum >= .05
    };
    const sell = {
      price: sellPrice, minListing: Math.ceil(market * 90 / 100), maxListing: Math.floor(market * 125 / 100),
      priceMet: market >= sellPrice, trendMet: momentum <= -.05
    };
    for (const rule of [buy, sell]) {
      rule.listingMet = low >= rule.minListing && low <= rule.maxListing;
    }
    const distinct = buyPrice < sellPrice;
    const buyEligible = policy.buyEligible && distinct;
    const sellEligible = policy.sellEligible && distinct;
    buy.eligible = buyEligible; sell.eligible = sellEligible;
    const eligible = buyEligible || sellEligible;
    let call = 'Hold';
    let reason = 'Keep the card or wait for a better entry. The price and trend do not support making a trade today.';
    if (!distinct) {
      reason = 'Prices have stayed too close together to justify a trade. Wait for a meaningful move.';
    } else if (!eligible) {
      reason = policy.buyReason + ' ' + policy.sellReason;
    } else if (buyEligible && buy.priceMet && buy.trendMet && buy.listingMet) {
      call = 'Buy Now';
      reason = 'Market Price is low in both historical ranges, momentum has turned up, and the lowest listing is 5% to 50% below market.';
    } else if (sellEligible && sell.priceMet && sell.trendMet && sell.listingMet) {
      call = 'Sell Now';
      reason = 'Market Price is high in both historical ranges, momentum has turned down, and the lowest listing is close enough to market to support the price comparison.';
    } else if (buyEligible && buy.priceMet && buy.trendMet) {
      reason = 'Watch for a buy. The price and rebound qualify, but the lowest listing is outside the range. Check the exact printing and condition.';
    } else if (sellEligible && sell.priceMet && sell.trendMet) {
      reason = 'Review your exit price. The trend supports a sale review, but current listings don’t corroborate Market Price. Check recent sales first.';
    } else if (buyEligible && buy.priceMet) {
      reason = 'Wait for an entry. The card is cheap relative to its history. Look for a sustained rebound and a qualifying listing before buying.';
    } else if (sellEligible && sell.priceMet) {
      reason = 'Hold at the upper end of the range. If you’re considering selling, watch for a downturn and check current listings.';
    } else if (momentum >= .05) {
      reason = 'Keep it for now. Recent prices are rising, so let the price come down before buying.';
    } else if (momentum <= -.05) {
      reason = 'Wait for prices to stabilize before buying. If you own it, compare recent sold listings before lowering your asking price.';
    }
    return { call, reason, day, market, low, momentum, horizon: 30, evidence: 'full', year, recentRange,
      ...policy, buyEligible, sellEligible, eligible,
      buyReason: distinct ? policy.buyReason : 'Buy candidates need distinct buy and sell thresholds.',
      sellReason: distinct ? policy.sellReason : 'Sale reviews need distinct buy and sell thresholds.', buy, sell };
  }

  function marketWindow(points, day) {
    const recent = [];
    const prior = [];
    for (let i = points.length - 1; i >= 0; i--) {
      const [date, price] = points[i];
      const age = day - date;
      if (age > 33) break;
      if (age >= 0 && age <= 6) recent.push(price);
      if (age >= 27) prior.push(price);
    }
    if (recent.length < 4 || prior.length < 4) return null;
    const priorMedian = percentile(prior, .5);
    return (percentile(recent, .5) - priorMedian) / priorMedian;
  }

  function sealedQuote(points) {
    const last = points.at(-1);
    const day = last?.[0];
    const market = last?.[1];
    const listing = last?.[2];
    const history = points.filter(point => point[0] < day && point[0] >= day - 90).map(point => point[1]);
    const median = history.length >= 60 ? percentile(history, .5) : null;
    const momentum = marketWindow(points, day);
    return { day, market, listing, median, momentum };
  }

  function analyzeSealedQuote(quote, today, singlesMoves, singlesCount) {
    const { day, market, listing, median, momentum } = quote;
    const singles = singlesMoves.length >= Math.max(10, Math.ceil(singlesCount * .6))
      ? percentile(singlesMoves, .5) : null;
    const result = { day, market, listing, median, momentum, singles, matched: singlesMoves.length, singlesCount };
    const insufficient = reason => ({ ...result, call: 'Insufficient data', reason });
    if (day == null || day > today || today - day > 3) {
      return insufficient('A box quote from the last four UTC dates is required.');
    }
    if (!(listing > 0)) return insufficient('The latest box quote has no lowest listing.');
    if (median == null || momentum == null) {
      return insufficient('The box needs 60 prices in the prior 90 days and four prices near each end of the 30-day trend.');
    }
    if (singles == null) return insufficient('At least 10 singles and 60% of the pullable catalog need comparable prices.');

    const buyPrice = Math.floor(Math.min(market * .95, median * .90));
    const passPrice = Math.ceil(median * (singles <= -.10 ? 1 : 1.10));
    const eligible = momentum >= -.10 && singles >= -.05;
    let call = 'Watch';
    let reason = 'The listing sits between the buy and pass prices.';
    if (listing <= buyPrice && !eligible) {
      const weak = [];
      if (momentum < -.10) weak.push('the box trend reaches −10% or higher');
      if (singles < -.05) weak.push('the singles trend reaches −5% or higher');
      reason = 'The listing meets the buy price. Wait until ' + weak.join(' and ') + '.';
    }
    if (eligible && listing <= buyPrice) {
      call = 'Buy';
      reason = 'The listing is at least 5% below market and 10% below its 90-day median. Box and singles trends meet the buy rule.';
    } else if (listing >= passPrice) {
      call = 'Pass';
      reason = singles <= -.10
        ? 'The listing is at or above its 90-day median while singles are down at least 10%.'
        : 'The listing is at least 10% above its 90-day median.';
    }
    return { ...result, call, reason, buyPrice, passPrice };
  }

  function analyzeSealed(points, today, singlesMoves, singlesCount) {
    return analyzeSealedQuote(sealedQuote(points), today, singlesMoves, singlesCount);
  }

  return { analyze, eligibility, strategy, analyzeSealed, analyzeSealedQuote, sealedQuote, marketWindow, saleProceeds, defaultShipping, summaryVersion,
    ebaySoldSearch, ebayItemId, summarizeComps, watchTargets };
})();

if (typeof module === 'object' && module.exports) module.exports = OQ_MARKET;

/* Card market signals and single-item sale estimates. All prices are cents. */
const OQ_MARKET = (() => {
  'use strict';

  const defaultShipping = 500;
  const buyMinimum = 1000;

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

  function analyze(points, today) {
    const last = points.at(-1);
    const insufficient = reason => ({ call: 'Insufficient data', reason });
    if (!last || last[0] > today || today - last[0] > 3) {
      return insufficient('Wait for a Market Price from the last four UTC dates.');
    }
    const [day, market, low] = last;
    if (!(low > 0)) return insufficient('The latest snapshot has no lowest listing for this printing.');

    const history = [];
    const quarter = [];
    const recent = [];
    const prior = [];
    for (let i = points.length - 2; i >= 0; i--) {
      const [pastDay, price] = points[i];
      const age = day - pastDay;
      if (age > 365) break;
      history.push(price);
      if (age <= 90) quarter.push(price);
      if (age <= 6) recent.push(price);
      if (age >= 27 && age <= 33) prior.push(price);
    }
    recent.push(market);
    if (history.length < 180 || quarter.length < 60 || recent.length < 4 || prior.length < 4) {
      return insufficient('Requires 180 observations in the past year, 60 in the past 90 days, and four near each end of the 30-day comparison.');
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
    const eligible = market >= buyMinimum && buyPrice < sellPrice;
    let call = 'Hold';
    let reason = 'The trend, historical price bands, and listing price do not align for a buy or sell.';
    if (market < buyMinimum) {
      reason = 'The market price is below $10. Small price moves can be outweighed by fees and shipping.';
    } else if (!eligible) {
      reason = 'Wait for price history to separate the buy and sell thresholds.';
    } else if (buy.priceMet && buy.trendMet && buy.listingMet) {
      call = 'Buy Now';
      reason = 'Market Price is low in both historical ranges, momentum has turned up, and the lowest listing is 5% to 50% below market.';
    } else if (sell.priceMet && sell.trendMet && sell.listingMet) {
      call = 'Sell Now';
      reason = 'Market Price is high in both historical ranges, momentum has turned down, and the lowest listing is close enough to market to support the price comparison.';
    }
    return { call, reason, day, market, low, momentum, year, recentRange, eligible, buy, sell };
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

  return { analyze, analyzeSealed, analyzeSealedQuote, sealedQuote, marketWindow, saleProceeds, defaultShipping,
    ebaySoldSearch, ebayItemId, summarizeComps, watchTargets };
})();

if (typeof module === 'object' && module.exports) module.exports = OQ_MARKET;

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

  function saleProceeds(price, shipping) {
    // US Marketplace Level 1–4, one item, seller-paid shipping, before buyer tax.
    const commission = Math.min(7500, Math.round(price * .1075));
    const processing = Math.round(price * .025) + 30;
    return price - commission - processing - shipping;
  }

  function analyze(points, today) {
    const last = points.at(-1);
    const insufficient = reason => ({ call: 'Insufficient data', reason });
    if (!last || today - last[0] > 3) return insufficient('A Market Price from the last four UTC dates is required.');
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

    const momentum = percentile(recent, .5) / percentile(prior, .5) - 1;
    const year = [percentile(history, .1), percentile(history, .9)];
    const recentRange = [percentile(quarter, .1), percentile(quarter, .9)];
    const buyPrice = Math.floor(Math.min(percentile(history, .35), percentile(quarter, .35)));
    const sellPrice = Math.ceil(Math.max(percentile(history, .65), percentile(quarter, .65)));
    const buyListing = Math.floor(market * .95);
    const sellListing = Math.ceil(market * .90);
    let call = 'Hold';
    let reason = 'The trend, historical price bands, and listing price do not align for a buy or sell.';
    if (market < buyMinimum) {
      reason = 'The market price is below $10. Small price moves can be outweighed by fees and shipping.';
    } else if (momentum >= .05 && market <= buyPrice && low <= buyListing && low >= market * .5 && buyPrice < sellPrice) {
      call = 'Buy Now';
      reason = 'Market Price is low in both historical ranges, momentum has turned up, and the lowest listing is 5% to 50% below market.';
    } else if (momentum <= -.05 && market >= sellPrice && low >= sellListing && low <= market * 1.25 && buyPrice < sellPrice) {
      call = 'Sell Now';
      reason = 'Market Price is high in both historical ranges, momentum has turned down, and the lowest listing is close enough to market to support the price comparison.';
    }
    return { call, reason, day, market, low, momentum, year, recentRange, buyPrice, sellPrice, buyListing, sellListing };
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
    return recent.length >= 4 && prior.length >= 4
      ? percentile(recent, .5) / percentile(prior, .5) - 1 : null;
  }

  function analyzeSealed(points, today, singlesMoves, singlesCount) {
    const last = points.at(-1);
    const day = last?.[0];
    const market = last?.[1];
    const listing = last?.[2];
    const history = points.filter(point => point[0] < day && point[0] >= day - 90).map(point => point[1]);
    const median = history.length >= 60 ? percentile(history, .5) : null;
    const momentum = marketWindow(points, day);
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
    let reason = !eligible && listing <= buyPrice
      ? 'The listing meets the buy price, but the box or singles trend is below the buy threshold.'
      : 'The listing sits between the buy and pass prices.';
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

  return { analyze, analyzeSealed, marketWindow, saleProceeds, defaultShipping };
})();

if (typeof module === 'object' && module.exports) module.exports = OQ_MARKET;

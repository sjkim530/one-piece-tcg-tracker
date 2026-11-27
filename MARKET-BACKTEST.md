# Card market backtest

**Earlier rule:** The published figures below used a $10 minimum for both Buy
and Sell. The current `rarity-sell-v1` rule keeps Buy at $10, excludes Common
and Uncommon from Sell, requires Rare to be at least $1, and allows other known
printed rarities at any positive Market Price. Alternate-art stars do not
change the printed C/UC/R restrictions. These figures have not been rerun or
relabeled as evidence for that newer rule. Current-rule forward tracking is
reported separately and excludes the older daily flags.

The historical table uses the original rule names. In the app these flags are
called Buy candidate, Review for sale, and Hold. The table evaluates the
full-history rules. The app also offers a limited-evidence Hold when shorter
history supports a recent trend, or when a listing is missing. Those cases
are outside this backtest. Forward results in Market Scanner are collected
separately by the daily price job.

The card analysis uses TCGplayer price snapshots from November 13, 2025 through
November 12, 2026. The backtest evaluates every eligible Monday for printings
matched to the local singles catalog. Each decision uses only quotes available
on or before that Monday. Outcomes use the exact 30- or 90-day forward quote
when available. The first six months supply the minimum history required to
make a call, and the longer horizon leaves fewer dates with a known outcome.

| Signal | Horizon | Observations | Median market move | Direction hit | Median estimated buy and resale return |
|---|---:|---:|---:|---:|---:|
| Buy Now | 30 days | 18 | +0.4% | 55.6% | −37.5% |
| Sell Now | 30 days | 62 | 0.0% | 50.0% | |
| Hold | 30 days | 123,237 | 0.0% | | |
| Buy Now | 90 days | 14 | +9.1% | 57.1% | −26.1% |
| Sell Now | 90 days | 39 | −21.0% | 71.8% | |
| Hold | 90 days | 70,066 | +0.7% | | |

The directional measure counts Buy calls followed by a rise and Sell calls
followed by a decline. The resale estimate assumes a purchase at the reported
lowest listing, a later sale at Market Price, standard US Marketplace Level
1–4 fees, and $5 seller-paid shipping. Buyer tax and acquisition shipping are
excluded. Quotes do not establish that either trade could have filled.

The rules were revised using this same archive after the first run flagged
low-priced cards whose moves were outweighed by fees and shipping. These are
in-sample observations, repeated cards and overlapping windows can influence the
results, and the directional samples are small. The Sell signal showed a
stronger 90-day result. Buy flags are leads for collection purchases, with
negative median resale estimates at both horizons.

Run `node backtest-market.cjs` with the local `mockapi/` catalog fixture and
generated `price-history/` directory to evaluate the **current** rule. Its
console output identifies the strategy and uses the fixture's current printed
rarities; it does not reproduce the earlier-rule figures above or establish
what rarity metadata was known historically.

# Card market backtest

The historical table uses the original rule names. In the app these flags are
called Buy candidate, Review for sale, and No clear signal. Forward results in
Market Scanner are collected separately by the daily price job.

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
generated `price-history/` directory to reproduce the figures.

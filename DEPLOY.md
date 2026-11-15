# Deploying OPTCG Quant v2

## Price history

The **Daily prices and Pages** workflow uses a standard runner on a public
GitHub repository. It runs at 21:37 UTC and publishes the app and shared
history through GitHub Pages. It also publishes after pushes to the default
branch. The workflow skips private repositories.

To enable it, put the project at the root of your public GitHub repository,
including `.github/workflows/daily-prices.yml` and `price-history/`. Keep
`mockapi/`, `.price-cache/`, and any private collection data out of the
repository. In **Settings → Pages**, select **GitHub Actions** as the source.
Then open **Actions → Daily prices and Pages → Run workflow** and confirm that
both jobs succeed. The app shows the saved feed's timestamp above the tabs'
content. GitHub can delay scheduled runs and disables schedules after 60 days
without repository activity.

The job checks TCGCSV's build timestamp before fetching the One Piece groups.
A repeated build is skipped. If the job misses days, the historical importer
can fill them when archives are available. For a manual local update, run
`python sync_prices.py` from this folder. The script uses Python's standard
library.

Publish `price-history.js` and the generated `price-history/` directory with the
site. Each chart loads one small file for the selected TCGplayer product.
The hosted app defaults to the existing Grand Line Vault Worker. Settings can
override the URL per browser. Local HTTP development defaults to the sample
catalog. On app opens and refreshes, the
browser saves the dated quotes in IndexedDB. These snapshots belong to that
browser and cover days when it successfully loads the feed.
Market Scanner also stores Buy and Sell calls from complete live-feed scans in
that browser. Subsequent scans check recorded 30- and 90-day prices when available.

To backfill or extend shared history, run the importer with Python and
`py7zr` installed. Supply the complete date range you want to publish.

```sh
python -m pip install py7zr
python backfill_prices.py --start 2025-11-13 --end 2026-11-12
```

The importer reuses downloads in `.price-cache/`. Resume with the same command
after a rate-limit cooldown. Use `--cached-only` to publish the dates already
downloaded. Keep the raw cache local. Deploy only the compact One Piece output.

v2 changed where data comes from. Card data and prices now come from
TCGplayer's catalogue via [tcgcsv.com](https://tcgcsv.com/), which **refuses
browser requests** — it returns 401 the moment a request carries an `Origin`
header, and their docs say plainly it is meant for back-end use. So there are
now two things to deploy: the site, and a small Cloudflare Worker that fetches
on the site's behalf.

The Worker proxies public data and has no key. Custom Worker URLs are saved
in browser storage. The app stores collection backups in a file you choose.

## 1. The Worker

You can configure the Worker in Cloudflare's **web editor**.

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) (free plan is
   enough — see "Why the Worker is dumb" below).
2. **Workers & Pages → Create → Start with Hello World → Deploy**, then **Edit
   code**.
3. Delete what is there, paste all of `worker/worker.js`, **Deploy**.
4. Copy the URL it gives you, like
   `https://optcg-quant-data.<you>.workers.dev`.
5. In the app: **Settings → Data source**, paste it, **Save and reload data**.
   It refuses to save a URL that does not respond, so a typo cannot leave you
   with an app that boots empty.

If you ever do install Node, `cd worker && wrangler deploy` uses the included
`wrangler.toml` instead.

### Locking it down (optional)

`ALLOWED_ORIGINS` in `worker.js` defaults to `['*']`. There is no key to steal
and no write path, so the only real exposure is somebody else spending your
100,000 requests/day. To close it, replace `'*'` with your Pages origin, e.g.
`['https://yourname.github.io']`.

### Why the Worker is dumb on purpose

It proxies exactly one upstream file per request and streams the body through
without parsing it. That is not laziness — the free plan allows **50
subrequests and 10 ms of CPU** per request, and assembling the whole catalogue
in one call needs 84 fetches and far more CPU than that. As a thin proxy it
uses 1 subrequest and almost no CPU, so it fits the free plan with room to
spare. The client does the assembly, where CPU is free.

It caches each file until just after TCGCSV's next daily build (~20:00 UTC), so
opening the app fifty times in a day still costs upstream one fetch per file.
That is also what their usage guidelines ask for.

## 2. The site

Commit everything in this folder **except** `mockapi/`, plus `icons/`.

### Required app and Worker files

| File | Why |
|---|---|
| `index.html` | The page. Must sit at the root of whatever Pages publishes. |
| `styles.css` | All styling. |
| `data.js` | Sets, group ids, pull-rate profiles, colours, variant tags. |
| `engine.js` | Classification, EV, odds, signals. Pure functions. |
| `collection.js` | Collection model, value maths, key migration. |
| `source.js` | Fetches and parses TCGCSV through the Worker. **New in v2.** |
| `price-history.js` | Loads price charts and saves dated snapshots. |
| `market-analysis.js` | Evaluates card price signals and estimates sale proceeds. |
| `MARKET-BACKTEST.md` | Summarizes the card signal backtest and assumptions. |
| `price-history/` | Generated historical prices for singles and sealed products. |
| `app.js` | State, rendering, local persistence. |
| `backup.js` | Versioned JSON backup, automatic file updates, and restore validation. |
| `worker/worker.js` | Not served, but you paste it into Cloudflare. Keep it versioned next to the code it feeds. |

### PWA (4 files + icons)

`manifest.json`, `sw.js`, and `icons/` — `icon-192.png`, `icon-512.png`,
`icon-maskable-512.png`, `apple-touch-icon.png`.

Install on the S25 Ultra: open the Pages URL in Chrome, menu → **Add to Home
screen**.

### Tests — optional, worth keeping

`tests.html` (79 engine + collection), `tests-source.html` (69 parser, mapping
and key migration), `worker/tests-worker.html` (29 routing). Nothing links to
them. Keeping them deployed means you can run the suite from any machine before
trusting a change.

## Do NOT commit

- **`mockapi/`** — a 3 MB development snapshot of TCGCSV. It exists so the app
  can be built and tested without the Worker. If you publish it, the app will
  silently read stale frozen prices instead of telling you the Worker is
  missing. Add it to `.gitignore`.
- Personal backup files and any private URLs.
- `_backups/` lives outside this folder and should stay out of the repo.

## First run after deploying

1. Open the Pages URL. Settings → Data source lets you override the default Worker.
2. On Android Chrome, open Settings → Collection backup → Enable automatic backup
   and select a file. The app updates that file while it has write permission.
3. Use Restore from file to load a backup. After moving devices, choose the
   restored file again to resume automatic updates. Keep an off-device copy
   if you want to recover after losing the phone.

### Your collection migrates itself

v1 keyed collection rows on a `set_id|card_image_id|card_name` composite,
because optcgapi had nothing unique. v2 keys on TCGplayer's `productId`, which
genuinely is unique. On the first v2 load, saved rows are repointed
automatically by matching card name plus card number.

Rows that match exactly one card are migrated in browser storage. **Anything that does not match exactly
one card is left completely alone and reported in a banner on My Collection** —
nothing is deleted, and nothing is guessed, because a wrong match looks fine
while pointing at the wrong card. Fix those by re-adding them by hand.

The original key is kept on each row as `oldKey`, so the migration can be
audited or reversed.

## Every time you deploy

Push to the default branch. **Daily prices and Pages** publishes that version.

The service worker is network-first: online it always fetches the current file
and only falls back to cache when the network fails.

### The one caching subtlety, if you ever edit `sw.js`

A plain `fetch()` inside a service worker still consults the browser's HTTP
cache, which silently turns network-first into cache-first. `fromNetwork()`
uses `cache: 'reload'` to force a real network request. Remove that and deploys
stop arriving — it looks like it works, because the app loads fine. It is just
old.

/* ============================================================================
   OPTCG QUANT — service worker

   STRATEGY: network-first for the app's own files, cache as offline fallback.

   The obvious PWA approach is cache-first, which is faster but means a deployed
   fix does not reach the device until the cache is invalidated — exactly the
   stale-JavaScript problem, made permanent. For a single-user tool that trade
   is wrong: correctness beats shaving 100ms off a load that is already instant
   on a local cache.

   So: online, you always run the latest code and never think about version
   strings. Offline, you get the last copy that worked. The network attempt is
   capped so a flaky signal falls back rather than hanging.
   ========================================================================== */

const CACHE = 'optcg-quant-v8';
const NET_TIMEOUT_MS = 3000;

/* The shell. Card data is not here — the app caches that itself in
   localStorage, which survives independently of this cache. */
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './data.js',
  './engine.js',
  './collection.js',
  './source.js',
  './price-history.js',
  './market-analysis.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // Individually, so one 404 cannot fail the whole install.
      .then(c => Promise.all(SHELL.map(url =>
        c.add(url).catch(err => console.warn('[sw] skipped', url, err))
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      // Take control of open tabs immediately rather than waiting for a close.
      .then(() => self.clients.claim())
  );
});

/**
 * `cache: 'reload'` is the whole point.
 *
 * A plain fetch() inside a service worker STILL consults the browser's own HTTP
 * cache, so a file already stored under the same URL is returned without any
 * network request — network-first silently degrades to cache-first and a deploy
 * never reaches the device. Verified: an edit to data.js was invisible until
 * this was added. 'reload' bypasses the HTTP cache on the way out and refreshes
 * it with the response on the way back.
 */
function fromNetwork(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), NET_TIMEOUT_MS);
    fetch(new Request(request.url, {
      cache: 'reload',
      credentials: 'same-origin',
      redirect: 'follow'
    })).then(res => { clearTimeout(timer); resolve(res); },
             err => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Card data and images come from optcgapi.com. Left to the network and the
  // app's own localStorage cache — intercepting a 2.3MB payload here would
  // duplicate storage for no gain.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fromNetwork(req)
      .then(res => {
        // Only cache real successes; a 404 page must not become the app.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        // ignoreSearch so the pre-cached "app.js" answers a request for
        // "app.js?v=1.20.0". Without it the shell cached at install would be
        // unreachable, because the page never asks for the bare filename — and
        // keeping the ?v= list in sync here would reintroduce exactly the
        // version chore this design removes.
        caches.match(req, { ignoreSearch: true })
          .then(hit => hit || caches.match('./index.html', { ignoreSearch: true }))
          .then(hit => hit ||
            new Response('Offline, and this page was never cached.',
                         { status: 503, headers: { 'Content-Type': 'text/plain' } }))
      )
  );
});

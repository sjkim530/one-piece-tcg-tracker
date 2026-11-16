/* Cache the exact app shell for offline use. Data uses HTTP revalidation. */
const CACHE_PREFIX = 'optcg-quant-';
const CACHE = CACHE_PREFIX + 'v26';
const scope = new URL(self.registration.scope);
const indexUrl = new URL('index.html', scope).href;
const unavailable = () => new Response('This resource is unavailable offline.', {
  status: 503, headers: { 'Content-Type': 'text/plain' }
});

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch(indexUrl, { cache: 'reload' });
    if (!response.ok) throw new Error('Could not cache the app shell');
    const html = await response.clone().text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)\?v=[^"]+)"/g)]
      .map(match => new Request(new URL(match[1], scope), { cache: 'reload' }));
    const cache = await caches.open(CACHE);
    await cache.addAll([...assets, new URL('icons/vault-192.png', scope)]);
    await cache.put(indexUrl, response);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function serve(request, appNavigation, versionedAsset) {
  const cache = await caches.open(CACHE);
  const key = appNavigation ? indexUrl : request;
  if (versionedAsset) {
    const cached = await cache.match(key);
    if (cached) return cached;
  }
  try {
    const response = await fetch(request, appNavigation
      ? { cache: 'no-cache', signal: AbortSignal.timeout(3000) } : {});
    if (response.ok && response.type === 'basic') {
      try { await cache.put(key, response.clone()); } catch (_) { /* The network response still works. */ }
    }
    if (response.status >= 500) return await cache.match(key) || response;
    return response;
  } catch (_) {
    return await cache.match(key) || unavailable();
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== scope.origin ||
      !url.pathname.startsWith(scope.pathname) || request.headers.has('range')) return;
  const appNavigation = request.mode === 'navigate' &&
    (url.pathname === scope.pathname || url.pathname === new URL(indexUrl).pathname);
  const versionedAsset = /\.(?:js|css)$/.test(url.pathname) && url.searchParams.has('v');
  event.respondWith(serve(request, appNavigation, versionedAsset));
});

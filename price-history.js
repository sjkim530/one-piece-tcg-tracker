/* Daily TCGplayer Market Price, keyed by product ID and printing subtype. */
const OQ_HISTORY = (() => {
  'use strict';

  const DAY = 86400000;
  const BUCKETS = 256;
  const dateFormat = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  });
  const moneyFormat = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
  const ranges = ['30D', '90D', '6M', '1Y', 'All'];
  const bucketCache = new Map();
  const observers = new WeakMap();
  let database;

  async function sharedStatus() {
    const response = await fetch('./price-history/status.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Shared history status is unavailable');
    const { sourceUpdatedAt } = await response.json();
    const stamp = Date.parse(sourceUpdatedAt);
    if (!Number.isFinite(stamp)) throw new Error('Invalid shared history timestamp');
    return stamp;
  }

  function openDatabase() {
    if (database) return database;
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('optcg-price-history', 2);
      request.onupgradeneeded = event => {
        const db = request.result;
        if (event.oldVersion < 1) db.createObjectStore('daily', { keyPath: ['bucket', 'day'] });
        db.createObjectStore('market-calls', { keyPath: ['id', 'day'] });
      };
      request.onblocked = () => reject(new Error('Another tab is blocking the history database'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          database = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    }).catch(error => {
      database = null;
      throw error;
    });
    return database;
  }

  const keyFor = (id, printing) => id + ':' + printing;

  function feedDay(timestamp) {
    if (!timestamp) return null;
    const ms = Date.parse(timestamp);
    return Number.isFinite(ms) ? Math.floor(ms / DAY) : null;
  }

  async function record(feed, cards, products) {
    const day = feedDay(feed?.updated);
    if (day === null || feed.mock) return;
    const db = await openDatabase();
    const saved = await new Promise((resolve, reject) => {
      const request = db.transaction('daily').objectStore('daily').get([-1, day]);
      request.onsuccess = () => resolve(Boolean(request.result));
      request.onerror = () => reject(request.error);
    });
    if (saved) return;
    const buckets = Array.from({ length: BUCKETS }, () => ({}));
    function add(id, printing, market, low) {
      const product = Number(id);
      if (!Number.isSafeInteger(product) || product <= 0 || !Number.isFinite(market) || market <= 0) return;
      const marketCents = Math.round(market * 100);
      if (!marketCents) return;
      buckets[product % BUCKETS][keyFor(product, printing || '')] = [
        marketCents, low > 0 ? Math.round(low * 100) || null : null
      ];
    }
    for (const card of cards) {
      if (card.printing != null) add(card.id, card.printing, card.market_price, card.inventory_price);
      const alt = card.alt_printing;
      if (alt?.printing != null) add(card.id, alt.printing, alt.market, alt.low);
    }
    for (const product of products) {
      if (product.printing != null) add(product.id, product.printing, product.market_price, product.low_price);
    }

    await new Promise((resolve, reject) => {
      const tx = db.transaction('daily', 'readwrite');
      const store = tx.objectStore('daily');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
      buckets.forEach((quotes, bucket) => {
        if (Object.keys(quotes).length) store.put({ bucket, day, quotes });
      });
      store.put({ bucket: -1, day });
    });
  }

  function archiveBucket(bucket) {
    if (bucketCache.has(bucket)) return bucketCache.get(bucket);
    const pending = fetch('./price-history/' + bucket + '.json').then(response => {
      if (!response.ok) throw new Error('Archive returned HTTP ' + response.status);
      return response.json();
    }).then(bucketPrices => {
      if (!bucketPrices || typeof bucketPrices !== 'object' || Array.isArray(bucketPrices)) {
        throw new Error('Unexpected archive response');
      }
      return bucketPrices;
    });
    bucketCache.set(bucket, pending);
    if (bucketCache.size > 12) bucketCache.delete(bucketCache.keys().next().value);
    pending.catch(() => { if (bucketCache.get(bucket) === pending) bucketCache.delete(bucket); });
    return pending;
  }

  async function localBucket(bucket, keys) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const store = db.transaction('daily').objectStore('daily');
      const request = store.openCursor(IDBKeyRange.bound([bucket, 0], [bucket, Number.MAX_SAFE_INTEGER]));
      const series = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(series);
        for (const key of keys) {
          const quote = cursor.value.quotes[key];
          if (quote) series.push([key, cursor.value.day, ...quote]);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function load(id, printings) {
    const product = Number(id);
    const bucket = product % BUCKETS;
    const keys = printings.map(printing => keyFor(product, printing));
    const result = await loadBucket(bucket, keys);
    return {
      series: printings.map((printing, index) => ({ printing, points: result.series.get(keys[index]) })),
      archiveUnavailable: result.archiveUnavailable,
      storageUnavailable: result.storageUnavailable
    };
  }

  async function loadBucket(bucket, keys) {
    const [archive, local] = await Promise.allSettled([archiveBucket(bucket), localBucket(bucket, keys)]);
    const byKey = new Map(keys.map(key => [key, new Map()]));
    for (const [key, days] of byKey) {
      const flat = archive.value?.[key] || [];
      for (let i = 0; i < flat.length; i += 3) days.set(flat[i], [flat[i], flat[i + 1], flat[i + 2]]);
    }
    for (const [key, day, market, low] of local.value || []) {
      const days = byKey.get(key);
      if (!days.has(day)) days.set(day, [day, market, low]);
    }
    return {
      series: new Map([...byKey].map(([key, days]) =>
        [key, [...days.values()].sort((a, b) => a[0] - b[0])])),
      archiveUnavailable: archive.status === 'rejected',
      storageUnavailable: local.status === 'rejected'
    };
  }

  async function scan(printings, analyze, progress) {
    const buckets = new Map();
    for (const printing of printings) {
      const bucket = Number(printing.card.id) % BUCKETS;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(printing);
    }
    const queue = [...buckets];
    const rows = [];
    let completed = 0;
    let unavailable = 0;
    let storageUnavailable = false;
    async function readNext() {
      for (let entry = queue.pop(); entry; entry = queue.pop()) {
        const [bucket, group] = entry;
        const keys = group.map(row => keyFor(row.card.id, row.printing));
        const result = await loadBucket(bucket, keys);
        if (result.archiveUnavailable) unavailable++;
        storageUnavailable ||= result.storageUnavailable;
        group.forEach((row, index) => rows.push(analyze(row, result.series.get(keys[index]))));
        progress(++completed, buckets.size);
      }
    }
    await Promise.all(Array.from({ length: 8 }, readNext));
    return { rows, unavailable, storageUnavailable };
  }

  async function trackedCalls() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction('market-calls').objectStore('market-calls').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveTrackedCalls(rows) {
    if (!rows.length) return;
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('market-calls', 'readwrite');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
      const store = tx.objectStore('market-calls');
      for (const row of rows) {
        const request = store.get([row.id, row.day]);
        request.onsuccess = () => {
          const previous = request.result;
          if (!previous) store.put(row);
          else store.put({ ...previous, outcomes: { ...row.outcomes, ...previous.outcomes } });
        };
      }
    });
  }

  function selectRange(points, range, now = Date.now()) {
    if (range === 'All') return points;
    const end = Math.floor(now / DAY);
    let start = end - 29;
    if (range === '90D') start = end - 89;
    if (range === '6M' || range === '1Y') {
      const date = new Date(end * DAY);
      const day = date.getUTCDate();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() - (range === '6M' ? 6 : 12));
      const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(day, monthEnd));
      start = Math.floor(date.getTime() / DAY);
    }
    return points.filter(([day]) => day >= start && day <= end);
  }

  const dateLabel = day => dateFormat.format(day * DAY);
  const dollars = cents => moneyFormat.format(cents / 100);

  function draw(canvas, points, selectedDay) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    const prices = points.map(point => point[1]);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const pad = Math.max((max - min) * .08, max * .015, 1);
    const bottom = Math.max(0, min - pad);
    const top = max + pad;
    const firstDay = points[0][0];
    const lastDay = points.at(-1)[0];
    ctx.font = '11px system-ui';
    const left = Math.ceil(ctx.measureText(dollars(top)).width) + 8;
    const right = width - 8;
    const x = day => firstDay === lastDay ? (left + right) / 2 :
      left + (day - firstDay) / (lastDay - firstDay) * (right - left);
    const y = price => 8 + (top - price) / (top - bottom) * (height - 20);
    const colors = getComputedStyle(canvas);
    const ink = colors.getPropertyValue('--ink-2').trim();
    ctx.fillStyle = ink;
    ctx.strokeStyle = colors.getPropertyValue('--line').trim();
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 4; i++) {
      const value = bottom + (top - bottom) * i / 3;
      const at = y(value);
      ctx.fillText(dollars(Math.round(value)), 0, at);
      ctx.beginPath();
      ctx.moveTo(left, at);
      ctx.lineTo(right, at);
      ctx.stroke();
    }
    ctx.strokeStyle = ctx.fillStyle = colors.getPropertyValue('--brass').trim();
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const [day, price] = points[i];
      if (i && day === points[i - 1][0] + 1) ctx.lineTo(x(day), y(price));
      else ctx.moveTo(x(day), y(price));
    }
    ctx.stroke();
    for (let i = 0; i < points.length; i++) {
      const [day, price] = points[i];
      if (points[i - 1]?.[0] === day - 1 || points[i + 1]?.[0] === day + 1) continue;
      ctx.beginPath();
      ctx.arc(x(day), y(price), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    const selected = points.find(([day]) => day === selectedDay);
    if (selected) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x(selectedDay), 8);
      ctx.lineTo(x(selectedDay), height - 12);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x(selectedDay), y(selected[1]), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    return { left, right };
  }

  function chart(container, productId, printings, onPrintingChange, initialPrinting) {
    return renderChart(container, load(productId, printings), {
      title: 'TCGplayer price history', label: 'Market price', onPrintingChange, initialPrinting
    });
  }

  function holdingsChart(container, pending) {
    return renderChart(container, pending.then(result => ({
      ...result, series: [{ points: result.points }]
    })), { title: 'Current holdings over time', label: 'Estimated value' });
  }

  function renderChart(container, pending, options) {
    observers.get(container)?.disconnect();
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="history-toolbar">
        <h3>${options.title}</h3>
        <label>Range <select>${ranges.map(range => '<option>' + range + '</option>').join('')}</select></label>
      </div>
      <p class="small muted" role="status">Loading prices…</p>
      <canvas class="history-chart" tabindex="0" role="img" aria-label="${options.title}" hidden></canvas>
      <div class="history-dates small muted" aria-hidden="true" hidden><span></span><span></span></div>
      <div class="history-point small" role="status" hidden></div>
      <div class="history-stats small" hidden></div>`;
    container.replaceChildren(root);
    const range = root.querySelector('select');
    const status = root.querySelector('p');
    const canvas = root.querySelector('canvas');
    const dates = root.querySelector('.history-dates');
    const stats = root.querySelector('.history-stats');
    const pointLabel = root.querySelector('.history-point');
    range.value = '6M';
    range.disabled = true;
    return pending.then(result => {
      if (root.parentElement !== container) return;
      const printing = document.createElement('select');
      printing.setAttribute('aria-label', 'Printing');
      result.series.forEach(({ printing: label }, index) => printing.add(new Option(label || 'Default', index)));
      const initialIndex = result.series.findIndex(series => series.printing === options.initialPrinting);
      if (initialIndex >= 0) printing.value = String(initialIndex);
      if (result.series.length > 1) root.querySelector('.history-toolbar').append(printing);
      range.disabled = false;
      let points = [];
      let geometry;
      let selectedIndex = -1;
      let pinnedIndex = -1;
      const prompt = 'Tap, click, or use arrow keys to inspect a day.';
      const redraw = () => { geometry = draw(canvas, points, points[selectedIndex]?.[0]); };
      function select(index) {
        if (selectedIndex === index) return;
        selectedIndex = index;
        const quote = points[index];
        pointLabel.textContent = quote
          ? dateLabel(quote[0]) + ' · ' + options.label + ' ' + dollars(quote[1]) +
            (quote[2] == null ? '' : ' · Lowest listing ' + dollars(quote[2]))
          : prompt;
        redraw();
      }
      function render() {
        selectedIndex = pinnedIndex = -1;
        points = selectRange(result.series[Number(printing.value)].points, range.value);
        canvas.hidden = dates.hidden = stats.hidden = pointLabel.hidden = !points.length;
        pointLabel.textContent = prompt;
        const notes = [];
        if (result.archiveUnavailable) notes.push('Some archived prices could not load.');
        if (result.storageUnavailable) notes.push('Browser snapshots are unavailable.');
        if (!points.length) {
          status.textContent = [result.emptyMessage || 'No recorded prices for this range.', ...notes].join(' ');
          return;
        }
        const [first, last] = [points[0], points.at(-1)];
        const missing = last[0] - first[0] + 1 - points.length;
        const span = dateLabel(first[0]) + ' to ' + dateLabel(last[0]);
        status.textContent = [
          points.length + (points.length === 1 ? ' daily price' : ' daily prices') + ' · ' + span,
          missing ? missing + ' missing days within coverage.' : '', ...notes
        ].filter(Boolean).join(' ');
        dates.firstElementChild.textContent = dateLabel(first[0]);
        dates.lastElementChild.textContent = first === last ? '' : dateLabel(last[0]);
        const prices = points.map(point => point[1]);
        const change = first[1] > 0 ? Math.round((last[1] / first[1] - 1) * 1000) / 10 : null;
        stats.textContent = [
          'Latest ' + dollars(last[1]),
          'Low ' + dollars(Math.min(...prices)),
          'High ' + dollars(Math.max(...prices)),
          first === last || change == null ? '' : 'Change ' + (change > 0 ? '+' : '') + change.toFixed(1) + '%'
        ].filter(Boolean).join(' · ');
        canvas.setAttribute('aria-label', options.label + ' from ' + span + '. ' + stats.textContent);
        redraw();
      }
      function nearestDay(clientX) {
        const { left, right } = geometry;
        const x = clientX - canvas.getBoundingClientRect().left;
        const first = points[0][0];
        const last = points.at(-1)[0];
        const day = first + (last - first) * (x - left) / Math.max(1, right - left);
        return points.reduce((best, point, index) =>
          Math.abs(point[0] - day) < Math.abs(points[best][0] - day) ? index : best, 0);
      }
      canvas.addEventListener('pointermove', event => {
        if (event.pointerType === 'mouse' && geometry && points.length) select(nearestDay(event.clientX));
      });
      canvas.addEventListener('click', event => {
        if (geometry && points.length) select(pinnedIndex = nearestDay(event.clientX));
      });
      canvas.addEventListener('pointerleave', () => select(pinnedIndex));
      canvas.addEventListener('keydown', event => {
        const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
        if (!direction || !points.length) return;
        event.preventDefault();
        pinnedIndex = selectedIndex === -1 ? points.length - 1 :
          Math.max(0, Math.min(points.length - 1, selectedIndex + direction));
        select(pinnedIndex);
      });
      range.addEventListener('change', render);
      function selectPrinting() {
        render();
        options.onPrintingChange?.(result.series[Number(printing.value)]);
      }
      printing.addEventListener('change', selectPrinting);
      const observer = new ResizeObserver(() => {
        if (points.length && !canvas.hidden) redraw();
      });
      observer.observe(canvas);
      observers.set(container, observer);
      selectPrinting();
    });
  }

  return { record, load, scan, selectRange, chart, holdingsChart, dateLabel, trackedCalls, saveTrackedCalls, sharedStatus };
})();

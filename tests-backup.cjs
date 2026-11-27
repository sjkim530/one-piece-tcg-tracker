/* Automatic backup state and serialization regressions. Run node tests-backup.cjs. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');

function harness(options = {}) {
  let now = 0, sequence = 0, closed = 0, aborted = 0, writes = 0, lockCalls = 0, openCalls = 0, request;
  const timers = new Map(), reports = [];
  const data = { cols: [], items: [], opens: [], watch: [], comps: [] };
  const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
  const contents = JSON.stringify({ format: 'grand-line-vault', version: 1, savedAt: '2026-11-27T00:00:00.000Z', data }) + '\n';
  const handle = { name: 'backup.json',
    queryPermission: () => options.pendingPermission ? new Promise(() => {}) : Promise.resolve('granted'),
    getFile: async () => ({ size: contents.length, text: async () => contents }),
    createWritable: async () => ({
      write: async () => { writes++; if (options.pendingWrite) await new Promise(() => {}); if (options.failedWrite) throw Error('Disk full'); },
      close: async () => {}, abort: async () => { aborted++; }
    })
  };
  let stored = options.noHandle ? undefined : { handle, identity: 'device', fileHash: hash(contents),
    dataHash: options.needsWrite ? 'different' : hash(JSON.stringify(data)), last: null };
  const db = { close() { closed++; }, transaction() {
    const tx = { abort() { aborted++; queueMicrotask(() => tx.onabort?.()); }, objectStore() { return {
      get() { const result = { result: stored }; if (!options.pendingTransaction) queueMicrotask(() => tx.oncomplete?.()); return result; },
      put(next) { stored = next; const result = { result: next }; queueMicrotask(() => tx.oncomplete?.()); return result; }
    }; } }; return tx;
  } };
  const indexedDB = { open() {
    openCalls++; request = { result: db };
    queueMicrotask(() => {
      if (options.blocked) request.onblocked?.();
      else if (options.failedOpen) { request.error = Error('Storage disabled'); request.onerror?.(); }
      else if (!options.pendingOpen) request.onsuccess?.();
    }); return request;
  } };
  const navigator = {};
  if (options.locks !== false) navigator.locks = { request: (name, { signal }, work) => {
    lockCalls++;
    if (!options.pendingLock) return Promise.resolve().then(work);
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Waiting cancelled', 'AbortError')), { once: true }));
  } };
  const window = { indexedDB, crypto: { subtle: { digest: async (_, bytes) => {
    const result = crypto.createHash('sha256').update(bytes).digest();
    return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
  } } } };
  if (!options.unsupported) window.showSaveFilePicker = async () => handle;
  const context = vm.createContext({ window, indexedDB, navigator, crypto: window.crypto, TextEncoder, AbortController,
    console, setTimeout(fn, ms) { timers.set(++sequence, { fn, at: now + ms }); return sequence; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'backup.js'), 'utf8'), context);
  const backup = vm.runInContext('OQ_BACKUP', context).create({ read: () => data, identity: () => 'device', status: state => reports.push(state) });
  async function flush() { for (let i = 0; i < 70; i++) await Promise.resolve(); }
  async function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    await flush();
  }
  return { backup, reports, flush, advance, get request() { return request; }, stats: () => ({ closed, aborted, writes, lockCalls, openCalls }) };
}

test('Android without file picker immediately reports manual fallback without storage access', async () => {
  const h = harness({ unsupported: true });
  await h.backup.refresh();
  assert.equal(h.reports.at(-1).state, 'unsupported');
  assert.match(h.reports.at(-1).message, /Download backup/);
  assert.equal(h.stats().openCalls, 0);
});

test('supported browser reports off with no handle and ready only after a verified linked file', async () => {
  for (const [noHandle, expected] of [[true, 'off'], [false, 'ready']]) {
    const h = harness({ noHandle }); const refresh = h.backup.refresh();
    assert.equal(h.reports[0].state, 'checking');
    await refresh;
    assert.equal(h.reports.at(-1).state, expected); assert.equal(h.stats().writes, 0);
  }
});

test('blocked or rejected IndexedDB reports error and never claims backup is on', async () => {
  for (const option of ['blocked', 'failedOpen']) {
    const h = harness({ [option]: true }); await h.backup.refresh();
    assert.equal(h.reports.at(-1).state, 'error');
    assert.ok(!h.reports.some(report => report.state === 'ready'));
    if (option === 'blocked') { h.request.onsuccess(); assert.equal(h.stats().closed, 1); }
  }
});

test('unresponsive IndexedDB open times out and closes a late connection', async () => {
  const h = harness({ pendingOpen: true }); const refresh = h.backup.refresh(); await h.flush();
  await h.advance(6000); await refresh;
  assert.equal(h.reports.at(-1).state, 'error');
  h.request.onsuccess(); assert.equal(h.stats().closed, 1);
});

test('unresponsive transaction is aborted instead of leaving a pending check', async () => {
  const h = harness({ pendingTransaction: true }); const refresh = h.backup.refresh(); await h.flush();
  await h.advance(6000); await refresh;
  assert.equal(h.stats().aborted, 1); assert.equal(h.reports.at(-1).state, 'error');
});

test('waiting Web Lock is abortable and repeated refreshes share one pending check', async () => {
  const h = harness({ pendingLock: true }); const first = h.backup.refresh(), second = h.backup.refresh();
  assert.equal(first, second); await h.flush();
  await h.advance(6000); await first;
  assert.equal(h.stats().lockCalls, 1); assert.equal(h.reports.at(-1).state, 'error');
  assert.match(h.reports.at(-1).message, /Another tab/);
});

test('unresponsive read-only permission probe times out without writing', async () => {
  const h = harness({ pendingPermission: true }); const refresh = h.backup.refresh(); await h.flush();
  await h.advance(6000); await refresh;
  assert.equal(h.reports.at(-1).state, 'error'); assert.equal(h.stats().writes, 0);
});

test('slow active write reports fallback but keeps serialization and never claims saved', async () => {
  const h = harness({ pendingWrite: true, needsWrite: true }); h.backup.refresh(); await h.flush();
  assert.equal(h.stats().writes, 1);
  await h.advance(7000);
  assert.equal(h.reports.at(-1).state, 'error');
  h.backup.change(); await h.advance(300);
  assert.equal(h.stats().writes, 1); assert.equal(h.stats().lockCalls, 1);
  assert.ok(!h.reports.some(report => report.state === 'ready'));
});

test('failed write aborts writer and shows error instead of backup on', async () => {
  const h = harness({ failedWrite: true, needsWrite: true }); await h.backup.refresh();
  assert.equal(h.stats().aborted, 1); assert.equal(h.reports.at(-1).state, 'error');
  assert.ok(!h.reports.some(report => report.state === 'ready'));
});

test('refresh queued behind an older stalled change cannot remain checking forever', async () => {
  const h = harness({ pendingWrite: true, needsWrite: true });
  h.backup.change(); await h.advance(300);
  assert.equal(h.stats().writes, 1);
  await h.advance(7000); assert.equal(h.reports.at(-1).state, 'error');
  h.backup.refresh(); assert.equal(h.reports.at(-1).state, 'checking');
  await h.advance(7000);
  assert.equal(h.reports.at(-1).state, 'error');
  assert.equal(h.stats().lockCalls, 1); assert.equal(h.stats().writes, 1);
});

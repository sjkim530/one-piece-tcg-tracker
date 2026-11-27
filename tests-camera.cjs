/* Camera capture lifecycle regressions, without camera hardware. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const cards = [{ id: 'regular', card_name: 'Kuro', card_set_id: 'OP15-025' },
  { id: 'alternate', card_name: 'Kuro (Alternate Art)', card_set_id: 'OP15-025', star: true }];

function harness({ ready = true, noMatch = false, deferMatch = false, detectionFails = false, matchFails = false, noTextMatch = false, deferText = false } = {}) {
  let now = 0, sequence = 0, stops = 0, analyses = 0, matches = 0, ocr = 0, permission, pendingMatch, pendingText;
  const timers = new Map(), nodes = new Map(), frames = [];
  function element() {
    const handlers = {};
    return { hidden: false, disabled: false, checked: true, value: '', textContent: '', innerHTML: '',
      style: {}, dataset: {}, readyState: 2, currentTime: 0, videoWidth: 1080, videoHeight: 1920,
      classList: { toggle() {} }, addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
      async emit(type, event = {}) { for (const fn of handlers[type] || []) await fn(event); },
      getContext: () => ({ drawImage() {} }), focus() {}, replaceChildren() {},
      showModal() { this.open = true; }, close() { this.open = false; }, play: () => Promise.resolve() };
  }
  const $ = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const document = element(); document.hidden = false;
  const window = element(), track = element(); track.stop = () => stops++;
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const code = app.slice(app.indexOf('  function wireCardScan()'), app.indexOf('  function wireCatalog()'));
  const result = () => ({ visual: true, numbers: ['OP15025'], readNumbers: [],
    candidates: noMatch ? [] : [{ id: 'alternate', score: 20 }], confident: true });
  const context = vm.createContext({ $, document, window, console, AbortController,
    navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { permission = resolve; }) } },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 }, performance: { now: () => now },
    setTimeout(fn) { timers.set(++sequence, fn); return sequence; }, clearTimeout(id) { timers.delete(id); },
    on: (selector, type, fn) => $(selector).addEventListener(type, fn),
    OQ_SCAN: { normalize: value => value.toUpperCase().replace(/[^A-Z0-9]/g, ''),
      picture: () => { const frame = { width: 1080, height: 1920 }; frames.push(frame); return frame; },
      createRecognizer: signal => ({ close() {}, async recognize() {
        ocr++;
        const evidence = noTextMatch ? { numbers: [], readNumbers: [], candidates: [] }
          : { numbers: ['OP15025'], readNumbers: [], candidates: [{ id: 'regular' }] };
        if (!deferText) return evidence;
        return new Promise((resolve, reject) => {
          pendingText = () => resolve(evidence);
          signal.addEventListener('abort', () => reject(Error('Text cancelled')), { once: true });
        });
      } }) },
    OQ_VISION: { preload: async () => ({}),
      analyze: async () => { analyses++; if (detectionFails) throw Error('Unavailable');
        return { ready, quality: .8, message: 'Show the whole card' }; },
      match: async (frame, { signal }) => { matches++; if (matchFails) throw Error('Unavailable');
        if (deferMatch) return new Promise((resolve, reject) => {
          pendingMatch = () => resolve(result());
          signal.addEventListener('abort', () => reject(Error('Aborted')), { once: true });
        });
        return result(); }
    }, S: { cards }, E: { cardKey: card => card.id, rarityBadge: card => ({ label: 'Rare', star: !!card.star }) },
    C: { cardTitle: value => value }, esc: value => value, cardArt: () => '' });
  vm.runInContext(code + '\nwireCardScan();', context);
  async function flush() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
  async function tick(ms = 480, advancing = true) {
    now += ms; if (advancing) $('#scan-video').currentTime += ms / 1000;
    const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); await flush();
  }
  async function open() {
    await $('#scan-open').emit('click'); const request = $('#scan-camera').emit('click'); permission(stream); await request; await flush();
  }
  return { $, document, window, open, tick, flush, frames, resolvePermission: () => permission(stream),
    finishMatch: async () => { pendingMatch(); await flush(); },
    finishText: async () => { pendingText(); await flush(); },
    counts: () => ({ stops, analyses, matches, ocr }) };
}

test('quality triggers a captured photo before recognition, without any OCR prerequisite', async () => {
  const h = harness({ deferMatch: true }); await h.open(); await h.tick();
  assert.equal(h.counts().matches, 1); assert.equal(h.counts().ocr, 0);
  assert.equal(h.$('#scan-shot').hidden, false);
  assert.match(h.$('#scan-quality').textContent, /Photo captured/);
  await h.finishMatch();
  assert.equal(h.$('#scan-controls').hidden, true);
  assert.match(h.$('#scan-results').innerHTML, /data-key="alternate"/);
  assert.doesNotMatch(h.$('#scan-results').innerHTML, /data-key="regular"/);
});
test('normal hand movement needs no perfectly still interval', async () => {
  const h = harness(); await h.open(); await h.tick(500);
  assert.equal(h.counts().matches, 1);
});
test('unusable frames never trigger a blind timed capture or turn auto off', async () => {
  const h = harness({ ready: false }); await h.open();
  for (let i = 0; i < 8; i++) await h.tick(5000);
  assert.equal(h.counts().matches, 0); assert.equal(h.$('#scan-auto').checked, true);
});
test('a failed visual match resumes searching beyond twenty seconds with auto still enabled', async () => {
  const h = harness({ noMatch: true, noTextMatch: true }); await h.open(); await h.tick();
  const first = h.counts().matches;
  assert.equal(h.$('#scan-auto').checked, true); assert.equal(h.counts().ocr, 1);
  await h.tick(21000); await h.tick();
  assert.ok(h.counts().matches > first); assert.equal(h.$('#scan-auto').checked, true);
  assert.equal(h.counts().stops, 0);
});
test('only one captured image is matched at once', async () => {
  const h = harness({ deferMatch: true }); await h.open(); await h.tick(); await h.tick(); await h.tick();
  assert.equal(h.counts().matches, 1); await h.finishMatch();
});
test('cancel during matching aborts it and cannot publish late results', async () => {
  const h = harness({ deferMatch: true }); await h.open(); await h.tick();
  await h.$('#scan-cancel-camera').emit('click'); await h.finishMatch();
  assert.equal(h.$('#scan-results').innerHTML, ''); assert.equal(h.counts().stops, 1);
});
test('turning auto off during matching cancels only that operation and retains manual camera', async () => {
  const h = harness({ deferMatch: true }); await h.open(); await h.tick();
  h.$('#scan-auto').checked = false; await h.$('#scan-auto').emit('change'); await h.finishMatch(); await h.tick();
  assert.equal(h.counts().stops, 0); assert.equal(h.$('#scan-shot').hidden, true);
  assert.equal(h.$('#scan-capture').disabled, false);
});
test('manual capture works with auto off and can use OCR when visual matching is unavailable', async () => {
  const h = harness({ matchFails: true }); h.$('#scan-auto').checked = false; await h.open();
  await h.$('#scan-capture').emit('click'); await h.flush();
  assert.equal(h.counts().ocr, 1); assert.match(h.$('#scan-status').textContent, /possible/);
});
test('detector failure leaves auto preference on and manual capture available', async () => {
  const h = harness({ detectionFails: true }); await h.open(); await h.tick();
  assert.equal(h.$('#scan-auto').checked, true); assert.equal(h.$('#scan-capture').disabled, false);
  assert.match(h.$('#scan-quality').textContent, /Retrying automatically/);
});
test('backgrounding during recognition stops camera and discards late matches', async () => {
  const h = harness({ deferMatch: true }); await h.open(); await h.tick();
  h.document.hidden = true; await h.document.emit('visibilitychange'); await h.finishMatch();
  assert.equal(h.counts().stops, 1); assert.equal(h.$('#scan-results').innerHTML, '');
});
test('late camera permission after cancellation releases tracks', async () => {
  const h = harness(); await h.$('#scan-open').emit('click'); const pending = h.$('#scan-camera').emit('click');
  await h.$('#scan-close').emit('click'); h.resolvePermission(); await pending;
  assert.equal(h.counts().stops, 1);
});
test('frozen video cannot produce repeated quality observations', async () => {
  const h = harness(); await h.open(); await h.tick(3000, false);
  assert.equal(h.counts().matches, 0); assert.match(h.$('#scan-quality').textContent, /paused/);
});

test('a captured card can use bounded OCR when foil prevents an artwork match', async () => {
  const h = harness({ noMatch: true }); await h.open(); await h.tick();
  assert.equal(h.counts().matches, 1); assert.equal(h.counts().ocr, 1);
  assert.match(h.$('#scan-status').textContent, /possible/);
  assert.equal(h.$('#scan-auto').checked, true);
});

test('closing during text fallback aborts its child job and discards late results', async () => {
  const h = harness({ noMatch: true, deferText: true }); await h.open(); await h.tick();
  assert.equal(h.counts().ocr, 1);
  await h.$('#scan-close').emit('click'); await h.finishText();
  assert.equal(h.$('#scan-results').innerHTML, ''); assert.equal(h.counts().stops, 1);
});
test('text fallback deadline resumes the camera without disabling automatic capture', async () => {
  const h = harness({ noMatch: true, deferText: true }); await h.open(); await h.tick();
  await h.tick(9000); await h.tick(160);
  assert.equal(h.$('#scan-auto').checked, true); assert.equal(h.counts().stops, 0);
  assert.equal(h.$('#scan-capture').disabled, false); assert.equal(h.$('#scan-shot').hidden, true);
});

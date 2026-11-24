/* Scanner quality/stability regressions: node tests-scan.cjs (no dependencies). */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(__dirname, 'card-scan.js'), 'utf8') + '\nglobalThis.scan = OQ_SCAN;', ctx);
const { analyzeFrame } = ctx.scan;

function image(paint) {
  const width = 180, height = 252, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, value = paint(x, y);
    data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
  }
  return { data, width, height };
}
const within = (x, y) => x >= 10 && x < 170 && y >= 14 && y < 238;
const detail = (x, y) => 130 + 26 * Math.sin(x * 1.8) * Math.cos(y * 1.6);
const card = image((x, y) => within(x, y) ? detail(x, y) : 28);
const quality = () => analyzeFrame(card);

const catalog = [
  { id: '1', card_name: 'Kuro', card_set_id: 'OP15-025', power: '6000', rulesText: 'Rest an opponent character. East Blue pirates.', set_name: 'Adventure' },
  { id: '2', star: true, card_name: 'Kuro (025) (Alternate Art)', card_set_id: 'OP15-025', power: '6000', rulesText: 'Rest an opponent character. East Blue pirates.', set_name: 'Adventure' },
  { id: '3', card_name: 'Jango', card_set_id: 'OP15-026', power: '2000', set_name: 'Adventure' }
];
const evidence = text => ctx.scan.resolveEvidence(text, { cards: catalog });
test('full-frame quality allows off-center cards and ordinary backgrounds; identity comes from OCR', () => {
  assert.equal(analyzeFrame(image(() => 125)).state, 'ready');
  assert.equal(analyzeFrame(image(detail)).state, 'ready');
  assert.equal(analyzeFrame(image(() => 8)).state, 'dark');
  assert.equal(analyzeFrame(image(() => 255)).state, 'bright');
});
test('actual photo rarity artifacts recover only known catalog codes', () => {
  for (const text of ['OP15 02588', 'oP150258n']) {
    const result = evidence(text);
    assert.deepEqual(Array.from(result.numbers), ['OP15025']);
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(Array.from(result.recoveredNumbers), ['OP15025']);
  }
  for (const text of ['OP15025000', 'OP15025888', 'OP1502788']) assert.equal(evidence(text).numbers.length, 0);
});
test('card number is stronger than a conflicting name and retains all printings', () => {
  const result = evidence('OP15-025\nJango');
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every(card => card.name === 'KURO'));
});
test('read but unknown card numbers remain explicit', () => {
  const result = evidence('OP99-999');
  assert.equal(result.numbers.length, 0);
  assert.deepEqual(Array.from(result.readNumbers), ['OP99999']);
});
test('short name needs exact OCR line; context can strengthen it', () => {
  assert.equal(evidence('Rest your Kuro characters').name, null);
  assert.equal(evidence('Kuro').name, 'KURO');
  assert.equal(evidence('Kuro').strongName, false);
  assert.equal(evidence('6000\nCHARACTER\nKuro').strongName, true);
  assert.equal(evidence('Kuroobi').name, null);
});
test('conflicting exact names do not produce one auto-confirmable name', () => {
  const result = evidence('Kuro\nJango');
  assert.equal(result.name, null); assert.equal(result.candidates.length, 3);
});
test('exact card nameplate outranks generic DON card mentions in rules text', () => {
  const cards = [
    { id: 'moby1', card_name: 'Moby Dick', card_set_id: 'OP16-021' },
    { id: 'moby2', card_name: 'Moby Dick (Alternate Art)', card_set_id: 'OP16-021' },
    ...Array.from({ length: 6 }, (_, i) => ({ id: 'don' + i, card_name: 'DON!! Card (Special ' + i + ')' }))
  ];
  const result = ctx.scan.resolveEvidence('Moby Dick\nRest one DON!! card\nSTAGE', { cards });
  assert.equal(result.name, 'MOBY DICK');
  assert.deepEqual(Array.from(result.candidates.map(card => card.id)), ['moby1', 'moby2']);
});
test('no card text yields no catalog candidates', () => {
  assert.equal(evidence('desk monitor keyboard').candidates.length, 0);
});
const manyCards = Array.from({ length: 55 }, (_, i) => ({ ...catalog[0], id: String(i + 1), star: i === 54 }));
test('name evidence retains every ranked candidate beyond the first page', () => {
  const result = ctx.scan.resolveEvidence('Kuro', { cards: manyCards });
  assert.equal(result.totalCandidates, 55); assert.equal(result.candidates.length, 55);
  assert.equal(result.candidates[54].id, '55');
});
function starFixture(kind, centerY = 67) {
  const vertices = Array.from({ length: 10 }, (_, i) => {
    const angle = i * Math.PI / 5 - Math.PI / 2, radius = i % 2 ? 3 : 7;
    return [135 + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius];
  });
  const pixels = image((x, y) => {
    if (kind === 'circle') return Math.hypot(x - 135, y - centerY) < 7 ? 220 : 28;
    if (kind === 'regular') return x >= 132 && x <= 136 && y >= centerY - 7 && y <= centerY + 7 ? 220 : 28;
    if (kind !== 'star') return 28;
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const [ax, ay] = vertices[i], [bx, by] = vertices[j];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    return inside ? 220 : 28;
  });
  return { width: pixels.width, height: pixels.height, getContext: () => ({ getImageData: () => pixels }) };
}
const codeBoxes = { blocks: [{ paragraphs: [{ lines: [{ words: [
  { text: 'OP15-02588', bbox: { x0: 50, y0: 70, x1: 145, y1: 95 } }
] }] }] }] };
test('printing star is detected only beside a recognized code, including inside its merged word box', () => {
  assert.equal(ctx.scan.detectPrintingStar(starFixture('star'), codeBoxes, ['OP15025']), true);
  assert.equal(ctx.scan.detectPrintingStar(starFixture('star'), codeBoxes, []), null);
  assert.equal(ctx.scan.detectPrintingStar(starFixture('star'), codeBoxes, ['OP15025', 'OP15026']), null);
  assert.equal(ctx.scan.detectPrintingStar(starFixture('star', 20), codeBoxes, ['OP15025']), null);
});
test('printing-star anchors use canonical O/I/L digit recovery', () => {
  for (const text of ['OPI5-O2588', 'OPL5-O2588', '0PI5-O2588']) {
    const boxes = { words: [{ text, bbox: { x0: 50, y0: 70, x1: 145, y1: 95 } }] };
    assert.equal(ctx.scan.readNumbers(text, new Set(['OP15025']))[0], 'OP15025');
    assert.equal(ctx.scan.detectPrintingStar(starFixture('star'), boxes, ['OP15025']), true);
  }
});
test('printing-star anchors reject unrelated or malformed leading text', () => {
  for (const text of ['art OP15-02588', 'OP15-02688', 'OP15025000 OP15-02588', '★ OP15-02588']) {
    const boxes = { words: [{ text, bbox: { x0: 50, y0: 70, x1: 145, y1: 95 } }] };
    assert.equal(ctx.scan.detectPrintingStar(starFixture('star'), boxes, ['OP15025']), null);
  }
});
for (const kind of ['regular', 'circle', 'none']) {
  test(`regular/no-star code-adjacent fixture stays unknown (${kind})`, () => {
    assert.equal(ctx.scan.detectPrintingStar(starFixture(kind), codeBoxes, ['OP15025']), null);
  });
}
test('decorative Unicode stars in unrelated OCR text never mark the printing', () => {
  assert.equal(evidence('★ artwork decoration\nOP15-025').starred, null);
});
test('positive printing star excludes regular but preserves every compatible alternate printing', () => {
  const cards = [...catalog, { ...catalog[1], id: '4', card_name: 'Kuro (Manga)' }];
  const result = ctx.scan.resolveEvidence('OP15-025', { cards });
  const filtered = ctx.scan.applyStarEvidence(result, true, { cards, isStarred: card => !!card.star });
  assert.equal(filtered.starred, true);
  assert.deepEqual(Array.from(filtered.candidates.map(card => card.id)), ['2', '4']);
  assert.equal(filtered.totalCandidates, 2);
  const unknown = ctx.scan.applyStarEvidence(result, null, { cards, isStarred: card => !!card.star });
  assert.equal(unknown.starred, null); assert.equal(unknown.candidates.length, 3);
  const mixed = ctx.scan.applyStarEvidence(ctx.scan.resolveEvidence('OP15-025 OP15-026', { cards }), true,
    { cards, isStarred: card => !!card.star });
  assert.equal(mixed.starred, null); assert.equal(mixed.candidates.length, 4);
});
function cameraHarness({ contextUnavailable = false, frameError = false, noMatch = false, text = 'OP15-025', refineText = text, deferProbe = false, cards = catalog, probeTexts, maskedName = false } = {}) {
  let now = 0, timerId = 0, scans = 0, stops = 0, cameraResolve, probes = 0, sessions = 0, pendingProbe;
  const timers = new Map(), nodes = new Map(), regions = [], recognitionCalls = [];
  const matchEvidence = text => ctx.scan.resolveEvidence(text, { cards });
  let previewImage = card, sceneStep = 0;
  function element() {
    const handlers = {};
    return { hidden: false, disabled: false, checked: true, value: '', textContent: '', innerHTML: '',
      style: {}, dataset: {}, readyState: 2, currentTime: 0, videoWidth: 1080, videoHeight: 1920,
      clientWidth: 300, clientHeight: 400, classList: { toggle() {} },
      addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
      async emit(type, event = {}) { for (const fn of handlers[type] || []) await fn(event); },
      focus() {}, replaceChildren() {}, showModal() { this.open = true; }, close() { this.open = false; },
      play() { return Promise.resolve(); },
      getContext() { return contextUnavailable ? null : { drawImage() { if (frameError) throw Error('Frame unavailable'); }, getImageData() { return previewImage; } }; }
    };
  }
  const $ = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const document = element(); document.hidden = false; document.createElement = element;
  const window = element();
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const track = element(); track.stop = () => { stops++; };
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const code = app.slice(app.indexOf('  function wireCardScan()'), app.indexOf('  function wireCatalog()'));
  const context = vm.createContext({ $, document, window, console, AbortController, Set, Map,
    navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { cameraResolve = resolve; }) } },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 }, performance: { now: () => now },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
    on: (selector, type, fn) => $(selector).addEventListener(type, fn),
    OQ_SCAN: { ...ctx.scan, picture: (video, dimensions, region) => { regions.push(region); return { width: 10, height: 14 }; },
      recognize: async () => { scans++; return matchEvidence(text); },
      createRecognizer(signal) { sessions++; return {
        close() {},
        async recognize(frame, settings = {}) {
          recognitionCalls.push({ ...settings });
          if (settings.probe && !settings.confirm) probes++;
          const probeText = probeTexts?.[Math.min(probes - 1, probeTexts.length - 1)] ?? text;
          if (deferProbe) return new Promise((resolve, reject) => {
            pendingProbe = () => resolve(matchEvidence(noMatch ? '' : probeText));
            signal.addEventListener('abort', () => reject(Error('Cancelled')), { once: true });
          });
          const result = matchEvidence(noMatch ? '' : settings.probe && !settings.confirm ? probeText : refineText);
          result.enhanced = !!(maskedName || settings.enhanced);
          return result;
        }
      }; }
    }, S: { cards }, E: { cardKey: card => card.id, rarityBadge: card => ({ label: 'Rare', star: !!card.star }) },
    C: { cardTitle: value => value }, esc: value => value, cardArt: () => ''
  });
  vm.runInContext(code + '\nwireCardScan();', context);
  async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
  async function openCamera() {
    await $('#scan-open').emit('click'); const request = $('#scan-camera').emit('click');
    cameraResolve(stream); await request; await flush();
  }
  async function tick(duration = 160, advanceVideo = true) {
    now += duration;
    if (advanceVideo && $('#scan-video').readyState >= 2) $('#scan-video').currentTime += duration / 1000;
    const callbacks = [...timers.values()]; timers.clear();
    for (const callback of callbacks) callback();
    await flush();
  }
  return { $, document, window, stream, openCamera, tick, timers, regions, recognitionCalls, flush,
    changeScene: () => { sceneStep = sceneStep ? 0 : 25; previewImage = image((x, y) => (within(x, y) ? detail(x, y) : 28) + sceneStep); },
    finishProbe: async () => { pendingProbe(); await flush(); }, resolveCamera: () => cameraResolve(stream),
    scans: () => scans, stops: () => stops, probes: () => probes, sessions: () => sessions };
}
test('automatic matching uses two independent probes and one reusable session', async () => {
  const h = cameraHarness(); await h.openCamera();
  for (let i = 0; i < 20; i++) await h.tick();
  assert.equal(h.probes(), 2); assert.equal(h.sessions(), 1); assert.equal(h.stops(), 1);
  assert.match(h.$('#scan-status').textContent, /possible printings/);
  assert.ok(h.regions.every(region => region.join(',') === '0,0,1,1'));
  await h.$('#scan-capture').emit('click'); assert.equal(h.scans(), 0);
});
test('short catalog name can confirm across two independent probes without guessing printing', async () => {
  const h = cameraHarness({ text: 'Kuro' }); await h.openCamera();
  for (let i = 0; i < 20; i++) await h.tick();
  assert.equal(h.probes(), 2); assert.equal(h.stops(), 1);
  assert.match(h.$('#scan-status').textContent, /based on the card name/);
});
test('name matches paginate all candidates and Star present filters instead of sorting', async () => {
  const h = cameraHarness({ text: 'Kuro', cards: manyCards }); await h.openCamera();
  for (let i = 0; i < 20; i++) await h.tick();
  const count = () => (h.$('#scan-results').innerHTML.match(/data-key=/g) || []).length;
  assert.equal(count(), 24); assert.match(h.$('#scan-status').textContent, /Showing 24 of 55/);
  assert.equal(h.$('#scan-more').hidden, false);
  h.$('#scan-star').checked = true; await h.$('#scan-star').emit('change');
  assert.match(h.$('#scan-results').innerHTML, /data-key="55"/);
  assert.equal(count(), 1); assert.equal(h.$('#scan-more').hidden, true);
  h.$('#scan-star').checked = false; await h.$('#scan-star').emit('change');
  await h.$('#scan-more').emit('click');
  assert.equal(count(), 48); assert.match(h.$('#scan-status').textContent, /Showing 48 of 55/);
  await h.$('#scan-more').emit('click');
  assert.equal(count(), 55); assert.match(h.$('#scan-results').innerHTML, /data-key="54"/);
  assert.equal(h.$('#scan-more').hidden, true);
});
test('known-number lookup paginates all printings and resets on a new lookup', async () => {
  const h = cameraHarness({ cards: manyCards }); await h.$('#scan-open').emit('click');
  const lookup = async () => {
    h.$('#scan-number').value = 'OP15-025';
    await h.$('#scan-lookup').emit('submit', { preventDefault() {} });
  };
  await lookup(); assert.match(h.$('#scan-status').textContent, /Showing 24 of 55/);
  await h.$('#scan-more').emit('click'); await h.$('#scan-more').emit('click');
  assert.match(h.$('#scan-results').innerHTML, /data-key="55"/);
  assert.equal(h.$('#scan-more').hidden, true);
  await lookup(); assert.match(h.$('#scan-status').textContent, /Showing 24 of 55/);
  assert.equal(h.$('#scan-more').hidden, false);
});
for (const refineText of ['Kuro\nJango', 'Jango']) {
  test(`name-only refinement must agree with the twice-observed name (${refineText.replace('\n', ' / ')})`, async () => {
    const h = cameraHarness({ text: 'Kuro', refineText }); await h.openCamera();
    for (let i = 0; i < 20; i++) await h.tick();
    assert.ok(h.probes() >= 2); assert.equal(h.stops(), 0);
    assert.equal(h.$('#scan-controls').hidden, false);
    assert.match(h.$('#scan-quality').textContent, /Could not confirm|Looking for/);
  });
}
test('failed automatic scans escalate then pause with an actionable manual fallback', async () => {
  const h = cameraHarness({ noMatch: true }); await h.openCamera();
  for (let i = 0; i < 60; i++) await h.tick();
  assert.equal(h.probes(), 4); assert.equal(h.stops(), 0);
  assert.deepEqual(h.recognitionCalls.map(call => call.enhanced), [false, false, true, true]);
  assert.equal(h.$('#scan-auto').checked, false);
  assert.match(h.$('#scan-quality').textContent, /Could not identify.*enable Auto capture.*Scan card/);
  for (let i = 0; i < 20; i++) await h.tick();
  assert.equal(h.probes(), 4);
  h.$('#scan-auto').checked = true; await h.$('#scan-auto').emit('change'); await h.tick();
  assert.equal(h.probes(), 5);
});
test('two foil-enhanced name observations avoid the redundant slow final pipeline', async () => {
  const h = cameraHarness({ text: 'Kuro', maskedName: true }); await h.openCamera();
  for (let i = 0; i < 20; i++) await h.tick();
  assert.equal(h.probes(), 2); assert.equal(h.recognitionCalls.length, 2);
  assert.equal(h.stops(), 1);
  assert.match(h.$('#scan-status').textContent, /based on the card name/);
});
test('a successful detailed fallback stays detailed for its independent confirmation', async () => {
  const h = cameraHarness({ text: 'Kuro', probeTexts: ['', '', 'Kuro', 'Kuro'] }); await h.openCamera();
  for (let i = 0; i < 60; i++) await h.tick();
  assert.deepEqual(h.recognitionCalls.map(call => call.enhanced), [false, false, true, true]);
  assert.equal(h.probes(), 4); assert.equal(h.stops(), 1);
});
test('slow in-flight scanning exposes elapsed guidance while manual capture remains available', async () => {
  const h = cameraHarness({ deferProbe: true }); await h.openCamera();
  await h.tick(6000);
  assert.match(h.$('#scan-quality').textContent, /Still reading.*Scan card/);
  assert.equal(h.$('#scan-capture').disabled, false);
  await h.tick(5000);
  assert.match(h.$('#scan-quality').textContent, /taking longer.*Scan card/);
  assert.equal(h.probes(), 1);
  await h.$('#scan-capture').emit('click'); await h.flush();
  assert.equal(h.scans(), 1); assert.equal(h.stops(), 1);
});
test('overall automatic budget pauses retries even when each individual probe is below its deadline', async () => {
  const h = cameraHarness({ deferProbe: true, noMatch: true }); await h.openCamera();
  await h.tick(11000); await h.finishProbe();
  await h.tick(2000); assert.equal(h.probes(), 2);
  await h.tick(8000);
  assert.equal(h.$('#scan-auto').checked, false); assert.equal(h.stops(), 0);
  assert.match(h.$('#scan-quality').textContent, /paused after 20 seconds.*Scan card/);
  await h.finishProbe(); await h.tick();
  assert.equal(h.probes(), 2);
  assert.match(h.$('#scan-quality').textContent, /paused after 20 seconds/);
  assert.equal(h.$('#scan-capture').disabled, false);
});
test('conflicting names and unknown numbers never auto commit', async () => {
  for (const text of ['Kuro\nJango', 'OP99-999\nKuro']) {
    const h = cameraHarness({ text }); await h.openCamera();
    for (let i = 0; i < 30; i++) await h.tick();
    assert.equal(h.stops(), 0);
  }
});
test('only one OCR probe is in flight and manual capture cancels it', async () => {
  const h = cameraHarness({ deferProbe: true }); await h.openCamera();
  for (let i = 0; i < 40; i++) await h.tick();
  assert.equal(h.probes(), 1);
  await h.$('#scan-capture').emit('click'); await h.flush();
  assert.equal(h.stops(), 1); assert.equal(h.scans(), 1); assert.equal(h.timers.size, 0);
  await h.finishProbe(); assert.equal(h.stops(), 1);
});
test('normal handheld jitter does not block matching or auto capture', async () => {
  const h = cameraHarness(); await h.openCamera();
  for (let i = 0; i < 20; i++) { h.changeScene(); await h.tick(); }
  assert.equal(h.probes(), 2); assert.equal(h.stops(), 1);
});
test('a new OCR identity must receive its own second observation', async () => {
  const h = cameraHarness({ probeTexts: ['OP15-025', 'OP15-026', 'OP15-026'], refineText: 'OP15-026' });
  await h.openCamera();
  for (let i = 0; i < 4; i++) { h.changeScene(); await h.tick(); }
  assert.equal(h.probes(), 2); assert.equal(h.stops(), 0);
  for (let i = 0; i < 8; i++) { h.changeScene(); await h.tick(); }
  assert.equal(h.probes(), 3); assert.equal(h.stops(), 1);
});
test('manual full-frame capture works with automatic disabled', async () => {
  const h = cameraHarness(); h.$('#scan-auto').checked = false; await h.openCamera();
  for (let i = 0; i < 10; i++) await h.tick();
  assert.equal(h.probes(), 0); await h.$('#scan-capture').emit('click'); await h.flush();
  assert.equal(h.scans(), 1); assert.equal(h.stops(), 1);
  assert.equal(h.regions[0].join(','), '0,0,1,1');
});
test('closing pending permission stops late tracks', async () => {
  const h = cameraHarness(); await h.$('#scan-open').emit('click');
  const request = h.$('#scan-camera').emit('click');
  await h.$('#scan-close').emit('click'); h.resolveCamera(); await request;
  assert.equal(h.stops(), 1); assert.equal(h.probes(), 0); assert.equal(h.timers.size, 0);
});
test('backgrounding aborts a pending match and stops preview', async () => {
  const h = cameraHarness({ deferProbe: true }); await h.openCamera();
  for (let i = 0; i < 10; i++) await h.tick();
  h.document.hidden = true; await h.document.emit('visibilitychange'); await h.flush();
  assert.equal(h.stops(), 1); assert.equal(h.timers.size, 0);
  await h.finishProbe(); assert.equal(h.stops(), 1);
});
test('video warming and frozen-frame diagnostics remain visible', async () => {
  const h = cameraHarness(), video = h.$('#scan-video'); video.readyState = 0;
  await h.openCamera(); assert.equal(h.$('#scan-quality').hidden, false);
  for (let i = 0; i < 6; i++) await h.tick(600);
  assert.match(h.$('#scan-quality').textContent, /No camera frames/);
  video.readyState = 2; await h.tick();
  for (let i = 0; i < 15; i++) await h.tick(160, false);
  assert.match(h.$('#scan-quality').textContent, /preview paused/); assert.equal(h.probes(), 1);
  assert.equal(h.stops(), 0);
});
for (const failure of [{ contextUnavailable: true }, { frameError: true }]) {
  test('analysis failure leaves full-frame manual fallback ' + Object.keys(failure)[0], async () => {
    const h = cameraHarness(failure); await h.openCamera();
    assert.match(h.$('#scan-quality').textContent, /matching unavailable/);
    await h.$('#scan-capture').emit('click'); assert.equal(h.scans(), 1);
  });
}
test('late playback failure cannot disrupt newer camera session', async () => {
  const h = cameraHarness(); let rejectPlay;
  h.$('#scan-video').play = () => new Promise((_, reject) => { rejectPlay = reject; });
  await h.openCamera(); await h.$('#scan-cancel-camera').emit('click');
  h.$('#scan-video').play = () => Promise.resolve();
  const newer = h.$('#scan-camera').emit('click'); h.resolveCamera(); await newer;
  rejectPlay(Error('Old playback failed')); await h.flush();
  assert.equal(h.stops(), 1); assert.equal(h.$('#scan-controls').hidden, false);
});

function recognizerHarness({ text = 'OP15-025', texts, delayStart = false, delayOCR = false } = {}) {
  let created = 0, terminated = 0, resolveStart, resolveOCR, reads = 0;
  const modes = [], draws = [];
  const worker = {
    setParameters: async values => modes.push(values.tessedit_pageseg_mode),
    recognize: async () => {
      const result = texts?.[Math.min(reads++, texts.length - 1)] ?? text;
      return delayOCR ? new Promise(resolve => { resolveOCR = () => resolve({ data: { text: result } }); }) : { data: { text: result } };
    },
    terminate: async () => { terminated++; }
  };
  const document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({
    drawImage: (...args) => draws.push(args), getImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData() {}
  }) }) };
  const local = vm.createContext({ console, document, DOMException, setTimeout, clearTimeout,
    window: { Tesseract: { createWorker: async () => {
      created++;
      return delayStart ? new Promise(resolve => { resolveStart = () => resolve(worker); }) : worker;
    } } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'card-scan.js'), 'utf8') + '\nglobalThis.scan = OQ_SCAN;', local);
  const controller = new AbortController();
  const session = local.scan.createRecognizer(controller.signal, () => {}, { cards: catalog });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { session, controller, flush, modes, draws, created: () => created, terminated: () => terminated,
    start: () => resolveStart(), finish: () => resolveOCR() };
}
test('actual recognizer reuses one worker across probes and sets segmentation via supported parameters', async () => {
  const h = recognizerHarness(), frame = { width: 1000, height: 1500 };
  const first = await h.session.recognize(frame, { probe: true });
  const second = await h.session.recognize(frame, { probe: true });
  assert.equal(first.numbers[0], 'OP15025'); assert.equal(second.numbers[0], 'OP15025');
  assert.equal(h.created(), 1); assert.deepEqual(h.modes, ['11', '11']);
  h.session.close(); await h.flush(); assert.equal(h.terminated(), 1);
});
test('foil text mask separates warm letters without turning blue artwork or gray into text', () => {
  const data = new Uint8ClampedArray([150, 160, 60, 255, 30, 80, 180, 255, 130, 130, 130, 255]);
  const canvas = { width: 3, height: 1, getContext: () => ({ getImageData: () => ({ data }), putImageData() {} }) };
  ctx.scan.maskFoilText(canvas);
  assert.deepEqual([...data], [0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
});
for (const probe of [false, true]) {
  test(`foil name recovery is an early whole-frame second OCR view (${probe ? 'camera' : 'photo'})`, async () => {
    const h = recognizerHarness({ texts: ['', 'Kuro'] }), frame = { width: 1000, height: 1500 };
    const result = await h.session.recognize(frame, { probe }); h.session.close();
    assert.equal(result.name, 'KURO'); assert.equal(result.enhanced, true);
    assert.deepEqual(h.modes, ['11', '11']);
    assert.equal(result.candidates.length, 2);
    assert.equal(h.draws[0][1], 0); assert.equal(h.draws[0][2], 0);
    assert.equal(h.draws[1][1], 0); assert.equal(h.draws[1][2], 0);
  });
}
test('quick no-match camera attempt uses at most two OCR views before returning for guidance', async () => {
  const h = recognizerHarness({ text: '' });
  const result = await h.session.recognize({ width: 1000, height: 1500 }, { probe: true }); h.session.close();
  assert.equal(result.candidates.length, 0); assert.equal(h.modes.length, 2);
});
test('bounded confirmation tries a magnified code view before returning a name-only result', async () => {
  const h = recognizerHarness({ texts: ['6000\nCHARACTER\nKuro', 'OP15-025'] });
  const frame = { width: 1000, height: 1500 };
  const result = await h.session.recognize(frame, { probe: true, enhanced: true, confirm: true }); h.session.close();
  assert.equal(result.numbers[0], 'OP15025'); assert.equal(h.modes.length, 2);
  assert.ok(h.draws.some(args => args[2] === 600 && args[4] === 900));
});
test('late worker startup is terminated after cancellation', async () => {
  const h = recognizerHarness({ delayStart: true });
  const pending = h.session.recognize({ width: 1000, height: 1500 });
  await h.flush(); h.controller.abort();
  await assert.rejects(pending, /cancelled/);
  h.start(); await h.flush(); assert.equal(h.terminated(), 1);
});
test('one recognizer cannot overlap OCR jobs; cancellation interrupts an active job', async () => {
  const h = recognizerHarness({ delayOCR: true }), frame = { width: 1000, height: 1500 };
  const pending = h.session.recognize(frame); await h.flush();
  await assert.rejects(h.session.recognize(frame), /already running/);
  h.controller.abort(); await assert.rejects(pending, /cancelled/);
  h.finish(); await h.flush(); assert.equal(h.terminated(), 1);
});
test('fallback magnification covers upper and lower frame instead of assuming a footer position', async () => {
  const h = recognizerHarness({ text: '' }), frame = { width: 1000, height: 1500 };
  await h.session.recognize(frame); h.session.close();
  assert.ok(h.draws.some(args => args[1] === 0 && args[2] === 0 && args[3] === 1000 && args[4] === 900));
  assert.ok(h.draws.some(args => args[1] === 0 && args[2] === 600 && args[3] === 1000 && args[4] === 900));
});

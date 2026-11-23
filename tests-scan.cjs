/* Scanner quality/stability regressions: node tests-scan.cjs (no dependencies). */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(__dirname, 'card-scan.js'), 'utf8') + '\nglobalThis.scan = OQ_SCAN;', ctx);
const { analyzeFrame, createCaptureGate } = ctx.scan;

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
  { id: '2', card_name: 'Kuro (025) (Alternate Art)', card_set_id: 'OP15-025', power: '6000', rulesText: 'Rest an opponent character. East Blue pirates.', set_name: 'Adventure' },
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
test('no card text yields no catalog candidates', () => {
  assert.equal(evidence('desk monitor keyboard').candidates.length, 0);
});
const manyCards = Array.from({ length: 55 }, (_, i) => ({ ...catalog[0], id: String(i + 1), star: i === 54 }));
test('name evidence retains every ranked candidate beyond the first page', () => {
  const result = ctx.scan.resolveEvidence('Kuro', { cards: manyCards });
  assert.equal(result.totalCandidates, 55); assert.equal(result.candidates.length, 55);
  assert.equal(result.candidates[54].id, '55');
});
for (const cadence of [160, 400, 600]) {
  test(`steady ${cadence}ms preview requires sustained independent samples`, () => {
    const gate = createCaptureGate(), q = quality(), events = [];
    for (let t = 0; t <= 6000; t += cadence) if (gate.update(q, t).capture) events.push(t);
    assert.equal(events.length, 1); assert.ok(events[0] >= Math.max(800, cadence * 5));
  });
}
test('movement, bad exposure and long interruptions reset readiness', () => {
  const gate = createCaptureGate(), q = quality();
  for (let t = 0; t <= 640; t += 160) gate.update(q, t);
  assert.equal(gate.update({ ...q, fingerprint: q.fingerprint.map(x => x + 25) }, 800).state, 'moving');
  assert.equal(gate.update(q, 960).capture, false);
  assert.equal(gate.update(q, 4000).capture, false);
  assert.equal(gate.update({ ...q, state: 'dark', message: 'Add light' }, 4160).capture, false);
});

function cameraHarness({ contextUnavailable = false, frameError = false, noMatch = false, text = 'OP15-025', refineText = text, deferProbe = false, cards = catalog } = {}) {
  let now = 0, timerId = 0, scans = 0, stops = 0, cameraResolve, probes = 0, sessions = 0, pendingProbe;
  const timers = new Map(), nodes = new Map(), regions = [];
  const matchEvidence = text => ctx.scan.resolveEvidence(text, { cards });
  let previewImage = card;
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
          if (settings.probe) probes++;
          if (deferProbe) return new Promise((resolve, reject) => {
            pendingProbe = () => resolve(matchEvidence(noMatch ? '' : text));
            signal.addEventListener('abort', () => reject(Error('Cancelled')), { once: true });
          });
          return matchEvidence(noMatch ? '' : settings.probe ? text : refineText);
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
  return { $, document, window, stream, openCamera, tick, timers, regions, flush,
    changeScene: () => { previewImage = image((x, y) => (within(x, y) ? detail(x, y) : 28) + 25); },
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
test('name matches paginate all candidates with accurate totals and preserve star sorting', async () => {
  const h = cameraHarness({ text: 'Kuro', cards: manyCards }); await h.openCamera();
  for (let i = 0; i < 20; i++) await h.tick();
  const count = () => (h.$('#scan-results').innerHTML.match(/data-key=/g) || []).length;
  assert.equal(count(), 24); assert.match(h.$('#scan-status').textContent, /Showing 24 of 55/);
  assert.equal(h.$('#scan-more').hidden, false);
  h.$('#scan-star').checked = true; await h.$('#scan-star').emit('change');
  assert.match(h.$('#scan-results').innerHTML, /data-key="55"/);
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
    assert.match(h.$('#scan-quality').textContent, /Could not confirm|Hold steady/);
  });
}
test('no match keeps camera running and bounds OCR probe rate', async () => {
  const h = cameraHarness({ noMatch: true }); await h.openCamera();
  for (let i = 0; i < 60; i++) await h.tick();
  assert.ok(h.probes() >= 2 && h.probes() <= 6, 'probe count ' + h.probes()); assert.equal(h.stops(), 0);
  assert.match(h.$('#scan-quality').textContent, /No match|Hold steady/);
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
test('movement during a pending OCR probe invalidates its match', async () => {
  const h = cameraHarness({ deferProbe: true }); await h.openCamera();
  for (let i = 0; i < 10; i++) await h.tick();
  assert.equal(h.probes(), 1); h.changeScene(); await h.tick();
  await h.finishProbe(); assert.equal(h.stops(), 0);
  assert.equal(h.$('#scan-controls').hidden, false);
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
  assert.match(h.$('#scan-quality').textContent, /preview paused/); assert.equal(h.probes(), 0);
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

function recognizerHarness({ text = 'OP15-025', delayStart = false, delayOCR = false } = {}) {
  let created = 0, terminated = 0, resolveStart, resolveOCR;
  const modes = [], draws = [];
  const worker = {
    setParameters: async values => modes.push(values.tessedit_pageseg_mode),
    recognize: async () => delayOCR ? new Promise(resolve => { resolveOCR = () => resolve({ data: { text } }); }) : { data: { text } },
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

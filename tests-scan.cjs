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

test('sharp well-lit aligned four-sided card is eligible', () => {
  assert.equal(quality().state, 'ready');
});
test('steady blank background cannot trigger auto capture', () => {
  assert.equal(analyzeFrame(image(() => 125)).state, 'framing');
});
test('full-frame textured scene without outer card edges is rejected', () => {
  assert.equal(analyzeFrame(image(detail)).state, 'framing');
});
test('missing one card edge is rejected', () => {
  assert.equal(analyzeFrame(image((x, y) => x >= 10 && y >= 14 && y < 238 ? detail(x, y) : 28)).state, 'framing');
});
test('card too small for the guide requests framing adjustment', () => {
  assert.equal(analyzeFrame(image((x, y) => x >= 40 && x < 140 && y >= 56 && y < 196 ? detail(x, y) : 28)).state, 'framing');
});
test('dark exposure and broad bright clipping get specific guidance', () => {
  assert.equal(analyzeFrame(image(() => 20)).state, 'dark');
  assert.equal(analyzeFrame(image((x, y) => within(x, y) ? (x > 70 ? 255 : detail(x, y)) : 28)).state, 'glare');
});
test('smooth framed card waits for focus instead of auto capturing', () => {
  assert.equal(analyzeFrame(image((x, y) => within(x, y) ? 130 : 28)).state, 'blur');
});
test('stable eligible frames capture once after sustained readiness', () => {
  const gate = createCaptureGate(), q = quality(), events = [];
  for (let time = 0; time <= 2400; time += 160) if (gate.update(q, time).capture) events.push(time);
  assert.equal(events.length, 1);
  assert.ok(events[0] >= 800);
});
for (const cadence of [400, 600]) {
  test(`stable ${cadence}ms Android preview cadence captures once`, () => {
    const gate = createCaptureGate(), q = quality(), events = [];
    for (let t = 0; t <= 6000; t += cadence) if (gate.update(q, t).capture) events.push(t);
    assert.equal(events.length, 1);
    assert.ok(events[0] >= cadence * 5);
  });
}
test('intermittent normal cadence still requires five distinct usable samples', () => {
  const gate = createCaptureGate(), q = quality();
  const times = [0, 450, 1050, 1210, 1710];
  for (const t of times) assert.equal(gate.update(q, t).capture, false);
  for (let i = 0; i < 30; i++) assert.equal(gate.update(q, 1710).capture, false);
  assert.equal(gate.update(q, 2310).capture, true);
});
test('movement resets the steady interval', () => {
  const gate = createCaptureGate(), q = quality();
  for (let t = 0; t <= 640; t += 160) assert.equal(gate.update(q, t).capture, false);
  const moving = { ...q, fingerprint: q.fingerprint.map(x => x + 25) };
  assert.equal(gate.update(moving, 800).state, 'moving');
  for (let t = 960; t <= 1600; t += 160) assert.equal(gate.update(q, t).capture, false);
});
test('bad quality interrupts readiness and disabled auto never captures', () => {
  const gate = createCaptureGate(), q = quality();
  for (let t = 0; t <= 4000; t += 160) assert.equal(gate.update(q, t, false).capture, false);
  gate.reset();
  for (let t = 0; t <= 640; t += 160) gate.update(q, t);
  gate.update({ ...q, state: 'blur', message: 'Focus' }, 800);
  assert.equal(gate.update(q, 960).capture, false);
});
test('long callback gaps cannot count as holding steady; reset re-arms next session', () => {
  const gate = createCaptureGate(), q = quality();
  gate.update(q, 0); gate.update(q, 160);
  assert.equal(gate.update(q, 4000).capture, false);
  for (let t = 4160; t <= 5120; t += 160) gate.update(q, t);
  assert.equal(gate.update(q, 5280).state, 'capturing');
  gate.reset();
  assert.equal(gate.update(q, 6000).capture, false);
});

function cameraHarness({ contextUnavailable = false, frameError = false } = {}) {
  let now = 0, timerId = 0, scans = 0, stops = 0, cameraResolve;
  const timers = new Map(), nodes = new Map();
  function element() {
    const handlers = {};
    return { hidden: false, disabled: false, checked: true, value: '', textContent: '',
      style: {}, dataset: {}, readyState: 2, currentTime: 0, videoWidth: 1080, videoHeight: 1920,
      clientWidth: 300, clientHeight: 400, classList: { toggle() {} },
      addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
      async emit(type, event = {}) { for (const fn of handlers[type] || []) await fn(event); },
      focus() {}, replaceChildren() {}, showModal() { this.open = true; }, close() { this.open = false; },
      play() { return Promise.resolve(); },
      getContext() { return contextUnavailable ? null : { drawImage() { if (frameError) throw Error('Frame unavailable'); }, getImageData() { return card; } }; }
    };
  }
  const $ = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const document = element(); document.hidden = false; document.createElement = element;
  const window = element();
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const track = element(); track.stop = () => { stops++; };
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const code = app.slice(app.indexOf('  function wireCardScan()'), app.indexOf('  function wireCatalog()'));
  const context = vm.createContext({ $, document, window, console, AbortController,
    navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { cameraResolve = resolve; }) } },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 }, performance: { now: () => now },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
    ResizeObserver: class { observe() {} }, on: (selector, type, fn) => $(selector).addEventListener(type, fn),
    OQ_SCAN: { ...ctx.scan, picture: () => ({ width: 10, height: 14 }),
      recognize: async () => { scans++; return { numbers: [], starred: false }; } }, S: { cards: [] }
  });
  vm.runInContext(code + '\nwireCardScan();', context);
  async function openCamera() {
    await $('#scan-open').emit('click');
    const request = $('#scan-camera').emit('click');
    cameraResolve(stream); await request;
  }
  async function tick(duration = 160, advanceVideo = true) {
    now += duration;
    if (advanceVideo && $('#scan-video').readyState >= 2) $('#scan-video').currentTime += duration / 1000;
    const callbacks = [...timers.values()]; timers.clear();
    for (const callback of callbacks) callback();
    await Promise.resolve(); await Promise.resolve();
  }
  return { $, document, window, stream, openCamera, tick, timers,
    resolveCamera: () => cameraResolve(stream), scans: () => scans, stops: () => stops };
}

test('automatic and manual capture share a single-shot camera path', async () => {
  const h = cameraHarness(); await h.openCamera();
  for (let i = 0; i < 9; i++) await h.tick();
  assert.equal(h.scans(), 1); assert.equal(h.stops(), 1);
  await h.$('#scan-capture').emit('click');
  for (let i = 0; i < 4; i++) await h.tick();
  assert.equal(h.scans(), 1); assert.equal(h.timers.size, 0);
});
test('manual capture remains available with automatic capture disabled', async () => {
  const h = cameraHarness(); h.$('#scan-auto').checked = false; await h.openCamera();
  for (let i = 0; i < 10; i++) await h.tick();
  assert.equal(h.scans(), 0); assert.equal(h.$('#scan-capture').disabled, false);
  await h.$('#scan-capture').emit('click');
  assert.equal(h.scans(), 1); assert.equal(h.stops(), 1);
});
test('closing while camera permission is pending stops late tracks', async () => {
  const h = cameraHarness(); await h.$('#scan-open').emit('click');
  const request = h.$('#scan-camera').emit('click');
  await h.$('#scan-close').emit('click'); h.resolveCamera(); await request;
  assert.equal(h.stops(), 1); assert.equal(h.scans(), 0); assert.equal(h.timers.size, 0);
});
test('backgrounding stops preview and tracks and requires explicit resume', async () => {
  const h = cameraHarness(); await h.openCamera();
  h.document.hidden = true; await h.document.emit('visibilitychange');
  for (let i = 0; i < 10; i++) await h.tick();
  assert.equal(h.stops(), 1); assert.equal(h.scans(), 0); assert.equal(h.timers.size, 0);
  h.document.hidden = false; await h.document.emit('visibilitychange');
  assert.equal(h.timers.size, 0);
});

test('slow camera frames capture through the actual preview loop', async () => {
  const h = cameraHarness(); await h.openCamera();
  for (let i = 0; i < 8; i++) await h.tick(600);
  assert.equal(h.scans(), 1); assert.equal(h.stops(), 1);
});
test('delayed video readiness shows warming then actionable no-frame guidance', async () => {
  const h = cameraHarness(), video = h.$('#scan-video');
  video.readyState = 0; video.videoWidth = video.videoHeight = 0;
  await h.openCamera();
  assert.equal(h.$('#scan-quality').hidden, false);
  assert.match(h.$('#scan-quality').textContent, /Starting camera/);
  for (let i = 0; i < 6; i++) await h.tick(600);
  assert.match(h.$('#scan-quality').textContent, /No camera frames yet/);
  assert.equal(h.$('#scan-capture').disabled, true); assert.equal(h.scans(), 0);
  video.readyState = 2; video.videoWidth = 1080; video.videoHeight = 1920;
  await h.tick();
  assert.match(h.$('#scan-quality').textContent, /Hold steady/);
  assert.equal(h.$('#scan-capture').disabled, false);
});
test('a frozen video cannot be mistaken for independent steady frames', async () => {
  const h = cameraHarness(); await h.openCamera();
  for (let i = 0; i < 15; i++) await h.tick(160, false);
  assert.equal(h.scans(), 0);
  assert.match(h.$('#scan-quality').textContent, /Camera preview paused/);
});
for (const failure of [{ contextUnavailable: true }, { frameError: true }]) {
  test(`preview analysis failure keeps visible manual fallback (${Object.keys(failure)[0]})`, async () => {
    const h = cameraHarness(failure); await h.openCamera();
    assert.match(h.$('#scan-quality').textContent, /Auto capture unavailable/);
    assert.equal(h.$('#scan-quality').hidden, false);
    assert.equal(h.$('#scan-capture').disabled, false);
    await h.$('#scan-capture').emit('click');
    assert.equal(h.scans(), 1);
  });
}
test('video playback failure stops tracks and exposes retry message', async () => {
  const h = cameraHarness();
  h.$('#scan-video').play = () => Promise.reject(Error('Playback blocked'));
  await h.openCamera();
  assert.equal(h.stops(), 1); assert.equal(h.timers.size, 0);
  assert.match(h.$('#scan-status').textContent, /preview could not start/);
});
test('late video playback failure cannot disrupt a newer camera request', async () => {
  const h = cameraHarness(); let rejectPlay;
  h.$('#scan-video').play = () => new Promise((_, reject) => { rejectPlay = reject; });
  await h.openCamera();
  await h.$('#scan-cancel-camera').emit('click');
  h.$('#scan-video').play = () => Promise.resolve();
  const newer = h.$('#scan-camera').emit('click'); h.resolveCamera(); await newer;
  rejectPlay(Error('Old playback failed')); await Promise.resolve();
  assert.equal(h.stops(), 1); assert.equal(h.$('#scan-controls').hidden, false);
});

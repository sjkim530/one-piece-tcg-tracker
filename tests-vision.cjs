/* Visual scanner format, retrieval, geometry and worker-lifecycle checks.
   Run node tests-vision.cjs. Real OpenCV/photo benchmarks are separate. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');

function workerHarness() {
  const messages = [], intervals = new Map(), timers = new Map(); let sequence = 0;
  const context = { console, URL, AbortController, Uint8Array, Uint16Array, Uint32Array, DataView,
    setTimeout(fn, ms) { timers.set(++sequence, { fn, ms }); return sequence; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { intervals.set(++sequence, fn); return sequence; }, clearInterval(id) { intervals.delete(id); },
    importScripts() {}, postMessage: message => messages.push(message) };
  context.self = context;
  vm.createContext(context); vm.runInContext(read('scan-vision-worker.js'), context);
  const evaluate = source => vm.runInContext(source, context);
  const api = evaluate('({parseIndex,hash,buildTables,descriptorDistance,shortlist,projectedCard,portraitQuad,foregroundSeparation,matchingResult})');
  return { context, messages, timers, intervals, api, evaluate };
}
function fixture() {
  const buffer = new ArrayBuffer(4 * 36), bytes = new Uint8Array(buffer);
  for (let feature = 0; feature < 4; feature++) for (let n = 0; n < 32; n++) bytes[feature * 36 + n] = feature < 2 ? n * 7 % 256 : 255;
  return { buffer, manifest: { version: 1, descriptorBytes: 32, recordBytes: 36, byteLength: buffer.byteLength,
    cards: [{ id: 'correct', offset: 0, count: 2, width: 301, height: 420 }, { id: 'other', offset: 2, count: 2, width: 301, height: 420 }] } };
}
test('compact index validates entry bounds and feature ownership', () => {
  const h = workerHarness(), { buffer, manifest } = fixture();
  const index = h.api.parseIndex(manifest, buffer);
  assert.equal(index.total, 4); assert.deepEqual([...index.owners], [0, 0, 1, 1]);
  for (const mutate of [
    m => { m.version = 2; }, m => { m.cards[1].offset = 0; }, m => { m.cards[0].count = 99; },
    m => { m.cards[1].id = 'correct'; }, m => { m.cards[0].width = 0; }, m => { m.byteLength++; }
  ]) {
    const bad = structuredClone(manifest); mutate(bad);
    assert.throws(() => h.api.parseIndex(bad, buffer));
  }
});
test('hash collisions require full-descriptor agreement before shortlisting', async () => {
  const h = workerHarness(), { buffer, manifest } = fixture();
  const bytes = new Uint8Array(buffer);
  // The wrong entry shares every 16-bit hash but disagrees on the other bits.
  for (let f = 2; f < 4; f++) for (let table = 0; table < 8; table++) {
    bytes[f * 36 + table * 4] = bytes[table * 4]; bytes[f * 36 + table * 4 + 1] = bytes[table * 4 + 1];
    bytes[f * 36 + table * 4 + 2] = bytes[table * 4 + 2] ^ 255; bytes[f * 36 + table * 4 + 3] = bytes[table * 4 + 3] ^ 255;
  }
  const index = h.api.parseIndex(manifest, buffer);
  const building = h.api.buildTables(index);
  for (let n = 0; n < 8; n++) {
    await Promise.resolve();
    const timer = [...h.timers.entries()].find(([, timer]) => timer.ms === 0);
    assert.ok(timer); h.timers.delete(timer[0]); timer[1].fn();
  }
  await building;
  const query = { rows: 1, data: bytes.slice(0, 32) };
  assert.equal(h.api.descriptorDistance(query.data, 0, index.bytes, 2), 128);
  const ranked = h.api.shortlist(query, index);
  assert.equal(ranked.length, 1); assert.equal(ranked[0].card, 0);
});
test('homography must project a finite, convex, plausible card inside the image', () => {
  const { api } = workerHarness(), card = { width: 301, height: 420 };
  const good = { data64F: new Float64Array([1, 0, 50, 0, 1, 60, 0, 0, 1]) };
  assert.equal(api.projectedCard(good, card, 600, 800).length, 4);
  for (const values of [
    [1, 0, 5000, 0, 1, 60, 0, 0, 1], [.01, 0, 50, 0, .01, 60, 0, 0, 1],
    [8, 0, 50, 0, .1, 60, 0, 0, 1], [NaN, 0, 50, 0, 1, 60, 0, 0, 1],
    [1, 0, 50, 0, 1, 60, 0, 0, 0]
  ]) assert.equal(api.projectedCard({ data64F: new Float64Array(values) }, card, 600, 800), null);
});
test('foreground evidence rejects uniform repeating material despite a rectangular line proposal', () => {
  const { api } = workerHarness(), width = 100, height = 140;
  const quad = [{ x: .2, y: .2 }, { x: .8, y: .2 }, { x: .8, y: .8 }, { x: .2, y: .8 }];
  const image = distinct => {
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const value = distinct && x >= 20 && x < 80 && y >= 28 && y < 112 ? 210 : 40;
      const at = (y * width + x) * 4; pixels[at] = pixels[at + 1] = pixels[at + 2] = value; pixels[at + 3] = 255;
    }
    return { width, height, buffer: pixels.buffer };
  };
  assert.equal(api.foregroundSeparation(image(false), quad), 0);
  assert.ok(api.foregroundSeparation(image(true), quad) > .9);
});

test('rectification keeps portrait proportions regardless of contour start or winding', () => {
  const { api } = workerHarness();
  for (const points of [
    [{ x: 20, y: 10 }, { x: 80, y: 10 }, { x: 80, y: 100 }, { x: 20, y: 100 }],
    [{ x: 20, y: 100 }, { x: 80, y: 100 }, { x: 80, y: 10 }, { x: 20, y: 10 }],
    [{ x: 10, y: 80 }, { x: 100, y: 80 }, { x: 100, y: 20 }, { x: 10, y: 20 }]
  ]) {
    const copy = JSON.stringify(points), ordered = api.portraitQuad(points);
    const width = Math.hypot(ordered[0].x - ordered[1].x, ordered[0].y - ordered[1].y);
    const height = Math.hypot(ordered[1].x - ordered[2].x, ordered[1].y - ordered[2].y);
    assert.equal(width, 60); assert.equal(height, 90); assert.equal(JSON.stringify(points), copy);
  }
});
test('weak text/clumped candidates cannot outrank verified artwork or leak into its list', () => {
  const { api } = workerHarness();
  const good = { id: 'art', score: 30, inliers: 12, artInliers: 5, coverage: .4, ratio: .7 };
  const weak = { id: 'wrong', score: 1000, inliers: 30, artInliers: 20, coverage: .02, ratio: .9 };
  const result = api.matchingResult([weak, good]);
  assert.equal(result.confident, true); assert.deepEqual(Array.from(result.candidates.map(item => item.id)), ['art']);
  assert.equal(api.matchingResult([weak]).candidates.length, 0);
});
test('identical artwork aliases stay ambiguous and all products remain available', () => {
  const { api } = workerHarness(), aliases = Array.from({ length: 21 }, (_, n) => String(n + 2));
  const result = api.matchingResult([{ id: 1, aliases, score: 40, inliers: 16, artInliers: 8, coverage: .5, ratio: .9 }]);
  assert.equal(result.confident, true); assert.equal(result.reason, 'similar-printings');
  assert.equal(result.candidates.length, 22); assert.equal(result.candidates[21].id, '22');
});
test('late cancel messages do not accumulate state after a completed request', async () => {
  const h = workerHarness();
  for (let id = 0; id < 100; id++) await h.context.onmessage({ data: { type: 'cancel', id } });
  assert.equal(h.evaluate('cancelled.size'), 0); assert.equal(h.evaluate('active.size'), 0);
});
test('analysis queue is bounded and cancelling a waiting request releases its slot', async () => {
  const h = workerHarness();
  const first = h.context.onmessage({ data: { type: 'analyze', id: 1, image: {} } });
  await h.context.onmessage({ data: { type: 'analyze', id: 2, image: {} } });
  assert.match(h.messages.find(message => message.id === 2).error, /busy/);
  await h.context.onmessage({ data: { type: 'cancel', id: 1 } });
  const third = h.context.onmessage({ data: { type: 'analyze', id: 3, image: {} } });
  h.context.cv = { Mat() {}, ORB() {} };
  for (const callback of h.intervals.values()) callback();
  await first; await third;
  assert.equal(h.evaluate('active.size'), 0); assert.equal(h.evaluate('cancelled.size'), 0);
  assert.ok(!h.messages.some(message => message.id === 1 && message.result));
  assert.ok(h.messages.some(message => message.id === 3 && /Invalid camera image/.test(message.error)));
});

function clientHarness() {
  const workers = [], timers = new Map(); let sequence = 0;
  class FakeWorker {
    constructor(url) { this.url = String(url); this.messages = []; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.stopped = true; }
    reply(id, result) { this.onmessage({ data: { id, result } }); }
  }
  const context = { URL, Worker: FakeWorker, DOMException, console,
    setTimeout(fn, ms) { timers.set(++sequence, { fn, ms }); return sequence; }, clearTimeout(id) { timers.delete(id); },
    document: { baseURI: 'https://example.test/app/index.html', createElement() {
      const canvas = { width: 1, height: 1 }; canvas.getContext = () => ({ drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }) }); return canvas;
    } }
  };
  vm.createContext(context); vm.runInContext(read('scan-vision.js') + '\nglobalThis.api = OQ_VISION;', context);
  return { api: context.api, workers, timers };
}
test('client separates cold preparation from bounded warm matching and removes abort listeners', async () => {
  const h = clientHarness(), loading = h.api.preload(), worker = h.workers[0];
  assert.ok([...h.timers.values()].some(timer => timer.ms === 90000));
  worker.reply(worker.messages[0].id, { cards: 100, indexVersion: 1 }); await loading;
  const controller = new AbortController(), matching = h.api.match({ width: 100, height: 140 }, { signal: controller.signal });
  assert.equal(worker.messages.at(-1).type, 'match');
  assert.ok([...h.timers.values()].some(timer => timer.ms === 12000));
  worker.reply(worker.messages.at(-1).id, { confident: true }); await matching;
  const count = worker.messages.length; controller.abort(); assert.equal(worker.messages.length, count);
  assert.equal(h.timers.size, 0);
});
test('camera cancellation rejects its request without terminating cached worker/model', async () => {
  const h = clientHarness(), controller = new AbortController();
  const pending = h.api.analyze({ width: 100, height: 140 }, { signal: controller.signal }), worker = h.workers[0];
  controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(worker.messages.at(-1).type, 'cancel'); assert.equal(worker.stopped, undefined); assert.equal(h.timers.size, 0);
});
test('worker failure rejects requests and the next attempt can initialize a fresh worker', async () => {
  const h = clientHarness(), first = h.api.preload(); h.workers[0].onerror();
  await assert.rejects(first, /stopped/); assert.equal(h.workers[0].stopped, true);
  const second = h.api.preload(), worker = h.workers[1];
  worker.reply(worker.messages[0].id, { cards: 100 }); await second;
  assert.equal(h.workers.length, 2); assert.equal(h.timers.size, 0);
});

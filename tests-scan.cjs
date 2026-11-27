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

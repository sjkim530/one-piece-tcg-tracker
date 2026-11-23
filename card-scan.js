/* OCR and image processing run in the browser. No image is persisted or uploaded. */
const OQ_SCAN = (() => {
  'use strict';

  const cdn = 'https://cdn.jsdelivr.net/npm/';
  const runtime = cdn + 'tesseract.js@6.0.1/dist/';
  let library;

  function loadOCR() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!library) {
      library = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = runtime + 'tesseract.min.js';
        script.onload = () => resolve(window.Tesseract);
        script.onerror = () => { script.remove(); reject(new Error('OCR download failed')); };
        document.head.append(script);
      }).catch(error => { library = null; throw error; });
    }
    return library;
  }

  const normalize = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  function readNumbers(text, knownNumbers, anchored = false) {
    const numbers = new Set();
    const boundary = anchored ? '^' : String.raw`\b`;
    const separator = String.raw`[ \t]*[-–—:·.]?[ \t]*`;
    // OCR can join the rarity box or block icon to the three-digit serial.
    // A misread rarity box can look like M immediately before the round icon.
    const end = String.raw`(?=$|[^A-Z\d]|(?:SEC|SR|SP|TR|UC|PR|[CRL])?[0-9OIL]?\b|M(?=[ \t]+[©®○◯]))`;
    const numbered = new RegExp(boundary + String.raw`([O0]P|ST|EB|PRB)${separator}([0-9OIL]{2})${separator}([0-9OIL]{3})${end}`, 'gi');
    const promos = new RegExp(boundary + String.raw`P${separator}([0-9OIL]{3})${end}`, 'gi');
    const digits = value => value.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
    for (const [, prefix, set, number] of text.matchAll(numbered)) {
      numbers.add(prefix.toUpperCase().replace(/^0/, 'O') + digits(set + number));
    }
    for (const [, number] of text.matchAll(promos)) numbers.add('P' + digits(number));
    // The rarity box/block symbol can become 88 or 8N immediately after the
    // serial. Recover only these observed suffixes and only a catalog number.
    if (knownNumbers?.size) {
      const glued = new RegExp(boundary + String.raw`([O0]P|ST|EB|PRB)${separator}([0-9OIL]{2})${separator}([0-9OIL]{3})(?:88|80|8O|8N|8R|B8|BN)(?=$|[^A-Z\d])`, 'gi');
      for (const [, prefix, set, number] of text.matchAll(glued)) {
        const code = prefix.toUpperCase().replace(/^0/, 'O') + digits(set + number);
        if (knownNumbers.has(code)) numbers.add(code);
      }
    }
    return [...numbers];
  }

  function picture(source, dimensions, region, scale = 1) {
    const { width, height } = dimensions;
    const [x, y, w, h] = region;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * w * scale));
    canvas.height = Math.max(1, Math.round(height * h * scale));
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(source, x * width, y * height,
      w * width, h * height, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  // Full-frame checks reject only gross unusable exposure. OCR, rather
  // than an assumed card border, decides whether a card is present.
  function analyzeFrame({ data, width, height }) {
    const fingerprint = [];
    let light = 0, count = 0;
    for (let y = 0; y < 18; y++) for (let x = 0; x < 12; x++) {
      const px = Math.min(width - 1, Math.round((.08 + .84 * x / 11) * width));
      const py = Math.min(height - 1, Math.round((.08 + .84 * y / 17) * height));
      const i = 4 * (py * width + px);
      const value = .299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2];
      fingerprint.push(value); light += value; count++;
    }
    const brightness = light / count;
    if (brightness < 25) return { state: 'dark', message: 'Add more light so the card text is visible', fingerprint, brightness };
    if (brightness > 248) return { state: 'bright', message: 'Reduce bright reflections so the card text is visible', fingerprint, brightness };
    return { state: 'ready', message: 'Keep one card visible anywhere in the camera view', fingerprint, brightness };
  }

  // Look only beside a catalog-matched code, using the OCR boxes from
  // these exact pixels. A positive means a visible printing star; no match
  // means unknown, not proof that this is the regular printing.
  function detectPrintingStar(canvas, data, numbers) {
    if (numbers.length !== 1) return null;
    const lines = [];
    for (const block of data.blocks || []) for (const paragraph of block.paragraphs || []) {
      lines.push(...(paragraph.lines || []));
    }
    if (data.words?.length) lines.push({ words: data.words });
    const anchors = [];
    const known = new Set(numbers);
    for (const line of lines) {
      const words = line.words || [];
      for (let i = 0; i < words.length; i++) for (let n = 1; n <= 3 && i + n <= words.length; n++) {
        const run = words.slice(i, i + n), text = run.map(word => word.text).join(' ');
        // Reuse the canonical code parser so O/I/L digit confusions are
        // handled identically. Anchor at the start to exclude unrelated text
        // or a later valid code following a malformed leading token.
        if (!readNumbers(text.trim(), known, true).some(number => known.has(number))) continue;
        if (/[★☆✦]/u.test(text)) return true;
        const boxes = run.map(word => word.bbox).filter(box => box && box.x1 > box.x0 && box.y1 > box.y0);
        if (boxes.length !== run.length) continue;
        anchors.push({ x0: Math.min(...boxes.map(box => box.x0)), y0: Math.min(...boxes.map(box => box.y0)),
          x1: Math.max(...boxes.map(box => box.x1)), y1: Math.max(...boxes.map(box => box.y1)) });
        break;
      }
    }
    if (!anchors.length) return null;
    const { width, height } = canvas;
    let pixels;
    try { pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data; }
    catch (_) { return null; }
    const vertices = Array.from({ length: 10 }, (_, i) => {
      const angle = i * Math.PI / 5 - Math.PI / 2, radius = i % 2 ? .43 : 1;
      return [Math.cos(angle) * radius, Math.sin(angle) * radius];
    });
    const inside = [], outside = [];
    for (let y = -11; y <= 11; y += 2) for (let x = -11; x <= 11; x += 2) {
      let filled = false;
      for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const [ax, ay] = vertices[i], [bx, by] = vertices[j];
        if ((ay > y / 10) !== (by > y / 10) && x / 10 < (bx - ax) * (y / 10 - ay) / (by - ay) + ax) filled = !filled;
      }
      (filled ? inside : outside).push([x / 10, y / 10]);
    }
    for (const box of anchors) {
      const h = box.y1 - box.y0, w = box.x1 - box.x0;
      // OCR often merges the number, rarity box and block icon. The star can
      // be inside that merged word's upper-right area, not outside its end.
      for (const fraction of [.14, .18, .22, .26, .30, .34, .38, .42]) {
        const radius = Math.max(2, h * fraction), step = Math.max(1, radius / 4);
        for (let y = Math.max(radius * 1.2, box.y0 - h); y <= Math.min(height - radius * 1.2, box.y0 + h * .6); y += step) {
          for (let x = Math.max(radius * 1.2, box.x0 + w * .5); x <= Math.min(width - radius * 1.2, box.x1 + h * .5); x += step) {
            let sum = 0, square = 0, difference = 0;
            for (const [points, sign] of [[inside, 1], [outside, -1]]) {
              let group = 0;
              for (const [dx, dy] of points) {
                const i = 4 * (Math.round(y + dy * radius) * width + Math.round(x + dx * radius));
                const value = .299 * pixels[i] + .587 * pixels[i + 1] + .114 * pixels[i + 2];
                group += value; square += value * value;
              }
              sum += group; difference += sign * group / points.length;
            }
            const count = inside.length + outside.length;
            const variance = square / count - (sum / count) ** 2;
            const correlation = Math.abs(difference) * Math.sqrt(inside.length * outside.length) / count / Math.sqrt(variance);
            if (Math.abs(difference) >= 45 && correlation >= .70) return true;
          }
        }
      }
    }
    return null;
  }

  function applyStarEvidence(evidence, starred, { isStarred, cards = [] } = {}) {
    if (starred !== true || evidence.numbers.length !== 1) return { ...evidence, starred: null };
    const byId = new Map(cards.map(card => [String(card.id), card]));
    const compatible = isStarred ? evidence.candidates.filter(candidate => byId.has(candidate.id) && isStarred(byId.get(candidate.id))) : [];
    return { ...evidence, starred: true,
      candidates: compatible.length ? compatible : evidence.candidates,
      totalCandidates: compatible.length || evidence.totalCandidates };
  }

  function boostNumberContrast(canvas) {
    const ctx = canvas.getContext('2d');
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = image;
    for (let i = 0; i < data.length; i += 4) {
      const light = .299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2];
      const gray = 255 - Math.max(0, Math.min(255, (light - 95) * 2.2));
      data[i] = data[i + 1] = data[i + 2] = gray;
    }
    ctx.putImageData(image, 0, 0);
  }

  const textWords = value => String(value || '').normalize('NFKD').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim();
  const baseName = value => textWords(String(value || '').replace(/\([^)]*\)/g, '')
    .replace(/\s*-\s*(?:OP|ST|EB|PRB)\d{2}-\d{3}.*$/i, ''));

  function resolveEvidence(text, { cards = [], knownNumbers } = {}) {
    const known = knownNumbers || new Set(cards.map(card => normalize(card.card_set_id)));
    const read = readNumbers(text, known);
    const numbers = read.filter(number => !known.size || known.has(number));
    const all = textWords(text), padded = ' ' + all + ' ';
    const lines = String(text).split(/[\r\n]+/).map(textWords);
    let candidates = [];
    if (numbers.length) {
      candidates = cards.filter(card => numbers.includes(normalize(card.card_set_id)))
        .map(card => ({ id: String(card.id), name: baseName(card.card_name), strong: true, score: 100 }));
    } else {
      for (const card of cards) {
        const name = baseName(card.card_name);
        if (name.length < 3 || !padded.includes(' ' + name + ' ')) continue;
        const exactLine = lines.includes(name);
        // Short names must be actual OCR lines, never mentions in another
        // card's rules. Two independent probes can confirm a weaker name.
        if ((name.length <= 5 || !name.includes(' ')) && !exactLine) continue;
        const power = String(card.power || '').replace(/[^0-9]/g, '');
        const powerMatch = power.length >= 4 && padded.includes(' ' + power + ' ');
        const ruleWords = [...new Set(textWords(card.rulesText).split(' ').filter(word => word.length >= 5))];
        const ruleHits = ruleWords.filter(word => padded.includes(' ' + word + ' ')).length;
        const cardContext = /\b(?:CHARACTER|LEADER|STAGE|EVENT|COUNTER|ON PLAY|YOUR TURN)\b/.test(all);
        const strong = exactLine && (powerMatch || (cardContext && ruleHits >= 2));
        candidates.push({ id: String(card.id), name, strong, score: (exactLine ? 20 : 5) + (strong ? 30 : 0) + Math.min(5, ruleHits) });
      }
      candidates.sort((a, b) => b.score - a.score);
    }
    const names = [...new Set(candidates.map(candidate => candidate.name))];
    return { numbers, readNumbers: read, candidates, totalCandidates: candidates.length,
      recoveredNumbers: numbers.filter(number => !readNumbers(text).includes(number)),
      name: names.length === 1 ? names[0] : null,
      strongName: names.length === 1 && candidates.some(candidate => candidate.strong),
      starred: null };
  }

  function createRecognizer(signal, progress = () => {}, options = {}) {
    let worker, starting, closed = false, busy = false, rejectCancelled;
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
    cancelled.catch(() => {});
    function close() {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', close);
      rejectCancelled(new DOMException('Scan cancelled', 'AbortError'));
      if (worker) Promise.resolve(worker.terminate()).catch(() => {});
    }
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) close();
    const race = task => Promise.race([task, cancelled]);
    async function getWorker() {
      if (!starting) starting = (async () => {
        const ocr = await race(loadOCR());
        const next = await ocr.createWorker('eng', 1, {
          workerPath: runtime + 'worker.min.js', corePath: cdn + 'tesseract.js-core@6.0.0',
          langPath: cdn + '@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
          logger: message => { if (!closed) progress(message.status); }
        });
        if (closed) { await next.terminate(); throw new DOMException('Scan cancelled', 'AbortError'); }
        worker = next;
        return worker;
      })();
      return race(starting);
    }
    async function recognize(frame, { probe = false } = {}) {
      if (closed) throw new DOMException('Scan cancelled', 'AbortError');
      if (busy) throw new Error('A scan is already running');
      busy = true;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new Error('Scan timed out')); close(); }, 65000);
      });
      const run = task => Promise.race([race(task), timeout]);
      let text = '';
      try {
        const ocr = await run(getWorker());
        // Full-frame first finds names wherever the card lies. Overlapping
        // tiles then magnify small card numbers without assuming card edges.
        const regions = probe ? [
          [[0, 0, 1, 1], 1400, '11'], [[0, 0, 1, .6], 1800, '11'], [[0, .4, 1, .6], 1800, '11']
        ] : [
          [[0, 0, 1, 1], 1800, '11'], [[0, 0, 1, .6], 2100, '11'], [[0, .4, 1, .6], 2100, '11'],
          [[0, .65, 1, .35], 2400, '6'], [[.35, .45, .65, .55], 1800, '11'],
          [[0, 0, 1, 1], 1800, '6']
        ];
        let evidence = resolveEvidence('', options);
        for (let i = 0; i < regions.length; i++) {
          const [region, maxSide, mode] = regions[i];
          const scale = Math.min(3, maxSide / Math.max(frame.width * region[2], frame.height * region[3]));
          const crop = picture(frame, frame, region, scale);
          try {
            await run(ocr.setParameters({ tessedit_pageseg_mode: mode, preserve_interword_spaces: '1' }));
            const result = await run(ocr.recognize(crop, {}, { text: true, blocks: true }));
            text += '\n' + result.data.text;
            evidence = resolveEvidence(text, options);
            if (evidence.numbers.length) return applyStarEvidence(evidence, detectPrintingStar(crop, result.data, evidence.numbers), options);
            if (probe && evidence.name && evidence.strongName) return evidence;
            if (!probe && i > 0 && !evidence.numbers.length) {
              const original = picture(crop, crop, [0, 0, 1, 1]);
              try {
                boostNumberContrast(crop);
                const enhanced = await run(ocr.recognize(crop, {}, { text: true, blocks: true }));
                text += '\n' + enhanced.data.text;
                evidence = resolveEvidence(text, options);
                if (evidence.numbers.length) return applyStarEvidence(evidence, detectPrintingStar(original, enhanced.data, evidence.numbers), options);
              } finally { original.width = original.height = 0; }
            }
          } finally { crop.width = crop.height = 0; }
        }
        return evidence;
      } finally {
        clearTimeout(timer);
        busy = false;
      }
    }
    return { recognize, close };
  }

  async function recognize(frame, signal, progress, options = {}) {
    const session = createRecognizer(signal, progress, options);
    try { return await session.recognize(frame); }
    finally { session.close(); }
  }

  return { normalize, readNumbers, picture, recognize, analyzeFrame, resolveEvidence, createRecognizer, detectPrintingStar, applyStarEvidence };
})();

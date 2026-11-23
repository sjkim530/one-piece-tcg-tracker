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

  function readNumbers(text, knownNumbers) {
    const numbers = new Set();
    const separator = String.raw`[ \t]*[-–—:·.]?[ \t]*`;
    // OCR can join the rarity box or block icon to the three-digit serial.
    // A misread rarity box can look like M immediately before the round icon.
    const end = String.raw`(?=$|[^A-Z\d]|(?:SEC|SR|SP|TR|UC|PR|[CRL])?[0-9OIL]?\b|M(?=[ \t]+[©®○◯]))`;
    const numbered = new RegExp(String.raw`\b([O0]P|ST|EB|PRB)${separator}([0-9OIL]{2})${separator}([0-9OIL]{3})${end}`, 'gi');
    const promos = new RegExp(String.raw`\bP${separator}([0-9OIL]{3})${end}`, 'gi');
    const digits = value => value.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
    for (const [, prefix, set, number] of text.matchAll(numbered)) {
      numbers.add(prefix.toUpperCase().replace(/^0/, 'O') + digits(set + number));
    }
    for (const [, number] of text.matchAll(promos)) numbers.add('P' + digits(number));
    // The rarity box/block symbol can become 88 or 8N immediately after the
    // serial. Recover only these observed suffixes and only a catalog number.
    if (knownNumbers?.size) {
      const glued = new RegExp(String.raw`\b([O0]P|ST|EB|PRB)${separator}([0-9OIL]{2})${separator}([0-9OIL]{3})(?:88|8N|8R|B8|BN)(?=$|[^A-Z\d])`, 'gi');
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

  // Full-frame checks reject only gross exposure or movement. OCR, rather
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
    return { state: 'ready', message: 'Hold the card steady anywhere in the camera view', fingerprint, brightness };
  }

  function createCaptureGate() {
    let previous, since, last, frames = 0, captured = false;
    function reset() { previous = undefined; since = last = undefined; frames = 0; captured = false; }
    function update(quality, now, enabled = true) {
      const hadPrevious = !!previous;
      const motion = previous && previous.length === quality.fingerprint.length
        ? quality.fingerprint.reduce((sum, value, i) => sum + Math.abs(value - previous[i]), 0) / previous.length : Infinity;
      previous = quality.fingerprint;
      // Analysis + scheduling can take 400–600 ms on a phone. Do not treat
      // ordinary slower preview cadence as a suspension. Five distinct
      // samples are still required; a genuinely long interruption resets.
      const fresh = last !== now;
      if (!enabled || quality.state !== 'ready' || motion > 6 || last == null || now - last > 1200 || now < last) {
        since = undefined; frames = 0;
      }
      last = now;
      if (quality.state !== 'ready') return { capture: false, message: quality.message, state: quality.state };
      if (!enabled) return { capture: false, message: 'Auto capture off · Tap Scan card when ready', state: 'manual' };
      if (motion > 6) return { capture: false, message: 'Hold steady', state: hadPrevious ? 'moving' : 'steady' };
      // Keep tracking motion while an OCR probe is running. Readiness is
      // latched, but movement must still invalidate that probe's evidence.
      if (captured) return { capture: false, message: 'Scanning…', state: 'capturing' };
      if (!fresh) return { capture: false, message: 'Hold steady · Getting ready to scan', state: 'steady' };
      if (since == null) since = now;
      frames++;
      captured = now - since >= 800 && frames >= 5;
      return { capture: captured, message: captured ? 'Scanning…' : 'Hold steady · Getting ready to scan', state: captured ? 'capturing' : 'steady' };
    }
    return { reset, update };
  }

  // Compare a five-point silhouette in either contrast polarity. A weak
  // match leaves the printing order alone, and every candidate stays visible.
  function hasStar(canvas) {
    const { width, height } = canvas;
    const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const vertices = Array.from({ length: 10 }, (_, i) => {
      const angle = i * Math.PI / 5 - Math.PI / 2;
      const radius = i % 2 ? .43 : 1;
      return [Math.cos(angle) * radius, Math.sin(angle) * radius];
    });
    const inside = [], outside = [];
    for (let y = -11; y <= 11; y += 2) {
      for (let x = -11; x <= 11; x += 2) {
        let filled = false;
        for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
          const [ax, ay] = vertices[i];
          const [bx, by] = vertices[j];
          if ((ay > y / 10) !== (by > y / 10) &&
              x / 10 < (bx - ax) * (y / 10 - ay) / (by - ay) + ax) filled = !filled;
        }
        (filled ? inside : outside).push([x / 10, y / 10]);
      }
    }
    for (const fraction of [.008, .011, .0133, .016, .019]) {
      const radius = Math.max(3, width * fraction);
      const step = Math.max(1, Math.floor(radius / 4));
      for (let y = height * .72; y < height - radius * 1.3; y += step) {
        for (let x = width * .68; x < width - radius * 1.3; x += step) {
          let sum = 0, square = 0, difference = 0;
          for (const [points, sign] of [[inside, 1], [outside, -1]]) {
            let group = 0;
            for (const [dx, dy] of points) {
              const i = 4 * (Math.round(y + dy * radius) * width + Math.round(x + dx * radius));
              const value = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
              group += value;
              square += value * value;
            }
            sum += group;
            difference += sign * group / points.length;
          }
          const samples = inside.length + outside.length;
          const variance = square / samples - (sum / samples) ** 2;
          const correlation = Math.abs(difference) * Math.sqrt(inside.length * outside.length) / samples / Math.sqrt(variance);
          if (Math.abs(difference) > 70 && correlation > .81) return true;
        }
      }
    }
    return false;
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
      starred: /[★☆✦]/u.test(text) };
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
            const result = await run(ocr.recognize(crop));
            text += '\n' + result.data.text;
            evidence = resolveEvidence(text, options);
            if (evidence.numbers.length || (probe && evidence.name && evidence.strongName)) return evidence;
            if (!probe && i > 0 && !evidence.numbers.length) {
              boostNumberContrast(crop);
              const enhanced = await run(ocr.recognize(crop));
              text += '\n' + enhanced.data.text;
              evidence = resolveEvidence(text, options);
              if (evidence.numbers.length) return evidence;
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

  return { normalize, readNumbers, picture, recognize, analyzeFrame, createCaptureGate, resolveEvidence, createRecognizer };
})();

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

  function readNumbers(text) {
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

  async function recognize(frame, signal, progress, { photo = false, knownNumbers } = {}) {
    let worker;
    let timer;
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(new DOMException('Scan cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new Error('Scan timed out')), 65000);
    });
    let stopped = false;
    interrupted.catch(() => {});
    const race = task => Promise.race([task, interrupted]);
    try {
      if (signal.aborted) throw signal.reason;
      const ocr = await race(loadOCR());
      worker = await race(new Promise((resolve, reject) => {
        ocr.createWorker('eng', 1, {
          workerPath: runtime + 'worker.min.js',
          corePath: cdn + 'tesseract.js-core@6.0.0',
          langPath: cdn + '@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
          logger: message => { if (!stopped) progress(message.status); },
          errorHandler: reject
        }).then(instance => {
          if (stopped) instance.terminate();
          else resolve(instance);
        }, reject);
      }));
      const footer = [.52, .84, .47, .155];
      const portraitPhoto = [.58, .745, .27, .08];
      const broadCorner = [.38, .63, .61, .36];
      const crops = photo ? [portraitPhoto, footer, broadCorner] : [footer, broadCorner];
      async function match(canvas) {
        const { data } = await race(worker.recognize(canvas, { tessedit_pageseg_mode: '11' }));
        const numbers = readNumbers(data.text).filter(number => !knownNumbers || knownNumbers.has(number));
        return { numbers, starred: /[★☆✦]/u.test(data.text) };
      }
      function finish(result) {
        if (result.starred || !result.numbers.length) return result;
        if (!photo) return { ...result, starred: hasStar(frame) };
        const sample = picture(frame, frame, [0, 0, 1, 1], Math.min(1, 1600 / Math.max(frame.width, frame.height)));
        try {
          return { ...result, starred: hasStar(sample) };
        } finally {
          sample.width = sample.height = 0;
        }
      }
      for (const [i, region] of crops.entries()) {
        const scale = Math.min(3, 1050 / (frame.width * region[2]));
        const crop = picture(frame, frame, region, scale);
        try {
          const result = await match(crop);
          if (result.numbers.length) return finish(result);
          if (i < crops.length - 1) {
            boostNumberContrast(crop);
            const enhanced = await match(crop);
            if (enhanced.numbers.length) return finish(enhanced);
          }
        } finally {
          crop.width = crop.height = 0;
        }
      }
      const full = picture(frame, frame, [0, 0, 1, 1], Math.min(1, 1800 / Math.max(frame.width, frame.height)));
      try {
        return finish(await match(full));
      } finally {
        full.width = full.height = 0;
      }
    } finally {
      stopped = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      await worker?.terminate();
    }
  }

  return { normalize, readNumbers, picture, recognize };
})();

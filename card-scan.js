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
    const pattern = /\b([O0]P|ST|EB|PRB|P)\s*[-–]?\s*([0-9OIL]{2,3})(?:[\s\-–]+([0-9OIL]{3}))?\b/gi;
    const digits = value => value.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
    for (const [, rawPrefix, first, last] of text.matchAll(pattern)) {
      const prefix = rawPrefix.toUpperCase().replace(/^0/, 'O');
      if (prefix === 'P') {
        if (first.length === 3) numbers.add('P' + digits(first));
      } else if (last && first.length === 2) numbers.add(prefix + digits(first) + digits(last));
    }
    // OCR sometimes drops the separator entirely.
    for (const [, prefix, suffix] of text.toUpperCase().matchAll(/\b([O0]P|ST|EB|PRB)([0-9OIL]{5})\b/g)) {
      numbers.add(prefix.replace(/^0/, 'O') + digits(suffix));
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

  async function recognize(frame, signal, progress) {
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
      const scale = Math.min(2, Math.max(1, 1400 / frame.width));
      const corner = picture(frame, frame, [.39, .62, .61, .38], scale);
      try {
        const { data } = await race(worker.recognize(corner, { tessedit_pageseg_mode: '11' }));
        let numbers = readNumbers(data.text);
        if (!numbers.length) {
          const full = await race(worker.recognize(frame, { tessedit_pageseg_mode: '11' }));
          numbers = readNumbers(full.data.text);
        }
        return { numbers, starred: numbers.length > 0 && (/[★☆✦]/u.test(data.text) || hasStar(frame)) };
      } finally {
        corner.width = corner.height = 0;
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

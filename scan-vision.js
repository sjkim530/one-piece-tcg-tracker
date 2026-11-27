/* On-device visual matching. Reference features are static public data;
   camera pixels are transferred only to this app's local worker. */
const OQ_VISION = (() => {
  'use strict';
  const workerUrl = new URL('scan-vision-worker.js?v=3.9.0', document.baseURI);
  let worker, nextId = 0, runtimeReady = false, indexReadyUrl = null;
  const pending = new Map();

  function connect() {
    if (worker) return worker;
    if (typeof Worker !== 'function') throw new Error('Visual matching is unavailable in this browser');
    worker = new Worker(workerUrl);
    worker.onmessage = ({ data }) => {
      const task = pending.get(data.id);
      if (!task) return;
      if (data.progress) {
        if (data.progress === 'index' || data.progress === 'ready') runtimeReady = true;
        task.onProgress?.(data.progress); return;
      }
      task.cleanup(); pending.delete(data.id);
      data.error ? task.reject(new Error(data.error)) : task.resolve(data.result);
    };
    worker.onerror = () => {
      for (const task of pending.values()) { task.cleanup(); task.reject(new Error('Visual scanner stopped. Please retry.')); }
      pending.clear(); worker.terminate(); worker = null; runtimeReady = false; indexReadyUrl = null;
    };
    return worker;
  }

  function request(type, payload = {}, { signal, onProgress, timeout = 60000 } = {}, transfer = []) {
    if (signal?.aborted) return Promise.reject(new DOMException('Scan cancelled', 'AbortError'));
    return new Promise((resolve, reject) => {
      let target;
      try { target = connect(); } catch (error) { reject(error); return; }
      const id = ++nextId;
      const abort = () => {
        const task = pending.get(id); if (!task) return;
        task.cleanup(); pending.delete(id); target.postMessage({ type: 'cancel', id });
        reject(new DOMException('Scan cancelled', 'AbortError'));
      };
      const timer = setTimeout(() => {
        const task = pending.get(id); if (!task) return;
        task.cleanup(); pending.delete(id); target.postMessage({ type: 'cancel', id });
        reject(new Error('Visual scanner timed out. Try again when its data has loaded.'));
      }, timeout);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      pending.set(id, { resolve, reject, cleanup, onProgress });
      signal?.addEventListener('abort', abort, { once: true });
      try { target.postMessage({ id, type, ...payload }, transfer); }
      catch (error) { cleanup(); pending.delete(id); reject(error); }
    });
  }

  function pixels(frame, maxSide) {
    const width = frame.width || frame.videoWidth, height = frame.height || frame.videoHeight;
    if (!width || !height) throw new Error('No camera frame is available');
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Image processing is unavailable');
      context.drawImage(frame, 0, 0, canvas.width, canvas.height);
      const data = context.getImageData(0, 0, canvas.width, canvas.height);
      return { width: canvas.width, height: canvas.height, buffer: data.data.buffer };
    } finally { canvas.width = canvas.height = 0; }
  }

  function preload({ indexUrl = 'scan-index/manifest.json', signal, onProgress } = {}) {
    const url = new URL(indexUrl, document.baseURI).href;
    return request('init', { indexUrl: url }, { signal, onProgress, timeout: 90000 }).then(result => {
      runtimeReady = true; indexReadyUrl = url; return result;
    });
  }
  async function analyze(frame, { signal, onProgress } = {}) {
    const image = pixels(frame, 640);
    const result = await request('analyze', { image }, { signal, onProgress, timeout: runtimeReady ? 8000 : 45000 }, [image.buffer]);
    runtimeReady = true; return result;
  }
  async function match(frame, { signal, indexUrl = 'scan-index/manifest.json', onProgress } = {}) {
    const url = new URL(indexUrl, document.baseURI).href;
    if (indexReadyUrl !== url) await preload({ indexUrl, signal, onProgress });
    const image = pixels(frame, 1000);
    return request('match', { image, indexUrl: url }, { signal, onProgress, timeout: 12000 }, [image.buffer]);
  }
  return { preload, analyze, match };
})();

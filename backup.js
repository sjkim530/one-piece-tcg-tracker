/* One portable collection file, linked to this browser with a file handle. */
const OQ_BACKUP = (() => {
  'use strict';

  const filename = 'grand-line-vault-backup.json';
  const limit = 8 * 1024 * 1024;
  const format = 'grand-line-vault';
  const fields = {
    cols: 'id name kind tradePct locked createdAt updatedAt deleted',
    items: 'id colId key oldKey printing qty cond grader grade value paid note src updatedAt deleted',
    opens: 'id setId boxes cost date updatedAt deleted',
    watch: 'key id name number set printing buy sell shipping',
    comps: 'id key sold condition price shipping itemId grader grade'
  };
  const text = value => typeof value === 'string' && value.trim() !== '';
  const key = value => (text(value) || Number.isSafeInteger(value)) &&
    !Object.hasOwn(Object.prototype, String(value)) && value !== 'prototype';
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value));
  const validators = {
    cols: row => typeof row.name === 'string' && ['keep', 'trade'].includes(row.kind),
    items: row => key(row.colId) && key(row.key) && count(row.qty) &&
      (row.printing == null || typeof row.printing === 'string'),
    opens: row => key(row.setId) && count(row.boxes) && amount(row.cost) && day(row.date),
    watch: row => key(row.id) && typeof row.printing === 'string' &&
      (count(row.buy) || count(row.sell)) && (row.buy == null || count(row.buy)) &&
      (row.sell == null || count(row.sell)) && count(row.shipping),
    comps: row => day(row.sold) && text(row.condition) &&
      count(row.price) && row.price > 0 && count(row.shipping)
  };

  function decode(raw) {
    const backup = JSON.parse(raw);
    if (backup?.format !== format || backup.version !== 1) {
      throw new Error('Choose a Grand Line Vault version 1 backup.');
    }
    const data = {};
    for (const [name, allowed] of Object.entries(fields)) {
      if (!Array.isArray(backup.data?.[name])) throw new Error('A section is missing from the backup.');
      const seen = new Set();
      data[name] = backup.data[name].map(row => {
        const id = name === 'watch' ? row?.key : row?.id;
        if (!row || Array.isArray(row) || typeof row !== 'object' || !key(id) ||
            seen.has(String(id)) || !validators[name](row) ||
            (name === 'comps' && !text(row.key))) {
          throw new Error('The backup contains an invalid or duplicate record.');
        }
        seen.add(String(id));
        const clean = {};
        for (const field of allowed.split(' ')) {
          if (!Object.hasOwn(row, field)) continue;
          const value = row[field];
          if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' &&
              !(typeof value === 'number' && Number.isFinite(value))) {
            throw new Error('The backup contains an invalid field.');
          }
          clean[field] = value;
        }
        return clean;
      });
    }
    return data;
  }

  const encode = (data, date = new Date()) =>
    JSON.stringify({ format, version: 1, savedAt: date.toISOString(), data }) + '\n';

  async function readFile(file) {
    if (file.size > limit) throw new Error('The backup file is larger than 8 MB.');
    return decode(await file.text());
  }

  function create({ read, identity, status }) {
    const supported = typeof window.showSaveFilePicker === 'function' && !!window.indexedDB &&
      !!window.crypto?.subtle;
    let database;
    let connection;
    let timer;
    let queued = Promise.resolve();
    let repairing = false;
    let refreshing;
    const checkLimit = 6000;

    function checked(work) {
      let timeout;
      return Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Automatic backup could not be checked. Download a backup to keep a copy.')), checkLimit);
      })]).finally(() => clearTimeout(timeout));
    }

    function openDatabase() {
      return database ||= new Promise((resolve, reject) => {
        const request = indexedDB.open('grand-line-vault-backup', 1);
        let finished = false;
        const fail = error => {
          if (finished) return;
          finished = true; clearTimeout(timeout); reject(error);
        };
        const timeout = setTimeout(() => fail(new Error('Backup storage did not respond. Download a backup and try again.')), checkLimit);
        request.onupgradeneeded = () => request.result.createObjectStore('settings');
        request.onsuccess = () => {
          if (finished) { request.result.close(); return; }
          finished = true; clearTimeout(timeout);
          request.result.onversionchange = () => { request.result.close(); database = null; };
          resolve(request.result);
        };
        request.onblocked = () => fail(new Error('Backup storage is blocked by another app tab. Close the other tab or download a backup.'));
        request.onerror = () => fail(request.error || new Error('Backup storage is unavailable. Download a backup instead.'));
      }).catch(error => { database = null; throw error; });
    }

    async function storedConnection(next) {
      const db = await openDatabase();
      const writing = next !== undefined;
      return new Promise((resolve, reject) => {
        const tx = db.transaction('settings', writing ? 'readwrite' : 'readonly');
        const store = tx.objectStore('settings');
        const request = writing ? store.put(next, 'backup') : store.get('backup');
        let expired = false;
        const timeout = setTimeout(() => {
          expired = true;
          try { tx.abort(); } catch { /* Already completed. */ }
          reject(new Error('Backup storage did not respond. Download a backup and try again.'));
        }, checkLimit);
        tx.oncomplete = () => { clearTimeout(timeout); if (!expired) resolve(request.result); };
        tx.onabort = () => { clearTimeout(timeout); reject(tx.error || new Error('Backup storage could not be read or saved.')); };
      });
    }

    async function digest(text) {
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > limit) throw new Error('The backup file is larger than 8 MB.');
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        byte => byte.toString(16).padStart(2, '0')).join('');
    }

    function report(state, message) {
      status({ state, message, last: connection?.last || null, filename: connection?.handle.name });
    }

    function locked(work) {
      // Cover time spent behind an earlier pending write as well as execution.
      // This changes only the status; it never releases the lock or queue.
      const watchdog = setTimeout(() => report('error', 'Automatic backup has not been confirmed. Download a backup to keep a copy.'), checkLimit + 1000);
      const execute = async () => {
        let waiting;
        try {
          if (!navigator.locks) return await work();
          const controller = new AbortController();
          waiting = setTimeout(() => controller.abort(), checkLimit);
          return await navigator.locks.request(format + '-backup', { signal: controller.signal }, async () => {
            clearTimeout(waiting);
            return work();
          });
        } finally { clearTimeout(waiting); }
      };
      return queued = queued.then(execute, execute).catch(error => {
        const needsPermission = ['NotAllowedError', 'SecurityError'].includes(error.name);
        report(needsPermission ? 'permission' : 'error', needsPermission
          ? 'Reconnect your backup file to save recent changes.'
          : error.name === 'AbortError' ? 'Another tab is using the backup file. Download a backup or close that tab and try again.'
          : error.message || 'The backup could not be updated.');
      }).finally(() => clearTimeout(watchdog));
    }

    async function flush() {
      connection = await storedConnection();
      if (!connection) {
        report('off', 'Automatic backup is off.');
        return;
      }
      const { handle } = connection;
      if (!connection.identity || connection.identity !== identity()) {
        report('error', 'This browser lost its link to the saved collection. Restore the file and choose it again.');
        return;
      }
      if (await checked(() => handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        report('permission', 'Reconnect your backup file to save recent changes.');
        return;
      }
      const data = read();
      if (!data) {
        report('error', 'This browser has no saved collection. Restore the backup file first.');
        return;
      }
      const dataHash = await checked(() => digest(JSON.stringify(data)));
      const existing = await checked(() => handle.getFile());
      if (existing.size > limit || await checked(async () => digest(await existing.text())) !== connection.fileHash) {
        report('error', 'The backup file changed or was replaced. Restore it or choose a new file.');
        return;
      }
      if (connection.dataHash !== dataHash) {
        report('saving', 'Updating backup…');
        const now = new Date();
        const contents = encode(data, now);
        const fileHash = await digest(contents);
        const writer = await handle.createWritable();
        try {
          await writer.write(contents);
          await writer.close();
        } catch (error) {
          await writer.abort().catch(() => {});
          throw error;
        }
        connection = { ...connection, dataHash, fileHash, last: now.toISOString() };
        await storedConnection(connection);
      }
      report('ready', 'Automatic backup is on.');
    }

    async function connect() {
      if (repairing) return;
      repairing = true;
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'Grand Line Vault backup', accept: { 'application/json': ['.json'] } }]
        });
        await locked(async () => {
          const collectionId = identity();
          if (!collectionId) throw new Error('Save your collection on this device before connecting a file.');
          const file = await handle.getFile();
          const data = read();
          let contents = '';
          if (file.size) {
            const mismatch = 'This file already has data. Restore it first or choose a new file.';
            if (file.size > limit || !data) throw new Error(mismatch);
            contents = await file.text();
            let same = false;
            try { same = JSON.stringify(decode(contents)) === JSON.stringify(decode(encode(data))); }
            catch { /* Only a recognized copy of the current collection can be linked. */ }
            if (!same) throw new Error(mismatch);
          }
          connection = { handle, identity: collectionId, fileHash: await digest(contents),
            last: file.size ? new Date(file.lastModified).toISOString() : null,
            dataHash: file.size ? await digest(JSON.stringify(data)) : null };
          await storedConnection(connection);
          await flush();
        });
      } catch (error) {
        if (error.name !== 'AbortError') report('error', error.message);
      } finally {
        repairing = false;
      }
    }

    async function reconnect() {
      if (!connection || repairing) return;
      repairing = true;
      try {
        await connection.handle.requestPermission({ mode: 'readwrite' });
        await locked(flush);
      } catch {
        report('permission', 'Chrome needs permission to update your backup file.');
      } finally {
        repairing = false;
      }
    }

    function change() {
      if (!supported) return;
      clearTimeout(timer);
      timer = setTimeout(() => locked(flush), 300);
    }

    function download() {
      const url = URL.createObjectURL(new Blob([encode(read())], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    function refresh() {
      if (!supported) {
        report('unsupported', 'Automatic backup is unavailable in this browser. Use Download backup to save a copy, then Restore from file when needed.');
        return Promise.resolve();
      }
      if (!refreshing) {
        report('checking', 'Checking the linked backup file. You can download a copy now.');
        refreshing = locked(flush).finally(() => { refreshing = null; });
      }
      return refreshing;
    }

    return { supported, connect, reconnect, change, download, refresh };
  }

  return { create, readFile, encode, decode };
})();

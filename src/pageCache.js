// ─────────────────────────────────────────────────────────────
// pageCache.js — IndexedDB-backed page image / PDF cache.
//
// Stores fetched page images (and PDF blobs) keyed by URL so the
// reader can serve them locally instead of hitting the network.
// Populated by the "cache" button; read by PdfPane when resolving
// <img> / PDF sources.
// ─────────────────────────────────────────────────────────────

const DB_NAME = 'pdf-reader-page-cache';
const DB_VERSION = 1;
const STORE = 'pages';

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    try {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
      request.onblocked = () => console.warn('[page-cache] IndexedDB open blocked by another connection');
    } catch (err) {
      reject(err);
    }
  });
  return _dbPromise;
}

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

/** Retrieve a cached Blob for the given URL, or null if not cached. */
export async function cacheGet(url) {
  try {
    const db = await openDb();
    const record = await requestAsPromise(db.transaction(STORE, 'readonly').objectStore(STORE).get(url));
    return record && record.blob instanceof Blob ? record.blob : null;
  } catch {
    return null;
  }
}

/** Store a Blob under the given URL key. Returns true on success. */
export async function cachePut(url, blob) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ url, blob, savedAt: Date.now() }, url);
    await txDone(tx);
    return true;
  } catch (err) {
    console.warn('[page-cache] put failed:', url, err?.message || err);
    return false;
  }
}

/** Check whether a URL is already cached. */
export async function cacheHas(url) {
  try {
    const db = await openDb();
    const record = await requestAsPromise(db.transaction(STORE, 'readonly').objectStore(STORE).get(url));
    return Boolean(record && record.blob);
  } catch {
    return false;
  }
}

/** Count how many of the given URLs are already cached. */
export async function cacheCountCached(urls) {
  const list = [...new Set((urls || []).filter(Boolean))];
  let cached = 0;
  // Sequential checks keep the read transaction count low.
  for (const url of list) {
    if (await cacheHas(url)) cached += 1;
  }
  return cached;
}

/** Return every cached URL key (one getAllKeys read). */
export async function cacheAllKeys() {
  try {
    const db = await openDb();
    const keys = await requestAsPromise(db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys());
    return (Array.isArray(keys) ? keys : []).map(String);
  } catch {
    return [];
  }
}

/** Remove everything from the cache. */
export async function cacheClear() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await txDone(tx);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download every URL into the IndexedDB cache.
 *
 * @param {string[]} urls
 * @param {{ onProgress?: (p:{total:number,done:number,stored:number,remaining:number})=>void, signal?: AbortSignal, concurrency?: number }} [options]
 * @returns {Promise<{total:number, done:number, stored:number}>}
 */
export async function cacheUrls(urls, { onProgress, signal, concurrency = 4 } = {}) {
  const list = [...new Set((urls || []).filter(Boolean))];
  const total = list.length;
  let done = 0;
  let stored = 0;

  const report = () => {
    try {
      onProgress?.({ total, done, stored, remaining: total - done });
    } catch { /* progress callback is best-effort */ }
  };
  report();

  if (!total) return { total, done, stored };

  const queue = [...list];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length) {
      if (signal?.aborted) return;
      const url = queue.shift();
      try {
        const existing = await cacheGet(url);
        if (!existing) {
          const response = await fetch(url, { signal, credentials: 'same-origin' });
          if (response.ok) {
            const blob = await response.blob();
            if (await cachePut(url, blob)) stored += 1;
          }
        }
      } catch (err) {
        if (signal?.aborted) return;
        console.warn('[page-cache] fetch failed:', url, err?.message || err);
      }
      done += 1;
      report();
    }
  });
  await Promise.all(workers);
  return { total, done, stored };
}

export default { cacheGet, cachePut, cacheHas, cacheCountCached, cacheAllKeys, cacheClear, cacheUrls };

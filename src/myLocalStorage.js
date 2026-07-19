/**
 * myLocalStorage.js — Unified scroll-position persistence.
 *
 * All writes go to memory first, then immediately to localStorage.
 * pagehide / visibilitychange call flushScrollStorage() so no unsaved
 * position is lost when the user closes the tab.
 *
 * Keys can be anything (source URL, "scroll-{group}-{lang}", etc.).
 *
 * Stored shape: { t: number, l: number, p?: number, sh?: number, sw?: number }
 *
 *   t — For scroll-* keys: fraction of page height (0–1), invariant to
 *       zoom/viewport.  For source keys (pagination): absolute scrollTop px.
 *       Values ≤ 1 are fractions; > 1 are pixel offsets (backward compat).
 */

import { isDebugMyLocalStorage } from './debug';

const STORAGE_KEY = 'pdfReaderScrollStorage';

/** Keys to silently strip on load — they will never enter the in-memory cache. */
const STRIP_KEYS = new Set([
  'scroll',
  'scroll-default-en',
  'scroll-default-tc',
  'scroll-1a-2-bilingual-en',
  'scroll-1a-2-bilingual-tc',
]);

// ── In-memory cache ───────────────────────────────────────
let _cache = null;           // null = not yet loaded from localStorage
let _dirty = false;          // true = cache has unsaved changes

// ── Internal helpers ──────────────────────────────────────

function _load() {
  if (_cache !== null) return _cache;
  if (typeof window === 'undefined') { _cache = {}; return _cache; }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    // Strip unwanted keys on load — they never enter the in-memory cache.
    let stripped = false;
    for (const k of Object.keys(parsed)) {
      if (STRIP_KEYS.has(k)) { delete parsed[k]; stripped = true; }
    }
    _cache = parsed;
    // If we stripped anything, immediately persist the cleaned cache.
    if (stripped) {
      _dirty = true;
      _flush();
    }
  } catch { _cache = {}; }
  if (isDebugMyLocalStorage()) {
    const keys = Object.keys(_cache);
    console.log(`[storage] loaded ${keys.length} keys: [${keys.join(', ')}]`);
  }
  return _cache;
}

function _flush() {
  if (!_dirty || _cache === null || typeof window === 'undefined') return;
  try {
    const json = JSON.stringify(_cache);
    window.localStorage.setItem(STORAGE_KEY, json);
    _dirty = false;
    if (isDebugMyLocalStorage()) {
      const ks = Object.keys(_cache);
      const summary = ks.map(k => `${k}:{p=${_cache[k].p},t=${typeof _cache[k].t==='number'?_cache[k].t.toFixed(4):_cache[k].t}}`).join(' ');
      console.log(`[storage] flushed ${ks.length} keys: ${summary}  (${json.length}B)`);
    }
  } catch { /* quota exceeded — silently ignore */ }
}

// ── Public API ────────────────────────────────────────────

/**
 * Retrieve a saved scroll position by key.
 * @param {string} key
 * @returns {{ top: number, left: number, page?: number, scrollHeight?: number, scrollWidth?: number } | null}
 */
export function loadScrollPos(key) {
  if (!key) return null;
  const all = _load();
  const entry = all[key];
  if (!entry) return null;
  return {
    top: entry.t ?? 0,
    left: entry.l ?? 0,
    page: entry.p,
    scrollHeight: entry.sh,
    scrollWidth: entry.sw,
  };
}

/**
 * Save a scroll position — writes to memory and immediately to localStorage.
 *
 * @param {string} key
 * @param {object} pos
 * @param {number} [pos.top]      - scrollTop (px)
 * @param {number} [pos.left]     - scrollLeft (px)
 * @param {number} [pos.page]     - current page number
 * @param {number} [pos.scrollHeight] - container scrollHeight
 * @param {number} [pos.scrollWidth]  - container scrollWidth
 */
export function saveScrollPos(key, pos) {
  if (!key || typeof window === 'undefined') return;
  try {
    const all = _load();
    all[key] = {
      t: pos.top ?? 0,
      l: pos.left ?? 0,
      p: pos.page != null ? Number(pos.page) : undefined,
      sh: pos.scrollHeight != null ? Math.round(pos.scrollHeight) : undefined,
      sw: pos.scrollWidth != null ? Math.round(pos.scrollWidth) : undefined,
    };
    _dirty = true;
    _flush();
  } catch { /* quota exceeded */ }
}

/**
 * Delete a saved scroll position by key from the in-memory cache
 * and immediately flush to localStorage (bypassing rate limit).
 *
 * @param {string} key
 */
export function deleteScrollPos(key) {
  if (!key || typeof window === 'undefined') return;
  const all = _load();
  if (!(key in all)) return;
  delete all[key];
  _dirty = true;
  _flush();
  if (isDebugMyLocalStorage()) console.log('[myLocalStorage] deleteScrollPos:', key);
}

/**
 * Flush the in-memory cache to localStorage immediately, bypassing
 * the rate limit.  Call this on pagehide / visibilitychange so no
 * position is lost when the user closes the tab.
 */
export function flushScrollStorage() {
  _flush();
}

/**
 * Delete multiple scroll keys at once.  Convenience wrapper around deleteScrollPos.
 * @param {string[]} keys
 */
export function deleteScrollKeys(keys) {
  if (!keys || !Array.isArray(keys)) return;
  const all = _load();
  let changed = false;
  for (const key of keys) {
    if (key in all) { delete all[key]; changed = true; }
  }
  if (changed) {
    _dirty = true;
    _flush();
    if (isDebugMyLocalStorage()) console.log('[myLocalStorage] deleteScrollKeys:', keys);
  }
}

/**
 * Return the entire in-memory cache (for debugging / migration).
 */
export function dumpScrollStorage() {
  return { ..._load() };
}

// ── Expose helpers on window for browser-console access ──
if (typeof window !== 'undefined') {
  window.__pdfReader = window.__pdfReader || {};
  window.__pdfReader.deleteScrollPos = deleteScrollPos;
  window.__pdfReader.deleteScrollKeys = deleteScrollKeys;
  window.__pdfReader.dumpScrollStorage = dumpScrollStorage;
}

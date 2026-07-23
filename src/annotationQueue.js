/**
 * annotationQueue.js — Offline-first, localStorage-backed send queue
 * for pen/highlighter annotations.
 *
 * Architecture:
 *   pointerUp → enqueue(action) → localStorage (instantly, never blocks)
 *                                → idle timer (300ms) or batch full (20) → flush over network
 *                                → if offline, stays in localStorage
 *                                → if online, POST /api/remarks/actions as batch
 *
 * Each action has a unique clientId for deduplication.  The queue survives
 * page reloads, tab crashes, and network outages.
 */

const STORAGE_KEY = 'pdfReaderAnnotationQueue';
const MAX_BATCH = 20;
const IDLE_MS = 300;
const MAX_RETRIES = 3;

/** Return an ISO-8601 timestamp in Hong Kong time (UTC+8) */
function hkNow() {
  const now = Date.now() + 8 * 60 * 60 * 1000;
  const d = new Date(now);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${Y}-${M}-${D}T${h}:${m}:${s}.${ms}+08:00`;
}

/** Generate a unique client-side ID — survives localStorage round-trip */
function makeClientId() {
  return `${hkNow()}__${Math.random().toString(36).slice(2, 10)}`;
}

// ── Module-level state (outside React so it survives re-renders) ──
let _queue = [];
let _timer = null;
let _sending = false;
let _onPendingCountChange = null; // callback: (count) => void
let _scopeKey = ''; // "userId|subjectId|bookId|sectionId"
let _fetchJson = null; // injected fetchJson function
let _isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

// ── localStorage helpers ──────────────────────────────────

function loadQueue() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  if (typeof window === 'undefined') return;
  try {
    if (queue.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    }
  } catch {
    // localStorage full — actions stay in memory but won't survive reload.
    // This is exceptionally rare and acceptable.
  }
}

function notifyPendingCount() {
  if (_onPendingCountChange) {
    _onPendingCountChange(_queue.length);
  }
}

// ── Scope matching ────────────────────────────────────────

function buildScopeKey(userId, subjectId, bookId, sectionId) {
  return `${userId || ''}|${subjectId || ''}|${bookId || ''}|${sectionId || ''}`;
}

/** Return actions that belong to the current scope */
function getScopeActions() {
  if (!_scopeKey) return _queue;
  return _queue.filter((a) => a.scopeKey === _scopeKey);
}

// ── Network flush ─────────────────────────────────────────

async function sendBatchWithRetry(batch, attempt) {
  // Extract userId/subjectId/bookId/sectionId from the payload of the first action,
  // since scopeKey is a composite string.  Each action's payload has these fields
  // embedded (put there by saveRemark / deleteRemarkByCreatedAt in App.jsx).
  const firstPayload = batch[0]?.payload || {};
  const userId = firstPayload.userId || '';
  const subjectId = firstPayload.subjectId || '';
  const bookId = firstPayload.bookId || '';
  const sectionId = firstPayload.sectionId || '';

  if (!_fetchJson) {
    // Queue not yet initialised — actions stay queued, will flush later
    return;
  }

  try {
    const data = await _fetchJson('api/remarks/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        subjectId,
        bookId,
        sectionId,
        actions: batch.map((a) => ({
          type: a.type,
          clientId: a.clientId,
          payload: a.payload,
        })),
      }),
    });

    // Remove successfully-sent actions from queue and localStorage
    const sentIds = new Set(batch.map((a) => a.clientId));
    _queue = _queue.filter((a) => !sentIds.has(a.clientId));
    saveQueue(_queue);
    notifyPendingCount();

    // Return server response for callbacks
    return data;
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, delay));
      return sendBatchWithRetry(batch, attempt);
    }
    // Max retries exceeded — actions stay in queue for next flush cycle
    throw err;
  }
}

async function flushScope() {
  if (_sending) return;

  const scopeActions = getScopeActions();
  if (scopeActions.length === 0) return;

  if (!_isOnline) {
    // Offline: stay silent, actions remain in localStorage
    return;
  }

  // Take up to MAX_BATCH actions for the current scope
  const batch = scopeActions.slice(0, MAX_BATCH);
  _sending = true;

  try {
    await sendBatchWithRetry(batch, 0);
  } catch (err) {
    console.error('[annotation-queue] flush failed:', err?.message || err);
    // Actions stay in queue, will retry on next flush
  } finally {
    _sending = false;
    // If more actions remain, schedule another flush
    if (getScopeActions().length > 0) {
      scheduleFlush();
    }
  }
}

function scheduleFlush() {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => flushScope(), IDLE_MS);
}

async function drainQueueOnLoad() {
  // On page load, try to flush any pending actions for the current scope
  await flushScope();
}

// ── Online/offline detection ──────────────────────────────

function setupOnlineListener() {
  if (typeof window === 'undefined') return;

  window.addEventListener('online', () => {
    _isOnline = true;
    console.log('[annotation-queue] back online — flushing queue');
    // Flush immediately when coming back online
    flushScope();
  });

  window.addEventListener('offline', () => {
    _isOnline = false;
    console.log('[annotation-queue] offline — queue will persist in localStorage');
  });
}

// ── Public API ────────────────────────────────────────────

/**
 * Initialize the queue module.  Must be called once before any enqueue operations.
 * Loads persisted queue from localStorage and starts draining.
 *
 * @param {object} opts
 * @param {function} opts.fetchJson - the fetchJson function from App.jsx
 * @param {string}   opts.userId
 * @param {string}   opts.subjectId   (selectedBook)
 * @param {string}   opts.bookId      (selectedChapter)
 * @param {number}   opts.sectionId   (selectedFile)
 * @param {function} [opts.onPendingCountChange] - callback receiving (count)
 */
export function initQueue(opts) {
  _fetchJson = opts.fetchJson;
  _onPendingCountChange = opts.onPendingCountChange || null;
  _scopeKey = buildScopeKey(opts.userId, opts.subjectId, opts.bookId, opts.sectionId);

  // Load persisted queue from localStorage
  _queue = loadQueue();
  notifyPendingCount();

  // Set up online/offline detection once
  setupOnlineListener();

  // Drain any pending actions for the current scope
  drainQueueOnLoad();
}

/**
 * Update the queue's scope when the user navigates to a different
 * book/chapter/section.  Flushes pending actions for the OLD scope first,
 * then loads actions for the new scope.
 */
export function updateScope(opts) {
  // Flush any pending actions for the current scope before switching
  if (_timer) clearTimeout(_timer);
  _timer = null;

  const oldKey = _scopeKey;
  const newKey = buildScopeKey(opts.userId, opts.subjectId, opts.bookId, opts.sectionId);
  _scopeKey = newKey;

  if (oldKey !== newKey) {
    // Flush old scope immediately (don't wait for idle timer)
    if (_queue.some((a) => a.scopeKey === oldKey)) {
      // Use a temporary scope switch to flush old actions
      const savedKey = _scopeKey;
      _scopeKey = oldKey;
      flushScope().finally(() => {
        _scopeKey = savedKey;
        // Now drain new scope
        scheduleFlush();
      });
    } else {
      scheduleFlush();
    }
  }
}

/**
 * Enqueue a single action.  Returns immediately — never blocks.
 *
 * @param {'addRemark'|'deleteRemark'} type
 * @param {object} payload - the remark data (for add) or delete params
 */
export function enqueue(type, payload) {
  const clientId = makeClientId();

  const action = {
    type,
    clientId,
    payload,
    scopeKey: _scopeKey,
    enqueuedAt: hkNow(),
  };

  _queue.push(action);
  saveQueue(_queue);
  notifyPendingCount();

  // Flush immediately if batch is full, otherwise (re)start idle timer
  if (getScopeActions().length >= MAX_BATCH) {
    if (_timer) clearTimeout(_timer);
    _timer = null;
    flushScope();
  } else {
    scheduleFlush();
  }

  return clientId;
}

/**
 * Return the number of pending (unsent) actions for the current scope.
 */
export function getPendingCount() {
  return getScopeActions().length;
}

/**
 * Return the number of pending (unsent) actions across ALL scopes.
 */
export function getTotalPendingCount() {
  return _queue.length;
}
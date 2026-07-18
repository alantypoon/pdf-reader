import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.js?url';
import { t, uiLang } from './i18n';
import { isDebugScrollingPersistence, isDebugZooming } from './debug';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// ── Scroll position persistence ───────────────────────────
// In-memory cache to avoid synchronous localStorage reads during scrolling.
// localStorage.getItem + JSON.parse on every scroll event blocks the main
// thread and kills momentum scrolling — especially in bilingual mode where
// two PdfPane instances each independently save their positions.
const SCROLL_POS_KEY = 'pdfReaderScrollPositions';
let _scrollPosCache = null;          // null = not yet loaded from localStorage
let _scrollPosDirty = false;        // true = cache has unsaved changes
let _scrollPosFlushTimer = null;    // debounce timer for batched writes

function _loadScrollPosCache() {
  if (_scrollPosCache !== null) return _scrollPosCache;
  try {
    const raw = localStorage.getItem(SCROLL_POS_KEY);
    _scrollPosCache = raw ? JSON.parse(raw) : {};
  } catch { _scrollPosCache = {}; }
  if (isDebugScrollingPersistence()) {
    const keys = Object.keys(_scrollPosCache);
    console.log('[scroll-storage] _loadScrollPosCache (first load):', { keyCount: keys.length, keys, rawLength: 0 });
  }
  return _scrollPosCache;
}

/** Flush the in-memory cache to localStorage. Called debounced during
 *  scroll and immediately on pagehide/visibilitychange. */
function _flushScrollPosCache() {
  if (!_scrollPosDirty || _scrollPosCache === null) return;
  try {
    localStorage.setItem(SCROLL_POS_KEY, JSON.stringify(_scrollPosCache));
    _scrollPosDirty = false;
    if (isDebugScrollingPersistence()) console.log('[scroll-storage] _flushScrollPosCache DONE, keys:', Object.keys(_scrollPosCache).length);
  } catch { /* quota exceeded, ignore */ }
}

function loadAllScrollPositions() {
  return _loadScrollPosCache();
}

function saveScrollPosition(source, scrollLeft, scrollTop, scrollHeight, scrollWidth) {
  if (!source) return;
  try {
    const all = _loadScrollPosCache();           // in-memory, no localStorage read
    all[source] = { scrollLeft, scrollTop, scrollHeight, scrollWidth, ts: Date.now() };
    _scrollPosDirty = true;
    // Debounce writes: flush at most once per 2 seconds during active scrolling.
    // pagehide/visibilitychange handlers call _flushScrollPosCache directly.
    if (_scrollPosFlushTimer) clearTimeout(_scrollPosFlushTimer);
    _scrollPosFlushTimer = setTimeout(_flushScrollPosCache, 2000);
    if (isDebugScrollingPersistence()) console.log('[scroll-storage] saveScrollPosition (cached):', { source, scrollLeft, scrollTop });
  } catch { /* quota exceeded, ignore */ }
}

function getScrollPosition(source) {
  if (!source) return null;
  const all = _loadScrollPosCache();
  const entry = all[source] || null;
  if (isDebugScrollingPersistence()) console.log('[scroll-storage] getScrollPosition:', { source, found: !!entry, entry });
  return entry;
}

// Safari/WebKit max canvas area is 16,777,216 px (e.g. 4096×4096)
const MAX_CANVAS_AREA = 16777216;

function safeDevicePixelRatio(viewportWidth, viewportHeight) {
  const dpr = window.devicePixelRatio || 1;
  const areaAtDpr = viewportWidth * dpr * viewportHeight * dpr;
  if (areaAtDpr <= MAX_CANVAS_AREA) return dpr;
  // Scale down DPR so width*height stays within limit
  return Math.sqrt(MAX_CANVAS_AREA / (viewportWidth * viewportHeight));
}

/**
 * If the page URL has ?timestamp=1, append a cache-busting datestamp
 * (up to milliseconds) to the given URL so the browser never serves a
 * stale cached copy.
 */
function withTimestamp(url) {
  if (typeof window === 'undefined') return url;
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('timestamp')) return url;
  } catch { return url; }
  const now = new Date();
  const pad = (n, len) => String(n).padStart(len, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}-${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}-${pad(now.getMilliseconds(), 3)}`;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}_t=${ts}`;
}

/**
 * Compute a scroll position that keeps the viewport center anchored
 * after content dimensions change (e.g. zoom in/out).
 *
 * IMPORTANT: oldClientHeight/oldClientWidth must be the container's
 * clientHeight/clientWidth *before* the content changed, because
 * scrollbar appearance/disappearance changes these values and would
 * throw off the viewport-center calculation.
 *
 * @param {HTMLElement} container - The scrollable element
 * @param {number} oldScrollTop  - scrollTop before content changed
 * @param {number} oldScrollHeight - scrollHeight before content changed
 * @param {'vertical'|'both'} axis - which axis to anchor
 * @param {number} [oldScrollLeft] - scrollLeft before content changed (for 'both')
 * @param {number} [oldScrollWidth] - scrollWidth before content changed (for 'both')
 * @param {number} [oldClientHeight] - clientHeight before content changed
 * @param {number} [oldClientWidth] - clientWidth before content changed
 * @returns {{ top: number, left?: number }} scrollTo options
 */
function centerAnchoredScroll(container, oldScrollTop, oldScrollHeight, axis = 'vertical', oldScrollLeft = 0, oldScrollWidth = 0, oldClientHeight = 0, oldClientWidth = 0) {
  // Use OLD client dimensions for the viewport-center calculation so that
  // scrollbar appearance/disappearance doesn't skew the result.
  const refClientHeight = oldClientHeight > 0 ? oldClientHeight : container.clientHeight;
  const refClientWidth = oldClientWidth > 0 ? oldClientWidth : container.clientWidth;

  const vpCenter = oldScrollTop + refClientHeight / 2;
  const centerRatio = oldScrollHeight > 0 ? vpCenter / oldScrollHeight : 0;
  const newTop = centerRatio * container.scrollHeight - container.clientHeight / 2;
  const result = { top: Math.max(0, newTop), behavior: 'instant' };
  if (axis === 'both') {
    // Use oldScrollLeft explicitly — do NOT fall back to container.scrollLeft
    // because 0 is a valid (and common) scrollLeft value.
    const hpCenter = oldScrollLeft + refClientWidth / 2;
    const hOldWidth = oldScrollWidth > 0 ? oldScrollWidth : Math.max(1, container.scrollWidth);
    const hCenterRatio = hOldWidth > 0 ? hpCenter / hOldWidth : 0;
    const newLeft = hCenterRatio * container.scrollWidth - container.clientWidth / 2;
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    result.left = Math.max(0, Math.min(newLeft, maxScrollLeft));
  }
  if (isDebugZooming()) {
    console.log('[zoom-anchor] centerAnchoredScroll', {
      axis,
      oldScrollTop, oldScrollHeight, refClientHeight,
      oldScrollLeft, oldScrollWidth, refClientWidth,
      vpCenter, centerRatio,
      newScrollTop: result.top,
      newScrollLeft: result.left,
      containerScrollHeight: container.scrollHeight,
      containerScrollWidth: container.scrollWidth,
      containerClientHeight: container.clientHeight,
      containerClientWidth: container.clientWidth,
    });
  }
  return result;
}

/**
 * Scroll-position persistence across page reloads.
 * Keyed by syncGroup (chapter-section-bilingual) + language so each
 * language pane remembers its own scrollTop / scrollLeft independently.
 *
 * Uses an in-memory cache to avoid synchronous localStorage reads during
 * scrolling (which kill momentum, especially in bilingual mode with 2 panes).
 */
const SCROLL_CACHE_KEY = 'pdfReaderScrollCache';
let _scrollCacheMem = null;           // null = not yet loaded
let _scrollCacheDirty = false;
let _scrollCacheFlushTimer = null;

function _loadScrollCacheMem() {
  if (_scrollCacheMem !== null) return _scrollCacheMem;
  if (typeof window === 'undefined') { _scrollCacheMem = {}; return _scrollCacheMem; }
  try { _scrollCacheMem = JSON.parse(window.localStorage.getItem(SCROLL_CACHE_KEY) || '{}'); } catch { _scrollCacheMem = {}; }
  return _scrollCacheMem;
}

function _flushScrollCache() {
  if (!_scrollCacheDirty || _scrollCacheMem === null || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SCROLL_CACHE_KEY, JSON.stringify(_scrollCacheMem));
    _scrollCacheDirty = false;
  } catch { /* quota exceeded */ }
}

function loadScrollCache() {
  return _loadScrollCacheMem();
}

function saveScrollCacheEntry(key, top, left) {
  if (typeof window === 'undefined') return;
  try {
    const cache = _loadScrollCacheMem();
    cache[key] = { t: Math.round(top || 0), l: Math.round(left || 0) };
    _scrollCacheDirty = true;
    // Debounce: flush at most once per 2 s during active scrolling.
    if (_scrollCacheFlushTimer) clearTimeout(_scrollCacheFlushTimer);
    _scrollCacheFlushTimer = setTimeout(_flushScrollCache, 2000);
    if (isDebugScrollingPersistence()) console.log(`[scroll-persist] SAVE  key=${key}  top=${cache[key].t}  left=${cache[key].l}`);
  } catch { /* quota exceeded — silently ignore */ }
}

/**
 * Bilingual page-position normalization.
 *
 * pageY = (pageIndex) × maxHeight  —  position is fixed regardless of
 * whether an image has loaded or what each page's natural height is.
 *
 * Each pane measures its local maxHeight, shares it via a module-level
 * Map keyed by syncGroup, then positions every child at:
 *     top: (data-page - 1) * maxHeight
 * using absolute positioning.  The mount becomes a positioned container
 * with explicit height = totalPages × maxHeight.
 *
 * Called once for PDFs (canvases are synchronous) and repeatedly for
 * images (as each load event reveals the true dimensions).
 */
const _bilingualMaxHeights = new Map();  // syncGroup → running max (px)
const BILINGUAL_REPOSITION_EVENT = 'pdf-bilingual-reposition';

/**
 * Returns the effective column width for a bilingual pane.
 * In 2-column side-by-side layout: stageWidth / 2.
 * In 1-column stacked layout (narrow screens): full stageWidth.
 */
function getBilingualColumnWidth(stage) {
  if (!stage || typeof window === 'undefined') return 360;
  const style = getComputedStyle(stage);
  const cols = style.gridTemplateColumns;
  // If the grid has only 1 track (e.g. "1fr"), panes are stacked → full width
  const colCount = cols ? cols.split(' ').filter(s => s !== '0px').length : 2;
  const stageWidth = stage.getBoundingClientRect().width;
  if (colCount <= 1) return Math.max(180, Math.floor(stageWidth));
  return Math.max(180, Math.floor(stageWidth / 2));
}

function isDebugMode() {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('test') === '1';
  } catch { return false; }
}

function debugLog(...args) {
  if (isDebugMode()) console.log(...args);
}

/**
 * Dynamically inject / update a CSS rule that locks ALL .page-img elements
 * in the bilingual layout to the shared maxHeight with !important.
 * This runs once when the max is established — no per-element inline needed.
 */
function updateBilingualPageHeightCSS(maxH) {
  debugLog(`[bilingual-css] updateBilingualPageHeightCSS called  maxH=${maxH}`);
  let styleEl = document.getElementById('bilingual-page-height-css');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'bilingual-page-height-css';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent =
    `.book-stage.bilingual-layout .pdf-scroll-pages .page-img {\n` +
    `  height: ${maxH}px !important;\n` +
    `  max-height: ${maxH}px !important;\n` +
    `  min-height: ${maxH}px !important;\n` +
    `}`;
  // console.log(`[bilingual-css] injected rule: .page-img { height:${maxH}px max-height:${maxH}px min-height:${maxH}px !important }`);
    debugLog(`[bilingual-css] injected rule: .page-img { height:${maxH}px max-height:${maxH}px min-height:${maxH}px !important }`);

}

function repositionBilingualPages(mount, syncGroup) {
  debugLog(`[bilingual-reposition] repositionBilingualPages called  syncGroup=${syncGroup}`);  
  const maxH = _bilingualMaxHeights.get(syncGroup) || 0;
  if (!maxH) { debugLog(`[bilingual-reposition] SKIP: maxH=${maxH} (zero/missing)`); return; }

  // Dynamically inject/update the CSS rule locking all .page-img heights.
  updateBilingualPageHeightCSS(maxH);

  // Find all page elements — may be inside legacy wrappers from previous builds
  const children = mount.querySelectorAll('[data-page]');
  if (!children.length) return;

  const paneLang = mount.closest('[data-annotation-language]')?.dataset?.annotationLanguage || '?';
  const oldScrollHeight = Math.max(1, mount.scrollHeight);
  const oldScrollTop = mount.scrollTop;

  // ── Unwrap legacy row/spacer/wrapper elements ────────────
  const legacy = mount.querySelector('.bilingual-position-wrapper');
  if (legacy) { while (legacy.firstChild) mount.appendChild(legacy.firstChild); legacy.remove(); }
  const oldSpacer = mount.querySelector('.bilingual-scroll-spacer');
  if (oldSpacer) oldSpacer.remove();
  mount.querySelectorAll('.bilingual-page-row').forEach((row) => {
    while (row.firstChild) mount.appendChild(row.firstChild);
    row.remove();
  });

  // ── Sort children by page number in the DOM ──────────────
  const sorted = Array.from(children).sort(
    (a, b) => (parseInt(a.dataset.page) || 0) - (parseInt(b.dataset.page) || 0)
  );
  sorted.forEach((child) => mount.appendChild(child));

  // ── Reset all positioning on children ────────────────────
  sorted.forEach((child) => {
    child.style.position = '';
    child.style.top = '';
    child.style.left = '';
    child.style.right = '';
    child.style.marginLeft = '';
    child.style.marginRight = '';
    child.style.display = 'block';
    if (child.dataset.blank === 'true') {
      child.style.setProperty('height', `${maxH}px`, 'important');
    }
  });

  // ── Block layout: images as direct children, fixed height ──
  // Use natural block flow (like single-language mode) instead of CSS Grid.
  // CSS Grid with gridAutoRows causes Safari desktop to snap-scroll to row
  // boundaries — each row is a full page, so scrolling "jumps" from page top
  // to page top. Block layout avoids this while still keeping momentum scroll
  // on iOS (which depends on -webkit-overflow-scrolling: touch on the
  // container, not on the display type of children).
  mount.style.display = 'block';
  mount.style.gridTemplateColumns = '';
  mount.style.gridAutoRows = '';
  mount.style.position = '';
  mount.style.setProperty('--bilingual-row-height', `${maxH}px`);

  // Add/update a normal-flow spacer so iOS -webkit-overflow-scrolling: touch
  // can compute momentum correctly.  Absolute children alone do not create a
  // scrollable content area that iOS momentum understands — a static element
  // with the total content height serves as the canonical scroll extent.
  const totalPages = children.length;
  let spacer = mount.querySelector('.bilingual-scroll-spacer');
  if (!spacer) {
    spacer = document.createElement('div');
    spacer.className = 'bilingual-scroll-spacer';
    spacer.style.cssText = 'width:1px;pointer-events:none;opacity:0;position:static;';
    mount.appendChild(spacer);
  }
  spacer.style.height = `${totalPages * maxH}px`;

  const newScrollHeight = Math.max(1, mount.scrollHeight);
  if (newScrollHeight !== oldScrollHeight) {
    mount.scrollTop = oldScrollTop * (newScrollHeight / oldScrollHeight);
  }

  debugLog(
    `[bilingual-reposition] grid rows=${sorted.length}  maxH=${maxH}  lang=${paneLang}  oldH=${oldScrollHeight}  newH=${newScrollHeight}`
  );
}

function updateBilingualMaxHeight(syncGroup, localMax) {
  const current = _bilingualMaxHeights.get(syncGroup) || 0;
  const next = Math.max(current, Math.round(localMax));
  _bilingualMaxHeights.set(syncGroup, next);
  debugLog(`[bilingual-maxH] updateBilingualMaxHeight  syncGroup=${syncGroup}  localMax=${Math.round(localMax)}  current=${current}  next=${next}`);
  return next;
}

function normalizeBilingualHeights(mount, syncGroup, reset = false) {
  const children = mount.querySelectorAll('[data-page]');
  const paneLang = mount.closest('[data-annotation-language]')?.dataset?.annotationLanguage || '?';
  debugLog(`[bilingual-measure] normalizeBilingualHeights called  lang=${paneLang}  syncGroup=${syncGroup}  reset=${reset}  children=${children.length}`);
  if (!children.length) { debugLog(`[bilingual-measure] SKIP: no children`); return; }

  // Measure local max from actual rendered heights
  let localMax = 0;
  let minH = Infinity;
  children.forEach((child) => {
    const h = child.getBoundingClientRect().height;
    if (h > localMax) localMax = h;
    if (h < minH) minH = h;
  });

  // Update shared max (both panes contribute to the same Map entry).
  // When reset is true, discard previous max so the value can shrink
  // (e.g. after fit-refresh or window resize to smaller dimensions).
  if (reset) _bilingualMaxHeights.delete(syncGroup);
  const prevMax = _bilingualMaxHeights.get(syncGroup) || 0;
  const newMax = updateBilingualMaxHeight(syncGroup, localMax);

  debugLog(
    `[bilingual-measure] lang=${paneLang}  localMax=${Math.round(localMax)}  localMin=${Math.round(minH)}  globalMax=${newMax}  (was ${prevMax})`
  );

  // Reposition if max changed
  if (newMax !== prevMax || prevMax === 0) {
    repositionBilingualPages(mount, syncGroup);
    // If the shared max grew because of us, notify the OTHER pane to reposition
    if (newMax !== prevMax) {
      window.dispatchEvent(new CustomEvent(BILINGUAL_REPOSITION_EVENT, {
        detail: { syncGroup }
      }));
    }
  }
}

function PdfPane({
  source,
  images,
  title,
  section,
  mode,
  currentPage,
  onPageChange,
  onPageCountChange,
  thumbnailsOpen,
  onThumbnailClick,
  syncGroup,
  syncId,
  zoom = 1,
  thumbCols = 4,
  fitMode = 'auto',
  fitRefreshToken = 0,
  onRenderScaleChange,
  onScrollCanvasesReady,
  language = 'en',
  paneLanguage = 'en',
  maxPagesInGroup = 0,
  hideHeader = false
}) {
  const lang = uiLang(language);
  const _ = (key) => t(key, lang);
  const isImageMode = Array.isArray(images) && images.length > 0;
  const [pdfDoc, setPdfDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [thumbs, setThumbs] = useState([]);
  const [renderedPage, setRenderedPage] = useState(1);
  const [contentWidth, setContentWidth] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [imageLoadVersion, setImageLoadVersion] = useState(0);
  const [loadError, setLoadError] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [thumbFocusIndex, setThumbFocusIndex] = useState(-1);
  const canvasRef = useRef(null);
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const thumbGridRef = useRef(null);
  const blankRef = useRef(null);
  const currentPageRef = useRef(currentPage);
  const renderedPageRef = useRef(1);
  const syncingFromRemoteRef = useRef(false);
  const modeGenRef = useRef(0);
  const scrollRestoredRef = useRef(false);
  const isInitialLoadRef = useRef(true);  // true until first content load completes
  const syncGroupRef = useRef(syncGroup);
  const paneLanguageRef = useRef(paneLanguage);
  // Keep refs in sync so the pagehide handler (which runs in an effect with
  // empty deps) can still access the latest values.
  useEffect(() => { syncGroupRef.current = syncGroup; }, [syncGroup]);
  useEffect(() => { paneLanguageRef.current = paneLanguage; }, [paneLanguage]);
  // Pre-zoom scroll capture that survives effect re-runs (caused by contentWidth
  // changing after CSS width is set).  The key (zoom+fitMode) prevents the second
  // run from overwriting the correct old-dimensions capture.
  const zoomAnchorRef = useRef({ key: '', zoom: 0, scrollTop: 0, scrollLeft: 0, scrollHeight: 0, scrollWidth: 0, clientHeight: 0, clientWidth: 0 });

  // Keep the refs in sync so the scrolling effect always sees the latest page
  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    renderedPageRef.current = renderedPage;
  }, [renderedPage]);

  // Increment generation on mode change to cancel stale async work
  useEffect(() => {
    modeGenRef.current += 1;
  }, [mode]);

  // ── Keyboard navigation for thumbnail grid (window-level for reliability) ──
  const thumbFocusIndexRef = useRef(-1);
  useEffect(() => { thumbFocusIndexRef.current = thumbFocusIndex; }, [thumbFocusIndex]);

  useEffect(() => {
    if (!thumbnailsOpen) return;
    const cols = Math.max(1, thumbCols);

    const onKey = (e) => {
      const total = thumbs.length;
      if (!total) return;
      // Don't interfere with typing in inputs
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

      const idx = thumbFocusIndexRef.current;
      const currentRow = idx < 0 ? 0 : Math.floor(idx / cols);
      const currentCol = idx < 0 ? 0 : idx % cols;
      const totalRows = Math.ceil(total / cols);

      let next = idx;
      let handled = true;
      switch (e.key) {
        case 'ArrowRight':
          next = idx < 0 ? 0 : Math.min(idx + 1, total - 1);
          break;
        case 'ArrowLeft':
          next = idx < 0 ? 0 : Math.max(idx - 1, 0);
          break;
        case 'ArrowDown': {
          const newRow = Math.min(currentRow + 1, totalRows - 1);
          next = newRow * cols + Math.min(currentCol, cols - 1);
          if (next >= total) next = total - 1;
          break;
        }
        case 'ArrowUp': {
          const newRow = Math.max(currentRow - 1, 0);
          next = newRow * cols + Math.min(currentCol, cols - 1);
          break;
        }
        case 'Enter':
          if (idx >= 0 && idx < total) {
            e.preventDefault();
            e.stopPropagation();
            const page = thumbs[idx].page;
            if (onThumbnailClick) {
              onThumbnailClick(page);
            } else {
              onPageChange(page);
            }
          }
          return;
        default:
          handled = false;
      }
      if (!handled) return;

      e.preventDefault();
      e.stopPropagation();
      setThumbFocusIndex(next);
      // Scroll focused thumbnail into view
      const grid = thumbGridRef.current;
      if (grid) {
        const btn = grid.querySelector(`[data-thumb-index="${next}"]`);
        if (btn) {
          btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [thumbnailsOpen, thumbCols, thumbs]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // ── Image mode: derive page count & thumbnails from images array ──
  useEffect(() => {
    if (!isImageMode) return;
    setPdfDoc(null);
    setLoadError(null);
    setNumPages(images.length);
    setRenderedPage((prev) => Math.max(1, Math.min(prev, images.length)));
    setThumbFocusIndex(-1);
    const thumbData = images.map((url, i) => ({
      page: i + 1,
      url
    }));
    setThumbs(thumbData);
  }, [isImageMode, images]);

  // Keep renderedPage in sync with currentPage
  useEffect(() => {
    // In PDF pagination mode, PdfPane manages its own page tracking via the draw effect.
    // In image mode and other modes, sync from the parent's currentPage.
    if (!isImageMode && mode === 'pagination') return;
    setRenderedPage((prev) => {
      const page = Math.max(1, Math.min(currentPage, numPages || 1));
      return prev !== page ? page : prev;
    });
  }, [isImageMode, mode, currentPage, numPages]);

  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setContentWidth(rect.width);
      setContentHeight(rect.height);
    });
    observer.observe(node);
    setContentWidth(node.clientWidth);
    setContentHeight(node.clientHeight);
    return () => observer.disconnect();
  }, []);

  // ── Fit scale: report the scale at which the page fits the container ──
  const imgRef = useRef(null);

  const handleImageLoad = () => {
    setImageLoadVersion((current) => current + 1);
  };

  const paginationPaneStyle = useMemo(() => {
    return {
      position: 'relative'
    };
  }, []);

  useEffect(() => {
    if (typeof onPageCountChange === 'function') {
      onPageCountChange(numPages);
    }
    // onPageCountChange excluded from deps — it's an inline callback whose identity
    // changes each render, but we only need to notify when numPages actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPages]);

  // ── PDF mode: load via pdfjs ───────────────────────────────
  useEffect(() => {
    if (isImageMode) return;
    let isMounted = true;
    if (!source) {
      setPdfDoc(null);
      setNumPages(0);
      setThumbs([]);
      setLoadError(null);
      return;
    }

    const load = async () => {
      try {
        setLoadError(null);
        const task = pdfjsLib.getDocument({ url: source });
        const doc = await task.promise;
        if (!isMounted) return;
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setRenderedPage(Math.min(currentPage, doc.numPages));

        const thumbsData = [];
        for (let i = 1; i <= doc.numPages; i += 1) {
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale: 0.24 });
          const c = document.createElement('canvas');
          const ctx = c.getContext('2d');
          c.width = viewport.width;
          c.height = viewport.height;
          await page.render({ canvasContext: ctx, viewport }).promise;
          thumbsData.push({ page: i, url: c.toDataURL('image/jpeg', 0.65) });
        }

        if (isMounted) {
          setThumbs(thumbsData);
        }
      } catch (err) {
        console.error('[PdfPane] failed to load PDF:', source, err);
        if (isMounted) {
          setPdfDoc(null);
          setNumPages(0);
          setThumbs([]);
          setLoadError(err.message || 'Failed to load PDF');
        }
      }
    };

    load();
    return () => {
      isMounted = false;
    };
  }, [source, currentPage]);

  // ── Pagination mode (PDF) ──────────────────────────────────
  useEffect(() => {
    if (isImageMode) return;
    if (mode !== 'pagination') return;
    if (!pdfDoc) return;
    const gen = modeGenRef.current;
    const draw = async () => {
      const pageNumber = Math.max(1, Math.min(currentPage, numPages || 1));
      const isBlank = currentPage > (numPages || 0) && numPages > 0;
      // Use first page as reference for blank page dimensions
      const refPageNumber = isBlank ? 1 : pageNumber;
      const page = await pdfDoc.getPage(refPageNumber);
      if (modeGenRef.current !== gen) return;
      const holder = canvasRef.current?.parentElement;
      if (!holder) return;
      // Capture scroll position before canvas resize changes scrollHeight.
      // On initial load (holder at 0,0) try localStorage first so the user
      // lands where they left off after a page reload.
      const stored = getScrollPosition(source);
      const useStored = stored && holder.scrollTop === 0 && holder.scrollLeft === 0;
      if (isDebugScrollingPersistence()) console.log('[scroll-restore:pdf-pagination]', { source, hasStored: !!stored, holderScrollTop: holder.scrollTop, holderScrollLeft: holder.scrollLeft, useStored, stored });
      if (useStored) scrollRestoredRef.current = true;
      const oldScrollTop = useStored ? stored.scrollTop : holder.scrollTop;
      const oldScrollLeft = useStored ? stored.scrollLeft : holder.scrollLeft;
      const oldScrollHeight = useStored
        ? Math.max(1, stored.scrollHeight || 0)
        : Math.max(1, holder.scrollHeight);
      const oldScrollWidth = useStored
        ? Math.max(1, stored.scrollWidth || 0)
        : Math.max(1, holder.scrollWidth);
      // Capture client dimensions before zoom changes them (scrollbar appearance)
      const oldClientHeight = holder.clientHeight;
      const oldClientWidth = holder.clientWidth;
      const sidebarWidth = Math.max(0, document.querySelector('.sidebar')?.getBoundingClientRect().width || 0);
      const toolbarHeight = Math.max(0, document.querySelector('.annotation-panel')?.getBoundingClientRect().height || 0);
      const viewportWidthCap = Math.max(180, window.innerWidth - sidebarWidth);
      const viewportHeightCap = Math.max(180, window.innerHeight - toolbarHeight);
      const fitWidth = Math.max(180, Math.min(holder.clientWidth, viewportWidthCap));
      const fitHeight = Math.max(180, Math.min(holder.clientHeight, viewportHeightCap));
      const baseViewport = page.getViewport({ scale: 1 });
      const scaleW = fitWidth / baseViewport.width;
      const scaleH = fitHeight / baseViewport.height;
      const fitScale = fitMode === 'height'
        ? scaleH
        : fitMode === 'width'
          ? scaleW
          : fitMode === 'none'
            ? scaleW  // same baseline as fit-width, but max-width is released
            : Math.min(scaleW, scaleH);
      const scale = Math.max(0.001, fitScale * zoom);
      if (isDebugZooming()) {
        console.log('[zoom-pdf-pagination] scale computed', {
          zoom, fitMode, fitScale, scale,
          fitWidth, fitHeight,
          baseWidth: baseViewport.width, baseHeight: baseViewport.height,
          oldScrollTop, oldScrollLeft, oldScrollHeight, oldScrollWidth,
        });
      }
      if (typeof onRenderScaleChange === 'function') {
        onRenderScaleChange(scale);
      }
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas || modeGenRef.current !== gen) return;
      const context = canvas.getContext('2d');
      const ratio = safeDevicePixelRatio(viewport.width, viewport.height);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      // Fit-height / none (absolute zoom): allow horizontal overflow.
      // CSS (.pdf-single-page canvas) applies max-width:100%, so we
      // must explicitly clear it when the user wants unconstrained zoom.
      canvas.style.maxWidth = (fitMode === 'height' || fitMode === 'none') ? 'none' : '';
      canvas.style.maxHeight = '';
      canvas.style.display = 'block';
      canvas.style.flexShrink = '0';
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      // Restore center-anchored scroll now that new dimensions are set
      const heightChanged = oldScrollHeight !== holder.scrollHeight;
      const widthChanged = oldScrollWidth !== holder.scrollWidth;
      if (isDebugZooming()) {
        console.log('[zoom-pdf-pagination] center-anchor check (pre-render)', {
          zoom, fitMode, scale,
          oldScrollTop, oldScrollHeight, oldScrollLeft, oldScrollWidth,
          currentScrollHeight: holder.scrollHeight, currentScrollWidth: holder.scrollWidth,
          heightChanged, widthChanged,
        });
      }
      if (heightChanged || widthChanged) {
        holder.scrollTo(centerAnchoredScroll(holder, oldScrollTop, oldScrollHeight, 'both', oldScrollLeft, oldScrollWidth, oldClientHeight, oldClientWidth));
      }
      if (isBlank) {
        // Render a blank white page so both versions have matching dimensions
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        await page.render({ canvasContext: context, viewport }).promise;
      }
      if (modeGenRef.current !== gen) return;
      // Re-apply after render in case paint caused a layout shift
      const postHeightChanged = oldScrollHeight !== holder.scrollHeight;
      const postWidthChanged = oldScrollWidth !== holder.scrollWidth;
      if (isDebugZooming()) {
        console.log('[zoom-pdf-pagination] center-anchor check (post-render)', {
          zoom, fitMode, scale,
          oldScrollTop, oldScrollHeight, oldScrollLeft, oldScrollWidth,
          currentScrollHeight: holder.scrollHeight, currentScrollWidth: holder.scrollWidth,
          postHeightChanged, postWidthChanged,
        });
      }
      if (postHeightChanged || postWidthChanged) {
        holder.scrollTo(centerAnchoredScroll(holder, oldScrollTop, oldScrollHeight, 'both', oldScrollLeft, oldScrollWidth, oldClientHeight, oldClientWidth));
      }
      setRenderedPage(currentPage);
      // Don't fire onPageChange for blank pages — the page number is intentionally
      // beyond this version's count and the parent already knows about it.
    };

    draw();
  }, [isImageMode, pdfDoc, currentPage, numPages, mode, onPageChange, zoom, contentWidth, contentHeight, fitMode, fitRefreshToken]);

  // ── Clamp horizontal scroll in pagination mode ──────────────
  // Prevents the page from drifting sideways past its edges
  // (especially in fit-height mode where maxWidth is "none").
  useEffect(() => {
    if (mode !== 'pagination') return;
    // Find the scroll container — works for both PDF (canvas) and image modes
    const holder = canvasRef.current?.parentElement
      || imgRef.current?.closest('.pdf-single-page')
      || contentRef.current?.querySelector('.pdf-single-page');
    if (!holder) return;

    const onScroll = () => {
      const maxScrollLeft = Math.max(0, holder.scrollWidth - holder.clientWidth);
      if (holder.scrollLeft > maxScrollLeft) {
        holder.scrollLeft = maxScrollLeft;
      } else if (holder.scrollLeft < 0) {
        holder.scrollLeft = 0;
      }
    };

    holder.addEventListener('scroll', onScroll, { passive: true });
    return () => holder.removeEventListener('scroll', onScroll);
  }, [isImageMode, mode, pdfDoc, images, zoom, fitMode, fitRefreshToken]);

  // ── Image pagination: apply explicit pixel dimensions for fit-height ──
  //     Using height:100% (percentage) can fail because of a circular
  //     dependency in the CSS chain (flex-basis:auto vs percentage heights).
  //     We measure the container and set explicit px, matching scrolling mode.
  //     Also handles blank page divs (when currentPage > images.length in
  //     bilingual mode) to ensure identical dimensions across both versions.
  useLayoutEffect(() => {
    if (!isImageMode || mode !== 'pagination') return;

    // Handle blank page div dimensions
    const isBlankPage = currentPage > images.length;
    if (isBlankPage) {
      const blank = blankRef.current;
      const container = blank?.closest('.pdf-single-page');
      if (!blank || !container) return;
      if (fitMode === 'height') {
        const h = container.clientHeight;
        if (h > 0) {
          blank.style.height = `${h * zoom}px`;
          blank.style.width = 'auto';
          blank.style.maxWidth = 'none';
          blank.style.maxHeight = 'none';
        }
      } else if (fitMode === 'none') {
        const w = container.clientWidth;
        if (w > 0) {
          blank.style.width = `${w * zoom}px`;
          blank.style.height = 'auto';
          blank.style.maxWidth = 'none';
          blank.style.maxHeight = 'none';
        }
      } else {
        const w = container.clientWidth;
        if (w > 0) {
          blank.style.width = `${w * zoom}px`;
          blank.style.height = 'auto';
          blank.style.maxWidth = '';
          blank.style.maxHeight = 'none';
        }
      }
      return;
    }

    const img = imgRef.current;
    const container = img?.closest('.pdf-single-page');
    if (!img || !container) return;
    if (fitMode === 'height') {
      const h = container.clientHeight;
      if (h > 0) {
        img.style.height = `${h * zoom}px`;
        img.style.width = 'auto';
        img.style.maxWidth = 'none';
        img.style.maxHeight = 'none';
      }
    } else if (fitMode === 'none') {
      // Same baseline as width-fit but max-width constraint is released for unconstrained zoom
      const w = container.clientWidth;
      if (w > 0) {
        img.style.width = `${w * zoom}px`;
        img.style.height = 'auto';
        img.style.maxWidth = 'none';
        img.style.maxHeight = 'none';
      }
    } else {
      const w = container.clientWidth;
      if (w > 0) {
        img.style.width = `${w * zoom}px`;
        img.style.height = 'auto';
        img.style.maxWidth = '';
        img.style.maxHeight = 'none';
      }
    }
  }, [isImageMode, mode, zoom, fitMode, fitRefreshToken, imageLoadVersion, currentPage, images]);

  useEffect(() => {
    if (!isImageMode) return;
    if (mode !== 'pagination') return;
    if (typeof onRenderScaleChange !== 'function') return;
    const img = imgRef.current;
    if (!img || !img.complete) return;

    const frame = requestAnimationFrame(() => {
      const rect = img.getBoundingClientRect();
      const baseSize = fitMode === 'height' ? img.naturalHeight : img.naturalWidth;
      const renderedSize = fitMode === 'height' ? rect.height : rect.width;
      if (baseSize > 0 && renderedSize > 0) {
        onRenderScaleChange(renderedSize / baseSize);
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [isImageMode, mode, currentPage, images, zoom, fitMode, contentWidth, contentHeight, imageLoadVersion, fitRefreshToken]);

  // ── Image pagination: keep viewport center anchored on zoom ─
  const imgPaginationScrollRef = useRef({ top: 0, left: 0, height: 0, width: 0, clientHeight: 0, clientWidth: 0 });
  useLayoutEffect(() => {
    if (!isImageMode || mode !== 'pagination') return;
    const container = imgRef.current?.closest('.pdf-single-page');
    if (!container) return;
    let { top, left, height, width, clientHeight, clientWidth } = imgPaginationScrollRef.current;

    // On initial load (height=0 in ref), try localStorage first
    if (height === 0) {
      const stored = getScrollPosition(source);
      if (isDebugScrollingPersistence()) console.log('[scroll-restore:img-pagination]', { source, hasStored: !!stored, stored });
      if (stored && stored.scrollTop > 0) {
        top = stored.scrollTop;
        left = stored.scrollLeft || 0;
        height = Math.max(1, stored.scrollHeight || 0);
        width = Math.max(1, stored.scrollWidth || 0);
        clientHeight = container.clientHeight;
        clientWidth = container.clientWidth;
        scrollRestoredRef.current = true;
      }
    }

    const heightChanged = height > 0 && height !== container.scrollHeight;
    const widthChanged = width > 0 && width !== container.scrollWidth;
    if (isDebugZooming()) {
      console.log('[zoom-img-pagination] center-anchor check', {
        zoom, fitMode,
        refTop: top, refLeft: left, refHeight: height, refWidth: width,
        currentScrollHeight: container.scrollHeight, currentScrollWidth: container.scrollWidth,
        heightChanged, widthChanged,
      });
    }
    if (heightChanged || widthChanged) {
      const oldCH = clientHeight > 0 ? clientHeight : container.clientHeight;
      const oldCW = clientWidth > 0 ? clientWidth : container.clientWidth;
      container.scrollTo(centerAnchoredScroll(container, top, height, 'both', left, width, oldCH, oldCW));
    } else if (height === 0 && top > 0) {
      // Initial load with stored position but same dimensions — apply directly
      container.scrollTop = top;
      container.scrollLeft = left;
    }
    imgPaginationScrollRef.current = {
      top: container.scrollTop,
      left: container.scrollLeft,
      height: Math.max(1, container.scrollHeight),
      width: Math.max(1, container.scrollWidth),
      clientHeight: container.clientHeight,
      clientWidth: container.clientWidth,
    };
  }, [isImageMode, mode, zoom, fitMode, fitRefreshToken, imageLoadVersion]);

  // ── Scrolling mode (PDF) ───────────────────────────────────
  useEffect(() => {
    if (isImageMode || mode !== 'scrolling') return;
    if (!pdfDoc) return;
    const mount = scrollRef.current;
    if (!mount) return;

    // If there is a saved scroll position, mark scrollRestoredRef now
    // so the scroll-to-page useEffect (which runs synchronously after
    // render) skips its scroll-to-currentPage call.
    const storedPos = getScrollPosition(source);
    if (storedPos && typeof storedPos.scrollTop === 'number') {
      scrollRestoredRef.current = true;
    }

    // ── Capture scroll position BEFORE any DOM changes ──
    // Use a ref keyed by zoom+fitMode so the capture survives effect
    // re-runs caused by contentWidth changes (ResizeObserver feedback).
    const anchorKey = `${zoom}|${fitMode}`;
    let anchor = zoomAnchorRef.current;
    const isFirstRunForZoom = anchor.key !== anchorKey;
    if (isFirstRunForZoom) {
      // On initial load (mount at 0,0) try localStorage first
      const stored = getScrollPosition(source);
      const useStored = stored && mount.scrollTop === 0 && mount.scrollLeft === 0;
      if (isDebugScrollingPersistence()) console.log('[scroll-restore:pdf-scrolling]', { source, hasStored: !!stored, mountScrollTop: mount.scrollTop, mountScrollLeft: mount.scrollLeft, useStored, stored });
      if (useStored) scrollRestoredRef.current = true;
      anchor = {
        key: anchorKey,
        scrollTop: useStored ? stored.scrollTop : mount.scrollTop,
        scrollLeft: useStored ? stored.scrollLeft : mount.scrollLeft,
        scrollHeight: useStored
          ? Math.max(1, stored.scrollHeight || 0)
          : Math.max(1, mount.scrollHeight),
        scrollWidth: useStored
          ? Math.max(1, stored.scrollWidth || 0)
          : Math.max(1, mount.scrollWidth),
        clientHeight: mount.clientHeight,
        clientWidth: mount.clientWidth,
      };
      zoomAnchorRef.current = anchor;
      if (isDebugZooming()) {
        console.log('[zoom-pdf-scrolling] pre-zoom capture (FIRST run)', {
          zoom, fitMode,
          savedScrollTop: anchor.scrollTop, savedScrollLeft: anchor.scrollLeft,
          savedScrollHeight: anchor.scrollHeight, savedScrollWidth: anchor.scrollWidth,
          savedClientHeight: anchor.clientHeight, savedClientWidth: anchor.clientWidth,
        });
      }
    } else if (isDebugZooming()) {
      console.log('[zoom-pdf-scrolling] pre-zoom capture (SKIPPED — already captured)', { zoom, fitMode, anchorKey });
    }

    let disposed = false;
    let pageRefreshTimer = null;
    const gen = modeGenRef.current;
    mount.style.justifyItems = 'center';
    mount.style.overflowX = fitMode === 'none' ? 'auto' : 'hidden';

    // Measure the base (unzoomed) width. In bilingual mode, compute from
    // the SHARED parent (.book-stage) so both panes get the EXACT same
    // value — no 1px sub-pixel drift.  Respects stacked vs side-by-side layout.
    const isBilingual = maxPagesInGroup > 0;
    let baseWidth;
    if (isBilingual) {
      const stage = mount.closest('.book-stage');
      baseWidth = getBilingualColumnWidth(stage);
    } else {
      const baseRect = contentRef.current ? contentRef.current.getBoundingClientRect() : mount.getBoundingClientRect();
      baseWidth = Math.max(180, baseRect.width);
    }

    if (contentRef.current) {
      contentRef.current.style.overflow = fitMode === 'none' ? 'visible' : 'hidden';
      // Drive zoom by changing .pdf-content width so it's visible in CSS
      contentRef.current.style.width = fitMode === 'none' ? `${100 * zoom}%` : '';
    }
    // Constrain .pdf-scroll-pages to the base (viewport) width so its content overflows → scrollbar
    mount.style.width = `${baseWidth}px`;

    // In bilingual mode, inject the CSS height rule BEFORE canvases enter
    // the DOM so they render at the correct size from the start.
    if (isBilingual) {
      const estH = Math.round(baseWidth * zoom * Math.SQRT2);
      updateBilingualPageHeightCSS(estH);
    }

    const drawAll = async () => {
      let lastScale = zoom;
      const mountRect = mount.getBoundingClientRect();
      const containerHeight = Math.max(180, mountRect.height);
      // Use the base (viewport) width for scale calculations, not the mount's
      // measured width which is now explicitly constrained.
      const containerWidth = baseWidth;

      if (isDebugZooming()) {
        console.log('[zoom-pdf-scrolling] drawAll start', {
          zoom, fitMode, baseWidth, containerHeight, containerWidth,
          isBilingual, numPages, maxPagesInGroup,
          currentScrollTop: mount.scrollTop, currentScrollLeft: mount.scrollLeft,
          currentScrollHeight: mount.scrollHeight, currentScrollWidth: mount.scrollWidth,
        });
      }
      const fragment = document.createDocumentFragment();

      // In bilingual mode, compute uniform page height from SHARED parameters
      // (container width + zoom + standard A4 ratio √2) so BOTH language panes
      // get the EXACT SAME integer value.  Computing from each pane's own first
      // page can differ by 1-10px due to slight PDF dimension variations, and
      // that error multiplies per page — causing growing vertical misalignment.
      let uniformPageHeight = null;
      if (isBilingual) {
        if (fitMode === 'height') {
          uniformPageHeight = Math.round(containerHeight * zoom);
        } else {
          uniformPageHeight = Math.round(containerWidth * zoom * Math.SQRT2);
        }
      }

      const canvases = [];
      for (let i = 1; i <= numPages; i += 1) {
        if (disposed || modeGenRef.current !== gen) return;
        const page = await pdfDoc.getPage(i);
        if (disposed || modeGenRef.current !== gen) return;
        const viewportBase = page.getViewport({ scale: 1 });

        if (isBilingual) {
          // Scale every page by height to match the shared uniform height.
          // Width adjusts proportionally (may overflow container → scrollbar).
          lastScale = Math.max(0.001, (uniformPageHeight / viewportBase.height));
        } else if (fitMode === 'none') {
          lastScale = Math.max(0.001, (containerWidth / viewportBase.width) * zoom);
        } else {
          const fitDim = fitMode === 'height' ? containerHeight : containerWidth;
          const fitBase = fitMode === 'height' ? viewportBase.height : viewportBase.width;
          lastScale = Math.max(0.001, (fitDim / fitBase) * zoom);
        }

        // Log zoom details for the first page only to avoid noise
        if (isDebugZooming() && i === 1) {
          console.log('[zoom-pdf-scrolling] page 1 scale computed', {
            zoom, fitMode, lastScale, isBilingual,
            uniformPageHeight,
            viewportBaseWidth: viewportBase.width, viewportBaseHeight: viewportBase.height,
          });
        }

        const viewport = page.getViewport({ scale: lastScale });

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        const ratio = safeDevicePixelRatio(viewport.width, viewport.height);
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);

        // In bilingual mode, force CSS height to the rounded uniform value so
        // every page occupies exactly the same vertical space across both panes.
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = isBilingual && uniformPageHeight
          ? `${uniformPageHeight}px`
          : `${viewport.height}px`;
        canvas.style.display = 'block';
        canvas.dataset.page = String(i);

        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        await page.render({ canvasContext: context, viewport }).promise;
        if (disposed || modeGenRef.current !== gen) return;
        canvases.push(canvas);
      }

      // Append all canvases
      canvases.forEach((c) => fragment.appendChild(c));

      // Pad shorter PDF with blank pages (all at uniform height) so both
      // bilingual versions have identical total scroll height.
      const pageH = uniformPageHeight || containerHeight;
      if (maxPagesInGroup > 0 && numPages > 0 && numPages < maxPagesInGroup) {
        const blankWidth = mount.getBoundingClientRect().width || baseWidth;
        for (let p = numPages + 1; p <= maxPagesInGroup; p++) {
          const blankPage = document.createElement('div');
          blankPage.className = 'pdf-blank-page';
          blankPage.style.width = `${blankWidth}px`;
          blankPage.style.setProperty('height', `${pageH}px`, 'important');
          blankPage.textContent = String(p);
          blankPage.style.display = 'block';
          blankPage.dataset.page = String(p);
          blankPage.dataset.blank = 'true';
          fragment.appendChild(blankPage);
        }
      }

      if (disposed || modeGenRef.current !== gen) return;

      // Scroll position was already captured at the effect level (zoomAnchorRef).
      // Read from the ref — NOT from mount — because a second effect run may
      // have already cleared the mount's innerHTML.

      mount.innerHTML = '';
      mount.appendChild(fragment);

      // Bilingual: after DOM settles, position every page at
      // pageY = (pageIndex) × max(all EN+TC heights) via absolute positioning.
      if (isBilingual) {
        requestAnimationFrame(() => {
          if (disposed || modeGenRef.current !== gen) return;
          normalizeBilingualHeights(mount, syncGroup, true);
        });
      }

      if (typeof onRenderScaleChange === 'function') {
        onRenderScaleChange(lastScale);
      }
      if (typeof onScrollCanvasesReady === 'function') {
        requestAnimationFrame(() => onScrollCanvasesReady());
      }

      const syncPageIndicator = () => {
        if (disposed || modeGenRef.current !== gen) return null;
        const allNodes = [...mount.querySelectorAll('[data-page]')];
        if (!allNodes.length) return null;
        const top = mount.scrollTop;
        let nearest = Number(allNodes[0].dataset.page) || 1;
        let min = Infinity;
        allNodes.forEach((node) => {
          const dist = Math.abs(node.offsetTop - top);
          if (dist < min) { min = dist; nearest = Number(node.dataset.page); }
        });
        // Only update React state when the page actually changes to avoid
        // unnecessary re-renders that cause flickering during scroll.
        if (nearest !== renderedPageRef.current) {
          setRenderedPage(nearest);
          // Suppress onPageChange when this scroll was triggered by a remote
          // sync — the initiating pane already reported the correct page.
          if (!syncingFromRemoteRef.current) {
            lastScrolledFromSyncRef.current = true;
            onPageChange(nearest);
          }
        }
        return nearest;
      };

      let scrollRafId = null;
      let pendingScrollSync = false;
      let saveScrollTimer = null;
      const scrollCacheKey = `scroll-${syncGroup || 'default'}-${paneLanguage}`;
      const scheduleSaveScroll = () => {
        if (saveScrollTimer) clearTimeout(saveScrollTimer);
        saveScrollTimer = setTimeout(() => {
          if (disposed || modeGenRef.current !== gen) return;
          saveScrollCacheEntry(scrollCacheKey, mount.scrollTop, mount.scrollLeft);
        }, 1000);
      };
      const onScroll = () => {
        // Throttle scroll handling to once per animation frame to avoid
        // layout thrashing and flickering on iOS/mobile devices.
        // Skip entirely when this scroll was triggered by a remote sync —
        // DOM queries (querySelectorAll + offsetTop) are expensive on iOS
        // and kill momentum scrolling in bilingual mode.
        if (!pendingScrollSync && !syncingFromRemoteRef.current) {
          pendingScrollSync = true;
          scrollRafId = requestAnimationFrame(() => {
            pendingScrollSync = false;
            if (disposed || modeGenRef.current !== gen) return;
            syncPageIndicator();

            if (syncGroup && !syncingFromRemoteRef.current) {
              const max = Math.max(1, mount.scrollHeight - mount.clientHeight);
              const ratio = mount.scrollTop / max;
              const hMax = Math.max(1, mount.scrollWidth - mount.clientWidth);
              const hRatio = hMax > 0 ? mount.scrollLeft / hMax : 0;
              window.dispatchEvent(new CustomEvent('pdf-pane-scroll-sync', {
                detail: {
                  group: syncGroup,
                  sender: syncId,
                  ratio,
                  hRatio
                }
              }));
            }
          });
        }
        scheduleSaveScroll();
      };

      mount.addEventListener('scroll', onScroll, { passive: true });

      // Restore center-anchored scroll position after layout settles,
      // then sync the page indicator from the restored position.
      // We MUST NOT call onScroll() synchronously here — the DOM layout
      // hasn't settled yet and scrollTop may be stale.  Instead we piggy-
      // back on the same RAF that restores the scroll position.
      // Read from the ref (NOT closure) so we use the FIRST-run capture.
      const captured = anchor;
      requestAnimationFrame(() => {
        if (disposed || modeGenRef.current !== gen) return;

        const heightChanged = captured.scrollHeight !== mount.scrollHeight;
        const widthChanged = captured.scrollWidth !== mount.scrollWidth;
        if (isDebugZooming()) {
          console.log('[zoom-pdf-scrolling] center-anchor check', {
            zoom, fitMode,
            savedScrollTop: captured.scrollTop, savedScrollHeight: captured.scrollHeight,
            savedScrollLeft: captured.scrollLeft, savedScrollWidth: captured.scrollWidth,
            currentScrollHeight: mount.scrollHeight, currentScrollWidth: mount.scrollWidth,
            heightChanged, widthChanged,
            willAnchoredScroll: heightChanged || widthChanged,
          });
        }
        if (heightChanged || widthChanged) {
          mount.scrollTo(centerAnchoredScroll(
            mount,
            captured.scrollTop, captured.scrollHeight, 'both',
            captured.scrollLeft, captured.scrollWidth,
            captured.clientHeight, captured.clientWidth
          ));
        }

        // On initial load, override with the saved scroll position from a
        // previous session (stored in localStorage).
        if (isInitialLoadRef.current) {
          const saved = loadScrollCache()[scrollCacheKey];
          if (saved && typeof saved.t === 'number') {
            if (isDebugScrollingPersistence()) console.log(`[scroll-persist] RESTORE key=${scrollCacheKey}  top=${saved.t}  left=${saved.l}`);
            mount.scrollTo({ left: saved.l, top: saved.t, behavior: 'instant' });
            scrollRestoredRef.current = true;
          } else {
            if (isDebugScrollingPersistence()) console.log(`[scroll-persist] RESTORE key=${scrollCacheKey}  (no saved position — using default)`);
          }
          isInitialLoadRef.current = false;
        }

        // After restoring scroll (or even if heights matched), fire the
        // scroll handler once so the parent knows which page is visible.
        // Use a microtask to let the scrollTo layout settle first.
        requestAnimationFrame(() => {
          if (disposed || modeGenRef.current !== gen) return;
          onScroll();
        });
      });

      return () => {
        if (scrollRafId != null) cancelAnimationFrame(scrollRafId);
        if (saveScrollTimer) clearTimeout(saveScrollTimer);
        mount.removeEventListener('scroll', onScroll);
      };
    };

    let cleanup = () => {};
    drawAll().then((result) => {
      cleanup = result || (() => {});
    });

    return () => {
      disposed = true;
      if (typeof pageRefreshTimer === 'number' || pageRefreshTimer) {
        clearTimeout(pageRefreshTimer);
      }
      cleanup();
    };
  }, [isImageMode, pdfDoc, numPages, mode, zoom, fitMode, fitRefreshToken, contentWidth, maxPagesInGroup]);

  // ── Scroll to current page in scrolling mode (prev/next buttons) ─
  // Only jump when the page change came from a button click, not from
  // natural scrolling (which would create a feedback loop).
  const lastScrolledFromSyncRef = useRef(false);
  useEffect(() => {
    if (mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount || !mount.children.length) return;
    // Skip if the page change was triggered by our own scroll sync.
    if (lastScrolledFromSyncRef.current) {
      lastScrolledFromSyncRef.current = false;
      return;
    }
    // During initial load only: if a saved scroll position exists in
    // localStorage, let the build effect's RAF restore it instead of
    // jumping to currentPage. After the first content load completes,
    // always honor prev/next navigation.
    if (isInitialLoadRef.current) {
      const storedPos = getScrollPosition(source);
      if (storedPos && typeof storedPos.scrollTop === 'number') {
        return;
      }
    }
    const target = mount.querySelector(`[data-page="${currentPage}"]`);
    if (target) {
      mount.scrollTo({ top: target.offsetTop, behavior: 'instant' });
    }
  }, [mode, currentPage]);

  // ── Helper: resolve the active scroll container ──────────
  const getScrollContainer = useCallback(() => {
    if (mode === 'scrolling') return scrollRef.current;
    return canvasRef.current?.parentElement
      || imgRef.current?.closest('.pdf-single-page')
      || null;
  }, [mode]);

  // ── Save scroll position to localStorage on scroll (debounced) ──
  // ONLY for pagination mode.  In scrolling mode the drawAll / image-scrolling
  // effect already attaches its own scroll handler that syncs page indicator,
  // dispatches cross-pane scroll events, AND saves the position — adding a
  // second listener here would double the per-frame work and hurt momentum
  // scrolling, especially in bilingual mode (2 panes × 2 listeners = 4 handlers).
  const saveContainerRef = useRef(null);
  useEffect(() => {
    if (!source) return;
    if (mode === 'scrolling') return;  // scrolling mode has its own scroll handler

    let saveTimer = null;
    let attachRetries = 0;
    const MAX_ATTACH_RETRIES = 20; // 20 × 200ms = 4 s

    const onScroll = () => {
      if (isDebugScrollingPersistence()) console.log('[scroll-save] scroll event FIRED (debouncing 500ms)');
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const container = saveContainerRef.current;
        if (!container) return;
        if (isDebugScrollingPersistence()) console.log('[scroll-save] saving to localStorage:', { source, scrollLeft: container.scrollLeft, scrollTop: container.scrollTop, scrollHeight: container.scrollHeight, scrollWidth: container.scrollWidth });
        saveScrollPosition(source, container.scrollLeft, container.scrollTop, container.scrollHeight, container.scrollWidth);
      }, 500);
    };

    // Save immediately on page unload / tab hide so the latest position is never lost.
    // pagehide fires reliably across all browsers (unlike beforeunload which may
    // be skipped on Chrome desktop during certain navigation patterns).
    const doSaveNow = () => {
      const container = saveContainerRef.current;
      if (!container || !source) return;
      saveScrollPosition(source, container.scrollLeft, container.scrollTop, container.scrollHeight, container.scrollWidth);
      // Also update the scroll-cache entry (used for initial-load restoration)
      const scrollCacheKey = `scroll-${syncGroup || 'default'}-${paneLanguage}`;
      saveScrollCacheEntry(scrollCacheKey, container.scrollTop, container.scrollLeft);
      // Flush both caches to localStorage immediately — don't wait for debounce.
      _flushScrollPosCache();
      _flushScrollCache();
    };
    const onVisibilityHidden = () => {
      if (document.visibilityState === 'hidden') doSaveNow();
    };
    window.addEventListener('pagehide', doSaveNow);
    window.addEventListener('visibilitychange', onVisibilityHidden);

    const tryAttach = () => {
      const container = getScrollContainer();
      if (container && container.scrollHeight > 0) {
        saveContainerRef.current = container;
        container.addEventListener('scroll', onScroll, { passive: true });
        if (isDebugScrollingPersistence()) console.log('[scroll-save] listener ATTACHED to container:', { source, mode, scrollHeight: container.scrollHeight, scrollWidth: container.scrollWidth });
        return true;
      }
      if (isDebugScrollingPersistence()) console.log('[scroll-save] tryAttach FAILED (container not ready):', { hasContainer: !!container, scrollHeight: container ? container.scrollHeight : 'N/A', mode, source });
      return false;
    };

    // Try immediately; if the container isn't ready yet, retry.
    if (!tryAttach()) {
      const interval = setInterval(() => {
        attachRetries++;
        if (tryAttach() || attachRetries >= MAX_ATTACH_RETRIES) {
          clearInterval(interval);
        }
      }, 200);
      return () => {
        clearInterval(interval);
        if (saveTimer) clearTimeout(saveTimer);
        window.removeEventListener('pagehide', doSaveNow);
        window.removeEventListener('visibilitychange', onVisibilityHidden);
        const c = saveContainerRef.current;
        if (c) { c.removeEventListener('scroll', onScroll); saveContainerRef.current = null; }
      };
    }

    return () => {
      if (saveTimer) clearTimeout(saveTimer);
      window.removeEventListener('pagehide', doSaveNow);
      window.removeEventListener('visibilitychange', onVisibilityHidden);
      const c = saveContainerRef.current;
      if (c) { c.removeEventListener('scroll', onScroll); saveContainerRef.current = null; }
    };
  }, [source, mode, pdfDoc, images, getScrollContainer]);

  // ── Flush scroll-position caches on pagehide / visibilitychange ──
  // This covers scrolling mode (where the main save-scroll effect is
  // skipped to avoid duplicate scroll listeners).  Both the old
  // (SCROLL_POS_KEY) and new (SCROLL_CACHE_KEY) systems are flushed
  // so no unsaved position is lost when the user closes the tab.
  //
  // We also save the *current* scroll position right before the page
  // unloads, because the debounced save (1-2 s) may not have fired yet.
  useEffect(() => {
    const saveAndFlush = () => {
      // Save the current scroll position for this pane instance.
      const mount = scrollRef.current;
      if (mount && mount.scrollHeight > 0) {
        const key = `scroll-${syncGroupRef.current || 'default'}-${paneLanguageRef.current}`;
        saveScrollCacheEntry(key, mount.scrollTop, mount.scrollLeft);
      }
      _flushScrollPosCache();
      _flushScrollCache();
    };
    const onPageHide = () => saveAndFlush();
    const onVisibilityHidden = () => {
      if (document.visibilityState === 'hidden') saveAndFlush();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('visibilitychange', onVisibilityHidden);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('visibilitychange', onVisibilityHidden);
    };
  }, []);

  useEffect(() => {
    if (!syncGroup || mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount) return;

    const onSync = (event) => {
      const { group, sender, ratio, hRatio } = event.detail || {};
      if (group !== syncGroup || sender === syncId) return;
      const max = Math.max(0, mount.scrollHeight - mount.clientHeight);
      const hMax = Math.max(0, mount.scrollWidth - mount.clientWidth);
      // Set both guards to prevent any scroll-back from the scroll-to-page
      // useEffect or the syncPageIndicator onPageChange callback.
      syncingFromRemoteRef.current = true;
      lastScrolledFromSyncRef.current = true;
      mount.scrollTop = ratio * max;
      if (hMax > 0 && typeof hRatio === 'number') {
        mount.scrollLeft = hRatio * hMax;
      }
      // Use setTimeout(0) instead of requestAnimationFrame so the reset
      // always runs AFTER React commits the batched onPageChange state
      // update.  On Safari, RAF callbacks can run before React's commit,
      // causing lastScrolledFromSyncRef to be reset too early — the
      // scroll-to-currentPage effect then sees false and jumps to the
      // top of the target page instead of skipping.
      setTimeout(() => {
        syncingFromRemoteRef.current = false;
        // If no React state update consumed lastScrolledFromSyncRef
        // (i.e. no page change occurred), reset it here so the next
        // prev/next button click doesn't get wrongly suppressed.
        lastScrolledFromSyncRef.current = false;
      }, 0);
    };

    window.addEventListener('pdf-pane-scroll-sync', onSync);
    return () => window.removeEventListener('pdf-pane-scroll-sync', onSync);
  }, [mode, syncGroup, syncId]);

  // ── Bilingual reposition listener ───────────────────────
  // When the OTHER pane measures a taller page and updates the shared
  // maxHeight, reposition our pages at the new (pageIndex * maxH) too.
  useEffect(() => {
    if (!syncGroup || mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount) return;

    const onReposition = (event) => {
      const { syncGroup: group } = event.detail || {};
      if (group !== syncGroup) return;
      const maxH = _bilingualMaxHeights.get(syncGroup) || 0;
      if (maxH && mount) {
        debugLog(`[bilingual-listen] lang=${paneLanguage} received reposition event, maxH=${maxH}`);
        repositionBilingualPages(mount, syncGroup);
      }
    };

    window.addEventListener(BILINGUAL_REPOSITION_EVENT, onReposition);
    return () => window.removeEventListener(BILINGUAL_REPOSITION_EVENT, onReposition);
  }, [mode, syncGroup, paneLanguage]);

  // ── Image-mode scrolling: build <img> tags with progressive load ─
  const lastImagesRef = useRef(null);
  const maxPagesInGroupRef = useRef(maxPagesInGroup);

  useEffect(() => {
    if (!isImageMode || mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount) return;

    // If there is a saved scroll position for this source, mark it
    // NOW (synchronously) so the scroll-to-page useEffect skips its
    // scroll-to-currentPage call, which would otherwise overwrite the
    // saved position before the RAF restore has a chance to run.
    const storedPos = getScrollPosition(source);
    if (storedPos && typeof storedPos.scrollTop === 'number') {
      scrollRestoredRef.current = true;
    }

    // Helper: scroll so the current page is visible and update parent state
    const scrollToPage = (pageNum) => {
      const p = Math.max(1, Math.min(pageNum, images.length || 1));
      const n = mount.querySelector(`img[data-page="${p}"]`);
      if (n) {
        mount.scrollTo({ top: n.offsetTop, behavior: 'instant' });
      }
      setRenderedPage(p);
      onPageChange(p);
    };

    // Skip rebuild if images array hasn't changed AND maxPagesInGroup hasn't changed
    if (lastImagesRef.current === images && maxPagesInGroupRef.current === maxPagesInGroup && mount.children.length === images.length) {
      // Still scroll to the current page (e.g. when switching from pagination to scrolling)
      scrollToPage(currentPage);
      // Report render scale even when we skip the rebuild — otherwise the
      // zoom percentage stays blank after switching pagination → scroll.
      if (typeof onRenderScaleChange === 'function') {
        const imgs = mount.querySelectorAll('img.page-img');
        for (const img of imgs) {
          if (img.naturalWidth > 0) {
            const w = img.getBoundingClientRect().width;
            if (w > 0) { onRenderScaleChange(w / img.naturalWidth); break; }
          }
        }
      }
      // If some images haven't finished loading, their offsetTop may still be
      // based on the initial 120px min-height.  Re-scroll once everything loads.
      const unloaded = [...mount.querySelectorAll('img.page-img')].filter(
        (img) => !(img.complete && img.naturalHeight > 0)
      );
      if (unloaded.length > 0) {
        let loadedCount = 0;
        unloaded.forEach((img) => {
          img.addEventListener('load', onAllLoaded, { once: true });
          img.addEventListener('error', onAllLoaded, { once: true });
        });
        function onAllLoaded() {
          loadedCount++;
          if (loadedCount >= unloaded.length) {
            scrollToPage(currentPage);
          }
        }
      }
      return;
    }

    mount.innerHTML = '';
    mount.style.justifyItems = 'center';

    const isBilingual = maxPagesInGroup > 0;

    // Measure the base (unzoomed) width. In bilingual mode, compute from
    // the SHARED parent (.book-stage) so both panes get the EXACT same
    // value — no 1px sub-pixel drift.  Respects stacked vs side-by-side layout.
    let baseWidth;
    if (isBilingual) {
      const stage = mount.closest('.book-stage');
      baseWidth = getBilingualColumnWidth(stage);
    } else {
      const baseRect = contentRef.current ? contentRef.current.getBoundingClientRect() : { width: mount.getBoundingClientRect().width };
      baseWidth = Math.max(180, baseRect.width);
    }

    // Apply zoom at the .pdf-content level so CSS width reflects the zoom percentage
    if (contentRef.current) {
      contentRef.current.style.width = fitMode === 'none' ? `${100 * zoom}%` : '';
    }
    // Constrain .pdf-scroll-pages to the base (viewport) width so its content overflows → scrollbar
    mount.style.width = `${baseWidth}px`;

    // In bilingual mode, inject the CSS height rule BEFORE any images enter
    // the DOM.  Uses the shared formula so both panes start at the same size.
    // normalizeBilingualHeights will refine it to the actual measured max later.
    if (isBilingual) {
      const estH = Math.round(baseWidth * zoom * Math.SQRT2);
      updateBilingualPageHeightCSS(estH);
    }

    // Create all img elements first (without src) so DOM order is fixed.
    const mountH = Math.max(180, mount.getBoundingClientRect().height);
    let uniformImgHeight = null;
    const imgElements = images.map((url, idx) => {
      const pageNum = idx + 1;
      const img = document.createElement('img');
      img.alt = `${_('pageN')} ${pageNum}`;
      img.dataset.page = String(pageNum);
      img.dataset.src = url;
      img.className = 'page-img';
      // In bilingual mode every dimension is explicit — no auto, no min-height.
      // Outside bilingual mode, use the existing fitMode-based sizing.
      if (isBilingual) {
        // width + height set below in the bilingual block
      } else if (fitMode === 'height') {
        img.style.height = `${mountH * zoom}px`;
        img.style.width = 'auto';
      } else {
        img.style.width = `${baseWidth * zoom}px`;
        img.style.height = 'auto';
        img.style.maxWidth = 'none';
      }
      img.style.display = 'block';
      if (!isBilingual) {
        img.style.minHeight = '120px';
      }
      img.style.opacity = '0';
      return img;
    });

    // In bilingual mode every image needs explicit width so the
    // render-scale calculation (width / naturalWidth) produces the
    // correct zoom percentage.  Height comes from the injected CSS rule.
    if (isBilingual && imgElements.length > 0) {
      if (fitMode === 'height') {
        uniformImgHeight = Math.round(mountH * zoom);
      } else {
        uniformImgHeight = Math.round(baseWidth * zoom * Math.SQRT2);
      }
      const pageW = Math.round(baseWidth * zoom);
      imgElements.forEach((img) => {
        img.style.width = `${pageW}px`;
      });
    }

    const fragment = document.createDocumentFragment();
    imgElements.forEach((img) => fragment.appendChild(img));
    mount.appendChild(fragment);

    // Update refs after rebuild
    lastImagesRef.current = images;
    maxPagesInGroupRef.current = maxPagesInGroup;

    // Pad shorter image set with individual blank <div> pages.  Each shows
    // its page number centred.  Height from uniformImgHeight, later locked
    // by repositionBilingualPages to the final global max.
    if (maxPagesInGroup > 0 && images.length > 0 && images.length < maxPagesInGroup) {
      const pageH = uniformImgHeight || (() => {
        if (fitMode === 'height') return Math.round(mountH * zoom);
        return Math.round(baseWidth * zoom * Math.SQRT2);
      })();
      for (let p = images.length + 1; p <= maxPagesInGroup; p++) {
        const blankPage = document.createElement('div');
        blankPage.className = 'pdf-blank-page';
        blankPage.style.height = `${pageH}px`;
        blankPage.textContent = String(p);
        blankPage.dataset.page = String(p);
        blankPage.dataset.blank = 'true';
        mount.appendChild(blankPage);
      }
    }

    // Bilingual: position every page at pageY = (pageIndex) × maxHeight
    // using absolute positioning.  Call immediately (all elements are in
    // the DOM), then re-run immediately as EACH image loads (so pages
    // centre without a visible flash on narrow stacked layouts), AND
    // keep a 150ms debounced safety net for late-arriving layout changes.
    if (isBilingual) {
      normalizeBilingualHeights(mount, syncGroup, true);
      let normalizeTimer = null;
      const scheduleNormalize = () => {
        if (normalizeTimer) clearTimeout(normalizeTimer);
        normalizeTimer = setTimeout(() => {
          if (disposed) return;
          normalizeBilingualHeights(mount, syncGroup, true);
        }, 150);
      };
      const onImageLoad = () => {
        // Immediate call — centres pages as soon as the image paints.
        // Use reset=false so we don't discard the shared max, just refine.
        normalizeBilingualHeights(mount, syncGroup, false);
        // Safety net: re-measure after any follow-up layout.
        scheduleNormalize();
      };
      imgElements.forEach((img) => {
        img.addEventListener('load', onImageLoad, { once: true });
      });
    }

    // Viewport-aware lazy loader — max 2 concurrent, preload 3 pages around current page
    const PRELOAD_WINDOW = 3;
    let loading = 0;
    const loadedSet = new Set(); // indices of pages loaded or currently loading
    let disposed = false;
    let lastVisiblePage = currentPage;

    const loadOne = (idx) => {
      if (idx < 0 || idx >= imgElements.length || disposed) return false;
      if (loadedSet.has(idx)) return false; // already loaded/loading
      if (loading >= 2) return false;
      const img = imgElements[idx];
      const url = img.dataset.src;
      if (!url || img.src) return false;
      loadedSet.add(idx);
      loading++;
      img.src = withTimestamp(url);
      img.onload = () => {
        loading--;
        img.style.minHeight = '';
        img.style.opacity = '1';
        if (!disposed) loadVisibleRange(lastVisiblePage);
      };
      img.onerror = () => {
        loading--;
        img.style.opacity = '0';
        if (!disposed) loadVisibleRange(lastVisiblePage);
      };
      return true;
    };

    const loadVisibleRange = (centerPage) => {
      // Always load the center page first
      loadOne(centerPage - 1);
      // Then load surrounding pages, expanding outward
      for (let offset = 1; offset <= PRELOAD_WINDOW; offset++) {
        loadOne(centerPage - 1 - offset);
        loadOne(centerPage - 1 + offset);
      }
    };

    // Initial load around the current page
    loadVisibleRange(currentPage);

    // After images have had a chance to load (cached images decode
    // synchronously), report the render scale so the zoom percentage
    // appears immediately after switching modes — no resize needed.
    if (typeof onRenderScaleChange === 'function') {
      const report = () => {
        const imgs = mount.querySelectorAll('img.page-img');
        for (const img of imgs) {
          if (img.naturalWidth > 0) {
            const w = img.getBoundingClientRect().width;
            if (w > 0) { onRenderScaleChange(w / img.naturalWidth); return; }
          }
        }
      };
      setTimeout(report, 0);
    }

    // After the current-page image loads (or is already cached), scroll into position.
    // On initial load, restore saved scroll position from localStorage instead.
    const scheduleScrollToCurrent = () => {
      const currentImg = imgElements[currentPage - 1];
      if (!currentImg || disposed) return;

      const storedPos = getScrollPosition(source);
      if (isDebugScrollingPersistence()) console.log('[scroll-restore:img-scrolling]', { source, hasStored: !!storedPos, storedPos });
      if (storedPos && typeof storedPos.scrollTop === 'number') {
        scrollRestoredRef.current = true;
        mount.scrollTop = storedPos.scrollTop;
        mount.scrollLeft = storedPos.scrollLeft || 0;

        // Re-restore after all images finish loading, since image load
        // events may trigger bilingual layout recalculations that shift
        // the scroll position.
        const allImgs = [...mount.querySelectorAll('img.page-img')];
        const pending = allImgs.filter((img) => !img.complete || img.naturalHeight === 0);
        if (pending.length > 0) {
          let loaded = 0;
          const onAnyLoaded = () => {
            loaded++;
            if (loaded >= pending.length) {
              mount.scrollTop = storedPos.scrollTop;
              mount.scrollLeft = storedPos.scrollLeft || 0;
            }
          };
          pending.forEach((img) => {
            img.addEventListener('load', onAnyLoaded, { once: true });
            img.addEventListener('error', onAnyLoaded, { once: true });
          });
        }
        // Safety net: after 2s re-apply the saved position in case
        // some load events were missed or bilingual normalization
        // shifted the scroll position after the restore.
        setTimeout(() => {
          if (disposed) return;
          mount.scrollTop = storedPos.scrollTop;
          mount.scrollLeft = storedPos.scrollLeft || 0;
        }, 2000);
        return;
      }

      if (currentImg.complete && currentImg.naturalHeight > 0) {
        scrollToPage(currentPage);
        return;
      }
      // Not loaded yet — wait for it
      const onReady = () => {
        currentImg.removeEventListener('load', onReady);
        currentImg.removeEventListener('error', onReady);
        if (!disposed) scrollToPage(currentPage);
      };
      currentImg.addEventListener('load', onReady, { once: true });
      currentImg.addEventListener('error', onReady, { once: true });
    };
    // Small delay to let the DOM settle, then scroll
    requestAnimationFrame(() => { scheduleScrollToCurrent(); });

    let scrollRafId2 = null;
    let pendingScroll2 = false;
    const onScroll = () => {
      // Throttle: only run once per animation frame (matching the drawAll handler).
      // Skip entirely when this scroll was triggered by a remote sync — the
      // initiating pane already reported the page, and DOM queries (querySelectorAll
      // + offsetTop) are expensive on iOS, killing momentum scrolling.
      if (syncingFromRemoteRef.current || pendingScroll2) return;
      pendingScroll2 = true;
      scrollRafId2 = requestAnimationFrame(() => {
        pendingScroll2 = false;
        if (disposed) return;
        const nodes = [...mount.querySelectorAll('[data-page]')];
        const top = mount.scrollTop;
        let nearest = 1;
        let min = Infinity;
        nodes.forEach((node) => {
          const distance = Math.abs(node.offsetTop - top);
          if (distance < min) {
            min = distance;
            nearest = Number(node.dataset.page);
          }
        });
        // Only update React state when the page actually changes to avoid
        // unnecessary re-renders that can cause flickering during scroll.
        if (nearest !== renderedPageRef.current) {
          setRenderedPage(nearest);
        }

        // Load newly-visible pages when the visible page changes
        if (nearest !== lastVisiblePage) {
          lastVisiblePage = nearest;
          loadVisibleRange(nearest);
        }

        const cp = currentPageRef.current;
        if (nearest !== cp) {
          lastScrolledFromSyncRef.current = true;
          onPageChange(nearest);
        }

        if (syncGroup) {
          const max = Math.max(1, mount.scrollHeight - mount.clientHeight);
          const ratio = mount.scrollTop / max;
          const hMax = Math.max(1, mount.scrollWidth - mount.clientWidth);
          const hRatio = hMax > 0 ? mount.scrollLeft / hMax : 0;
          window.dispatchEvent(new CustomEvent('pdf-pane-scroll-sync', {
            detail: { group: syncGroup, sender: syncId, ratio, hRatio }
          }));
        }
      });
    };

    // ── Scroll-position persistence (debounced 1s) ──────
    let saveScrollTimer = null;
    const scrollCacheKey = `scroll-${syncGroup || 'default'}-${paneLanguage}`;
    const scheduleSaveScroll = () => {
      if (saveScrollTimer) clearTimeout(saveScrollTimer);
      saveScrollTimer = setTimeout(() => {
        if (disposed) return;
        saveScrollCacheEntry(scrollCacheKey, mount.scrollTop, mount.scrollLeft);
      }, 1000);
    };
    const onScrollWithSave = () => {
      onScroll();
      scheduleSaveScroll();
    };

    mount.addEventListener('scroll', onScrollWithSave, { passive: true });

    // Restore saved scroll position from a previous session
    if (isInitialLoadRef.current) {
      const saved = loadScrollCache()[scrollCacheKey];
      if (saved && typeof saved.t === 'number') {
        if (isDebugScrollingPersistence()) console.log(`[scroll-persist] RESTORE key=${scrollCacheKey}  top=${saved.t}  left=${saved.l}`);
        requestAnimationFrame(() => {
          if (disposed) return;
          requestAnimationFrame(() => {
            if (disposed) return;
            mount.scrollTo({ left: saved.l, top: saved.t, behavior: 'instant' });
            scrollRestoredRef.current = true;
          });
        });
      } else {
        if (isDebugScrollingPersistence()) console.log(`[scroll-persist] RESTORE key=${scrollCacheKey}  (no saved position — using default)`);
      }
      isInitialLoadRef.current = false;
    }

    return () => {
      disposed = true;
      if (saveScrollTimer) clearTimeout(saveScrollTimer);
      if (scrollRafId2 != null) cancelAnimationFrame(scrollRafId2);
      mount.removeEventListener('scroll', onScrollWithSave);
    };
  }, [isImageMode, images, mode, syncGroup, syncId, maxPagesInGroup]);

  // ── Apply zoom to image-mode scrolling via .pdf-content width ─
  useEffect(() => {
    if (!isImageMode) return;
    if (mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount) return;

    // ── Capture scroll position BEFORE any CSS changes ──
    // Use a ref so the capture survives React re-running this effect
    // (e.g. when contentWidth changes after we set .pdf-content width).
    // We only capture ONCE per unique zoom+fitMode pair.
    const anchorKey = `${zoom}|${fitMode}`;
    let anchor = zoomAnchorRef.current;
    if (anchor.key !== anchorKey) {
      // First run for this zoom level — capture old dimensions AND old zoom
      anchor = {
        key: anchorKey,
        zoom: anchor.zoom > 0 ? anchor.zoom : zoom,  // preserve previous zoom for scale calc
        scrollTop: mount.scrollTop,
        scrollLeft: mount.scrollLeft,
        scrollHeight: Math.max(1, mount.scrollHeight),
        scrollWidth: Math.max(1, mount.scrollWidth),
        clientHeight: mount.clientHeight,
        clientWidth: mount.clientWidth,
      };
      zoomAnchorRef.current = anchor;

      if (isDebugZooming()) {
        console.log('[zoom-img-scrolling] pre-zoom capture (FIRST run)', {
          zoom, fitMode,
          savedScrollTop: anchor.scrollTop, savedScrollLeft: anchor.scrollLeft,
          savedScrollHeight: anchor.scrollHeight, savedScrollWidth: anchor.scrollWidth,
          savedClientHeight: anchor.clientHeight, savedClientWidth: anchor.clientWidth,
        });
      }
    } else if (isDebugZooming()) {
      console.log('[zoom-img-scrolling] pre-zoom capture (SKIPPED — already captured for this zoom)', {
        zoom, fitMode, anchorKey,
      });
    }

    mount.style.overflowX = fitMode === 'none' ? 'auto' : 'hidden';
    if (contentRef.current) {
      contentRef.current.style.overflow = fitMode === 'none' ? 'visible' : 'hidden';
    }

    // Measure the true base width by temporarily clearing any zoom width,
    // then re-apply the zoom width. All synchronous — no visible flash.
    if (contentRef.current) {
      contentRef.current.style.width = '';
    }
    const rawRect = contentRef.current ? contentRef.current.getBoundingClientRect() : mount.getBoundingClientRect();
    const baseWidth = Math.max(180, rawRect.width);

    if (contentRef.current) {
      // Drive zoom by changing .pdf-content width so it's visible in CSS
      contentRef.current.style.width = fitMode === 'none' ? `${100 * zoom}%` : '';
    }
    // Constrain .pdf-scroll-pages to the base width so content overflows → scrollbar
    mount.style.width = `${baseWidth}px`;

    // In bilingual mode, recalculate max page height on every resize.
    // The injected CSS rule and absolute positioning must reflect the new
    // container width, otherwise page heights become stale.
    if (maxPagesInGroup > 0) {
      // Use the SHARED parent width so both panes stay in sync.
      // Respects stacked vs side-by-side layout.
      const stage = mount.closest('.book-stage');
      const sharedW = getBilingualColumnWidth(stage);
      const estH = fitMode === 'height'
        ? Math.round(Math.max(180, mount.getBoundingClientRect().height) * zoom)
        : Math.round(sharedW * zoom * Math.SQRT2);
      updateBilingualPageHeightCSS(estH);
      // Update image widths to match the new container width
      const pageW = Math.round(sharedW * zoom);
      const imgs = mount.querySelectorAll('img.page-img');
      imgs.forEach((img) => { img.style.width = `${pageW}px`; });
      // Re-measure and reposition — image dimensions changed.
      // reset=true allows the shared max to shrink if needed.
      normalizeBilingualHeights(mount, syncGroup, true);
    } else {
      // Size images wider than the scroll container to create horizontal overflow.
      // For height-fit mode use container height to drive image size instead.
      const imgs = mount.querySelectorAll('img.page-img');
      if (fitMode === 'height') {
        const mountH = Math.max(180, mount.getBoundingClientRect().height);
        imgs.forEach((img) => {
          img.style.height = `${mountH * zoom}px`;
          img.style.width = 'auto';
          img.style.maxWidth = '';
        });
      } else {
        imgs.forEach((img) => {
          img.style.width = `${baseWidth * zoom}px`;
          img.style.height = 'auto';
          img.style.maxWidth = 'none';
        });
      }
    }

    // Report the render scale for the zoom percentage display.
    // Scans ALL images (not just the first) because the lazy loader may
    // only have loaded pages near currentPage, leaving page 1 unloaded.
    if (typeof onRenderScaleChange === 'function') {
      let reported = false;
      const reportScale = () => {
        if (reported) return;
        const imgs = mount.querySelectorAll('img.page-img');
        for (const img of imgs) {
          if (!img.naturalWidth) continue;
          const w = img.getBoundingClientRect().width;
          if (w > 0) {
            reported = true;
            onRenderScaleChange(w / img.naturalWidth);
            return;
          }
        }
      };
      reportScale();  // try immediately (some images may be cached)
      // If no image is loaded yet, listen on ALL of them
      if (!reported) {
        const imgs = mount.querySelectorAll('img.page-img');
        imgs.forEach((img) => {
          img.addEventListener('load', reportScale, { once: true });
        });
      }
      // Fallback: retry after 2s in case load events were missed
      const fallbackTimer = setTimeout(() => {
        if (!reported) reportScale();
      }, 2000);
    }
    // After fit/zoom changes, page boundaries shift. Restore the same relative
    // scroll position (both axes) so zoom is anchored at the screen center.
    //
    // ═══ PHASE 1 (synchronous): apply estimated scroll immediately ═══
    // Using the known zoom ratio avoids a paint frame where content is
    // at the wrong position — this eliminates visible "shakiness".
    const captured = anchor;
    const oldZoom = captured.zoom > 0 ? captured.zoom : zoom;
    const zoomRatio = oldZoom > 0 ? zoom / oldZoom : 1;
    const oldCH = captured.clientHeight;
    const oldCW = captured.clientWidth;
    const oldSH = captured.scrollHeight;
    const oldSW = captured.scrollWidth;

    // Vertical: content is top-aligned, simple zoom-factor scaling
    const estNewTop = (captured.scrollTop + oldCH / 2) * zoomRatio - oldCH / 2;

    // Horizontal: account for CSS centering offset in old state
    const oldContentFits = oldSW <= oldCW + 1;
    const oldHOffset = oldContentFits ? (oldCW - oldSW) / 2 : 0;
    const contentCenterX = captured.scrollLeft + oldCW / 2 - oldHOffset;
    // Estimate new centering: if content was already overflowing, it stays overflowed
    const estNewContentFits = oldContentFits && (zoomRatio <= 1.01);
    const estNewHOffset = estNewContentFits ? (oldCW - oldSW * zoomRatio) / 2 : 0;
    const estNewLeft = contentCenterX * zoomRatio + estNewHOffset - oldCW / 2;

    // Clamp and apply synchronously (before browser paints)
    const estMaxTop = Math.max(0, oldSH * zoomRatio - oldCH);
    const estMaxLeft = Math.max(0, oldSW * zoomRatio - oldCW);
    if (oldSH > 0 || oldSW > 0) {
      mount.scrollTo({
        top: Math.max(0, Math.min(estNewTop, estMaxTop)),
        left: Math.max(0, Math.min(estNewLeft, estMaxLeft)),
        behavior: 'instant',
      });
    }

    // ═══ PHASE 2 (async): fine-tune using actual layout dimensions ═══
    const timer = setTimeout(() => {
      if (!mount) return;
      const newCH = mount.clientHeight;
      const newCW = mount.clientWidth;
      const newSH = mount.scrollHeight;
      const newSW = mount.scrollWidth;

      // Vertical
      const vpCenterY = captured.scrollTop + oldCH / 2;
      const scaleY = oldSH > 0 ? newSH / oldSH : 1;
      const newTop = vpCenterY * scaleY - newCH / 2;

      // Horizontal (with actual new centering offset)
      const newContentFits = newSW <= newCW + 1;
      const newHOffset = newContentFits ? (newCW - newSW) / 2 : 0;
      const scaleX = oldSW > 0 ? newSW / oldSW : 1;
      const newLeft = contentCenterX * scaleX + newHOffset - newCW / 2;

      const maxTop = Math.max(0, newSH - newCH);
      const maxLeft = Math.max(0, newSW - newCW);

      const hChanged = oldSH !== newSH;
      const wChanged = oldSW !== newSW;

      if (isDebugZooming()) {
        console.log('[zoom-img-scrolling] center-anchor fine-tune', {
          zoom, fitMode, oldZoom, zoomRatio,
          savedScrollTop: captured.scrollTop, savedScrollHeight: oldSH,
          savedScrollLeft: captured.scrollLeft, savedScrollWidth: oldSW,
          oldClientH: oldCH, oldClientW: oldCW,
          newClientH: newCH, newClientW: newCW,
          oldContentFits, newContentFits,
          oldHOffset, newHOffset,
          contentCenterX, scaleX, scaleY,
          estNewTop, estNewLeft,
          finalNewTop: newTop, finalNewLeft: newLeft,
          curH: newSH, curW: newSW,
          hChanged, wChanged,
        });
      }
      if (hChanged || wChanged) {
        mount.scrollTo({
          top: Math.max(0, Math.min(newTop, maxTop)),
          left: Math.max(0, Math.min(newLeft, maxLeft)),
          behavior: 'instant',
        });
      }
      // Update the ref's zoom so the NEXT zoom change uses correct oldZoom
      zoomAnchorRef.current = { ...captured, zoom };
    }, 0);

    // Only clear the timer if the zoom/fitMode key has changed (meaning a
    // genuinely new zoom level, not just a re-run from contentWidth resize).
    // Otherwise the first (correct) capture's timer would be cancelled.
    return () => {
      if (zoomAnchorRef.current.key !== anchorKey) {
        clearTimeout(timer);
      }
    };
  }, [isImageMode, mode, zoom, fitMode, fitRefreshToken, contentWidth]);

  // Scroll position in scrolling mode is user-controlled — no auto-scroll on page change

  return (
    <section
      className="page-frame page-card pdf-pane"
      data-annotation-language={paneLanguage}
    >
      {!hideHeader && (
      <header className="page-card-header">
        {title != null && <strong className="header-book">{title}</strong>}
        {section != null && (
          <>
            <span className="header-sep">·</span>
            <span className="header-section">§{section}</span>
          </>
        )}
        <button
          className="header-fullscreen-btn"
          onClick={() => {
            if (document.fullscreenElement) {
              document.exitFullscreen?.();
            } else {
              document.documentElement.requestFullscreen?.();
            }
          }}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          <svg viewBox="0 0 24 24" role="presentation" focusable="false">
            {isFullscreen ? (
              <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
            ) : (
              <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
            )}
          </svg>
        </button>
      </header>
      )}
      <div className={`pdf-pane-shell ${thumbnailsOpen ? 'thumbs-open' : 'thumbs-closed'}`}>
        {!thumbnailsOpen && (
        <aside className="thumbnail-rail" aria-hidden={!thumbnailsOpen}>
          <div className="thumbnail-list">
            {thumbs.map((thumb) => (
              <button
                key={thumb.page}
                className={`thumb-item ${thumb.page === renderedPage ? 'active' : ''}`}
                onMouseEnter={() => console.log(`[rail] hover enter page ${thumb.page}`)}
                onMouseLeave={() => console.log(`[rail] hover leave page ${thumb.page}`)}
                onClick={() => {
                  console.log(`[rail] CLICK page ${thumb.page}`);
                  if (onThumbnailClick) {
                    onThumbnailClick(thumb.page);
                  } else {
                    onPageChange(thumb.page);
                  }
                }}
              >
                <img
                  src={thumb.url}
                  alt={`${_('pageN')} ${thumb.page}`}
                  onError={(e) => { e.target.style.visibility = 'hidden'; }}
                />
                <span>{thumb.page}</span>
              </button>
            ))}
          </div>
        </aside>
        )}

        <div className={`pdf-content${thumbnailsOpen ? ' thumbs-mode' : ''}`} ref={contentRef} key={mode}>
          {thumbnailsOpen ? (
            <div
              className="thumbnail-grid"
              ref={thumbGridRef}
              style={{ gridTemplateColumns: `repeat(${Math.max(1, thumbCols)}, 1fr)` }}
            >
                {thumbs.map((thumb, idx) => (
                  <button
                    key={thumb.page}
                    data-thumb-index={idx}
                    className={`thumb-grid-item${thumb.page === renderedPage ? ' active' : ''}${idx === thumbFocusIndex ? ' focused' : ''}`}
                    onClick={() => {
                      if (onThumbnailClick) {
                        onThumbnailClick(thumb.page);
                      } else {
                        onPageChange(thumb.page);
                      }
                    }}
                  >
                    <img
                  src={thumb.url}
                  alt={`${_('pageN')} ${thumb.page}`}
                  data-page={thumb.page}
                  onError={(e) => { e.target.style.visibility = 'hidden'; }}
                />
                    <span>{thumb.page}</span>
                  </button>
                ))}
              </div>
          ) : loadError ? (
            <div className="pdf-error">
              <p>{_('failedToLoadPdf')}</p>
              <small>{loadError}</small>
            </div>
          ) : isImageMode && mode === 'pagination' ? (
            (() => {
              const isBlankPage = currentPage > images.length;
              const imgSrc = !isBlankPage ? images[currentPage - 1] || '' : '';
              const imageStyle = fitMode === 'height'
                ? {
                    width: 'auto',
                    height: `${100 * zoom}%`,
                    display: 'block',
                    flexShrink: 0,
                    maxWidth: 'none',
                    maxHeight: 'none',
                  }
                : {
                    width: `${100 * zoom}%`,
                    height: 'auto',
                    display: 'block',
                    flexShrink: 0,
                    maxHeight: 'none',
                  };
              return (
            <div
              className="pdf-single-page"
              style={paginationPaneStyle}
            >
              {isBlankPage ? (
                <div
                  ref={blankRef}
                  className="page-img pdf-blank-page"
                  style={{ ...imageStyle, minHeight: '120px', background: '#fff' }}
                  data-page={currentPage}
                  data-blank="true"
                />
              ) : imgSrc ? (
                <img
                  ref={imgRef}
                  src={withTimestamp(imgSrc)}
                  alt={`${_('pageN')} ${currentPage}`}
                  className="page-img"
                  onLoad={handleImageLoad}
                  onError={(e) => {
                    // Hide the broken-image icon; placeholder background shows instead
                    e.target.style.visibility = 'hidden';
                  }}
                  style={imageStyle}
                />
              ) : (
                <div className="page-img" style={{ ...imageStyle, minHeight: '120px' }} />
              )}
            </div>
              );
            })()
          ) : !isImageMode && mode === 'pagination' ? (
            <div className="pdf-single-page" style={paginationPaneStyle}>
              <canvas ref={canvasRef} />
            </div>
          ) : (
            <div ref={scrollRef} className="pdf-scroll-pages" />
          )}
        </div>
      </div>
    </section>
  );
}

export default PdfPane;

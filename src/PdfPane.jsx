import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.js?url';
import { t, uiLang } from './i18n';
import { isDebugLoadingPageImages, isDebugScrollingPersistence, isDebugZooming } from './debug';
import { mySetScrollTop, mySetScrollLeft, myScrollTo, getScrollPos } from './MyScroll';
import { loadScrollPos, saveScrollPos, flushScrollStorage } from './myLocalStorage';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

/**
 * Returns true when the page URL contains ?test=1, enabling in-UI
 * debug indicators on the loading overlay for diagnosing stuck loads.
 */
function isTestMode() {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has('test');
  } catch { return false; }
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
 * Find the page element that CONTAINS the given scrollTop.
 *
 * "Nearest offsetTop" (geometrically closest) picks the wrong page
 * whenever scrollTop is past the midpoint of a page.  This finds the
 * last page whose offsetTop ≤ scrollTop — the page the user is IN.
 *
 * @param {HTMLElement} mount - scrollable container with [data-page] children
 * @param {number} scrollTop - current scrollTop of the container
 * @returns {{ page: number, pageEl: Element | null }}
 */
function findContainingPage(mount, scrollTop) {
  const nodes = mount.querySelectorAll('[data-page]');
  let page = 1;
  let pageEl = null;
  for (const node of nodes) {
    if (node.offsetTop <= scrollTop) {
      page = Number(node.dataset.page);
      pageEl = node;
    } else {
      break; // pages are in DOM order — remaining start after scrollTop
    }
  }
  return { page, pageEl };
}

/**
 * Build the scroll-position localStorage key from the source string.
 *
 * Two source formats are supported:
 *
 *   1. Image mode:   "img:book:chapter:file:lang"
 *      → key: "scroll-{book}-{chapter}"  (e.g. "scroll-biology-oup-1a")
 *
 *   2. PDF mode:     URL like "/pdf-reader/data/book/chapter/lang/file.pdf"
 *      → key: "scroll-{book}-{chapter}"  (extracted from URL path segments)
 *
 * This namespaces scroll positions per subject+chapter so the same chapter
 * ID (e.g. "1a") across different books doesn't collide.
 *
 * @param {string} source - source identifier string
 * @returns {string} localStorage key
 */
function getScrollCacheKey(source) {
  if (!source) return 'scroll-default';

  // Image-mode format: "img:book:chapter:file:lang"
  const parts = String(source).split(':');
  if (parts.length >= 4 && parts[0] === 'img') {
    const book = parts[1] || 'default';
    const chapter = parts[2] || 'default';
    return `scroll-${book}-${chapter}`;
  }

  // PDF-mode format: URL like "/pdf-reader/data/book/chapter/lang/file.pdf"
  // Extract book + chapter from path segments.  Common patterns:
  //   /pdf-reader/data/biology-oup/1a/en/1.pdf
  //   /data/biology-oup/1a/en/1.pdf
  try {
    const url = new URL(String(source), 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    // Look for a "data" segment followed by book and chapter
    const dataIdx = segments.indexOf('data');
    if (dataIdx >= 0 && segments.length > dataIdx + 2) {
      const book = segments[dataIdx + 1] || 'default';
      const chapter = segments[dataIdx + 2] || 'default';
      return `scroll-${book}-${chapter}`;
    }
    // Fallback: if path has at least 2 segments, use last two meaningful ones
    if (segments.length >= 3) {
      // Try to find the book (second-to-last or third-to-last segment
      // before the language code, which is typically 'en' or 'tc')
      const langIdx = segments.findIndex(s => s === 'en' || s === 'tc');
      if (langIdx >= 2) {
        const book = segments[langIdx - 2] || 'default';
        const chapter = segments[langIdx - 1] || 'default';
        return `scroll-${book}-${chapter}`;
      }
    }
  } catch {
    // URL parsing failed — fall through to default
  }

  // Legacy/fallback: try colon-separated format anyway
  const book = parts[1] || 'default';
  const chapter = parts[2] || 'default';
  return `scroll-${book}-${chapter}`;
}

/**
 * Reliably get the displayed height of a page element, trying multiple
 * sources.  getBoundingClientRect() can return 0 or a tiny value before
 * the CSS height rule (e.g. bilingual "height: Npx !important") takes
 * effect.  getComputedStyle() catches !important rules even before the
 * first paint, making it the most reliable source.
 *
 * @param {Element} pageEl
 * @returns {number} page height in px, at least 1
 */
function getPageHeight(pageEl) {
  if (!pageEl || typeof window === 'undefined') return 1;
  // 1. Computed style — returns CSS height even before layout (catches !important)
  const cs = window.getComputedStyle(pageEl);
  const csH = parseFloat(cs.height);
  if (csH > 1) return csH;
  // 2. Rendered height (forces layout, accurate after paint)
  const rectH = pageEl.getBoundingClientRect().height;
  if (rectH > 1) return rectH;
  // 3. Layout height
  if (pageEl.offsetHeight > 1) return pageEl.offsetHeight;
  // 4. Inline style
  const inlineH = parseFloat(pageEl.style.height);
  if (inlineH > 1) return inlineH;
  return 1;
}

/**
 * Convert a saved scroll-top value into a pixel offset from the top of
 * the given page element, correctly handling both storage formats:
 *
 *   New (fraction):  0 ≤ value ≤ 1  →  fraction × pageHeight
 *   Old (pixels):    value > 1      →  use as-is (backward compat)
 *
 * Fractions are invariant to zoom, viewport size, and image-load state.
 * When a stored pageHeight is available, it is preferred over measuring
 * the DOM (which may return 0 before CSS heights are applied).
 *
 * @param {number|null|undefined} savedTop - stored top value
 * @param {Element|null} pageEl - the target page element (fallback)
 * @param {number} [storedPageHeight] - page height from localStorage
 * @returns {number} pixel offset from the top of the page element
 */
function resolveScrollOffset(savedTop, pageEl, storedPageHeight) {
  if (savedTop == null) return 0;
  // New format: fraction of page height (0–1)
  if (savedTop <= 1 && savedTop >= 0) {
    const pageHeight = storedPageHeight || getPageHeight(pageEl);
    return Math.max(0, savedTop * pageHeight);
  }
  // Old format: absolute pixel offset
  return Math.max(0, savedTop);
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
let _bilingualRepositioning = false;  // true while repositionBilingualPages is adjusting scrollTop
let _scrollRestoreInProgress = false; // true while a saved scroll position is being restored — suppresses saveScrollNow so the fraction is not recomputed before the layout stabilises

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

/**
 * Dynamically inject / update a CSS rule that locks ALL .page-img elements
 * in the bilingual layout to the shared maxHeight with !important.
 * This runs once when the max is established — no per-element inline needed.
 */
function updateBilingualPageHeightCSS(maxH) {
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

}

function repositionBilingualPages(mount, syncGroup) {
  const maxH = _bilingualMaxHeights.get(syncGroup) || 0;
  if (!maxH) { return; }

  // Find all page elements
  const children = mount.querySelectorAll('[data-page]');
  if (!children.length) return;

  // Skip everything if layout hasn't changed — prevents visual jump
  // when this function is called mid-scroll by resize observers.
  // The spacer is always 0px (pages provide their own scroll extent in
  // block layout), so just check that a spacer exists.
  const existingSpacer = mount.querySelector('.bilingual-scroll-spacer');
  const spacerExists = !!existingSpacer;
  // Also check whether CSS rule is already correct (injected via style element)
  const styleEl = document.getElementById('bilingual-page-height-css');
  const cssSame = styleEl && styleEl.textContent.includes(`height: ${maxH}px`);
  if (spacerExists && cssSame) {
    return;
  }

  // Dynamically inject/update the CSS rule locking all .page-img heights.
  updateBilingualPageHeightCSS(maxH);

  const oldScrollHeight = Math.max(1, mount.scrollHeight);
  const oldScrollTop = getScrollPos(mount).scrollTop;

  // ── Remove old spacer so it can be re-added at end ──────
  const oldSpacer = mount.querySelector('.bilingual-scroll-spacer');
  if (oldSpacer) oldSpacer.remove();

  // ── Sort children by page number in the DOM ──────────────
  const sorted = Array.from(children).sort(
    (a, b) => (parseInt(a.dataset.page) || 0) - (parseInt(b.dataset.page) || 0)
  );
  sorted.forEach((child) => mount.appendChild(child));

  // ── Reset inline positioning on children ────────────────
  sorted.forEach((child) => {
    child.style.position = '';
    child.style.top = '';
    child.style.left = '';
    child.style.right = '';
    child.style.marginLeft = '';
    child.style.marginRight = '';
    // Blank pages use flexbox for centering the page number — preserve
    // display:flex from CSS (.pdf-blank-page) instead of overriding to block.
    if (child.dataset.blank === 'true') {
      child.style.display = 'flex';
      child.style.setProperty('height', `${maxH}px`, 'important');
    } else {
      child.style.display = 'block';
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

  // Pages are in normal block flow and already provide the correct
  // scrollable content area for iOS -webkit-overflow-scrolling: touch.
  // The spacer is kept as an invisible element (height:0) so that the
  // early-exit check (spacerSame) still works — it prevents redundant
  // repositioning when maxH hasn't changed.
  const totalPages = children.length;
  let spacer = mount.querySelector('.bilingual-scroll-spacer');
  if (!spacer) {
    spacer = document.createElement('div');
    spacer.className = 'bilingual-scroll-spacer';
    spacer.style.cssText = 'width:1px;pointer-events:none;opacity:0;position:static;';
    mount.appendChild(spacer);
  }
  spacer.style.height = '0px';

  // Proportionally restore scroll position after height change.
  // Set _bilingualRepositioning so the scroll event handler suppresses
  // onPageChange — otherwise syncPageIndicator may detect a different page
  // due to rounding and cause an unwanted page jump (e.g. 9 → 8).
  const newScrollHeight = Math.max(1, mount.scrollHeight);
  if (newScrollHeight !== oldScrollHeight) {
    _bilingualRepositioning = true;
    mySetScrollTop(mount, oldScrollTop * (newScrollHeight / oldScrollHeight));
    // Reset on the next macrotask so the rAF-deferred syncPageIndicator
    // still sees the flag, but subsequent user scrolls do not.
    setTimeout(() => { _bilingualRepositioning = false; }, 0);
  }
}

function updateBilingualMaxHeight(syncGroup, localMax) {
  const current = _bilingualMaxHeights.get(syncGroup) || 0;
  const next = Math.max(current, Math.round(localMax));
  _bilingualMaxHeights.set(syncGroup, next);
  return next;
}

function normalizeBilingualHeights(mount, syncGroup, reset = false) {
  const children = mount.querySelectorAll('[data-page]');
  if (!children.length) return;

  // Measure local max from actual rendered heights
  let localMax = 0;
  children.forEach((child) => {
    const h = child.getBoundingClientRect().height;
    if (h > localMax) localMax = h;
  });

  // Update shared max (both panes contribute to the same Map entry).
  // When reset is true, discard previous max so the value can shrink
  // (e.g. after fit-refresh or window resize to smaller dimensions).
  // Only reset if we measured a height that's close to the existing
  // shared max — a tiny measurement means the CSS rule hasn't taken
  // effect yet and we must keep the pre-computed value.
  if (reset && localMax > 0) {
    const existing = _bilingualMaxHeights.get(syncGroup) || 0;
    if (existing === 0 || localMax >= existing * 0.5) {
      _bilingualMaxHeights.delete(syncGroup);
    }
  }
  const prevMax = _bilingualMaxHeights.get(syncGroup) || 0;
  const newMax = updateBilingualMaxHeight(syncGroup, localMax);

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
  const [showLoadingOverlay, setShowLoadingOverlay] = useState(true);
  const [loadDebugText, setLoadDebugText] = useState('init');

  // Safety timeout: dismiss loading overlay after 5s regardless of mode.
  // Covers Chrome iOS where pagination-mode images may not fire onLoad.
  useEffect(() => {
    if (!showLoadingOverlay) return;
    const timer = setTimeout(() => {
      setShowLoadingOverlay(false);
      if (isTestMode()) setLoadDebugText((prev) => prev + ' | timeout-fallback');
    }, 5000);
    return () => clearTimeout(timer);
  }, [showLoadingOverlay, isImageMode]);
  const canvasRef = useRef(null);
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const thumbGridRef = useRef(null);
  const blankRef = useRef(null);
  const currentPageRef = useRef(currentPage);
  const renderedPageRef = useRef(1);
  const syncingFromRemoteRef = useRef(false);
  const programmaticScrollingRef = useRef(false);  // true while the scroll-to-page effect is scrolling (per-instance, not shared across panes)
  const postRestoreUntilRef = useRef(0);     // timestamp: suppress saveScrollNow for detected-page changes until this time
  const lastRestoredPageRef = useRef(0);      // page number that was just restored — if saveScrollNow detects a different page within the grace period, skip
  const modeGenRef = useRef(0);
  const scrollRestoredRef = useRef(false);
  const isInitialLoadRef = useRef(true);  // true until first content load completes
  const syncGroupRef = useRef(syncGroup);
  const paneLanguageRef = useRef(paneLanguage);
  // source format: img:book:chapter:file:lang — extract chapter for storage key
  const chapterRef = useRef('default');
  // Tracks the source that was used to build the CURRENT DOM content.
  // Needed by the pre-rebuild save — when the effect re-runs with a new
  // source (e.g. subject/language switch), `source` already points to the
  // NEW subject, but the DOM still has the OLD subject's pages.  We must
  // save the old position under the OLD key, not the new one.
  const activeDomSourceRef = useRef(source || '');
  // Keep refs in sync so the pagehide handler (which runs in an effect with
  // empty deps) can still access the latest values.
  useEffect(() => { syncGroupRef.current = syncGroup; }, [syncGroup]);
  useEffect(() => { paneLanguageRef.current = paneLanguage; }, [paneLanguage]);
  useEffect(() => {
    const parts = String(source || '').split(':');
    chapterRef.current = parts[2] || 'default';
  }, [source]);
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

  // ── Scroll active thumbnail to center when page changes ──
  useEffect(() => {
    if (!thumbnailsOpen) return;
    const grid = thumbGridRef.current;
    if (!grid) return;
    const activeBtn = grid.querySelector(`.thumb-grid-item.active`);
    if (activeBtn) {
      // Center the active thumbnail in the grid without animation.
      const gridRect = grid.getBoundingClientRect();
      const btnRect = activeBtn.getBoundingClientRect();
      const targetScrollTop = grid.scrollTop + (btnRect.top - gridRect.top) - (gridRect.height - btnRect.height) / 2;
      grid.scrollTop = Math.max(0, targetScrollTop);
    }
  }, [thumbnailsOpen, renderedPage]);

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
    const thumbData = images.map((item, i) => ({
      page: i + 1,
      url: typeof item === 'string' ? item : item?.url || ''
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
    setShowLoadingOverlay(false);
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
      const stored = loadScrollPos(source);
      const holderPos = getScrollPos(holder);
      const useStored = stored && holderPos.scrollTop === 0 && holderPos.scrollLeft === 0;
      if (isDebugScrollingPersistence()) console.log(`[scroll-load] ${source}  pagination  stored=${!!stored}  useStored=${useStored}  top=${stored?.top}`);
      if (useStored) scrollRestoredRef.current = true;
      const oldScrollTop = useStored ? stored.top : holderPos.scrollTop;
      const oldScrollLeft = useStored ? stored.left : holderPos.scrollLeft;
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
      if ((heightChanged || widthChanged) && !_scrollRestoreInProgress) {
        myScrollTo(holder, centerAnchoredScroll(holder, oldScrollTop, oldScrollHeight, 'both', oldScrollLeft, oldScrollWidth, oldClientHeight, oldClientWidth));
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
      if ((postHeightChanged || postWidthChanged) && !_scrollRestoreInProgress) {
        myScrollTo(holder, centerAnchoredScroll(holder, oldScrollTop, oldScrollHeight, 'both', oldScrollLeft, oldScrollWidth, oldClientHeight, oldClientWidth));
      }
      setRenderedPage(currentPage);
      // Don't fire onPageChange for blank pages — the page number is intentionally
      // beyond this version's count and the parent already knows about it.
    };

    draw();
  }, [isImageMode, pdfDoc, currentPage, numPages, mode, onPageChange, zoom, contentWidth, contentHeight, fitMode, fitRefreshToken]);

  // ── Clamp scroll in pagination mode ─────────────────────
  // Prevents the page from drifting past its edges
  // (especially in fit-height mode where maxWidth is "none").
  useEffect(() => {
    if (mode !== 'pagination') return;
    // Find the scroll container — works for both PDF (canvas) and image modes
    const holder = canvasRef.current?.parentElement
      || imgRef.current?.closest('.pdf-single-page')
      || contentRef.current?.querySelector('.pdf-single-page');
    if (!holder) return;

    const onScroll = () => {
      // Horizontal clamp
      const maxScrollLeft = Math.max(0, holder.scrollWidth - holder.clientWidth);
      const holderScrollLeft = getScrollPos(holder).scrollLeft;
      if (holderScrollLeft > maxScrollLeft) {
        mySetScrollLeft(holder, maxScrollLeft);
      } else if (holderScrollLeft < 0) {
        mySetScrollLeft(holder, 0);
      }
      // Vertical clamp — never scroll past the last page content
      const maxScrollTop = Math.max(0, holder.scrollHeight - holder.clientHeight);
      const holderScrollTop = getScrollPos(holder).scrollTop;
      if (holderScrollTop > maxScrollTop) {
        mySetScrollTop(holder, maxScrollTop);
      } else if (holderScrollTop < 0) {
        mySetScrollTop(holder, 0);
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
      const stored = loadScrollPos(source);
      if (isDebugScrollingPersistence()) console.log(`[scroll-load] ${source}  img-pagination  stored=${!!stored}  top=${stored?.top}`);
      if (stored && stored.top > 0) {
        top = stored.top;
        left = stored.left || 0;
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
    if ((heightChanged || widthChanged) && !_scrollRestoreInProgress) {
      const oldCH = clientHeight > 0 ? clientHeight : container.clientHeight;
      const oldCW = clientWidth > 0 ? clientWidth : container.clientWidth;
      myScrollTo(container, centerAnchoredScroll(container, top, height, 'both', left, width, oldCH, oldCW));
    } else if (height === 0 && top > 0) {
      // Initial load with stored position but same dimensions — apply directly
      mySetScrollTop(container, top);
      mySetScrollLeft(container, left);
    }
    const containerPos = getScrollPos(container);
    imgPaginationScrollRef.current = {
      top: containerPos.scrollTop,
      left: containerPos.scrollLeft,
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
    // Bilingual mode: wait until maxPagesInGroup is known.
    if (syncGroup && !maxPagesInGroup) return;
    const mount = scrollRef.current;
    if (!mount) return;

    // If there is a saved scroll position, mark scrollRestoredRef now
    // so the scroll-to-page useEffect (which runs synchronously after
    // render) skips its scroll-to-currentPage call.
    const storedPos = loadScrollPos(source);
    if (storedPos && typeof storedPos.top === 'number') {
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
      const stored = loadScrollPos(source);
      const mountPos = getScrollPos(mount);
      const useStored = stored && mountPos.scrollTop === 0 && mountPos.scrollLeft === 0;
      if (isDebugScrollingPersistence()) console.log(`[scroll-load] ${source}  pdf-scrolling  stored=${!!stored}  top=${stored?.top}  mountScrollTop=${Math.round(mountPos.scrollTop)}`);
      if (useStored) scrollRestoredRef.current = true;
      anchor = {
        key: anchorKey,
        scrollTop: useStored ? stored.top : mountPos.scrollTop,
        scrollLeft: useStored ? stored.left : mountPos.scrollLeft,
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
        const drawStartPos = getScrollPos(mount);
        console.log('[zoom-pdf-scrolling] drawAll start', {
          zoom, fitMode, baseWidth, containerHeight, containerWidth,
          isBilingual, numPages, maxPagesInGroup,
          currentScrollTop: drawStartPos.scrollTop, currentScrollLeft: drawStartPos.scrollLeft,
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
          // Keep display:flex from CSS for vertical+horizontal centering of page number
          blankPage.dataset.page = String(p);
          blankPage.dataset.blank = 'true';
          fragment.appendChild(blankPage);
        }
      }

      if (disposed || modeGenRef.current !== gen) return;

      // ── Save current scroll position BEFORE clearing the DOM ──
      // Ensures the last-viewed position is preserved in localStorage when
      // the user switches subject/book/language without a recent scroll.
      // Only fires when the source has CHANGED (activeDomSourceRef differs
      // from current source) — on initial load they are equal, so we skip
      // to avoid overwriting the real saved position with (0,0) defaults.
      if (mount.scrollHeight > 0 && activeDomSourceRef.current && activeDomSourceRef.current !== (source || '')) {
        const prevDomKey = getScrollCacheKey(activeDomSourceRef.current || source);
        const prePos = getScrollPos(mount);
        const { page: prePage, pageEl: prePageEl } = findContainingPage(mount, prePos.scrollTop);
        const preRelTop = prePageEl ? Math.max(0, prePos.scrollTop - prePageEl.offsetTop) : prePos.scrollTop;
        const preDispH = getPageHeight(prePageEl);
        const preFrac = preDispH > 0 ? Math.min(1, Math.max(0, preRelTop / preDispH)) : 0;
        saveScrollPos(prevDomKey, { top: preFrac, left: prePos.scrollLeft, page: prePage, pageHeight: Math.round(preDispH) });
        flushScrollStorage(); // persist immediately — next render may clear the DOM
        if (isDebugScrollingPersistence()) {
          console.log(`[scroll-save] ${prevDomKey}  PRE-REBUILD  page=${prePage}  fraction=${preFrac.toFixed(4)}  ph=${Math.round(preDispH)}  oldSource=${activeDomSourceRef.current}  newSource=${source}`);
        }
      }

      // Scroll position was already captured at the effect level (zoomAnchorRef).
      // Read from the ref — NOT from mount — because a second effect run may
      // have already cleared the mount's innerHTML.

      mount.innerHTML = '';
      mount.appendChild(fragment);

      // Track which source built this DOM so the pre-rebuild save uses the
      // correct key on the next effect run (e.g. after a subject/book switch).
      activeDomSourceRef.current = source || '';

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
        const top = getScrollPos(mount).scrollTop;
        // Containing page (offsetTop ≤ scrollTop), not geometrically nearest.
        const { page: nearest } = findContainingPage(mount, top);
        // Only update React state when the page actually changes to avoid
        // unnecessary re-renders that cause flickering during scroll.
        if (nearest !== renderedPageRef.current) {
          setRenderedPage(nearest);
          // Suppress onPageChange when this scroll was triggered by a remote
          // sync — the initiating pane already reported the correct page.
          // Also suppress during bilingual repositioning to avoid false
          // page-change detections from proportional scroll adjustment.
          if (!syncingFromRemoteRef.current && !_bilingualRepositioning && !programmaticScrollingRef.current) {
            lastScrolledFromSyncRef.current = true;
            onPageChange(nearest);
          }
        }
        return nearest;
      };

      let scrollRafId = null;
      let pendingScrollSync = false;
      const scrollCacheKey = getScrollCacheKey(source);
      const onScroll = () => {
        // Throttle scroll handling to once per animation frame to avoid
        // layout thrashing and flickering on iOS/mobile devices.
        // Skip entirely when this scroll was triggered by a remote sync —
        // DOM queries (querySelectorAll + offsetTop) are expensive on iOS
        // and kill momentum scrolling in bilingual mode.
        // Also skip during bilingual repositioning to avoid redundant
        // syncPageIndicator calls and cross-pane scroll-sync dispatches.
        if (!pendingScrollSync && !syncingFromRemoteRef.current && !_bilingualRepositioning && !programmaticScrollingRef.current) {
          pendingScrollSync = true;
          scrollRafId = requestAnimationFrame(() => {
            pendingScrollSync = false;
            if (disposed || modeGenRef.current !== gen) return;

            // Clamp vertical scroll — never scroll past the last page content
            const clampPos = getScrollPos(mount);
            const maxTop = Math.max(0, mount.scrollHeight - mount.clientHeight);
            if (clampPos.scrollTop > maxTop) {
              mySetScrollTop(mount, maxTop);
            }

            syncPageIndicator();

            // Save scroll position as fraction of page height — same
            // format as the image-scrolling mode for consistency.
            if (!isInitialLoadRef.current && !programmaticScrollingRef.current) {
              const savePos = getScrollPos(mount);
              const top = savePos.scrollTop;
              const { page, pageEl } = findContainingPage(mount, top);
              const relativeTop = pageEl ? Math.max(0, top - pageEl.offsetTop) : top;
              const pageHeight = getPageHeight(pageEl);
              const fraction = pageHeight > 0 ? Math.min(1, Math.max(0, relativeTop / pageHeight)) : 0;
              saveScrollPos(scrollCacheKey, { top: fraction, left: savePos.scrollLeft, page, pageHeight: Math.round(pageHeight) });
              if (isDebugScrollingPersistence()) {
                console.log(`[scroll-save] ${scrollCacheKey}  p=${page}  t=${fraction.toFixed(4)}  scrollTop=${Math.round(top)}  ph=${Math.round(pageHeight)}`);
              }
            }

            if (syncGroup && !syncingFromRemoteRef.current && !isInitialLoadRef.current) {
              const max = Math.max(1, mount.scrollHeight - mount.clientHeight);
              const syncPos = getScrollPos(mount);
              const ratio = syncPos.scrollTop / max;
              const hMax = Math.max(1, mount.scrollWidth - mount.clientWidth);
              const hRatio = hMax > 0 ? syncPos.scrollLeft / hMax : 0;
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
        // Scroll-position saving is handled by the image-scrolling effect
        // (onScrollWithSave) — no need to double-save here.
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
        if ((heightChanged || widthChanged) && !_scrollRestoreInProgress) {
          myScrollTo(mount, centerAnchoredScroll(
            mount,
            captured.scrollTop, captured.scrollHeight, 'both',
            captured.scrollLeft, captured.scrollWidth,
            captured.clientHeight, captured.clientWidth
          ));
        }

        // On initial load, override with the saved scroll position from a
        // previous session (stored in localStorage).
        if (isInitialLoadRef.current) {
          const saved = loadScrollPos(scrollCacheKey);
          if (saved && typeof saved.page === 'number' && saved.page >= 1) {
            const target = mount.querySelector(`[data-page="${saved.page}"]`);
            if (target) {
              const offset = resolveScrollOffset(saved.top, target);
              const restoreTop = target.offsetTop + offset;
              if (isDebugScrollingPersistence()) console.log(`[scroll-load] ${scrollCacheKey}  stored(p=${saved.page},t=${saved.top})  →  offsetTop=${Math.round(target.offsetTop)}  offset=${Math.round(offset)}px  scrollTo(left=${Math.round(saved.left||0)},top=${Math.round(restoreTop)})`);
              myScrollTo(mount, { left: saved.left || 0, top: restoreTop, behavior: 'instant' });
              scrollRestoredRef.current = true;
            } else {
              const allPages = [...mount.querySelectorAll('[data-page]')].map(el => el.dataset.page);
              if (isDebugScrollingPersistence()) console.log(`[scroll-load] ${scrollCacheKey}  DEFERRED page=${saved.page} not in DOM. present=[${allPages.join(',')}]`);
            }
            setRenderedPage(saved.page);
            onPageChange(saved.page);
          } else if (saved && typeof saved.top === 'number') {
            // Fallback for old-format data (absolute top, no page)
            if (isDebugScrollingPersistence()) console.log(`[scroll-load] ${scrollCacheKey}  LEGACY top=${saved.top}  scrollTo(left=${Math.round(saved.left)},top=${Math.round(saved.top)})`);
            myScrollTo(mount, { left: saved.left, top: saved.top, behavior: 'instant' });
            scrollRestoredRef.current = true;
            if (typeof saved.page === 'number' && saved.page >= 1) {
              setRenderedPage(saved.page);
              onPageChange(saved.page);
            }
          } else {
            if (isDebugScrollingPersistence()) console.log(`[scroll-load] ${scrollCacheKey}  (no saved position)`);
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
    // During initial load, scroll restoration is handled by
    // scheduleScrollToCurrent — do NOT interfere by scrolling to
    // currentPage here.  Let the restore logic settle first.
    if (isInitialLoadRef.current) return;
    // If the DOM currently showing was built for a different source
    // (subject/book/language switch in progress), suppress this scroll.
    // The parent may have already set currentPage=1, but the DOM still
    // contains the OLD subject's content — scrolling it would move the
    // user away from their last-viewed position before the pre-rebuild
    // save can capture it.
    if (activeDomSourceRef.current && activeDomSourceRef.current !== (source || '')) return;
    const mount = scrollRef.current;
    if (!mount || !mount.children.length) return;
    // Skip if the page change was triggered by our own scroll sync
    // (e.g. onPageChange called from doScrollWork after natural scroll).
    if (lastScrolledFromSyncRef.current) {
      lastScrolledFromSyncRef.current = false;
      return;
    }
    const target = mount.querySelector(`[data-page="${currentPage}"]`);
    if (!target) {
      const allPages = [...mount.querySelectorAll('[data-page]')].map(el => el.dataset.page);
      if (isDebugScrollingPersistence()) console.log(`[scroll-to-page] MISS page=${currentPage} not in DOM. present=[${allPages.join(',')}]`);
      return;
    }

    // All images have explicit heights set (from API dimensions or the
    // bilingual CSS rule), so offsetTop is always correct — no clamping
    // or retry needed.  Just scroll to the target position.
    const targetTop = target.offsetTop;
    const currentScrollTop = getScrollPos(mount).scrollTop;
    const maxScroll = Math.max(0, mount.scrollHeight - mount.clientHeight);
    // If we're already at the target position (within a 2px tolerance
    // for sub-pixel rounding), skip the scroll entirely. This prevents
    // unnecessary scroll events, RAF handlers, and cross-pane sync
    // dispatches — especially important in bilingual mode where sync
    // events from the other pane may have already positioned us correctly.
    const scrollTarget = Math.min(targetTop, maxScroll);
    if (Math.abs(currentScrollTop - scrollTarget) <= 2) {
      return;
    }
    const chapter = String(source || '').split(':')[2] || '?';
    // Use the first page's offsetHeight as the authoritative page height.
    // All pages share the same height (from the bilingual CSS rule or
    // inline dimensions), so page 1's height represents every page.
    const firstPage = mount.querySelector('[data-page="1"]');
    const avgPageH = firstPage ? firstPage.offsetHeight : 0;
    console.log(
      `[trace] scroll-to-page  ${chapter}.${currentPage}  ` +
      `offsetTop=${Math.round(targetTop)}  avgPageH=offsetHeight(page1)=${avgPageH}  ` +
      `requested=${Math.round(scrollTarget)}  maxScroll=${Math.round(maxScroll)}  ` +
      `scrollHeight=${Math.round(mount.scrollHeight)}  clientHeight=${mount.clientHeight}`
    );

    programmaticScrollingRef.current = true;
    myScrollTo(mount, { top: scrollTarget, behavior: 'instant' });
    // Reset in next RAF so scroll events (sync or async) and any
    // previously-scheduled RAF callbacks still see the flag and skip
    // saving the programmatic position.
    const resetFlagRaf = requestAnimationFrame(() => {
      programmaticScrollingRef.current = false;
    });
    const actualPos = getScrollPos(mount);
    console.log(`[trace] scroll-to-page  RESULT  ${chapter}.${currentPage}  actualPage=${findContainingPage(mount, actualPos.scrollTop).page}  actualTop=${Math.round(actualPos.scrollTop)}`);

    // After scrolling, trigger background loading of ±3 pages so the
    // user sees continuous content when they scroll from the target.
    const loadWindow = 3;
    for (let p = Math.max(1, currentPage - loadWindow); p <= Math.min(currentPage + loadWindow, (numPages || images.length || 999)); p++) {
      const img = mount.querySelector(`img[data-page="${p}"]`);
      if (!img) continue;
      const url = img.dataset?.src;
      if (!url || img.src) continue;
      img.onload = () => { img.style.minHeight = ''; img.style.opacity = '1'; };
      img.onerror = () => { img.style.opacity = '0'; };
      img.src = url;
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

    let attachRetries = 0;
    const MAX_ATTACH_RETRIES = 20; // 20 × 200ms = 4 s

    const onScroll = () => {
      const container = saveContainerRef.current;
      if (!container) return;
      const cpos = getScrollPos(container);
      saveScrollPos(source, { left: cpos.scrollLeft, top: cpos.scrollTop, scrollHeight: container.scrollHeight, scrollWidth: container.scrollWidth });
      // Also save under the scroll-cache key so the position survives
      // display-mode switches (scrolling ↔ pagination).  The cache-key
      // format is used by scrolling mode for initial-load restoration.
      // Use currentPageRef (kept in sync via useEffect) instead of the
      // currentPage prop directly — the effect's dependency array does
      // not include currentPage, so the closure would be stale.
      const scrollCacheKey = getScrollCacheKey(source);
      saveScrollPos(scrollCacheKey, { top: cpos.scrollTop, left: cpos.scrollLeft, page: currentPageRef.current, scrollHeight: container.scrollHeight, scrollWidth: container.scrollWidth });
    };

    // Save immediately on page unload / tab hide so the latest position is never lost.
    // pagehide fires reliably across all browsers (unlike beforeunload which may
    // be skipped on Chrome desktop during certain navigation patterns).
    // Skip during initial load — the DOM hasn't settled yet and saving now
    // would overwrite the real saved position with (page=1, ph=1) defaults.
    const doSaveNow = () => {
      if (isInitialLoadRef.current) return;
      const container = saveContainerRef.current;
      if (!container || !source) return;
      const cpos2 = getScrollPos(container);
      saveScrollPos(source, { left: cpos2.scrollLeft, top: cpos2.scrollTop, scrollHeight: container.scrollHeight, scrollWidth: container.scrollWidth });
      // Also update the scroll-cache entry (used for initial-load restoration)
      const scrollCacheKey2 = getScrollCacheKey(source);
      saveScrollPos(scrollCacheKey2, { top: cpos2.scrollTop, left: cpos2.scrollLeft, page: currentPageRef.current });
      // Flush to localStorage immediately — don't wait for debounce.
      flushScrollStorage();
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
        if (isDebugScrollingPersistence()) console.log(`[scroll-save] attached listener  ${source}  scrollHeight=${container.scrollHeight}`);
        return true;
      }
      if (isDebugScrollingPersistence()) console.log(`[scroll-save] attach FAILED  ${source}  hasContainer=${!!container}`);
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
        window.removeEventListener('pagehide', doSaveNow);
        window.removeEventListener('visibilitychange', onVisibilityHidden);
        const c = saveContainerRef.current;
        if (c) { c.removeEventListener('scroll', onScroll); saveContainerRef.current = null; }
      };
    }

    return () => {
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
  //
  // source is included in the dependency array so the handler always
  // uses the correct scroll-cache key for the current subject/chapter.
  useEffect(() => {
    const saveAndFlush = () => {
      // Skip during initial load — the DOM hasn't settled yet and
      // saving now would overwrite the real saved position with
      // (page=1, ph=1) defaults from the unloaded state.
      if (isInitialLoadRef.current) return;
      // Skip during post-restore grace period — the re-save above already
      // stored the authoritative restored position.  Recomputing from DOM
      // here would capture the post-reposition (bilingual layout shift)
      // scrollTop, causing fraction drift on every reload cycle.
      if (Date.now() < postRestoreUntilRef.current && lastRestoredPageRef.current > 0) {
        if (isDebugScrollingPersistence()) console.log(`[scroll-save] ${getScrollCacheKey(source)}  SKIP pagehide flush — post-restore grace period, restored=p${lastRestoredPageRef.current}`);
        flushScrollStorage();
        return;
      }
      const mount = scrollRef.current;
      if (mount && mount.scrollHeight > 0) {
        const key = getScrollCacheKey(source);
        const savePos = getScrollPos(mount);
        const top = savePos.scrollTop;
        const { page, pageEl } = findContainingPage(mount, top);
        const relativeTop = pageEl ? Math.max(0, top - pageEl.offsetTop) : top;
        const pageHeight = getPageHeight(pageEl);
        const fraction = pageHeight > 0 ? Math.min(1, Math.max(0, relativeTop / pageHeight)) : 0;
        // Capture natural width for pw so it survives across reloads.
        const imgData = (page > 0 && page <= (images?.length || 0)) ? images[page - 1] : null;
        const natW = (imgData && typeof imgData === 'object') ? imgData.w : 0;
        saveScrollPos(key, { top: fraction, left: savePos.scrollLeft, page, pageHeight: Math.round(pageHeight), pageWidth: natW });
        if (isDebugScrollingPersistence()) {
          console.log(`[scroll-save] ${key}  p=${page}  t=${fraction.toFixed(4)}  scrollTop=${Math.round(top)}  scrollLeft=${Math.round(savePos.scrollLeft)}  ph=${Math.round(pageHeight)}  pw=${natW || '-'}`);
        }
      }
      flushScrollStorage();
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
  }, [source]);

  useEffect(() => {
    if (!syncGroup || mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount) return;

    const onSync = (event) => {
      const { group, sender, ratio, hRatio } = event.detail || {};
      if (group !== syncGroup || sender === syncId) return;
      // Never sync during initial load — both panes are independently
      // restoring their saved positions.  Cross-pane sync during this
      // phase creates feedback loops that pull both to page 1.
      if (isInitialLoadRef.current) return;
      const max = Math.max(0, mount.scrollHeight - mount.clientHeight);
      if (max === 0) return;
      const hMax = Math.max(0, mount.scrollWidth - mount.clientWidth);
      // Set both guards to prevent any scroll-back from the scroll-to-page
      // useEffect or the syncPageIndicator onPageChange callback.
      syncingFromRemoteRef.current = true;
      lastScrolledFromSyncRef.current = true;
      mySetScrollTop(mount, ratio * max);
      if (hMax > 0 && typeof hRatio === 'number') {
        mySetScrollLeft(mount, hRatio * hMax);
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
    if (!isImageMode || mode !== 'scrolling') {
      setLoadDebugText(`chk0: skip(isArray=${Array.isArray(images)} len=${images?.length} mode=${mode})`);
      return;
    }
    // Bilingual mode: wait until maxPagesInGroup is known before building
    // the DOM.  Without it, isBilingual=false and pages render without the
    // CSS height lock, breaking scroll-position restore.
    if (syncGroup && !maxPagesInGroup) { setLoadDebugText('chk1: wait(maxPages)'); return; }
    const mount = scrollRef.current;
    if (!mount) { setLoadDebugText('chk2: no mount'); return; }

    setLoadDebugText('chk3: entered');

    // Reset the initial-load flag so saveScrollNow (and cross-pane sync)
    // are suppressed until the saved scroll position is fully restored.
    // Without this, switching language triggers a save at scrollTop=0
    // before the restore runs, corrupting the stored position.
    isInitialLoadRef.current = true;

    // Must be declared OUTSIDE the try block so the cleanup return
    // (also outside try) can access them on unmount.
    let disposed = false;
    let scrollRafId2 = null;
    let pendingScroll2 = false;

    // If there is a saved scroll position for this source, mark it
    // NOW (synchronously) so the scroll-to-page useEffect skips its
    // scroll-to-currentPage call, which would otherwise overwrite the
    // saved position before the RAF restore has a chance to run.
    const storedPos = loadScrollPos(source);
    if (storedPos && typeof storedPos.top === 'number') {
      scrollRestoredRef.current = true;
    }

    // Helper: scroll so the current page is visible and update parent state
    const scrollToPage = (pageNum) => {
      const p = Math.max(1, Math.min(pageNum, images.length || 1));
      const n = mount.querySelector(`[data-page="${p}"]`);
      if (n) {
        myScrollTo(mount, { top: n.offsetTop, behavior: 'instant' });
      }
      setRenderedPage(p);
      onPageChange(p);
    };

    // Skip rebuild if images array hasn't changed AND maxPagesInGroup hasn't changed
    if (lastImagesRef.current === images && maxPagesInGroupRef.current === maxPagesInGroup && mount.children.length === images.length) {
      setLoadDebugText('chk3a: skip(no-rebuild)');
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

    // ── Save current scroll position BEFORE clearing the DOM ──
    // Ensures the last-viewed position is preserved in localStorage even
    // if the user switches subject/book/language without a recent scroll.
    // Only fires when the source has CHANGED (activeDomSourceRef differs
    // from current source) — on initial load they are equal, so we skip
    // to avoid overwriting the real saved position with (0,0) defaults.
    if (mount.scrollHeight > 0 && activeDomSourceRef.current && activeDomSourceRef.current !== (source || '')) {
      const preRebuildPos = getScrollPos(mount);
      const { page: prePage, pageEl: prePageEl } = findContainingPage(mount, preRebuildPos.scrollTop);
      const preRelTop = prePageEl ? Math.max(0, preRebuildPos.scrollTop - prePageEl.offsetTop) : preRebuildPos.scrollTop;
      const preDispH = getPageHeight(prePageEl);
      const preFrac = preDispH > 0 ? Math.min(1, Math.max(0, preRelTop / preDispH)) : 0;
      const prevDomKey = getScrollCacheKey(activeDomSourceRef.current || source);
      saveScrollPos(prevDomKey, { top: preFrac, left: preRebuildPos.scrollLeft, page: prePage, pageHeight: Math.round(preDispH) });
      flushScrollStorage(); // persist immediately — next render may clear the DOM
      if (isDebugScrollingPersistence()) {
        console.log(`[scroll-save] ${prevDomKey}  PRE-REBUILD  page=${prePage}  fraction=${preFrac.toFixed(4)}  ph=${Math.round(preDispH)}  oldSource=${activeDomSourceRef.current}  newSource=${source}`);
      }
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
    // Override CSS height:100% with an explicit pixel height matching the
    // available viewport.  height:100% on overflow:auto can cause WebKit
    // to add the container's box height to scrollHeight, creating blank
    // scrollable space past the last page.
    if (contentRef.current) {
      mount.style.height = `${contentRef.current.clientHeight}px`;
      mount.style.flex = '0 0 auto';
    }

    // In bilingual mode, inject the CSS height rule BEFORE any images enter
    // the DOM.  Uses actual image dimensions from the API to compute the
    // correct maxH — no more guessing with Math.SQRT2.
    if (isBilingual) {
      let maxH = 0;
      const displayW = Math.round(baseWidth * zoom);
      console.log(`[bilingual-maxH] computing from ${images.length} images  baseWidth=${baseWidth}  zoom=${zoom}  displayW=${displayW}`);
      for (const item of images) {
        const natW = typeof item === 'object' ? item.w : undefined;
        const natH = typeof item === 'object' ? item.h : undefined;
        if (natW && natH) {
          const displayH = Math.round(natH * displayW / natW);
          if (displayH > maxH) maxH = displayH;
        }
      }
      if (maxH === 0) {
        // Fallback for old-format images without dimensions
        maxH = Math.round(baseWidth * zoom * Math.SQRT2);
        console.log(`[bilingual-maxH] no dimensions available — using estimate: ${maxH}`);
      }
      // Always update the shared max — our computed value from actual
      // dimensions is more accurate than any previously estimated value.
      // Use the SHARED max for the CSS rule so both panes get the same height.
      const prev = _bilingualMaxHeights.get(syncGroup) || 0;
      _bilingualMaxHeights.set(syncGroup, Math.max(prev, maxH));
      const sharedMax = _bilingualMaxHeights.get(syncGroup);
      console.log(`[bilingual-maxH] maxH=${maxH}  prev=${prev}  sharedMax=${sharedMax}  displayW=${displayW}  baseWidth=${baseWidth}  zoom=${zoom}`);
      updateBilingualPageHeightCSS(sharedMax);
    }

    // Create all img elements first (without src) so DOM order is fixed.
    const mountH = Math.max(180, mount.getBoundingClientRect().height);
    let uniformImgHeight = null;
    const imgElements = images.map((item, idx) => {
      const pageNum = idx + 1;
      const img = document.createElement('img');
      img.alt = `${_('pageN')} ${pageNum}`;
      img.dataset.page = String(pageNum);
      img.className = 'page-img';
      // Support both old format (plain URL string) and new format ({ url, w, h })
      const url = typeof item === 'string' ? item : item?.url || '';
      const natW = typeof item === 'object' ? item.w : undefined;
      const natH = typeof item === 'object' ? item.h : undefined;
      img.dataset.src = url;

      if (isBilingual) {
        // width + height set below in the bilingual block
      } else if (fitMode === 'height') {
        const displayH = mountH * zoom;
        img.style.height = `${displayH}px`;
        // If natural dimensions are known, set explicit width so the browser
        // reserves correct space before the image loads.
        if (natW && natH) {
          img.style.width = `${Math.round(natW * displayH / natH)}px`;
        } else {
          img.style.width = 'auto';
        }
      } else {
        // fitMode === 'width' (default) or 'none'
        const displayW = baseWidth * zoom;
        img.style.width = `${displayW}px`;
        img.style.maxWidth = (fitMode === 'none') ? 'none' : '';
        // If natural dimensions are known, set explicit height so the browser
        // reserves correct space before the image loads — scrollHeight is
        // correct from the start, scroll restoration works instantly.
        if (natW && natH) {
          img.style.height = `${Math.round(natH * displayW / natW)}px`;
        } else {
          img.style.height = 'auto';
        }
      }
      img.style.display = 'block';
      if (!isBilingual) {
        img.style.minHeight = natW && natH ? '' : '120px';
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

    // ── Progressive DOM insertion ──────────────────────────
    // Only insert images within ±3 of the current page into the
    // initial DOM.  For all other pages, insert lightweight placeholder
    // <div> elements with the same explicit height so scrollHeight is
    // correct from the start.  The lazy loader replaces placeholders
    // with real <img> elements as the user scrolls near them.
    //
    // This keeps the initial render fast when switching subjects —
    // only ~7 pages hit the DOM synchronously instead of 50+.
    const INITIAL_WINDOW = 3;
    for (let i = 0; i < imgElements.length; i++) {
      const dist = Math.abs(i + 1 - currentPage);
      if (dist <= INITIAL_WINDOW || isBilingual) {
        // Bilingual: all pages must be real images because the CSS
        // height rule must apply to actual <img> elements.
        fragment.appendChild(imgElements[i]);
      } else {
        const img = imgElements[i];
        const ph = document.createElement('div');
        ph.className = 'page-img page-placeholder';
        ph.dataset.page = String(i + 1);
        ph.dataset.placeholder = 'true';
        if (img.style.height && img.style.height !== 'auto') {
          ph.style.height = img.style.height;
        } else {
          ph.style.minHeight = img.style.minHeight || '120px';
        }
        if (img.style.width && img.style.width !== 'auto') {
          ph.style.width = img.style.width;
        }
        ph.style.display = 'block';
        ph.style.opacity = '0';
        fragment.appendChild(ph);
      }
    }
    mount.appendChild(fragment);

    // Update refs after rebuild
    lastImagesRef.current = images;
    maxPagesInGroupRef.current = maxPagesInGroup;
    activeDomSourceRef.current = source || '';  // track which source built this DOM

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

    // disposed declared above (before try block) so cleanup return can set it
    // Bilingual: position every page at pageY = (pageIndex) × maxHeight
    // using absolute positioning.  Call immediately (all elements are in
    // the DOM), then re-run immediately as EACH image loads (so pages
    // centre without a visible flash on narrow stacked layouts), AND
    // keep a 150ms debounced safety net for late-arriving layout changes.
    if (isBilingual) {
      normalizeBilingualHeights(mount, syncGroup, false);
      let normalizeTimer = null;
      const scheduleNormalize = () => {
        if (normalizeTimer) clearTimeout(normalizeTimer);
        normalizeTimer = setTimeout(() => {
          if (disposed) return;
          normalizeBilingualHeights(mount, syncGroup, false);
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

    // Viewport-aware lazy loader — max 2 concurrent, preload 3 pages around current page.
    // Before the FIRST image loads, cap to 1 concurrent — the selected page must
    // paint as fast as possible before we waste bandwidth on surrounding pages.
    const PRELOAD_WINDOW = 3;
    let loading = 0;
    let _firstImageLoaded = false;
    const loadedSet = new Set(); // indices of pages loaded or currently loading
    // disposed declared above (before bilingual block)
    let lastVisiblePage = currentPage;

    const loadOne = (idx) => {
      if (idx < 0 || idx >= imgElements.length || disposed) return false;
      if (loadedSet.has(idx)) return false; // already loaded/loading
      // Before the first image finishes, only load one at a time so the
      // selected page gets all the bandwidth and paints immediately.
      if (loading >= (_firstImageLoaded ? 2 : 1)) return false;
      const img = imgElements[idx];
      const url = img.dataset.src;
      if (!url || img.src) return false;
      loadedSet.add(idx);
      loading++;
      const pageNum = idx + 1;
      if (isDebugLoadingPageImages()) {
        console.log(`[img-load] START  page=${pageNum}  concurrent=${loading}  url=${url?.substring(url.lastIndexOf('/') + 1)}`);
      }
      // Ensure the real <img> is in the DOM — it may have been deferred
      // as a placeholder during initial render (progressive insertion).
      if (!img.parentNode) {
        const placeholder = mount.querySelector(`[data-page="${pageNum}"][data-placeholder]`);
        if (placeholder) {
          placeholder.replaceWith(img);
        } else {
          // No placeholder found — insert after the preceding page element
          const prev = mount.querySelector(`[data-page="${idx}"]`);
          if (prev && prev.nextSibling) {
            prev.parentNode.insertBefore(img, prev.nextSibling);
          } else {
            mount.appendChild(img);
          }
        }
      }
      img.src = withTimestamp(url);
      img.onload = () => {
        loading--;
        const wasFirst = !_firstImageLoaded;
        _firstImageLoaded = true;
        if (isDebugLoadingPageImages()) {
          console.log(`[img-load] OK    page=${pageNum}  natural=${img.naturalWidth}×${img.naturalHeight}  displayed=${Math.round(img.getBoundingClientRect().width)}×${Math.round(img.getBoundingClientRect().height)}  concurrent=${loading}  scrollH=${Math.round(mount.scrollHeight)}  isInit=${isInitialLoadRef.current}  restoreInProgress=${_scrollRestoreInProgress}  wasFirst=${wasFirst}`);
        }
        // ── Anchor viewport center to prevent layout-shift jumps ──
        // When images expand from 120px min-height to full height, the
        // scrollHeight grows but the browser keeps scrollTop fixed — so
        // the same pixel offset now points to a different page.
        // Proportional adjustment preserves the scrollTop/scrollHeight
        // ratio, which is the same ratio set during initial restore.
        // Skip when a scroll restore is in progress — the restoration
        // itself will place the viewport correctly once all images are
        // loaded, and the proportional adjustment would fight against it.
        if (!isBilingual) {
          const oldScrollHeight = Math.max(1, mount.scrollHeight);
          const oldScrollTop = getScrollPos(mount).scrollTop;
          img.style.minHeight = '';
          img.style.opacity = '1';
          const newScrollHeight = Math.max(1, mount.scrollHeight);
          if (newScrollHeight !== oldScrollHeight && !_scrollRestoreInProgress) {
            const ratio = newScrollHeight / oldScrollHeight;
            if (isDebugLoadingPageImages()) {
              console.log(`[img-load] PROP-ADJ  page=${pageNum}  oldScrollH=${Math.round(oldScrollHeight)}  newScrollH=${Math.round(newScrollHeight)}  ratio=${ratio.toFixed(4)}  scrollTop ${Math.round(oldScrollTop)} → ${Math.round(oldScrollTop * ratio)}`);
            }
            mySetScrollTop(mount, oldScrollTop * ratio);
          }
        } else {
          img.style.minHeight = '';
          img.style.opacity = '1';
        }
        if (!disposed) loadVisibleRange(lastVisiblePage);
      };
      img.onerror = () => {
        loading--;
        if (!_firstImageLoaded) _firstImageLoaded = true;
        if (isDebugLoadingPageImages()) {
          console.log(`[img-load] ERROR  page=${pageNum}  concurrent=${loading}`);
        }
        img.style.opacity = '0';
        if (!disposed) loadVisibleRange(lastVisiblePage);
      };
      return true;
    };

    const loadVisibleRange = (centerPage) => {
      if (isDebugLoadingPageImages() && centerPage !== lastVisiblePage) {
        const range = [Math.max(1, centerPage - PRELOAD_WINDOW), Math.min(images.length, centerPage + PRELOAD_WINDOW)];
        console.log(`[img-load] RANGE  center=${centerPage}  range=[${range[0]}..${range[1]}]  loaded=${loadedSet.size}/${images.length}`);
      }
      // Always load the center page first
      loadOne(centerPage - 1);
      // Defer surrounding pages until the first image has loaded — the
      // selected page must render before we spend time on neighbours.
      if (!_firstImageLoaded) return;
      // Then load surrounding pages, expanding outward
      for (let offset = 1; offset <= PRELOAD_WINDOW; offset++) {
        loadOne(centerPage - 1 - offset);
        loadOne(centerPage - 1 + offset);
      }
    };

    // Initial load around the current page
    if (isDebugLoadingPageImages()) {
      console.log(`[img-load] INIT  currentPage=${currentPage}  total=${images.length}  isBilingual=${isBilingual}  scrollH=${Math.round(mount.scrollHeight)}`);
    }
    loadVisibleRange(currentPage);

    setLoadDebugText(`chk4: ${imgElements.length} imgs src=${!!imgElements[0]?.src}`);

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
    const scrollCacheKey = getScrollCacheKey(source);

    const scheduleScrollToCurrent = () => {
      // ── Check for a saved scroll position ──
      const storedPos = loadScrollPos(source);
      const cachedPos = !storedPos ? loadScrollPos(scrollCacheKey) : null;

      const savedTop = storedPos?.top ?? cachedPos?.top;
      const savedLeft = storedPos?.left ?? cachedPos?.left ?? 0;
      const savedPage = storedPos?.page ?? cachedPos?.page;
      // Page height stored alongside the position — use this instead of
      // measuring the DOM, which may return 0 before CSS heights apply.
      const storedPageHeight = storedPos?.pageHeight ?? cachedPos?.pageHeight ?? 0;
      // Zoom level from the PdfPane prop (passed as render scale or available
      // from the parent).  For image mode the render scale is the ratio of
      // display width to natural width, equivalent to the zoom factor.
      const zoomLevel = zoom || 1;

      if (isDebugScrollingPersistence()) {
        const sp = storedPos || cachedPos;
        console.log(`[scroll-load] ${scrollCacheKey}  stored(p=${sp?.page}, t=${sp?.top}, ph=${sp?.pageHeight}, pw=${sp?.pageWidth})  source=${!!storedPos}`);
      }

      if (typeof savedPage === 'number' && savedPage >= 1) {
        scrollRestoredRef.current = true;
        _scrollRestoreInProgress = true;

        const target = mount.querySelector(`[data-page="${savedPage}"]`);
        // ── Compute offsetTop for the target page ─────────
        // Prefer the stored page height formula over the DOM element's
        // offsetTop.  During early load (especially in bilingual mode),
        // preceding pages may not have their final CSS heights applied
        // yet, so target.offsetTop can be significantly wrong.  The stored
        // page height from the previous session represents the settled
        // layout where ALL pages had their correct heights.
        let offsetTop;
        let domOffsetTop = 0;
        if (target) {
          domOffsetTop = target.offsetTop;
        }
        if (storedPageHeight > 0) {
          // storedPageHeight is the CSS display height (includes zoom).
          // Do NOT multiply by zoomLevel again — that would double-count.
          offsetTop = (savedPage - 1) * storedPageHeight;
        } else if (target) {
          offsetTop = domOffsetTop;
        } else {
          offsetTop = 0;
        }
        // within-page offset: always use the current display height of the
        // target element so the fraction maps to the correct pixel position.
        const offset = resolveScrollOffset(savedTop, target);

        const targetTop = offsetTop + offset;

        if (isDebugScrollingPersistence()) {
          const displayH = target ? getPageHeight(target) : '?';
          const actualOffsetTop = Math.round(offsetTop);
          const domDelta = domOffsetTop > 0 && Math.abs(domOffsetTop - offsetTop) > 2
            ? ` (DOM=${Math.round(domOffsetTop)} Δ=${Math.round(domOffsetTop - offsetTop)})` : '';
          console.log(`[scroll-load] ${scrollCacheKey}  →  page=${savedPage}  ` +
            `offsetTop=${actualOffsetTop}${domDelta}  ` +
            `offset=${displayH}×${savedTop?.toFixed?.(4) || savedTop}=${Math.round(offset)}  ` +
            `scrollTo(left=${Math.round(savedLeft)},top=${Math.round(targetTop)})`);
        }
        myScrollTo(mount, { top: targetTop, left: savedLeft, behavior: 'instant' });

        // Verify the browser didn't clamp the scroll.  CSS heights are set
        // synchronously but may not have taken layout effect yet (the CSS
        // rule is injected before the DOM build, but the first paint may
        // not have happened).  If clamped, retry after a short delay.
        const actualTop = getScrollPos(mount).scrollTop;
        const maxScroll = Math.max(0, mount.scrollHeight - mount.clientHeight);
        if (Math.abs(actualTop - targetTop) > 5 && maxScroll < targetTop) {
          if (isDebugScrollingPersistence()) console.log(`[scroll-load] ${scrollCacheKey}  CLAMPED: target=${Math.round(targetTop)} actual=${Math.round(actualTop)} maxScroll=${Math.round(maxScroll)} — retrying after layout`);
          // On retry, use the element's actual offsetTop (which reflects
          // the laid-out CSS heights) instead of the natural-height formula.
          requestAnimationFrame(() => {
            if (!disposed) {
              const t = mount.querySelector(`[data-page="${savedPage}"]`);
              if (t) {
                const realTop = t.offsetTop + resolveScrollOffset(savedTop, t);
                myScrollTo(mount, { top: Math.min(realTop, mount.scrollHeight - mount.clientHeight), left: savedLeft, behavior: 'instant' });
              }
              // Now clear flags and save the RESTORED position.
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  _scrollRestoreInProgress = false;
                  isInitialLoadRef.current = false;
                  const storedPageWidth2 = storedPos?.pageWidth ?? cachedPos?.pageWidth;
                  saveScrollPos(scrollCacheKey, { top: savedTop, left: savedLeft, page: savedPage, pageHeight: Math.round(storedPageHeight), pageWidth: storedPageWidth2 });
                  if (isDebugScrollingPersistence()) console.log(`[scroll-save] ${scrollCacheKey}  p=${savedPage}  t=${typeof savedTop==='number'?savedTop.toFixed(4):savedTop}  pw=${storedPageWidth2 || '-'}  (clamped retry, re-saved)`);
                  // Start post-restore grace period (same as normal path).
                  lastRestoredPageRef.current = savedPage;
                  postRestoreUntilRef.current = Date.now() + 2000;
                  const { page: curPage } = findContainingPage(mount, getScrollPos(mount).scrollTop);
                  loadVisibleRange(curPage);
                  programmaticScrollingRef.current = true;
                  requestAnimationFrame(() => {
                    programmaticScrollingRef.current = false;
                  });
                });
              });
            }
          });
          return;
        }
      } else if (typeof savedTop === 'number' && savedTop > 0) {
        // Legacy format: absolute pixel offset
        scrollRestoredRef.current = true;
        _scrollRestoreInProgress = true;
        myScrollTo(mount, { top: savedTop, left: savedLeft, behavior: 'instant' });
      } else {
        // No saved position — scroll to the current page.
        const currentImg = imgElements[currentPage - 1];
        if (currentImg && !disposed) {
          scrollToPage(currentPage);
        }
      }

      // Clear flags and save the RESTORED position (not the DOM-detected
      // position).  After bilingual layout height adjustment, the detected
      // page can differ from the restored page — saving the detected page
      // would corrupt the stored position (e.g. p=5 becomes p=4).
      // Use the values we INTENDED to restore, keeping the stored position
      // stable across reloads until the user scrolls on their own.
      // Also suppress scroll-save for one extra frame after the re-save
      // so that any layout-triggered scroll events from bilingual height
      // recalculation don't immediately overwrite the restored position.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          _scrollRestoreInProgress = false;
          isInitialLoadRef.current = false;
          // Save EXACTLY what we restored, not what the DOM currently shows.
          // Preserve pageWidth (pw) from the stored position so it survives
          // across reloads — the normal saveScrollNow includes it but our
          // re-save must too, otherwise pw is lost on the first reload.
          const storedPageWidth = storedPos?.pageWidth ?? cachedPos?.pageWidth;
          saveScrollPos(scrollCacheKey, { top: savedTop, left: savedLeft, page: savedPage, pageHeight: Math.round(storedPageHeight), pageWidth: storedPageWidth });
          if (isDebugScrollingPersistence()) console.log(`[scroll-save] ${scrollCacheKey}  p=${savedPage}  t=${typeof savedTop==='number'?savedTop.toFixed(4):savedTop}  pw=${storedPageWidth || '-'}  (restored position re-saved)`);
          // Start post-restore grace period: suppress saveScrollNow for 2 s
          // if the detected page differs from the restored page.  This lets
          // bilingual layout recalculation settle without corrupting the
          // stored position.
          lastRestoredPageRef.current = savedPage;
          postRestoreUntilRef.current = Date.now() + 2000;
          // Load ±3 pages around the restored/current position.
          const { page: curPage } = findContainingPage(mount, getScrollPos(mount).scrollTop);
          loadVisibleRange(curPage);
          // Suppress scroll-save for one extra frame so the initial layout
          // scroll events don't fire before the grace period check kicks in.
          programmaticScrollingRef.current = true;
          requestAnimationFrame(() => {
            programmaticScrollingRef.current = false;
          });
        });
      });
    };
    // Wait until layout settles AND the first image has loaded before
    // restoring the scroll position.  The first image's rendered dimensions
    // confirm that CSS heights are applied and offsetTop values are correct.
    //
    // In single-language (non-bilingual) mode, images have explicit inline
    // heights set during DOM creation — offsetTop is correct immediately,
    // so we can skip the wait and proceed right after a double-RAF for layout.
    const waitForReadyThenScroll = () => {
      try {
      // Always wait for at least the current page's image to load before
      // restoring scroll position.  In single-language mode we previously
      // skipped this (assuming explicit inline heights from API data), but
      // when API dimensions are unavailable the page elements have no
      // explicit height and offsetTop values are wrong until images load.
      // Page 1 is always a real <img> (within ±3 of currentPage), unlike
      // the saved target page which might be a placeholder.
      const needsImageLoad = true;  // was: isBilingual

      if (!needsImageLoad) {
        // Single-language mode: explicit heights are already set inline.
        // Double-RAF is enough for layout to settle, then restore scroll.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (disposed) return;
            setShowLoadingOverlay(false);
            scheduleScrollToCurrent();
          });
        });
        return;
      }

      // ── Bilingual mode: must wait for the first image to load ──
      // Wait for the SELECTED page's image (the one the lazy loader starts
      // with after the _firstImageLoaded optimization), NOT imgElements[0].
      // Page N is loaded first; page 1 may be far outside the ±3 range and
      // would never fire a load event.
      const saved = loadScrollPos(scrollCacheKey);
      const targetPage = (saved && typeof saved.page === 'number' && saved.page >= 1)
        ? saved.page
        : currentPage;
      const firstImg = mount.querySelector(`img.page-img[data-page="${targetPage}"]`);
      setLoadDebugText(`exists=${!!firstImg} tp=${targetPage} srcSet=${!!firstImg?.src} complete=${firstImg?.complete} nh=${firstImg?.naturalHeight}`);

      const tryScroll = () => {
        try {
          setLoadDebugText(`→ tryScroll (dismiss overlay)`);
          setShowLoadingOverlay(false);
          // Double-RAF ensures CSS rules have taken layout effect.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (disposed) return;
              scheduleScrollToCurrent();
            });
          });
        } catch (e) { setLoadDebugText(`ERR-tryScroll: ${e.message}`); }
      };

      if (firstImg && firstImg.complete && firstImg.naturalHeight > 0) {
        // First image already loaded/cached — CSS heights should be active.
        setLoadDebugText('ready(complete+nh)');
        const rect = firstImg.getBoundingClientRect();
        if (isDebugScrollingPersistence()) console.log(`[scroll-load] first image ready: ${rect.width}×${rect.height}  natural: ${firstImg.naturalWidth}×${firstImg.naturalHeight}`);
        tryScroll();
      } else if (firstImg) {
        setLoadDebugText(`waiting complete=${firstImg.complete} nh=${firstImg.naturalHeight}`);
        // Wait for the first image to load.
        if (isDebugScrollingPersistence()) console.log(`[scroll-load] waiting for first image to load...`);
        let ready = false;
        const onReady = () => {
          try {
            if (ready) return; ready = true;
            if (firstImg) {
              firstImg.removeEventListener('load', onReady);
              firstImg.removeEventListener('error', onReady);
            }
            if (!disposed) {
              setLoadDebugText(`onReady complete=${firstImg?.complete} nh=${firstImg?.naturalHeight}`);
              const rect = firstImg ? firstImg.getBoundingClientRect() : { width: 0, height: 0 };
              if (isDebugScrollingPersistence()) console.log(`[scroll-load] first image loaded: ${rect.width}×${rect.height}  natural: ${firstImg?.naturalWidth}×${firstImg?.naturalHeight}`);
              tryScroll();
            }
          } catch (e) { setLoadDebugText(`ERR-onReady: ${e.message}`); }
        };
        firstImg.addEventListener('load', onReady, { once: true });
        firstImg.addEventListener('error', onReady, { once: true });
        // Safety timeout: if the image load/error event never fires, dismiss
        // the overlay and restore scroll position after 3 s anyway.
        setTimeout(() => {
          try {
            if (!disposed && !ready) {
              if (isDebugScrollingPersistence()) console.log(`[scroll-load] first image load timeout — trying anyway`);
              onReady();
            }
          } catch (e) { /* silent */ }
        }, 3000);
      } else {
        // Target page may be a placeholder (not a real <img>).  Fall back
        // to page 1's image — it is always a real <img> within the ±3
        // range of currentPage.  Wait for it to load so CSS heights are
        // applied and offsetTop values are correct.
        const fallbackImg = mount.querySelector(`img.page-img[data-page="1"]`);
        if (fallbackImg && fallbackImg.complete && fallbackImg.naturalHeight > 0) {
          if (isDebugScrollingPersistence()) console.log(`[scroll-load] target page is placeholder — page 1 image already loaded, proceeding`);
          tryScroll();
        } else if (fallbackImg) {
          if (isDebugScrollingPersistence()) console.log(`[scroll-load] target page is placeholder — waiting for page 1 image to load`);
          setLoadDebugText(`wait-fallback complete=${fallbackImg.complete} nh=${fallbackImg.naturalHeight}`);
          let ready = false;
          const onReady = () => {
            try {
              if (ready) return; ready = true;
              fallbackImg.removeEventListener('load', onReady);
              fallbackImg.removeEventListener('error', onReady);
              if (!disposed) tryScroll();
            } catch (e) { /* silent */ }
          };
          fallbackImg.addEventListener('load', onReady, { once: true });
          fallbackImg.addEventListener('error', onReady, { once: true });
          setTimeout(() => {
            try { if (!disposed && !ready) onReady(); } catch (e) { /* silent */ }
          }, 3000);
        } else {
          // No images at all — just go.
          tryScroll();
        }
      }
      } catch (e) { setLoadDebugText(`ERR-waitForReady: ${e.message}`); }
    };
    setLoadDebugText('chk5: calling waitForReady');
    try { waitForReadyThenScroll(); } catch (e) { setLoadDebugText(`ERR-call: ${e.message}`); }

    // scrollRafId2 and pendingScroll2 declared above (before try block)

    // Core scroll work: page detection, lazy loading, cross-pane sync.
    // Extracted so both onScroll (direct calls) and onScrollWithSave
    // (scroll events) share the same logic without duplicating the
    // throttle guard.
    const doScrollWork = () => {
      const pos = getScrollPos(mount);
      const top = pos.scrollTop;
      // Clamp: never scroll past the last page content
      const maxTop = Math.max(0, mount.scrollHeight - mount.clientHeight);
      if (top > maxTop) {
        mySetScrollTop(mount, maxTop);
        return;
      }
      // Containing page (offsetTop ≤ scrollTop), not geometrically nearest.
      const { page: nearest } = findContainingPage(mount, top);
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
      // Suppress onPageChange when this scroll was triggered programmatically
      // (scroll-to-page effect) or during bilingual repositioning to avoid
      // false page-change detections from proportional scroll adjustment.
      if (nearest !== cp && !programmaticScrollingRef.current && !_bilingualRepositioning) {
        lastScrolledFromSyncRef.current = true;
        onPageChange(nearest);
      }

      if (syncGroup && !isInitialLoadRef.current) {
        const max = Math.max(1, mount.scrollHeight - mount.clientHeight);
        const syncPos2 = getScrollPos(mount);
        const ratio = syncPos2.scrollTop / max;
        const hMax = Math.max(1, mount.scrollWidth - mount.clientWidth);
        const hRatio = hMax > 0 ? syncPos2.scrollLeft / hMax : 0;
        window.dispatchEvent(new CustomEvent('pdf-pane-scroll-sync', {
          detail: { group: syncGroup, sender: syncId, ratio, hRatio }
        }));
      }
    };

    const onScroll = () => {
      // Throttle: only run once per animation frame.  Skip entirely when
      // this scroll was triggered by a remote sync — the initiating pane
      // already reported the page, and DOM queries (querySelectorAll +
      // offsetTop) are expensive on iOS, killing momentum scrolling.
      if (syncingFromRemoteRef.current || pendingScroll2) return;
      pendingScroll2 = true;
      scrollRafId2 = requestAnimationFrame(() => {
        pendingScroll2 = false;
        if (disposed) return;
        doScrollWork();
      });
    };

    // ── Scroll-position persistence ──────────────────
    // Store as FRACTION of page height (0–1) — invariant to zoom,
    // viewport width, and image-load state.
    const saveScrollNow = () => {
      if (disposed) return;
      if (isInitialLoadRef.current) return;
      if (_scrollRestoreInProgress) return;  // suppress save during scroll-restore — layout hasn't stabilised yet
      const savePos2 = getScrollPos(mount);
      const top = savePos2.scrollTop;
      const { page, pageEl } = findContainingPage(mount, top);
      // ── Post-restore grace period ──────────────────────
      // After scroll restoration, the bilingual layout height recalculation
      // triggers scroll events that can land on a different page than the
      // restored one.  During the grace period, if the detected page differs
      // from the restored page, skip the save — the restored position (saved
      // by the re-save above) is authoritative until the user scrolls.
      if (Date.now() < postRestoreUntilRef.current && lastRestoredPageRef.current > 0 && page !== lastRestoredPageRef.current) {
        if (isDebugScrollingPersistence()) console.log(`[scroll-save] ${scrollCacheKey}  SKIP — post-restore grace period, restored=p${lastRestoredPageRef.current} detected=p${page}`);
        return;
      }
      const relativeTop = pageEl ? Math.max(0, top - pageEl.offsetTop) : top;
      const displayHeight = getPageHeight(pageEl);
      // Never save when the page height is unreliable (≤ 1px).  This
      // indicates the layout hasn't settled — images haven't loaded,
      // CSS hasn't been applied — and saving would corrupt the stored
      // position with (page=1, ph=1) defaults.
      if (displayHeight <= 1) return;
      const fraction = displayHeight > 0 ? Math.min(1, Math.max(0, relativeTop / displayHeight)) : 0;
      // Also capture natural dimensions for potential future use.
      const imgData = (page > 0 && page <= images.length) ? images[page - 1] : null;
      const natW = (imgData && typeof imgData === 'object') ? imgData.w : 0;
      saveScrollPos(scrollCacheKey, { top: fraction, left: savePos2.scrollLeft, page, pageHeight: Math.round(displayHeight), pageWidth: natW });
      if (isDebugScrollingPersistence()) {
        console.log(`[scroll-save] ${scrollCacheKey}  p=${page}  t=${fraction.toFixed(4)}  scrollTop=${Math.round(top)}  scrollLeft=${Math.round(savePos2.scrollLeft)}  ph=${Math.round(displayHeight)}  pw=${natW}`);
      }
    };
    const onScrollWithSave = () => {
      // Throttle scroll work AND position saving to once per animation
      // frame.  Without this, saveScrollNow fires on every raw scroll
      // event (60+/s during momentum scrolling), calling querySelectorAll
      // + getBoundingClientRect + localStorage.setItem — killing
      // performance, especially on iOS.
      // Also skip during programmatic scrolling (scroll-to-page effect) —
      // the scroll position may not have settled yet.
      if (syncingFromRemoteRef.current || pendingScroll2 || programmaticScrollingRef.current) return;
      pendingScroll2 = true;
      scrollRafId2 = requestAnimationFrame(() => {
        pendingScroll2 = false;
        // Also skip in RAF callback — a previously-scheduled RAF can fire
        // after a programmatic scroll (scroll-to-page) has already moved
        // the viewport, and saving that position would overwrite the user's
        // real last-scroll position.
        if (disposed || programmaticScrollingRef.current) return;
        doScrollWork();
        saveScrollNow();
      });
    };

    mount.addEventListener('scroll', onScrollWithSave, { passive: true });

    // Restore page-number state so the header shows the correct page
    // immediately.  The actual scroll position is handled by
    // scheduleScrollToCurrent (which retries until the layout is ready).
    // NOTE: isInitialLoadRef is NOT cleared here — it stays true until
    // scheduleScrollToCurrent successfully restores the scroll position.
    // Clearing it too early lets the scroll-to-page effect and
    // saveScrollNow fire during restoration, corrupting the saved position.
    if (isInitialLoadRef.current) {
      const saved = loadScrollPos(scrollCacheKey);
      if (saved && typeof saved.page === 'number' && saved.page >= 1) {
        if (isDebugScrollingPersistence()) console.log(`[scroll-load] ${scrollCacheKey}  restorePageState p=${saved.page}`);
        setRenderedPage(saved.page);
        onPageChange(saved.page);
      }
    }

    return () => {
      disposed = true;
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
    // We ALWAYS capture the current state so that contentWidth-only re-runs
    // (e.g. mobile address bar hide/show) don't use a stale anchor from a
    // previous zoom transition.  Without this, the stale anchor's scrollTop
    // (captured minutes ago during initial load) gets applied in Phase 1,
    // jumping the user from page 16 back to page 3.
    const anchorKey = `${zoom}|${fitMode}`;
    const isNewZoomLevel = zoomAnchorRef.current.key !== anchorKey;

    // Capture current dimensions BEFORE any CSS changes.
    const capturePos = getScrollPos(mount);
    const currentCapture = {
      scrollTop: capturePos.scrollTop,
      scrollLeft: capturePos.scrollLeft,
      scrollHeight: Math.max(1, mount.scrollHeight),
      scrollWidth: Math.max(1, mount.scrollWidth),
      clientHeight: mount.clientHeight,
      clientWidth: mount.clientWidth,
    };

    // For zoom transitions, preserve the OLD zoom level in the anchor
    // so Phase 1 can compute zoomRatio correctly.
    let anchor;
    if (isNewZoomLevel) {
      anchor = {
        key: anchorKey,
        zoom: zoomAnchorRef.current.zoom > 0 ? zoomAnchorRef.current.zoom : zoom,
        ...currentCapture,
      };
      zoomAnchorRef.current = anchor;
      if (isDebugZooming()) {
        console.log('[zoom-img-scrolling] pre-zoom capture (NEW zoom level)', {
          zoom, fitMode, oldZoom: anchor.zoom,
          savedScrollTop: anchor.scrollTop, savedScrollLeft: anchor.scrollLeft,
          savedScrollHeight: anchor.scrollHeight, savedScrollWidth: anchor.scrollWidth,
        });
      }
    } else {
      anchor = { ...zoomAnchorRef.current };
      if (isDebugZooming()) {
        console.log('[zoom-img-scrolling] pre-zoom capture (contentWidth-only re-run — using current state)', {
          zoom, fitMode,
          currentScrollTop: currentCapture.scrollTop,
          currentScrollHeight: currentCapture.scrollHeight,
          anchorScrollTop: anchor.scrollTop,
          anchorScrollHeight: anchor.scrollHeight,
        });
      }
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
      // Update blank page heights to match the new layout dimensions.
      // Blank pages are created once (not recreated on resize), so their
      // inline heights become stale when the column width changes
      // (e.g. horizontal ↔ vertical bilingual split, window resize).
      const blankPages = mount.querySelectorAll('.pdf-blank-page');
      blankPages.forEach((bp) => {
        bp.style.setProperty('height', `${estH}px`, 'important');
      });
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
    // ═══ Choose the correct "old" capture ═══
    // For zoom changes: use the anchor (which has oldZoom and old dimensions).
    // For contentWidth-only re-runs: use currentCapture (taken right before
    // the CSS changes above), since the anchor holds stale values from a
    // previous zoom transition and would jump the user to the wrong page.
    const zoomChanged = (zoomAnchorRef.current.zoom > 0 && zoomAnchorRef.current.zoom !== zoom)
                     || isNewZoomLevel;
    const old = isNewZoomLevel ? anchor : currentCapture;
    const oldZoom = isNewZoomLevel ? (anchor.zoom > 0 ? anchor.zoom : zoom) : zoom;
    const zoomRatio = oldZoom > 0 ? zoom / oldZoom : 1;
    const oldCH = old.clientHeight;
    const oldCW = old.clientWidth;
    const oldSH = old.scrollHeight;
    const oldSW = old.scrollWidth;

    // ═══ PHASE 1 (synchronous): apply estimated scroll immediately ═══
    // Only needed when zoom actually changed — for contentWidth-only re-runs
    // the browser naturally preserves scrollTop at the correct content position.
    if (zoomChanged) {
      // Vertical: content is top-aligned, simple zoom-factor scaling
      const estNewTop = (old.scrollTop + oldCH / 2) * zoomRatio - oldCH / 2;

      // Horizontal: account for CSS centering offset in old state
      const oldContentFits = oldSW <= oldCW + 1;
      const oldHOffset = oldContentFits ? (oldCW - oldSW) / 2 : 0;
      const contentCenterX = old.scrollLeft + oldCW / 2 - oldHOffset;
      // Estimate new centering: if content was already overflowing, it stays overflowed
      const estNewContentFits = oldContentFits && (zoomRatio <= 1.01);
      const estNewHOffset = estNewContentFits ? (oldCW - oldSW * zoomRatio) / 2 : 0;
      const estNewLeft = contentCenterX * zoomRatio + estNewHOffset - oldCW / 2;

      // Clamp and apply synchronously (before browser paints)
      const estMaxTop = Math.max(0, oldSH * zoomRatio - oldCH);
      const estMaxLeft = Math.max(0, oldSW * zoomRatio - oldCW);
      if (oldSH > 0 || oldSW > 0) {
        myScrollTo(mount, {
          top: Math.max(0, Math.min(estNewTop, estMaxTop)),
          left: Math.max(0, Math.min(estNewLeft, estMaxLeft)),
          behavior: 'instant',
        });
      }

      if (isDebugZooming()) {
        console.log('[zoom-img-scrolling] Phase 1 sync (zoom changed)', {
          zoom, fitMode, oldZoom, zoomRatio,
          oldScrollTop: old.scrollTop, oldScrollHeight: oldSH,
          estNewTop, estMaxTop,
          contentCenterX, estNewLeft, estMaxLeft,
        });
      }
    } else if (isDebugZooming()) {
      console.log('[zoom-img-scrolling] Phase 1 SKIPPED (zoom unchanged — browser preserves scrollTop)', {
        zoom, fitMode, zoomRatio,
        currentScrollTop: currentCapture.scrollTop,
      });
    }

    // ═══ PHASE 2 (async): fine-tune using actual layout dimensions ═══
    // Compute horizontal centering from the "old" state (same as Phase 1).
    const phase2OldContentFits = oldSW <= oldCW + 1;
    const phase2OldHOffset = phase2OldContentFits ? (oldCW - oldSW) / 2 : 0;
    const phase2ContentCenterX = old.scrollLeft + oldCW / 2 - phase2OldHOffset;

    const timer = setTimeout(() => {
      if (!mount) return;
      const newCH = mount.clientHeight;
      const newCW = mount.clientWidth;
      const newSH = mount.scrollHeight;
      const newSW = mount.scrollWidth;

      // Vertical: viewport-center anchored scaling
      const vpCenterY = old.scrollTop + oldCH / 2;
      const scaleY = oldSH > 0 ? newSH / oldSH : 1;
      const newTop = vpCenterY * scaleY - newCH / 2;

      // Horizontal (with actual new centering offset)
      const newContentFits = newSW <= newCW + 1;
      const newHOffset = newContentFits ? (newCW - newSW) / 2 : 0;
      const scaleX = oldSW > 0 ? newSW / oldSW : 1;
      const newLeft = phase2ContentCenterX * scaleX + newHOffset - newCW / 2;

      const maxTop = Math.max(0, newSH - newCH);
      const maxLeft = Math.max(0, newSW - newCW);

      const hChanged = oldSH !== newSH;
      const wChanged = oldSW !== newSW;

      if (isDebugZooming()) {
        console.log('[zoom-img-scrolling] center-anchor fine-tune', {
          zoom, fitMode, zoomChanged, oldZoom, zoomRatio,
          savedScrollTop: old.scrollTop, savedScrollHeight: oldSH,
          savedScrollLeft: old.scrollLeft, savedScrollWidth: oldSW,
          oldClientH: oldCH, oldClientW: oldCW,
          newClientH: newCH, newClientW: newCW,
          phase2OldContentFits, newContentFits,
          phase2OldHOffset, newHOffset,
          phase2ContentCenterX, scaleX, scaleY,
          finalNewTop: newTop, finalNewLeft: newLeft,
          curH: newSH, curW: newSW,
          hChanged, wChanged,
        });
      }
      if ((hChanged || wChanged) && !_scrollRestoreInProgress) {
        myScrollTo(mount, {
          top: Math.max(0, Math.min(newTop, maxTop)),
          left: Math.max(0, Math.min(newLeft, maxLeft)),
          behavior: 'instant',
        });
      }
      // Update the ref's zoom so the NEXT zoom change uses correct oldZoom.
      // For contentWidth-only re-runs, preserve the previous anchor key
      // but store the latest dimensions and zoom for future reference.
      const endPos = getScrollPos(mount);
      zoomAnchorRef.current = {
        key: zoomAnchorRef.current.key,
        zoom,
        scrollTop: endPos.scrollTop,
        scrollLeft: endPos.scrollLeft,
        scrollHeight: Math.max(1, mount.scrollHeight),
        scrollWidth: Math.max(1, mount.scrollWidth),
        clientHeight: mount.clientHeight,
        clientWidth: mount.clientWidth,
      };
    }, 0);

    // Always clear the timer on re-run — each run captures the current state
    // fresh, so a stale timer from a previous run would use outdated dimensions.
    return () => {
      clearTimeout(timer);
    };
  }, [isImageMode, mode, zoom, fitMode, fitRefreshToken, contentWidth]);

  // Scroll position in scrolling mode is user-controlled — no auto-scroll on page change

  return (
    <section
      className="page-frame page-card pdf-pane"
      data-annotation-language={paneLanguage}
    >
      {showLoadingOverlay && isImageMode && (
        <div className="pdf-loading-overlay">
          <div className="pdf-loading-spinner" />
          <span>Loading pages…</span>
          {isTestMode() && (
            <span style={{fontSize:'10px',color:'#888',marginTop:'8px',maxWidth:'90vw',wordBreak:'break-all',textAlign:'center'}}>{loadDebugText}</span>
          )}
        </div>
      )}
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
              const imgItem = !isBlankPage ? images[currentPage - 1] : null;
              const imgSrc = typeof imgItem === 'string' ? imgItem : imgItem?.url || '';
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
                    setShowLoadingOverlay(false);
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

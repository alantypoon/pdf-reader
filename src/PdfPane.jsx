import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.js?url';
import { t, uiLang } from './i18n';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

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
 * Compute a scroll position that keeps the viewport center anchored
 * after content dimensions change (e.g. zoom in/out).
 *
 * @param {HTMLElement} container - The scrollable element
 * @param {number} oldScrollTop  - scrollTop before content changed
 * @param {number} oldScrollHeight - scrollHeight before content changed
 * @param {'vertical'|'both'} axis - which axis to anchor
 * @returns {{ top: number, left?: number }} scrollTo options
 */
function centerAnchoredScroll(container, oldScrollTop, oldScrollHeight, axis = 'vertical') {
  const vpCenter = oldScrollTop + container.clientHeight / 2;
  const centerRatio = oldScrollHeight > 0 ? vpCenter / oldScrollHeight : 0;
  const newTop = centerRatio * container.scrollHeight - container.clientHeight / 2;
  const result = { top: Math.max(0, newTop), behavior: 'instant' };
  if (axis === 'both') {
    const oldScrollLeft = container.scrollLeft;
    const oldScrollWidth = container.scrollWidth;
    const hpCenter = oldScrollLeft + container.clientWidth / 2;
    const hCenterRatio = oldScrollWidth > 0 ? hpCenter / oldScrollWidth : 0;
    const newLeft = hCenterRatio * container.scrollWidth - container.clientWidth / 2;
    result.left = Math.max(0, newLeft);
  }
  return result;
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
  paneLanguage = 'en'
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
  const canvasRef = useRef(null);
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const currentPageRef = useRef(currentPage);
  const renderedPageRef = useRef(1);
  const syncingFromRemoteRef = useRef(false);
  const modeGenRef = useRef(0);

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
      position: 'relative',
      display: 'flex',
      justifyContent: 'center',
      alignItems: fitMode === 'width' ? 'flex-start' : 'center',
    };
  }, [fitMode]);

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
      const page = await pdfDoc.getPage(pageNumber);
      if (modeGenRef.current !== gen) return;
      const holder = canvasRef.current?.parentElement;
      if (!holder) return;
      // Capture scroll position before canvas resize changes scrollHeight
      const oldScrollTop = holder.scrollTop;
      const oldScrollHeight = Math.max(1, holder.scrollHeight);
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
        ? Math.min(scaleH, scaleW)
        : fitMode === 'width'
          ? scaleW
          : Math.min(scaleW, scaleH);
      const scale = Math.max(0.001, fitScale * zoom);
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
      canvas.style.maxWidth = fitMode === 'height' ? 'none' : '100%';
      canvas.style.maxHeight = fitMode === 'width' ? 'none' : '100%';
      canvas.style.display = 'block';
      canvas.style.flexShrink = '0';
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      // Restore center-anchored scroll now that new dimensions are set
      if (oldScrollHeight !== holder.scrollHeight) {
        holder.scrollTo(centerAnchoredScroll(holder, oldScrollTop, oldScrollHeight, 'both'));
      }
      await page.render({ canvasContext: context, viewport }).promise;
      if (modeGenRef.current !== gen) return;
      // Re-apply after render in case paint caused a layout shift
      if (oldScrollHeight !== holder.scrollHeight) {
        holder.scrollTo(centerAnchoredScroll(holder, oldScrollTop, oldScrollHeight, 'both'));
      }
      setRenderedPage(pageNumber);
      if (pageNumber !== currentPage) {
        onPageChange(pageNumber);
      }
    };

    draw();
  }, [isImageMode, pdfDoc, currentPage, numPages, mode, onPageChange, zoom, contentWidth, contentHeight, fitMode, fitRefreshToken]);

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
  const imgPaginationScrollRef = useRef({ top: 0, height: 0 });
  useLayoutEffect(() => {
    if (!isImageMode || mode !== 'pagination') return;
    const container = imgRef.current?.closest('.pdf-single-page');
    if (!container) return;
    const { top, height } = imgPaginationScrollRef.current;
    if (height > 0 && height !== container.scrollHeight) {
      container.scrollTo(centerAnchoredScroll(container, top, height, 'both'));
    }
    imgPaginationScrollRef.current = {
      top: container.scrollTop,
      height: Math.max(1, container.scrollHeight),
    };
  }, [isImageMode, mode, zoom, fitMode, fitRefreshToken, imageLoadVersion]);

  // ── Scrolling mode (PDF) ───────────────────────────────────
  useEffect(() => {
    if (isImageMode || mode !== 'scrolling') return;
    if (!pdfDoc) return;
    const mount = scrollRef.current;
    if (!mount) return;

    let disposed = false;
    let pageRefreshTimer = null;
    const gen = modeGenRef.current;
    mount.style.justifyItems = 'center';

    const drawAll = async () => {
      let lastScale = zoom;
      const mountRect = mount.getBoundingClientRect();
      const containerHeight = Math.max(180, mountRect.height);
      const containerWidth = Math.max(180, mountRect.width);
      const fragment = document.createDocumentFragment();
      for (let i = 1; i <= numPages; i += 1) {
        if (disposed || modeGenRef.current !== gen) return;
        const page = await pdfDoc.getPage(i);
        if (disposed || modeGenRef.current !== gen) return;
        const viewportBase = page.getViewport({ scale: 1 });
        const fitDim = fitMode === 'height' ? containerHeight : containerWidth;
        const fitBase = fitMode === 'height' ? viewportBase.height : viewportBase.width;
        lastScale = Math.max(0.001, (fitDim / fitBase) * zoom);
        const viewport = page.getViewport({ scale: lastScale });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        const ratio = safeDevicePixelRatio(viewport.width, viewport.height);
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.style.display = 'block';
        canvas.dataset.page = String(i);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        await page.render({ canvasContext: context, viewport }).promise;
        if (disposed || modeGenRef.current !== gen) return;
        fragment.appendChild(canvas);
      }

      if (disposed || modeGenRef.current !== gen) return;
      const savedScrollTop = mount.scrollTop;
      const savedScrollHeight = Math.max(1, mount.scrollHeight);

      mount.innerHTML = '';
      mount.appendChild(fragment);

      if (typeof onRenderScaleChange === 'function') {
        onRenderScaleChange(lastScale);
      }
      if (typeof onScrollCanvasesReady === 'function') {
        requestAnimationFrame(() => onScrollCanvasesReady());
      }

      const syncPageIndicator = () => {
        if (disposed || modeGenRef.current !== gen) return null;
        const allNodes = [...mount.querySelectorAll('canvas[data-page]')];
        if (!allNodes.length) return null;
        const top = mount.scrollTop;
        let nearest = Number(allNodes[0].dataset.page) || 1;
        let min = Infinity;
        allNodes.forEach((node) => {
          const dist = Math.abs(node.offsetTop - top);
          if (dist < min) { min = dist; nearest = Number(node.dataset.page); }
        });
        setRenderedPage(nearest);
        lastScrolledFromSyncRef.current = true;
        onPageChange(nearest);
        return nearest;
      };

      const onScroll = () => {
        syncPageIndicator();

        if (syncGroup && !syncingFromRemoteRef.current) {
          const max = Math.max(1, mount.scrollHeight - mount.clientHeight);
          const ratio = mount.scrollTop / max;
          window.dispatchEvent(new CustomEvent('pdf-pane-scroll-sync', {
            detail: {
              group: syncGroup,
              sender: syncId,
              ratio
            }
          }));
        }
      };

      mount.addEventListener('scroll', onScroll, { passive: true });

      // Restore center-anchored scroll position after layout settles,
      // then sync the page indicator from the restored position.
      // We MUST NOT call onScroll() synchronously here — the DOM layout
      // hasn't settled yet and scrollTop may be stale.  Instead we piggy-
      // back on the same RAF that restores the scroll position.
      requestAnimationFrame(() => {
        if (disposed || modeGenRef.current !== gen) return;

        if (savedScrollHeight !== mount.scrollHeight) {
          mount.scrollTo(centerAnchoredScroll(mount, savedScrollTop, savedScrollHeight));
        }

        // After restoring scroll (or even if heights matched), fire the
        // scroll handler once so the parent knows which page is visible.
        // Use a microtask to let the scrollTo layout settle first.
        requestAnimationFrame(() => {
          if (disposed || modeGenRef.current !== gen) return;
          onScroll();
        });
      });

      return () => mount.removeEventListener('scroll', onScroll);
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
  }, [isImageMode, pdfDoc, numPages, mode, zoom, fitMode, fitRefreshToken, contentWidth]);

  // ── Scroll to current page in scrolling mode (prev/next buttons) ─
  // Only jump when the page change came from a button click, not from
  // natural scrolling (which would create a feedback loop).
  const lastScrolledFromSyncRef = useRef(false);
  useEffect(() => {
    if (mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount || !mount.children.length) return;
    // Skip if the page change was triggered by our own scroll sync
    if (lastScrolledFromSyncRef.current) {
      lastScrolledFromSyncRef.current = false;
      return;
    }
    const target = mount.querySelector(`[data-page="${currentPage}"]`);
    if (target) {
      mount.scrollTo({ top: target.offsetTop, behavior: 'instant' });
    }
  }, [mode, currentPage]);

  useEffect(() => {
    if (!syncGroup || mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount) return;

    const onSync = (event) => {
      const { group, sender, ratio } = event.detail || {};
      if (group !== syncGroup || sender === syncId) return;
      const max = Math.max(0, mount.scrollHeight - mount.clientHeight);
      syncingFromRemoteRef.current = true;
      mount.scrollTop = ratio * max;
      requestAnimationFrame(() => {
        syncingFromRemoteRef.current = false;
      });
    };

    window.addEventListener('pdf-pane-scroll-sync', onSync);
    return () => window.removeEventListener('pdf-pane-scroll-sync', onSync);
  }, [mode, syncGroup, syncId]);

  // ── Image-mode scrolling: build <img> tags with progressive load ─
  const lastImagesRef = useRef(null);

  useEffect(() => {
    if (!isImageMode || mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount) return;

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

    // Skip rebuild if images array hasn't changed (prevents duplicates on mode switch)
    if (lastImagesRef.current === images && mount.children.length === images.length) {
      // Still scroll to the current page (e.g. when switching from pagination to scrolling)
      scrollToPage(currentPage);
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
    lastImagesRef.current = images;

    mount.innerHTML = '';
    mount.style.justifyItems = 'center';

    // Create all img elements first (without src) so DOM order is fixed
    const mountRect = mount.getBoundingClientRect();
    const containerHeight = Math.max(180, mountRect.height);
    const containerWidth = Math.max(180, mountRect.width);
    const imgElements = images.map((url, idx) => {
      const pageNum = idx + 1;
      const img = document.createElement('img');
      img.alt = `${_('pageN')} ${pageNum}`;
      img.dataset.page = String(pageNum);
      img.dataset.src = url;
      img.className = 'page-img';
      if (fitMode === 'height') {
        img.style.height = `${containerHeight * zoom}px`;
        img.style.width = 'auto';
      } else {
        img.style.width = `${containerWidth * zoom}px`;
        img.style.height = 'auto';
      }
      img.style.display = 'block';
      img.style.minHeight = '120px';
      img.style.opacity = '0'; // hidden until loaded (fades in via CSS transition)
      return img;
    });

    const fragment = document.createDocumentFragment();
    imgElements.forEach((img) => fragment.appendChild(img));
    mount.appendChild(fragment);

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
      img.src = url;
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

    // After the current-page image loads (or is already cached), scroll into position
    const scheduleScrollToCurrent = () => {
      const currentImg = imgElements[currentPage - 1];
      if (!currentImg || disposed) return;
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

    const onScroll = () => {
      const nodes = [...mount.querySelectorAll('img[data-page]')];
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
      setRenderedPage(nearest);

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

      if (syncGroup && !syncingFromRemoteRef.current) {
        const max = Math.max(1, mount.scrollHeight - mount.clientHeight);
        const ratio = mount.scrollTop / max;
        window.dispatchEvent(new CustomEvent('pdf-pane-scroll-sync', {
          detail: { group: syncGroup, sender: syncId, ratio }
        }));
      }
    };

    mount.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      disposed = true;
      mount.removeEventListener('scroll', onScroll);
    };
  }, [isImageMode, images, mode, syncGroup, syncId]);

  // ── Apply zoom to image-mode scrolling images ─────────────
  useEffect(() => {
    if (!isImageMode) return;
    if (mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount) return;
    const mountRect = mount.getBoundingClientRect();
    const containerHeight = Math.max(180, mountRect.height);
    const containerWidth = Math.max(180, mountRect.width);
    const imgs = mount.querySelectorAll('img.page-img');
    let reportedScale = zoom;
    imgs.forEach((img) => {
      if (fitMode === 'height') {
        img.style.height = `${containerHeight * zoom}px`;
        img.style.width = 'auto';
        if (img.naturalHeight > 0 && containerHeight > 0 && reportedScale === zoom) {
          reportedScale = (containerHeight * zoom) / img.naturalHeight;
        }
      } else {
        img.style.width = `${containerWidth * zoom}px`;
        img.style.height = 'auto';
        if (img.naturalWidth > 0 && containerWidth > 0 && reportedScale === zoom) {
          reportedScale = (containerWidth * zoom) / img.naturalWidth;
        }
      }
    });
    if (typeof onRenderScaleChange === 'function') {
      onRenderScaleChange(Math.max(0.01, reportedScale));
    }
    // After fit/zoom changes, page boundaries shift. Restore the same relative
    // scroll position instead of snapping to the top of the nearest page.
    const DELAY_AFTER_FIT_CHANGE = 0;
    const savedScrollTop = mount.scrollTop;
    const savedScrollHeight = Math.max(1, mount.scrollHeight);
    const timer = setTimeout(() => {
      if (!mount) return;
      if (savedScrollHeight !== mount.scrollHeight) {
        mount.scrollTo(centerAnchoredScroll(mount, savedScrollTop, savedScrollHeight));
      }
    }, DELAY_AFTER_FIT_CHANGE);

    return () => clearTimeout(timer);
  }, [isImageMode, mode, zoom, fitMode, fitRefreshToken, contentWidth]);

  // Scroll position in scrolling mode is user-controlled — no auto-scroll on page change

  const titleSuffix = useMemo(() => `${renderedPage}${numPages ? ` / ${numPages}` : ''}`, [renderedPage, numPages]);

  return (
    <section className="page-frame page-card pdf-pane" data-annotation-language={paneLanguage}>
      <header className="page-card-header">
        <strong className="header-book">{title}</strong>
        {section != null && (
          <>
            <span className="header-sep">·</span>
            <span className="header-section">§{section}</span>
          </>
        )}
        <span className="header-sep">·</span>
        <span className="header-page-num">{titleSuffix}</span>
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

        <div className="pdf-content" ref={contentRef} key={mode}>
          {thumbnailsOpen ? (
            <div className="thumbnail-grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, thumbCols)}, 1fr)` }}>
                {thumbs.map((thumb) => (
                  <button
                    key={thumb.page}
                    className={`thumb-grid-item ${thumb.page === renderedPage ? 'active' : ''}`}
                    onMouseEnter={() => console.log(`[thumb] hover enter page ${thumb.page}`)}
                    onMouseLeave={() => console.log(`[thumb] hover leave page ${thumb.page}`)}
                    onClick={() => {
                      console.log(`[thumb] CLICK page ${thumb.page}`);
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
              const imgSrc = images[Math.max(0, Math.min(currentPage - 1, images.length - 1))] || '';
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
              {imgSrc ? (
                <img
                  ref={imgRef}
                  src={imgSrc}
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

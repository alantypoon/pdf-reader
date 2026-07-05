import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  const syncingFromRemoteRef = useRef(false);
  const modeGenRef = useRef(0);

  // Keep the ref in sync so the scrolling effect always sees the latest page
  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

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
    // In pagination mode, PdfPane manages its own page tracking via the draw effect.
    // In other modes (thumbnails, scrolling), sync from the parent's currentPage.
    if (mode === 'pagination') return;
    setRenderedPage((prev) => {
      const page = Math.max(1, Math.min(currentPage, numPages || 1));
      return prev !== page ? page : prev;
    });
  }, [mode, currentPage, numPages]);

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
    console.log('[fit-refresh] PdfPane draw effect triggered — deps:', {
      isImageMode, mode, hasPdfDoc: !!pdfDoc,
      currentPage, numPages, zoom, contentWidth, contentHeight,
      fitMode, fitRefreshToken,
    });
    if (isImageMode) { console.log('[fit-refresh] SKIP: isImageMode=true'); return; }
    if (mode !== 'pagination') { console.log('[fit-refresh] SKIP: mode=' + mode + ' (not pagination)'); return; }
    if (!pdfDoc) { console.log('[fit-refresh] SKIP: no pdfDoc loaded'); return; }
    console.log('[fit-refresh] guards passed — starting draw()');
    const gen = modeGenRef.current;
    const draw = async () => {
      const pageNumber = Math.max(1, Math.min(currentPage, numPages || 1));
      console.log('[fit-refresh] draw() — getting page ' + pageNumber + ' of ' + numPages);
      const page = await pdfDoc.getPage(pageNumber);
      if (modeGenRef.current !== gen) { console.log('[fit-refresh] SKIP: mode changed during getPage, gen=' + gen + ' current=' + modeGenRef.current); return; }
      const holder = canvasRef.current?.parentElement;
      if (!holder) { console.log('[fit-refresh] SKIP: no canvas parent element'); return; }
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
      console.log('[fit-calc]', {
        sidebarWidth, toolbarHeight,
        viewportWidthCap, viewportHeightCap,
        holderW: holder.clientWidth, holderH: holder.clientHeight,
        fitWidth, fitHeight,
        baseW: baseViewport.width, baseH: baseViewport.height,
        scaleW: scaleW.toFixed(4), scaleH: scaleH.toFixed(4),
        fitMode, zoom,
        fitScale: fitScale.toFixed(4),
        finalScale: scale.toFixed(4),
        canvasW: Math.floor(baseViewport.width * scale),
        canvasH: Math.floor(baseViewport.height * scale),
      });
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
      await page.render({ canvasContext: context, viewport }).promise;
      console.log('[fit-refresh] canvas rendered — size: ' + canvas.style.width + '×' + canvas.style.height);
      if (modeGenRef.current !== gen) { console.log('[fit-refresh] SKIP: mode changed during render'); return; }
      setRenderedPage(pageNumber);
      if (pageNumber !== currentPage) {
        onPageChange(pageNumber);
      }
    };

    draw();
  }, [isImageMode, pdfDoc, currentPage, numPages, mode, onPageChange, zoom, contentWidth, contentHeight, fitMode, fitRefreshToken]);

  useEffect(() => {
    console.log('[fit-refresh] image-pagination scale effect triggered — deps:', {
      isImageMode, mode, currentPage, zoom, fitMode,
      contentWidth, contentHeight, fitRefreshToken
    });
    if (!isImageMode) { console.log('[fit-refresh] SKIP: not image mode'); return; }
    if (mode !== 'pagination') { console.log('[fit-refresh] SKIP: mode=' + mode + ' (not pagination)'); return; }
    if (typeof onRenderScaleChange !== 'function') return;
    const img = imgRef.current;
    if (!img || !img.complete) { console.log('[fit-refresh] SKIP: img not ready'); return; }

    const frame = requestAnimationFrame(() => {
      const rect = img.getBoundingClientRect();
      const baseSize = fitMode === 'height' ? img.naturalHeight : img.naturalWidth;
      const renderedSize = fitMode === 'height' ? rect.height : rect.width;
      console.log('[fit-refresh] image-pagination — img rect: ' + rect.width + '×' + rect.height + ' natural: ' + img.naturalWidth + '×' + img.naturalHeight + ' zoom=' + zoom + ' fitMode=' + fitMode);
      if (baseSize > 0 && renderedSize > 0) {
        onRenderScaleChange(renderedSize / baseSize);
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [isImageMode, mode, currentPage, images, zoom, fitMode, contentWidth, contentHeight, imageLoadVersion, fitRefreshToken]);

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
      const prevPage = currentPageRef.current;
      console.log(`[fit-debug] stored prevPage=${prevPage} before fit redraw`);
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
      const savedRatio = mount.scrollHeight > 0
        ? mount.scrollTop / mount.scrollHeight
        : 0;

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
        onPageChange(nearest);
        return nearest;
      };

      if (pageRefreshTimer) clearTimeout(pageRefreshTimer);
      pageRefreshTimer = setTimeout(() => {
        if (disposed || modeGenRef.current !== gen) return;
        const target = mount.querySelector(`canvas[data-page="${prevPage}"]`);
        if (target) {
          mount.scrollTo({ top: target.offsetTop, behavior: 'instant' });
        }
        setRenderedPage(prevPage);
        onPageChange(prevPage);
        console.log(`[fit-debug] PDF scrolled back to prevPage=${prevPage}`);
      }, 100);

      const nodes = [...mount.querySelectorAll('canvas[data-page]')];

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
      onScroll();
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
  useEffect(() => {
    if (mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount || !mount.children.length) return;
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
      return img;
    });

    const fragment = document.createDocumentFragment();
    imgElements.forEach((img) => fragment.appendChild(img));
    mount.appendChild(fragment);

    // Progressive loader — max 2 concurrent loads, first page first
    let loading = 0;
    let nextIdx = 0;
    let loadedCount = 0;
    let disposed = false;

    const loadNext = () => {
      while (loading < 2 && nextIdx < imgElements.length && !disposed) {
        const img = imgElements[nextIdx];
        const url = img.dataset.src;
        if (url && !img.src) {
          loading++;
          img.src = url;
          img.onload = img.onerror = () => {
            loading--;
            loadedCount++;
            img.style.minHeight = '';
            if (!disposed) {
              // When all images have loaded, their final heights are known,
              // so recalculate the scroll position to land on the correct page.
              if (loadedCount >= imgElements.length) {
                scrollToPage(currentPage);
              }
              loadNext();
            }
          };
        }
        nextIdx++;
      }
    };

    loadNext();

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
      const cp = currentPageRef.current;
      if (nearest !== cp) {
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

    // Initial scroll position — approximate because images have min-height 120px
    // and their final heights aren't known yet.  After all images load,
    // scrollToPage is called again with the correct offsets.
    scrollToPage(currentPage);

    return () => {
      disposed = true;
      mount.removeEventListener('scroll', onScroll);
    };
  }, [isImageMode, images, mode, syncGroup, syncId]);

  // ── Scroll to current page in image scrolling mode (prev/next buttons) ─
  useEffect(() => {
    if (!isImageMode || mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount || !mount.children.length) return;
    const p = Math.max(1, Math.min(currentPage, mount.children.length || 1));
    const target = mount.querySelector(`[data-page="${p}"]`);
    if (target) {
      mount.scrollTo({ top: target.offsetTop, behavior: 'instant' });
    }
  }, [isImageMode, mode, currentPage]);

  // ── Apply zoom to image-mode scrolling images ─────────────
  useEffect(() => {
    console.log('[fit-refresh] image-scroll zoom effect triggered — deps:', {
      isImageMode, mode, zoom, fitMode, fitRefreshToken, contentWidth
    });
    if (!isImageMode) { console.log('[fit-refresh] SKIP: not image mode'); return; }
    if (mode !== 'scrolling') { console.log('[fit-refresh] SKIP: mode=' + mode + ' (not scrolling)'); return; }
    const mount = scrollRef.current;
    if (!mount) { console.log('[fit-refresh] SKIP: no scroll mount'); return; }
    const mountRect = mount.getBoundingClientRect();
    const containerHeight = Math.max(180, mountRect.height);
    const containerWidth = Math.max(180, mountRect.width);
    const imgs = mount.querySelectorAll('img.page-img');
    console.log('[fit-refresh] image-scroll resizing ' + imgs.length + ' images — container: ' + containerWidth + '×' + containerHeight + ' zoom=' + zoom + ' fitMode=' + fitMode);
    imgs.forEach((img) => {
      if (fitMode === 'height') {
        img.style.height = `${containerHeight * zoom}px`;
        img.style.width = 'auto';
      } else {
        img.style.width = `${containerWidth * zoom}px`;
        img.style.height = 'auto';
      }
    });
    if (typeof onRenderScaleChange === 'function') {
      onRenderScaleChange(zoom);
    }
    // After fit/zoom changes, page boundaries shift. Wait for layout to settle
    // then recalculate which page is visible and update the page indicator.
    // const DELAY_AFTER_FIT_CHANGE = 100;
    const DELAY_AFTER_FIT_CHANGE = 0;
    const prevPage = currentPageRef.current;
    console.log(`[fit-debug] stored prevPage=${prevPage} before fit zoom`);
    const timer = setTimeout(() => {
      if (!mount) return;
      const target = mount.querySelector(`img[data-page="${prevPage}"]`);
      if (target) {
        mount.scrollTo({ top: target.offsetTop, behavior: 'instant' });
      }
      setRenderedPage(prevPage);
      onPageChange(prevPage);
      console.log(`[fit-debug] scrolled back to prevPage=${prevPage}`);
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
                <img src={thumb.url} alt={`${_('pageN')} ${thumb.page}`} />
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
                    <img src={thumb.url} alt={`${_('pageN')} ${thumb.page}`} data-page={thumb.page} />
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
              <img
                ref={imgRef}
                src={imgSrc}
                alt={`${_('pageN')} ${currentPage}`}
                className="page-img"
                onLoad={handleImageLoad}
                style={imageStyle}
              />
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

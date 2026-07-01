import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.js?url';

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
  thumbCols = 4,
  onThumbColsChange,
  onThumbnailClick,
  syncGroup,
  syncId,
  zoom = 1
}) {
  const isImageMode = Array.isArray(images) && images.length > 0;
  console.log(`[PdfPane] mode=${mode} isImageMode=${isImageMode} images=${images?.length || 0} source=${source ? 'yes' : 'no'} thumbnailsOpen=${thumbnailsOpen}`);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [thumbs, setThumbs] = useState([]);
  const [renderedPage, setRenderedPage] = useState(1);
  const [contentWidth, setContentWidth] = useState(0);
  const [loadError, setLoadError] = useState(null);
  const canvasRef = useRef(null);
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const syncingFromRemoteRef = useRef(false);
  const modeGenRef = useRef(0);

  // Increment generation on mode change to cancel stale async work
  useEffect(() => {
    modeGenRef.current += 1;
  }, [mode]);

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

  // Keep renderedPage in sync with currentPage for paginated image mode
  useEffect(() => {
    if (!isImageMode || mode !== 'pagination') return;
    setRenderedPage((prev) => {
      const page = Math.max(1, Math.min(currentPage, numPages || 1));
      return prev !== page ? page : prev;
    });
  }, [isImageMode, mode, currentPage, numPages]);

  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setContentWidth(node.clientWidth);
    });
    observer.observe(node);
    setContentWidth(node.clientWidth);
    return () => observer.disconnect();
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
    if (isImageMode || mode !== 'pagination') return;
    if (!pdfDoc) return;
    const gen = modeGenRef.current;
    const draw = async () => {
      const pageNumber = Math.max(1, Math.min(currentPage, numPages || 1));
      const page = await pdfDoc.getPage(pageNumber);
      if (modeGenRef.current !== gen) return; // mode changed, abort
      const holder = canvasRef.current?.parentElement;
      if (!holder) return;
      const fitWidth = Math.max(180, holder.clientWidth - 4);
      const fitHeight = Math.max(180, holder.clientHeight - 4);
      const baseViewport = page.getViewport({ scale: 1 });
      const scaleW = fitWidth / baseViewport.width;
      const scaleH = fitHeight / baseViewport.height;
      const scale = Math.max(0.001, Math.min(scaleW, scaleH) * zoom);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas || modeGenRef.current !== gen) return;
      const context = canvas.getContext('2d');
      const ratio = safeDevicePixelRatio(viewport.width, viewport.height);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      await page.render({ canvasContext: context, viewport }).promise;
      if (modeGenRef.current !== gen) return;
      setRenderedPage(pageNumber);
      if (pageNumber !== currentPage) {
        onPageChange(pageNumber);
      }
    };

    draw();
  }, [isImageMode, pdfDoc, currentPage, numPages, mode, onPageChange, zoom, contentWidth]);

  // ── Scrolling mode (PDF) ───────────────────────────────────
  useEffect(() => {
    if (isImageMode || mode !== 'scrolling') return;
    if (!pdfDoc) return;
    const mount = scrollRef.current;
    if (!mount) return;

    let disposed = false;
    const gen = modeGenRef.current;
    mount.innerHTML = '';
    mount.scrollTop = 0;

    const drawAll = async () => {
      for (let i = 1; i <= numPages; i += 1) {
        if (disposed || modeGenRef.current !== gen) return;
        const page = await pdfDoc.getPage(i);
        if (disposed || modeGenRef.current !== gen) return;
        const viewportBase = page.getViewport({ scale: 1 });
        const fitWidth = Math.max(180, mount.clientWidth - 6);
        const scale = Math.max(0.001, (fitWidth / viewportBase.width) * zoom);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        const ratio = safeDevicePixelRatio(viewport.width, viewport.height);
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.dataset.page = String(i);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        await page.render({ canvasContext: context, viewport }).promise;
        if (disposed || modeGenRef.current !== gen) return;
        mount.appendChild(canvas);
      }

      if (disposed || modeGenRef.current !== gen) return;
      const nodes = [...mount.querySelectorAll('canvas[data-page]')];
      const targetPage = Math.max(1, Math.min(currentPage, numPages || 1));
      const targetNode = nodes.find((node) => Number(node.dataset.page) === targetPage);
      if (targetNode) {
        mount.scrollTop = targetNode.offsetTop;
      }

      const onScroll = () => {
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
        if (nearest !== currentPage) {
          onPageChange(nearest);
        }

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
      cleanup();
    };
  }, [isImageMode, pdfDoc, numPages, mode, onPageChange, currentPage, zoom, contentWidth]);

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

    // Skip rebuild if images array hasn't changed (prevents duplicates on mode switch)
    if (lastImagesRef.current === images && mount.children.length === images.length) {
      return;
    }
    lastImagesRef.current = images;

    mount.innerHTML = '';

    // Create all img elements first (without src) so DOM order is fixed
    const imgElements = images.map((url, idx) => {
      const pageNum = idx + 1;
      const img = document.createElement('img');
      img.alt = `Page ${pageNum}`;
      img.dataset.page = String(pageNum);
      img.dataset.src = url;
      img.className = 'page-img';
      img.style.width = '100%';
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
            img.style.minHeight = '';
            if (!disposed) loadNext();
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
      if (nearest !== currentPage) {
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

    // Initial scroll position (approximate — images haven't loaded yet)
    const targetPage = Math.max(1, Math.min(currentPage, images.length || 1));
    const targetNode = mount.querySelector(`img[data-page="${targetPage}"]`);
    if (targetNode) {
      mount.scrollTop = targetNode.offsetTop;
    }

    return () => {
      disposed = true;
      mount.removeEventListener('scroll', onScroll);
    };
  }, [isImageMode, images, mode, syncGroup, syncId]);

  // ── Scroll to currentPage (external navigation) ────────────
  useEffect(() => {
    if (!isImageMode || mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount) return;
    const targetNode = mount.querySelector(`img[data-page="${currentPage}"]`);
    if (targetNode) {
      mount.scrollTop = targetNode.offsetTop;
    }
  }, [isImageMode, mode, currentPage]);

  const titleSuffix = useMemo(() => `${renderedPage}${numPages ? ` / ${numPages}` : ''}`, [renderedPage, numPages]);

  return (
    <section className="page-frame page-card pdf-pane">
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
        {thumbnailsOpen && (
          <label className="thumb-cols-label header-thumb-cols">
            <span>Cols: {thumbCols}</span>
            <input
              type="range"
              min="1"
              max="10"
              value={thumbCols}
              onChange={(e) => onThumbColsChange?.(Number(e.target.value))}
              className="thumb-cols-slider"
            />
          </label>
        )}
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
                <img src={thumb.url} alt={`Page ${thumb.page}`} />
                <span>{thumb.page}</span>
              </button>
            ))}
          </div>
        </aside>
        )}

        <div className="pdf-content" ref={contentRef} key={mode}>
          {thumbnailsOpen ? (
            <div className="thumbnail-grid" style={{ gridTemplateColumns: `repeat(${thumbCols}, 1fr)` }}>
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
                    <img src={thumb.url} alt={`Page ${thumb.page}`} />
                    <span>{thumb.page}</span>
                  </button>
                ))}
              </div>
          ) : loadError ? (
            <div className="pdf-error">
              <p>Failed to load PDF</p>
              <small>{loadError}</small>
            </div>
          ) : isImageMode && mode === 'pagination' ? (
            <div className="pdf-single-page">
              <img
                src={images[Math.max(0, Math.min(currentPage - 1, images.length - 1))] || ''}
                alt={`Page ${currentPage}`}
                className="page-img"
                style={{ width: '100%', display: 'block' }}
              />
            </div>
          ) : !isImageMode && mode === 'pagination' ? (
            <div className="pdf-single-page">
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

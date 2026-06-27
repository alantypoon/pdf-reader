import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

function PdfPane({
  source,
  title,
  mode,
  currentPage,
  onPageChange,
  onPageCountChange,
  thumbnailsOpen,
  syncGroup,
  syncId,
  zoom = 1
}) {
  const [pdfDoc, setPdfDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [thumbs, setThumbs] = useState([]);
  const [renderedPage, setRenderedPage] = useState(1);
  const [contentWidth, setContentWidth] = useState(0);
  const canvasRef = useRef(null);
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const syncingFromRemoteRef = useRef(false);

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

  useEffect(() => {
    let isMounted = true;
    if (!source) {
      setPdfDoc(null);
      setNumPages(0);
      setThumbs([]);
      return;
    }

    const load = async () => {
      try {
        const task = pdfjsLib.getDocument({ url: source });
        const doc = await task.promise;
        if (!isMounted) return;
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setRenderedPage(Math.min(currentPage, doc.numPages));

        const thumbsData = [];
        const count = Math.min(doc.numPages, 16);
        for (let i = 1; i <= count; i += 1) {
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
      } catch {
        if (isMounted) {
          setPdfDoc(null);
          setNumPages(0);
          setThumbs([]);
        }
      }
    };

    load();
    return () => {
      isMounted = false;
    };
  }, [source, currentPage]);

  useEffect(() => {
    if (!pdfDoc || mode !== 'pagination') return;
    const draw = async () => {
      const pageNumber = Math.max(1, Math.min(currentPage, numPages || 1));
      const page = await pdfDoc.getPage(pageNumber);
      const holder = canvasRef.current?.parentElement;
      if (!holder) return;
      const fitWidth = Math.max(180, holder.clientWidth - 4);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.max(0.001, (fitWidth / baseViewport.width) * zoom);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      await page.render({ canvasContext: context, viewport }).promise;
      setRenderedPage(pageNumber);
      if (pageNumber !== currentPage) {
        onPageChange(pageNumber);
      }
    };

    draw();
  }, [pdfDoc, currentPage, numPages, mode, onPageChange, zoom, contentWidth]);

  useEffect(() => {
    if (!pdfDoc || mode !== 'scrolling') return;
    const mount = scrollRef.current;
    if (!mount) return;

    let disposed = false;
    mount.innerHTML = '';
    mount.scrollTop = 0;

    const drawAll = async () => {
      for (let i = 1; i <= numPages; i += 1) {
        if (disposed) return;
        const page = await pdfDoc.getPage(i);
        const viewportBase = page.getViewport({ scale: 1 });
        const fitWidth = Math.max(180, mount.clientWidth - 6);
        const scale = Math.max(0.001, (fitWidth / viewportBase.width) * zoom);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.dataset.page = String(i);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        await page.render({ canvasContext: context, viewport }).promise;
        mount.appendChild(canvas);
      }

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
  }, [pdfDoc, numPages, mode, onPageChange, currentPage, zoom, contentWidth]);

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

  const titleSuffix = useMemo(() => `${renderedPage}${numPages ? ` / ${numPages}` : ''}`, [renderedPage, numPages]);

  return (
    <section className="page-frame page-card pdf-pane">
      <header className="page-card-header">
        <strong>{title}</strong>
        <span>{titleSuffix}</span>
      </header>
      <div className={`pdf-pane-shell ${thumbnailsOpen ? 'thumbs-open' : 'thumbs-closed'}`}>
        <aside className="thumbnail-rail" aria-hidden={!thumbnailsOpen}>
          <div className="thumbnail-list">
            {thumbs.map((thumb) => (
              <button
                key={thumb.page}
                className={`thumb-item ${thumb.page === renderedPage ? 'active' : ''}`}
                onClick={() => onPageChange(thumb.page)}
              >
                <img src={thumb.url} alt={`Page ${thumb.page}`} />
                <span>{thumb.page}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="pdf-content" ref={contentRef}>
          {mode === 'pagination' ? (
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

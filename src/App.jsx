import React, { useEffect, useMemo, useRef, useState } from 'react';
import PdfPane from './PdfPane';
import SectionAutocomplete from './SectionAutocomplete';

const PREFERENCES_KEY = 'pdfReaderPreferences';

function loadPreferences() {
  if (typeof window === 'undefined') {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function getSectionName(section, language) {
  const value = section?.[language];
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.name || '';
}

function getSectionResources(section, language) {
  const value = section?.[language];
  if (!value || typeof value === 'string') return [];
  return value.resources || [];
}

function getUserId() {
  if (typeof window === 'undefined') return 'default';
  let id = window.localStorage.getItem('pdfReaderUserId');
  if (!id) {
    id = 'u' + Math.random().toString(36).slice(2, 10);
    window.localStorage.setItem('pdfReaderUserId', id);
  }
  return id;
}

function App() {
  const savedPrefs = loadPreferences();
  const userId = useMemo(() => getUserId(), []);
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const currentStrokeRef = useRef(null);
  const displayModeInitializedRef = useRef(false);
  const [structure, setStructure] = useState([]);
  const [selectedChapter, setSelectedChapter] = useState(savedPrefs.selectedChapter || '1a');
  const [selectedFile, setSelectedFile] = useState(Number(savedPrefs.selectedFile || 1));
  const [selectedPage, setSelectedPage] = useState(Number(savedPrefs.selectedPage || 1));
  const [displayMode, setDisplayMode] = useState(savedPrefs.displayMode || 'scrolling');
  const showThumbnails = displayMode === 'thumbnails';
  const [selectedLanguage, setSelectedLanguage] = useState(savedPrefs.selectedLanguage || 'bilingual');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(Boolean(savedPrefs.sidebarCollapsed));
  const [pageSources, setPageSources] = useState({});
  const [remarks, setRemarks] = useState([]);
  const [pageAnnotations, setPageAnnotations] = useState([]);
  const [tool, setTool] = useState(savedPrefs.tool || 'hand');
  const [textColor, setTextColor] = useState(savedPrefs.textColor || '#1f2937');
  const [noteText, setNoteText] = useState('');
  const [clearedTimestamps, setClearedTimestamps] = useState([]);
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [thumbCols, setThumbCols] = useState(Number(savedPrefs.thumbCols || 4));
  const [zoomLevel, setZoomLevel] = useState(Number(savedPrefs.zoomLevel || 1));
  const [pageCounts, setPageCounts] = useState({});
  const [modalInfo, setModalInfo] = useState(null);
  const [resourcesDrawerOpen, setResourcesDrawerOpen] = useState(false);
  const [panelVisible, setPanelVisible] = useState(savedPrefs.panelVisible !== false);
  const [panelPos, setPanelPos] = useState(() => {
    const saved = savedPrefs.panelPos;
    return (saved && typeof saved.x === 'number' && typeof saved.y === 'number')
      ? saved
      : { x: undefined, y: undefined };
  });
  const panelRef = useRef(null);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, posX: 0, posY: 0 });

  const fitScreen = () => {
    setZoomLevel(1);
  };

  useEffect(() => {
    fetch('api/catalog')
      .then((response) => response.json())
      .then((data) => {
        const chapters = data.chapters || [];
        setStructure(chapters);
        if (chapters.length) {
          setSelectedChapter((current) => (chapters.some((chapter) => chapter.id === current) ? current : chapters[0].id));
        }
      });
  }, []);

  useEffect(() => {
    fetch(`api/remarks?userId=${userId}`)
      .then((response) => response.json())
      .then((data) => setRemarks(data.remarks || []));
  }, [userId]);

  useEffect(() => {
    const existing = remarks.filter(
      (remark) =>
        remark.chapter === selectedChapter &&
        Number(remark.page) === Number(selectedPage) &&
        !clearedTimestamps.includes(remark.createdAt)
    );
    setPageAnnotations(existing);
  }, [remarks, selectedChapter, selectedPage, clearedTimestamps]);

  const currentChapter = useMemo(
    () => structure.find((chapter) => chapter.id === selectedChapter),
    [structure, selectedChapter]
  );

  const currentSection = useMemo(
    () => currentChapter?.contents?.find((item) => Number(item.page || item.section) === Number(selectedFile)),
    [currentChapter, selectedFile]
  );

  useEffect(() => {
    if (!currentChapter?.contents?.length) return;
    const first = Number(currentChapter.contents[0].page || currentChapter.contents[0].section || 1);
    setSelectedFile((current) => {
      const hasCurrent = currentChapter.contents.some((item) => Number(item.page || item.section) === Number(current));
      return hasCurrent ? current : first;
    });
    setSelectedPage((current) => Math.max(1, Number(current) || 1));
  }, [currentChapter]);

  useEffect(() => {
    const loadPages = async () => {
      const targets = selectedLanguage === 'bilingual' ? ['en', 'tc'] : [selectedLanguage];
      console.log(`[loadPages] chapter=${selectedChapter} file=${selectedFile} languages=${targets.join(',')}`);
      const entries = await Promise.all(
        targets.map(async (language) => {
          const url = `api/page?chapter=${selectedChapter}&language=${language}&page=${selectedFile}`;
          console.log(`[loadPages] fetching: ${url}`);
          const response = await fetch(url);
          const data = await response.json();
          const result = data.images || data.url || '';
          console.log(`[loadPages]   ${language}: images=${Array.isArray(data.images) ? data.images.length : 'N/A'} url=${typeof data.url === 'string' ? data.url : 'N/A'} result=${Array.isArray(result) ? result.length + ' imgs' : result}`);
          return [language, result];
        })
      );
      console.log(`[loadPages] setting pageSources:`, Object.keys(Object.fromEntries(entries)));
      setPageSources(Object.fromEntries(entries));
    };

    if (selectedChapter) {
      loadPages();
    }
  }, [selectedChapter, selectedFile, selectedLanguage]);

  useEffect(() => {
    if (!displayModeInitializedRef.current) {
      displayModeInitializedRef.current = true;
      return;
    }
    fitScreen();
  }, [displayMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const prefs = {
      selectedChapter,
      selectedFile,
      selectedPage,
      displayMode,
      selectedLanguage,
      sidebarCollapsed,
      tool,
      textColor,
      thumbCols,
      zoomLevel,
      panelPos,
      panelVisible
    };
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
  }, [
    selectedChapter,
    selectedFile,
    selectedPage,
    displayMode,
    selectedLanguage,
    sidebarCollapsed,
    tool,
    textColor,
    thumbCols,
    zoomLevel,
    panelPos,
    panelVisible
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    const resize = () => {
      const frame = canvas.parentElement;
      const rect = frame.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * window.devicePixelRatio);
      canvas.height = Math.floor(rect.height * window.devicePixelRatio);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      context.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
      redraw(context, rect.width, rect.height, pageAnnotations);
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [pageAnnotations]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    redraw(context, rect.width, rect.height, pageAnnotations);
  }, [pageAnnotations, pageSources]);

  const changePage = (direction) => {
    setSelectedPage((current) => {
      const next = current + direction;
      const max = maxNavigablePage;
      if (!Number.isFinite(max)) {
        return Math.max(1, next);
      }
      return Math.max(1, Math.min(max, next));
    });
  };

  const moveSection = (direction) => {
    if (!currentChapter?.contents?.length) return;
    const sections = currentChapter.contents.map((item) => Number(item.page || item.section));
    const currentIndex = sections.findIndex((page) => page === Number(selectedFile));
    if (currentIndex < 0) return;
    const nextIndex = Math.max(0, Math.min(sections.length - 1, currentIndex + direction));
    setSelectedFile(sections[nextIndex]);
    setSelectedPage(1);
  };

  const changeZoom = (delta) => {
    setZoomLevel((current) => {
      const next = current + delta;
      return Math.min(5, Math.max(0, Number(next.toFixed(2))));
    });
  };

  const cycleBook = () => {
    if (!structure.length) return;
    const index = structure.findIndex((chapter) => chapter.id === selectedChapter);
    const nextIndex = index < 0 ? 0 : (index + 1) % structure.length;
    const nextBook = structure[nextIndex];
    if (nextBook) {
      setSelectedChapter(nextBook.id);
      const firstSection = nextBook.contents?.[0];
      const firstPage = firstSection ? Number(firstSection.page || firstSection.section) : 1;
      setSelectedFile(firstPage);
      setSelectedPage(1);
    }
  };

  const cycleDisplayMode = () => {
    const modes = ['scrolling', 'pagination', 'thumbnails'];
    const idx = modes.indexOf(displayMode);
    setDisplayMode(modes[(idx + 1) % modes.length]);
    setSelectedPage(1);
  };

  const cycleLanguage = () => {
    const order = ['bilingual', 'en', 'tc'];
    const index = order.indexOf(selectedLanguage);
    const next = order[(index + 1) % order.length];
    setSelectedLanguage(next);
  };

  const openResource = (resource) => {
    // MP3 files always use the audio player modal
    if (/\.mp3(\?|$)/i.test(resource.url)) {
      setModalInfo({ url: resource.url, name: resource.name });
      return;
    }
    try {
      const host = new URL(resource.url).hostname;
      if (host === 'eresources.oupchina.com.hk' || host.endsWith('.oupchina.com.hk')) {
        window.open(resource.url, '_blank', 'noopener,noreferrer');
        return;
      }
    } catch { /* invalid URL, use modal */ }
    setModalInfo({ url: resource.url, name: resource.name });
  };
  const saveRemark = async (remark) => {
    const response = await fetch('api/remarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, ...remark })
    });
    const data = await response.json();
    setRemarks(data.remarks || []);
  };

  const clearPageRemarks = async () => {
    const response = await fetch(
      `api/remarks?userId=${userId}&chapter=${selectedChapter}&page=${selectedPage}`,
      { method: 'DELETE' }
    );
    const data = await response.json();
    setRemarks(data.remarks || []);
    setUndoStack([]);
    setRedoStack([]);
  };

  const clearAllRemarks = async () => {
    const response = await fetch(
      `api/remarks?userId=${userId}&chapter=${selectedChapter}`,
      { method: 'DELETE' }
    );
    const data = await response.json();
    setRemarks(data.remarks || []);
    setUndoStack([]);
    setRedoStack([]);
  };

  const undoRemark = async () => {
    const pageRemarks = remarks.filter(
      (r) => r.chapter === selectedChapter && Number(r.page) === Number(selectedPage)
    );
    if (!pageRemarks.length) return;
    const last = pageRemarks[pageRemarks.length - 1];
    // Delete from server
    await fetch(
      `api/remarks?userId=${userId}&chapter=${selectedChapter}&page=${selectedPage}`,
      { method: 'DELETE' }
    );
    // But keep track for redo
    setUndoStack((prev) => [...prev, last]);
    setRedoStack([]);
    // Remove from local state
    setRemarks((prev) => prev.filter((r) => r !== last));
  };

  const redoRemark = async () => {
    if (!undoStack.length) return;
    const last = undoStack[undoStack.length - 1];
    // Re-add to server
    const response = await fetch('api/remarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, ...last })
    });
    const data = await response.json();
    setRemarks(data.remarks || []);
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, last]);
  };

  const getPoint = (event) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  };

  const redraw = (context, width, height, annotations) => {
    if (!context) return;
    context.clearRect(0, 0, width, height);
    for (const annotation of annotations) {
      if (annotation.type === 'stroke') {
        const points = annotation.points || [];
        if (points.length < 2) continue;
        context.save();
        context.lineJoin = 'round';
        context.lineCap = 'round';
        context.strokeStyle = annotation.color;
        context.globalAlpha = annotation.mode === 'highlight' ? 0.28 : 1;
        context.lineWidth = annotation.mode === 'highlight' ? 18 : 4;
        context.beginPath();
        context.moveTo(points[0].x, points[0].y);
        for (const point of points.slice(1)) {
          context.lineTo(point.x, point.y);
        }
        context.stroke();
        context.restore();
      }

      if (annotation.type === 'text') {
        context.save();
        context.fillStyle = annotation.color;
        context.font = '18px Inter, system-ui, sans-serif';
        context.fillText(annotation.text, annotation.x, annotation.y);
        context.restore();
      }
    }
  };

  const handlePointerDown = (event) => {
    if (tool !== 'pen' && tool !== 'highlight') return;
    drawingRef.current = true;
    currentStrokeRef.current = {
      type: 'stroke',
      chapter: selectedChapter,
      page: selectedPage,
      mode: tool,
      color: tool === 'highlight' ? '#fbbf24' : textColor,
      points: [getPoint(event)],
      createdAt: new Date().toISOString()
    };
  };

  const handlePointerMove = (event) => {
    if (!drawingRef.current || !currentStrokeRef.current) return;
    const nextPoint = getPoint(event);
    currentStrokeRef.current.points.push(nextPoint);
    const context = canvasRef.current.getContext('2d');
    const rect = canvasRef.current.getBoundingClientRect();
    redraw(context, rect.width, rect.height, [...pageAnnotations, currentStrokeRef.current]);
  };

  const handlePointerUp = async () => {
    if (!drawingRef.current || !currentStrokeRef.current) return;
    drawingRef.current = false;
    const stroke = currentStrokeRef.current;
    currentStrokeRef.current = null;
    await saveRemark(stroke);
  };

  const handleCanvasClick = async (event) => {
    if (tool !== 'text' || !noteText.trim()) return;
    const point = getPoint(event);
    const remark = {
      type: 'text',
      chapter: selectedChapter,
      page: selectedPage,
      x: point.x,
      y: point.y,
      color: textColor,
      text: noteText.trim(),
      createdAt: new Date().toISOString()
    };
    await saveRemark(remark);
    setNoteText('');
  };

  // ── Panel drag ─────────────────────────────────────────────
  const handlePanelDragStart = (event) => {
    if (!panelRef.current) return;
    dragRef.current.dragging = true;
    dragRef.current.startX = event.clientX;
    dragRef.current.startY = event.clientY;
    const rect = panelRef.current.getBoundingClientRect();
    dragRef.current.posX = rect.left;
    dragRef.current.posY = rect.top;
    panelRef.current.classList.add('dragging');
    event.preventDefault();
  };

  useEffect(() => {
    const onMove = (event) => {
      if (!dragRef.current.dragging) return;
      const dx = event.clientX - dragRef.current.startX;
      const dy = event.clientY - dragRef.current.startY;
      setPanelPos({
        x: dragRef.current.posX + dx,
        y: dragRef.current.posY + dy
      });
    };

    const onUp = () => {
      if (!dragRef.current.dragging) return;
      dragRef.current.dragging = false;
      if (panelRef.current) {
        panelRef.current.classList.remove('dragging');
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const visibleLanguages = selectedLanguage === 'bilingual' ? ['en', 'tc'] : [selectedLanguage];
  const isBilingualView = selectedLanguage === 'bilingual';
  const maxNavigablePage = useMemo(() => {
    const counts = visibleLanguages
      .map((language) => Number(pageCounts[language] || 0))
      .filter((value) => value > 0);
    return counts.length ? Math.min(...counts) : Number.POSITIVE_INFINITY;
  }, [visibleLanguages, pageCounts]);

  useEffect(() => {
    if (!Number.isFinite(maxNavigablePage)) return;
    setSelectedPage((current) => Math.max(1, Math.min(maxNavigablePage, current)));
  }, [maxNavigablePage]);

  // ── Escape key closes modal then drawer ───────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (modalInfo) { setModalInfo(null); return; }
      if (resourcesDrawerOpen) { setResourcesDrawerOpen(false); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalInfo, resourcesDrawerOpen]);

  // Derive modal content type
  const modalType = useMemo(() => {
    if (!modalInfo) return null;
    const url = modalInfo.url;
    if (/\.mp3(\?|$)/i.test(url)) return 'audio';
    const yt = url.match(
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})/
    );
    if (yt) return { type: 'youtube', id: yt[1] };
    return 'iframe';
  }, [modalInfo]);

  // Rewrite OUP URLs through proxy to bypass X-Frame-Options
  const modalFrameSrc = useMemo(() => {
    if (!modalInfo) return '';
    const url = modalInfo.url;
    try {
      const host = new URL(url).hostname;
      if (host === 'isolution.oupchina.com.hk' || host.endsWith('.oupchina.com.hk')) {
        return `api/proxy?url=${encodeURIComponent(url)}`;
      }
    } catch { /* invalid URL, use as-is */ }
    return url;
  }, [modalInfo]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-title-row">
          <h1>
            <svg className="sidebar-logo" viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm2 0v14h12V5H6zm2 2h8v2H8V7zm0 4h8v2H8v-2zm0 4h5v2H8v-2z" />
            </svg>
            PDF Reader
          </h1>
          <button
            className="sidebar-toggle"
            onClick={() => {
              setSidebarCollapsed((current) => !current);
              setSelectedPage(1);
            }}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <span aria-hidden="true" className="sidebar-toggle-icon">{sidebarCollapsed ? '>>' : '<<'}</span>
          </button>
        </div>
        <label>
          <span className="sidebar-label-icon">
            <svg viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm2 0v14h12V5H6zm2 2h8v2H8V7zm0 4h8v2H8v-2zm0 4h5v2H8v-2z" />
            </svg>
            Book
          </span>
          <select value={selectedChapter} onChange={(event) => {
            const newChapterId = event.target.value;
            setSelectedChapter(newChapterId);
            const newChapter = structure.find((c) => c.id === newChapterId);
            const firstSection = newChapter?.contents?.[0];
            const firstPage = firstSection ? Number(firstSection.page || firstSection.section) : 1;
            setSelectedFile(firstPage);
            setSelectedPage(1);
          }}>
            {structure.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>{chapter.name || chapter.id}</option>
            ))}
          </select>
        </label>

        {!sidebarCollapsed && (
          <label>
            <span className="sidebar-label-icon">
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M3 4h18v2H3V4zm0 7h18v2H3v-2zm0 7h18v2H3v-2z" />
              </svg>
              Section
            </span>
            <div className="toc">
            <SectionAutocomplete
              sections={currentChapter?.contents || []}
              onSelect={(page) => {
                setSelectedFile(page);
                setSelectedPage(1);
              }}
              getSectionName={getSectionName}
              currentSection={currentSection}
              language={selectedLanguage}
            />
          </div>
          </label>
        )}

        <label>
          <span className="sidebar-label-icon">
            {displayMode === 'thumbnails' ? (
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="3" y="4" width="6" height="7" rx="1.2" />
                <rect x="3" y="13" width="6" height="7" rx="1.2" />
                <rect x="11" y="4" width="10" height="16" rx="1.5" />
              </svg>
            ) : displayMode === 'scrolling' ? (
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="3" y="3" width="18" height="4" rx="1" />
                <rect x="3" y="9" width="18" height="4" rx="1" />
                <rect x="3" y="15" width="18" height="4" rx="1" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <line x1="8" y1="8" x2="16" y2="8" stroke="currentColor" strokeWidth="1.5" />
                <line x1="8" y1="12" x2="16" y2="12" stroke="currentColor" strokeWidth="1.5" />
                <line x1="8" y1="16" x2="13" y2="16" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            )}
            Display mode
          </span>
          <div className="toggle-group">
            <button
              className={`toggle-btn ${displayMode === 'pagination' ? 'active' : ''}`}
              onClick={() => { setDisplayMode('pagination'); setSelectedPage(1); }}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="4" y="3" width="16" height="18" rx="2" />
              </svg>
              Paginated
            </button>
            <button
              className={`toggle-btn ${displayMode === 'scrolling' ? 'active' : ''}`}
              onClick={() => { setDisplayMode('scrolling'); setSelectedPage(1); }}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="3" y="3" width="18" height="4" rx="1" />
                <rect x="3" y="9" width="18" height="4" rx="1" />
                <rect x="3" y="15" width="18" height="4" rx="1" />
              </svg>
              Scroll
            </button>
            <button
              className={`toggle-btn ${displayMode === 'thumbnails' ? 'active' : ''}`}
              onClick={() => { setDisplayMode('thumbnails'); setSelectedPage(1); }}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="3" y="4" width="6" height="7" rx="1.2" />
                <rect x="3" y="13" width="6" height="7" rx="1.2" />
                <rect x="11" y="4" width="10" height="16" rx="1.5" />
              </svg>
              Thumbs
            </button>
          </div>
        </label>

        <label>
          <span className="sidebar-label-icon">
            <svg viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M5 6h9v2H5V6zm2 4h5v2H7v-2zm7.5 0h2.4L20 18h-2.1l-.7-2h-3l-.7 2h-2.1l3.2-8zm.2 4h1.7l-.8-2.3-.9 2.3z" />
            </svg>
            Language
          </span>
          <button className="cycle-toggle" onClick={cycleLanguage}>
            {selectedLanguage === 'bilingual' ? 'Bilingual' : selectedLanguage === 'en' ? 'English' : '中文'}
          </button>
        </label>

        {sidebarCollapsed && (
          <div className="sidebar-icon-stack" aria-label="Collapsed sidebar controls">
            <button
              className="sidebar-icon-btn"
              onClick={cycleBook}
              data-tooltip="Switch book"
              aria-label="Switch book"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M4 5a2 2 0 0 1 2-2h13v17H6a2 2 0 0 0-2 2V5zm2 0v13h11V5H6z" />
              </svg>
            </button>
            <button
              className="sidebar-icon-btn"
              onClick={cycleDisplayMode}
              data-tooltip={displayMode === 'thumbnails' ? 'Thumbnails' : displayMode === 'scrolling' ? 'Scrolling mode' : 'Pagination mode'}
              aria-label="Toggle display mode"
            >
              {displayMode === 'thumbnails' ? (
                <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                  <rect x="3" y="4" width="6" height="7" rx="1.2" />
                  <rect x="3" y="13" width="6" height="7" rx="1.2" />
                  <rect x="11" y="4" width="10" height="16" rx="1.5" />
                </svg>
              ) : displayMode === 'scrolling' ? (
                <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                  <rect x="3" y="3" width="18" height="4" rx="1" />
                  <rect x="3" y="9" width="18" height="4" rx="1" />
                  <rect x="3" y="15" width="18" height="4" rx="1" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                  <rect x="4" y="3" width="16" height="18" rx="2" />
                  <line x1="8" y1="8" x2="16" y2="8" stroke="currentColor" strokeWidth="1.5" />
                  <line x1="8" y1="12" x2="16" y2="12" stroke="currentColor" strokeWidth="1.5" />
                  <line x1="8" y1="16" x2="13" y2="16" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              )}
            </button>
            <button
              className="sidebar-icon-btn"
              onClick={cycleLanguage}
              data-tooltip="Switch language"
              aria-label="Switch language"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M5 6h9v2H5V6zm2 4h5v2H7v-2zm7.5 0h2.4L20 18h-2.1l-.7-2h-3l-.7 2h-2.1l3.2-8zm.2 4h1.7l-.8-2.3-.9 2.3z" />
              </svg>
            </button>
            <button
              className={`sidebar-icon-btn ${resourcesDrawerOpen ? 'active' : ''}`}
              onClick={() => setResourcesDrawerOpen((current) => !current)}
              data-tooltip="Toggle resources"
              aria-label="Toggle resources"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 0 0-5 5 5 5 0 0 0 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4a5 5 0 0 0 5-5 5 5 0 0 0-5-5z" />
              </svg>
            </button>
            <button
              className={`sidebar-icon-btn ${panelVisible ? 'active' : ''}`}
              onClick={() => setPanelVisible((current) => !current)}
              data-tooltip="Toggle toolbar"
              aria-label="Toggle toolbar"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="3" y="3" width="18" height="14" rx="2" />
                <rect x="6" y="7" width="12" height="2" rx="1" />
                <rect x="6" y="11" width="8" height="2" rx="1" />
              </svg>
            </button>
          </div>
        )}

        {!sidebarCollapsed && (
          <label className="toggle-row">
            <button
              className={`toggle-btn icon-only ${resourcesDrawerOpen ? 'active' : ''}`}
              onClick={() => setResourcesDrawerOpen((current) => !current)}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 0 0-5 5 5 5 0 0 0 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4a5 5 0 0 0 5-5 5 5 0 0 0-5-5z" />
              </svg>
              Resources
            </button>
          </label>
        )}

        {!sidebarCollapsed && (
          <label className="toggle-row">
            <button
              className={`toggle-btn icon-only ${panelVisible ? 'active' : ''}`}
              onClick={() => setPanelVisible((current) => !current)}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="3" y="3" width="18" height="14" rx="2" />
                <rect x="6" y="7" width="12" height="2" rx="1" />
                <rect x="6" y="11" width="8" height="2" rx="1" />
              </svg>
              Toolbar
            </button>
          </label>
        )}

        {!sidebarCollapsed && (
          <label className="toggle-row">
            <button
              className={`toggle-btn icon-only ai-generate-btn ${aiDrawerOpen ? 'active' : ''}`}
              onClick={handleAiGenerate}
              disabled={aiLoading}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
              </svg>
              {aiLoading ? 'Generating…' : 'AI Generation'}
            </button>
          </label>
        )}

        {sidebarCollapsed && (
          <button
            className={`sidebar-icon-btn ${aiDrawerOpen ? 'active' : ''}`}
            onClick={handleAiGenerate}
            disabled={aiLoading}
            data-tooltip={aiLoading ? 'Generating…' : 'AI Generation'}
            aria-label="AI Generation"
          >
            <svg viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
            </svg>
          </button>
        )}

      </aside>

      <main className="reader">
        <div className={`book-stage ${displayMode} ${isBilingualView ? 'bilingual-layout' : ''}`}>
          {visibleLanguages.map((language) => {
            const src = pageSources[language];
            const isImages = Array.isArray(src);
            return (
              <PdfPane
                key={language}
                source={isImages ? '' : (src || '')}
                images={isImages ? src : null}
                title={`${language === 'en' ? 'English' : '中文'} · ${currentChapter?.name || selectedChapter}`}
                section={selectedFile}
                mode={displayMode}
                currentPage={selectedPage}
                onPageChange={setSelectedPage}
                onPageCountChange={(count) => setPageCounts((current) => ({ ...current, [language]: count }))}
                thumbnailsOpen={showThumbnails}
                thumbCols={thumbCols}
                onThumbColsChange={setThumbCols}
                onThumbnailClick={(page) => {
                  setSelectedPage(page);
                  setDisplayMode('pagination');
                }}
                syncGroup={isBilingualView && displayMode === 'scrolling' ? `${selectedChapter}-${selectedFile}-bilingual` : ''}
                syncId={language}
                zoom={zoomLevel}
              />
            );
          })}
          <canvas
            ref={canvasRef}
            className="annotation-canvas"
            style={{ pointerEvents: tool === 'hand' ? 'none' : 'auto' }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            onClick={handleCanvasClick}
          />
        </div>

        {resourcesDrawerOpen && currentSection && (
          <div className="resources-drawer-overlay" onClick={() => setResourcesDrawerOpen(false)}>
            <section className="section-resources resources-drawer" onClick={(e) => e.stopPropagation()}>
            {(selectedLanguage === 'bilingual' || selectedLanguage === 'en') && (
              <div className="resources-column">
                <h3>{getSectionName(currentSection, 'en')}</h3>
                {getSectionResources(currentSection, 'en').length === 0 ? (
                  <p className="resources-empty">No resources</p>
                ) : (
                  <ul>
                    {getSectionResources(currentSection, 'en').map((resource) => (
                      <li key={resource.url || resource.name}>
                        <button
                          className="resource-link"
                          onClick={() => openResource(resource)}
                        >
                          {resource.name}
                        </button>
                        {resource.type && <span className="resource-type">{resource.type}</span>}
                        {resource.page && <span className="resource-page">p.{resource.page}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {(selectedLanguage === 'bilingual' || selectedLanguage === 'tc') && (
              <div className="resources-column">
                <h3>{getSectionName(currentSection, 'tc')}</h3>
                {getSectionResources(currentSection, 'tc').length === 0 ? (
                  <p className="resources-empty">No resources</p>
                ) : (
                  <ul>
                    {getSectionResources(currentSection, 'tc').map((resource) => (
                      <li key={resource.url || resource.name}>
                        <button
                          className="resource-link"
                          onClick={() => openResource(resource)}
                        >
                          {resource.name}
                        </button>
                        {resource.type && <span className="resource-type">{resource.type}</span>}
                        {resource.page && <span className="resource-page">p.{resource.page}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
          </div>
        )}

        {panelVisible && (
        <section
          className="annotation-panel"
          ref={panelRef}
          style={{
            left: panelPos.x != null ? `${panelPos.x}px` : undefined,
            top: panelPos.y != null ? `${panelPos.y}px` : undefined,
            right: panelPos.x == null ? '16px' : undefined,
            bottom: panelPos.y == null ? '16px' : undefined
          }}
        >
          <span
            className="panel-drag-handle"
            onMouseDown={handlePanelDragStart}
            title="Drag to move panel"
            aria-label="Drag to move panel"
          >
            <svg viewBox="0 0 24 24" role="presentation" focusable="false">
              <circle cx="9" cy="5" r="1.5" />
              <circle cx="15" cy="5" r="1.5" />
              <circle cx="9" cy="12" r="1.5" />
              <circle cx="15" cy="12" r="1.5" />
              <circle cx="9" cy="19" r="1.5" />
              <circle cx="15" cy="19" r="1.5" />
            </svg>
          </span>
          <div className="panel-scroll-area">
          <div className="toolbar-group toolbar-primary">
            <button onClick={() => moveSection(-1)} title="Previous section" aria-label="Previous section">|&lt;</button>
            <button onClick={() => changePage(-1)} title="Previous page" aria-label="Previous page">&lt;</button>
            <span className="page-indicator">{selectedPage}</span>
            <button onClick={() => changePage(1)} title="Next page" aria-label="Next page">&gt;</button>
            <button onClick={() => moveSection(1)} title="Next section" aria-label="Next section">&gt;|</button>
            <button className="icon-btn" onClick={fitScreen} title="Fit screen" aria-label="Fit screen">
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M4 9V4h5v2H6v3H4zm10-5h6v6h-2V6h-4V4zM6 16h3v2H4v-5h2v3zm12-3h2v5h-6v-2h4v-3z" />
              </svg>
            </button>
            <button onClick={() => changeZoom(-0.1)} title="Zoom out" aria-label="Zoom out">-</button>
            <span className="zoom-indicator">{Math.round(zoomLevel * 100)}%</span>
            <button onClick={() => changeZoom(0.1)} title="Zoom in" aria-label="Zoom in">+</button>
          </div>
          <div className="toolbar-group toolbar-secondary">
            <button
              className={`tool-btn ${tool === 'hand' ? 'active' : ''}`}
              onClick={() => setTool('hand')}
              title="Hand / Pan"
              aria-label="Hand pan tool"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M18 13.5V11a1.5 1.5 0 0 0-3 0v2.5a1.5 1.5 0 0 0-3 0V7a1.5 1.5 0 0 0-3 0v8.5a1.5 1.5 0 0 0-3 0V12a1.5 1.5 0 0 0-3 0v3c0 3.04 2.46 5.5 5.5 5.5h2.55a5.5 5.5 0 0 0 3.89-1.61l3.54-3.54A1.5 1.5 0 0 0 18 13.5z" />
              </svg>
            </button>
            <button
              className={`tool-btn ${tool === 'pen' ? 'active' : ''}`}
              onClick={() => setTool('pen')}
              title="Pen"
              aria-label="Pen tool"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
              </svg>
            </button>
            <button
              className={`tool-btn ${tool === 'text' ? 'active' : ''}`}
              onClick={() => setTool('text')}
              title="Text"
              aria-label="Text tool"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M5 4v3h5.5v12h3V7H19V4H5z" />
              </svg>
            </button>
            <button
              className={`tool-btn ${tool === 'highlight' ? 'active' : ''}`}
              onClick={() => setTool('highlight')}
              title="Highlighter"
              aria-label="Highlighter tool"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M15.24 2.36l-11 11a1 1 0 0 0-.24.59V17a1 1 0 0 0 1 1h3.05a1 1 0 0 0 .59-.24l11-11a1 1 0 0 0 0-1.41l-3.4-3.4a1 1 0 0 0-1.41 0zM5 16v-2.5l9-9L16.5 7l-9 9H5z" />
                <rect x="2" y="18" width="20" height="3" rx="1" />
              </svg>
            </button>
            <span className="toolbar-sep" />
            <input type="color" value={textColor} onChange={(event) => setTextColor(event.target.value)} title="Color" aria-label="Color" />
            <input value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="Remark" />
            <button
              className="tool-btn"
              onClick={() => saveRemark({
                type: 'text',
                chapter: selectedChapter,
                page: selectedPage,
                color: textColor,
                text: noteText,
                createdAt: new Date().toISOString()
              })}
              title="Save text"
              aria-label="Save text annotation"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M17 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm4-10H8V5h8v4z" />
              </svg>
            </button>
            <span className="toolbar-sep" />
            <button
              className="tool-btn"
              disabled={!remarks.filter(r => r.chapter === selectedChapter && Number(r.page) === Number(selectedPage)).length}
              onClick={undoRemark}
              title="Undo"
              aria-label="Undo"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
              </svg>
            </button>
            <button
              className="tool-btn"
              disabled={!undoStack.length}
              onClick={redoRemark}
              title="Redo"
              aria-label="Redo"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16a8.002 8.002 0 0 1 7.6-5.5c1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z" />
              </svg>
            </button>
            <span className="toolbar-sep" />
            <button
              className="tool-btn"
              onClick={clearPageRemarks}
              title="Erase page"
              aria-label="Erase page"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4h-3.5z" />
              </svg>
            </button>
            <button
              className="tool-btn"
              onClick={clearAllRemarks}
              title="Erase all"
              aria-label="Erase all"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4h-3.5z" />
                <path d="M2 7h20" stroke="currentColor" strokeWidth="2" fill="none" />
              </svg>
            </button>
          </div>
          <button
            className="tool-btn panel-close-btn"
            onClick={() => setPanelVisible(false)}
            title="Close panel"
            aria-label="Close panel"
          >
            <svg viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
          </div>
        </section>
        )}


      </main>

      {/* ── AI Generation Drawer ─────────────────────────── */}
      {aiDrawerOpen && (
        <div className="resources-drawer-overlay" onClick={() => setAiDrawerOpen(false)}>
          <section className="ai-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="ai-drawer-header">
              <h2>
                <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="ai-header-icon">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                </svg>
                AI Study Materials
              </h2>
              <div className="ai-drawer-header-actions">
                {aiContent && !aiLoading && (
                  <button className="ai-regenerate-btn" onClick={handleAiGenerate} title="Regenerate">
                    <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                      <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                    </svg>
                  </button>
                )}
                <button className="modal-close" onClick={() => setAiDrawerOpen(false)} aria-label="Close">✕</button>
              </div>
            </div>

            <div className="ai-drawer-body">
              {aiLoading && (
                <div className="ai-loading">
                  <div className="ai-spinner" />
                  <p>Generating flash cards and quiz questions…</p>
                  <small>This may take 30-60 seconds</small>
                </div>
              )}

              {aiError && !aiLoading && (
                <div className="ai-error">
                  <p>⚠️ {aiError}</p>
                  <button className="ai-retry-btn" onClick={handleAiGenerate}>Retry</button>
                </div>
              )}

              {aiContent && !aiLoading && (
                <div className="ai-content">
                  {/* Flash Cards */}
                  {aiContent.flashcards && aiContent.flashcards.length > 0 && (
                    <div className="ai-section">
                      <h3 className="ai-section-title">
                        <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="ai-section-icon">
                          <rect x="2" y="4" width="20" height="16" rx="2" />
                          <line x1="8" y1="9" x2="16" y2="9" stroke="currentColor" strokeWidth="1.5" />
                          <line x1="8" y1="13" x2="12" y2="13" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                        Flash Cards ({aiContent.flashcards.length})
                      </h3>
                      <div className="flashcards-grid">
                        {aiContent.flashcards.map((card, idx) => (
                          <div
                            key={idx}
                            className={`flashcard ${flippedCards[idx] ? 'flipped' : ''}`}
                            onClick={() => toggleFlashcard(idx)}
                          >
                            <div className="flashcard-inner">
                              <div className="flashcard-front">
                                <span className="flashcard-label">Q{idx + 1}</span>
                                <p>{card.question}</p>
                                <small className="flashcard-hint">Click to reveal answer</small>
                              </div>
                              <div className="flashcard-back">
                                <span className="flashcard-label">A{idx + 1}</span>
                                <p>{card.answer}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* MCQ Quiz */}
                  {aiContent.mcq && aiContent.mcq.length > 0 && (
                    <div className="ai-section">
                      <h3 className="ai-section-title">
                        <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="ai-section-icon">
                          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
                          <text x="12" y="17" textAnchor="middle" fontSize="12" fill="currentColor" fontWeight="700">?</text>
                        </svg>
                        MCQ Quiz ({aiContent.mcq.length})
                      </h3>
                      <div className="mcq-list">
                        {aiContent.mcq.map((q, qIdx) => {
                          const selected = mcqAnswers[qIdx];
                          const isCorrect = selected === q.correct;
                          return (
                            <div key={qIdx} className={`mcq-item ${selected ? 'answered' : ''}`}>
                              <p className="mcq-question">
                                <strong>Q{qIdx + 1}.</strong> {q.question}
                              </p>
                              <div className="mcq-options">
                                {(q.options || []).map((opt) => {
                                  const optLetter = opt.charAt(0);
                                  let optClass = 'mcq-option';
                                  if (selected) {
                                    if (optLetter === q.correct) optClass += ' correct';
                                    else if (optLetter === selected && !isCorrect) optClass += ' incorrect';
                                  }
                                  return (
                                    <button
                                      key={optLetter}
                                      className={optClass}
                                      onClick={() => !selected && handleMcqSelect(qIdx, optLetter)}
                                      disabled={!!selected}
                                    >
                                      {opt}
                                    </button>
                                  );
                                })}
                              </div>
                              {selected && (
                                <div className={`mcq-feedback ${isCorrect ? 'correct' : 'incorrect'}`}>
                                  <strong>{isCorrect ? '✓ Correct!' : '✗ Incorrect'}</strong>
                                  <p>{q.explanation}</p>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Raw / unparsed content fallback */}
                  {!aiContent.flashcards && !aiContent.mcq && aiContent.raw && (
                    <div className="ai-section">
                      <h3 className="ai-section-title">Generated Content</h3>
                      <pre className="ai-raw">{aiContent.raw}</pre>
                    </div>
                  )}
                </div>
              )}

              {!aiContent && !aiLoading && !aiError && (
                <div className="ai-empty">
                  <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="ai-empty-icon">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                  </svg>
                  <p>Click &ldquo;AI Generation&rdquo; in the sidebar to generate flash cards and quiz questions for this section.</p>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {modalInfo && (
        <div className="modal-overlay" onClick={() => setModalInfo(null)}>
          <div className={`modal-frame${modalType === 'audio' ? ' modal-audio-frame' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-url-label">{modalInfo.name || modalInfo.url}</span>
              <a
                href={modalInfo.url}
                target="_blank"
                rel="noopener noreferrer"
                className="modal-open-link"
                title="Open in new tab"
              >
                ↗
              </a>
              <button
                className="modal-close"
                onClick={() => setModalInfo(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            {modalType === 'audio' ? (
              <div className="modal-audio-wrap">
                <audio controls autoPlay className="modal-audio">
                  <source src={modalInfo.url} type="audio/mpeg" />
                </audio>
              </div>
            ) : modalType?.type === 'youtube' ? (
              <iframe
                src={`https://www.youtube.com/embed/${modalType.id}`}
                className="modal-iframe"
                title="YouTube video"
                allow="autoplay; encrypted-media"
                allowFullScreen
              />
            ) : (
              <iframe src={modalFrameSrc} className="modal-iframe" title="Resource viewer" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Swal from 'sweetalert2';
import BookAutocomplete from './BookAutocomplete';
import PdfPane from './PdfPane';
import SectionAutocomplete from './SectionAutocomplete';
import { t, uiLang } from './i18n';

const PREFERENCES_KEY = 'pdfReaderPreferences';
const DEFAULT_ANNOTATION_COLOR = '#9acd32';

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

function hasRenderableSource(source) {
  if (Array.isArray(source)) return source.length > 0;
  return typeof source === 'string' && source.trim().length > 0;
}

function getSubjectLabel(subjectId) {
  const normalized = String(subjectId || '').trim().toLowerCase();
  if (normalized === 'biology-oup') return 'Biology';
  if (normalized === 'chemistry-winter') return 'Chemistry';
  if (normalized === 'physics-oup') return 'Physics';
  return String(subjectId || '').trim();
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

async function fetchJson(url, options) {
  const response = await fetch(url, options);

  // ── Show SweetAlert2 for 502 / 5xx server errors ──
  if (response.status >= 500 && !fetchJson._swalOpen) {
    fetchJson._swalOpen = true;
    const statusText = [502, 503, 504].includes(response.status)
      ? `Bad Gateway (${response.status})`
      : `Server Error (${response.status})`;
    Swal.fire({
      icon: 'error',
      title: statusText,
      html: `
        <p>The server returned an error for:</p>
        <code style="word-break:break-all;font-size:0.85rem;">${url}</code>
        <p style="margin-top:12px;">Please check that the backend server is running and try again.</p>
      `,
      confirmButtonText: 'OK',
      allowOutsideClick: true
    }).finally(() => {
      fetchJson._swalOpen = false;
    });
  }

  const rawText = await response.text();
  const contentType = response.headers.get('content-type') || '';
  let data = {};

  if (rawText) {
    const looksLikeJson = contentType.includes('application/json') || /^[\[{]/.test(rawText.trim());
    if (!looksLikeJson) {
      throw new Error(`Unexpected response from ${url} (${response.status})`);
    }
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(`Invalid JSON from ${url} (${response.status})`);
    }
  }

  if (!response.ok) {
    throw new Error(data.error || `Request failed for ${url} (${response.status})`);
  }

  return data;
}

function App() {
  const savedPrefs = loadPreferences();
  const initialTextColor = useMemo(() => {
    const value = savedPrefs.textColor;
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
      ? value
      : DEFAULT_ANNOTATION_COLOR;
  }, [savedPrefs.textColor]);
  const fallbackUserId = useMemo(() => getUserId(), []);
  const [userId, setUserId] = useState(fallbackUserId);
  const isTestMode = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('test') === '1';
  }, []);
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const currentStrokeRef = useRef(null);
  const displayModeInitializedRef = useRef(false);
  const [structure, setStructure] = useState([]);
  const [dataBooks, setDataBooks] = useState([]);
  const [activeBookId, setActiveBookId] = useState('');
  const [physicsChapterCatalog, setPhysicsChapterCatalog] = useState(null);
  const [selectedBook, setSelectedBook] = useState(savedPrefs.selectedBook || '');
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
  const [tool, setTool] = useState('hand');
  const [annotationToolsOpen, setAnnotationToolsOpen] = useState(Boolean(savedPrefs.annotationToolsOpen));
  const [textColor, setTextColor] = useState(initialTextColor);
  const [noteText, setNoteText] = useState('');
  const [clearedTimestamps, setClearedTimestamps] = useState([]);
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [thumbCols, setThumbCols] = useState(Number(savedPrefs.thumbCols || 4));
  const [zoomLevel, setZoomLevel] = useState(Number(savedPrefs.zoomLevel || 1));
  const [fitMode, setFitMode] = useState(
    savedPrefs.fitMode === 'height' ? 'height' : 'width'
  );
  const [renderScaleByLanguage, setRenderScaleByLanguage] = useState({});
  const [pageCounts, setPageCounts] = useState({});
  const [modalInfo, setModalInfo] = useState(null);
  const [resourcesDrawerOpen, setResourcesDrawerOpen] = useState(false);
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [aiDrawerLanguage, setAiDrawerLanguage] = useState('en');
  const [aiContent, setAiContent] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [flippedCards, setFlippedCards] = useState({});
  const [mcqAnswers, setMcqAnswers] = useState({});
  const [aiDebug, setAiDebug] = useState(null);
  const [panelVisible, setPanelVisible] = useState(savedPrefs.panelVisible !== false);
  const [panelReservedHeight, setPanelReservedHeight] = useState(0);
  const [fitRefreshToken, setFitRefreshToken] = useState(0);
  const [panelPos, setPanelPos] = useState(() => {
    const saved = savedPrefs.panelPos;
    return (saved && typeof saved.x === 'number' && typeof saved.y === 'number')
      ? saved
      : { x: undefined, y: undefined };
  });
  const [isNarrowScreen, setIsNarrowScreen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 960px)').matches;
  });
  const panelRef = useRef(null);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, posX: 0, posY: 0 });
  const pageViewRef = useRef({ key: '', startedAt: 0, loginLogged: false });

  const lang = uiLang(selectedLanguage);
  const _ = (key) => t(key, lang);
  const logoutUrl = useMemo(() => {
    if (typeof window === 'undefined') {
      return '/dse-logout.php';
    }
    const next = `${window.location.pathname}${window.location.search}`;
    return `/dse-logout.php?next=${encodeURIComponent(next)}`;
  }, []);
  const fitButtonMode = fitMode === 'height' ? 'height' : 'width';
  const fitButtonTitle = fitButtonMode === 'height' ? _('fitHeight') : _('fitWidth');
  const regenerateConfirmMessage = _('confirmRegenerate');

  const fitScreen = () => {
    setFitMode((current) => (current === 'width' ? 'height' : 'width'));
    setZoomLevel(1);
  };

  const refreshFitForCurrentMode = useCallback(() => {
    setFitRefreshToken((current) => current + 1);
  }, []);

  const preferredAiDrawerLanguage = useMemo(() => {
    return selectedLanguage === 'tc' ? 'zh' : 'en';
  }, [selectedLanguage]);

  const logUserAction = async (actionType, payload = {}) => {
    try {
      await fetchJson('api/user-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          actionType,
          chapter: selectedChapter,
          section: selectedFile,
          page: selectedPage,
          language: selectedLanguage,
          ...payload,
        })
      });
    } catch (err) {
      console.error(`[user-actions] failed to log ${actionType}:`, err);
    }
  };

  const logLogout = async () => {
    try {
      await fetchJson('api/user-actions/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          metadata: {
            chapter: selectedChapter,
            section: selectedFile,
            page: selectedPage,
            language: selectedLanguage,
          },
        })
      });
    } catch (err) {
      console.error('[user-actions] failed to log logout:', err);
    }
  };

  useEffect(() => {
    const loadCatalog = async (book) => {
      try {
        const bookParam = book ? `?book=${encodeURIComponent(book)}` : '';
        const data = await fetchJson(`api/catalog${bookParam}`);
        const chapters = data.chapters || [];
        setDataBooks(Array.isArray(data.books) ? data.books : []);
        const bookId = typeof data.activeBookId === 'string' ? data.activeBookId : '';
        setActiveBookId(bookId);
        if (!book) {
          setSelectedBook(bookId);
        }
        setStructure(chapters);
        if (chapters.length) {
          setSelectedChapter((current) => (chapters.some((chapter) => chapter.id === current) ? current : chapters[0].id));
        }
      } catch (err) {
        console.error('[catalog] failed to load:', err);
        setDataBooks([]);
        setActiveBookId('');
        setStructure([]);
      }
    };

    loadCatalog(savedPrefs.selectedBook || '');
  }, []);

  useEffect(() => {
    if (selectedBook !== 'physics-oup' || physicsChapterCatalog) return;
    const loadPhysicsChapters = async () => {
      try {
        const data = await fetchJson('/pdf-reader/data/physics-oup/physics-chapters.json');
        setPhysicsChapterCatalog(data || {});
      } catch (err) {
        console.error('[physics-chapters] failed to load:', err);
        setPhysicsChapterCatalog({});
      }
    };
    loadPhysicsChapters();
  }, [selectedBook, physicsChapterCatalog]);

  useEffect(() => {
    const loadSessionUser = async () => {
      try {
        const data = await fetchJson('api/session-user');
        if (typeof data.userId === 'string' && data.userId.trim()) {
          setUserId(data.userId.trim());
        }
      } catch (err) {
        console.error('[session-user] failed to load:', err);
      }
    };

    loadSessionUser();
  }, []);

  useEffect(() => {
    if (!userId || pageViewRef.current.loginLogged) return;
    pageViewRef.current.loginLogged = true;
    logUserAction('login');
  }, [userId]);

  useEffect(() => {
    const loadRemarks = async () => {
      try {
        const data = await fetchJson(`api/remarks?userId=${userId}`);
        setRemarks(data.remarks || []);
      } catch (err) {
        console.error('[remarks] failed to load:', err);
        setRemarks([]);
      }
    };

    loadRemarks();
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

  const handleBookSelect = async (newBookId) => {
    setSelectedChapter(newBookId);
    const newChapter = structure.find((chapter) => chapter.id === newBookId);
    const firstSection = newChapter?.contents?.[0];
    const firstPage = firstSection ? Number(firstSection.page || firstSection.section) : 1;
    setSelectedFile(firstPage);
    setSelectedPage(1);
  };

  const currentSection = useMemo(
    () => currentChapter?.contents?.find((item) => Number(item.page || item.section) === Number(selectedFile)),
    [currentChapter, selectedFile]
  );

  const physicsBookChapterMeta = useMemo(() => {
    if (selectedBook !== 'physics-oup' || !physicsChapterCatalog) return null;
    return physicsChapterCatalog[String(selectedChapter || '').toLowerCase()] || null;
  }, [selectedBook, selectedChapter, physicsChapterCatalog]);

  const physicsChapterOptions = useMemo(() => {
    return (physicsBookChapterMeta?.chapters || []).map((item) => ({
      ...item,
      name: item.nameEn || item.nameZh || item.id,
      nameEn: item.nameEn || item.name || item.id,
      nameZh: item.nameZh || '',
    }));
  }, [physicsBookChapterMeta]);

  const currentPhysicsChapter = useMemo(() => {
    if (!physicsChapterOptions.length) return null;
    const page = Math.max(1, Number(selectedPage) || 1);
    const exact = physicsChapterOptions.find((item) => page >= Number(item.startPage) && page <= Number(item.endPage || item.startPage));
    if (exact) return exact;
    const fallback = physicsChapterOptions
      .filter((item) => page >= Number(item.startPage))
      .sort((a, b) => Number(a.startPage) - Number(b.startPage))
      .pop();
    return fallback || physicsChapterOptions[0];
  }, [physicsChapterOptions, selectedPage]);

  const handlePhysicsChapterSelect = (chapterId) => {
    const next = physicsChapterOptions.find((item) => String(item.id) === String(chapterId));
    if (!next) return;
    setSelectedPage(Math.max(1, Number(next.startPage) || 1));
  };

  const sectionOptionsCount = currentChapter?.contents?.length || 0;

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
      try {
        const targets = selectedLanguage === 'bilingual'
          ? ['en', 'tc']
          : [selectedLanguage, selectedLanguage === 'en' ? 'tc' : 'en'];
        const bookParam = selectedBook ? `&book=${encodeURIComponent(selectedBook)}` : '';
        console.log(`[loadPages] chapter=${selectedChapter} file=${selectedFile} languages=${targets.join(',')}`);
        const entries = await Promise.allSettled(
          targets.map(async (language) => {
            const url = `api/page?chapter=${selectedChapter}&language=${language}&page=${selectedFile}${bookParam}`;
            console.log(`[loadPages] fetching: ${url}`);
            const data = await fetchJson(url);
            const result = data.images || data.url || '';
            console.log(`[loadPages]   ${language}: images=${Array.isArray(data.images) ? data.images.length : 'N/A'} url=${typeof data.url === 'string' ? data.url : 'N/A'} result=${Array.isArray(result) ? result.length + ' imgs' : result}`);
            return [language, result];
          })
        );
        const nextSources = {};
        entries.forEach((entry, index) => {
          const language = targets[index];
          if (entry.status !== 'fulfilled') {
            console.warn(`[loadPages] ${language} unavailable:`, entry.reason?.message || entry.reason);
            return;
          }
          const [resolvedLanguage, source] = entry.value;
          if (hasRenderableSource(source)) {
            nextSources[resolvedLanguage] = source;
          }
        });
        console.log(`[loadPages] setting pageSources:`, Object.keys(nextSources));
        setPageSources(nextSources);
      } catch (err) {
        console.error('[loadPages] failed:', err);
        setPageSources({});
      }
    };

    if (selectedChapter) {
      loadPages();
    }
  }, [selectedChapter, selectedFile, selectedLanguage, selectedBook]);

  useEffect(() => {
    if (!displayModeInitializedRef.current) {
      displayModeInitializedRef.current = true;
      return;
    }
    setZoomLevel(1);
  }, [displayMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const prefs = {
      selectedBook,
      selectedChapter,
      selectedFile,
      selectedPage,
      displayMode,
      selectedLanguage,
      sidebarCollapsed,
      tool,
      annotationToolsOpen,
      textColor,
      thumbCols,
      zoomLevel,
      fitMode,
      panelPos,
      panelVisible
    };
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
  }, [
    selectedBook,
    selectedChapter,
    selectedFile,
    selectedPage,
    displayMode,
    selectedLanguage,
    sidebarCollapsed,
    tool,
    annotationToolsOpen,
    textColor,
    thumbCols,
    zoomLevel,
    fitMode,
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
    const data = await fetchJson('api/remarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, ...remark })
    });
    setRemarks(data.remarks || []);
  };

  const clearPageRemarks = async () => {
    const data = await fetchJson(
      `api/remarks?userId=${userId}&chapter=${selectedChapter}&page=${selectedPage}`,
      { method: 'DELETE' }
    );
    setRemarks(data.remarks || []);
    setUndoStack([]);
    setRedoStack([]);
  };

  const clearAllRemarks = async () => {
    const data = await fetchJson(
      `api/remarks?userId=${userId}&chapter=${selectedChapter}`,
      { method: 'DELETE' }
    );
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
    await fetchJson(
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
    const data = await fetchJson('api/remarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, ...last })
    });
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
    if (isNarrowScreen) return;
    if (!panelRef.current) return;
    if (event.pointerType === 'touch' && typeof event.target?.setPointerCapture === 'function') {
      event.target.setPointerCapture(event.pointerId);
    }
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
    if (typeof window === 'undefined') return undefined;
    const mediaQuery = window.matchMedia('(max-width: 960px)');
    const handleChange = (event) => {
      setIsNarrowScreen(event.matches);
    };
    setIsNarrowScreen(mediaQuery.matches);
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => {
      refreshFitForCurrentMode();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [refreshFitForCurrentMode]);

  useEffect(() => {
    refreshFitForCurrentMode();
  }, [sidebarCollapsed, panelVisible, annotationToolsOpen, refreshFitForCurrentMode]);

  useEffect(() => {
    if (!panelVisible) {
      setPanelReservedHeight(0);
      return undefined;
    }
    const updatePanelHeight = () => {
      if (!panelRef.current) {
        setPanelReservedHeight(0);
        return;
      }
      const rect = panelRef.current.getBoundingClientRect();
      const offset = isNarrowScreen ? 0 : 16;
      setPanelReservedHeight(Math.max(0, Math.ceil(rect.height + offset)));
    };
    updatePanelHeight();
    const observer = new ResizeObserver(updatePanelHeight);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener('resize', updatePanelHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePanelHeight);
    };
  }, [panelVisible, annotationToolsOpen, isNarrowScreen]);

  useEffect(() => {
    const onMove = (event) => {
      if (isNarrowScreen || !dragRef.current.dragging) return;
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

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [isNarrowScreen]);

  const visibleLanguages = useMemo(() => {
    if (selectedLanguage !== 'bilingual') {
      if (hasRenderableSource(pageSources[selectedLanguage])) {
        return [selectedLanguage];
      }
      const fallbackLanguage = selectedLanguage === 'en' ? 'tc' : 'en';
      return hasRenderableSource(pageSources[fallbackLanguage]) ? [fallbackLanguage] : [];
    }
    return ['en', 'tc'].filter((language) => hasRenderableSource(pageSources[language]));
  }, [selectedLanguage, pageSources]);
  const isBilingualView = selectedLanguage === 'bilingual' && visibleLanguages.length > 1;
  const displayZoomPercent = useMemo(() => {
    const scales = visibleLanguages
      .map((language) => renderScaleByLanguage[language])
      .filter((value) => Number.isFinite(value) && value > 0);

    if (scales.length > 0) {
      return Math.round(Math.min(...scales) * 100);
    }

    return Math.round(zoomLevel * 100);
  }, [visibleLanguages, renderScaleByLanguage, zoomLevel]);
  const maxNavigablePage = useMemo(() => {
    const counts = visibleLanguages
      .map((language) => Number(pageCounts[language] || 0))
      .filter((value) => value > 0);
    return counts.length ? Math.min(...counts) : Number.POSITIVE_INFINITY;
  }, [visibleLanguages, pageCounts]);
  const pageOptions = useMemo(() => {
    const maxPage = Number.isFinite(maxNavigablePage)
      ? Math.max(1, Math.floor(maxNavigablePage))
      : Math.max(1, Number(selectedPage) || 1);
    return Array.from({ length: maxPage }, (_, index) => index + 1);
  }, [maxNavigablePage, selectedPage]);

  useEffect(() => {
    if (!Number.isFinite(maxNavigablePage)) return;
    setSelectedPage((current) => Math.max(1, Math.min(maxNavigablePage, current)));
  }, [maxNavigablePage]);

  useEffect(() => {
    const key = [selectedChapter, selectedFile, selectedPage, selectedLanguage, displayMode].join('|');
    const now = Date.now();
    const previous = pageViewRef.current;

    if (previous.key && previous.key !== key && previous.startedAt) {
      const durationMs = Math.max(0, now - previous.startedAt);
      logUserAction('page_view_end', { durationMs, metadata: { viewKey: previous.key } });
    }

    if (previous.key !== key) {
      pageViewRef.current = { ...previous, key, startedAt: now };
      logUserAction('page_view_start', { metadata: { viewKey: key } });
    }
  }, [selectedChapter, selectedFile, selectedPage, selectedLanguage, displayMode]);

  useEffect(() => {
    const handleUnload = () => {
      const previous = pageViewRef.current;
      if (!previous.key || !previous.startedAt) return;
      const payload = JSON.stringify({
        userId,
        actionType: 'page_view_end',
        chapter: selectedChapter,
        section: selectedFile,
        page: selectedPage,
        language: selectedLanguage,
        durationMs: Math.max(0, Date.now() - previous.startedAt),
        metadata: { viewKey: previous.key, reason: 'unload' },
      });
      navigator.sendBeacon?.('api/user-actions', new Blob([payload], { type: 'application/json' }));
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [userId, selectedChapter, selectedFile, selectedPage, selectedLanguage]);

  useEffect(() => {
    setRenderScaleByLanguage({});
  }, [selectedChapter, selectedFile, selectedPage, selectedLanguage, displayMode]);

  const fetchCachedAiContent = async () => {
    const data = await fetchJson(
      `api/ai-content?subjectId=${encodeURIComponent(selectedBook)}&bookId=${encodeURIComponent(selectedChapter)}&sectionId=${selectedFile}&pageId=${selectedPage}`
    );
    if (data.content && (data.content.en || data.content.zh)) {
      return data.content;
    }
    return null;
  };

  // ── Load saved AI content when section/page/language changes ──
  useEffect(() => {
    if (!selectedChapter || !selectedFile) return;
    setAiContent(null); // clear stale content while loading
    const loadContent = async () => {
      try {
        const cachedContent = await fetchCachedAiContent();
        if (cachedContent) {
          setAiContent(cachedContent);
          setAiError(null);
        } else {
          setAiContent(null);
        }
      } catch (err) {
        console.error('[ai-content] failed to load:', err);
        setAiContent(null);
      }
    };
    loadContent();
  }, [selectedChapter, selectedFile, selectedPage, selectedLanguage]);

  const handleAiGenerate = async (forceRegenerate = false, requireConfirmation = false) => {
    if (aiLoading) {
      setAiDrawerLanguage(preferredAiDrawerLanguage);
      setAiDrawerOpen(true);
      if (isTestMode) {
        console.log('[ai-generate] request already in progress; reopening drawer');
      }
      return;
    }

    if (forceRegenerate && requireConfirmation && typeof window !== 'undefined') {
      const result = await Swal.fire({
        icon: 'warning',
        text: regenerateConfirmMessage,
        showCancelButton: true,
        confirmButtonText: _('confirm'),
        cancelButtonText: _('cancel'),
        reverseButtons: true,
        focusCancel: true,
      });
      if (!result.isConfirmed) {
        return;
      }
    }

    // If content already exists and not forcing regenerate, just show it
    if (!forceRegenerate && aiContent) {
      setAiDrawerLanguage(preferredAiDrawerLanguage);
      setAiDrawerOpen(true);
      if (isTestMode) {
        console.log('[ai-generate] showing cached content (use Regenerate to re-fetch)');
      }
      return;
    }

    if (!forceRegenerate) {
      try {
        const cachedContent = await fetchCachedAiContent();
        if (cachedContent) {
          setAiContent(cachedContent);
          setAiError(null);
          setAiDrawerLanguage(preferredAiDrawerLanguage);
          setAiDrawerOpen(true);
          if (isTestMode) {
            console.log('[ai-generate] loaded cached content from database on demand');
          }
          return;
        }
      } catch (err) {
        if (isTestMode) {
          console.log('[ai-generate] cache recheck failed:', err.message);
        }
      }
    }

    setAiLoading(true);
    setAiError(null);
    if (forceRegenerate) {
      setAiContent(null);
    }
    setFlippedCards({});
    setMcqAnswers({});
    setAiDebug(null);
    setAiDrawerLanguage(preferredAiDrawerLanguage);
    setAiDrawerOpen(true);

    try {
      const sectionName = getSectionName(currentSection, 'en');

      const endpointUrl = 'api/ai-generate';
      const requestBody = {
        subjectId: selectedBook,
        bookId: selectedChapter,
        sectionId: selectedFile,
        pageId: selectedPage,
        sectionName: sectionName || '',
        userId,
        force: forceRegenerate ? '1' : undefined,
        test: isTestMode ? '1' : undefined,
      };

      if (isTestMode) {
        console.log('[ai-generate] endpoint:', endpointUrl);
        console.log('[ai-generate] request payload:', JSON.stringify(requestBody, null, 2));
      }

      logUserAction('ai_generate_request', {
        metadata: {
          forceRegenerate,
          sectionName: sectionName || '',
        }
      });

      const res = await fetch(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const rawResponseText = await res.text();
      if (isTestMode) {
        console.log('[ai-generate] raw response:', rawResponseText);
      }

      let data;
      try {
        data = rawResponseText ? JSON.parse(rawResponseText) : {};
      } catch (parseError) {
        if (isTestMode) {
          console.log('[ai-generate] response parse error:', parseError.message);
        }
        throw new Error('AI response was not valid JSON');
      }

      if (data.error) {
        if (isTestMode) {
          console.log('[ai-generate] error message:', data.error);
        }
        setAiError(data.error);
      } else {
        // data.content is now { en: {...}, tc: {...} }
        setAiContent(data.content);
        logUserAction('ai_generate_success', {
          metadata: {
            forceRegenerate,
            hasEnglish: !!data.content?.en,
            hasChinese: !!data.content?.zh,
          }
        });
        if (data._debug) {
          setAiDebug(data._debug);
          if (isTestMode) {
            console.log('[ai-generate] debug:', data._debug);
          }
        }
      }
    } catch (err) {
      if (isTestMode) {
        console.log('[ai-generate] caught error message:', err.message || 'Failed to generate content');
      }
      logUserAction('ai_generate_failure', {
        metadata: {
          forceRegenerate,
          error: err.message || 'Failed to generate content',
        }
      });
      setAiError(err.message || 'Failed to generate content');
    } finally {
      setAiLoading(false);
    }
  };

  const toggleFlashcard = (index) => {
    setFlippedCards((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const handleMcqSelect = (qIndex, option) => {
    setMcqAnswers((prev) => ({ ...prev, [qIndex]: option }));
    const question = aiDisplayContent?.mcq?.[qIndex];
    logUserAction('quiz_answer', {
      metadata: {
        questionIndex: qIndex,
        selectedOption: option,
        correctOption: question?.correct,
        isCorrect: option === question?.correct,
        question: question?.question || '',
      }
    });
  };

  // ── Derive display content for AI drawer ──────────────────
  const aiDisplayContent = useMemo(() => {
    if (!aiContent) return null;
    return aiContent[aiDrawerLanguage] || aiContent.en || aiContent.zh || null;
  }, [aiContent, aiDrawerLanguage]);

  const aiHasBoth = useMemo(() => {
    return !!(aiContent?.en && aiContent?.zh);
  }, [aiContent]);

  const aiGenerationPresent = useMemo(() => {
    return !!(aiContent?.en || aiContent?.zh);
  }, [aiContent]);

  // ── Escape key closes modal then drawers ───────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (modalInfo) { setModalInfo(null); return; }
      if (resourcesDrawerOpen) { setResourcesDrawerOpen(false); return; }
      if (aiDrawerOpen) { setAiDrawerOpen(false); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalInfo, resourcesDrawerOpen, aiDrawerOpen]);

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
    <div className={`app-shell ${displayMode === 'scrolling' ? 'scrolling-mode' : ''}`} style={{ '--bottom-toolbar-offset': `${panelReservedHeight}px` }}>
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${displayMode === 'scrolling' ? 'scroll-locked' : ''}`}>
        <div className="sidebar-title-row">
          <h1>
            <svg className="sidebar-logo" viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm2 0v14h12V5H6zm2 2h8v2H8V7zm0 4h8v2H8v-2zm0 4h5v2H8v-2z" />
            </svg>
            {_('appTitle')}
          </h1>
          <button
            className="sidebar-toggle"
            onClick={() => {
              setSidebarCollapsed((current) => !current);
              setSelectedPage(1);
            }}
            aria-label={sidebarCollapsed ? _('expandSidebar') : _('collapseSidebar')}
            title={sidebarCollapsed ? _('expandSidebar') : _('collapseSidebar')}
          >
            <span aria-hidden="true" className="sidebar-toggle-icon">{sidebarCollapsed ? '>>' : '<<'}</span>
          </button>
        </div>
        {!sidebarCollapsed && (
          <div className="sidebar-user-row">
            <div className="sidebar-user-actions">
              <div className="sidebar-user-id" title={_('yourUserId')}>
                <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="sidebar-user-id-icon">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                </svg>
                <code>{userId}</code>
              </div>
              <a className="sidebar-logout-btn" href={logoutUrl} onClick={logLogout}>{_('logout')}</a>
            </div>
          </div>
        )}
        <label>
          <span className="sidebar-label-icon">
            <svg viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm2 0v14h12V5H6zm2 2h8v2H8V7zm0 4h8v2H8v-2zm0 4h5v2H8v-2z" />
            </svg>
            {_('book')}
          </span>
          {dataBooks.length > 0 ? (
            <select value={selectedBook} onChange={async (event) => {
              const newBook = event.target.value;
              setSelectedBook(newBook);
              try {
                const data = await fetchJson(`api/catalog?book=${encodeURIComponent(newBook)}`);
                const chapters = data.chapters || [];
                setDataBooks(Array.isArray(data.books) ? data.books : []);
                setActiveBookId(typeof data.activeBookId === 'string' ? data.activeBookId : newBook);
                setStructure(chapters);
                if (chapters.length) {
                  setSelectedChapter(chapters[0].id);
                  const firstSection = chapters[0]?.contents?.[0];
                  const firstPage = firstSection ? Number(firstSection.page || firstSection.section) : 1;
                  setSelectedFile(firstPage);
                  setSelectedPage(1);
                }
              } catch (err) {
                console.error('[catalog] failed to load book:', newBook, err);
              }
            }}>
              {dataBooks.map((bookId) => (
                <option key={bookId} value={bookId}>{getSubjectLabel(bookId)}</option>
              ))}
            </select>
          ) : (
            <select value={selectedBook} disabled>
              <option value={selectedBook}>{selectedBook ? getSubjectLabel(selectedBook) : _('noBook')}</option>
            </select>
          )}
        </label>
        <label>
          <span className="sidebar-label-icon">
            <svg viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M3 4h18v2H3V4zm0 7h18v2H3v-2zm0 7h18v2H3v-2z" />
            </svg>
            {_('chapter')}
          </span>
          <BookAutocomplete
            books={structure}
            currentBook={currentChapter}
            language={selectedLanguage}
            subjectId={selectedBook}
            onSelect={handleBookSelect}
            placeholder={_('searchBookTopic')}
            emptyText={_('noMatchingBooks')}
          />
        </label>

        {!sidebarCollapsed && selectedBook === 'physics-oup' && physicsChapterOptions.length > 0 && (
          <label>
            <span className="sidebar-label-icon">
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M4 5h16v2H4V5zm0 6h16v2H4v-2zm0 6h10v2H4v-2z" />
              </svg>
              {_('physicsChapter')}
            </span>
            <BookAutocomplete
              books={physicsChapterOptions}
              currentBook={currentPhysicsChapter}
              language={selectedLanguage}
              subjectId="physics-oup"
              onSelect={handlePhysicsChapterSelect}
              placeholder={_('searchChapter')}
              emptyText={_('noMatchingChapters')}
            />
          </label>
        )}

        {!sidebarCollapsed && sectionOptionsCount > 1 && (
          <label>
            <span className="sidebar-label-icon">
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M3 4h18v2H3V4zm0 7h18v2H3v-2zm0 7h18v2H3v-2z" />
              </svg>
              {_('section')}
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

        {!sidebarCollapsed && (
          <label>
            <span className="sidebar-label-icon">
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <line x1="8" y1="8" x2="16" y2="8" stroke="currentColor" strokeWidth="1.5" />
                <line x1="8" y1="12" x2="16" y2="12" stroke="currentColor" strokeWidth="1.5" />
                <line x1="8" y1="16" x2="13" y2="16" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              {_('pageN')}
            </span>
            <select value={selectedPage} onChange={(event) => setSelectedPage(Number(event.target.value))}>
              {pageOptions.map((page) => (
                <option key={page} value={page}>{page}</option>
              ))}
            </select>
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
            {_('displayMode')}
          </span>
          <div className="toggle-group">
            <button
              className={`toggle-btn ${displayMode === 'pagination' ? 'active' : ''}`}
              onClick={() => { setDisplayMode('pagination'); setSelectedPage(1); }}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="4" y="3" width="16" height="18" rx="2" />
              </svg>
              {_('paginated')}
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
              {_('scroll')}
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
              {_('thumbs')}
            </button>
          </div>
        </label>

        <label>
          <span className="sidebar-label-icon">
            <svg viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M5 6h9v2H5V6zm2 4h5v2H7v-2zm7.5 0h2.4L20 18h-2.1l-.7-2h-3l-.7 2h-2.1l3.2-8zm.2 4h1.7l-.8-2.3-.9 2.3z" />
            </svg>
            {_('language')}
          </span>
          <div className="toggle-group">
            <button
              className={`toggle-btn ${selectedLanguage === 'en' ? 'active' : ''}`}
              onClick={() => setSelectedLanguage('en')}
              aria-pressed={selectedLanguage === 'en'}
            >
              {_('english')}
            </button>
            <button
              className={`toggle-btn ${selectedLanguage === 'tc' ? 'active' : ''}`}
              onClick={() => setSelectedLanguage('tc')}
              aria-pressed={selectedLanguage === 'tc'}
            >
              {_('chinese')}
            </button>
            <button
              className={`toggle-btn ${selectedLanguage === 'bilingual' ? 'active' : ''}`}
              onClick={() => setSelectedLanguage('bilingual')}
              aria-pressed={selectedLanguage === 'bilingual'}
            >
              {_('bilingual')}
            </button>
          </div>
        </label>

        {sidebarCollapsed && (
          <div className="sidebar-icon-stack" aria-label="Collapsed sidebar controls">
            <div className="sidebar-collapsed-user">
              <div className="sidebar-icon-btn sidebar-user-icon-btn" data-tooltip={userId} aria-label={userId}>
                <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                  <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                </svg>
              </div>
              <div className="sidebar-collapsed-user-id" title={userId}>
                <code>{userId.slice(0, 6)}</code>
              </div>
              <a className="sidebar-icon-btn sidebar-logout-icon-btn" href={logoutUrl} data-tooltip={_('logout')} aria-label={_('logout')} onClick={logLogout}>
                <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                  <path d="M10 17l1.41-1.41L8.83 13H20v-2H8.83l2.58-2.59L10 7l-5 5 5 5zm-6 3h8v-2H4V6h8V4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2z" />
                </svg>
              </a>
            </div>
            <button
              className="sidebar-icon-btn"
              onClick={cycleBook}
              data-tooltip={_('switchBook')}
              aria-label={_('switchBook')}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M4 5a2 2 0 0 1 2-2h13v17H6a2 2 0 0 0-2 2V5zm2 0v13h11V5H6z" />
              </svg>
            </button>
            <button
              className="sidebar-icon-btn"
              onClick={cycleDisplayMode}
              data-tooltip={displayMode === 'thumbnails' ? _('thumbnailsMode') : displayMode === 'scrolling' ? _('scrollingMode') : _('paginationMode')}
              aria-label={_('toggleDisplayMode')}
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
              data-tooltip={_('switchLanguage')}
              aria-label={_('switchLanguage')}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M5 6h9v2H5V6zm2 4h5v2H7v-2zm7.5 0h2.4L20 18h-2.1l-.7-2h-3l-.7 2h-2.1l3.2-8zm.2 4h1.7l-.8-2.3-.9 2.3z" />
              </svg>
            </button>
            {displayMode === 'scrolling' && (
              <button
                className="sidebar-icon-btn"
                onClick={fitScreen}
                data-tooltip={fitButtonTitle}
                aria-label={fitButtonTitle}
              >
                <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                  {fitButtonMode === 'height' ? (
                    <path d="M12 3l3.5 3.5-1.4 1.4-1.1-1.1V17.2l1.1-1.1 1.4 1.4L12 21l-3.5-3.5 1.4-1.4 1.1 1.1V6.8L9.9 7.9 8.5 6.5 12 3zM5 5h3v2H7v10h1v2H5V5zm11 0h3v14h-3v-2h1V7h-1V5z" />
                  ) : (
                    <path d="M3 12l3.5-3.5 1.4 1.4-1.1 1.1h10.4l-1.1-1.1 1.4-1.4L21 12l-3.5 3.5-1.4-1.4 1.1-1.1H6.8l1.1 1.1-1.4 1.4L3 12zM5 5h14v3h-2V7H7v1H5V5zm0 11h2v1h10v-1h2v3H5v-3z" />
                  )}
                </svg>
              </button>
            )}
            <button
              className={`sidebar-icon-btn ${resourcesDrawerOpen ? 'active' : ''}`}
              onClick={() => setResourcesDrawerOpen((current) => !current)}
              data-tooltip={_('toggleResources')}
              aria-label={_('toggleResources')}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 0 0-5 5 5 5 0 0 0 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4a5 5 0 0 0 5-5 5 5 0 0 0-5-5z" />
              </svg>
            </button>
            <button
              className={`sidebar-icon-btn ${panelVisible ? 'active' : ''}`}
              onClick={() => setPanelVisible((current) => !current)}
              data-tooltip={_('toggleToolbar')}
              aria-label={_('toggleToolbar')}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="3" y="3" width="18" height="14" rx="2" />
                <rect x="6" y="7" width="12" height="2" rx="1" />
                <rect x="6" y="11" width="8" height="2" rx="1" />
              </svg>
            </button>

            <button
              className={`sidebar-icon-btn ${aiDrawerOpen ? 'active' : ''}`}
              onClick={() => handleAiGenerate()}
              data-tooltip={aiLoading ? _('generating') : _('aiGeneration')}
              aria-label={_('aiGeneration')}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
              </svg>
              {aiGenerationPresent && (
                <span className="ai-generated-tick ai-generated-tick-collapsed" aria-hidden="true">
                  <svg viewBox="0 0 20 20" role="presentation" focusable="false">
                    <path d="M3 10.5l4.1 4.1L17 4.8" />
                  </svg>
                </span>
              )}
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
              {_('resources')}
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
              {_('toolbar')}
            </button>
          </label>
        )}

        {!sidebarCollapsed && displayMode === 'scrolling' && (
          <label className="toggle-row">
            <button
              className="toggle-btn icon-only"
              onClick={fitScreen}
              title={fitButtonTitle}
              aria-label={fitButtonTitle}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                {fitButtonMode === 'height' ? (
                  <path d="M12 3l3.5 3.5-1.4 1.4-1.1-1.1V17.2l1.1-1.1 1.4 1.4L12 21l-3.5-3.5 1.4-1.4 1.1 1.1V6.8L9.9 7.9 8.5 6.5 12 3zM5 5h3v2H7v10h1v2H5V5zm11 0h3v14h-3v-2h1V7h-1V5z" />
                ) : (
                  <path d="M3 12l3.5-3.5 1.4 1.4-1.1 1.1h10.4l-1.1-1.1 1.4-1.4L21 12l-3.5 3.5-1.4-1.4 1.1-1.1H6.8l1.1 1.1-1.4 1.4L3 12zM5 5h14v3h-2V7H7v1H5V5zm0 11h2v1h10v-1h2v3H5v-3z" />
                )}
              </svg>
              {fitButtonTitle}
            </button>
          </label>
        )}

        {!sidebarCollapsed && (
          <label className="toggle-row">
            <button
              className={`toggle-btn icon-only ai-generate-btn ${aiDrawerOpen ? 'active' : ''}`}
              onClick={() => handleAiGenerate()}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
              </svg>
              {aiLoading ? _('generating') : _('aiGeneration')}
              {aiGenerationPresent && (
                <span className="ai-generated-tick" aria-hidden="true">
                  <svg viewBox="0 0 20 20" role="presentation" focusable="false">
                    <path d="M3 10.5l4.1 4.1L17 4.8" />
                  </svg>
                </span>
              )}
            </button>
          </label>
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
                title={`${language === 'en' ? _('english') : _('chinese')} · ${currentChapter?.name || selectedChapter}`}
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
                fitMode={fitMode}
                fitRefreshToken={fitRefreshToken}
                onRenderScaleChange={(scale) => {
                  setRenderScaleByLanguage((current) => {
                    if (current[language] === scale) {
                      return current;
                    }
                    return { ...current, [language]: scale };
                  });
                }}
                language={selectedLanguage}
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
                  <p className="resources-empty">{_('noResources')}</p>
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
                  <p className="resources-empty">{_('noResources')}</p>
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
          className={`annotation-panel ${isNarrowScreen ? 'docked-bottom' : ''}`}
          ref={panelRef}
          style={isNarrowScreen
            ? { left: '0', right: '0', bottom: '0' }
            : {
              left: panelPos.x != null ? `${panelPos.x}px` : undefined,
              top: panelPos.y != null ? `${panelPos.y}px` : undefined,
              right: panelPos.x == null ? '16px' : undefined,
              bottom: panelPos.y == null ? '16px' : undefined
            }}
        >
          <div className="panel-row-1">
          <span
            className="panel-drag-handle"
            onPointerDown={handlePanelDragStart}
            title={_('dragToMove')}
            aria-label={_('dragToMove')}
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
          <div className="toolbar-group toolbar-primary">
            <button onClick={() => moveSection(-1)} title={_('prevSection')} aria-label={_('prevSection')}>|&lt;</button>
            <button onClick={() => changePage(-1)} title={_('prevPage')} aria-label={_('prevPage')}>&lt;</button>
            <button onClick={() => changePage(1)} title={_('nextPage')} aria-label={_('nextPage')}>&gt;</button>
            <button onClick={() => moveSection(1)} title={_('nextSection')} aria-label={_('nextSection')}>&gt;|</button>
            <button className="icon-btn active" onClick={fitScreen} title={fitButtonTitle} aria-label={fitButtonTitle}>
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                {fitButtonMode === 'height' ? (
                  <path d="M12 3l3.5 3.5-1.4 1.4-1.1-1.1V17.2l1.1-1.1 1.4 1.4L12 21l-3.5-3.5 1.4-1.4 1.1 1.1V6.8L9.9 7.9 8.5 6.5 12 3zM5 5h3v2H7v10h1v2H5V5zm11 0h3v14h-3v-2h1V7h-1V5z" />
                ) : (
                  <path d="M3 12l3.5-3.5 1.4 1.4-1.1 1.1h10.4l-1.1-1.1 1.4-1.4L21 12l-3.5 3.5-1.4-1.4 1.1-1.1H6.8l1.1 1.1-1.4 1.4L3 12zM5 5h14v3h-2V7H7v1H5V5zm0 11h2v1h10v-1h2v3H5v-3z" />
                )}
              </svg>
            </button>
            <span className="toolbar-sep" />
            <input
              type="range"
              className="zoom-slider"
              min="5"
              max="400"
              value={Math.round(zoomLevel * 100)}
              onChange={(e) => setZoomLevel(Number(e.target.value) / 100)}
              title={_('zoomLevel')}
              aria-label={_('zoomLevel')}
            />
            <span className="zoom-label">{displayZoomPercent}%</span>
          </div>
          <button
            className={`tool-btn annotation-toggle-btn ${annotationToolsOpen ? 'active' : ''}`}
            onClick={() => {
              setAnnotationToolsOpen((prev) => {
                if (prev) setTool('hand');
                return !prev;
              });
            }}
            title={_('toggleAnnotations')}
            aria-label={_('toggleAnnotations')}
          >
            <svg viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M4 16.5V20h3.5L18 9.5 14.5 6 4 16.5zm2.2 1.3h-.7v-.7l8.6-8.6.7.7-8.6 8.6zM19.7 7.8c.4-.4.4-1 0-1.4l-2.1-2.1c-.4-.4-1-.4-1.4 0l-1.2 1.2 3.5 3.5 1.2-1.2z" />
            </svg>
          </button>
          <button
            className="tool-btn panel-close-btn panel-close-accent"
            onClick={() => setPanelVisible(false)}
            title={_('closePanel')}
            aria-label={_('closePanel')}
          >
            <svg viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
          </div>
          {annotationToolsOpen && (
          <div className="panel-row-2 annotation-row">
          <div className="toolbar-group toolbar-secondary">
            <button
              className={`tool-btn ${tool === 'pen' ? 'active' : ''}`}
              onClick={() => setTool('pen')}
              title={_('pen')}
              aria-label={_('pen')}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
              </svg>
            </button>
            <button
              className={`tool-btn ${tool === 'text' ? 'active' : ''}`}
              onClick={() => setTool('text')}
              title={_('textTool')}
              aria-label={_('textTool')}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M5 4v3h5.5v12h3V7H19V4H5z" />
              </svg>
            </button>
            <button
              className={`tool-btn ${tool === 'highlight' ? 'active' : ''}`}
              onClick={() => setTool('highlight')}
              title={_('highlighter')}
              aria-label={_('highlighter')}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M15.24 2.36l-11 11a1 1 0 0 0-.24.59V17a1 1 0 0 0 1 1h3.05a1 1 0 0 0 .59-.24l11-11a1 1 0 0 0 0-1.41l-3.4-3.4a1 1 0 0 0-1.41 0zM5 16v-2.5l9-9L16.5 7l-9 9H5z" />
                <rect x="2" y="18" width="20" height="3" rx="1" />
              </svg>
            </button>
            <span className="toolbar-sep" />
            <input type="color" value={textColor} onChange={(event) => setTextColor(event.target.value)} title={_('color')} aria-label={_('color')} />
            <span className="toolbar-sep" />
            <button
              className="tool-btn"
              disabled={!remarks.filter(r => r.chapter === selectedChapter && Number(r.page) === Number(selectedPage)).length}
              onClick={undoRemark}
              title={_('undo')}
              aria-label={_('undo')}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
              </svg>
            </button>
            <button
              className="tool-btn"
              disabled={!undoStack.length}
              onClick={redoRemark}
              title={_('redo')}
              aria-label={_('redo')}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16a8.002 8.002 0 0 1 7.6-5.5c1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z" />
              </svg>
            </button>
            <span className="toolbar-sep" />
            <button
              className="tool-btn"
              onClick={clearPageRemarks}
              title={_('erasePage')}
              aria-label={_('erasePage')}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4h-3.5z" />
              </svg>
            </button>
            <button
              className="tool-btn"
              onClick={clearAllRemarks}
              title={_('eraseAll')}
              aria-label={_('eraseAll')}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4h-3.5z" />
                <path d="M2 7h20" stroke="currentColor" strokeWidth="2" fill="none" />
              </svg>
            </button>
          </div>
          </div>
          )}
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
                {_('aiStudyMaterials')}
              </h2>
              <div className="ai-drawer-header-actions">
                {aiContent && !aiLoading && (
                  <button className="ai-regenerate-btn" onClick={() => handleAiGenerate(true, true)} title={_('regenerate')}>
                    <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                      <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                    </svg>
                    <span>{_('regenerate')}</span>
                  </button>
                )}
                <button className="modal-close" onClick={() => setAiDrawerOpen(false)} aria-label={_('close')}>✕</button>
              </div>
            </div>

            <div className="ai-drawer-body">
              {aiLoading && (
                <div className="ai-loading">
                  <div className="ai-spinner" />
                  <p>{_('generatingMsg')}</p>
                  <small>{_('generatingTime')}</small>
                </div>
              )}

              {aiError && !aiLoading && (
                <div className="ai-error">
                  <p>⚠️ {aiError}</p>
                  <button className="ai-retry-btn" onClick={() => handleAiGenerate(true, false)}>{_('retry')}</button>
                </div>
              )}

              {aiContent && !aiLoading && (
                <div className="ai-content">
                  {/* Language tabs when both languages are available */}
                  {aiHasBoth && (
                    <div className="ai-lang-tabs">
                      <button
                        className={`ai-lang-tab ${aiDrawerLanguage === 'en' ? 'active' : ''}`}
                        onClick={() => setAiDrawerLanguage('en')}
                      >
                        🇬🇧 {_('english')}
                      </button>
                      <button
                        className={`ai-lang-tab ${aiDrawerLanguage === 'zh' ? 'active' : ''}`}
                        onClick={() => setAiDrawerLanguage('zh')}
                      >
                        🇭🇰 {_('chinese')}
                      </button>
                    </div>
                  )}

                  {aiDisplayContent?.summary && aiDisplayContent.summary.length > 0 && (
                    <div className="ai-section">
                      <h3 className="ai-section-title">
                        <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="ai-section-icon">
                          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.8" />
                          <line x1="12" y1="7" x2="12" y2="13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                          <circle cx="12" cy="16.5" r="0.8" fill="currentColor" />
                        </svg>
                        {_('summary')}
                      </h3>
                      <ul className="ai-summary">
                        {aiDisplayContent.summary.map((point, idx) => (
                          <li key={idx}>{point}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {aiDisplayContent?.flashcards && aiDisplayContent.flashcards.length > 0 && (
                    <div className="ai-section">
                      <h3 className="ai-section-title">
                        <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="ai-section-icon">
                          <rect x="2" y="4" width="20" height="16" rx="2" />
                          <line x1="8" y1="9" x2="16" y2="9" stroke="currentColor" strokeWidth="1.5" />
                          <line x1="8" y1="13" x2="12" y2="13" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                        {_('flashCards')} ({aiDisplayContent.flashcards.length})
                      </h3>
                      <div className="flashcards-grid">
                        {aiDisplayContent.flashcards.map((card, idx) => (
                          <div
                            key={idx}
                            className={`flashcard ${flippedCards[idx] ? 'flipped' : ''}`}
                            onClick={() => toggleFlashcard(idx)}
                          >
                            <div className="flashcard-inner">
                              <div className="flashcard-front">
                                <span className="flashcard-label">Q{idx + 1}</span>
                                <p>{card.question}</p>
                                <small className="flashcard-hint">{_('clickToReveal')}</small>
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

                  {aiDisplayContent?.mcq && aiDisplayContent.mcq.length > 0 && (
                    <div className="ai-section">
                      <h3 className="ai-section-title">
                        <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="ai-section-icon">
                          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
                          <text x="12" y="17" textAnchor="middle" fontSize="12" fill="currentColor" fontWeight="700">?</text>
                        </svg>
                        {_('mcqQuiz')} ({aiDisplayContent.mcq.length})
                      </h3>
                      <div className="mcq-list">
                        {aiDisplayContent.mcq.map((q, qIdx) => {
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
                                  <strong>{isCorrect ? _('correct') : _('incorrect')}</strong>
                                  <p>{q.explanation}</p>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {aiDisplayContent && !aiDisplayContent.flashcards && !aiDisplayContent.mcq && aiDisplayContent.raw && (
                    <div className="ai-section">
                      <h3 className="ai-section-title">{_('generatedContent')}</h3>
                      <pre className="ai-raw">{aiDisplayContent.raw}</pre>
                    </div>
                  )}

                  {aiDisplayContent?.error && !aiDisplayContent.flashcards && !aiDisplayContent.mcq && (
                    <div className="ai-error">
                      <p>⚠️ {aiDisplayContent.error}</p>
                    </div>
                  )}
                </div>
              )}
              {/* Test mode: debug sections */}
              {aiDebug && (
                <div className="ai-debug-section">
                  <details className="ai-debug-details">
                    <summary className="ai-debug-summary">Request Payload</summary>
                    <textarea
                      className="ai-debug-textarea"
                      readOnly
                      value={JSON.stringify(aiDebug.request, null, 2)}
                      rows={10}
                    />
                  </details>
                  <details className="ai-debug-details">
                    <summary className="ai-debug-summary">Extraction Raw Response</summary>
                    <textarea
                      className="ai-debug-textarea"
                      readOnly
                      value={aiDebug.extractionRaw || ''}
                      rows={8}
                    />
                  </details>
                  <details className="ai-debug-details">
                    <summary className="ai-debug-summary">Generation Raw Response</summary>
                    <textarea
                      className="ai-debug-textarea"
                      readOnly
                      value={aiDebug.generationRaw || ''}
                      rows={8}
                    />
                  </details>
                </div>
              )}

              {!aiContent && !aiLoading && !aiError && (
                <div className="ai-empty">
                  <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="ai-empty-icon">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                  </svg>
                  <p>{_('aiEmptyPrompt')}</p>
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
                title={_('openInNewTab')}
              >
                ↗
              </a>
              <button
                className="modal-close"
                onClick={() => setModalInfo(null)}
                aria-label={_('close')}
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
                title={_('youtubeVideo')}
                allow="autoplay; encrypted-media"
                allowFullScreen
              />
            ) : (
              <iframe src={modalFrameSrc} className="modal-iframe" title={_('resourceViewer')} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
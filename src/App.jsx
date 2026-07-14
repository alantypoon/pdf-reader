import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QrScanner from 'qr-scanner';
import jsQR from 'jsqr';
import { detectCropUpscaleQr, detectCropUpscaleToClipboard } from './qr-utils.js';
import Swal from 'sweetalert2';
import BookAutocomplete from './BookAutocomplete';
import PdfPane from './PdfPane';
import SectionAutocomplete from './SectionAutocomplete';
import StepperSelect from './StepperSelect';
import AutocompleteDropdown from './components/AutocompleteDropdown';
import { t, uiLang } from './i18n';

const PREFERENCES_KEY = 'pdfReaderPreferences';
const DEFAULT_ANNOTATION_COLOR = '#9acd32';
const ANNOTATION_TOOLS = new Set(['pen', 'highlight', 'text', 'eraser', 'move', 'hand']);
const COLOR_TOOLS = new Set(['pen', 'highlight', 'text']);

// ── QR code debug capture levels ──────────────────────────
// 0 = no debug
// 1 = show click-position tooltip + console logs
// 2 = also copy crop image data URL to clipboard
// 3 = also trigger a Save-As file download
const DEBUG_QRCODE_CAPTURE = 0;
// const DEBUG_QRCODE_CAPTURE = 2;

/** Return an ISO-8601 timestamp in Hong Kong time (UTC+8) */
function hkNow() {
  const now = Date.now() + 8 * 60 * 60 * 1000; // UTC + 8h = HKT
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

const POPULAR_COLORS = [
  '#9acd32', // YellowGreen (default)
  '#000000', // Black
  '#e74c3c', // Red
  '#e67e22', // Orange
  '#f1c40f', // Yellow
  '#2ecc71', // Green
  '#1abc9c', // Teal
  '#3498db', // Blue
  '#2980b9', // Dark Blue
  '#9b59b6', // Purple
  '#e91e63', // Pink
  '#795548', // Brown
  '#95a5a6', // Gray
];

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

/** Convert a section's page/section value to a stable file ID.
 *  Numeric values (1, "3") → number; non-numeric ("end") → string. */
function toFileId(raw) {
  if (raw == null) return '';
  const num = Number(raw);
  return isNaN(num) ? String(raw) : num;
}

function getSectionResources(section, language) {
  const value = section?.[language];
  if (!value || typeof value === 'string') return [];
  return value.resources || [];
}

function buildQrUrlRewriteMap(chapter) {
  const entries = [];

  for (const section of chapter?.contents || []) {
    for (const language of ['en', 'tc']) {
      for (const resource of getSectionResources(section, language)) {
        const sourceUrl = typeof resource?.['url-orig'] === 'string' ? resource['url-orig'].trim() : '';
        const targetUrl = typeof resource?.url === 'string' ? resource.url.trim() : '';
        if (!sourceUrl || !targetUrl) continue;

        entries.push([sourceUrl, { url: targetUrl, name: resource?.name || '' }]);

        try {
          entries.push([new URL(sourceUrl).href, { url: targetUrl, name: resource?.name || '' }]);
        } catch {
          // Keep the raw sourceUrl entry when normalization is not possible.
        }
      }
    }
  }

  return new Map(entries);
}

function hasRenderableSource(source) {
  if (Array.isArray(source)) return source.length > 0;
  return typeof source === 'string' && source.trim().length > 0;
}

function getSubjectLabel(subjectId, selectedLanguage = 'en') {
  const normalized = String(subjectId || '').trim().toLowerCase();
  const showChinese = selectedLanguage === 'tc';
  if (normalized === 'biology-oup') return showChinese ? '生物' : 'Biology';
  if (normalized === 'chemistry-winter') return showChinese ? '化學' : 'Chemistry';
  if (normalized === 'physics-oup') return showChinese ? '物理' : 'Physics';
  return String(subjectId || '').trim();
}

/** Abbreviated label for the collapsed sidebar subject button. */
function getSubjectAbbreviation(subjectId, selectedLanguage = 'en') {
  const normalized = String(subjectId || '').trim().toLowerCase();
  let result;
  if (normalized === 'biology-oup') result = selectedLanguage === 'tc' ? '生物' : 'Bio';
  else if (normalized === 'chemistry-winter') result = selectedLanguage === 'tc' ? '化學' : 'Che';
  else if (normalized === 'physics-oup') result = selectedLanguage === 'tc' ? '物理' : 'Phy';
  else result = getSubjectLabel(subjectId, selectedLanguage);
  // console.log('[subjectBtn] getSubjectAbbreviation', { subjectId, selectedLanguage, normalized, result });
  return result;
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

function FloatingAudioPlayer({ url, name, onClose }) {
  const playerRef = useRef(null);
  const dragState = useRef({ dragging: false, startX: 0, startY: 0 });
  const [position, setPosition] = useState(() => {
    // Start at the center of the viewport
    const w = window.innerWidth;
    const h = window.innerHeight;
    return { x: Math.max(0, (w - 350) / 2), y: Math.max(0, (h - 80) / 2) };
  });

  const startDrag = useCallback((clientX, clientY) => {
    dragState.current = {
      dragging: true,
      startX: clientX - position.x,
      startY: clientY - position.y,
    };
  }, [position]);

  // Mouse drag
  const onMouseDown = useCallback((e) => {
    if (e.target.tagName === 'BUTTON' || e.target.closest('audio')) return;
    e.preventDefault();
    startDrag(e.clientX, e.clientY);
  }, [startDrag]);

  // Touch drag (tablet / phone)
  const onTouchStart = useCallback((e) => {
    if (e.target.tagName === 'BUTTON' || e.target.closest('audio')) return;
    const touch = e.touches[0];
    startDrag(touch.clientX, touch.clientY);
  }, [startDrag]);

  useEffect(() => {
    const onMove = (clientX, clientY) => {
      if (!dragState.current.dragging) return;
      setPosition({
        x: clientX - dragState.current.startX,
        y: clientY - dragState.current.startY,
      });
    };
    const onMouseMove = (e) => onMove(e.clientX, e.clientY);
    const onTouchMove = (e) => {
      if (!dragState.current.dragging) return;
      e.preventDefault();
      const touch = e.touches[0];
      onMove(touch.clientX, touch.clientY);
    };
    const onEnd = () => { dragState.current.dragging = false; };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onEnd);
    };
  }, []);

  return (
    <div
      className="floating-audio-player"
      style={{ left: position.x, top: position.y }}
      ref={playerRef}
    >
      <div
        className="floating-audio-header"
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
      >
        <span className="floating-audio-title">{name || 'Audio'}</span>
        <button
          className="floating-audio-close"
          onClick={onClose}
          aria-label="Close player"
        >
          ✕
        </button>
      </div>
      <div className="floating-audio-body">
        <audio controls autoPlay className="floating-audio-el">
          <source src={url} type="audio/mpeg" />
        </audio>
      </div>
    </div>
  );
}

/** Small helper for test-mode debug sub-sections within each pipeline step */
function DebugSubSection({ label, data }) {
  const isEmpty = !data || (typeof data === 'object' && Object.keys(data).length === 0);
  const value = isEmpty ? '(empty)' : (typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return (
    <div className="ai-debug-sub">
      <div className="ai-debug-sub-label">{label}</div>
      <textarea className="ai-debug-textarea" readOnly value={value} rows={isEmpty ? 2 : 10} />
    </div>
  );
}

function App() {
  const savedPrefs = loadPreferences();
  const initialTextColor = useMemo(() => {
    const value = savedPrefs.textColor;
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
      ? value
      : DEFAULT_ANNOTATION_COLOR;
  }, [savedPrefs.textColor]);
  const [userId, setUserId] = useState('');
  const isTestMode = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('test') === '1';
  }, []);
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const drawingRef = useRef(false);
  const currentStrokeRef = useRef(null);
  const moveAnnotationRef = useRef(null);
  const moveStartPointRef = useRef(null);
  const moveHasMovedRef = useRef(false);
  const activePointersRef = useRef(new Set()); // track active pointer IDs for multi-touch detection
  const displayModeInitializedRef = useRef(false);
  const initialSubjectRestoreRef = useRef('');
  const restoringUserSelectsRef = useRef(false);
  const [structure, setStructure] = useState([]);
  const [dataBooks, setDataBooks] = useState([]);
  const [activeBookId, setActiveBookId] = useState('');
  const [physicsChapterCatalog, setPhysicsChapterCatalog] = useState(null);
  const physicsChapterCatalogRef = useRef(null);
  useEffect(() => {
    physicsChapterCatalogRef.current = physicsChapterCatalog;
  }, [physicsChapterCatalog]);
  const [subjectSelections, setSubjectSelections] = useState({});
  const [lastSubjectId, setLastSubjectId] = useState('');
  const [sessionUserResolved, setSessionUserResolved] = useState(false);
  const [userSelectsLoaded, setUserSelectsLoaded] = useState(false);
  const [selectedBook, setSelectedBook] = useState('');
  const [selectedChapter, setSelectedChapter] = useState('');
  const [selectedFile, setSelectedFile] = useState(1);
  const [selectedPage, setSelectedPage] = useState(1);
  const [selectedPhysicsChapterId, setSelectedPhysicsChapterId] = useState('');
  const [displayMode, setDisplayMode] = useState(savedPrefs.displayMode || 'scrolling');
  const showThumbnails = displayMode === 'thumbnails';
  const displayModeRef = useRef(displayMode);
  const selectedPageRef = useRef(selectedPage);
  const selectedFileRef = useRef(selectedFile);
  const currentChapterRef = useRef(null);  // synced via useEffect below
  const selectedChapterRef = useRef(selectedChapter);
  const maxNavigablePageRef = useRef(Infinity);
  const regenSkipExtractionRef = useRef(false);
  const regenSkipSummaryRef = useRef(false);
  const regenSkipFlashcardsRef = useRef(false);
  const regenSkipQuizRef = useRef(false);
  const [selectedLanguage, setSelectedLanguage] = useState(savedPrefs.selectedLanguage || 'bilingual');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(Boolean(savedPrefs.sidebarCollapsed));
  const [sidebarHidden, setSidebarHidden] = useState(Boolean(savedPrefs.sidebarHidden));
  const [pageSources, setPageSources] = useState({});
  const [pageLoading, setPageLoading] = useState(false);
  const [remarks, setRemarks] = useState([]);
  const [pageAnnotations, setPageAnnotations] = useState([]);
  const [tool, setTool] = useState(() => {
    if (!savedPrefs.annotationToolsOpen) return 'hand';
    return ANNOTATION_TOOLS.has(savedPrefs.tool) ? savedPrefs.tool : 'highlight';
  });
  const [annotationToolsOpen, setAnnotationToolsOpen] = useState(Boolean(savedPrefs.annotationToolsOpen));
  const [textColor, setTextColor] = useState(initialTextColor);
  const [textInputState, setTextInputState] = useState(null);
  const textInputRef = useRef(null);
  const textInputCommittedRef = useRef(false);
  const textInputBlurFlagRef = useRef(false);
  const [clearedTimestamps, setClearedTimestamps] = useState([]);
  const [clickMarker, setClickMarker] = useState(null);  // { x, y, imgLeft, imgTop, naturalX, naturalY } debug overlay
  const clickMarkerTimeoutRef = useRef(null);
  const [qrCropRect, setQrCropRect] = useState(null);     // { left, top, width, height } dashed overlay for QR crop
  const qrCropRectTimeoutRef = useRef(null);
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [zoomLevel, setZoomLevel] = useState(Number(savedPrefs.zoomLevel || 1));
  const [fitMode, setFitMode] = useState(
    savedPrefs.fitMode === 'height' ? 'height' : 'width'
  );
  const [renderScaleByLanguage, setRenderScaleByLanguage] = useState({});
  const [pageCounts, setPageCounts] = useState({});
  const [redrawTick, setRedrawTick] = useState(0);
  const [modalInfo, setModalInfo] = useState(null);
  const modalIframeRef = useRef(null);
  const modalFrameTimeoutRef = useRef(null);
  const [modalFrameLoading, setModalFrameLoading] = useState(false);
  const [modalFrameFailed, setModalFrameFailed] = useState(false);
  const [floatingPlayer, setFloatingPlayer] = useState(null);
  const [activeAnnotationLangId, setActiveAnnotationLangId] = useState('en');
  const [resourcesDrawerOpen, setResourcesDrawerOpen] = useState(false);
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [aiDrawerLanguage, setAiDrawerLanguage] = useState('en');
  const [aiContent, setAiContent] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [visionProviders, setVisionProviders] = useState([]);
  const [visionProvider, setVisionProvider] = useState('');
  const [flippedCards, setFlippedCards] = useState({});
  const [mcqAnswers, setMcqAnswers] = useState({});
  const [aiDebug, setAiDebug] = useState(null);
  const [searchDrawerOpen, setSearchDrawerOpen] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [colorPickerPos, setColorPickerPos] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState('book');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [jumpNotice, setJumpNotice] = useState('');
  const [toolbarScale, setToolbarScale] = useState(1);
  const [toolbarTight, setToolbarTight] = useState(false);
  const [includeAnnotations, setIncludeAnnotations] = useState(false);
  const [panelVisible, setPanelVisible] = useState(savedPrefs.panelVisible !== false);
  const [isFullscreen, setIsFullscreen] = useState(() => {
    if (typeof document === 'undefined') return false;
    return Boolean(document.fullscreenElement);
  });
  const [panelReservedHeight, setPanelReservedHeight] = useState(0);
  const [fitRefreshToken, setFitRefreshToken] = useState(0);
  const [singleRowToolbar, setSingleRowToolbar] = useState(false);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [studyMenuOpen, setStudyMenuOpen] = useState(false);
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const [lastStudyAction, setLastStudyAction] = useState('ai'); // 'ai' | 'resources' | 'search'
  const [thumbCols, setThumbCols] = useState(4);
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
  const [isPortrait, setIsPortrait] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(orientation: portrait)').matches;
  });
  const panelRef = useRef(null);
  const mainControlsRef = useRef(null);
  const primaryToolbarRef = useRef(null);
  const secondaryToolbarRef = useRef(null);
  const annotationToggleRef = useRef(null);
  const searchButtonRef = useRef(null);
  const closeButtonRef = useRef(null);
  const colorBtnRef = useRef(null);
  const customColorInputRef = useRef(null);
  const restorePressTimerRef = useRef(null);
  const restoreLongPressRef = useRef(false);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, posX: 0, posY: 0 });
  const pageViewRef = useRef({ key: '', startedAt: 0, loginLogged: false });
  const touchScrollingRef = useRef(false);
  const lastTouchScrollAtRef = useRef(0);
  const momentumRef = useRef({ animating: false, vx: 0, vy: 0, target: null, lastTime: 0, rafId: null });
  const wheelVelocityRef = useRef({ vx: 0, vy: 0, lastTime: 0, timeoutId: null });
  const isIOSDevice = useRef((() => {
    if (typeof navigator === 'undefined') return false;
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.maxTouchPoints > 1 && /MacIntel/.test(navigator.platform));
  })()).current;

  // Position the color picker popover relative to the color button
  useLayoutEffect(() => {
    if (!colorPickerOpen) {
      setColorPickerPos(null);
      return;
    }
    const updatePos = () => {
      const btn = colorBtnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setColorPickerPos({
        left: r.left + r.width / 2,
        top: r.top - 8,
        transform: 'translate(-50%, -100%)',
      });
    };
    updatePos();
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [colorPickerOpen]);

  const lang = uiLang(selectedLanguage);
  const _ = (key) => t(key, lang);
  const logoutUrl = useMemo(() => {
    if (typeof window === 'undefined') {
      return '/dse-logout.php';
    }
    const next = `${window.location.pathname}${window.location.search}`;
    return `/dse-logout.php?next=${encodeURIComponent(next)}`;
  }, []);
  const regenerateConfirmMessage = _('confirmRegenerate');
  const fitDisabled = displayMode === 'thumbnails';
  const panelDocked = true;

  const refreshFitForCurrentMode = useCallback(() => {
    setZoomLevel(1);
    setFitRefreshToken((current) => current + 1);
  }, []);

  // Refresh layout when fullscreen, sidebar, panel, or window size changes
  useEffect(() => {
    const onResize = () => { 
      // console.log('[layout] window resize — firing fit refresh'); 
      refreshFitForCurrentMode(); 
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [refreshFitForCurrentMode]);

  useEffect(() => {
    console.log('[layout] sidebar collapse/expand/fullscreen changed — scheduling fit refresh in 2000ms');
    const timer = setTimeout(() => {
      console.log('[layout] firing fit refresh now');
      refreshFitForCurrentMode();
    }, 2000);
    return () => clearTimeout(timer);
  }, [isFullscreen, sidebarCollapsed, sidebarHidden, panelVisible, refreshFitForCurrentMode]);

  const preferredAiDrawerLanguage = useMemo(() => {
    return selectedLanguage === 'tc' ? 'zh' : 'en';
  }, [selectedLanguage]);

  const normalizeAiContent = useCallback((content) => {
    if (!content || typeof content !== 'object') return null;
    const normalized = {
      en: content.en || null,
      zh: content.zh || content.tc || null,
    };
    return normalized.en || normalized.zh ? normalized : null;
  }, []);

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
    const loadUserSelects = async () => {
      if (!sessionUserResolved) {
        return;
      }
      if (!userId) {
        setUserSelectsLoaded(true);
        return;
      }
      try {
        const data = await fetchJson(`api/user-selects?userId=${encodeURIComponent(userId)}`);
        setLastSubjectId(typeof data.lastSubjectId === 'string' ? data.lastSubjectId : '');
        setSubjectSelections(data.selections && typeof data.selections === 'object' ? data.selections : {});
      } catch (err) {
        console.error('[user-selects] failed to load:', err);
        setLastSubjectId('');
        setSubjectSelections({});
      } finally {
        setUserSelectsLoaded(true);
      }
    };
    initialSubjectRestoreRef.current = '';
    restoringUserSelectsRef.current = false;
    setUserSelectsLoaded(false);
    loadUserSelects();
  }, [sessionUserResolved, userId]);

  const applyBookSelection = useCallback((chapters, nextBookId, options = {}) => {
    const { preferredSectionId, preferredPageId, preferredPhysicsChapterId } = options;
    const nextBook = (chapters || []).find((chapter) => chapter.id === nextBookId) || (chapters || [])[0] || null;
    const firstSection = nextBook?.contents?.[0];

    const rawFirstId = firstSection ? (firstSection.page ?? firstSection.section) : 1;
    const firstSectionId = toFileId(rawFirstId);

    const hasPreferredSection = nextBook?.contents?.some((item) => {
      return String(toFileId(item.page ?? item.section)) === String(preferredSectionId ?? '');
    });
    const nextSectionId = hasPreferredSection
      ? toFileId(preferredSectionId)
      : firstSectionId;
    const nextPageId = Math.max(1, Number(preferredPageId || 1));

    setSelectedChapter(nextBook?.id || '');
    setSelectedFile(nextSectionId);
    setSelectedPage(nextPageId);
    setSelectedPhysicsChapterId(preferredPhysicsChapterId ? String(preferredPhysicsChapterId) : '');
  }, [selectedBook]);

  const applySubjectSelection = useCallback((subjectId, chapters, defaultSubjectId = '') => {
    const normalizedSubjectId = String(subjectId || defaultSubjectId || '').trim();
    const savedSelection = subjectSelections[normalizedSubjectId] || {};
    const fallbackBookId = savedSelection.bookId || chapters?.[0]?.id || '';
    applyBookSelection(chapters, fallbackBookId, {
      preferredSectionId: savedSelection.sectionId,
      preferredPageId: savedSelection.pageId,
      preferredPhysicsChapterId: savedSelection.physicsChapterId,
    });
  }, [applyBookSelection, subjectSelections]);

  useEffect(() => {
    if (!sessionUserResolved || !userSelectsLoaded || !userId || initialSubjectRestoreRef.current === userId) return;
    initialSubjectRestoreRef.current = userId;
    restoringUserSelectsRef.current = true;
    const loadCatalog = async (book) => {
      try {
        const bookParam = book ? `?book=${encodeURIComponent(book)}` : '';
        const data = await fetchJson(`api/catalog${bookParam}`);
        const chapters = data.chapters || [];
        setDataBooks(Array.isArray(data.books) ? data.books : []);
        const bookId = typeof data.activeBookId === 'string' ? data.activeBookId : '';
        setActiveBookId(bookId);
        setSelectedBook(book || bookId);
        setStructure(chapters);
        if (chapters.length) {
          applySubjectSelection(book || bookId, chapters, bookId);
        } else {
          setSelectedChapter('');
          setSelectedFile(1);
          setSelectedPage(1);
          setSelectedPhysicsChapterId('');
        }
      } catch (err) {
        console.error('[catalog] failed to load:', err);
        setDataBooks([]);
        setActiveBookId('');
        setStructure([]);
      } finally {
        restoringUserSelectsRef.current = false;
      }
    };

    const storedSubjectId = typeof savedPrefs.selectedBook === 'string' ? savedPrefs.selectedBook : '';
    const rememberedSubjectId = lastSubjectId || storedSubjectId || '';
    loadCatalog(rememberedSubjectId);
  }, [applySubjectSelection, lastSubjectId, savedPrefs.selectedBook, sessionUserResolved, userId, userSelectsLoaded]);

  useEffect(() => {
    if (selectedBook !== 'physics-oup' || physicsChapterCatalog) return;
    const loadPhysicsChapters = async () => {
      // try {
      //   const data = await fetchJson('/pdf-reader/data/physics-oup/physics-chapters.json');
      //   setPhysicsChapterCatalog(data || {});
      // } catch (err) {
      //   console.error('[physics-chapters] failed to load:', err);
      //   setPhysicsChapterCatalog({});
      // }
    };
    loadPhysicsChapters();
  }, [selectedBook, physicsChapterCatalog]);

  useEffect(() => {
    const loadSessionUser = async () => {
      try {
        const data = await fetchJson('api/session-user');
        if (typeof data.userId === 'string' && data.userId.trim()) {
          setUserId(data.userId.trim());
          setSessionUserResolved(true);
          return;
        }
      } catch (err) {
        console.error('[session-user] failed to load:', err);
      }
      // Not authenticated — ask to login
      setSessionUserResolved(true);
      const loginUrl = `/dse-login.php?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      Swal.fire({
        title: _('loginRequired') || 'Login Required',
        text: _('pleaseLogin') || 'Please log in to continue.',
        icon: 'warning',
        confirmButtonText: _('login') || 'Login',
        allowOutsideClick: false,
        allowEscapeKey: false,
      }).then(() => {
        window.location.href = loginUrl;
      });
    };

    loadSessionUser();
  }, []);

  useEffect(() => {
    if (!userId || pageViewRef.current.loginLogged) return;
    pageViewRef.current.loginLogged = true;
    logUserAction('login');
  }, [userId]);

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

  const sectionScopedAnnotations = displayMode === 'scrolling' || displayMode === 'thumbnails';

  const loadRemarksForCurrentScope = useCallback(async () => {
    const langTargets = selectedLanguage === 'bilingual'
      ? visibleLanguages
      : visibleLanguages.slice(0, 1);
    if (!langTargets.length) {
      setRemarks([]);
      return [];
    }

    const responses = await Promise.all(
      langTargets.map((langId) => {
        const params = new URLSearchParams({
          userId,
          subjectId: selectedBook,
          bookId: selectedChapter,
          sectionId: String(selectedFile),
          langId,
        });
        if (!sectionScopedAnnotations) {
          params.set('pageId', String(selectedPage));
        }
        return fetchJson(`api/remarks?${params.toString()}`);
      })
    );

    const nextRemarks = responses.flatMap((data) => data.remarks || []);
    setRemarks(nextRemarks);
    return nextRemarks;
  }, [userId, selectedBook, selectedChapter, selectedFile, selectedLanguage, selectedPage, visibleLanguages, sectionScopedAnnotations]);

  useEffect(() => {
    const loadRemarks = async () => {
      try {
        await loadRemarksForCurrentScope();
      } catch (err) {
        console.error('[remarks] failed to load:', err);
        setRemarks([]);
      }
    };

    loadRemarks();
  }, [loadRemarksForCurrentScope]);

  useEffect(() => {
    const existing = remarks.filter(
      (remark) =>
        remark.chapter === selectedChapter &&
        Number(remark.page) === Number(selectedPage) &&
        !clearedTimestamps.includes(remark.createdAt)
    );
    setPageAnnotations(existing.map((remark) => ({
      ...remark,
      langId: remark.langId === 'tc' ? 'tc' : 'en'
    })));
  }, [remarks, selectedChapter, selectedPage, clearedTimestamps]);

  // All annotations for the current section (all pages) — used in thumbnails & scrolling modes
  const allSectionAnnotations = useMemo(() => {
    return remarks
      .filter((remark) =>
        remark.chapter === selectedChapter &&
        !clearedTimestamps.includes(remark.createdAt)
      )
      .map((remark) => ({
        ...remark,
        langId: remark.langId === 'tc' ? 'tc' : 'en'
      }));
  }, [remarks, selectedChapter, clearedTimestamps]);

  const currentChapter = useMemo(
    () => structure.find((chapter) => chapter.id === selectedChapter),
    [structure, selectedChapter]
  );

  const qrUrlRewriteMap = useMemo(() => buildQrUrlRewriteMap(currentChapter), [currentChapter]);

  const handleBookSelect = (newBookId) => {
    applyBookSelection(structure, newBookId);
  };

  const physicsBookChapterMeta = useMemo(() => {
    if (selectedBook !== 'physics-oup' || !physicsChapterCatalog) return null;
    return physicsChapterCatalog[String(selectedChapter || '').toLowerCase()] || null;
  }, [selectedBook, selectedChapter, physicsChapterCatalog]);

  const isOnePdfForAllSections = useMemo(() => {
    if (selectedBook !== 'physics-oup' || !physicsBookChapterMeta) return false;
    return Boolean(physicsBookChapterMeta['one-pdf-for-all-section']);
  }, [selectedBook, physicsBookChapterMeta]);

  const currentSection = useMemo(() => {
    if (!currentChapter?.contents?.length) return undefined;
    return currentChapter.contents.find((item) => {
      const itemId = toFileId(item.page ?? item.section);
      const fileId = toFileId(selectedFile);
      // Compare consistently: both as strings (handles numeric + "end" uniformly)
      return String(itemId) === String(fileId);
    });
  }, [currentChapter, selectedFile, isOnePdfForAllSections]);

  const currentBookHeaderName = useMemo(() => {
    if (!currentChapter) return selectedChapter;
    const zhName = typeof currentChapter.nameZh === 'string' ? currentChapter.nameZh.trim() : '';
    const enName = typeof currentChapter.nameEn === 'string' ? currentChapter.nameEn.trim() : '';
    const fallbackName = typeof currentChapter.name === 'string' ? currentChapter.name.trim() : '';

    if (selectedLanguage === 'tc') {
      return zhName || enName || fallbackName || currentChapter.id || selectedChapter;
    }
    if (selectedLanguage === 'bilingual') {
      return enName || zhName || fallbackName || currentChapter.id || selectedChapter;
    }
    return enName || fallbackName || zhName || currentChapter.id || selectedChapter;
  }, [currentChapter, selectedChapter, selectedLanguage]);

  const bookAutocompleteOptions = useMemo(() => {
    if (selectedBook !== 'biology-oup') {
      return structure;
    }
    return (structure || []).map((item) => ({
      ...item,
      name: /^e\d+$/i.test(String(item.id || '')) ? item.name : '',
      nameEn: /^e\d+$/i.test(String(item.id || '')) ? item.nameEn : '',
      nameZh: /^e\d+$/i.test(String(item.id || '')) ? item.nameZh : '',
    }));
  }, [selectedBook, structure]);

  /** Normalize a section/page identifier based on the book's PDF mode.
   *  In "one PDF for all sections" mode the identifier is the book ID (string),
   *  otherwise it's a numeric section number. */
  const normalizeSectionId = useCallback((value) => {
    if (isOnePdfForAllSections) return String(value ?? '');
    return Number(value);
  }, [isOnePdfForAllSections]);

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
    const explicit = physicsChapterOptions.find((item) => String(item.id) === String(selectedPhysicsChapterId));
    if (explicit && page === Number(explicit.startPage || 1)) {
      return explicit;
    }
    const sorted = [...physicsChapterOptions].sort((a, b) => Number(a.startPage) - Number(b.startPage));
    for (let index = 0; index < sorted.length; index += 1) {
      const current = sorted[index];
      const next = sorted[index + 1];
      const currentStart = Number(current.startPage || 1);
      const nextStart = Number(next?.startPage || Number.POSITIVE_INFINITY);
      if (page >= currentStart && page < nextStart) {
        return current;
      }
    }
    return sorted[sorted.length - 1] || sorted[0] || null;
  }, [physicsChapterOptions, selectedPage, selectedPhysicsChapterId]);

  const currentSectionHeaderId = useMemo(() => {
    return selectedFile;
  }, [selectedFile]);

  const currentSectionHeaderName = useMemo(() => {
    if (!currentSection) {
      return String(selectedFile || '');
    }

    const enName = getSectionName(currentSection, 'en');
    const zhName = getSectionName(currentSection, 'tc');
    if (selectedLanguage === 'tc') {
      return zhName || enName || String(selectedFile || '');
    }
    if (selectedLanguage === 'bilingual') {
      return enName || zhName || String(selectedFile || '');
    }
    return enName || zhName || String(selectedFile || '');
  }, [currentSection, selectedFile, selectedLanguage]);

  /** Compact display for the collapsed sidebar section button, using section
   *  names from contents.json (same source as SectionAutocomplete dropdown).
   *  Computed inline (not memoized) so it NEVER gets stale. */
  const collapsedSectionDisplay = (() => {
    if (!currentSection) return String(selectedFile || '') || '···';
    const sectionId = String(currentSection.section || currentSection.page || '').trim();
    let sectionLabel = '';
    if (selectedLanguage === 'bilingual') {
      const en = getSectionName(currentSection, 'en');
      const tc = getSectionName(currentSection, 'tc');
      sectionLabel = [en, tc].filter(Boolean).join(' / ') || '';
    } else {
      sectionLabel = getSectionName(currentSection, selectedLanguage) || '';
    }
    if (!sectionId || !sectionLabel) return sectionLabel || sectionId || '···';
    // Compact format: "2 Motion" — but avoid "2 2" when label starts with the section id
    const firstWord = sectionLabel.split(' ')[0];
    const bareFirst = firstWord.replace(/[.:-]$/, '');
    if (bareFirst === sectionId || bareFirst === String(Number(sectionId))) {
      return sectionLabel; // label already contains the section number, use as-is
    }
    return `${sectionId} ${firstWord}`;
  })();

  /** Compact display for the collapsed sidebar book button: "2 Force" (ID + first name word). */
  const collapsedBookDisplay = useMemo(() => {
    if (!currentChapter) return '···';
    const id = String(currentChapter.id || '').toUpperCase();
    const name = currentBookHeaderName;
    if (!name) return id;
    const firstWord = name.split(' ')[0];
    // Avoid "1A 1A" when the name is just the ID (e.g. Biology core books)
    if (firstWord.toUpperCase() === id) return id;
    return `${id} ${firstWord}`;
  }, [currentChapter, currentBookHeaderName]);

  const getSectionHeaderNameForLang = useCallback((lang) => {
    if (!currentSection) return String(selectedFile || '');
    if (lang === 'tc') {
      return getSectionName(currentSection, 'tc') || getSectionName(currentSection, 'en') || String(selectedFile || '');
    }
    return getSectionName(currentSection, 'en') || getSectionName(currentSection, 'tc') || String(selectedFile || '');
  }, [currentSection, selectedFile]);

  const handlePhysicsChapterSelect = (chapterId) => {
    const next = physicsChapterOptions.find((item) => String(item.id) === String(chapterId));
    if (!next) return;
    setSelectedPhysicsChapterId(String(next.id));
    setSelectedPage(Math.max(1, Number(next.startPage) || 1));
  };

  const subjectToggleOptions = useMemo(() => {
    const desiredOrder = ['physics-oup', 'chemistry-winter', 'biology-oup'];
    const existing = new Set((dataBooks || []).map((item) => String(item)));
    return desiredOrder
      .filter((id) => existing.has(id))
      .map((id) => ({ id, label: getSubjectLabel(id, selectedLanguage) }));
  }, [dataBooks, selectedLanguage]);

  const subjectAutocompleteItems = useMemo(() => (
    subjectToggleOptions.map((item) => ({
      id: item.id,
      primary: item.label,
      searchText: item.label,
    }))
  ), [subjectToggleOptions]);

  const handleSubjectChange = async (newBook) => {
    if (!newBook || String(newBook) === String(selectedBook)) return;
    setSelectedBook(newBook);
    setLastSubjectId(newBook);
    setSelectedChapter('');
    setSelectedFile(1);
    setSelectedPage(1);
    setSelectedPhysicsChapterId('');
    try {
      const data = await fetchJson(`api/catalog?book=${encodeURIComponent(newBook)}`);
      const chapters = data.chapters || [];
      setDataBooks(Array.isArray(data.books) ? data.books : []);
      setActiveBookId(typeof data.activeBookId === 'string' ? data.activeBookId : newBook);
      setStructure(chapters);
      if (chapters.length) {
        applySubjectSelection(newBook, chapters, newBook);
      } else {
        setSelectedChapter('');
        setSelectedFile(1);
        setSelectedPage(1);
        setSelectedPhysicsChapterId('');
      }
    } catch (err) {
      console.error('[catalog] failed to step subject:', newBook, err);
    }
  };

  const currentBookIndex = useMemo(
    () => bookAutocompleteOptions.findIndex((item) => String(item.id) === String(selectedChapter)),
    [bookAutocompleteOptions, selectedChapter]
  );

  const stepBook = (direction) => {
    if (!bookAutocompleteOptions.length) return;
    const currentIndex = currentBookIndex >= 0 ? currentBookIndex : 0;
    const nextIndex = Math.max(0, Math.min(bookAutocompleteOptions.length - 1, currentIndex + direction));
    if (nextIndex === currentIndex) return;
    handleBookSelect(String(bookAutocompleteOptions[nextIndex].id));
  };

  const currentPhysicsChapterIndex = useMemo(
    () => physicsChapterOptions.findIndex((item) => String(item.id) === String(currentPhysicsChapter?.id || selectedPhysicsChapterId)),
    [physicsChapterOptions, currentPhysicsChapter, selectedPhysicsChapterId]
  );

  const stepPhysicsChapter = (direction) => {
    if (!physicsChapterOptions.length) return;
    const currentIndex = currentPhysicsChapterIndex >= 0 ? currentPhysicsChapterIndex : 0;
    const nextIndex = Math.max(0, Math.min(physicsChapterOptions.length - 1, currentIndex + direction));
    if (nextIndex === currentIndex) return;
    handlePhysicsChapterSelect(String(physicsChapterOptions[nextIndex].id));
  };

  const sectionSelectOptions = useMemo(() => (
    (currentChapter?.contents || []).map((item) => {
      const id = toFileId(item.page ?? item.section);
      const en = getSectionName(item, 'en');
      const tc = getSectionName(item, 'tc');
      const label = selectedLanguage === 'tc'
        ? `${id} - ${tc || en || id}`
        : `${id} - ${en || tc || id}`;
      const secondary = selectedLanguage === 'tc' ? (en || '') : (tc || '');
      return { id, label, secondary };
    })
  ), [currentChapter, selectedLanguage, isOnePdfForAllSections]);

  const currentSectionIndex = useMemo(
    () => sectionSelectOptions.findIndex((item) => {
      return String(item.id) === String(selectedFile);
    }),
    [sectionSelectOptions, selectedFile]
  );

  const sectionOptionsCount = currentChapter?.contents?.length || 0;

  useEffect(() => {
    if (!currentChapter?.contents?.length) return;
    const rawFirst = currentChapter.contents[0].page ?? currentChapter.contents[0].section ?? 1;
    const first = toFileId(rawFirst);
    setSelectedFile((current) => {
      const hasCurrent = currentChapter.contents.some((item) => {
        const itemId = toFileId(item.page ?? item.section);
        return String(itemId) === String(current ?? '');
      });
      return hasCurrent ? current : first;
    });
    setSelectedPage((current) => Math.max(1, Number(current) || 1));
  }, [currentChapter, isOnePdfForAllSections]);

  useEffect(() => {
    const loadPages = async () => {
      setPageLoading(true);
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

        // Seed pageCounts from the server response so cross-book navigation
        // works immediately, before the PDF renderer reports its own count.
        setPageCounts((current) => {
          const updated = { ...current };
          entries.forEach((entry, index) => {
            const language = targets[index];
            if (entry.status !== 'fulfilled') return;
            const [, source] = entry.value;
            if (Array.isArray(source) && source.length > 0 && !updated[language]) {
              updated[language] = source.length;
            }
          });
          return updated;
        });
      } catch (err) {
        console.error('[loadPages] failed:', err);
        setPageSources({});
      } finally {
        setPageLoading(false);
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
    displayModeRef.current = displayMode;
  }, [displayMode]);

  useEffect(() => {
    selectedPageRef.current = selectedPage;
  }, [selectedPage]);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  useEffect(() => {
    currentChapterRef.current = currentChapter;
  }, [currentChapter]);

  useEffect(() => {
    selectedChapterRef.current = selectedChapter;
  }, [selectedChapter]);

  useEffect(() => {
    if (!selectedBook) return;
    setSubjectSelections((current) => {
      const nextEntry = {
        bookId: selectedChapter,
        sectionId: selectedFile,
        pageId: selectedPage,
        physicsChapterId: selectedBook === 'physics-oup' ? selectedPhysicsChapterId : '',
      };
      const previous = current[selectedBook] || {};
      if (
        previous.bookId === nextEntry.bookId
        && String(previous.sectionId ?? '') === String(nextEntry.sectionId ?? '')
        && Number(previous.pageId) === Number(nextEntry.pageId)
        && String(previous.physicsChapterId || '') === String(nextEntry.physicsChapterId || '')
      ) {
        return current;
      }
      return { ...current, [selectedBook]: nextEntry };
    });
  }, [selectedBook, selectedChapter, selectedFile, selectedPage, selectedPhysicsChapterId]);

  useEffect(() => {
    if (!sessionUserResolved || !userSelectsLoaded || !userId || !selectedBook || restoringUserSelectsRef.current) return;
    const timer = window.setTimeout(() => {
      fetchJson('api/user-selects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          lastSubjectId: selectedBook,
          subjectId: selectedBook,
          bookId: selectedChapter,
          sectionId: selectedFile,
          pageId: selectedPage,
          physicsChapterId: selectedBook === 'physics-oup' ? selectedPhysicsChapterId : '',
        }),
      }).catch((err) => {
        console.error('[user-selects] failed to save:', err);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [sessionUserResolved, userId, userSelectsLoaded, selectedBook, selectedChapter, selectedFile, selectedPage, selectedPhysicsChapterId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const prefs = {
      displayMode,
      selectedLanguage,
      sidebarCollapsed,
      sidebarHidden,
      tool,
      annotationToolsOpen,
      textColor,
      zoomLevel,
      fitMode,
      panelPos,
      panelVisible
    };
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
  }, [
    displayMode,
    selectedLanguage,
    sidebarCollapsed,
    sidebarHidden,
    tool,
    annotationToolsOpen,
    textColor,
    zoomLevel,
    fitMode,
    panelPos,
    panelVisible
  ]);

  // ── Canvas sizing — only fire when the canvas element's pixel dimensions
  //     may have changed (window resize, sidebar toggle, fullscreen, etc.).
  //     Resizing clears the canvas, so we must redraw immediately after.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');

    let lastW = 0;
    let lastH = 0;

    const resizeAndRedraw = () => {
      const frame = canvas.parentElement;
      const rect = frame.getBoundingClientRect();
      const w = Math.floor(rect.width * window.devicePixelRatio);
      const h = Math.floor(rect.height * window.devicePixelRatio);

      // Only touch canvas.width/height if dimensions actually changed.
      // Setting them clears the canvas — avoid doing it unnecessarily.
      if (w !== lastW || h !== lastH || canvas.width !== w || canvas.height !== h) {
        lastW = w;
        lastH = h;
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        context.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
      }

      const annotationsToDraw = (displayMode === 'thumbnails' || displayMode === 'scrolling')
        ? allSectionAnnotations
        : pageAnnotations;
      redraw(context, rect.width, rect.height, annotationsToDraw);
    };

    // Immediate draw
    resizeAndRedraw();

    window.addEventListener('resize', resizeAndRedraw);
    return () => window.removeEventListener('resize', resizeAndRedraw);
  }, [displayMode, sidebarCollapsed, sidebarHidden, isFullscreen, panelVisible, allSectionAnnotations, pageAnnotations]);

  // ── Annotation / layout redraw — fires when annotations, page sources, or
  //     any layout-affecting state changes.  Uses a DOUBLE rAF so the browser
  //     has definitely completed layout before we measure image rects.
  //     Also schedules a follow-up redraw ~100ms later as a safety net for
  //     slow-loading page canvases (PDF.js renders can span multiple frames).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let timerId = null;

    const doRedraw = () => {
      if (cancelled) return;
      const context = canvas.getContext('2d');
      const rect = canvas.getBoundingClientRect();
      const annotationsToDraw = (displayMode === 'thumbnails' || displayMode === 'scrolling')
        ? allSectionAnnotations
        : pageAnnotations;
      redraw(context, rect.width, rect.height, annotationsToDraw);
    };

    // First rAF: browser has processed the DOM mutations.
    // Second rAF: browser has completed layout & paint for the new content.
    const raf1 = requestAnimationFrame(() => {
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (cancelled) return;
        doRedraw();

        // Safety net: page canvases (especially from PDF.js) can take several
        // frames to fully render.  Schedule one more redraw ~100ms later.
        timerId = setTimeout(() => {
          if (cancelled) return;
          doRedraw();
        }, 100);
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (timerId) clearTimeout(timerId);
    };
  }, [pageAnnotations, allSectionAnnotations, pageSources, displayMode, selectedLanguage, sidebarCollapsed, zoomLevel, fitMode, fitRefreshToken, visibleLanguages, redrawTick]);

  // Sync annotationToolsOpen with panelVisible
  useEffect(() => {
    setAnnotationToolsOpen(panelVisible);
  }, [panelVisible]);

  useEffect(() => {
    if (!annotationToolsOpen) {
      if (tool !== 'hand') {
        setTool('hand');
      }
      return;
    }
    if (!ANNOTATION_TOOLS.has(tool)) {
      setTool('pen');
    }
  }, [annotationToolsOpen, tool]);

  // ── Momentum / inertia scrolling ──────────────────────
  const animateMomentum = useCallback(() => {
    const m = momentumRef.current;
    if (!m.animating || !m.target || !m.target.isConnected) {
      m.animating = false;
      m.rafId = null;
      m.target = null;
      return;
    }

    const now = performance.now();
    const dt = Math.min(now - (m.lastTime || now), 50); // cap at 50ms to avoid huge jumps
    m.lastTime = now;

    if (dt > 0) {
      // Apply displacement: dx = v * dt  (v is px/ms)
      m.target.scrollBy({
        left: m.vx * dt,
        top: m.vy * dt,
        behavior: 'auto',
      });

      // Frame-rate-independent friction: v *= 0.95^(dt / 16.67)
      // At 60fps, 0.95 per frame gives ~1.5s to stop — feels natural
      // On iOS, use lower friction (0.975) so momentum coasts longer
      const frictionBase = isIOSDevice ? 0.975 : 0.95;
      const friction = Math.pow(frictionBase, dt / 16.67);
      m.vx *= friction;
      m.vy *= friction;
    }

    const speed = Math.sqrt(m.vx * m.vx + m.vy * m.vy);
    if (speed > 0.02 && m.target.isConnected) {
      m.rafId = requestAnimationFrame(animateMomentum);
    } else {
      m.animating = false;
      m.rafId = null;
      m.target = null;
    }
  }, []);

  const startMomentum = useCallback((vx, vy, target) => {
    if (!target) return;
    const m = momentumRef.current;
    if (m.rafId) cancelAnimationFrame(m.rafId);

    m.animating = true;
    m.vx = vx;   // px/ms
    m.vy = vy;
    m.target = target;
    m.lastTime = performance.now();
    m.rafId = requestAnimationFrame(animateMomentum);
  }, [animateMomentum]);

  const cancelMomentum = useCallback(() => {
    const m = momentumRef.current;
    m.animating = false;
    m.vx = 0;
    m.vy = 0;
    m.target = null;
    if (m.rafId) {
      cancelAnimationFrame(m.rafId);
      m.rafId = null;
    }
  }, []);

  const getScrollTargetForGesture = useCallback((event) => {
    const stage = stageRef.current;
    if (!stage) return null;

    if (displayModeRef.current === 'pagination') {
      // In pagination mode, scroll the .pdf-single-page container under the touch point
      const source = event?.touches?.[0] || event?.changedTouches?.[0] || event;
      const clientX = source?.clientX;
      const clientY = source?.clientY;
      if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
        const panes = stage.querySelectorAll('[data-annotation-language]');
        for (const pane of panes) {
          const rect = pane.getBoundingClientRect();
          if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
            return pane.querySelector('.pdf-single-page') || stage;
          }
        }
      }
      return stage.querySelector('.pdf-single-page') || stage;
    }

    if (displayModeRef.current !== 'scrolling') {
      return stage;
    }

    const source = event?.touches?.[0] || event?.changedTouches?.[0] || event;
    const clientX = source?.clientX;
    const clientY = source?.clientY;
    const panes = stage.querySelectorAll('[data-annotation-language]');

    if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      for (const pane of panes) {
        const rect = pane.getBoundingClientRect();
        if (
          clientX >= rect.left
          && clientX <= rect.right
          && clientY >= rect.top
          && clientY <= rect.bottom
        ) {
          return pane.querySelector('.pdf-scroll-pages') || pane;
        }
      }
    }

    return stage.querySelector('.pdf-scroll-pages') || stage;
  }, []);

  // Pass through wheel events to scroll the PDF content.
  // Listens on the stage (always mounted) so wheel scrolling works even when the
  // annotation canvas has not yet rendered on the initial mount.
  // In hand mode we let the browser handle native scroll; in annotation-tool modes
  // we intercept wheel events and redirect them to the underlying scroll container.
  // No momentum/inertia for mouse wheel — only touch gets momentum.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const onWheel = (e) => {
      // In hand mode, let the browser scroll natively — don't intercept.
      if (tool === 'hand') return;

      // Skip wheel events synthesized from touch gestures — touch handler already scrolls.
      if (touchScrollingRef.current) return;
      if (Date.now() - lastTouchScrollAtRef.current < 250) return;

      // Cancel any running touch momentum so it doesn't fight the user's new input
      cancelMomentum();

      const scrollTarget = getScrollTargetForGesture(e);
      if (!scrollTarget) return;
      e.preventDefault();
      scrollTarget.scrollBy({ left: e.deltaX, top: e.deltaY, behavior: 'auto' });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      stage.removeEventListener('wheel', onWheel);
    };
  }, [getScrollTargetForGesture, cancelMomentum, tool]);

  // In scrolling/pagination mode on touch devices: one finger draws, two fingers scroll.
  // Momentum: on finger lift, scroll continues with captured velocity and decelerates.
  useEffect(() => {
    if ((displayMode !== 'scrolling' && displayMode !== 'pagination') || tool === 'hand') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let touchStartX = 0;
    let touchStartY = 0;
    let touchActive = false;
    let touchScrollTarget = null;
    let pendingRaf = null;
    let accumulatedDeltaX = 0;
    let accumulatedDeltaY = 0;

    // Velocity tracking for momentum on release
    let velocityX = 0;
    let velocityY = 0;
    let lastVelocityTime = 0;
    let lastVelocityX = 0;
    let lastVelocityY = 0;

    const getTouchMidpoint = (touches) => {
      if (!touches || touches.length < 2) return null;
      return {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2,
      };
    };

    const applyScroll = () => {
      pendingRaf = null;
      if (!touchActive) return;
      const dx = accumulatedDeltaX;
      const dy = accumulatedDeltaY;
      accumulatedDeltaX = 0;
      accumulatedDeltaY = 0;
      if (dx === 0 && dy === 0) return;
      touchScrollTarget?.scrollBy({ left: dx, top: dy, behavior: 'auto' });
    };

    const onTouchStart = (e) => {
      // Cancel any running momentum when user touches again
      cancelMomentum();

      if (e.touches.length === 2) {
        const midpoint = getTouchMidpoint(e.touches);
        if (!midpoint) return;
        e.preventDefault();
        lastTouchScrollAtRef.current = Date.now();
        touchStartX = midpoint.x;
        touchStartY = midpoint.y;
        accumulatedDeltaX = 0;
        accumulatedDeltaY = 0;
        touchActive = true;
        touchScrollTarget = getScrollTargetForGesture(e);
        touchScrollingRef.current = true;

        // Reset velocity trackers for the new gesture
        velocityX = 0;
        velocityY = 0;
        lastVelocityTime = 0;

        if (drawingRef.current && currentStrokeRef.current) {
          drawingRef.current = false;
          currentStrokeRef.current = null;
        }
      } else {
        touchActive = false;
        touchScrollTarget = null;
      }
    };

    const onTouchMove = (e) => {
      if (!touchActive) return;
      if (e.touches.length !== 2) {
        touchActive = false;
        touchScrollTarget = null;
        return;
      }
      const midpoint = getTouchMidpoint(e.touches);
      if (!midpoint) return;
      e.preventDefault();
      lastTouchScrollAtRef.current = Date.now();

      // ── Track velocity for momentum ──
      const now = performance.now();
      const dt = now - lastVelocityTime;
      if (dt > 0 && lastVelocityTime > 0) {
        // Instantaneous velocity (px/ms) — finger moved from last pos to current
        const instantVX = (midpoint.x - lastVelocityX) / dt;
        const instantVY = (midpoint.y - lastVelocityY) / dt;
        // Exponential moving average smooths jitter; α=0.3 responds quickly
        const alpha = 0.3;
        velocityX = velocityX * (1 - alpha) + instantVX * alpha;
        velocityY = velocityY * (1 - alpha) + instantVY * alpha;
      }
      lastVelocityTime = now;
      lastVelocityX = midpoint.x;
      lastVelocityY = midpoint.y;
      // ── End velocity tracking ──

      accumulatedDeltaX += touchStartX - midpoint.x;
      accumulatedDeltaY += touchStartY - midpoint.y;
      touchStartX = midpoint.x;
      touchStartY = midpoint.y;

      if (!pendingRaf) {
        pendingRaf = requestAnimationFrame(applyScroll);
      }
    };

    const onTouchEnd = () => {
      touchActive = false;
      touchScrollingRef.current = false;
      lastTouchScrollAtRef.current = Date.now();
      if (pendingRaf) {
        cancelAnimationFrame(pendingRaf);
        pendingRaf = null;
      }
      // Flush any leftover deltas
      if (accumulatedDeltaX !== 0 || accumulatedDeltaY !== 0) {
        touchScrollTarget?.scrollBy({ left: accumulatedDeltaX, top: accumulatedDeltaY, behavior: 'auto' });
        accumulatedDeltaX = 0;
        accumulatedDeltaY = 0;
      }

      // ── Launch momentum on release ──
      // velocityX/Y tracks finger movement direction (px/ms).
      // Our scroll deltas are (start - midpoint), i.e. scroll = -fingerMovement.
      // Negate so momentum continues scrolling in the same direction as the gesture.
      // On iOS, amplify initial velocity so the coasting feels more responsive.
      const iosBoost = isIOSDevice ? 1.5 : 1.0;
      const speed = Math.sqrt(velocityX * velocityX + velocityY * velocityY);
      if (speed > 0.05 && touchScrollTarget && displayModeRef.current === 'scrolling') {
        startMomentum(-velocityX * iosBoost, -velocityY * iosBoost, touchScrollTarget);
      }
      // ── End momentum ──

      // Reset trackers
      velocityX = 0;
      velocityY = 0;
      lastVelocityTime = 0;

      touchScrollTarget = null;
    };

    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: true });
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      if (pendingRaf) {
        cancelAnimationFrame(pendingRaf);
        pendingRaf = null;
      }
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [displayMode, getScrollTargetForGesture, tool, cancelMomentum, startMomentum]);

  // Re-trigger canvas redraw when thumbnail images finish loading
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onImageLoad = (e) => {
      const img = e.target;
      if (img.tagName === 'IMG' && img.hasAttribute('data-page')) {
        setRedrawTick((t) => t + 1);
      }
    };
    stage.addEventListener('load', onImageLoad, true); // capture phase
    return () => stage.removeEventListener('load', onImageLoad, true);
  }, []);

  // Close annotation tools when entering thumbnails mode
  // Default zoom to 25% for thumbnails, restore to 100% when leaving
  useEffect(() => {
    if (displayMode === 'thumbnails') {
      setTool('hand');
      setZoomLevel((prev) => {
        // Clamp to 100% max for thumbnails; default to 25% if at pagination default
        const clamped = Math.min(prev, 1.0);
        if (clamped >= 0.95 && clamped <= 1.05) return 0.25;
        return clamped;
      });
    } else {
      setZoomLevel((prev) => {
        // Clamp to 200% max for pagination/scrolling; restore 100% if at thumbnail default
        const clamped = Math.min(prev, 2.0);
        if (Math.abs(clamped - 0.25) < 0.01) return 1.0;
        return clamped;
      });
    }
  }, [displayMode]);

  // Scroll page containers to top when page changes in pagination mode
  useEffect(() => {
    if (displayMode !== 'pagination') return;
    const stage = stageRef.current;
    if (!stage) return;
    requestAnimationFrame(() => {
      const pages = stage.querySelectorAll('.pdf-single-page');
      pages.forEach((el) => {
        el.scrollTo({ top: 0, behavior: 'instant' });
      });
    });
  }, [selectedPage, displayMode]);

  // Scroll content to top when book or section changes (all display modes)
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    requestAnimationFrame(() => {
      // Scroll all possible content containers regardless of current mode
      const selectors = ['.pdf-scroll-pages', '.pdf-single-page', '.thumbnail-grid'];
      selectors.forEach((sel) => {
        stage.querySelectorAll(sel).forEach((el) => {
          el.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        });
      });
    });
  }, [selectedChapter, selectedFile]);

  // Track mousedown on stage (outside textarea) to flag reposition intent
  useEffect(() => {
    const onMouseDown = (e) => {
      const stage = stageRef.current;
      const textarea = textInputRef.current;
      if (stage && stage.contains(e.target) && !(textarea && textarea.contains(e.target))) {
        textInputBlurFlagRef.current = true;
      }
    };
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, []);

  const changePage = (direction) => {
    const page = selectedPageRef.current;
    const file = selectedFileRef.current;
    const chapter = currentChapterRef.current;
    const maxPage = maxNavigablePageRef.current;
    if (direction > 0) {
      // ── Going forward ──────────────────────────────────
      if (page >= maxPage) {
        // At last page of current section → try next section
        if (chapter?.contents?.length) {
          const sections = chapter.contents.map((item) => toFileId(item.page ?? item.section));
          const currentIndex = sections.findIndex((p) => String(p) === String(file));
          if (currentIndex >= 0 && currentIndex < sections.length - 1) {
            setSelectedFile(sections[currentIndex + 1]);
            setSelectedPage(1);
            return;
          }
        }
        // At last section of current book → try first section of next book
        if (structure?.length) {
          const selCh = selectedChapterRef.current;
          const bookIndex = structure.findIndex((ch) => ch.id === selCh);
          if (bookIndex >= 0 && bookIndex < structure.length - 1) {
            const nextBook = structure[bookIndex + 1];
            const nextSections = (nextBook?.contents || []).map((item) => toFileId(item.page ?? item.section));
            if (nextSections.length > 0) {
              setSelectedChapter(nextBook.id);
              setSelectedFile(nextSections[0]);
              setSelectedPage(1);
              return;
            }
          }
        }
        return; // nowhere to go
      }
    } else {
      // ── Going backward ─────────────────────────────────
      if (page <= 1) {
        // At first page of current section → try previous section
        if (chapter?.contents?.length) {
          const sections = chapter.contents.map((item) => toFileId(item.page ?? item.section));
          const currentIndex = sections.findIndex((p) => String(p) === String(file));
          if (currentIndex > 0) {
            // Navigate to previous section; setSelectedPage to MAX so the
            // clamping effect (see below) will cap it to the actual last page.
            setSelectedFile(sections[currentIndex - 1]);
            setSelectedPage(Number.MAX_SAFE_INTEGER);
            return;
          }
        }
        // At first section of current book → try last section of previous book
        if (structure?.length) {
          const selCh = selectedChapterRef.current;
          const bookIndex = structure.findIndex((ch) => ch.id === selCh);
          if (bookIndex > 0) {
            const prevBook = structure[bookIndex - 1];
            const prevSections = (prevBook?.contents || []).map((item) => toFileId(item.page ?? item.section));
            if (prevSections.length > 0) {
              setSelectedChapter(prevBook.id);
              setSelectedFile(prevSections[prevSections.length - 1]);
              setSelectedPage(Number.MAX_SAFE_INTEGER);
              return;
            }
          }
        }
        return; // nowhere to go
      }
    }

    // ── Normal page change within current section ─────────
    setSelectedPage((current) => {
      const next = current + direction;
      if (!Number.isFinite(maxPage)) {
        return Math.max(1, next);
      }
      return Math.max(1, Math.min(maxPage, next));
    });
  };

  const moveSection = (direction) => {
    const chapter = currentChapterRef.current;
    const file = selectedFileRef.current;
    if (!chapter?.contents?.length) return;
    const sections = chapter.contents.map((item) => toFileId(item.page ?? item.section));
    const currentIndex = sections.findIndex((p) => String(p) === String(file));
    if (currentIndex < 0) return;
    const nextIndex = currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < sections.length) {
      // Within current book — move to adjacent section
      setSelectedFile(sections[nextIndex]);
      setSelectedPage(1);
    } else {
      // At book boundary — fall through to cross-book navigation
      moveBook(direction);
    }
  };

  const moveBook = (direction) => {
    if (!structure?.length) return;
    const selCh = selectedChapterRef.current;
    const currentIndex = structure.findIndex((ch) => ch.id === selCh);
    if (currentIndex < 0) return;
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= structure.length) return; // no more books
    const nextBook = structure[nextIndex];
    if (!nextBook) return;
    const sections = (nextBook?.contents || []).map((item) => toFileId(item.page ?? item.section));
    if (!sections.length) return;
    if (direction > 0) {
      // Going forward → first section, first page
      setSelectedChapter(nextBook.id);
      setSelectedFile(sections[0]);
      setSelectedPage(1);
    } else {
      // Going backward → last section, last page
      setSelectedChapter(nextBook.id);
      setSelectedFile(sections[sections.length - 1]);
      setSelectedPage(Number.MAX_SAFE_INTEGER);
    }
  };

  const changePageSeamless = (direction) => {
    if (direction < 0 && selectedPage <= 1) {
      // First page → go to last page of previous section
      if (!currentChapter?.contents?.length) return;
      const sections = currentChapter.contents.map((item) => toFileId(item.page ?? item.section));
      const currentIndex = sections.findIndex((page) => String(page) === String(selectedFile));
      if (currentIndex <= 0) return;
      setSelectedFile(sections[currentIndex - 1]);
      setSelectedPage(Number.MAX_SAFE_INTEGER); // clamped to actual max by useEffect
    } else if (direction > 0 && selectedPage >= maxNavigablePage) {
      // Last page → go to first page of next section
      if (!currentChapter?.contents?.length) return;
      const sections = currentChapter.contents.map((item) => toFileId(item.page ?? item.section));
      const currentIndex = sections.findIndex((page) => String(page) === String(selectedFile));
      if (currentIndex < 0 || currentIndex >= sections.length - 1) return;
      setSelectedFile(sections[currentIndex + 1]);
      setSelectedPage(1);
    } else {
      changePage(direction);
    }
  };

  const jumpPage = (direction) => {
    if (displayMode === 'thumbnails') {
      changePageSeamless(direction);
      return;
    }
    changePage(direction);
    if (displayMode === 'scrolling') {
      setJumpNotice(direction > 0 ? _('jumpNextPage') : _('jumpPrevPage'));
    }
  };

  const jumpSection = (direction) => {
    moveSection(direction);
    if (displayMode === 'scrolling') {
      setJumpNotice(direction > 0 ? _('jumpNextSection') : _('jumpPrevSection'));
    }
  };

  useEffect(() => {
    if (!jumpNotice) return undefined;
    const timer = window.setTimeout(() => setJumpNotice(''), 900);
    return () => window.clearTimeout(timer);
  }, [jumpNotice]);

  const changeZoom = (delta) => {
    setFitMode('none'); // release fit-width / fit-height so zoom works standalone
    setZoomLevel((current) => {
      const next = current + delta;
      return Math.min(5, Math.max(0.1, Number(next.toFixed(2))));
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
      const rawFirstPage = firstSection ? (firstSection.page ?? firstSection.section) : 1;

      // Determine if the next book uses "one PDF for all sections" mode.
      const catalog = physicsChapterCatalogRef.current || {};
      const nextBookMeta = (selectedBook === 'physics-oup' && nextBook?.id)
        ? (catalog[String(nextBook.id).toLowerCase()] || null)
        : null;
      const nextIsOnePdf = Boolean(nextBookMeta?.['one-pdf-for-all-section']);

      const firstPage = nextIsOnePdf ? String(rawFirstPage ?? '') : Number(rawFirstPage);
      setSelectedFile(firstPage);
      setSelectedPage(1);
    }
  };

  const cycleDisplayMode = () => {
    const modes = ['scrolling', 'pagination', 'thumbnails'];
    const idx = modes.indexOf(displayMode);
    setDisplayMode(modes[(idx + 1) % modes.length]);
  };

  const cycleLanguage = () => {
    const order = ['bilingual', 'en', 'tc'];
    const index = order.indexOf(selectedLanguage);
    const next = order[(index + 1) % order.length];
    setSelectedLanguage(next);
  };

  // Refs for collapsed sidebar buttons – used to position the autocomplete dropdowns
  const collapsedBtnRefs = useRef({ subject: null, book: null, section: null, page: null, language: null, displayMode: null });
  const subjectBtnTextRef = useRef(null);
  const [collapsedDropdownId, setCollapsedDropdownId] = useState(null);
  const [collapsedDropdownPos, setCollapsedDropdownPos] = useState({ top: 0, left: 0 });
  const [pressedAutocompleteBtn, setPressedAutocompleteBtn] = useState(null);
  const openAutocompleteTimerRef = useRef(null);

  // Debug: log subject button dimensions on change
  useEffect(() => {
    const el = subjectBtnTextRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const parentRect = el.parentElement?.getBoundingClientRect();
    const cs = getComputedStyle(el);
    console.log('[subjectBtn] rendered', {
      text: el.textContent,
      width: rect.width,
      height: rect.height,
      parentWidth: parentRect?.width,
      fontSize: cs.fontSize,
      maxWidth: cs.maxWidth,
      overflow: cs.overflow,
      textOverflow: cs.textOverflow,
      whiteSpace: cs.whiteSpace,
    });
  }, [selectedBook, selectedLanguage]);

  const openSidebarAutocomplete = useCallback((autocompleteId) => {
    // Toggle: if the same dropdown is already open, close it
    if (collapsedDropdownId === autocompleteId) {
      setCollapsedDropdownId(null);
      return;
    }
    // Clear any pending timer
    if (openAutocompleteTimerRef.current) {
      clearTimeout(openAutocompleteTimerRef.current);
    }
    // Show immediate visual feedback
    setPressedAutocompleteBtn(autocompleteId);
    // After a short delay, execute the lengthy operation
    openAutocompleteTimerRef.current = setTimeout(() => {
      openAutocompleteTimerRef.current = null;
      setPressedAutocompleteBtn(null);
      const btn = collapsedBtnRefs.current[autocompleteId];
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      setCollapsedDropdownPos({ top: rect.top, left: rect.right + 8 });
      setCollapsedDropdownId(autocompleteId);
      // After render, trigger the toggle button via mousedown
      requestAnimationFrame(() => {
        const container = document.querySelector(`[data-collapsed-autocomplete="${autocompleteId}"]`);
        if (!container) return;
        const toggleBtn = container.querySelector('.autocomplete-toggle-btn');
        if (toggleBtn instanceof HTMLElement) {
          toggleBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        }
      });
    }, 100);
  }, [collapsedDropdownId]);

  // Escape key closes the collapsed autocomplete dropdown
  useEffect(() => {
    if (!collapsedDropdownId) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setCollapsedDropdownId(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [collapsedDropdownId]);

  // Close collapsed autocomplete dropdown when sidebar is expanded,
  // otherwise the portal dropdown and the full sidebar selector both appear.
  useEffect(() => {
    if (!sidebarCollapsed) {
      setCollapsedDropdownId(null);
    }
  }, [sidebarCollapsed]);

  // Clear pressed state when dropdown closes
  useEffect(() => {
    if (!collapsedDropdownId) {
      setPressedAutocompleteBtn(null);
      if (openAutocompleteTimerRef.current) {
        clearTimeout(openAutocompleteTimerRef.current);
        openAutocompleteTimerRef.current = null;
      }
    }
  }, [collapsedDropdownId]);

  const openResource = (resource) => {
    // MP3 files use a floating draggable player instead of modal
    if (/\.mp3(\?|$)/i.test(resource.url)) {
      setFloatingPlayer({ url: resource.url, name: resource.name });
      return;
    }
    // HTML pages open in external tab
    if (/\.html?(\?|$|#)/i.test(resource.url)) {
      window.open(resource.url, '_blank', 'noopener,noreferrer');
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
    const savedRemark = {
      ...remark,
      page: remark.page || selectedPage,
      langId: remark.langId || annotationScopeLangId,
    };

    // Optimistic: add to local remarks immediately so the stroke/annotation
    // appears instantly even if the backend is slow.  Scrolling no longer
    // makes the stroke disappear while we wait for the server.
    const optimistic = { ...savedRemark, chapter: savedRemark.chapter || selectedChapter, _optimistic: true };
    setRemarks((prev) => [...prev, optimistic]);

    try {
      const data = await fetchJson('api/remarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          subjectId: selectedBook,
          bookId: selectedChapter,
          sectionId: selectedFile,
          pageId: savedRemark.page,
          langId: savedRemark.langId,
          ...savedRemark,
        })
      });
      setUndoStack((prev) => [...prev, { type: 'add', remark: savedRemark }]);
      setRedoStack([]);
      if (sectionScopedAnnotations) {
        await loadRemarksForCurrentScope();
        return;
      }
      setRemarks(data.remarks || []);
    } catch (err) {
      // Rollback: remove the optimistic remark on failure
      setRemarks((prev) => prev.filter((r) => !(r._optimistic && r.createdAt === savedRemark.createdAt)));
      throw err;
    }
  };

  const clearPageRemarks = async () => {
    const targetPage = Math.max(1, Number(selectedPageRef.current || selectedPage || 1));
    // Save current page remarks for undo before deleting
    const currentPageRemarks = remarks.filter(
      (r) => r.chapter === selectedChapter
        && Number(r.page) === targetPage
    );
    const data = await fetchJson(
      `api/remarks?userId=${encodeURIComponent(userId)}&subjectId=${encodeURIComponent(selectedBook)}&bookId=${encodeURIComponent(selectedChapter)}&sectionId=${selectedFile}&pageId=${targetPage}`,
      { method: 'DELETE' }
    );
    if (sectionScopedAnnotations) {
      await loadRemarksForCurrentScope();
    } else {
      setRemarks(data.remarks || []);
    }
    if (currentPageRemarks.length > 0) {
      setUndoStack((prev) => [...prev, { type: 'erasePage', remarks: currentPageRemarks }]);
      setRedoStack([]);
    }
  };

  const clearAllRemarks = async () => {
    // Save current book remarks for undo before deleting
    const currentBookRemarks = remarks.filter(
      (r) => r.chapter === selectedChapter
    );
    const data = await fetchJson(
      `api/remarks?userId=${encodeURIComponent(userId)}&subjectId=${encodeURIComponent(selectedBook)}&bookId=${encodeURIComponent(selectedChapter)}&sectionId=${selectedFile}`,
      { method: 'DELETE' }
    );
    setRemarks(data.remarks || []);
    if (currentBookRemarks.length > 0) {
      setUndoStack((prev) => [...prev, { type: 'eraseBook', remarks: currentBookRemarks }]);
      setRedoStack([]);
    }
  };

  const openEraseDialog = async () => {
    if (typeof window === 'undefined') return;

    const result = await Swal.fire({
      icon: 'warning',
      text: _('confirmEraseBook'),
      showCancelButton: true,
      showDenyButton: true,
      confirmButtonText: _('erasePage'),
      denyButtonText: _('eraseBook'),
      cancelButtonText: _('cancel'),
      reverseButtons: false,
      focusCancel: true,
    });

    if (result.isConfirmed) {
      await clearPageRemarks();
      return;
    }

    if (result.isDenied) {
      await clearAllRemarks();
    }
  };

  const deleteRemarkByCreatedAt = async (createdAtValue, langId = annotationScopeLangId, pageIdOverrideOrOptions) => {
    const options = (pageIdOverrideOrOptions && typeof pageIdOverrideOrOptions === 'object' && !Array.isArray(pageIdOverrideOrOptions))
      ? pageIdOverrideOrOptions
      : { pageIdOverride: pageIdOverrideOrOptions };
    const resolvedPageId = options.pageIdOverride != null ? options.pageIdOverride : selectedPage;

    // Optimistic: remove from local remarks immediately so the erased stroke
    // disappears instantly even while the backend is processing.
    const removed = remarks.find(
      (r) => r.createdAt === createdAtValue && r.langId === langId
    ) || options.deletedRemark || null;
    if (removed) {
      setRemarks((prev) => prev.filter(
        (r) => !(r.createdAt === createdAtValue && r.langId === langId)
      ));
    }

    try {
      const data = await fetchJson(
        `api/remarks?userId=${encodeURIComponent(userId)}&subjectId=${encodeURIComponent(selectedBook)}&bookId=${encodeURIComponent(selectedChapter)}&sectionId=${selectedFile}&pageId=${resolvedPageId}&langId=${encodeURIComponent(langId)}&createdAt=${encodeURIComponent(createdAtValue)}`,
        { method: 'DELETE' }
      );
      if (options.recordUndo && removed) {
        setUndoStack((prev) => [...prev, { type: 'delete', remark: removed }]);
        setRedoStack([]);
      }
      if (sectionScopedAnnotations) {
        return loadRemarksForCurrentScope();
      }
      setRemarks(data.remarks || []);
      return data.remarks || [];
    } catch (err) {
      // Rollback: restore the removed remark if the server call fails
      if (removed) {
        setRemarks((prev) => {
          if (prev.some((r) => r.createdAt === removed.createdAt && r.langId === removed.langId)) return prev;
          return [...prev, removed];
        });
      }
      throw err;
    }
  };

  const undoRemark = async () => {
    // If there are actions on the undo stack, reverse the last one
    if (undoStack.length > 0) {
      const action = undoStack[undoStack.length - 1];

      if (action.type === 'add') {
        await deleteRemarkByCreatedAt(action.remark.createdAt, action.remark.langId || annotationScopeLangId, action.remark.page || selectedPage);
        setUndoStack((prev) => prev.slice(0, -1));
        setRedoStack((prev) => [...prev, action]);
        return;
      }

      if (action.type === 'delete') {
        // Re-add a deleted remark
        const data = await fetchJson('api/remarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId,
            subjectId: selectedBook,
            bookId: selectedChapter,
            sectionId: selectedFile,
            pageId: selectedPage,
            langId: action.remark.langId || annotationScopeLangId,
            ...action.remark,
          })
        });
        if (sectionScopedAnnotations) {
          await loadRemarksForCurrentScope();
        } else {
          setRemarks(data.remarks || []);
        }
        setUndoStack((prev) => prev.slice(0, -1));
        setRedoStack((prev) => [...prev, action]);
        return;
      }

      if (action.type === 'erasePage' || action.type === 'eraseBook') {
        // Re-add all erased remarks
        for (const r of action.remarks) {
          await fetchJson('api/remarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId,
              subjectId: selectedBook,
              bookId: selectedChapter,
              sectionId: selectedFile,
              pageId: r.page || selectedPage,
              langId: r.langId || annotationScopeLangId,
              ...r,
            })
          });
        }
        await loadRemarksForCurrentScope();
        setUndoStack((prev) => prev.slice(0, -1));
        setRedoStack((prev) => [...prev, action]);
        return;
      }
    }

    // No undo stack — undo the last individual remark on current page
    const pageRemarks = remarks.filter(
      (r) => r.chapter === selectedChapter
        && Number(r.page) === Number(selectedPage)
        && (r.langId === annotationScopeLangId || (!r.langId && annotationScopeLangId === 'en'))
    );
    if (!pageRemarks.length) return;
    const last = pageRemarks[pageRemarks.length - 1];
    await deleteRemarkByCreatedAt(last.createdAt, last.langId || annotationScopeLangId);
    setUndoStack((prev) => [...prev, { type: 'delete', remark: last }]);
    setRedoStack([{ type: 'delete', remark: last }]);
  };

  const redoRemark = async () => {
    if (!redoStack.length) return;
    const action = redoStack[redoStack.length - 1];

    if (action.type === 'add') {
      const data = await fetchJson('api/remarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          subjectId: selectedBook,
          bookId: selectedChapter,
          sectionId: selectedFile,
          pageId: action.remark.page || selectedPage,
          langId: action.remark.langId || annotationScopeLangId,
          ...action.remark,
        })
      });
      if (sectionScopedAnnotations) {
        await loadRemarksForCurrentScope();
      } else {
        setRemarks(data.remarks || []);
      }
      setUndoStack((prev) => [...prev, action]);
      setRedoStack((prev) => prev.slice(0, -1));
      return;
    }

    if (action.type === 'delete') {
      // Re-delete the remark
      await deleteRemarkByCreatedAt(action.remark.createdAt, action.remark.langId || annotationScopeLangId);
      setUndoStack((prev) => [...prev, action]);
      setRedoStack((prev) => prev.slice(0, -1));
      return;
    }

    if (action.type === 'erasePage' || action.type === 'eraseBook') {
      // Re-erase all remarks
      for (const r of action.remarks) {
        await fetchJson(
          `api/remarks?userId=${encodeURIComponent(userId)}&subjectId=${encodeURIComponent(selectedBook)}&bookId=${encodeURIComponent(selectedChapter)}&sectionId=${selectedFile}&pageId=${r.page || selectedPage}&langId=${encodeURIComponent(r.langId || annotationScopeLangId)}&createdAt=${encodeURIComponent(r.createdAt)}`,
          { method: 'DELETE' }
        );
      }
      await loadRemarksForCurrentScope();
      setUndoStack((prev) => [...prev, action]);
      setRedoStack((prev) => prev.slice(0, -1));
      return;
    }
  };

  /**
   * Get the bounding rect (relative to the annotation canvas) of the
   * rendered page IMAGE (canvas or img) inside each language pane.
   *
   * This is the authoritative source for coordinate normalization —
   * the page image dimensions stay proportional to the PDF page
   * regardless of container size / header height / layout mode.
   */
  const getPageImageRects = useCallback(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return {};
    const canvasRect = canvas.getBoundingClientRect();
    const panes = stage.querySelectorAll('[data-annotation-language]');
    const isScrolling = displayModeRef.current === 'scrolling';
    const result = {};

    for (const pane of panes) {
      const langId = pane.getAttribute('data-annotation-language');
      if (!langId) continue;

      // Pagination mode: the single rendered page inside .pdf-single-page
      let pageImage = pane.querySelector('.pdf-single-page canvas, .pdf-single-page img.page-img');

      if (!pageImage) {
        // Scrolling mode: collect ALL page canvases/images, keyed by langId-pageNum
        const candidates = pane.querySelectorAll('canvas[data-page], img[data-page]');
        if (candidates.length > 1 && isScrolling) {
          for (const el of candidates) {
            const elPage = Number(el.getAttribute('data-page'));
            if (!elPage) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              result[`${langId}-${elPage}`] = {
                left: r.left - canvasRect.left,
                top: r.top - canvasRect.top,
                width: r.width,
                height: r.height,
              };
            }
          }
          continue; // handled all scrolling candidates for this pane
        }

        // Fallback: find the image matching the current selected page (pagination or edge case)
        const currentPage = selectedPageRef.current;
        for (const el of candidates) {
          const elPage = Number(el.getAttribute('data-page'));
          if (elPage === currentPage) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              pageImage = el;
              break;
            }
          }
        }
        // Last-resort fallback: first visible image
        if (!pageImage) {
          for (const el of candidates) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              pageImage = el;
              break;
            }
          }
        }
      }
      // Thumbnail mode: active thumbnail image
      if (!pageImage) {
        const activeThumb = pane.querySelector('.thumb-grid-item.active img');
        if (activeThumb) {
          const r = activeThumb.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            pageImage = activeThumb;
          }
        }
      }
      // Fallback: the content area div (excludes header), never the full pane
      if (!pageImage) {
        pageImage = pane.querySelector('.pdf-content');
      }

      if (!pageImage) continue;

      const rect = pageImage.getBoundingClientRect();
      result[langId] = {
        left: rect.left - canvasRect.left,
        top: rect.top - canvasRect.top,
        width: rect.width,
        height: rect.height,
      };
    }
    return result;
  }, []);

  /**
   * In thumbnails mode, get rects for ALL thumbnail images keyed by "langId-pageNum".
   */
  const getAllThumbnailRects = useCallback(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return {};
    const canvasRect = canvas.getBoundingClientRect();
    const panes = stage.querySelectorAll('[data-annotation-language]');
    const result = {};
    for (const pane of panes) {
      const langId = pane.getAttribute('data-annotation-language');
      if (!langId) continue;
      const thumbImgs = pane.querySelectorAll('.thumb-grid-item img[data-page]');
      for (const img of thumbImgs) {
        const page = Number(img.getAttribute('data-page'));
        if (!page) continue;
        const r = img.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          result[`${langId}-${page}`] = {
            left: r.left - canvasRect.left,
            top: r.top - canvasRect.top,
            width: r.width,
            height: r.height,
          };
        }
      }
    }
    return result;
  }, []);

  /**
   * Convert annotation page-image-relative pixel coordinates to percentages
   * relative to the page image size (image width/height).
   * Stores a coordsNormalized flag so the renderer knows to denormalize.
   */
  const normalizeAnnotationCoords = useCallback((annotation, imageRect) => {
    if (!imageRect || !imageRect.width || !imageRect.height) return annotation;
    const normalized = { ...annotation, coordsNormalized: true };
    if (annotation.type === 'stroke' && Array.isArray(annotation.points)) {
      normalized.points = annotation.points.map((p) => ({
        x: (p.x / imageRect.width) * 100,
        y: (p.y / imageRect.height) * 100,
      }));
    }
    if (annotation.type === 'text') {
      normalized.x = (annotation.x / imageRect.width) * 100;
      normalized.y = (annotation.y / imageRect.height) * 100;
    }
    return normalized;
  }, []);

  /**
   * Convert stored percentage coordinates back to page-image-relative pixel
   * coordinates based on the current image dimensions.
   * Returns a new object (does not mutate the original).
   */
  const denormalizeAnnotationCoords = useCallback((annotation, imageRect) => {
    if (!annotation.coordsNormalized || !imageRect || !imageRect.width || !imageRect.height) {
      return annotation;
    }
    const denorm = { ...annotation };
    delete denorm.coordsNormalized;
    if (annotation.type === 'stroke' && Array.isArray(annotation.points)) {
      denorm.points = annotation.points.map((p) => ({
        x: (p.x / 100) * imageRect.width,
        y: (p.y / 100) * imageRect.height,
      }));
    }
    if (annotation.type === 'text') {
      denorm.x = (annotation.x / 100) * imageRect.width;
      denorm.y = (annotation.y / 100) * imageRect.height;
    }
    return denorm;
  }, []);

  const resolveAnnotationTarget = useCallback((event) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const canvasPoint = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
    const pageImageRects = getPageImageRects();
    const isScrollMode = displayModeRef.current === 'scrolling';

    if (isScrollMode) {
      // In scrolling mode, rects are keyed by "langId-pageNum"
      for (const langId of visibleLanguages) {
        // Check all page rects for this language; find the one containing the click
        for (const [key, imageRect] of Object.entries(pageImageRects)) {
          if (!key.startsWith(langId + '-')) continue;
          if (canvasPoint.x >= imageRect.left
            && canvasPoint.x <= imageRect.left + imageRect.width
            && canvasPoint.y >= imageRect.top
            && canvasPoint.y <= imageRect.top + imageRect.height) {
            return {
              langId,
              point: {
                x: canvasPoint.x - imageRect.left,
                y: canvasPoint.y - imageRect.top
              },
              imageRect: { width: imageRect.width, height: imageRect.height },
              pageNum: Number(key.split('-')[1]),
            };
          }
        }
      }
      return null;
    }

    // Pagination / thumbnails mode: rects are keyed by langId
    const langId = visibleLanguages.find((language) => {
      const imageRect = pageImageRects[language];
      return imageRect
        && canvasPoint.x >= imageRect.left
        && canvasPoint.x <= imageRect.left + imageRect.width
        && canvasPoint.y >= imageRect.top
        && canvasPoint.y <= imageRect.top + imageRect.height;
    });
    if (!langId) {
      // console.log('[draw] resolveAnnotationTarget — no langId matched. pageImageRects:', JSON.stringify(Object.keys(pageImageRects)), 'canvasPoint:', canvasPoint, 'visibleLanguages:', visibleLanguages);
      return null;
    }
    const imageRect = pageImageRects[langId];
    return {
      langId,
      // Coordinates relative to the page image top-left corner
      point: {
        x: canvasPoint.x - imageRect.left,
        y: canvasPoint.y - imageRect.top
      },
      // Page image dimensions for percentage normalization
      imageRect: { width: imageRect.width, height: imageRect.height },
    };
  }, [getPageImageRects, visibleLanguages]);

  const redraw = useCallback((context, width, height, annotations) => {
    if (!context) return;
    context.clearRect(0, 0, width, height);

    const isThumbMode = displayModeRef.current === 'thumbnails';
    const isScrollMode = displayModeRef.current === 'scrolling';

    if (isThumbMode) {
      // Thumbnails mode: draw each page's annotations on its own thumbnail
      const thumbRects = getAllThumbnailRects();
      for (const annotation of annotations) {
        const langId = annotation.langId === 'tc' ? 'tc' : 'en';
        const page = Number(annotation.page);
        const key = `${langId}-${page}`;
        const imageRect = thumbRects[key];
        if (!imageRect) continue;

        context.save();
        context.beginPath();
        context.rect(imageRect.left, imageRect.top, imageRect.width, imageRect.height);
        context.clip();

        const denorm = annotation.coordsNormalized
          ? denormalizeAnnotationCoords(annotation, imageRect)
          : annotation;

        if (denorm.type === 'stroke') {
          const points = denorm.points || [];
          if (points.length < 2) { context.restore(); continue; }
          context.save();
          context.lineJoin = 'round';
          context.lineCap = 'round';
          context.strokeStyle = denorm.color;
          context.globalAlpha = denorm.mode === 'highlight' ? 0.28 : 1;
          const strokeScale = Math.max(0.2, imageRect.width / 800);
          context.lineWidth = (denorm.mode === 'highlight' ? 18 : 4) * strokeScale;
          context.beginPath();
          context.moveTo(imageRect.left + points[0].x, imageRect.top + points[0].y);
          for (const point of points.slice(1)) {
            context.lineTo(imageRect.left + point.x, imageRect.top + point.y);
          }
          context.stroke();
          context.restore();
        }

        if (denorm.type === 'text') {
          context.save();
          context.fillStyle = denorm.color;
          const fontSize = Math.max(1, Math.round(18 * (imageRect.width / 800)));
          context.font = `${fontSize}px Inter, system-ui, sans-serif`;
          context.fillText(denorm.text, imageRect.left + denorm.x, imageRect.top + denorm.y);
          context.restore();
        }

        context.restore();
      }
      return;
    }

    if (isScrollMode) {
      // Scrolling mode: draw each page's annotations on its own page canvas
      const pageRects = getPageImageRects();
      for (const annotation of annotations) {
        const langId = annotation.langId === 'tc' ? 'tc' : 'en';
        const page = Number(annotation.page);
        const key = `${langId}-${page}`;
        const imageRect = pageRects[key];
        if (!imageRect) continue;

        context.save();
        context.beginPath();
        context.rect(imageRect.left, imageRect.top, imageRect.width, imageRect.height);
        context.clip();

        const denorm = annotation.coordsNormalized
          ? denormalizeAnnotationCoords(annotation, imageRect)
          : annotation;

        if (denorm.type === 'stroke') {
          const points = denorm.points || [];
          if (points.length < 2) { context.restore(); continue; }
          context.save();
          context.lineJoin = 'round';
          context.lineCap = 'round';
          context.strokeStyle = denorm.color;
          context.globalAlpha = denorm.mode === 'highlight' ? 0.28 : 1;
          const strokeScale = Math.max(0.2, imageRect.width / 800);
          context.lineWidth = (denorm.mode === 'highlight' ? 18 : 4) * strokeScale;
          context.beginPath();
          context.moveTo(imageRect.left + points[0].x, imageRect.top + points[0].y);
          for (const point of points.slice(1)) {
            context.lineTo(imageRect.left + point.x, imageRect.top + point.y);
          }
          context.stroke();
          context.restore();
        }

        if (denorm.type === 'text') {
          context.save();
          context.fillStyle = denorm.color;
          const fontSize = Math.max(1, Math.round(18 * (imageRect.width / 800)));
          context.font = `${fontSize}px Inter, system-ui, sans-serif`;
          context.fillText(denorm.text, imageRect.left + denorm.x, imageRect.top + denorm.y);
          context.restore();
        }

        context.restore();
      }
      return;
    }

    // Pagination mode: draw annotations on the current page image
    const pageImageRects = getPageImageRects();
    for (const annotation of annotations) {
      const langId = annotation.langId === 'tc' ? 'tc' : 'en';
      const imageRect = pageImageRects[langId];
      if (!imageRect) continue;

      // Clip to the page image area so annotations don't bleed outside
      context.save();
      context.beginPath();
      context.rect(imageRect.left, imageRect.top, imageRect.width, imageRect.height);
      context.clip();

      // Denormalize if stored as percentages
      const denorm = annotation.coordsNormalized
        ? denormalizeAnnotationCoords(annotation, imageRect)
        : annotation;

      if (denorm.type === 'stroke') {
        const points = denorm.points || [];
        if (points.length < 2) { context.restore(); continue; }
        context.save();
        context.lineJoin = 'round';
        context.lineCap = 'round';
        context.strokeStyle = denorm.color;
        context.globalAlpha = denorm.mode === 'highlight' ? 0.28 : 1;
        const strokeScale = Math.max(0.2, imageRect.width / 800);
        context.lineWidth = (denorm.mode === 'highlight' ? 18 : 4) * strokeScale;
        context.beginPath();
        context.moveTo(imageRect.left + points[0].x, imageRect.top + points[0].y);
        for (const point of points.slice(1)) {
          context.lineTo(imageRect.left + point.x, imageRect.top + point.y);
        }
        context.stroke();
        context.restore();
      }

      if (denorm.type === 'text') {
        context.save();
        context.fillStyle = denorm.color;
        const fontSize = Math.max(1, Math.round(18 * (imageRect.width / 800)));
        context.font = `${fontSize}px Inter, system-ui, sans-serif`;
        context.fillText(denorm.text, imageRect.left + denorm.x, imageRect.top + denorm.y);
        context.restore();
      }

      context.restore(); // restore clip
    }
  }, [getPageImageRects, denormalizeAnnotationCoords, getAllThumbnailRects]);

  const pointToSegmentDistance = (point, start, end) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (dx === 0 && dy === 0) {
      return Math.hypot(point.x - start.x, point.y - start.y);
    }
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
    const projX = start.x + t * dx;
    const projY = start.y + t * dy;
    return Math.hypot(point.x - projX, point.y - projY);
  };

  const findAnnotationAtPoint = (langId, point, pageNumOverride) => {
    const searchPage = pageNumOverride != null ? pageNumOverride : selectedPage;
    const pageRemarks = remarks.filter(
      (r) => r.chapter === selectedChapter
        && Number(r.page) === Number(searchPage)
        && (r.langId === 'tc' ? 'tc' : 'en') === langId
    );
    // Get current page image rect for denormalizing stored percentage coords
    const pageImageRects = getPageImageRects();
    const isScrollMode = displayModeRef.current === 'scrolling';
    const rectKey = isScrollMode ? `${langId}-${searchPage}` : langId;
    const imageRect = pageImageRects[rectKey] || null;

    const ordered = [...pageRemarks].reverse();
    for (const annotation of ordered) {
      // Denormalize if stored as percentages, so we can compare against raw pixel point
      const denorm = (annotation.coordsNormalized && imageRect)
        ? denormalizeAnnotationCoords(annotation, imageRect)
        : annotation;

      if (denorm.type === 'text') {
        const text = String(denorm.text || '');
        const approxWidth = Math.max(24, text.length * 9);
        const approxHeight = 24;
        if (
          point.x >= denorm.x - 4 && point.x <= denorm.x + approxWidth &&
          point.y <= denorm.y + 4 && point.y >= denorm.y - approxHeight
        ) {
          return annotation;
        }
      }

      if (denorm.type === 'stroke') {
        const points = denorm.points || [];
        const tolerance = (denorm.mode === 'highlight' ? 18 : 4) / 2 + 8;
        for (let index = 1; index < points.length; index += 1) {
          if (pointToSegmentDistance(point, points[index - 1], points[index]) <= tolerance) {
            return annotation;
          }
        }
      }
    }
    return null;
  };

  const handlePointerDown = (event) => {
    // console.log('[draw] pointerdown — tool:', tool, 'pointerId:', event.pointerId, 'target:', event.target?.tagName, event.target?.className);
    if (tool !== 'pen' && tool !== 'highlight' && tool !== 'move') {
      // console.log('[draw] SKIP: tool not pen/highlight/move');
      return;
    }

    // Multi-touch: if another pointer is already down, cancel any in-progress
    // drawing and let both fingers scroll (don't draw).
    activePointersRef.current.add(event.pointerId);
    if (activePointersRef.current.size > 1) {
      // console.log('[draw] SKIP: multi-touch (' + activePointersRef.current.size + ' pointers)');
      // Cancel in-progress stroke
      if (drawingRef.current && currentStrokeRef.current) {
        drawingRef.current = false;
        currentStrokeRef.current = null;
      }
      return;
    }

    const target = resolveAnnotationTarget(event);
    if (!target) {
      // console.log('[draw] SKIP: resolveAnnotationTarget returned null');
      return;
    }
    // console.log('[draw] target found — langId:', target.langId, 'point:', target.point);
    setActiveAnnotationLangId(target.langId);

    if (tool === 'move') {
      const imageRect = target.imageRect;
      const existing = findAnnotationAtPoint(target.langId, target.point, target.pageNum);
      if (existing) {
        moveAnnotationRef.current = existing;
        moveStartPointRef.current = target.point;
        moveHasMovedRef.current = false;
      }
      return;
    }

    drawingRef.current = true;
    // console.log('[draw] drawingRef set to TRUE');
    // Prevent browser from interpreting this drag as a scroll
    event.preventDefault();
    currentStrokeRef.current = {
      type: 'stroke',
      chapter: selectedChapter,
      page: target.pageNum || selectedPage,
      langId: target.langId,
      mode: tool,
      color: textColor,
      points: [target.point],
      createdAt: hkNow()
    };
  };

  const handlePointerMove = (event) => {
    // Multi-touch: don't draw when multiple pointers are active
    if (activePointersRef.current.size > 1) return;

    // Handle move tool dragging
    if (moveAnnotationRef.current && moveStartPointRef.current) {
      const target = resolveAnnotationTarget(event);
      if (!target || target.langId !== moveAnnotationRef.current.langId) return;
      const dx = target.point.x - moveStartPointRef.current.x;
      const dy = target.point.y - moveStartPointRef.current.y;
      moveStartPointRef.current = target.point;
      moveHasMovedRef.current = true;

      const pageImageRects = getPageImageRects();
      const moveLangId = moveAnnotationRef.current.langId;
      const movePage = moveAnnotationRef.current.page;
      const rectKey = displayModeRef.current === 'scrolling' ? `${moveLangId}-${movePage}` : moveLangId;
      const imageRect = pageImageRects[rectKey];
      if (!imageRect) return;

      // Update the annotation in-place for live preview
      const moved = { ...moveAnnotationRef.current };
      if (moved.type === 'text') {
        // Denormalize first, apply delta, then re-normalize
        const denorm = (moved.coordsNormalized && imageRect)
          ? denormalizeAnnotationCoords(moved, imageRect)
          : moved;
        denorm.x = (denorm.x || 0) + dx;
        denorm.y = (denorm.y || 0) + dy;
        const renormalized = normalizeAnnotationCoords({ ...denorm, langId: moved.langId, type: 'text', text: moved.text, color: moved.color }, imageRect);
        moveAnnotationRef.current = { ...moved, ...renormalized, createdAt: moved.createdAt };
      } else if (moved.type === 'stroke' && Array.isArray(moved.points)) {
        const denorm = (moved.coordsNormalized && imageRect)
          ? denormalizeAnnotationCoords(moved, imageRect)
          : moved;
        denorm.points = (denorm.points || []).map((p) => ({ x: p.x + dx, y: p.y + dy }));
        const renormalized = normalizeAnnotationCoords({ ...denorm, langId: moved.langId, type: 'stroke', mode: moved.mode, color: moved.color, points: denorm.points }, imageRect);
        moveAnnotationRef.current = { ...moved, ...renormalized, createdAt: moved.createdAt };
      }

      // Redraw with the moved annotation
      const context = canvasRef.current?.getContext('2d');
      const rect = canvasRef.current?.getBoundingClientRect();
      if (context && rect) {
        const withoutMoved = pageAnnotations.filter((a) => a.createdAt !== moved.createdAt || a.langId !== moved.langId);
        redraw(context, rect.width, rect.height, [...withoutMoved, moveAnnotationRef.current]);
      }
      return;
    }

    // Handle drawing stroke
    if (!drawingRef.current || !currentStrokeRef.current) return;
    const target = resolveAnnotationTarget(event);
    if (!target || target.langId !== currentStrokeRef.current.langId || (target.pageNum || selectedPage) !== (currentStrokeRef.current.page || selectedPage)) {
      // Pointer is outside the page image or crossed language panes — skip this event
      // but keep the stroke alive (don't stop it). It will be saved on pointerup.
      if (!target) {
        // console.log('[draw] pointermove — resolveAnnotationTarget returned null');
      } else {
        // console.log('[draw] pointermove — langId/page mismatch: target=' + target.langId + '/' + target.pageNum + ' stroke=' + currentStrokeRef.current.langId + '/' + currentStrokeRef.current.page);
      }
      return;
    }
    const nextPoint = target.point;
    currentStrokeRef.current.points.push(nextPoint);
    // console.count('[draw] pointermove points');
    const context = canvasRef.current.getContext('2d');
    const rect = canvasRef.current.getBoundingClientRect();
    redraw(context, rect.width, rect.height, [...(displayMode === 'scrolling' ? allSectionAnnotations : pageAnnotations), currentStrokeRef.current]);
  };

  const handlePointerUp = async (event) => {
    // Clean up pointer tracking for multi-touch detection
    if (event?.pointerId != null) {
      activePointersRef.current.delete(event.pointerId);
    }

    // Handle move tool drop
    if (moveAnnotationRef.current) {
      const moved = moveAnnotationRef.current;
      moveAnnotationRef.current = null;
      moveStartPointRef.current = null;
      // Only save if the annotation was actually moved
      if (moveHasMovedRef.current) {
        moveHasMovedRef.current = false;
        // Delete old annotation and save moved version
        if (moved.createdAt) {
          await deleteRemarkByCreatedAt(moved.createdAt, moved.langId || annotationScopeLangId);
        }
        // Re-save with updated coordinates
        const remarkToSave = {
          type: moved.type,
          chapter: selectedChapter,
          page: selectedPage,
          langId: moved.langId,
          color: moved.color,
          text: moved.text,
          points: moved.points,
          mode: moved.mode,
          x: moved.x,
          y: moved.y,
          coordsNormalized: moved.coordsNormalized,
          createdAt: hkNow()
        };
        await saveRemark(remarkToSave);
      }
      return;
    }

    if (!drawingRef.current || !currentStrokeRef.current) return;
    drawingRef.current = false;
    const stroke = currentStrokeRef.current;
    currentStrokeRef.current = null;
    // console.log('[draw] pointerup — stroke points:', stroke.points.length);
    // Normalize coordinates to percentages relative to page image size
    const pageImageRects = getPageImageRects();
    const isScrollMode = displayModeRef.current === 'scrolling';
    const rectKey = isScrollMode ? `${stroke.langId}-${stroke.page || selectedPage}` : stroke.langId;
    const imageRect = pageImageRects[rectKey];
    const normalizedStroke = imageRect
      ? normalizeAnnotationCoords(stroke, imageRect)
      : stroke;
    await saveRemark(normalizedStroke);
  };

  // Native pointermove/pointerup listeners on the DOCUMENT to work around
  // browser quirks where pointer capture doesn't dispatch to the target element.
  useEffect(() => {
    const onNativeMove = (e) => {
      if (!drawingRef.current && !moveAnnotationRef.current) return;
      // console.count('[draw] document pointermove — drawing=' + drawingRef.current + ' move=' + !!moveAnnotationRef.current);
      handlePointerMove(e);
    };
    const onNativeUp = (e) => {
      if (!drawingRef.current && !moveAnnotationRef.current) return;
      // console.log('[draw] document pointerup — drawing=' + drawingRef.current);
      handlePointerUp(e);
    };

    document.addEventListener('pointermove', onNativeMove, true);
    document.addEventListener('pointerup', onNativeUp, true);
    document.addEventListener('pointercancel', onNativeUp, true);
    return () => {
      document.removeEventListener('pointermove', onNativeMove, true);
      document.removeEventListener('pointerup', onNativeUp, true);
      document.removeEventListener('pointercancel', onNativeUp, true);
    };
  }, [handlePointerMove, handlePointerUp]);

  const commitTextAnnotation = async () => {
    const el = textInputRef.current;
    const state = textInputState;
    if (!el || !state) return;
    const text = el.value.trim();
    if (!text) {
      textInputCommittedRef.current = true;
      setTextInputState(null);
      return;
    }
    // If editing an existing annotation, delete the old one first
    if (state.existingCreatedAt) {
      await deleteRemarkByCreatedAt(state.existingCreatedAt, state.existingLangId || state.langId, {
        recordUndo: true,
        deletedRemark: state.existingRemark,
      });
    }
    const remark = {
      type: 'text',
      chapter: selectedChapter,
      page: selectedPage,
      langId: state.langId,
      x: state.point.x,
      y: state.point.y,
      color: textColor,
      text,
      createdAt: hkNow()
    };
    const normalizedRemark = state.imageRect
      ? normalizeAnnotationCoords(remark, state.imageRect)
      : remark;
    textInputCommittedRef.current = true;
    await saveRemark(normalizedRemark);
    setTextInputState(null);
  };

  const cancelTextAnnotation = () => {
    textInputCommittedRef.current = true;
    setTextInputState(null);
  };

  // Cancel active text input when switching away from text tool
  useEffect(() => {
    if (tool !== 'text' && textInputState) {
      cancelTextAnnotation();
    }
  }, [tool]);

  // Cancel active text input when navigating away
  useEffect(() => {
    if (textInputState) {
      cancelTextAnnotation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChapter, selectedFile, selectedPage]);

  // Redraw annotations when scrolling (capture scroll events on the stage)
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let rafId = null;
    const scheduleRedraw = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext('2d');
        const rect = canvas.getBoundingClientRect();
        const annotationsToDraw = (displayMode === 'thumbnails' || displayMode === 'scrolling') ? allSectionAnnotations : pageAnnotations;
        redraw(context, rect.width, rect.height, annotationsToDraw);
      });
    };

    const scrollTargets = [
      stage,
      ...stage.querySelectorAll('.pdf-scroll-pages, .thumbnail-grid, .thumbnail-list, .pdf-single-page')
    ];

    for (const target of scrollTargets) {
      target.addEventListener('scroll', scheduleRedraw, { passive: true });
    }

    return () => {
      for (const target of scrollTargets) {
        target.removeEventListener('scroll', scheduleRedraw);
      }
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [pageAnnotations, allSectionAnnotations, displayMode, pageSources, redraw, visibleLanguages]);

  // ── QR code detection on click ─────────────────────────
  const handleStageClick = async (event) => {
    // Only scan for QR codes when the hand tool is active
    if (tool !== 'hand') return;

    // Don't scan if a text input is active
    if (textInputState) return;

    // Don't scan if clicking on a UI element
    if (event.target.closest('button, input, textarea, select, .annotation-textarea')) return;

    // Find the page image at the click position
    const pageImg = document.elementsFromPoint(event.clientX, event.clientY)
      .find(el => el.tagName === 'IMG' && el.classList.contains('page-img'));
    if (!pageImg) {
      if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] No page-img found at click position');
      return;
    }

    // Check that the image is fully loaded
    if (!pageImg.complete || pageImg.naturalWidth === 0) {
      if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] Page image not yet loaded');
      return;
    }

    // Compute click position in natural image coordinates
    const rect = pageImg.getBoundingClientRect();
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;
    const naturalW = pageImg.naturalWidth;
    const naturalH = pageImg.naturalHeight;
    const clickNX = (cssX / rect.width) * naturalW;
    const clickNY = (cssY / rect.height) * naturalH;

    // Show a visual marker at the click position (auto-hides after 3s)
    if (DEBUG_QRCODE_CAPTURE >= 1) {
      setClickMarker({ x: cssX, y: cssY, imgLeft: rect.left, imgTop: rect.top, naturalX: clickNX, naturalY: clickNY });
      clearTimeout(clickMarkerTimeoutRef.current);
      clickMarkerTimeoutRef.current = setTimeout(() => setClickMarker(null), 3000);
    }

    // ── Proportional crop: 15% of smaller image dimension, centered on click ──
    const fracX = clickNX / naturalW;
    const fracY = clickNY / naturalH;
    const cropDim = Math.round(Math.min(naturalW, naturalH) * 0.075);
    const halfCrop = Math.floor(cropDim / 2);
    const csx = Math.max(0, Math.floor(clickNX - halfCrop));
    const csy = Math.max(0, Math.floor(clickNY - halfCrop));
    const csw = Math.min(cropDim, naturalW - csx);
    const csh = Math.min(cropDim, naturalH - csy);

    if (DEBUG_QRCODE_CAPTURE >= 1) {
      console.log('[QR] Click:', clickNX.toFixed(1) + ',' + clickNY.toFixed(1),
        '| proportional:', (fracX * 100).toFixed(1) + '%,' + (fracY * 100).toFixed(1) + '%',
        '| crop:', csw + 'x' + csh, 'at', csx + ',' + csy,
        '| image:', naturalW + 'x' + naturalH);
    }

    // ── Show dashed crop area overlay on the page image ──
    const cropLeft = rect.left + (csx / naturalW) * rect.width;
    const cropTop = rect.top + (csy / naturalH) * rect.height;
    const cropW = (csw / naturalW) * rect.width;
    const cropH = (csh / naturalH) * rect.height;
    setQrCropRect({ left: cropLeft, top: cropTop, width: cropW, height: cropH });
    clearTimeout(qrCropRectTimeoutRef.current);
    qrCropRectTimeoutRef.current = setTimeout(() => setQrCropRect(null), 3000);

    // Draw proportional crop
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = csw;
    cropCanvas.height = csh;
    const cropCtx = cropCanvas.getContext('2d');
    cropCtx.drawImage(pageImg, csx, csy, csw, csh, 0, 0, csw, csh);

    // ── Create raw crop canvas (before contrast enhancement) ──
    const origCropCanvas = document.createElement('canvas');
    origCropCanvas.width = csw;
    origCropCanvas.height = csh;
    const origCtx2 = origCropCanvas.getContext('2d');
    origCtx2.drawImage(pageImg, csx, csy, csw, csh, 0, 0, csw, csh);

    // ── Strategy 0: detect → crop → 3× upscale pipeline (runs FIRST, auto-copies to clipboard) ──
    let qrResult = null;
    try {
      const pipeResult = await detectCropUpscaleQr(origCropCanvas);
      if (pipeResult.data) {
        qrResult = pipeResult.data;
        if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] ✅ detect→crop→3× upscale:', qrResult,
          '| crop:', pipeResult.cropW + '×' + pipeResult.cropH,
          '| up:', pipeResult.canvas.width + '×' + pipeResult.canvas.height);
      } else if (pipeResult.location) {
        if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] detect→crop→3× upscale: QR located but decode failed');
      }
    } catch (err) {
      if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] detect→crop→3× upscale error:', err.message || err);
    }

    // ── Debug: original crop image ──────────────────────
    const origUrl = cropCanvas.toDataURL('image/png');

    // Level 2: copy crop image to clipboard as PNG (paste-able into dnschecker.org etc.)
    // Only if pipeline didn't already copy the upscaled version
    if (DEBUG_QRCODE_CAPTURE >= 2 && !qrResult) {
      try {
        const blob = await new Promise(resolve => cropCanvas.toBlob(resolve, 'image/png'));
        if (blob) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] Copied crop image to clipboard');
        }
      } catch { /* clipboard may not be available */ }
    }

    // If pipeline already found the QR, skip remaining strategies
    if (qrResult) {
      if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] ✅ Setting QR URL:', qrResult);
      processQrValue(qrResult);
      return;
    }

    // Level 3: trigger Save-As download of original crop
    if (DEBUG_QRCODE_CAPTURE >= 3) {
      const a1 = document.createElement('a');
      a1.href = origUrl;
      a1.download = `qr-debug-${Math.round(clickNX)}x${Math.round(clickNY)}.png`;
      document.body.appendChild(a1);
      a1.click();
      document.body.removeChild(a1);
      if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] Saved original crop:', a1.download);
    }

    // ── Contrast enhancement ─────────────────────────────
    const imageData = cropCtx.getImageData(0, 0, csw, csh);
    const pixels = imageData.data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      sum += pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
    }
    const avg = sum / (pixels.length / 4);
    const threshold = Math.max(60, Math.min(200, avg * 0.8));
    for (let i = 0; i < pixels.length; i += 4) {
      const lum = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
      const v = lum < threshold ? 0 : 255;
      pixels[i] = v;
      pixels[i + 1] = v;
      pixels[i + 2] = v;
    }
    cropCtx.putImageData(imageData, 0, 0);

    // ── Save contrast-enhanced proportional crop (level >= 3) ──
    if (DEBUG_QRCODE_CAPTURE >= 3) {
      const contrastUrl = cropCanvas.toDataURL('image/png');
      const a2 = document.createElement('a');
      a2.href = contrastUrl;
      a2.download = `qr-debug-${Math.round(clickNX)}x${Math.round(clickNY)}-contrast.png`;
      document.body.appendChild(a2);
      a2.click();
      document.body.removeChild(a2);
      if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] Saved contrast crop (threshold:', threshold.toFixed(0) + ')');
    }

    // ── Decode QR code (remaining strategies if pipeline didn't find it) ──

    // Helper: try jsQR on raw RGBA pixels
    const tryJsQR = (pixels, w, h, label) => {
      try {
        const res = jsQR(pixels, w, h, { inversionAttempts: 'attemptBoth' });
        if (res?.data) {
          if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] ✅ jsQR ' + label + ':', res.data);
          return res.data;
        }
        if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] jsQR ' + label + ': returned null (no QR detected)');
      } catch (err) {
        if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] jsQR ' + label + ' error:', err.message || err);
      }
      return null;
    };

    // Helper: create B&W thresholded pixels
    const thresholdPixels = (srcData, t) => {
      const out = new Uint8ClampedArray(srcData.length);
      for (let i = 0; i < srcData.length; i += 4) {
        const lum = srcData[i] * 0.299 + srcData[i + 1] * 0.587 + srcData[i + 2] * 0.114;
        const v = lum < t ? 0 : 255;
        out[i] = v;
        out[i + 1] = v;
        out[i + 2] = v;
        out[i + 3] = 255;
      }
      return out;
    };

    // Get raw (unprocessed) crop pixels (reuse origCropCanvas from above)
    const origImageData = origCtx2.getImageData(0, 0, csw, csh);
    const origPixels = new Uint8ClampedArray(origImageData.data);

    // Strategy 1: jsQR on raw crop pixels
    if (!qrResult) qrResult = tryJsQR(origPixels, csw, csh, 'raw crop');

    // Strategy 2: jsQR on contrast-enhanced (auto threshold)
    if (!qrResult) {
      const contrastPixels = thresholdPixels(origPixels, threshold);
      qrResult = tryJsQR(contrastPixels, csw, csh, `contrast t=${threshold.toFixed(0)}`);
    }

    // Strategy 3: jsQR on inverted contrast
    if (!qrResult) {
      const invPixels = new Uint8ClampedArray(origPixels.length);
      for (let i = 0; i < origPixels.length; i += 4) {
        const lum = origPixels[i] * 0.299 + origPixels[i + 1] * 0.587 + origPixels[i + 2] * 0.114;
        const v = lum < threshold ? 255 : 0;
        invPixels[i] = v; invPixels[i + 1] = v; invPixels[i + 2] = v; invPixels[i + 3] = 255;
      }
      qrResult = tryJsQR(invPixels, csw, csh, `inverted t=${threshold.toFixed(0)}`);
    }

    // Strategy 4: threshold sweep
    if (!qrResult) {
      for (const t of [40, 60, 80, 100, 120, 140, 160, 180, 200, 220]) {
        const sweepPixels = thresholdPixels(origPixels, t);
        qrResult = tryJsQR(sweepPixels, csw, csh, `sweep t=${t}`);
        if (qrResult) break;
      }
    }

    // Strategy 5: qr-scanner on the contrast crop canvas with disallowCanvasResizing
    if (!qrResult) {
      try {
        const res = await QrScanner.scanImage(cropCanvas, { disallowCanvasResizing: true, alsoTryWithoutScanRegion: true });
        if (res) {
          qrResult = typeof res === 'string' ? res : res.data;
          if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] ✅ qr-scanner (no-resize) on contrast crop:', qrResult);
        }
      } catch (err) {
        if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] qr-scanner (no-resize) failed:', err.message || err);
      }
    }

    // Strategy 6: qr-scanner on Blob (mimics file upload like dnschecker.org)
    if (!qrResult) {
      try {
        const blob = await new Promise(resolve => cropCanvas.toBlob(resolve, 'image/png'));
        if (blob) {
          const res = await QrScanner.scanImage(blob, { disallowCanvasResizing: true, alsoTryWithoutScanRegion: true });
          if (res) {
            qrResult = typeof res === 'string' ? res : res.data;
            if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] ✅ qr-scanner on Blob:', qrResult);
          }
        }
      } catch (err) {
        if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] qr-scanner on Blob failed:', err.message || err);
      }
    }

    // Strategy 7: native BarcodeDetector on original crop
    if (!qrResult && 'BarcodeDetector' in window) {
      try {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        const detections = await detector.detect(origCropCanvas);
        if (detections.length > 0) {
          qrResult = detections[0].rawValue;
          if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] ✅ BarcodeDetector:', qrResult);
        }
      } catch (err) {
        if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] BarcodeDetector failed:', err.message || err);
      }
    }

    // Strategy 8: last resort — qr-scanner on full page image (no resize)
    if (!qrResult) {
      try {
        const res = await QrScanner.scanImage(pageImg, { disallowCanvasResizing: true, alsoTryWithoutScanRegion: true });
        if (res) {
          qrResult = typeof res === 'string' ? res : res.data;
          if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] ✅ qr-scanner on full image:', qrResult);
        }
      } catch (err) {
        if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] qr-scanner on full image failed:', err.message || err);
      }
    }

    // Strategy 9: server-side QR decode via zbarimg
    if (!qrResult) {
      try {
        const dataUrl = origCropCanvas.toDataURL('image/png');
        const resp = await fetch('api/qr-decode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl }),
        });
        if (resp.ok) {
          const json = await resp.json();
          if (json.data) {
            qrResult = json.data;
            if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] ✅ server-side decode:', qrResult);
          } else {
            if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] server-side decode: no QR found');
          }
        } else {
          if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] server-side error:', resp.status);
        }
      } catch (err) {
        if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] server-side decode failed:', err.message || err);
      }
    }

    if (qrResult) {
      if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] ✅ Setting QR URL:', qrResult);
      processQrValue(qrResult);
    } else {
      if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] All strategies failed: no QR found');
    }
  };

  /** Validate QR value as http(s) URL and route it appropriately */
  const processQrValue = (value) => {
    let url;
    let host;
    try {
      url = new URL(value);
    } catch {
      if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] QR value is not a valid URL:', value);
      return;
    }

    const rewriteEntry = qrUrlRewriteMap.get(url.href) || qrUrlRewriteMap.get(String(value).trim());
    const rewrittenUrl = rewriteEntry?.url || url.href;
    const resourceName = rewriteEntry?.name || '';
    if (rewrittenUrl !== url.href && DEBUG_QRCODE_CAPTURE >= 1) {
      console.log('[QR] Rewrote QR URL from contents mapping:', { from: url.href, to: rewrittenUrl, name: resourceName });
    }

    try {
      url = new URL(rewrittenUrl);
      host = url.hostname;
    } catch {
      // Rewritten URL may be a relative path (e.g. /pdf-reader/data/...)
      if (typeof rewrittenUrl === 'string' && rewrittenUrl.startsWith('/')) {
        try {
          url = new URL(rewrittenUrl, window.location.origin);
          host = url.hostname;
        } catch {
          if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] Rewritten QR value is not a valid URL:', rewrittenUrl);
          return;
        }
      } else {
        if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] Rewritten QR value is not a valid URL:', rewrittenUrl);
        return;
      }
    }

    if (!url.protocol.startsWith('http')) {
      if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] URL protocol is not http(s):', url.protocol);
      return;
    }
    if (/\.mp3(\?|$)/i.test(url.href)) {
      if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] ✅ Opening MP3 QR URL in floating player:', url.href, resourceName);
      setFloatingPlayer({ url: url.href, name: resourceName || 'QR Code Link' });
      return;
    }
    if (host === 'eresources.oupchina.com.hk' || host.endsWith('.oupchina.com.hk')) {
      if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] ✅ Opening OUP QR URL in proxy modal:', url.href);
      setModalInfo({ url: url.href });
      return;
    }
    if (/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})/.test(url.href)) {
      if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] ✅ Opening YouTube QR URL in modal:', url.href);
      setModalInfo({ url: url.href });
      return;
    }
    if (DEBUG_QRCODE_CAPTURE >= 1) console.log('[QR] ✅ Opening QR URL in modal:', url.href);
    setModalInfo({ url: url.href });
  };

  const handleCanvasClick = async (event) => {
    // If a text input is already active, handle reposition or ignore
    if (textInputState) {
      // Check if this click is a reposition (blur flag was set by mousedown listener)
      if (textInputBlurFlagRef.current) {
        textInputBlurFlagRef.current = false;
        const target = resolveAnnotationTarget(event);
        if (!target) {
          // Clicked outside page image area — commit as-is
          commitTextAnnotation();
          return;
        }
        const stage = stageRef.current;
        const stageRect = stage ? stage.getBoundingClientRect() : null;
        if (!stageRect) return;
        // Reposition the textarea to the new click location
        setTextInputState((prev) => prev ? {
          ...prev,
          canvasX: event.clientX - stageRect.left,
          canvasY: event.clientY - stageRect.top,
          langId: target.langId,
          point: target.point,
          imageRect: target.imageRect,
        } : null);
        // Refocus the textarea after React re-renders
        setTimeout(() => textInputRef.current?.focus(), 0);
        return;
      }
      return;
    }

    const target = resolveAnnotationTarget(event);
    if (!target) return;
    setActiveAnnotationLangId(target.langId);
    if (tool === 'eraser') {
      const annotation = findAnnotationAtPoint(target.langId, target.point, target.pageNum);
      if (!annotation?.createdAt) return;
      await deleteRemarkByCreatedAt(annotation.createdAt, annotation.langId || target.langId, {
        pageIdOverride: annotation.page,
        recordUndo: true,
        deletedRemark: annotation,
      });
      return;
    }
    if (tool === 'text') {
      // Check if clicking on an existing text annotation (to re-edit it)
      const existing = findAnnotationAtPoint(target.langId, target.point, target.pageNum);
      const stage = stageRef.current;
      const stageRect = stage ? stage.getBoundingClientRect() : null;
      if (!stageRect) return;
      textInputCommittedRef.current = false;

      // When editing existing text, use its original position (denormalized)
      let editPoint = target.point;
      if (existing && existing.type === 'text') {
        const existRectKey = displayModeRef.current === 'scrolling'
          ? `${target.langId}-${existing.page || selectedPage}`
          : target.langId;
        const imageRect = pageImageRects[existRectKey] || target.imageRect;
        if (imageRect && existing.coordsNormalized) {
          const denorm = denormalizeAnnotationCoords(existing, imageRect);
          editPoint = { x: denorm.x || 0, y: denorm.y || 0 };
        } else if (existing.x != null && existing.y != null) {
          editPoint = { x: existing.x, y: existing.y };
        }
      }

      const newState = {
        canvasX: event.clientX - stageRect.left,
        canvasY: event.clientY - stageRect.top,
        langId: target.langId,
        point: editPoint,
        imageRect: target.imageRect,
      };
      if (existing && existing.type === 'text') {
        // Re-edit: pre-fill with existing text and store reference to delete old on save
        newState.existingCreatedAt = existing.createdAt;
        newState.existingLangId = existing.langId || target.langId;
        newState.existingRemark = existing;
        newState.initialText = existing.text || '';
      }
      setTextInputState(newState);
    }
  };

  // ── Panel drag ─────────────────────────────────────────────
  const handlePanelDragStart = (event) => {
    if (panelDocked || isNarrowScreen) return;
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
    const mediaQuery = window.matchMedia('(orientation: portrait)');
    const handleChange = (event) => {
      setIsPortrait(event.matches);
    };
    setIsPortrait(mediaQuery.matches);
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    console.log('[layout] immediate fit refresh — sidebar/fullscreen/panel changed');
    refreshFitForCurrentMode();
  }, [sidebarCollapsed, sidebarHidden, panelVisible, annotationToolsOpen, refreshFitForCurrentMode]);

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
      const offset = 0;
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
    if (!panelVisible || !panelRef.current) {
      setSingleRowToolbar(false);
      setToolbarScale(1);
      setToolbarTight(false);
      return undefined;
    }

    const panel = panelRef.current;
    const updateSingleRowToolbar = () => {
      const panelStyle = window.getComputedStyle(panel);
      const paddingLeft = parseFloat(panelStyle.paddingLeft || '0');
      const paddingRight = parseFloat(panelStyle.paddingRight || '0');
      let availableWidth = Math.max(0, panel.clientWidth - paddingLeft - paddingRight);

      // Reserve space for the absolutely-positioned close button
      const closeBtnWidth = closeButtonRef.current?.offsetWidth || 0;
      if (closeBtnWidth > 0) {
        availableWidth = Math.max(0, availableWidth - closeBtnWidth - 12 /* gap */);
      }

      const widths = [
        primaryToolbarRef.current?.scrollWidth || 0,
        annotationToggleRef.current?.offsetWidth || 0,
        searchButtonRef.current?.offsetWidth || 0,
      ];

      if (annotationToolsOpen && displayMode !== 'thumbnails') {
        widths.splice(3, 0, secondaryToolbarRef.current?.scrollWidth || 0);
      }

      const visibleItemCount = widths.filter((width) => width > 0).length;
      const gapWidth = Math.max(0, visibleItemCount - 1) * 6;
      const requiredWidth = widths.reduce((sum, width) => sum + width, 0) + gapWidth;

      const currentScale = toolbarScale || 1;
      const baseRequiredWidth = requiredWidth / currentScale;
      const minScale = 1.0;
      const maxScale = 1.2;
      const nextScale = Math.max(
        minScale,
        Math.min(maxScale, availableWidth / Math.max(baseRequiredWidth, 1))
      );
      const requiredAtMinScale = baseRequiredWidth * minScale;
      let nextTight = requiredAtMinScale > availableWidth;

      // Check if centered content would overlap with the absolutely-positioned close button.
      // Use baseRequiredWidth (scale-independent) so the check is not affected by the
      // current tight/loose layout mode.  In tight mode .panel-main-controls stretches via
      // flex:1-1-auto, so its bounding rect is not a reliable measure of content width.
      if (closeBtnWidth > 0) {
        const panelWidth = panel.clientWidth;
        // When content is centered, its right edge is at panelWidth/2 + baseRequiredWidth/2.
        // The close button (absolutely positioned right:8px) has its left edge at
        // panelWidth - 8 - closeBtnWidth.
        // Overlap when: panelWidth/2 + baseRequiredWidth/2 + 8 > panelWidth - 8 - closeBtnWidth
        // → baseRequiredWidth + 32 + 2*closeBtnWidth > panelWidth
        if (baseRequiredWidth + 32 + 2 * closeBtnWidth > panelWidth) {
          nextTight = true;
        }
      }

      if (Math.abs(nextScale - toolbarScale) > 0.01) {
        setToolbarScale(nextScale);
      }
      if (nextTight !== toolbarTight) {
        setToolbarTight(nextTight);
      }

      // Keep controls in a single row and resize controls to fit when space is tight.
      setSingleRowToolbar(!isPortrait);
    };

    updateSingleRowToolbar();
    const observer = new ResizeObserver(updateSingleRowToolbar);
    observer.observe(panel);
    window.addEventListener('resize', updateSingleRowToolbar);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSingleRowToolbar);
    };
  }, [panelVisible, annotationToolsOpen, displayMode, zoomLevel, selectedLanguage, sidebarHidden, toolbarScale, toolbarTight, isPortrait]);

  // Clamp panel position so it never moves off-screen
  const clampPanelPos = useCallback((pos) => {
    if (pos.x == null || pos.y == null) return pos;
    const panel = panelRef.current;
    const pw = panel ? panel.offsetWidth : 360;
    const ph = panel ? panel.offsetHeight : 80;
    const maxX = Math.max(0, window.innerWidth - pw);
    const maxY = Math.max(0, window.innerHeight - ph);
    return {
      x: Math.min(maxX, Math.max(0, pos.x)),
      y: Math.min(maxY, Math.max(0, pos.y)),
    };
  }, []);

  // Clamp panel on window resize so it never ends up off-screen
  useEffect(() => {
    const onResize = () => {
      setPanelPos((prev) => clampPanelPos(prev));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampPanelPos]);

  // Clamp saved panel position on first load (stale coords from larger screen)
  useEffect(() => {
    setPanelPos((prev) => {
      if (prev.x == null || prev.y == null) return prev;
      return clampPanelPos(prev);
    });
    // Run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onMove = (event) => {
      if (isNarrowScreen || !dragRef.current.dragging) return;
      const dx = event.clientX - dragRef.current.startX;
      const dy = event.clientY - dragRef.current.startY;
      setPanelPos(clampPanelPos({
        x: dragRef.current.posX + dx,
        y: dragRef.current.posY + dy
      }));
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

  useEffect(() => {
    maxNavigablePageRef.current = maxNavigablePage;
  }, [maxNavigablePage]);

  const pageOptions = useMemo(() => {
    const maxPage = Number.isFinite(maxNavigablePage)
      ? Math.max(1, Math.floor(maxNavigablePage))
      : Math.max(1, Math.min(Number(selectedPage) || 1, 10000));
    // Safety cap — selectedPage can be MAX_SAFE_INTEGER when navigating between sections
    const safeMax = Math.min(maxPage, 10000);
    return Array.from({ length: safeMax }, (_, index) => index + 1);
  }, [maxNavigablePage, selectedPage]);

  const pageSelectOptions = useMemo(() => (
    pageOptions.map((page) => ({ id: page, label: String(page) }))
  ), [pageOptions]);

  const annotationScopeLangId = useMemo(() => {
    if (selectedLanguage === 'bilingual') {
      return visibleLanguages.includes(activeAnnotationLangId)
        ? activeAnnotationLangId
        : (visibleLanguages[0] || 'en');
    }
    if (visibleLanguages[0]) {
      return visibleLanguages[0];
    }
    return selectedLanguage === 'tc' ? 'tc' : 'en';
  }, [activeAnnotationLangId, selectedLanguage, visibleLanguages]);

  useEffect(() => {
    setActiveAnnotationLangId((current) => {
      if (selectedLanguage !== 'bilingual') {
        return visibleLanguages[0] || (selectedLanguage === 'tc' ? 'tc' : 'en');
      }
      if (visibleLanguages.includes(current)) {
        return current;
      }
      return visibleLanguages[0] || current || 'en';
    });
  }, [selectedLanguage, visibleLanguages]);

  const currentPageIndex = useMemo(
    () => pageOptions.findIndex((page) => Number(page) === Number(selectedPage)),
    [pageOptions, selectedPage]
  );

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
  }, [selectedChapter, selectedFile, selectedLanguage, displayMode]);

  const fetchCachedAiContent = useCallback(async () => {
    const data = await fetchJson(
      `api/ai-content?subjectId=${encodeURIComponent(selectedBook)}&bookId=${encodeURIComponent(selectedChapter)}&sectionId=${selectedFile}&pageId=${selectedPage}`
    );
    return normalizeAiContent(data.content);
  }, [normalizeAiContent, selectedBook, selectedChapter, selectedFile, selectedPage]);

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
  }, [fetchCachedAiContent, selectedChapter, selectedFile, selectedPage, selectedLanguage]);

  const isRightDrawerOpen = resourcesDrawerOpen || aiDrawerOpen || searchDrawerOpen;

  // Reset quiz/flashcard answers every time the AI drawer opens
  useEffect(() => {
    if (aiDrawerOpen) {
      setFlippedCards({});
      setMcqAnswers({});
    }
  }, [aiDrawerOpen]);

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
      // Determine which parts already exist (so they can be unchecked by default)
      const enContent = aiContent?.en || {};
      const hasSummary = Array.isArray(enContent.summary) && enContent.summary.length > 0;
      const hasFlashcards = Array.isArray(enContent.flashcards) && enContent.flashcards.length > 0;
      const hasQuiz = Array.isArray(enContent.mcq) && enContent.mcq.length > 0;
      const hasAny = hasSummary || hasFlashcards || hasQuiz;

      const html = `
        <div style="text-align:left;display:flex;flex-direction:column;gap:10px;padding:8px 0;">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:0.95rem;">
            <input type="checkbox" class="swal-regen-check" value="extraction" ${!hasAny ? 'checked disabled' : ''} style="width:18px;height:18px;accent-color:#667eea;">
            <span>1. ${_('regenTextExtraction')}</span>
          </label>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:0.95rem;">
            <input type="checkbox" class="swal-regen-check" value="summary" ${!hasSummary ? 'checked disabled' : ''} style="width:18px;height:18px;accent-color:#667eea;">
            <span>2. ${_('regenSummary')}${hasSummary ? ' ✓' : ' (missing)'}</span>
          </label>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:0.95rem;">
            <input type="checkbox" class="swal-regen-check" value="flashcards" ${!hasFlashcards ? 'checked disabled' : ''} style="width:18px;height:18px;accent-color:#667eea;">
            <span>3. ${_('regenFlashcards')}${hasFlashcards ? ' ✓' : ' (missing)'}</span>
          </label>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:0.95rem;">
            <input type="checkbox" class="swal-regen-check" value="quiz" ${!hasQuiz ? 'checked disabled' : ''} style="width:18px;height:18px;accent-color:#667eea;">
            <span>4. ${_('regenQuiz')}${hasQuiz ? ' ✓' : ' (missing)'}</span>
          </label>
        </div>
      `;

      const result = await Swal.fire({
        title: _('regenerate'),
        html,
        showCancelButton: true,
        confirmButtonText: _('confirm'),
        cancelButtonText: _('cancel'),
        reverseButtons: true,
        focusCancel: true,
        preConfirm: () => {
          const checks = document.querySelectorAll('.swal-regen-check');
          return {
            extraction: checks[0]?.checked || false,
            summary: checks[1]?.checked || false,
            flashcards: checks[2]?.checked || false,
            quiz: checks[3]?.checked || false,
          };
        },
      });
      if (!result.isConfirmed) {
        return;
      }
      // Store skip flags (inverse of checked = regenerate)
      const sel = result.value || {};
      regenSkipExtractionRef.current = !sel.extraction;
      regenSkipSummaryRef.current = !sel.summary;
      regenSkipFlashcardsRef.current = !sel.flashcards;
      regenSkipQuizRef.current = !sel.quiz;
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
      // No cached content found and not force-regenerating → just open drawer,
      // show empty state. User must explicitly click "Generate" to start.
      setAiDrawerLanguage(preferredAiDrawerLanguage);
      setAiDrawerOpen(true);
      return;
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
        ...(forceRegenerate ? {
          skipExtraction: regenSkipExtractionRef.current ? '1' : undefined,
          skipSummary: regenSkipSummaryRef.current ? '1' : undefined,
          skipFlashcards: regenSkipFlashcardsRef.current ? '1' : undefined,
          skipQuiz: regenSkipQuizRef.current ? '1' : undefined,
        } : {}),
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

  const handleResetAnswers = () => {
    setFlippedCards({});
    setMcqAnswers({});
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

  const aiLookupKey = useMemo(() => ({
    subjectId: selectedBook,
    bookId: selectedChapter,
    sectionId: selectedFile,
    pageId: selectedPage,
  }), [selectedBook, selectedChapter, selectedFile, selectedPage]);

  // ── Keyboard navigation ─────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      // Ignore if user is typing in an input/textarea
      const tag = (e.target.tagName || '').toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
      if (isInput) return;

      // Escape: close modals & drawers
      if (e.key === 'Escape') {
        if (modalInfo) { setModalInfo(null); return; }
        if (toolMenuOpen) { setToolMenuOpen(false); return; }
        if (studyMenuOpen) { setStudyMenuOpen(false); return; }
        if (zoomMenuOpen) { setZoomMenuOpen(false); return; }
        if (resourcesDrawerOpen) { setResourcesDrawerOpen(false); return; }
        if (searchDrawerOpen) { setSearchDrawerOpen(false); return; }
        if (aiDrawerOpen) { setAiDrawerOpen(false); return; }
        return;
      }

      // Backspace: close drawers (common "go back" shortcut)
      if (e.key === 'Backspace') {
        if (modalInfo) { e.preventDefault(); setModalInfo(null); return; }
        if (resourcesDrawerOpen) { e.preventDefault(); setResourcesDrawerOpen(false); return; }
        if (searchDrawerOpen) { e.preventDefault(); setSearchDrawerOpen(false); return; }
        return;
      }

      // Arrow key navigation — skip in thumbnails mode (PdfPane handles it)
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && displayMode !== 'thumbnails') {
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (e.shiftKey) {
          e.preventDefault();
          moveBook(dir);
        } else if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          moveSection(dir);
        } else {
          e.preventDefault();
          changePage(dir);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalInfo, toolMenuOpen, studyMenuOpen, zoomMenuOpen, resourcesDrawerOpen, searchDrawerOpen, aiDrawerOpen, selectedChapter, structure, displayMode]);

  // ── Right-click context menu: Copy to clipboard ────────
  const handleCopyToClipboard = useCallback(async () => {
    if (typeof window === 'undefined') return;
    const stage = stageRef.current;
    const annotationCanvas = canvasRef.current;
    if (!stage) return;

    // Find only the current page's images
    const currentPage = selectedPageRef.current;
    const currentPageImages = stage.querySelectorAll(`img.page-img[data-page="${currentPage}"]`);
    // Pagination mode: the single rendered canvas per pane
    const pageCanvases = stage.querySelectorAll('.pdf-single-page canvas');

    const result = await Swal.fire({
      title: _('copyToClipboard'),
      html: `
        <div style="display:flex;flex-direction:column;gap:12px;text-align:left;padding:8px 0;">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:0.95rem;">
            <input type="checkbox" id="swal-copy-contents" checked style="width:18px;height:18px;accent-color:#667eea;" />
            <span>${_('pageContents')} (p.${currentPage})</span>
          </label>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:0.95rem;">
            <input type="checkbox" id="swal-copy-annotations" checked style="width:18px;height:18px;accent-color:#667eea;" />
            <span>${_('annotations')}</span>
          </label>
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: _('copy'),
      cancelButtonText: _('cancel'),
      focusConfirm: false,
      preConfirm: () => {
        const includeContents = document.getElementById('swal-copy-contents')?.checked;
        const includeAnnotations = document.getElementById('swal-copy-annotations')?.checked;
        return { includeContents, includeAnnotations };
      },
    });

    if (!result.isConfirmed || !result.value) return;
    const { includeContents, includeAnnotations } = result.value;
    if (!includeContents && !includeAnnotations) return;

    try {
      const stageRect = stage.getBoundingClientRect();

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const elements = [];

      const addElement = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        elements.push({ el, x: r.left - stageRect.left, y: r.top - stageRect.top, w: r.width, h: r.height });
        minX = Math.min(minX, r.left - stageRect.left);
        minY = Math.min(minY, r.top - stageRect.top);
        maxX = Math.max(maxX, r.left - stageRect.left + r.width);
        maxY = Math.max(maxY, r.top - stageRect.top + r.height);
      };

      if (includeContents) {
        // Current page images only (handles scrolling mode with data-page)
        for (const img of currentPageImages) addElement(img);
        // Pagination mode canvases (only the current page is visible)
        for (const c of pageCanvases) addElement(c);
      }

      if (!Number.isFinite(minX)) throw new Error('No visible page content found');

      const totalW = Math.round(Math.max(1, maxX - minX));
      const totalH = Math.round(Math.max(1, maxY - minY));
      const maxPixels = 8 * 1024 * 1024;
      let dpr = Math.min(2, window.devicePixelRatio || 1);
      if (totalW * dpr * totalH * dpr > maxPixels) {
        dpr = Math.max(0.5, Math.sqrt(maxPixels / (totalW * totalH)));
      }

      const offscreen = document.createElement('canvas');
      offscreen.width = Math.round(totalW * dpr);
      offscreen.height = Math.round(totalH * dpr);
      const ctx = offscreen.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');
      ctx.scale(dpr, dpr);

      // White background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, totalW, totalH);

      // Draw page contents
      let drewSomething = false;
      if (includeContents) {
        for (const { el, x, y, w, h } of elements) {
          const sx = x - minX;
          const sy = y - minY;
          try {
            ctx.drawImage(el, sx, sy, w, h);
            drewSomething = true;
          } catch (e) {
            // Tainted source — skip
          }
        }
      }

      // Draw annotations on top (may taint canvas — try but don't fail)
      if (includeAnnotations && annotationCanvas && annotationCanvas.width > 0) {
        const annRect = annotationCanvas.getBoundingClientRect();
        const ax = annRect.left - stageRect.left - minX;
        const ay = annRect.top - stageRect.top - minY;
        try {
          ctx.drawImage(annotationCanvas, ax, ay, annRect.width, annRect.height);
          drewSomething = true;
        } catch (e) {
          // Tainted — annotations will be missing from the copy; that's OK
        }
      }

      if (!drewSomething) throw new Error('Nothing could be drawn (all sources tainted or empty)');

      // Export and copy
      let blob = null;
      // Try toBlob first
      try {
        blob = await new Promise((res, rej) => {
          offscreen.toBlob((b) => (b && b.size > 0 ? res(b) : rej(new Error('empty'))), 'image/png');
        });
      } catch (_) { /* fall through */ }

      // Fallback: data URL
      if (!blob) {
        try {
          const dataUrl = offscreen.toDataURL('image/png');
          const resp = await fetch(dataUrl);
          if (!resp.ok) throw new Error('data URL fetch failed');
          blob = await resp.blob();
        } catch (e) {
          throw new Error('image generation failed: ' + (e.message || 'unknown'));
        }
      }

      if (!blob || blob.size === 0) throw new Error('generated image is empty');

      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ]);

      if (isTestMode) {
        console.log('[clipboard] copied', `${offscreen.width}x${offscreen.height}`, `${(blob.size / 1024).toFixed(0)}KB`);
      }
    } catch (err) {
      console.error('[clipboard] copy failed:', err);
      Swal.fire({
        icon: 'error',
        title: _('copyFailed'),
        text: err.message || '',
        timer: 3000,
        showConfirmButton: false,
      });
    }
  }, [_]);

  const handleStageContextMenu = useCallback((e) => {
    // Only show custom menu on the stage area (not on buttons/inputs etc.)
    if (e.target.closest('button, input, a, [role="button"]')) return;
    e.preventDefault();
    handleCopyToClipboard();
  }, [handleCopyToClipboard]);

  // ── Debounced search ────────────────────────────────────
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const params = new URLSearchParams({ q: searchQuery.trim() });
        if (searchScope !== 'all' && selectedBook) params.set('subjectId', selectedBook);
        if (searchScope === 'book' || searchScope === 'section' || searchScope === 'page') {
          if (selectedChapter) params.set('bookId', selectedChapter);
        }
        if (searchScope === 'section' || searchScope === 'page') {
          if (selectedFile) params.set('sectionId', selectedFile);
        }
        if (searchScope === 'page') {
          if (selectedPage) params.set('pageId', selectedPage);
        }
        if (includeAnnotations) params.set('includeAnnotations', '1');
        const data = await fetchJson(`api/search?${params.toString()}`);
        setSearchResults(data.results || []);
      } catch (err) {
        console.error('[search] error:', err);
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchScope, selectedBook, selectedChapter, selectedFile, selectedPage, includeAnnotations]);

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
      const parsed = new URL(url);
      // Proxy external URLs through the server to avoid mixed-content blocking (HTTP on HTTPS page)
      // and to work around CORS / X-Frame-Options restrictions.
      if (parsed.hostname !== window.location.hostname) {
        return `api/proxy?url=${encodeURIComponent(url)}`;
      }
    } catch { /* invalid URL, use as-is */ }
    return url;
  }, [modalInfo]);

  useEffect(() => {
    if (!modalInfo || modalType === 'audio' || modalType?.type === 'youtube') {
      setModalFrameLoading(false);
      setModalFrameFailed(false);
      return undefined;
    }

    setModalFrameLoading(true);
    setModalFrameFailed(false);

    modalFrameTimeoutRef.current = window.setTimeout(() => {
      setModalFrameLoading(false);
      setModalFrameFailed(true);
    }, 12000);

    return () => {
      if (modalFrameTimeoutRef.current) {
        window.clearTimeout(modalFrameTimeoutRef.current);
        modalFrameTimeoutRef.current = null;
      }
    };
  }, [modalInfo, modalType, modalFrameSrc]);

  const handleModalFrameLoad = () => {
    // Clear the failure timeout — iframe loaded successfully
    if (modalFrameTimeoutRef.current) {
      window.clearTimeout(modalFrameTimeoutRef.current);
      modalFrameTimeoutRef.current = null;
    }
    setModalFrameLoading(false);

    if (!modalIframeRef.current || !modalFrameSrc.startsWith('api/proxy?url=')) {
      setModalFrameFailed(false);
      return;
    }

    try {
      const bodyText = modalIframeRef.current.contentDocument?.body?.textContent?.trim() || '';
      if (/^(Proxy error|Host not allowed|Missing \?url=)/.test(bodyText)) {
        setModalFrameFailed(true);
        return;
      }
    } catch {
      // Ignore inspection failures and assume the frame loaded.
    }

    setModalFrameFailed(false);
  };

  const openStudyDrawer = useCallback((type) => {
    // Toggle: if the requested drawer is already open, close it
    if (type === 'resources' && resourcesDrawerOpen) { setResourcesDrawerOpen(false); return; }
    if (type === 'ai' && aiDrawerOpen) { setAiDrawerOpen(false); return; }
    if (type === 'search' && searchDrawerOpen) { setSearchDrawerOpen(false); return; }
    // Close all others, then open the requested one
    if (type !== 'resources') setResourcesDrawerOpen(false);
    if (type !== 'ai') setAiDrawerOpen(false);
    if (type !== 'search') setSearchDrawerOpen(false);
    if (type === 'resources') setResourcesDrawerOpen(true);
    else if (type === 'search') setSearchDrawerOpen(true);
    else if (type === 'ai') handleAiGenerate();
  }, [handleAiGenerate, resourcesDrawerOpen, aiDrawerOpen, searchDrawerOpen]);

  const restoreSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed(true);
    setSidebarHidden(false);
  }, []);

  const restoreSidebarAndPanel = useCallback(() => {
    setSidebarCollapsed(true);
    setSidebarHidden(false);
    setPanelVisible(true);
  }, []);

  const canRestoreHiddenSidebar = sidebarHidden;

  const secondaryToolbar = (
    <div className="toolbar-group toolbar-secondary" ref={secondaryToolbarRef}>
      {/* Split button: tool + color selector */}
      <div className="tool-menu-wrapper">
        <div className="tool-split-btn">
          <button
            className="tool-btn tool-split-main"
            disabled={isRightDrawerOpen}
            data-tooltip={_('annotation')}
            aria-label={_('annotation')}
          >
            {tool === 'highlight' && (
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="currentColor">
                <path d="M15.24 2.36l-11 11a1 1 0 0 0-.24.59V17a1 1 0 0 0 1 1h3.05a1 1 0 0 0 .59-.24l11-11a1 1 0 0 0 0-1.41l-3.4-3.4a1 1 0 0 0-1.41 0zM5 16v-2.5l9-9L16.5 7l-9 9H5z" />
                <rect x="2" y="18" width="20" height="3" rx="1" />
              </svg>
            )}
            {tool === 'pen' && (
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="currentColor">
                <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
              </svg>
            )}
            {tool === 'text' && (
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="currentColor">
                <path d="M5 4v3h5.5v12h3V7H19V4H5z" />
              </svg>
            )}
            {tool === 'eraser' && (
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="currentColor">
                <path d="M16.24 3.56a2 2 0 0 1 2.83 0l1.37 1.37a2 2 0 0 1 0 2.83l-8.49 8.48H8.71L3.56 10.9a2 2 0 0 1 0-2.83l7.85-7.85a2 2 0 0 1 2.83 0l2 2.34zM5.68 9.49l4.28 4.27h1.16l7.9-7.9-1.36-1.37-1.44-1.44-1.31-1.54L5.68 9.49z" />
                <path d="M3 20h18v2H3z" />
              </svg>
            )}
            {tool === 'move' && (
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="currentColor">
                <path d="M12 2l3 3h-2v4h4V7l3 3-3 3v-2h-4v4h2l-3 3-3-3h2v-4H7v2l-3-3 3-3v2h4V5H9l3-3z" />
              </svg>
            )}
            {tool === 'hand' && (
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="currentColor">
                <path d="M18 13.5v-6a1.5 1.5 0 0 0-3 0V11h-.5V6a1.5 1.5 0 0 0-3 0v5h-.5V4.5a1.5 1.5 0 0 0-3 0V11H7.5V7a1.5 1.5 0 0 0-3 0v8.5l-2.5-2.5-2 2L7 22h10.5a2 2 0 0 0 2-2l-.5-6.5z" />
              </svg>
            )}
            {COLOR_TOOLS.has(tool) && (
              <span className="tool-color-indicator" style={{ background: textColor, opacity: tool === 'highlight' ? 0.45 : 1 }} />
            )}
          </button>
          <button
            className="tool-btn tool-split-arrow"
            disabled={isRightDrawerOpen}
            onClick={() => setToolMenuOpen((prev) => !prev)}
            data-tooltip={_('selectTool')}
            aria-label={_('selectTool')}
          >
            <svg viewBox="0 0 12 12" className="tool-menu-arrow" role="presentation" focusable="false">
              <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {toolMenuOpen && (
          <div className="tool-menu-popup">
            <div className="tool-menu-grid">
            <button className={`tool-menu-item ${tool === 'highlight' ? 'active' : ''}`} onClick={() => { setTool('highlight'); setToolMenuOpen(false); }}>
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon" fill="currentColor"><path d="M15.24 2.36l-11 11a1 1 0 0 0-.24.59V17a1 1 0 0 0 1 1h3.05a1 1 0 0 0 .59-.24l11-11a1 1 0 0 0 0-1.41l-3.4-3.4a1 1 0 0 0-1.41 0zM5 16v-2.5l9-9L16.5 7l-9 9H5z" /><rect x="2" y="18" width="20" height="3" rx="1" /></svg>
              {_('highlighter')}
            </button>
            <button className={`tool-menu-item ${tool === 'pen' ? 'active' : ''}`} onClick={() => { setTool('pen'); setToolMenuOpen(false); }}>
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" /></svg>
              {_('pen')}
            </button>
            <button className={`tool-menu-item ${tool === 'text' ? 'active' : ''}`} onClick={() => { setTool('text'); setToolMenuOpen(false); }}>
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon" fill="currentColor"><path d="M5 4v3h5.5v12h3V7H19V4H5z" /></svg>
              {_('textTool')}
            </button>
            <button className={`tool-menu-item ${tool === 'eraser' ? 'active' : ''}`} onClick={() => { setTool('eraser'); setToolMenuOpen(false); }}>
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon" fill="currentColor"><path d="M16.24 3.56a2 2 0 0 1 2.83 0l1.37 1.37a2 2 0 0 1 0 2.83l-8.49 8.48H8.71L3.56 10.9a2 2 0 0 1 0-2.83l7.85-7.85a2 2 0 0 1 2.83 0l2 2.34zM5.68 9.49l4.28 4.27h1.16l7.9-7.9-1.36-1.37-1.44-1.44-1.31-1.54L5.68 9.49z" /><path d="M3 20h18v2H3z" /></svg>
              {_('rubber')}
            </button>
            <button className={`tool-menu-item ${tool === 'move' ? 'active' : ''}`} onClick={() => { setTool('move'); setToolMenuOpen(false); }}>
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon" fill="currentColor"><path d="M12 2l3 3h-2v4h4V7l3 3-3 3v-2h-4v4h2l-3 3-3-3h2v-4H7v2l-3-3 3-3v2h4V5H9l3-3z" /></svg>
              {_('moveTool')}
            </button>
            <button className={`tool-menu-item ${tool === 'hand' ? 'active' : ''}`} onClick={() => { setTool('hand'); setToolMenuOpen(false); }}>
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon" fill="currentColor"><path d="M18 13.5v-6a1.5 1.5 0 0 0-3 0V11h-.5V6a1.5 1.5 0 0 0-3 0v5h-.5V4.5a1.5 1.5 0 0 0-3 0V11H7.5V7a1.5 1.5 0 0 0-3 0v8.5l-2.5-2.5-2 2L7 22h10.5a2 2 0 0 0 2-2l-.5-6.5z" /></svg>
              {_('handPan')}
            </button>
            </div>
            <span className="tool-menu-sep undo-redo-mobile" />
            <div className="tool-menu-grid">
            <button
              className="tool-menu-item undo-redo-mobile"
              disabled={!undoStack.length && !remarks.filter(r => r.chapter === selectedChapter && Number(r.page) === Number(selectedPage)).length}
              onClick={() => { undoRemark(); setToolMenuOpen(false); }}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon" fill="currentColor"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" /></svg>
              {_('undo')}
            </button>
            <button
              className="tool-menu-item undo-redo-mobile"
              disabled={!redoStack.length}
              onClick={() => { redoRemark(); setToolMenuOpen(false); }}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon" fill="currentColor"><path d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16a8.002 8.002 0 0 1 7.6-5.5c1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z" /></svg>
              {_('redo')}
            </button>
            </div>
            <span className="tool-menu-sep" />
            <button className="tool-menu-item tool-menu-erase-item" onClick={() => { setToolMenuOpen(false); openEraseDialog(); }}>
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon" fill="currentColor"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4h-3.5z" /></svg>
              {_('erase')}
            </button>
            <span className="tool-menu-sep" />
            <div className="tool-menu-section-label">{_('color')}</div>
            <div className="tool-menu-colors">
              {POPULAR_COLORS.map((c) => (
                <button
                  key={c}
                  className={`tool-menu-color-dot ${textColor === c ? 'active' : ''}`}
                  style={{ background: c }}
                  onClick={() => {
                    setTextColor(c);
                    setToolMenuOpen(false);
                  }}
                  aria-label={c}
                />
              ))}
              <button
                className="tool-menu-color-dot tool-menu-color-custom"
                onClick={() => {
                  setToolMenuOpen(false);
                  setTimeout(() => customColorInputRef.current?.click(), 60);
                }}
                aria-label={_('customColor')}
              >
                <svg viewBox="0 0 16 16" role="presentation" focusable="false">
                  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.5" />
                  <path d="M8 3v3M8 10v3M3 8h3M10 8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>
      <input
        ref={customColorInputRef}
        type="color"
        value={textColor}
        onChange={(e) => setTextColor(e.target.value)}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }}
        aria-hidden="true"
        tabIndex={-1}
      />
      <button
        className="tool-btn undo-btn"
        disabled={isRightDrawerOpen || (!undoStack.length && !remarks.filter(r => r.chapter === selectedChapter && Number(r.page) === Number(selectedPage)).length)}
        onClick={undoRemark}
        data-tooltip={_('undo')}
        aria-label={_('undo')}
      >
        <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="currentColor">
          <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
        </svg>
      </button>
      <button
        className="tool-btn redo-btn"
        disabled={isRightDrawerOpen || !redoStack.length}
        onClick={redoRemark}
        data-tooltip={_('redo')}
        aria-label={_('redo')}
      >
        <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="currentColor">
          <path d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16a8.002 8.002 0 0 1 7.6-5.5c1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z" />
        </svg>
      </button>
      <span className="toolbar-sep undo-redo-sep" />
      {/* Study dropdown: Resources, AI Generation, Search */}
      <div className="tool-menu-wrapper">
        <div className="tool-split-btn">
          <button
            className="tool-btn tool-split-main"
            data-tooltip={_('resources')}
            aria-label={_('resources')}
            onClick={() => openStudyDrawer(lastStudyAction)}
          >
            {lastStudyAction === 'resources' && (
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 0 0-5 5 5 5 0 0 0 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4a5 5 0 0 0 5-5 5 5 0 0 0-5-5z" /></svg>
            )}
            {lastStudyAction === 'search' && (
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" /></svg>
            )}
            {lastStudyAction === 'ai' && (
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M10 7L9.48415 8.39405C8.80774 10.222 8.46953 11.136 7.80278 11.8028C7.13603 12.4695 6.22204 12.8077 4.39405 13.4842L3 14L4.39405 14.5158C6.22204 15.1923 7.13603 15.5305 7.80278 16.1972C8.46953 16.864 8.80774 17.778 9.48415 19.6059L10 21L10.5158 19.6059C11.1923 17.778 11.5305 16.864 12.1972 16.1972C12.864 15.5305 13.778 15.1923 15.6059 14.5158L17 14L15.6059 13.4842C13.778 12.8077 12.864 12.4695 12.1972 11.8028C11.5305 11.136 11.1923 10.222 10.5158 8.39405L10 7Z" /><path d="M18 3L17.7789 3.59745C17.489 4.38087 17.3441 4.77259 17.0583 5.05833C16.7726 5.34408 16.3809 5.48903 15.5975 5.77892L15 6L15.5975 6.22108C16.3809 6.51097 16.7726 6.65592 17.0583 6.94167C17.3441 7.22741 17.489 7.61913 17.7789 8.40255L18 9L18.2211 8.40255C18.511 7.61913 18.6559 7.22741 18.9417 6.94166C19.2274 6.65592 19.6191 6.51097 20.4025 6.22108L21 6L20.4025 5.77892C19.6191 5.48903 19.2274 5.34408 18.9417 5.05833C18.6559 4.77259 18.511 4.38087 18.2211 3.59745L18 3Z" /></svg>
            )}
          </button>
          <button
            className="tool-btn tool-split-arrow"
            onClick={() => setStudyMenuOpen((prev) => !prev)}
            data-tooltip={_('selectTool')}
            aria-label={_('selectTool')}
          >
            <svg viewBox="0 0 12 12" className="tool-menu-arrow" role="presentation" focusable="false">
              <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {studyMenuOpen && (
          <div className="tool-menu-popup">
            <div className="tool-menu-section-label">{_('resources')}</div>
            <button className={`tool-menu-item ${resourcesDrawerOpen ? 'active' : ''}`} onClick={() => { openStudyDrawer('resources'); setLastStudyAction('resources'); setStudyMenuOpen(false); }}>
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 0 0-5 5 5 5 0 0 0 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4a5 5 0 0 0 5-5 5 5 0 0 0-5-5z" /></svg>
              {_('resources')}
            </button>
            <button className={`tool-menu-item ${aiDrawerOpen ? 'active' : ''}`} onClick={() => { openStudyDrawer('ai'); setLastStudyAction('ai'); setStudyMenuOpen(false); }}>
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon"><path d="M7.5 5.5l.9-2.3L10.7 4 8.4 5l.9 2.3-2.2-.9-2.3.9.9-2.2-2.4-.8 2.4-.8zM15.5 9.5l1.2-2.8L19.5 8l-1.8.9 1.2 2.8-2.7-1.1-2.8 1.1 1.1-2.8-2.6-1 2.6-1zM5 20l1.8-5.5L12 16l-5.2 1.2L5.5 22 5 20z" fill="currentColor" /></svg>
              {aiLoading ? _('generating') : _('aiGeneration')}
            </button>
            <button className={`tool-menu-item ${searchDrawerOpen ? 'active' : ''}`} onClick={() => { openStudyDrawer('search'); setLastStudyAction('search'); setStudyMenuOpen(false); }}>
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" /></svg>
              {_('search')}
            </button>
          </div>
        )}
      </div>
    </div>
  );

  useEffect(() => {
    if (!canRestoreHiddenSidebar || typeof window === 'undefined') {
      return undefined;
    }

    const onKeyDown = () => {
      restoreSidebarCollapsed();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canRestoreHiddenSidebar, restoreSidebarCollapsed]);

  // Close tool/study/zoom menus when clicking outside
  useEffect(() => {
    if (!toolMenuOpen && !studyMenuOpen && !zoomMenuOpen) return undefined;
    const onPointer = (e) => {
      if (!e.target.closest('.tool-menu-wrapper')) {
        setToolMenuOpen(false);
        setStudyMenuOpen(false);
        setZoomMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [toolMenuOpen, studyMenuOpen, zoomMenuOpen]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  return (
    <div
      className={`app-shell ${displayMode === 'scrolling' ? 'scrolling-mode' : ''} ${sidebarHidden ? 'sidebar-hidden' : ''} ${isFullscreen ? 'fullscreen-active' : ''}`}
      style={{ '--bottom-toolbar-offset': `${panelReservedHeight}px` }}
      data-fit-mode={fitMode}
      onDoubleClick={() => {
        if (canRestoreHiddenSidebar) {
          restoreSidebarCollapsed();
        }
      }}
    >
      {canRestoreHiddenSidebar && (
        <button
          className="hidden-sidebar-restore"
          type="button"
          onPointerDown={() => {
            restoreLongPressRef.current = false;
            if (restorePressTimerRef.current) {
              clearTimeout(restorePressTimerRef.current);
            }
            restorePressTimerRef.current = setTimeout(() => {
              restoreLongPressRef.current = true;
              restoreSidebarAndPanel();
              restorePressTimerRef.current = null;
            }, 500);
          }}
          onPointerUp={() => {
            if (restorePressTimerRef.current) {
              clearTimeout(restorePressTimerRef.current);
              restorePressTimerRef.current = null;
            }
          }}
          onPointerLeave={() => {
            if (restorePressTimerRef.current) {
              clearTimeout(restorePressTimerRef.current);
              restorePressTimerRef.current = null;
            }
          }}
          onPointerCancel={() => {
            if (restorePressTimerRef.current) {
              clearTimeout(restorePressTimerRef.current);
              restorePressTimerRef.current = null;
            }
          }}
          onClick={() => {
            if (restoreLongPressRef.current) {
              restoreLongPressRef.current = false;
              return;
            }
            restoreSidebarAndPanel();
          }}
          aria-label={_('showSidebar')}
          title={_('showSidebar')}
        >
          <span className="hidden-sidebar-restore-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M9 7l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 7l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
      )}
      {!sidebarHidden && (
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-title-row">
          <h1>
            <svg className="sidebar-logo" viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm2 0v14h12V5H6zm2 2h8v2H8V7zm0 4h8v2H8v-2zm0 4h5v2H8v-2z" />
            </svg>
            {_('appTitle')}
          </h1>
          <div className="sidebar-title-actions">
            <button
              className="sidebar-toggle"
              onClick={() => { console.log('[sidebar] toggle clicked, current collapsed:', sidebarCollapsed); setSidebarCollapsed((current) => !current); }}
              aria-label={sidebarCollapsed ? _('expandSidebar') : _('collapseSidebar')}
              title={sidebarCollapsed ? _('expandSidebar') : _('collapseSidebar')}
            >
              <span aria-hidden="true" className="sidebar-toggle-icon">
                {sidebarCollapsed ? (
                  <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                    <path d="M9 7l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M5 7l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                    <path d="M15 7l-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M19 7l-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
            </button>
            <button
              className="sidebar-toggle sidebar-hide-btn"
              onClick={() => setSidebarHidden(true)}
              aria-label={_('closeSidebar')}
              title={_('closeSidebar')}
            >
              <span aria-hidden="true" className="sidebar-toggle-icon">
                <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                  <path d="M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                  <path d="M6 6l12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </span>
            </button>

          </div>
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
            {_('subject')}
          </span>
          <div className="toggle-group subject-toggle-group">
            {subjectToggleOptions.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`toggle-btn ${selectedBook === item.id ? 'active' : ''}`}
                onClick={() => handleSubjectChange(item.id)}
                aria-pressed={selectedBook === item.id}
              >
                {item.label}
              </button>
            ))}
          </div>
        </label>
        {isTestMode && !sidebarCollapsed && (
          <button
            type="button"
            onClick={() => { console.log('[debug] manual fit refresh'); refreshFitForCurrentMode(); }}
            style={{
              width: '100%', padding: '8px 12px', marginBottom: '8px',
              borderRadius: '8px', border: '1px solid #f59e0b',
              background: '#fffbeb', color: '#92400e',
              fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '6px',
              justifyContent: 'center',
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" role="presentation" focusable="false">
              <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="#b45309"/>
            </svg>
            Refresh Fit
          </button>
        )}
        <label>
          <span className="sidebar-label-icon">
            <svg viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M3 4h18v2H3V4zm0 7h18v2H3v-2zm0 7h18v2H3v-2z" />
            </svg>
            {_('book')}
          </span>
          <div className="selector-stepper-row" data-autocomplete-id="book">
            <button type="button" className="selector-stepper-btn" onClick={() => stepBook(-1)} disabled={currentBookIndex <= 0}>-</button>
            <BookAutocomplete
              books={bookAutocompleteOptions}
              currentBook={currentChapter}
              language={selectedLanguage}
              subjectId={selectedBook}
              onSelect={handleBookSelect}
              placeholder={_('searchBookTopic')}
              emptyText={_('noMatchingBooks')}
            />
            <button type="button" className="selector-stepper-btn" onClick={() => stepBook(1)} disabled={currentBookIndex < 0 || currentBookIndex >= bookAutocompleteOptions.length - 1}>+</button>
          </div>
        </label>

        {!sidebarCollapsed && selectedBook === 'physics-oup' && physicsChapterOptions.length > 0 && (
          <label>
            <span className="sidebar-label-icon">
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M4 5h16v2H4V5zm0 6h16v2H4v-2zm0 6h10v2H4v-2z" />
              </svg>
              {_('chapter')}
            </span>
            <div className="selector-stepper-row">
              <button type="button" className="selector-stepper-btn" onClick={() => stepPhysicsChapter(-1)} disabled={currentPhysicsChapterIndex <= 0}>-</button>
              <BookAutocomplete
                books={physicsChapterOptions}
                currentBook={currentPhysicsChapter}
                language={selectedLanguage}
                subjectId="physics-oup"
                onSelect={handlePhysicsChapterSelect}
                placeholder={_('searchChapter')}
                emptyText={_('noMatchingChapters')}
              />
              <button type="button" className="selector-stepper-btn" onClick={() => stepPhysicsChapter(1)} disabled={currentPhysicsChapterIndex < 0 || currentPhysicsChapterIndex >= physicsChapterOptions.length - 1}>+</button>
            </div>
          </label>
        )}

        {!sidebarCollapsed && sectionOptionsCount > 1 && !(selectedBook === 'physics-oup' && physicsChapterOptions.length > 0) && (
          <label>
            <span className="sidebar-label-icon">
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M3 4h18v2H3V4zm0 7h18v2H3v-2zm0 7h18v2H3v-2z" />
              </svg>
              {_('section')}
            </span>
            <div className="selector-stepper-row" data-autocomplete-id="section">
              <button type="button" className="selector-stepper-btn" onClick={() => { const idx = currentSectionIndex; if (idx > 0) { setSelectedFile(sectionSelectOptions[idx - 1].id); setSelectedPage(1); } else { moveBook(-1); } }}>-</button>
              <SectionAutocomplete
                sections={currentChapter?.contents || []}
                currentSection={currentSection}
                language={selectedLanguage}
                getSectionName={getSectionName}
                onSelect={(sectionId) => {
                  setSelectedFile(sectionId);
                  setSelectedPage(1);
                }}
              />
              <button type="button" className="selector-stepper-btn" onClick={() => { const idx = currentSectionIndex; const len = sectionSelectOptions.length; if (idx >= 0 && idx < len - 1) { setSelectedFile(sectionSelectOptions[idx + 1].id); setSelectedPage(1); } else { moveBook(1); } }}>+</button>
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
            <div data-autocomplete-id="page">
            <StepperSelect
              items={pageSelectOptions}
              value={selectedPage}
              onChange={(value) => setSelectedPage(Number(value))}
              onPrev={() => currentPageIndex > 0 && setSelectedPage(Number(pageOptions[currentPageIndex - 1]))}
              onNext={() => currentPageIndex >= 0 && currentPageIndex < pageOptions.length - 1 && setSelectedPage(Number(pageOptions[currentPageIndex + 1]))}
              disablePrev={currentPageIndex <= 0}
              disableNext={currentPageIndex < 0 || currentPageIndex >= pageOptions.length - 1}
              placeholder={String(selectedPage || 1)}
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
            {_('displayMode')}
          </span>
          <div className="toggle-group">
            <button
              className={`toggle-btn ${displayMode === 'pagination' ? 'active' : ''}`}
              onClick={() => { setDisplayMode('pagination'); }}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="4" y="3" width="16" height="18" rx="2" />
              </svg>
              {_('paginated')}
            </button>
            <button
              className={`toggle-btn ${displayMode === 'scrolling' ? 'active' : ''}`}
              onClick={() => { setDisplayMode('scrolling'); }}
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
              onClick={() => { setDisplayMode('thumbnails'); }}
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
            <a className="sidebar-account-btn" href={logoutUrl} data-tooltip={userId} aria-label={userId} onClick={logLogout}>
              <span className="sidebar-account-id"><code>{userId.slice(0, 6)}</code></span>
              <span className="sidebar-account-logout" aria-hidden="true">
                <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                  <path d="M10 17l1.41-1.41L8.83 13H20v-2H8.83l2.58-2.59L10 7l-5 5 5 5zm-6 3h8v-2H4V6h8V4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2z" fill="#12324a" />
                </svg>
              </span>
            </a>
            {isTestMode && (
            <button
              className="sidebar-icon-btn"
              onClick={() => { console.log('[debug] manual fit refresh'); refreshFitForCurrentMode(); }}
              data-tooltip="Refresh Fit"
              aria-label="Refresh Fit"
              style={{ background: '#fef3c7' }}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="#b45309"/>
              </svg>
            </button>
            )}
            {/* Subject selector – collapsed */}
            <button
              className="sidebar-icon-btn"
              ref={(el) => { collapsedBtnRefs.current.subject = el; }}
              onClick={() => openSidebarAutocomplete('subject')}
              data-tooltip={_('selectSubject')}
              aria-label={_('selectSubject')}
            ><span className="sidebar-icon-btn-text" ref={subjectBtnTextRef}>{getSubjectAbbreviation(selectedBook, selectedLanguage)}</span></button>
            {/* Book selector – collapsed */}
            <button
              className={`sidebar-icon-btn book-stepper${pressedAutocompleteBtn === 'book' ? ' pressed' : ''}`}
              ref={(el) => { collapsedBtnRefs.current.book = el; }}
              onClick={() => openSidebarAutocomplete('book')}
              data-tooltip={_('selectBook')}
              aria-label={_('selectBook')}
            ><span className="sidebar-icon-btn-text">{collapsedBookDisplay}</span></button>
            {/* Section selector – collapsed */}
            <button
              className={`sidebar-icon-btn section-stepper${pressedAutocompleteBtn === 'section' ? ' pressed' : ''}`}
              ref={(el) => { collapsedBtnRefs.current.section = el; }}
              onClick={() => openSidebarAutocomplete('section')}
              data-tooltip={_('selectSection')}
              aria-label={_('selectSection')}
            ><span className="sidebar-icon-btn-text">{collapsedSectionDisplay}</span></button>
            {/* Page selector – collapsed */}
            {maxNavigablePage > 1 && (
              <button
                className={`sidebar-icon-btn page-stepper${pressedAutocompleteBtn === 'page' ? ' pressed' : ''}`}
                ref={(el) => { collapsedBtnRefs.current.page = el; }}
                onClick={() => openSidebarAutocomplete('page')}
                data-tooltip={_('selectPage')}
                aria-label={_('selectPage')}
              ><span className="sidebar-icon-btn-text">{selectedPage}</span></button>
            )}
            <button
              className="sidebar-icon-btn"
              ref={(el) => { collapsedBtnRefs.current.displayMode = el; }}
              onClick={() => openSidebarAutocomplete('displayMode')}
              data-tooltip={_('displayMode')}
              aria-label={_('displayMode')}
            >
              {displayMode === 'thumbnails' ? (
                <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                  <rect x="3" y="4" width="6" height="7" rx="1.2" fill="#1f4d6c" />
                  <rect x="3" y="13" width="6" height="7" rx="1.2" fill="#1f4d6c" />
                  <rect x="11" y="4" width="10" height="16" rx="1.5" fill="#1f4d6c" />
                </svg>
              ) : displayMode === 'scrolling' ? (
                <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                  <rect x="3" y="3" width="18" height="4" rx="1" fill="#1f4d6c" />
                  <rect x="3" y="9" width="18" height="4" rx="1" fill="#1f4d6c" />
                  <rect x="3" y="15" width="18" height="4" rx="1" fill="#1f4d6c" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                  <rect x="4" y="3" width="16" height="18" rx="2" fill="#1f4d6c" />
                  <line x1="8" y1="8" x2="16" y2="8" stroke="#f4f9fc" strokeWidth="1.5" />
                  <line x1="8" y1="12" x2="16" y2="12" stroke="#f4f9fc" strokeWidth="1.5" />
                  <line x1="8" y1="16" x2="13" y2="16" stroke="#f4f9fc" strokeWidth="1.5" />
                </svg>
              )}
            </button>
            <button
              className={`sidebar-icon-btn${pressedAutocompleteBtn === 'language' ? ' pressed' : ''}`}
              ref={(el) => { collapsedBtnRefs.current.language = el; }}
              onClick={() => openSidebarAutocomplete('language')}
              data-tooltip={_('switchLanguage')}
              aria-label={_('switchLanguage')}
            ><span className="sidebar-icon-btn-text">{selectedLanguage === 'en' ? 'EN' : selectedLanguage === 'tc' ? '中' : '雙'}</span></button>
            <button
              className={`sidebar-icon-btn ${panelVisible ? 'active' : ''}`}
              onClick={() => setPanelVisible((current) => !current)}
              data-tooltip={_('toggleToolbar')}
              aria-label={_('toggleToolbar')}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="3" y="3" width="18" height="14" rx="2" fill={panelVisible ? '#ffffff' : '#1f4d6c'} />
                <rect x="6" y="7" width="12" height="2" rx="1" fill={panelVisible ? '#1f4d6c' : '#f4f9fc'} />
                <rect x="6" y="11" width="8" height="2" rx="1" fill={panelVisible ? '#1f4d6c' : '#f4f9fc'} />
              </svg>
            </button>

          </div>
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
      </aside>
  )}

      <main className="reader">
        <div
          className={`book-stage ${displayMode} ${isBilingualView ? 'bilingual-layout' : ''} tool-${tool}`}
          ref={stageRef}
          onClick={(e) => { handleStageClick(e); if (tool === 'text') handleCanvasClick(e); }}
          onContextMenu={handleStageContextMenu}
        >
          {/* ── Click coordinate debug marker ──────────────── */}
          {clickMarker && (
            <div
              className="click-marker"
              style={{ left: clickMarker.imgLeft + clickMarker.x, top: clickMarker.imgTop + clickMarker.y }}
            >
              <div className="click-marker-dot" />
              <span className="click-marker-label">
                CSS: ({Math.round(clickMarker.x)}, {Math.round(clickMarker.y)})
                {' · '}
                Img: ({Math.round(clickMarker.naturalX)}, {Math.round(clickMarker.naturalY)})
              </span>
            </div>
          )}
          {/* ── QR crop area dashed overlay (portal to body to escape stacking contexts) ── */}
          {qrCropRect && tool === 'hand' && createPortal(
            <div
              className="qr-crop-overlay"
              style={{
                left: qrCropRect.left,
                top: qrCropRect.top,
                width: qrCropRect.width,
                height: qrCropRect.height
              }}
            />,
            document.body
          )}
          {(pageLoading || (visibleLanguages.length === 0 && selectedChapter)) ? (
            <div className="page-loading">
              <div className="page-loading-spinner" />
              <p>{_('loadingPage') || 'Loading page…'}</p>
            </div>
          ) : (
            <>
            {visibleLanguages.map((language) => {
            const src = pageSources[language];
            const isImages = Array.isArray(src);
            return (
              <PdfPane
                key={language}
                paneLanguage={language}
                source={isImages ? '' : (src || '')}
                images={isImages ? src : null}
                title={`${getSubjectLabel(selectedBook, language)} · ${currentBookHeaderName}`}
                section={`${currentSectionHeaderId} - ${getSectionHeaderNameForLang(language)}`}
                mode={displayMode}
                currentPage={selectedPage}
                onPageChange={setSelectedPage}
                onPageCountChange={(count) => setPageCounts((current) => ({ ...current, [language]: count }))}
                thumbnailsOpen={showThumbnails}
                onThumbnailClick={(page) => {
                  setSelectedPage(page);
                  setDisplayMode('pagination');
                }}
                syncGroup={isBilingualView && displayMode === 'scrolling' ? `${selectedChapter}-${selectedFile}-bilingual` : ''}
                syncId={language}
                zoom={zoomLevel}
                thumbCols={thumbCols}
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
                onScrollCanvasesReady={() => setRedrawTick((t) => t + 1)}
                language={selectedLanguage}
              />
            );
          })}
          {textInputState && (
            <textarea
              ref={textInputRef}
              className="text-annotation-textarea"
              style={{
                left: textInputState.canvasX,
                top: textInputState.canvasY,
                color: textColor,
                borderColor: textColor,
              }}
              placeholder={_('textPlaceholder')}
              defaultValue={textInputState.initialText || ''}
              rows={2}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  commitTextAnnotation();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelTextAnnotation();
                }
              }}
              onBlur={() => {
                if (textInputCommittedRef.current) {
                  textInputCommittedRef.current = false;
                  return;
                }
                commitTextAnnotation();
              }}
            />
          )}
          </>
          )}
          <canvas
            ref={canvasRef}
            className="annotation-canvas"
            style={{
              pointerEvents: tool === 'hand' ? 'none' : 'auto',
              touchAction: tool === 'hand'
                ? (displayMode === 'scrolling' ? 'pan-y' : 'pan-x pan-y')
                : 'none',
              cursor: tool === 'move' ? 'move' : tool === 'eraser' ? 'pointer' : tool === 'text' ? 'text' : tool === 'pen' || tool === 'highlight' ? 'crosshair' : 'default'
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onPointerLeave={handlePointerUp}
            onClick={handleCanvasClick}
          />
        </div>

        {displayMode === 'scrolling' && jumpNotice && (
          <div className="jump-indicator" aria-live="polite">{jumpNotice}</div>
        )}

        {resourcesDrawerOpen && currentSection && (
          <div className="resources-drawer-overlay" onClick={() => setResourcesDrawerOpen(false)}>
            <section className="section-resources resources-drawer" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const tag = (e.target.tagName || '').toLowerCase(); if (tag !== 'input' && tag !== 'textarea' && !e.target.isContentEditable) { e.preventDefault(); } } if (e.key === 'Backspace') { const tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) { e.stopPropagation(); } } }}>
            <div className="ai-drawer-header">
              <h2>
                <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="ai-header-icon">
                  <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 0 0-5 5 5 5 0 0 0 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4a5 5 0 0 0 5-5 5 5 0 0 0-5-5z" />
                </svg>
                {_('resources')}
              </h2>
              <button className="modal-close" onClick={() => setResourcesDrawerOpen(false)} aria-label={_('close')}>✕</button>
            </div>
            <div className="ai-drawer-body">
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
            </div>
          </section>
          </div>
        )}

        {panelVisible && (
        <section
          className={`annotation-panel docked-bottom ${singleRowToolbar ? 'single-row' : ''} ${toolbarTight ? 'tight-space' : ''}`}
          ref={panelRef}
          style={{ left: '0', right: '0', bottom: '0', '--toolbar-scale': toolbarScale }}
        >
          <div className="panel-row-1">
          <div className="panel-main-controls" ref={mainControlsRef}>
          <div className="toolbar-group toolbar-primary" ref={primaryToolbarRef}>
            <button className="icon-btn" onClick={() => changePage(-1)} data-tooltip={displayMode === 'scrolling' ? _('jumpPrevPage') : _('prevPage')} aria-label={displayMode === 'scrolling' ? _('jumpPrevPage') : _('prevPage')}>&lt;</button>
            <button className="icon-btn" onClick={() => changePage(1)} data-tooltip={displayMode === 'scrolling' ? _('jumpNextPage') : _('nextPage')} aria-label={displayMode === 'scrolling' ? _('jumpNextPage') : _('nextPage')}>&gt;</button>
            {!fitDisabled && (
            <div className="tool-menu-wrapper">
              <div className="tool-split-btn">
                <button
                  className="tool-btn tool-split-main"
                  disabled={fitDisabled}
                  onClick={() => { setFitMode('none'); setZoomLevel(1); }}
                  data-tooltip={_('zoomLevel')}
                  aria-label={_('zoomLevel')}
                >
                  <span className="zoom-percent-label">{displayZoomPercent}%</span>
                </button>
                <button
                  className="tool-btn tool-split-arrow"
                  disabled={fitDisabled}
                  onClick={() => setZoomMenuOpen((prev) => !prev)}
                  data-tooltip={_('zoomLevel')}
                  aria-label={_('zoomLevel')}
                >
                  <svg viewBox="0 0 12 12" className="tool-menu-arrow" role="presentation" focusable="false">
                    <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              {zoomMenuOpen && (
                <div className="tool-menu-popup">
                  <div className="tool-menu-section-label">{_('zoomLevel')}</div>
                  <div className="tool-menu-zoom-slider">
                    <button
                      className="tool-menu-zoom-btn"
                      onClick={(e) => {
                        const delta = e.shiftKey ? -0.10 : e.ctrlKey ? -0.05 : -0.01;
                        changeZoom(delta);
                      }}
                      aria-label={_('zoomOut')}
                    >−</button>
                    <input
                      type="range"
                      className="tool-menu-zoom-range"
                      min="0.1"
                      max="5"
                      step="0.05"
                      value={zoomLevel}
                      onChange={(e) => { setFitMode('none'); setZoomLevel(Number(e.target.value)); }}
                      aria-label={_('zoomLevel')}
                    />
                    <button
                      className="tool-menu-zoom-btn"
                      onClick={(e) => {
                        const delta = e.shiftKey ? 0.10 : e.ctrlKey ? 0.05 : 0.01;
                        changeZoom(delta);
                      }}
                      aria-label={_('zoomIn')}
                    >+</button>
                  </div>
                  <span className="tool-menu-sep" />
                  <button
                    className={`tool-menu-item ${fitMode === 'width' ? 'active' : ''}`}
                    onClick={() => { setFitMode('width'); setZoomLevel(1); setFitRefreshToken((t) => t + 1); setZoomMenuOpen(false); }}
                  >
                    <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon">
                      <path d="M3 12l3.5-3.5 1.4 1.4-1.1 1.1h10.4l-1.1-1.1 1.4-1.4L21 12l-3.5 3.5-1.4-1.4 1.1-1.1H6.8l1.1 1.1-1.4 1.4L3 12zM5 5h14v3h-2V7H7v1H5V5zm0 11h2v1h10v-1h2v3H5v-3z" />
                    </svg>
                    {_('fitWidth')}
                  </button>
                  <button
                    className={`tool-menu-item ${fitMode === 'height' ? 'active' : ''}`}
                    onClick={() => { setFitMode('height'); setZoomLevel(1); setFitRefreshToken((t) => t + 1); setZoomMenuOpen(false); }}
                  >
                    <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="tool-menu-item-icon">
                      <path d="M12 3l3.5 3.5-1.4 1.4-1.1-1.1V17.2l1.1-1.1 1.4 1.4L12 21l-3.5-3.5 1.4-1.4 1.1 1.1V6.8L9.9 7.9 8.5 6.5 12 3zM5 5h3v2H7v10h1v2H5V5zm11 0h3v14h-3v-2h1V7h-1V5z" />
                    </svg>
                    {_('fitHeight')}
                  </button>
                </div>
              )}
            </div>
            )}
            {showThumbnails && (
              <>
                <span className="toolbar-sep" />
                <span className="zoom-label">{_('cols')}: {thumbCols}</span>
                <input
                  type="range"
                  className="cols-slider"
                  min="1"
                  max="8"
                  value={thumbCols}
                  onChange={(e) => setThumbCols(Number(e.target.value))}
                  data-tooltip={_('colsPerRow')}
                  aria-label={_('colsPerRow')}
                />
              </>
            )}

          </div>
          {displayMode !== 'thumbnails' && secondaryToolbar}
          <button
            className="tool-btn panel-close-btn panel-close-accent"
            ref={closeButtonRef}
            onClick={() => setPanelVisible(false)}
            data-tooltip={_('closePanel')}
            aria-label={_('closePanel')}
          >
            <svg viewBox="0 0 24 24" role="presentation" focusable="false">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
          </div>
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
                  <path d="M10 7L9.48415 8.39405C8.80774 10.222 8.46953 11.136 7.80278 11.8028C7.13603 12.4695 6.22204 12.8077 4.39405 13.4842L3 14L4.39405 14.5158C6.22204 15.1923 7.13603 15.5305 7.80278 16.1972C8.46953 16.864 8.80774 17.778 9.48415 19.6059L10 21L10.5158 19.6059C11.1923 17.778 11.5305 16.864 12.1972 16.1972C12.864 15.5305 13.778 15.1923 15.6059 14.5158L17 14L15.6059 13.4842C13.778 12.8077 12.864 12.4695 12.1972 11.8028C11.5305 11.136 11.1923 10.222 10.5158 8.39405L10 7Z" /><path d="M18 3L17.7789 3.59745C17.489 4.38087 17.3441 4.77259 17.0583 5.05833C16.7726 5.34408 16.3809 5.48903 15.5975 5.77892L15 6L15.5975 6.22108C16.3809 6.51097 16.7726 6.65592 17.0583 6.94167C17.3441 7.22741 17.489 7.61913 17.7789 8.40255L18 9L18.2211 8.40255C18.511 7.61913 18.6559 7.22741 18.9417 6.94166C19.2274 6.65592 19.6191 6.51097 20.4025 6.22108L21 6L20.4025 5.77892C19.6191 5.48903 19.2274 5.34408 18.9417 5.05833C18.6559 4.77259 18.511 4.38087 18.2211 3.59745L18 3Z" />
                </svg>
                {_('aiStudyMaterials')}
              </h2>

              <div className="ai-drawer-header-actions">
                {aiContent && !aiLoading && isTestMode && (
                  <button className="ai-regenerate-btn" onClick={() => handleAiGenerate(true, true)} title={_('regenerate')}>
                    <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                      <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                    </svg>
                    <span>{_('regenerate')}</span>
                  </button>
                )}
                {aiContent && !aiLoading && (
                  <button className="ai-reset-btn" onClick={handleResetAnswers} title={_('resetAnswers')}>
                    <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                      <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
                    </svg>
                    <span>{_('resetAnswers')}</span>
                  </button>
                )}
                <button className="modal-close" onClick={() => setAiDrawerOpen(false)} aria-label={_('close')}>✕</button>
              </div>
            </div>

            <div className="ai-drawer-body" onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                const tag = (e.target.tagName || '').toLowerCase();
                if (tag !== 'input' && tag !== 'textarea' && !e.target.isContentEditable) {
                  e.preventDefault(); // let window handler navigate pages instead
                }
              }
              // Don't close drawer on Backspace if user is interacting with answer inputs
              if (e.key === 'Backspace') {
                const tag = (e.target.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) {
                  e.stopPropagation(); // let user type normally, don't trigger drawer close
                }
              }
            }}>
              {isTestMode && (
                <div className="ai-lookup-key">
                  <strong>Lookup Key</strong>
                  <code>{JSON.stringify(aiLookupKey)}</code>
                </div>
              )}

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
              {/* Test mode: debug sections — organized as 2-step pipeline */}
              {aiDebug && (
                <div className="ai-debug-section">
                  <details className="ai-debug-details">
                    <summary className="ai-debug-summary">Client Request</summary>
                    <textarea
                      className="ai-debug-textarea"
                      readOnly
                      value={JSON.stringify(aiDebug.request, null, 2)}
                      rows={10}
                    />
                  </details>

                  {/* ── Step 1: Image → Text Extraction ── */}
                  <details className="ai-debug-details" open>
                    <summary className="ai-debug-summary">🔍 Step 1: Image → Text Extraction</summary>
                    <DebugSubSection label="Request payload" data={aiDebug.extractionRequest} />
                    <DebugSubSection label="Raw response (gateway)" data={aiDebug.extractionRaw} />
                  </details>

                  {/* ── Step 2: Text → Study Materials ── */}
                  <details className="ai-debug-details" open>
                    <summary className="ai-debug-summary">📝 Step 2: Text → Study Materials</summary>
                    <DebugSubSection label="Request payload" data={aiDebug.generationRequest} />
                    <DebugSubSection label="Raw response (gateway)" data={aiDebug.generationRaw} />
                  </details>
                </div>
              )}

              {!aiContent && !aiLoading && !aiError && (
                <div className="ai-empty">
                  <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="ai-empty-icon" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                    <path d="M10 7L9.48415 8.39405C8.80774 10.222 8.46953 11.136 7.80278 11.8028C7.13603 12.4695 6.22204 12.8077 4.39405 13.4842L3 14L4.39405 14.5158C6.22204 15.1923 7.13603 15.5305 7.80278 16.1972C8.46953 16.864 8.80774 17.778 9.48415 19.6059L10 21L10.5158 19.6059C11.1923 17.778 11.5305 16.864 12.1972 16.1972C12.864 15.5305 13.778 15.1923 15.6059 14.5158L17 14L15.6059 13.4842C13.778 12.8077 12.864 12.4695 12.1972 11.8028C11.5305 11.136 11.1923 10.222 10.5158 8.39405L10 7Z" />
                    <path d="M18 3L17.7789 3.59745C17.489 4.38087 17.3441 4.77259 17.0583 5.05833C16.7726 5.34408 16.3809 5.48903 15.5975 5.77892L15 6L15.5975 6.22108C16.3809 6.51097 16.7726 6.65592 17.0583 6.94167C17.3441 7.22741 17.489 7.61913 17.7789 8.40255L18 9L18.2211 8.40255C18.511 7.61913 18.6559 7.22741 18.9417 6.94166C19.2274 6.65592 19.6191 6.51097 20.4025 6.22108L21 6L20.4025 5.77892C19.6191 5.48903 19.2274 5.34408 18.9417 5.05833C18.6559 4.77259 18.511 4.38087 18.2211 3.59745L18 3Z" />
                  </svg>
                  <p>{_('aiEmptyPrompt')}</p>
                  <button className="ai-generate-btn" onClick={() => handleAiGenerate(true, false)}>{_('aiGenerate')}</button>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {searchDrawerOpen && (
        <div className="resources-drawer-overlay" onClick={() => setSearchDrawerOpen(false)}>
          <section className="ai-drawer search-drawer" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const tag = (e.target.tagName || '').toLowerCase(); if (tag !== 'input' && tag !== 'textarea' && !e.target.isContentEditable) { e.preventDefault(); } } if (e.key === 'Backspace') { const tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) { e.stopPropagation(); } } }}>
            <div className="ai-drawer-header">
              <h2>
                <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="ai-header-icon">
                  <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
                </svg>
                {_('search')}
              </h2>
              <button className="modal-close" onClick={() => setSearchDrawerOpen(false)} aria-label={_('close')}>✕</button>
            </div>
            <div className="ai-drawer-body">
              <div className="search-controls-sticky">
                <input
                  type="text"
                  className="search-input"
                  placeholder={_('searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <div className="search-scope-row">
                  <select
                    className="search-scope-select"
                    value={searchScope}
                    onChange={(e) => setSearchScope(e.target.value)}
                  >
                    <option value="page">{_('searchScopePage')}</option>
                    <option value="section">{_('searchScopeSection')}</option>
                    <option value="book">{_('searchScopeBook')}</option>
                    <option value="subject">{_('searchScopeSubject')}</option>
                    <option value="all">{_('searchScopeAll')}</option>
                  </select>
                  <label className="search-checkbox-label">
                    <input
                      type="checkbox"
                      checked={includeAnnotations}
                      onChange={(e) => setIncludeAnnotations(e.target.checked)}
                    />
                    <span>{_('searchIncludeAnnotations')}</span>
                  </label>
                </div>
              </div>
              {searchLoading && (
                <div className="ai-loading">
                  <div className="ai-spinner" />
                  <p>{_('searching')}</p>
                </div>
              )}
              {!searchLoading && searchResults.length > 0 && (
                <div className="search-results">
                  <p className="search-results-count">{_('searchResultsCount').replace('{count}', searchResults.length)}</p>
                  {searchResults.map((result, idx) => (
                    <button
                      key={result._id || idx}
                      className="search-result-item"
                      onClick={() => {
                        // Navigate to the result's page
                        const subjectChanged = result.subjectId && result.subjectId !== selectedBook;
                        if (subjectChanged) {
                          setSelectedBook(result.subjectId);
                        }
                        setSelectedChapter(result.bookId);
                        setSelectedFile(result.sectionId);
                        if (result.pageId) setSelectedPage(Number(result.pageId));
                        // Keep drawer open so user can try another result
                      }}
                    >
                      <div className="search-result-breadcrumb">
                        <span>{getSubjectLabel(result.subjectId, selectedLanguage)}</span>
                        <span className="breadcrumb-sep">›</span>
                        <span>{String(result.bookId || '').toUpperCase()}</span>
                        <span className="breadcrumb-sep">›</span>
                        <span>§{result.sectionId}</span>
                        {result.pageId != null && (
                          <>
                            <span className="breadcrumb-sep">›</span>
                            <span>p.{result.pageId}</span>
                          </>
                        )}
                        {result.source === 'annotation' && (
                          <span className="search-result-badge">{_('searchAnnotationBadge')}</span>
                        )}
                      </div>
                      {result.snippet && (
                        <p className="search-result-snippet">{result.snippet}</p>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {!searchLoading && searchQuery.trim() && searchResults.length === 0 && (
                <p className="search-no-results">{_('searchNoResults')}</p>
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
              <div className="modal-actions">
                <button
                  className="modal-copy-btn"
                  title={(_ && _('copyToClipboard')) || 'Copy URL to clipboard'}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(modalInfo.url);
                      const btn = document.activeElement;
                      if (btn) {
                        btn.textContent = '✓';
                        setTimeout(() => { btn.textContent = '📋'; }, 1500);
                      }
                    } catch { /* ignore */ }
                  }}
                >
                  📋
                </button>
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
              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                <iframe
                  ref={modalIframeRef}
                  src={modalFrameSrc}
                  className="modal-iframe"
                  title={_('resourceViewer')}
                  onLoad={handleModalFrameLoad}
                />
                {modalFrameFailed && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'rgba(255,255,255,0.92)',
                      padding: '24px',
                    }}
                  >
                    <button
                      type="button"
                      className="modal-open-link"
                      style={{
                        fontSize: '16px',
                        padding: '12px 18px',
                        width: 'auto',
                        minWidth: 'max-content',
                        height: 'auto',
                        borderRadius: '10px',
                        border: 'none',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        writingMode: 'horizontal-tb',
                        wordBreak: 'keep-all',
                        textOrientation: 'mixed',
                      }}
                      onClick={() => window.open(modalInfo.url, '_blank', 'noopener,noreferrer')}
                    >
                      {(_ && _('openInNewTab')) || 'Open in another tab'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Floating MP3 Player (draggable, always-on-top) ──── */}
      {floatingPlayer && (
        <FloatingAudioPlayer
          url={floatingPlayer.url}
          name={floatingPlayer.name}
          onClose={() => setFloatingPlayer(null)}
        />
      )}

      {/* ── Collapsed Sidebar Autocomplete Portals ──────────── */}
      {collapsedDropdownId && createPortal(
        <div
          className="collapsed-autocomplete-container"
          style={{
            position: 'fixed',
            top: collapsedDropdownPos.top,
            left: collapsedDropdownPos.left,
            zIndex: 10000,
          }}
        >
          {collapsedDropdownId === 'subject' && (
            <div data-collapsed-autocomplete="subject">
              <AutocompleteDropdown
                items={subjectAutocompleteItems}
                value={selectedBook}
                onSelect={(id) => { handleSubjectChange(id); setCollapsedDropdownId(null); }}
                onOpenChange={(open) => { if (!open) setCollapsedDropdownId(null); }}
                selectedDisplay={getSubjectLabel(selectedBook, selectedLanguage)}
                placeholder={_('subject')}
                emptyText={_('noMatchingBooks')}
                toggleAriaLabel="Select subject"
                alwaysOpen
              />
            </div>
          )}
          {collapsedDropdownId === 'book' && (
            <div data-collapsed-autocomplete="book">
              <BookAutocomplete
                books={bookAutocompleteOptions}
                currentBook={currentChapter}
                language={selectedLanguage}
                subjectId={selectedBook}
                onSelect={(book) => { handleBookSelect(book); setCollapsedDropdownId(null); }}
                onOpenChange={(open) => { if (!open) setCollapsedDropdownId(null); }}
                placeholder={_('searchBookTopic')}
                emptyText={_('noMatchingBooks')}
                alwaysOpen
              />
            </div>
          )}
          {collapsedDropdownId === 'section' && (
            <div data-collapsed-autocomplete="section">
              <SectionAutocomplete
                sections={currentChapter?.contents || []}
                currentSection={currentSection}
                language={selectedLanguage}
                getSectionName={getSectionName}
                onSelect={(sectionId) => {
                  setSelectedFile(sectionId);
                  setSelectedPage(1);
                  setCollapsedDropdownId(null);
                }}
                onOpenChange={(open) => { if (!open) setCollapsedDropdownId(null); }}
                alwaysOpen
              />
            </div>
          )}
          {collapsedDropdownId === 'page' && maxNavigablePage > 1 && (
            <div data-collapsed-autocomplete="page">
              <AutocompleteDropdown
                items={pageSelectOptions.map((item) => ({
                  id: item.id,
                  primary: item.label,
                  secondary: item.secondary || '',
                  searchText: [item.id, item.label, item.secondary].filter(Boolean).join('\n'),
                }))}
                value={selectedPage}
                onSelect={(id) => { setSelectedPage(Number(id)); setCollapsedDropdownId(null); }}
                onOpenChange={(open) => { if (!open) setCollapsedDropdownId(null); }}
                selectedDisplay={String(selectedPage)}
                placeholder={String(selectedPage || 1)}
                emptyText="No matching pages"
                toggleAriaLabel="Toggle page list"
                alwaysOpen
              />
            </div>
          )}
          {collapsedDropdownId === 'language' && (
            <div data-collapsed-autocomplete="language">
              <AutocompleteDropdown
                items={[
                  { id: 'bilingual', primary: _('bilingual'), searchText: _('bilingual') },
                  { id: 'en', primary: _('english'), searchText: _('english') },
                  { id: 'tc', primary: _('chinese'), searchText: _('chinese') },
                ]}
                value={selectedLanguage}
                onSelect={(id) => { setSelectedLanguage(id); setCollapsedDropdownId(null); }}
                onOpenChange={(open) => { if (!open) setCollapsedDropdownId(null); }}
                selectedDisplay={selectedLanguage === 'en' ? _('english') : selectedLanguage === 'tc' ? _('chinese') : _('bilingual')}
                placeholder={_('language')}
                emptyText=""
                toggleAriaLabel={_('switchLanguage')}
                hideFilter
                alwaysOpen
              />
            </div>
          )}
          {collapsedDropdownId === 'displayMode' && (
            <div
              data-collapsed-autocomplete="displayMode"
              className="collapsed-displaymode-menu"
            >
              <button
                className={`collapsed-displaymode-item ${displayMode === 'pagination' ? 'active' : ''}`}
                onClick={() => { setDisplayMode('pagination'); setCollapsedDropdownId(null); }}
              >
                <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="collapsed-displaymode-icon">
                  <rect x="4" y="3" width="16" height="18" rx="2" fill="currentColor" />
                  <line x1="8" y1="8" x2="16" y2="8" stroke="#f4f9fc" strokeWidth="1.5" />
                  <line x1="8" y1="12" x2="16" y2="12" stroke="#f4f9fc" strokeWidth="1.5" />
                  <line x1="8" y1="16" x2="13" y2="16" stroke="#f4f9fc" strokeWidth="1.5" />
                </svg>
                <span>{_('paginated')}</span>
              </button>
              <button
                className={`collapsed-displaymode-item ${displayMode === 'scrolling' ? 'active' : ''}`}
                onClick={() => { setDisplayMode('scrolling'); setCollapsedDropdownId(null); }}
              >
                <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="collapsed-displaymode-icon">
                  <rect x="3" y="3" width="18" height="4" rx="1" fill="currentColor" />
                  <rect x="3" y="9" width="18" height="4" rx="1" fill="currentColor" />
                  <rect x="3" y="15" width="18" height="4" rx="1" fill="currentColor" />
                </svg>
                <span>{_('scrollingMode')}</span>
              </button>
              <button
                className={`collapsed-displaymode-item ${displayMode === 'thumbnails' ? 'active' : ''}`}
                onClick={() => { setDisplayMode('thumbnails'); setCollapsedDropdownId(null); }}
              >
                <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="collapsed-displaymode-icon">
                  <rect x="3" y="4" width="6" height="7" rx="1.2" fill="currentColor" />
                  <rect x="3" y="13" width="6" height="7" rx="1.2" fill="currentColor" />
                  <rect x="11" y="4" width="10" height="16" rx="1.5" fill="currentColor" />
                </svg>
                <span>{_('thumbnailsMode')}</span>
              </button>
            </div>
          )}
        </div>,
        document.body
      )}

      {/* ── Color Picker Portal ──────────────────────────── */}
      {colorPickerOpen && createPortal(
        <>
          <div className="color-picker-overlay" onClick={() => setColorPickerOpen(false)} />
          <div
            className="color-picker-popover"
            style={colorPickerPos || {}}
          >
            <div className="color-picker-grid">
              {POPULAR_COLORS.map((c) => (
                <button
                  key={c}
                  className={`color-swatch ${c === textColor ? 'active' : ''}`}
                  style={{ background: c }}
                  onClick={() => {
                    setTextColor(c);
                    setColorPickerOpen(false);
                  }}
                  title={c}
                />
              ))}
            </div>
            <div className="color-picker-divider" />
            <button
              className="color-picker-custom-btn"
              onClick={() => {
                const input = customColorInputRef.current;
                if (!input) return;
                // Listen for the native picker to close, then close our popover
                const onClose = () => { setColorPickerOpen(false); input.removeEventListener('change', onClose); };
                input.addEventListener('change', onClose);
                input.click();
              }}
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="color-picker-custom-icon">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
              <span>{_('custom') || 'Custom…'}</span>
            </button>
          </div>
        </>,
        document.body
      )}

    </div>
  );
}

export default App;
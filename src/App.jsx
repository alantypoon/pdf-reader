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

function App() {
  const savedPrefs = loadPreferences();
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const currentStrokeRef = useRef(null);
  const displayModeInitializedRef = useRef(false);
  const [structure, setStructure] = useState([]);
  const [selectedChapter, setSelectedChapter] = useState(savedPrefs.selectedChapter || '1a');
  const [selectedFile, setSelectedFile] = useState(Number(savedPrefs.selectedFile || 1));
  const [selectedPage, setSelectedPage] = useState(Number(savedPrefs.selectedPage || 1));
  const [displayMode, setDisplayMode] = useState(savedPrefs.displayMode || 'scrolling');
  const [selectedLanguage, setSelectedLanguage] = useState(savedPrefs.selectedLanguage || 'bilingual');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(Boolean(savedPrefs.sidebarCollapsed));
  const [pageSources, setPageSources] = useState({});
  const [remarks, setRemarks] = useState([]);
  const [pageAnnotations, setPageAnnotations] = useState([]);
  const [tool, setTool] = useState(savedPrefs.tool || 'hand');
  const [textColor, setTextColor] = useState(savedPrefs.textColor || '#1f2937');
  const [noteText, setNoteText] = useState('');
  const [showThumbnails, setShowThumbnails] = useState(Boolean(savedPrefs.showThumbnails));
  const [zoomLevel, setZoomLevel] = useState(Number(savedPrefs.zoomLevel || 1));
  const [pageCounts, setPageCounts] = useState({});

  const fitScreen = () => {
    setZoomLevel(1);
  };

  useEffect(() => {
    fetch('/api/catalog')
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
    fetch('/api/remarks')
      .then((response) => response.json())
      .then((data) => setRemarks(data.remarks || []));
  }, []);

  useEffect(() => {
    const existing = remarks.filter(
      (remark) =>
        remark.chapter === selectedChapter &&
        Number(remark.page) === Number(selectedPage)
    );
    setPageAnnotations(existing);
  }, [remarks, selectedChapter, selectedPage]);

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
      const entries = await Promise.all(
        targets.map(async (language) => {
          const response = await fetch(`/api/page?chapter=${selectedChapter}&language=${language}&page=${selectedFile}`);
          const data = await response.json();
          return [language, data.url || ''];
        })
      );
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
      showThumbnails,
      zoomLevel
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
    showThumbnails,
    zoomLevel
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
    const nextBook = structure[nextIndex]?.id;
    if (nextBook) {
      setSelectedChapter(nextBook);
    }
  };

  const cycleDisplayMode = () => {
    setDisplayMode((current) => (current === 'scrolling' ? 'pagination' : 'scrolling'));
  };

  const cycleLanguage = () => {
    const order = ['bilingual', 'en', 'tc'];
    const index = order.indexOf(selectedLanguage);
    const next = order[(index + 1) % order.length];
    setSelectedLanguage(next);
  };

  const saveRemark = async (remark) => {
    const response = await fetch('/api/remarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(remark)
    });
    const data = await response.json();
    setRemarks(data.remarks || []);
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

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-title-row">
          <h1>PDF Reader</h1>
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
        <p>Local biology chapter viewer.</p>
        <label>
          Book
          <select value={selectedChapter} onChange={(event) => setSelectedChapter(event.target.value)}>
            {structure.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>{chapter.name || chapter.id}</option>
            ))}
          </select>
        </label>

        <label>
          Display mode
          <select value={displayMode} onChange={(event) => setDisplayMode(event.target.value)}>
            <option value="pagination">Pagination</option>
            <option value="scrolling">Scrolling</option>
          </select>
        </label>

        <label>
          Language
          <select value={selectedLanguage} onChange={(event) => setSelectedLanguage(event.target.value)}>
            <option value="bilingual">Bilingual</option>
            <option value="en">English</option>
            <option value="tc">Traditional Chinese</option>
          </select>
        </label>

        {!sidebarCollapsed && (
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={showThumbnails}
              onChange={(event) => setShowThumbnails(event.target.checked)}
            />
            <span className="toggle-label-with-icon">
              <span className="toggle-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                  <rect x="3" y="4" width="6" height="7" rx="1.2" />
                  <rect x="3" y="13" width="6" height="7" rx="1.2" />
                  <rect x="11" y="4" width="10" height="16" rx="1.5" />
                </svg>
              </span>
              <span>Show thumbnails</span>
            </span>
          </label>
        )}

        {sidebarCollapsed && (
          <div className="sidebar-icon-stack" aria-label="Collapsed sidebar controls">
            <button
              className="sidebar-icon-btn"
              onClick={cycleBook}
              title="Book"
              aria-label="Book"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M4 5a2 2 0 0 1 2-2h13v17H6a2 2 0 0 0-2 2V5zm2 0v13h11V5H6z" />
              </svg>
            </button>
            <button
              className="sidebar-icon-btn"
              onClick={cycleDisplayMode}
              title="Display mode"
              aria-label="Display mode"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="3" y="4" width="8" height="16" rx="1.5" />
                <rect x="13" y="4" width="8" height="16" rx="1.5" />
              </svg>
            </button>
            <button
              className="sidebar-icon-btn"
              onClick={cycleLanguage}
              title="Language"
              aria-label="Language"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M5 6h9v2H5V6zm2 4h5v2H7v-2zm7.5 0h2.4L20 18h-2.1l-.7-2h-3l-.7 2h-2.1l3.2-8zm.2 4h1.7l-.8-2.3-.9 2.3z" />
              </svg>
            </button>
            <button
              className={`sidebar-icon-btn ${showThumbnails ? 'active' : ''}`}
              onClick={() => setShowThumbnails((current) => !current)}
              title="Show thumbnails"
              aria-label="Show thumbnails"
            >
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <rect x="3" y="4" width="6" height="7" rx="1.2" />
                <rect x="3" y="13" width="6" height="7" rx="1.2" />
                <rect x="11" y="4" width="10" height="16" rx="1.5" />
              </svg>
            </button>
          </div>
        )}

        {!sidebarCollapsed && (
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
        )}
      </aside>

      <main className="reader">
        <div className={`book-stage ${displayMode} ${isBilingualView ? 'bilingual-layout' : ''}`}>
          {visibleLanguages.map((language) => (
            <PdfPane
              key={language}
              source={pageSources[language]}
              title={`${language === 'en' ? 'English' : '中文'} · ${currentChapter?.name || selectedChapter}`}
              mode={displayMode}
              currentPage={selectedPage}
              onPageChange={setSelectedPage}
              onPageCountChange={(count) => setPageCounts((current) => ({ ...current, [language]: count }))}
              thumbnailsOpen={showThumbnails}
              syncGroup={isBilingualView && displayMode === 'scrolling' ? `${selectedChapter}-${selectedFile}-bilingual` : ''}
              syncId={language}
              zoom={zoomLevel}
            />
          ))}
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

        {currentSection && (
          <section className="section-resources">
            {(selectedLanguage === 'bilingual' || selectedLanguage === 'en') && (
              <div className="resources-column">
                <h3>{getSectionName(currentSection, 'en')}</h3>
                {getSectionResources(currentSection, 'en').length === 0 ? (
                  <p className="resources-empty">No resources</p>
                ) : (
                  <ul>
                    {getSectionResources(currentSection, 'en').map((resource) => (
                      <li key={resource.url || resource.name}>
                        <a href={resource.url} target="_blank" rel="noopener noreferrer">
                          {resource.name}
                        </a>
                        {resource.type && <span className="resource-type">{resource.type}</span>}
                        <span className="resource-url">{resource.url}</span>
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
                        <a href={resource.url} target="_blank" rel="noopener noreferrer">
                          {resource.name}
                        </a>
                        {resource.type && <span className="resource-type">{resource.type}</span>}
                        <span className="resource-url">{resource.url}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}

        <section className="annotation-panel">
          <div className="toolbar-group toolbar-primary">
            <span className="toolbar-label">Primary</span>
            <button onClick={() => moveSection(-1)}>|&lt;</button>
            <button onClick={() => changePage(-1)}>&lt;</button>
            <button onClick={() => changePage(1)}>&gt;</button>
            <button onClick={() => moveSection(1)}>&gt;|</button>
            <button className="icon-btn" onClick={fitScreen} title="Fit screen" aria-label="Fit screen">
              <svg viewBox="0 0 24 24" role="presentation" focusable="false">
                <path d="M4 9V4h5v2H6v3H4zm10-5h6v6h-2V6h-4V4zM6 16h3v2H4v-5h2v3zm12-3h2v5h-6v-2h4v-3z" />
              </svg>
            </button>
            <button onClick={() => changeZoom(-0.1)}>-</button>
            <span className="zoom-indicator">{Math.round(zoomLevel * 100)}%</span>
            <button onClick={() => changeZoom(0.1)}>+</button>
          </div>
          <div className="toolbar-group toolbar-secondary">
            <button className={tool === 'pen' ? 'active' : ''} onClick={() => setTool('pen')}>Pen</button>
            <button className={tool === 'text' ? 'active' : ''} onClick={() => setTool('text')}>Text</button>
            <button className={tool === 'highlight' ? 'active' : ''} onClick={() => setTool('highlight')}>Highlighter</button>
            <input type="color" value={textColor} onChange={(event) => setTextColor(event.target.value)} />
            <input value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="Remark" />
            <button onClick={() => saveRemark({
              type: 'text',
              chapter: selectedChapter,
              page: selectedPage,
              color: textColor,
              text: noteText,
              createdAt: new Date().toISOString()
            })}>Save</button>
          </div>
        </section>

        <section className="remarks">
          <h3>Saved remarks</h3>
          {pageAnnotations.map((remark, index) => (
            <article key={`${remark.createdAt}-${index}`} style={{ borderColor: remark.color || '#d1d5db' }}>
              <strong>{remark.type}</strong>
              <p>{remark.text || remark.mode}</p>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}

export default App;
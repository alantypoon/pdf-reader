import React, { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import FontSizeControl from './FontSizeControl';

const LIMIT = 20;

function getSectionNameFromStructure(structure, currentSubject, subjectId, bookId, sectionId, language) {
  if (String(subjectId) !== String(currentSubject)) return '';
  const chapter = (structure || []).find((c) => String(c.id) === String(bookId));
  if (!chapter?.contents) return '';
  const section = chapter.contents.find((item) => {
    const itemId = item.page ?? item.section;
    return String(itemId) === String(sectionId);
  });
  if (!section) return '';
  const val = section?.[language];
  if (!val) {
    const fallback = section?.[language === 'tc' ? 'en' : 'tc'];
    if (!fallback) return '';
    if (typeof fallback === 'string') return fallback;
    return fallback.name || '';
  }
  if (typeof val === 'string') return val;
  return val.name || '';
}

function getSubjectShortName(subjectId, selectedLanguage = 'en') {
  const normalized = String(subjectId || '').trim().toLowerCase();
  const showChinese = selectedLanguage === 'tc';
  if (normalized === 'biology-oup') return showChinese ? '生物' : 'Bio';
  if (normalized === 'chemistry-aristo') return showChinese ? '化學' : 'Chem';
  if (normalized === 'chemistry-winter') return showChinese ? '化學.W' : 'Chem.W';
  if (normalized === 'math-oup') return showChinese ? '數學' : 'Math';
  if (normalized === 'physics-oup') return showChinese ? '物理' : 'Phy';
  return String(subjectId || '').slice(0, 6);
}

function extractSummaryText(aiContent, language) {
  if (!aiContent) return '';
  const langKey = language === 'tc' ? 'zh' : 'en';
  const fallbackKey = language === 'tc' ? 'en' : 'zh';
  const content = aiContent[langKey] || aiContent[language] || aiContent[fallbackKey] || null;
  if (!content) return '';
  if (Array.isArray(content.summary)) {
    return content.summary.map((s) => (typeof s === 'string' ? s : s?.text || '')).join(' ').slice(0, 300);
  }
  return '';
}

export default function BookmarksDrawer({ lang, userId, onClose, onNavigate, onKeyDown, structure, selectedLanguage, currentSubject, refreshToken, subjectOptions = [], selectedSubjects = [], onSelectedSubjectsChange, drawerFontSize, onDrawerFontSizeChange }) {
  const _ = (key) => t(key, lang);
  const displayLang = selectedLanguage === 'tc' ? 'tc' : 'en';

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('time');
  const [order, setOrder] = useState('desc');
  const [summaries, setSummaries] = useState({});
  const [flashId, setFlashId] = useState(null);
  const filterRef = useRef('');
  const sortRef = useRef('time');
  const orderRef = useRef('desc');
  const scrollRef = useRef(null);
  const flashTimerRef = useRef(null);

  const buildUrl = useCallback((currentOffset) => {
    const params = new URLSearchParams({
      userId,
      limit: LIMIT,
      offset: currentOffset,
      sort: sortRef.current,
      order: orderRef.current,
    });
    return `api/bookmarks?${params}`;
  }, [userId]);

  const load = useCallback(async (reset = false) => {
    const currentOffset = reset ? 0 : offset;
    if (reset) { setLoading(true); } else { setLoadingMore(true); }
    try {
      const res = await fetch(buildUrl(currentOffset));
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (reset) {
        setItems(data.items);
        setOffset(data.items.length);
        // Flash the newest item if it was just created/updated
        if (data.items.length > 0) {
          const newest = data.items[0];
          const ts = new Date(newest.updatedAt || newest.createdAt).getTime();
          if (Date.now() - ts < 5000) {
            setFlashId(String(newest._id));
            if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
            flashTimerRef.current = setTimeout(() => setFlashId(null), 1500);
          }
        }
      } else {
        setItems((prev) => [...prev, ...data.items]);
        setOffset(currentOffset + data.items.length);
      }
      setTotal(data.total);
    } catch (err) {
      console.error('[bookmarks] load error:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [buildUrl, offset]);

  // initial load
  useEffect(() => {
    filterRef.current = '';
    sortRef.current = 'time';
    orderRef.current = 'desc';
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload when parent signals a new bookmark was added
  const prevTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken !== prevTokenRef.current) {
      prevTokenRef.current = refreshToken;
      load(true);
    }
  }, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyFilter = useCallback((value) => {
    setFilter(value);
  }, []);

  const applySort = useCallback((newSort) => {
    if (sortRef.current === newSort) {
      const newOrder = orderRef.current === 'asc' ? 'desc' : 'asc';
      orderRef.current = newOrder;
      setOrder(newOrder);
    } else {
      sortRef.current = newSort;
      setSort(newSort);
    }
    load(true);
  }, [load]);

  const handleDelete = useCallback(async (id) => {
    try {
      const res = await fetch(`api/bookmarks/${id}`, { method: 'DELETE', headers: { 'X-User-Id': userId } });
      if (!res.ok) throw new Error(await res.text());
      setItems((prev) => prev.filter((item) => String(item._id) !== String(id)));
      setTotal((prev) => prev - 1);
    } catch (err) {
      console.error('[bookmarks] delete error:', err);
    }
  }, [userId]);

  // Infinite scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loadingMore || offset >= total) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      load(false);
    }
  }, [load, loadingMore, offset, total]);

  // Fetch AI summaries for loaded items
  const fetchSummaries = useCallback(async (bookmarkItems) => {
    const toFetch = bookmarkItems.filter((item) => {
      const key = `${item.subjectId}|${item.bookId}|${item.sectionId}|${item.pageId}`;
      return !summaries[key];
    });
    if (!toFetch.length) return;
    const results = {};
    await Promise.all(toFetch.map(async (item) => {
      const key = `${item.subjectId}|${item.bookId}|${item.sectionId}|${item.pageId}`;
      try {
        const res = await fetch(
          `api/ai-content?subjectId=${encodeURIComponent(item.subjectId)}&bookId=${encodeURIComponent(item.bookId)}&sectionId=${item.sectionId}&pageId=${item.pageId}`
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data.content) results[key] = data.content;
      } catch { /* ignore */ }
    }));
    if (Object.keys(results).length) {
      setSummaries((prev) => ({ ...prev, ...results }));
    }
  }, [summaries]);

  // Trigger summary fetch when items change
  useEffect(() => {
    if (items.length) fetchSummaries(items);
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!flashId || !scrollRef.current) return;
    const row = scrollRef.current.querySelector(`[data-bookmark-id="${flashId}"]`);
    if (row) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [flashId]);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  const normalizedFilter = filter.trim().toLowerCase();
  const visibleItems = items.filter((item) => {
    if (selectedSubjects.length && !selectedSubjects.includes(item.subjectId)) return false;
    if (!normalizedFilter) return true;
    const sectionName = getSectionNameFromStructure(structure, currentSubject, item.subjectId, item.bookId, item.sectionId, displayLang);
    const aiKey = `${item.subjectId}|${item.bookId}|${item.sectionId}|${item.pageId}`;
    const aiData = summaries[aiKey];
    const summary = extractSummaryText(aiData, displayLang);
    const haystack = [
      item.subjectId,
      item.bookId,
      item.sectionId,
      item.pageId,
      sectionName,
      summary,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(normalizedFilter);
  });

  return (
    <div
      className="resources-drawer-overlay"
      onClick={onClose}
    >
      <section
        className="ai-drawer bookmarks-drawer"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="ai-drawer-header">
          <h2>
            <svg viewBox="0 0 24 24" role="presentation" focusable="false" className="ai-header-icon" fill="currentColor">
              <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
            </svg>
            {_('bookmarks')}
          </h2>
          <div className="ai-drawer-header-actions">
            <FontSizeControl value={drawerFontSize} onChange={onDrawerFontSizeChange} lang={lang} />
            <button className="modal-close" onClick={onClose} aria-label={_('close')}>✕</button>
          </div>
        </div>

        <div className="bookmarks-controls">
          <input
            type="text"
            className="search-input"
            placeholder={_('bookmarksFilter')}
            value={filter}
            onChange={(e) => applyFilter(e.target.value)}
          />
          <div className="search-subject-filters bookmark-subject-filters">
            {subjectOptions.map((subj) => (
              <label key={subj.id} className="search-checkbox-label">
                <input
                  type="checkbox"
                  checked={selectedSubjects.includes(subj.id)}
                  onChange={(e) => {
                    if (!onSelectedSubjectsChange) return;
                    onSelectedSubjectsChange((prev) => {
                      const current = Array.isArray(prev) ? prev : [];
                      const next = e.target.checked
                        ? [...new Set([...current, subj.id])]
                        : current.filter((id) => id !== subj.id);
                      return next.length ? next : current;
                    });
                  }}
                />
                <span>{subj.label}</span>
              </label>
            ))}
          </div>
          <div className="bookmarks-sort-row">
            <span className="search-filter-label">{_('bookmarksSortBy')}</span>
            {['time', 'alpha', 'section'].map((s) => (
              <button
                key={s}
                className={`bookmarks-sort-btn ${sort === s ? 'active' : ''}`}
                onClick={() => applySort(s)}
              >
                {_(`bookmarksSortBy_${s}`)}{sort === s ? (order === 'asc' ? ' ↑' : ' ↓') : ''}
              </button>
            ))}
          </div>
        </div>

        <div className="ai-drawer-body bookmarks-list" ref={scrollRef} onScroll={handleScroll} style={{ fontSize: `${drawerFontSize}px` }}>
          {loading && (
            <div className="ai-loading">
              <div className="ai-spinner" />
              <p>{_('loading')}</p>
            </div>
          )}
          {!loading && visibleItems.length === 0 && (
            <p className="resources-empty">{_('bookmarksEmpty')}</p>
          )}
          {!loading && visibleItems.map((item) => {
            const sectionName = getSectionNameFromStructure(structure, currentSubject, item.subjectId, item.bookId, item.sectionId, displayLang);
            const aiKey = `${item.subjectId}|${item.bookId}|${item.sectionId}|${item.pageId}`;
            const aiData = summaries[aiKey];
            const summary = extractSummaryText(aiData, displayLang);
            return (
            <div
              key={String(item._id)}
              data-bookmark-id={String(item._id)}
              className={`bookmark-item${flashId === String(item._id) ? ' bookmark-flash' : ''}`}
            >
              <button
                className="bookmark-item-main"
                onClick={() => onNavigate(item)}
              >
                <div className="bookmark-item-meta">
                  <span className="bookmark-breadcrumb">
                    <span>{getSubjectShortName(item.subjectId, selectedLanguage)}</span>
                    <span className="bookmark-breadcrumb-sep">›</span>
                    <span>{String(item.bookId || '').toUpperCase()}</span>
                    <span className="bookmark-breadcrumb-sep">›</span>
                    <span>§{item.sectionId}</span>
                    <span className="bookmark-breadcrumb-sep">›</span>
                    <span>p.{item.pageId}</span>
                  </span>
                  {sectionName && <span className="bookmark-badge bookmark-lang">{sectionName}</span>}
                  <span className="bookmark-date">{formatDate(item.updatedAt || item.createdAt)}</span>
                </div>
                {filter && summary ? (
                  <p className="bookmark-summary bookmark-summary-filtered">
                    {highlightMatch(summary, filter)}
                  </p>
                ) : summary ? (
                  <p className="bookmark-summary">{summary}</p>
                ) : null}
              </button>
              <button
                className="bookmark-delete-btn"
                onClick={() => handleDelete(item._id)}
                aria-label={_('delete')}
                title={_('delete')}
              >
                <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="currentColor" width="16" height="16">
                  <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                </svg>
              </button>
            </div>
          );})}
          {loadingMore && (
            <div className="ai-loading" style={{ padding: '8px 0' }}>
              <div className="ai-spinner" style={{ width: 20, height: 20 }} />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function highlightMatch(text, query) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  // Show a snippet around the match
  const start = Math.max(0, idx - 60);
  const snippet = (start > 0 ? '…' : '') + before.slice(start) + match + after.slice(0, 120) + (after.length > 120 ? '…' : '');
  return (
    <>
      {(start > 0 ? '…' : '') + before.slice(start)}
      <mark className="bookmark-highlight">{match}</mark>
      {after.slice(0, 120)}{after.length > 120 ? '…' : ''}
    </>
  );
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

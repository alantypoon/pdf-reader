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

function normalizeExtractText(value, preserveLineBreaks = false) {
  if (typeof value !== 'string') return '';
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return '';
  if (preserveLineBreaks) return normalized;
  return normalized.replace(/\s+/g, ' ');
}

function buildInlineExtract(text, query = '', maxChars = 180) {
  const safeText = normalizeExtractText(text);
  if (!safeText) return '';
  const safeQuery = normalizeExtractText(query);
  if (safeQuery) {
    const idx = safeText.toLowerCase().indexOf(safeQuery.toLowerCase());
    if (idx >= 0) {
      const contextRadius = Math.max(40, Math.floor((maxChars - safeQuery.length) / 2));
      const start = Math.max(0, idx - contextRadius);
      const end = Math.min(safeText.length, idx + safeQuery.length + contextRadius);
      let snippet = safeText.slice(start, end);
      if (start > 0) snippet = `…${snippet}`;
      if (end < safeText.length) snippet = `${snippet}…`;
      return snippet;
    }
  }
  if (safeText.length <= maxChars) return safeText;
  return `${safeText.slice(0, maxChars).trimEnd()}…`;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildShareUrl(item) {
  const base = `${window.location.origin}${window.location.pathname}`;
  const params = new URLSearchParams({
    subject: item.subjectId,
    book: item.bookId,
    section: String(item.sectionId),
    page: String(item.pageId),
  });
  return `${base}?${params.toString()}`;
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
  const [textExtracts, setTextExtracts] = useState({});
  const [flashId, setFlashId] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
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

  const handleShare = useCallback(async (item) => {
    const url = buildShareUrl(item);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(String(item._id));
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Fallback: use Swal if available, else prompt
      const msg = `${_('bookmarkShareIconFailedHint')}\n${url}`;
      if (window.Swal) {
        window.Swal.fire({ title: _('bookmarkShareIconFailed'), text: msg, icon: 'info' });
      } else {
        window.prompt(_('bookmarkShareIconFailed'), url);
      }
    }
  }, [_]);

  // Infinite scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loadingMore || offset >= total) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      load(false);
    }
  }, [load, loadingMore, offset, total]);

  // Fetch stored page text extracts for loaded items
  const fetchTextExtracts = useCallback(async (bookmarkItems) => {
    const toFetch = bookmarkItems.filter((item) => {
      const key = `${item.subjectId}|${item.bookId}|${item.sectionId}|${item.pageId}|${displayLang}`;
      return !(key in textExtracts);
    });
    if (!toFetch.length) return;
    const results = {};
    await Promise.all(toFetch.map(async (item) => {
      const key = `${item.subjectId}|${item.bookId}|${item.sectionId}|${item.pageId}|${displayLang}`;
      try {
        const res = await fetch(
          `api/ai-content?subjectId=${encodeURIComponent(item.subjectId)}&bookId=${encodeURIComponent(item.bookId)}&sectionId=${item.sectionId}&pageId=${item.pageId}&language=${displayLang}`
        );
        if (!res.ok) return;
        const data = await res.json();
        results[key] = normalizeExtractText(data.textExtract || '', true);
      } catch { /* ignore */ }
    }));
    if (Object.keys(results).length) {
      setTextExtracts((prev) => ({ ...prev, ...results }));
    }
  }, [displayLang, textExtracts]);

  // Trigger text-extract fetch when items or display language change
  useEffect(() => {
    if (items.length) fetchTextExtracts(items);
  }, [items, displayLang]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const extractKey = `${item.subjectId}|${item.bookId}|${item.sectionId}|${item.pageId}|${displayLang}`;
    const pageExtract = normalizeExtractText(textExtracts[extractKey], true);
    const haystack = [
      item.subjectId,
      item.bookId,
      item.sectionId,
      item.pageId,
      sectionName,
      pageExtract,
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
            const extractKey = `${item.subjectId}|${item.bookId}|${item.sectionId}|${item.pageId}|${displayLang}`;
            const fullTextExtract = normalizeExtractText(textExtracts[extractKey], true);
            const inlineExtract = buildInlineExtract(fullTextExtract, filter);
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
                {filter && inlineExtract ? (
                  <p className="bookmark-summary bookmark-summary-filtered" title={fullTextExtract || undefined}>
                    {highlightMatch(inlineExtract, filter)}
                  </p>
                ) : inlineExtract ? (
                  <p className="bookmark-summary" title={fullTextExtract || undefined}>{inlineExtract}</p>
                ) : null}
              </button>
              <button
                className={`bookmark-share-btn${copiedId === String(item._id) ? ' copied' : ''}`}
                onClick={() => handleShare(item)}
                aria-label={_('bookmarkShareIconTitle')}
                title={copiedId === String(item._id) ? _('bookmarkShareIconCopied') : _('bookmarkShareIconTitle')}
              >
                {copiedId === String(item._id) ? (
                  <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="currentColor" width="16" height="16">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" role="presentation" focusable="false" fill="currentColor" width="16" height="16">
                    <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" />
                  </svg>
                )}
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
  const regex = new RegExp(`(${escapeRegExp(query)})`, 'ig');
  const parts = String(text).split(regex);
  if (parts.length === 1) return text;
  const lowerQuery = String(query).toLowerCase();
  return parts.map((part, index) => (
    part.toLowerCase() === lowerQuery
      ? <mark key={`${part}-${index}`} className="bookmark-highlight">{part}</mark>
      : <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>
  ));
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

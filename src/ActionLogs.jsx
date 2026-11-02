import React, { useCallback, useEffect, useRef, useState } from 'react';
import './actionLogs.css';

const BASE = import.meta.env.BASE_URL;
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Hong_Kong',
});

export default function ActionLogs({ targetUser = '' }) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('datetime');
  const [direction, setDirection] = useState('desc');
  const [items, setItems] = useState([]);
  const [userId, setUserId] = useState('');
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);
  const requestRef = useRef(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const loadPage = useCallback(async (nextCursor, generation) => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ search: query, sort, direction, limit: '50' });
      if (nextCursor) params.set('cursor', nextCursor);
      const endpoint = `${BASE}api/user-actions${targetUser ? `/${targetUser}` : ''}`;
      const response = await fetch(`${endpoint}?${params}`, {
        signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-store',
      });
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('Your session may have expired. Sign in again, then retry.');
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Unable to load logs (${response.status}).`);
      if (!Array.isArray(data.items) || !(data.nextCursor === null || typeof data.nextCursor === 'string')) {
        throw new Error('The server returned an invalid log response.');
      }
      if (generation !== generationRef.current) return;
      setItems((previous) => nextCursor ? [...previous, ...data.items] : data.items);
      setUserId(data.userId);
      setCursor(data.nextCursor);
      setHasMore(data.nextCursor !== null);
    } catch (failure) {
      if (controller.signal.aborted || generation !== generationRef.current) return;
      console.error('[action-logs] failed to load logs:', failure);
      setError(failure.message);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [query, sort, direction, targetUser]);

  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    const generation = ++generationRef.current;
    setItems([]);
    setCursor(null);
    setHasMore(true);
    scrollRef.current?.scrollTo({ top: 0 });
    loadPage(null, generation);
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [loadPage]);

  useEffect(() => {
    if (loading || error || !hasMore) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) loadPage(cursor, generationRef.current);
    }, { root: scrollRef.current, rootMargin: '300px' });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [cursor, error, hasMore, loading, loadPage]);

  return (
    <main className="action-logs">
      <header className="action-logs-header">
        <div>
          <a href={BASE}>Back to PDF Reader</a>
          <h1>{targetUser ? `Action logs: ${userId || targetUser}` : 'My action logs'}</h1>
          <p>{userId ? `Showing logs for ${userId}. ` : ''}Dates and times are shown in Hong Kong time (UTC+8).</p>
        </div>
      </header>
      <form className="action-logs-controls" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); }}>
        <label className="action-logs-search">
          Search logs
          <input type="search" value={search} maxLength={200} placeholder="Search actions, books, sections or dates"
            onChange={(event) => setSearch(event.target.value)} />
        </label>
        <label>
          Sort by
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="datetime">Datetime</option>
            <option value="bookName">Book name</option>
            <option value="sectionName">Section name</option>
          </select>
        </label>
        <label>
          Direction
          <select value={direction} onChange={(event) => setDirection(event.target.value)}>
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>
      </form>
      <div className="action-logs-scroll" ref={scrollRef} tabIndex={0} role="region" aria-label="Action log results" aria-busy={loading}>
        <table>
          <thead><tr>
            <th scope="col">Datetime (HKT)</th><th scope="col">Action</th><th scope="col">Subject</th>
            <th scope="col">Book name</th><th scope="col">Section name</th><th scope="col">Page</th><th scope="col">Details</th>
          </tr></thead>
          <tbody>
            {items.map((item) => {
              const date = new Date(item.createdAt);
              return (
                <tr key={item.id}>
                  <td>{Number.isNaN(date.getTime()) ? item.createdAt || '-' : <time dateTime={item.createdAt}>{dateFormatter.format(date)}</time>}</td>
                  <td>{item.actionType?.replaceAll('_', ' ') || '-'}</td>
                  <td>{item.subjectId || '-'}</td>
                  <td>{item.bookName || item.chapter || '-'}</td>
                  <td>{item.sectionName || item.section || '-'}</td>
                  <td>{item.page ?? '-'}</td>
                  <td>
                    {item.language && <span>{item.language.toUpperCase()} </span>}
                    {Number.isFinite(item.durationMs) && <span>{(item.durationMs / 1000).toFixed(1)}s </span>}
                    {item.metadata && <details><summary>More</summary><pre>{JSON.stringify(item.metadata, null, 2)}</pre></details>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="action-logs-status" role="status" aria-live="polite">
          {loading && 'Loading logs...'}
          {!loading && !error && !items.length && (query ? 'No logs match your search.' : 'No action logs yet.')}
          {!loading && !error && items.length > 0 && `${items.length} logs loaded.${hasMore ? ' Scroll down for more.' : ' End of logs.'}`}
        </div>
        {error && <div className="action-logs-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => loadPage(cursor, generationRef.current)}>Retry</button>
          {' '}<a href={`${BASE}logs${targetUser ? `/${targetUser}` : ''}`}>Sign in / reload</a>
        </div>}
        <div ref={sentinelRef} className="action-logs-sentinel" aria-hidden="true" />
      </div>
    </main>
  );
}

import React, { useMemo, useRef, useState } from 'react';

function compareNaturalIds(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  const aNum = Number(a);
  const bNum = Number(b);
  const aIsNum = a !== '' && Number.isFinite(aNum);
  const bIsNum = b !== '' && Number.isFinite(bNum);

  if (aIsNum && bIsNum) {
    if (aNum !== bNum) return aNum - bNum;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }
  if (aIsNum) return -1;
  if (bIsNum) return 1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function stripLeadingId(label, id) {
  const text = String(label || '').trim();
  const normalizedId = String(id || '').trim();
  if (!text || !normalizedId) return text;
  const escapedId = normalizedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^${escapedId}\\s*[-:]\\s*`, 'i'), '').trim();
}

function getBookSeparator(subjectId) {
  return String(subjectId || '').trim().toLowerCase() === 'chemistry-winter' ? ' ' : ' - ';
}

function getBookPrimaryLabel(item, subjectId, language) {
  if (!item) return '';
  const id = String(item.id || '').trim();
  const normalizedSubjectId = String(subjectId || '').trim().toLowerCase();
  if (normalizedSubjectId === 'biology-oup') {
    return id.toUpperCase();
  }
  const fallbackName = stripLeadingId(item.name, id);
  const nameEn = stripLeadingId(item.nameEn, id) || fallbackName;
  const nameZh = stripLeadingId(item.nameZh, id);
  const separator = getBookSeparator(subjectId);

  let label = '';
  if (language === 'bilingual') {
    label = nameEn || nameZh;
  } else if (language === 'tc') {
    label = nameZh || nameEn;
  } else {
    label = nameEn || nameZh;
  }

  if (id && label) {
    return `${id}${separator}${label}`;
  }
  return label || id.toUpperCase();
}

function BookAutocomplete({ books, onSelect, currentBook, language, subjectId, placeholder, emptyText }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef(null);

  const filtered = useMemo(() => {
    const sortedBooks = [...(books || [])].sort((a, b) => compareNaturalIds(a.id, b.id));
    if (!query.trim()) return sortedBooks;
    const lower = query.toLowerCase();
    return sortedBooks.filter((item) => {
      const id = String(item.id || '').toLowerCase();
      const nameEn = String(item.nameEn || item.name || '').toLowerCase();
      const nameZh = String(item.nameZh || '').toLowerCase();
      return id.includes(lower) || nameEn.includes(lower) || nameZh.includes(lower);
    });
  }, [query, books]);

  const currentBookName = useMemo(() => {
    return getBookPrimaryLabel(currentBook, subjectId, language);
  }, [currentBook, subjectId, language]);

  const resolvedPlaceholder = query ? placeholder : (currentBookName || placeholder);

  const handleSelect = (item) => {
    onSelect(String(item.id || ''));
    setQuery('');
    setOpen(false);
    setHighlightIndex(0);
  };

  const handleKeyDown = (event) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        setOpen(true);
        event.preventDefault();
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightIndex((current) => Math.min(filtered.length - 1, current + 1));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const item = filtered[highlightIndex];
      if (item) {
        handleSelect(item);
      }
      return;
    }

    if (event.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const handleFocus = () => {
    setOpen(true);
    setHighlightIndex(0);
  };

  const handleToggleOpen = (event) => {
    event.preventDefault();
    setOpen((current) => {
      const next = !current;
      if (next) {
        setHighlightIndex(0);
      }
      return next;
    });
    inputRef.current?.focus();
  };

  const handleBlur = () => {
    setTimeout(() => setOpen(false), 180);
  };

  return (
    <div className="section-autocomplete">
      <div className="autocomplete-input-wrapper">
        <svg className="autocomplete-search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <line x1="15" y1="15" x2="21" y2="21" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          className="autocomplete-input"
          placeholder={resolvedPlaceholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setHighlightIndex(0);
          }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          aria-autocomplete="list"
          aria-expanded={open}
          role="combobox"
        />
        <button
          type="button"
          className={`autocomplete-toggle-btn ${open ? 'open' : ''}`}
          onMouseDown={handleToggleOpen}
          aria-label="Toggle book list"
          tabIndex={-1}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {open && filtered.length > 0 && (
        <ul className="autocomplete-list" role="listbox">
          {filtered.map((item, index) => (
            <li
              key={item.id}
              className={`autocomplete-item ${index === highlightIndex ? 'highlighted' : ''}`}
              role="option"
              aria-selected={index === highlightIndex}
              onMouseDown={(event) => {
                event.preventDefault();
                handleSelect(item);
              }}
              onMouseEnter={() => setHighlightIndex(index)}
            >
              <div className="autocomplete-names">
                <strong>{getBookPrimaryLabel(item, subjectId, language)}</strong>
                <small>{stripLeadingId(item.nameZh || '', item.id)}</small>
              </div>
            </li>
          ))}
        </ul>
      )}

      {open && query && filtered.length === 0 && (
        <div className="autocomplete-empty">{emptyText}</div>
      )}
    </div>
  );
}

export default BookAutocomplete;

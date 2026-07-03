import React, { useMemo, useRef, useState } from 'react';

function SectionAutocomplete({ sections, onSelect, getSectionName, currentSection, language }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return sections || [];
    const lower = query.toLowerCase();
    return (sections || []).filter((item) => {
      const en = (getSectionName(item, 'en') || '').toLowerCase();
      const tc = (getSectionName(item, 'tc') || '').toLowerCase();
      const sec = String(item.section || '').toLowerCase();
      return en.includes(lower) || tc.includes(lower) || sec.includes(lower);
    });
  }, [query, sections, getSectionName]);

  const currentSectionName = useMemo(() => {
    if (!currentSection || !language) return '';
    const sectionId = String(currentSection.section || currentSection.page || '').trim();
    let sectionLabel = '';
    if (language === 'bilingual') {
      const en = getSectionName(currentSection, 'en');
      const tc = getSectionName(currentSection, 'tc');
      sectionLabel = [en, tc].filter(Boolean).join(' / ') || '';
    } else {
      sectionLabel = getSectionName(currentSection, language) || '';
    }
    if (sectionId && sectionLabel) {
      return `${sectionId} - ${sectionLabel}`;
    }
    return sectionLabel || sectionId;
  }, [currentSection, language, getSectionName]);

  const getPrimarySectionName = (item) => {
    if (language === 'bilingual') {
      return getSectionName(item, 'en') || getSectionName(item, 'tc') || '';
    }
    return getSectionName(item, language) || getSectionName(item, language === 'tc' ? 'en' : 'tc') || '';
  };

  const getSecondarySectionName = (item) => {
    if (language === 'tc') {
      return getSectionName(item, 'en') || '';
    }
    if (language === 'en') {
      return getSectionName(item, 'tc') || '';
    }
    return getSectionName(item, 'tc') || '';
  };

  const placeholder = query ? 'Search section…' : (currentSectionName || 'Search section…');

  const handleSelect = (item) => {
    onSelect(Number(item.page || item.section));
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
    // Delay close so click on item registers first
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
          placeholder={placeholder}
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
          aria-label="Toggle section list"
          tabIndex={-1}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {open && filtered.length > 0 && (
        <ul className="autocomplete-list" ref={listRef} role="listbox">
          {filtered.map((item, index) => (
            <li
              key={item.section}
              className={`autocomplete-item ${index === highlightIndex ? 'highlighted' : ''}`}
              role="option"
              aria-selected={index === highlightIndex}
              onMouseDown={(event) => {
                event.preventDefault();
                handleSelect(item);
              }}
              onMouseEnter={() => setHighlightIndex(index)}
            >
              <span className="autocomplete-section-badge">{item.section}</span>
              <div className="autocomplete-names">
                <strong>{getPrimarySectionName(item)}</strong>
                <small>{getSecondarySectionName(item)}</small>
              </div>
            </li>
          ))}
        </ul>
      )}

      {open && query && filtered.length === 0 && (
        <div className="autocomplete-empty">No matching sections</div>
      )}
    </div>
  );
}

export default SectionAutocomplete;

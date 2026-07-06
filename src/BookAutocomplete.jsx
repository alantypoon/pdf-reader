import React, { useMemo } from 'react';
import AutocompleteDropdown from './components/AutocompleteDropdown';

function compareNaturalIds(left, right) {
  const a = String(left || '').trim().toLowerCase();
  const b = String(right || '').trim().toLowerCase();
  const pattern = /^(\d+)([a-z]*)$/i;
  const matchA = a.match(pattern);
  const matchB = b.match(pattern);

  if (matchA && matchB) {
    const numDiff = Number(matchA[1]) - Number(matchB[1]);
    if (numDiff !== 0) return numDiff;
    return matchA[2].localeCompare(matchB[2], undefined, { sensitivity: 'base' });
  }
  if (matchA) return -1;
  if (matchB) return 1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function compareBiologyBookIds(left, right) {
  const a = String(left || '').trim().toLowerCase();
  const b = String(right || '').trim().toLowerCase();

  const coreMatchA = a.match(/^(\d+)([a-z]?)$/i);
  const coreMatchB = b.match(/^(\d+)([a-z]?)$/i);
  const electiveMatchA = a.match(/^e(\d+)$/i);
  const electiveMatchB = b.match(/^e(\d+)$/i);

  if (coreMatchA && coreMatchB) {
    const numDiff = Number(coreMatchA[1]) - Number(coreMatchB[1]);
    if (numDiff !== 0) return numDiff;
    return coreMatchA[2].localeCompare(coreMatchB[2], undefined, { sensitivity: 'base' });
  }
  if (coreMatchA) return -1;
  if (coreMatchB) return 1;

  if (electiveMatchA && electiveMatchB) {
    return Number(electiveMatchA[1]) - Number(electiveMatchB[1]);
  }
  if (electiveMatchA) return -1;
  if (electiveMatchB) return 1;

  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function stripLeadingId(label, id) {
  const text = String(label || '').trim();
  const normalizedId = String(id || '').trim();
  if (!text || !normalizedId) return text;
  const escapedId = normalizedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^${escapedId}\\s*[-:]\\s*`, 'i'), '').trim();
}

function getBookSeparator() {
  return ' - ';
}

function getBookPrimaryLabel(item, subjectId, language) {
  if (!item) return '';
  const id = String(item.id || '').trim();
  const normalizedSubjectId = String(subjectId || '').trim().toLowerCase();
  if (normalizedSubjectId === 'biology-oup' && !/^e\d+$/i.test(id)) {
    return id.toUpperCase();
  }
  const fallbackName = stripLeadingId(item.name, id);
  const nameEn = stripLeadingId(item.nameEn, id) || fallbackName;
  const nameZh = stripLeadingId(item.nameZh, id);
  const separator = getBookSeparator();

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

function getBookSecondaryLabel(item, language) {
  const id = String(item?.id || '').trim();
  if (!item || !id) return '';

  // Monolingual: show only the selected language, no secondary
  if (language !== 'bilingual') return '';

  // Bilingual: show the complementary language as secondary
  const fallbackName = stripLeadingId(item.name, id);
  const nameEn = stripLeadingId(item.nameEn, id) || fallbackName;
  const nameZh = stripLeadingId(item.nameZh, id);
  return nameZh || '';
}

function BookAutocomplete({ books, onSelect, currentBook, language, subjectId, placeholder, emptyText }) {
  const dropdownItems = useMemo(() => {
    const normalizedSubjectId = String(subjectId || '').trim().toLowerCase();
    const sortedBooks = [...(books || [])].sort((a, b) => (
      normalizedSubjectId === 'biology-oup'
        ? compareBiologyBookIds(a.id, b.id)
        : compareNaturalIds(a.id, b.id)
    ));
    return sortedBooks.map((item) => ({
      id: String(item.id || ''),
      primary: getBookPrimaryLabel(item, subjectId, language),
      secondary: getBookSecondaryLabel(item, language),
      searchText: [item.id, item.name, item.nameEn, item.nameZh].filter(Boolean).join('\n'),
    }));
  }, [books, language, subjectId]);

  const currentBookName = useMemo(() => {
    return getBookPrimaryLabel(currentBook, subjectId, language);
  }, [currentBook, subjectId, language]);

  return (
    <AutocompleteDropdown
      items={dropdownItems}
      value={currentBook?.id || ''}
      onSelect={(id) => onSelect(String(id || ''))}
      selectedDisplay={currentBookName}
      placeholder={placeholder}
      emptyText={emptyText}
      toggleAriaLabel="Toggle book list"
    />
  );
}

export default BookAutocomplete;

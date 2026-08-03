import React, { useMemo } from 'react';
import AutocompleteDropdown from './components/AutocompleteDropdown';

function SectionAutocomplete({ sections, onSelect, getSectionName, currentSection, language, onOpenChange, alwaysOpen, hideFilter }) {
  const currentSectionName = useMemo(() => {
    if (!currentSection || !language) return '';
    if (typeof currentSection.label === 'string' && currentSection.label.trim()) {
      return currentSection.label.trim();
    }
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
    // Monolingual: show only the selected language, no secondary
    if (language !== 'bilingual') return '';
    // Bilingual: show the complementary language as secondary
    return getSectionName(item, 'tc') || '';
  };

  const dropdownItems = useMemo(() => (
    (sections || []).map((item) => {
      if (item && Object.prototype.hasOwnProperty.call(item, 'primary') && Object.prototype.hasOwnProperty.call(item, 'id')) {
        return {
          id: String(item.id || ''),
          badge: item.badge || '',
          primary: item.primary || '',
          secondary: item.secondary || '',
          searchText: item.searchText || '',
          _page: item._sectionId ?? item.id,
          disabled: Boolean(item.disabled),
          _bookId: item._bookId,
          _sectionId: item._sectionId,
        };
      }
      const rawPage = item.page || item.section;
      const num = Number(rawPage);
      const pageVal = isNaN(num) ? String(rawPage) : num;
      return {
        id: String(item.section || item.page || ''),
        badge: String(item.section || item.page || ''),
        primary: getPrimarySectionName(item),
        secondary: getSecondarySectionName(item),
        searchText: [item.section, item.page, getSectionName(item, 'en'), getSectionName(item, 'tc')].filter(Boolean).join('\n'),
        _page: pageVal,
      };
    })
  ), [sections, getSectionName, language]);

  return (
    <AutocompleteDropdown
      items={dropdownItems}
      value={String(currentSection?.section || currentSection?.page || '')}
      onSelect={(id, item) => {
        if (item?.disabled) return;
        const val = item?._page;
        // Pass numeric page numbers as numbers, non-numeric (like "end") as strings
        onSelect(typeof val === 'number' ? val : String(val ?? id), item);
      }}
      selectedDisplay={currentSectionName}
      placeholder="Search section..."
      emptyText="No matching sections"
      toggleAriaLabel="Toggle section list"
      onOpenChange={onOpenChange}
      alwaysOpen={alwaysOpen}
      hideFilter={hideFilter}
    />
  );
}

export default SectionAutocomplete;

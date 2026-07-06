import React, { useMemo } from 'react';
import AutocompleteDropdown from './components/AutocompleteDropdown';

function SectionAutocomplete({ sections, onSelect, getSectionName, currentSection, language, onOpenChange }) {
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
    // Monolingual: show only the selected language, no secondary
    if (language !== 'bilingual') return '';
    // Bilingual: show the complementary language as secondary
    return getSectionName(item, 'tc') || '';
  };

  const dropdownItems = useMemo(() => (
    (sections || []).map((item) => ({
      id: String(item.section || item.page || ''),
      badge: String(item.section || item.page || ''),
      primary: getPrimarySectionName(item),
      secondary: getSecondarySectionName(item),
      searchText: [item.section, item.page, getSectionName(item, 'en'), getSectionName(item, 'tc')].filter(Boolean).join('\n'),
      _page: Number(item.page || item.section),
    }))
  ), [sections, getSectionName, language]);

  return (
    <AutocompleteDropdown
      items={dropdownItems}
      value={String(currentSection?.section || currentSection?.page || '')}
      onSelect={(id, item) => onSelect(Number(item?._page || id))}
      selectedDisplay={currentSectionName}
      placeholder="Search section..."
      emptyText="No matching sections"
      toggleAriaLabel="Toggle section list"
      onOpenChange={onOpenChange}
    />
  );
}

export default SectionAutocomplete;

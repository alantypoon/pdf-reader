import React, { useMemo } from 'react';
import AutocompleteDropdown from './components/AutocompleteDropdown';

function StepperSelect({
  items,
  value,
  onChange,
  onPrev,
  onNext,
  disablePrev,
  disableNext,
  placeholder,
}) {
  const currentItem = useMemo(
    () => (items || []).find((item) => String(item.id) === String(value)) || null,
    [items, value]
  );

  const displayValue = currentItem?.label || placeholder || '';

  const dropdownItems = useMemo(() => (
    (items || []).map((item) => ({
      id: item.id,
      primary: item.label,
      secondary: item.secondary || '',
      searchText: [item.id, item.label, item.secondary].filter(Boolean).join('\n'),
    }))
  ), [items]);

  return (
    <div className="selector-stepper">
      <button
        type="button"
        className="selector-stepper-btn"
        onClick={onPrev}
        disabled={disablePrev}
        aria-label="Previous option"
      >
        -
      </button>
      <AutocompleteDropdown
        items={dropdownItems}
        value={value}
        onSelect={(id) => onChange(id)}
        selectedDisplay={displayValue}
        placeholder={placeholder || 'Search...'}
        emptyText="No matching options"
        toggleAriaLabel="Toggle option list"
        showSearchIcon={false}
        containerClassName="selector-stepper-main"
        inputWrapperClassName="selector-stepper-input-wrapper"
        inputClassName="selector-stepper-input"
      />
      <button
        type="button"
        className="selector-stepper-btn"
        onClick={onNext}
        disabled={disableNext}
        aria-label="Next option"
      >
        +
      </button>
    </div>
  );
}

export default StepperSelect;

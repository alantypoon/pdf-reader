import React, { useMemo, useRef, useState } from 'react';

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
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  const currentItem = useMemo(
    () => (items || []).find((item) => String(item.id) === String(value)) || null,
    [items, value]
  );

  const displayValue = currentItem?.label || placeholder || '';

  const handleToggleOpen = (event) => {
    event.preventDefault();
    setOpen((current) => !current);
    inputRef.current?.focus();
  };

  const handleBlur = () => {
    setTimeout(() => setOpen(false), 180);
  };

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
      <div className="section-autocomplete selector-stepper-main">
        <div className="autocomplete-input-wrapper selector-stepper-input-wrapper">
          <input
            ref={inputRef}
            type="text"
            className="autocomplete-input selector-stepper-input"
            value={displayValue}
            readOnly
            onFocus={() => setOpen(true)}
            onBlur={handleBlur}
            aria-expanded={open}
            role="combobox"
          />
          <button
            type="button"
            className={`autocomplete-toggle-btn ${open ? 'open' : ''}`}
            onMouseDown={handleToggleOpen}
            aria-label="Toggle option list"
            tabIndex={-1}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {open && items?.length > 0 && (
          <ul className="autocomplete-list" role="listbox">
            {items.map((item) => (
              <li
                key={item.id}
                className={`autocomplete-item ${String(item.id) === String(value) ? 'highlighted' : ''}`}
                role="option"
                aria-selected={String(item.id) === String(value)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(item.id);
                  setOpen(false);
                }}
              >
                <div className="autocomplete-names">
                  <strong>{item.label}</strong>
                  {item.secondary ? <small>{item.secondary}</small> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
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

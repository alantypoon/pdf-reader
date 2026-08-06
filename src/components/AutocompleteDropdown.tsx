// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

function normalizeText(value) {
	return String(value || '').trim();
}

function getSearchBlob(item) {
	return [item.searchText, item.primary, item.secondary, item.badge, item.id]
		.map((value) => normalizeText(value).toLowerCase())
		.filter(Boolean)
		.join('\n');
}

function AutocompleteDropdown({
	items,
	value,
	onSelect,
	selectedDisplay,
	placeholder,
	emptyText,
	toggleAriaLabel,
	showSearchIcon = false,
	showStepper = false,
	hideFilter = false,
	alwaysOpen = false,
	disablePrev,
	disableNext,
	onPrev,
	onNext,
	onOpenChange,
	inputClassName = '',
	inputWrapperClassName = '',
	containerClassName = '',
}) {
	const [query, setQuery] = useState('');
	const [open, setOpen] = useState(alwaysOpen);
	const [highlightIndex, setHighlightIndex] = useState(-1);
	const [dropdownFilter, setDropdownFilter] = useState('');
	const [dropdownStyle, setDropdownStyle] = useState({});
	const inputRef = useRef(null);
	const dropdownFilterRef = useRef(null);
	const listRef = useRef(null);
	const containerRef = useRef(null);

	const filtered = useMemo(() => {
		if (!query.trim()) return items || [];
		const lower = query.toLowerCase();
		return (items || []).filter((item) => getSearchBlob(item).includes(lower));
	}, [items, query]);

	const dropdownFiltered = useMemo(() => {
		if (!dropdownFilter.trim()) return filtered;
		const lower = dropdownFilter.toLowerCase();
		return filtered.filter((item) => getSearchBlob(item).includes(lower));
	}, [filtered, dropdownFilter]);

	const resolvedPlaceholder = query ? placeholder : (placeholder || '');

	// Notify parent when open state changes (e.g. for cleanup after click-outside dismiss)
	// When alwaysOpen, never report false — the parent portal controls visibility.
	const prevOpenRef = useRef(open);
	useEffect(() => {
		if (prevOpenRef.current !== open) {
			prevOpenRef.current = open;
			if (!alwaysOpen || open) {
				onOpenChange?.(open);
			}
		}
	}, [open, onOpenChange, alwaysOpen]);

	// Recalculate the dropdown position relative to the viewport
	const updateDropdownPosition = useCallback(() => {
		if (!containerRef.current) return;
		const rect = containerRef.current.getBoundingClientRect();
		const viewportPadding = 16;
		const anchoredLeft = Math.min(
			Math.max(rect.left, viewportPadding),
			Math.max(viewportPadding, window.innerWidth - viewportPadding - rect.width),
		);
		const spaceBelow = window.innerHeight - rect.bottom - 6;
		const dropdownHeight = listRef.current?.offsetHeight || 200;
		const fitsBelow = spaceBelow >= dropdownHeight;
		setDropdownStyle({
			position: 'fixed',
			left: anchoredLeft,
			...(fitsBelow
				? { top: rect.bottom + 6 }
				: { bottom: window.innerHeight - rect.top + 6 }),
			minWidth: rect.width,
			maxWidth: Math.max(rect.width, window.innerWidth - anchoredLeft - viewportPadding),
			zIndex: 99999,
		});
	}, []);

	// Update dropdown position when it opens and on scroll/resize
	useEffect(() => {
		if (!open) return;
		updateDropdownPosition();
		window.addEventListener('scroll', updateDropdownPosition, true);
		window.addEventListener('resize', updateDropdownPosition);
		return () => {
			window.removeEventListener('scroll', updateDropdownPosition, true);
			window.removeEventListener('resize', updateDropdownPosition);
		};
	}, [open, updateDropdownPosition]);

	// Scroll the selected item to the center of the list when the dropdown opens
	useEffect(() => {
		if (!open) return;
		// Wait for the DOM to render the list
		const timer = setTimeout(() => {
			const selectedEl = listRef.current?.querySelector('.autocomplete-item.selected');
			if (selectedEl) {
				selectedEl.scrollIntoView({ block: 'center', behavior: 'instant' });
			}
		}, 0);
		return () => clearTimeout(timer);
	}, [open, dropdownFiltered]);

	const handleSelect = (item) => {
		if (item?.disabled) return;
		console.log('[page-select] AutocompleteDropdown handleSelect  item.id=', item.id, '  item.primary=', item.primary);
		onSelect?.(item.id, item);
		setQuery('');
		setDropdownFilter('');
		setOpen(false);
		setHighlightIndex(0);
	};

	const handleKeyDown = (event) => {
		if (!open) {
			if (event.key === 'ArrowDown' || event.key === 'Enter') {
				setOpen(true);
				const firstEnabled = items.findIndex((item) => !item.disabled);
				setHighlightIndex(firstEnabled);
				event.preventDefault();
			}
			return;
		}

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setHighlightIndex((current) => {
				let next = current + 1;
				while (next < dropdownFiltered.length && dropdownFiltered[next]?.disabled) next++;
				return next < dropdownFiltered.length ? next : current;
			});
			return;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			setHighlightIndex((current) => {
				let next = current - 1;
				while (next >= 0 && dropdownFiltered[next]?.disabled) next--;
				return next >= 0 ? next : current;
			});
			return;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			if (highlightIndex >= 0) {
				const item = dropdownFiltered[highlightIndex];
				if (item) {
					handleSelect(item);
				}
			}
			return;
		}

		if (event.key === 'Escape') {
			setOpen(false);
			setQuery('');
			setDropdownFilter('');
			inputRef.current?.blur();
		}
	};

	const handleFocus = () => {
		setOpen(true);
		// Start highlight on the first non-disabled item
		setHighlightIndex((dropdownFiltered || items || []).findIndex((item) => !item.disabled));
	};

	const handleToggleOpen = (event) => {
		event.preventDefault();
		setOpen((current) => {
			const next = !current;
			if (next) {
				setHighlightIndex(-1);
			} else {
				setQuery('');
				setDropdownFilter('');
			}
			return next;
		});
		inputRef.current?.focus();
	};

	const handleBlur = () => {
		setTimeout(() => {
			// Don't close the dropdown if focus moved to the filter input inside it
			if (document.activeElement === dropdownFilterRef.current) return;
			setOpen(false);
			setQuery('');
			setDropdownFilter('');
		}, 180);
	};

	const handleStepperPrev = () => {
		if (onPrev) {
			onPrev();
		} else if (open) {
			setHighlightIndex((current) => {
				let next = current - 1;
				while (next >= 0 && (dropdownFiltered[next] || filtered[next])?.disabled) next--;
				return next >= 0 ? next : current;
			});
		}
	};

	const handleStepperNext = () => {
		if (onNext) {
			onNext();
		} else if (open) {
			setHighlightIndex((current) => {
				let next = current + 1;
				const list = dropdownFiltered.length > 0 ? dropdownFiltered : filtered;
				while (next < list.length && list[next]?.disabled) next++;
				return next < list.length ? next : current;
			});
		}
	};

	const selectedKey = String(value ?? '');

	return (
		<div className={`section-autocomplete ${containerClassName}`.trim()} ref={containerRef}>
			<div className={`autocomplete-input-wrapper ${!showSearchIcon ? 'no-search-icon' : ''} ${showStepper ? 'has-stepper' : ''} ${inputWrapperClassName}`.trim()}>
				{showStepper && (
					<button
						type="button"
						className="autocomplete-stepper-btn autocomplete-stepper-prev"
						onClick={handleStepperPrev}
						disabled={disablePrev}
						aria-label="Previous option"
						tabIndex={-1}
					>
						-
					</button>
				)}
				{showSearchIcon && (
					<svg className="autocomplete-search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
						<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
						<line x1="15" y1="15" x2="21" y2="21" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
					</svg>
				)}
				<input
					ref={inputRef}
					type="text"
					readOnly
					inputMode="none"
					className={`autocomplete-input ${!showSearchIcon ? 'no-search-icon' : ''} ${!query && selectedDisplay ? 'has-selected' : ''} ${inputClassName}`.trim()}
					placeholder={resolvedPlaceholder}
					value={selectedDisplay || ''}
					onFocus={handleFocus}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					aria-autocomplete="list"
					aria-expanded={open}
					role="combobox"
				/>
				{!alwaysOpen && (
				<button
					type="button"
					className={`autocomplete-toggle-btn ${open ? 'open' : ''}`}
					onMouseDown={handleToggleOpen}
					aria-label={toggleAriaLabel}
					tabIndex={-1}
				>
					<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
						<path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</button>
				)}
				{showStepper && (
					<button
						type="button"
						className="autocomplete-stepper-btn autocomplete-stepper-next"
						onClick={handleStepperNext}
						disabled={disableNext}
						aria-label="Next option"
						tabIndex={-1}
					>
						+
					</button>
				)}
			</div>

		{(open || alwaysOpen) && createPortal(
			<>
				{filtered.length > 0 && (
					<div className="autocomplete-dropdown" style={dropdownStyle} onMouseDown={(e) => {
						// Don't preventDefault on the filter input so it can receive focus
						// and bring up the virtual keyboard on iOS.
						if (e.target !== dropdownFilterRef.current) {
							e.preventDefault();
						}
					}}>
						{!hideFilter && (
						<div className="autocomplete-dropdown-filter">
							<svg className="autocomplete-dropdown-filter-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
								<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
								<line x1="15" y1="15" x2="21" y2="21" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
							</svg>
							<input
								ref={dropdownFilterRef}
								type="text"
								className="autocomplete-dropdown-filter-input"
								placeholder="Filter…"
								value={dropdownFilter}
								onChange={(event) => {
									setDropdownFilter(event.target.value);
									setHighlightIndex(-1);
								}}
								onKeyDown={(event) => {
									if (event.key === 'ArrowDown') {
										event.preventDefault();
										setHighlightIndex((current) => {
											let next = current + 1;
											while (next < dropdownFiltered.length && dropdownFiltered[next]?.disabled) next++;
											return next < dropdownFiltered.length ? next : current;
										});
									} else if (event.key === 'ArrowUp') {
										event.preventDefault();
										setHighlightIndex((current) => {
											let next = current - 1;
											while (next >= 0 && dropdownFiltered[next]?.disabled) next--;
											return next >= 0 ? next : current;
										});
									} else if (event.key === 'Enter') {
										event.preventDefault();
										if (highlightIndex >= 0) {
											const item = dropdownFiltered[highlightIndex];
											if (item) {
												handleSelect(item);
											}
										}
									} else if (event.key === 'Escape') {
										setOpen(false);
										setQuery('');
										setDropdownFilter('');
										inputRef.current?.blur();
									}
								}}
							/>
						</div>
						)}
						{dropdownFiltered.length > 0 ? (
							<ul className="autocomplete-list" role="listbox" ref={listRef}>
								{dropdownFiltered.map((item, index) => {
									const itemKey = String(item.id ?? '');
										const isSelected = !query && !dropdownFilter && itemKey === selectedKey;
									const isHighlighted = !item.disabled && index === highlightIndex;
									const classNames = [
										'autocomplete-item',
										item.disabled ? 'disabled' : '',
										isSelected ? 'selected' : '',
										isHighlighted ? 'highlighted' : '',
									].filter(Boolean).join(' ');
									return (
										<li
											key={itemKey}
											className={classNames}
											role="option"
											aria-disabled={item.disabled ? 'true' : undefined}
											aria-selected={isSelected || isHighlighted}
											onMouseDown={(event) => {
												event.preventDefault();
												if (item.disabled) return;
												handleSelect(item);
											}}
											onMouseEnter={!item.disabled ? () => setHighlightIndex(index) : undefined}
										>
											{item.badge ? <span className="autocomplete-section-badge">{item.badge}</span> : null}
											<div className="autocomplete-names">
												<strong>{item.primary}</strong>
												{item.secondary ? <small>{item.secondary}</small> : null}
											</div>
										</li>
									);
								})}
							</ul>
						) : (
							<div className="autocomplete-empty">{emptyText}</div>
						)}
					</div>
				)}

				{query && filtered.length === 0 && (
					<div className="autocomplete-empty autocomplete-empty--standalone" style={dropdownStyle}>{emptyText}</div>
				)}
			</>,
			document.body
		)}
	</div>
	);
}

export default AutocompleteDropdown;

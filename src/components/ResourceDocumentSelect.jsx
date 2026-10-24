import React, { useEffect, useRef } from 'react';
import $ from 'jquery';
import select2 from 'select2/dist/js/select2.full.js';
import 'select2/dist/css/select2.css';

select2(window, $);

export default function ResourceDocumentSelect({ entries, value, title, onSelect }) {
  const selectRef = useRef(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const element = $(selectRef.current);
    element.select2({
      data: entries.map((entry) => ({ id: entry.id, text: entry.name })),
      width: '100%',
      minimumResultsForSearch: 0,
      dropdownCssClass: 'resource-document-dropdown',
    });
    element.next('.select2-container').find('[role="combobox"]').attr('aria-label', title);
    element.on('change.resourceDocument', () => onSelectRef.current(element.val()));
    element.on('select2:open.resourceDocument', () => {
      $('.resource-document-dropdown .select2-search__field').attr('aria-label', title).trigger('focus');
    });
    return () => {
      element.off('.resourceDocument');
      element.select2('destroy');
      element.empty();
    };
  }, [entries, title]);

  useEffect(() => {
    $(selectRef.current).val(value).trigger('change.select2');
  }, [value, entries, title]);

  return (
    <div className="resource-document-select">
      <select ref={selectRef} aria-label={title} defaultValue={value} />
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import PdfPane from '../PdfPane';
import ResourceDocumentSelect from './ResourceDocumentSelect';

export default function OtherResourceColumn({
  pane, title, entries, selectedId, onSelect, loading, error, onRetry, labels, ...readerProps
}) {
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [pane.sourceKey]);
  const source = pane.source;
  return (
    <section className="other-resource-column" aria-label={title} data-resource-category={pane.viewId}>
      <div className="other-resource-topics" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
        <h2>{title}</h2>
        {loading ? <p role="status">{labels.loading}</p>
          : error ? <div role="alert"><p>{error}</p><button type="button" onClick={onRetry}>{labels.retry}</button></div>
            : entries.length === 0 ? <p>{labels.noResources}</p>
              : (
                <ResourceDocumentSelect
                  title={title}
                  entries={entries}
                  value={selectedId}
                  onSelect={(id) => { setPage(1); onSelect(id); }}
                />
              )}
      </div>
      {source && (
        <PdfPane
          key={pane.sourceKey}
          {...readerProps}
          source={Array.isArray(source) ? `img:${pane.sourceKey}` : source}
          images={Array.isArray(source) ? source : null}
          paneLanguage={pane.language}
          paneRole={pane.role}
          title={selectedId}
          hideHeader={true}
          currentPage={page}
          onPageChange={setPage}
          onThumbnailClick={setPage}
          syncGroup=""
          syncId={pane.sourceKey}
          maxPagesInGroup={0}
        />
      )}
    </section>
  );
}

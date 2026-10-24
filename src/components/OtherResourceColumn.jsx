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
        {entries.some((entry) => entry.id === selectedId) && (
          <a
            className="resource-document-download"
            href={`/pdf-reader/data/other-learning-resources/${encodeURIComponent(selectedId)}.pdf`}
            download={`${selectedId}.pdf`}
            title={`${labels.download}: ${selectedId}`}
            aria-label={`${labels.download}: ${selectedId}`}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M11 3h2v10l3-3 1.4 1.4L12 17l-5.4-5.6L8 10l3 3V3zM5 19h14v2H5v-2z" fill="currentColor" />
            </svg>
            <span>{labels.download}</span>
          </a>
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

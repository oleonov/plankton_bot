interface PaginationProps {
  nextCursor: string | null;
  onNext: (cursor: string) => void;
  onPrev?: () => void;
  hasPrev?: boolean;
  pageInfo?: string;
}

export function Pagination({ nextCursor, onNext, onPrev, hasPrev, pageInfo }: PaginationProps) {
  if (!nextCursor && !hasPrev && !pageInfo) return null;

  return (
    <div
      style={{
        marginTop: 12,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <div>
        {hasPrev && onPrev && (
          <button className="btn-secondary" onClick={onPrev}>
            &larr; Prev
          </button>
        )}
      </div>
      {pageInfo && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{pageInfo}</span>}
      <div>
        {nextCursor && (
          <button className="btn-secondary" onClick={() => onNext(nextCursor)}>
            Next &rarr;
          </button>
        )}
      </div>
    </div>
  );
}

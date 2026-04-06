interface PaginationProps {
  nextCursor?: string | null;
  onNext?: (cursor: string) => void;
  onPrev?: () => void;
  hasPrev?: boolean;
  pageInfo?: string;
  page?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
}

function buildPageItems(page: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (page <= 4) {
    return [1, 2, 3, 4, 5, "ellipsis", totalPages];
  }

  if (page >= totalPages - 3) {
    return [
      1,
      "ellipsis",
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ];
  }

  return [1, "ellipsis", page - 1, page, page + 1, "ellipsis", totalPages];
}

function buttonStyle(active: boolean) {
  return {
    minWidth: 36,
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: active ? "var(--blue)" : "var(--bg-elevated)",
    color: active ? "#fff" : "var(--text)",
    fontWeight: active ? 700 : 500,
    cursor: active ? "default" : "pointer",
  } as const;
}

export function Pagination(props: PaginationProps) {
  if (
    typeof props.page === "number" &&
    typeof props.totalPages === "number" &&
    typeof props.onPageChange === "function"
  ) {
    const { page, totalPages, onPageChange, pageInfo } = props;
    if (totalPages <= 1 && !pageInfo) return null;

    const pageItems = buildPageItems(page, totalPages);
    return (
      <div
        style={{
          marginTop: 16,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        {totalPages > 1 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            <button
              className="btn-secondary"
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
            >
              &larr;
            </button>
            {pageItems.map((item, index) =>
              item === "ellipsis" ? (
                <span
                  key={`ellipsis-${index}`}
                  style={{ color: "var(--text-muted)", padding: "0 4px" }}
                >
                  …
                </span>
              ) : (
                <button
                  key={item}
                  style={buttonStyle(item === page)}
                  onClick={() => item !== page && onPageChange(item)}
                  disabled={item === page}
                >
                  {item}
                </button>
              ),
            )}
            <button
              className="btn-secondary"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
            >
              &rarr;
            </button>
          </div>
        )}
        {pageInfo && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{pageInfo}</span>}
      </div>
    );
  }

  const { nextCursor = null, onNext, onPrev, hasPrev, pageInfo } = props;
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
        {nextCursor && onNext && (
          <button className="btn-secondary" onClick={() => onNext(nextCursor)}>
            Next &rarr;
          </button>
        )}
      </div>
    </div>
  );
}

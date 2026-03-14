export function Pagination({
  nextCursor,
  onNext,
}: {
  nextCursor: string | null;
  onNext: (cursor: string) => void;
}) {
  if (!nextCursor) return null;
  return (
    <div style={{ marginTop: 12, textAlign: "right" }}>
      <button className="btn-secondary" onClick={() => onNext(nextCursor)}>
        Next &rarr;
      </button>
    </div>
  );
}

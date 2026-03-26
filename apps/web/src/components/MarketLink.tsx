/** Renders market question + outcome with a Polymarket link. */
export function MarketLink({
  slug,
  eventSlug,
  question,
  outcome,
}: {
  slug: string | null;
  eventSlug: string | null;
  question: string | null;
  outcome: string | null;
}) {
  if (!question && !slug) return <span style={{ color: "var(--text-dim)" }}>—</span>;

  const label = question ? (question.length > 40 ? question.slice(0, 40) + "…" : question) : slug;

  const linkSlug = eventSlug ?? slug;

  return (
    <div style={{ lineHeight: 1.3 }}>
      <div style={{ fontSize: 12 }}>{label}</div>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          display: "flex",
          gap: 6,
          alignItems: "center",
        }}
      >
        {outcome && <span>{outcome}</span>}
        {linkSlug && (
          <a
            href={`https://polymarket.com/event/${linkSlug}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--blue)" }}
          >
            Open
          </a>
        )}
      </div>
    </div>
  );
}

import type { PromotionBlockerDTO } from "../api/types.ts";

export function PromotionBlockers({
  blockers,
  title = "Promotion Checklist",
}: {
  blockers: PromotionBlockerDTO[];
  title?: string;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", marginBottom: 4 }}>
        {title}
      </div>
      {blockers.map((b) => (
        <div key={b.metric} style={{ fontSize: 11, display: "flex", gap: 6, marginBottom: 2 }}>
          <span style={{ color: b.passed ? "var(--green)" : "var(--red)", width: 14 }}>
            {b.passed ? "\u2713" : "\u2717"}
          </span>
          <span>{b.metric}</span>
          <span style={{ color: "var(--text-dim)" }}>
            {b.current} / {b.required}
          </span>
        </div>
      ))}
    </div>
  );
}

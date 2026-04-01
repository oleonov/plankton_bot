interface Score {
  label: string;
  value: number | null;
  color: string;
}

function ScoreBar({ label, value, color }: Score) {
  const pct = value != null ? Math.round(value * 100) : 0;
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 2 }}
      >
        <span style={{ color: "var(--text-muted)" }}>{label}</span>
        <span style={{ color }}>{value != null ? value.toFixed(2) : "\u2014"}</span>
      </div>
      <div style={{ height: 6, background: "var(--border)", borderRadius: 3 }}>
        <div style={{ height: 6, width: `${pct}%`, background: color, borderRadius: 3 }} />
      </div>
    </div>
  );
}

export interface ScoreBarsProps {
  recurrence: number | null;
  recycle: number | null;
  liveViability: number | null;
  toxicity: number | null;
}

export function ScoreBars({ recurrence, recycle, liveViability, toxicity }: ScoreBarsProps) {
  const scores: Score[] = [
    { label: "Recurrence", value: recurrence, color: "var(--blue)" },
    { label: "Recycle", value: recycle, color: "var(--green)" },
    { label: "Live Viability", value: liveViability, color: "#26a69a" },
    { label: "Toxicity", value: toxicity, color: "var(--red)" },
  ];

  return (
    <div style={{ minWidth: 160 }}>
      {scores.map((s) => (
        <ScoreBar key={s.label} {...s} />
      ))}
    </div>
  );
}

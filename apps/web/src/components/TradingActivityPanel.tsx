import { useState, useEffect } from "react";
import { useTradingActivity } from "../api/hooks.ts";
import { aggregateSnapshots, collapseStates } from "../utils/tradingActivity.ts";

const STATE_COLORS: Record<string, string> = {
  ACTIVELY_TRADING: "var(--green)",
  PROBING_ONLY: "var(--blue)",
  EXITS_ONLY: "#cc8800",
  ALIVE_BUT_BLOCKED: "var(--orange)",
  PAUSED: "var(--red)",
  NO_SIGNALS: "#666",
};

const STATE_LABELS: Record<string, string> = {
  ACTIVELY_TRADING: "Trading",
  PROBING_ONLY: "Probing",
  EXITS_ONLY: "Exits only",
  ALIVE_BUT_BLOCKED: "Blocked",
  PAUSED: "Paused",
  NO_SIGNALS: "No signals",
};

const RANGE_OPTIONS = [
  { label: "24h", days: 1, bucketMinutes: 10 },
  { label: "7d", days: 7, bucketMinutes: 30 },
  { label: "14d", days: 14, bucketMinutes: 120 },
] as const;

const WIDTH = 700;
const BAR_HEIGHT = 140;
const BAND_HEIGHT = 20;
const PAD = { top: 10, right: 20, bottom: 25, left: 40 };

function StateBand({ segments, totalMs }: { segments: { state: string; startMs: number; durationMs: number }[]; totalMs: number }) {
  if (segments.length === 0) return null;
  const plotW = WIDTH - PAD.left - PAD.right;

  return (
    <svg width={WIDTH} height={BAND_HEIGHT + 4} style={{ display: "block" }}>
      {segments.map((seg, i) => {
        const xStart = PAD.left + (seg.startMs / totalMs) * plotW;
        const w = Math.max((seg.durationMs / totalMs) * plotW, 1);
        return (
          <rect key={i} x={xStart} y={2} width={w} height={BAND_HEIGHT} rx={2} fill={STATE_COLORS[seg.state] ?? "#666"}>
            <title>{STATE_LABELS[seg.state] ?? seg.state}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function SignalBars({ buckets }: { buckets: { signalsProduced: number; signalsApproved: number; signalsRejected: number }[] }) {
  if (buckets.length === 0) return null;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = BAR_HEIGHT - PAD.top - PAD.bottom;
  const maxVal = Math.max(1, ...buckets.map((b) => b.signalsProduced));
  const barW = Math.max(plotW / buckets.length - 1, 1);

  const yTicks = 4;
  const yStep = maxVal / yTicks;

  return (
    <svg width={WIDTH} height={BAR_HEIGHT} style={{ display: "block" }}>
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const val = i * yStep;
        const yPos = PAD.top + plotH - (val / maxVal) * plotH;
        return (
          <g key={i}>
            <line x1={PAD.left} y1={yPos} x2={WIDTH - PAD.right} y2={yPos} stroke="var(--border)" strokeWidth={0.5} />
            <text x={PAD.left - 6} y={yPos + 3} textAnchor="end" fill="var(--text-dim)" fontSize={8}>
              {Math.round(val)}
            </text>
          </g>
        );
      })}

      {buckets.map((b, i) => {
        const xPos = PAD.left + i * (plotW / buckets.length) + 0.5;
        const approvedH = (b.signalsApproved / maxVal) * plotH;
        const rejectedH = (b.signalsRejected / maxVal) * plotH;
        return (
          <g key={i}>
            <rect x={xPos} y={PAD.top + plotH - approvedH - rejectedH} width={barW} height={rejectedH} fill="var(--red)" opacity={0.7}>
              <title>{`Rejected: ${b.signalsRejected}`}</title>
            </rect>
            <rect x={xPos} y={PAD.top + plotH - approvedH} width={barW} height={approvedH} fill="var(--green)" opacity={0.9}>
              <title>{`Approved: ${b.signalsApproved}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

export function TradingActivityPanel() {
  const [rangeIdx, setRangeIdx] = useState(2); // default 14d
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const range = RANGE_OPTIONS[rangeIdx]!;
  const { data } = useTradingActivity(range.days);
  const snapshots = data?.items ?? [];

  const segments = collapseStates(snapshots);
  const buckets = aggregateSnapshots(snapshots, range.bucketMinutes);

  const rangeMs = range.days * 24 * 60 * 60 * 1000;
  const rangeStart = now - rangeMs;
  const bandSegments = segments.map((seg) => {
    const startMs = Math.max(new Date(seg.startAt).getTime() - rangeStart, 0);
    const endMs = new Date(seg.endAt).getTime() - rangeStart + 10 * 60 * 1000;
    return { state: seg.state, startMs, durationMs: Math.min(endMs, rangeMs) - startMs };
  });

  if (snapshots.length === 0) {
    return (
      <div className="card" style={{ textAlign: "center", padding: 40, color: "var(--text-dim)" }}>
        No activity data yet
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div className="label">Trading Activity</div>
        <div style={{ display: "flex", gap: 4 }}>
          {RANGE_OPTIONS.map((opt, i) => (
            <button
              key={opt.label}
              className={i === rangeIdx ? "btn-success" : "btn-secondary"}
              style={{ padding: "2px 8px", fontSize: 10 }}
              onClick={() => setRangeIdx(i)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <StateBand segments={bandSegments} totalMs={rangeMs} />

      <div style={{ marginTop: 4 }}>
        <SignalBars buckets={buckets} />
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 9, color: "var(--text-muted)", flexWrap: "wrap" }}>
        {Object.entries(STATE_LABELS).map(([key, label]) => (
          <span key={key} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: STATE_COLORS[key] }} />
            {label}
          </span>
        ))}
        <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--green)", opacity: 0.9 }} />
          Approved
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--red)", opacity: 0.7 }} />
          Rejected
        </span>
      </div>
    </div>
  );
}

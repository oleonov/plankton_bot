import { useState } from "react";
import { useTradingActivity } from "../api/hooks.ts";
import type { TradingActivityResponse, TradingActivityWindow } from "../api/types.ts";
import {
  ACTIVITY_STATE_COLORS,
  buildActivityTimeline,
  buildStateMarkerGroups,
  formatActivityTooltip,
  formatDuration,
  formatStateMarkerGroup,
  type ActivityMode,
} from "../utils/tradingActivity.ts";

const RANGE_OPTIONS = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
] as const;

const WIDTH = 700;
const HEIGHT = 190;
const PAD = { top: 28, right: 10, bottom: 24, left: 34 };
const tabStyle: React.CSSProperties = {
  padding: "3px 9px",
  fontSize: 11,
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
};

function WindowBars({
  item,
  mode,
  x,
  width,
  maxValue,
}: {
  item: TradingActivityWindow;
  mode: ActivityMode;
  x: number;
  width: number;
  maxValue: number;
}) {
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const y = (value: number) => PAD.top + plotHeight - (value / maxValue) * plotHeight;
  const label = formatActivityTooltip(item, mode);
  if (mode === "execution") {
    const orderY = y(item.ordersAccepted);
    const fillY = y(item.fillsReceived);
    return (
      <g aria-label={label} tabIndex={0}>
        <title>{label}</title>
        <rect
          x={x}
          y={orderY}
          width={width}
          height={PAD.top + plotHeight - orderY}
          fill="var(--blue)"
          opacity={0.45}
        />
        <rect
          x={x}
          y={fillY}
          width={width}
          height={PAD.top + plotHeight - fillY}
          fill="var(--green)"
          opacity={0.9}
        />
      </g>
    );
  }
  const producedY = y(item.signalsProduced);
  const approvedHeight = (item.signalsApproved / maxValue) * plotHeight;
  const rejectedHeight = (item.signalsRejected / maxValue) * plotHeight;
  return (
    <g aria-label={label} tabIndex={0}>
      <title>{label}</title>
      <rect
        x={x}
        y={producedY}
        width={width}
        height={PAD.top + plotHeight - producedY}
        fill="var(--text-dim)"
        opacity={0.25}
      />
      <rect
        x={x}
        y={PAD.top + plotHeight - approvedHeight}
        width={width}
        height={approvedHeight}
        fill="var(--green)"
        opacity={0.9}
      />
      <rect
        x={x}
        y={PAD.top + plotHeight - approvedHeight - rejectedHeight}
        width={width}
        height={rejectedHeight}
        fill="var(--red)"
        opacity={0.7}
      />
    </g>
  );
}

function ActivityChart({ data, mode }: { data: TradingActivityResponse; mode: ActivityMode }) {
  const timeline = buildActivityTimeline(data);
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const windows = timeline.filter((segment) => segment.kind === "window" && segment.item);
  const values = data.items.flatMap((item) =>
    mode === "execution"
      ? [item.ordersAccepted, item.fillsReceived]
      : [item.signalsProduced, item.signalsApproved + item.signalsRejected],
  );
  const maxValue = Math.max(1, ...values);
  const stateMarkers = buildStateMarkerGroups(
    data.items,
    data.coverage.requestedStartAt,
    data.coverage.requestedEndAt,
    Math.floor(plotWidth / 12),
  );
  return (
    <svg
      data-testid="activity-chart"
      role="img"
      aria-label={`${mode === "execution" ? "Execution" : "Signal"} activity; ${formatDuration(data.coverage.coveredMs)} verified and ${formatDuration(data.coverage.gapMs)} unavailable`}
      width="100%"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      style={{ display: "block", height: HEIGHT }}
    >
      {timeline
        .filter((segment) => segment.kind !== "window")
        .map((segment, index) => {
          const x = PAD.left + (segment.leftPct / 100) * plotWidth;
          const width = (segment.widthPct / 100) * plotWidth;
          const label =
            segment.kind === "collecting" ? "Collecting current window" : "No verified data";
          return (
            <rect
              key={`${segment.kind}-${segment.startMs}`}
              data-testid={
                index === 0 || segment.kind === "collecting"
                  ? `activity-gap-${segment.kind}`
                  : `activity-gap-${segment.kind}-${index}`
              }
              x={x}
              y={PAD.top}
              width={width}
              height={HEIGHT - PAD.top - PAD.bottom}
              fill={segment.kind === "collecting" ? "var(--blue)" : "var(--red)"}
              opacity={segment.kind === "collecting" ? 0.08 : 0.05}
              aria-label={`${label}: ${formatDuration(segment.endMs - segment.startMs)}`}
            >
              <title>{`${label}: ${formatDuration(segment.endMs - segment.startMs)}`}</title>
            </rect>
          );
        })}
      {[0, 0.5, 1].map((ratio) => (
        <line
          key={ratio}
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={PAD.top + (1 - ratio) * (HEIGHT - PAD.top - PAD.bottom)}
          y2={PAD.top + (1 - ratio) * (HEIGHT - PAD.top - PAD.bottom)}
          stroke="var(--border)"
          strokeWidth={0.5}
        />
      ))}
      {windows.map((segment) => {
        const item = segment.item!;
        const x = PAD.left + (segment.leftPct / 100) * plotWidth;
        const width = (segment.widthPct / 100) * plotWidth;
        return (
          <WindowBars
            key={item.windowStartedAt}
            item={item}
            mode={mode}
            x={x}
            width={width}
            maxValue={maxValue}
          />
        );
      })}
      {stateMarkers.map((marker) => {
        const x = PAD.left + (marker.leftPct / 100) * plotWidth;
        const label = formatStateMarkerGroup(marker);
        return (
          <g
            key={`state-${marker.leftPct}`}
            data-testid="activity-state-marker"
            tabIndex={0}
            aria-label={label}
          >
            <title>{label}</title>
            <circle
              cx={x}
              cy={12}
              r={4}
              fill={ACTIVITY_STATE_COLORS[marker.latestState] ?? "#666"}
            />
          </g>
        );
      })}
      <text x={PAD.left} y={HEIGHT - 5} fill="var(--text-dim)" fontSize={9}>
        {data.coverage.requestedStartAt.slice(5, 16).replace("T", " ")}
      </text>
      <text
        x={WIDTH - PAD.right}
        y={HEIGHT - 5}
        textAnchor="end"
        fill="var(--text-dim)"
        fontSize={9}
      >
        {data.coverage.requestedEndAt.slice(5, 16).replace("T", " ")}
      </text>
    </svg>
  );
}

function ActivityMessage({
  label,
  loading,
  retry,
}: {
  label: string;
  loading?: boolean;
  retry?: () => void;
}) {
  return (
    <div data-testid="trading-activity-shell" style={{ position: "relative", minHeight: HEIGHT }}>
      {loading && <div className="pnl-skeleton" aria-hidden="true" style={{ height: HEIGHT }} />}
      <div
        role={loading ? "status" : retry ? "alert" : undefined}
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          color: "var(--text-dim)",
        }}
      >
        {label}
        {retry && <button onClick={retry}>Retry</button>}
      </div>
    </div>
  );
}

export function TradingActivityPanel() {
  const [rangeIdx, setRangeIdx] = useState(0);
  const [mode, setMode] = useState<ActivityMode>("execution");
  const range = RANGE_OPTIONS[rangeIdx]!;
  const query = useTradingActivity(range.days);
  const isBlocking =
    query.isPending || query.isPlaceholderData || (query.isFetching && query.data == null);
  const isHardError = query.isError && query.data == null && !isBlocking;
  const isUpdating = query.isFetching && query.data != null && !query.isPlaceholderData;
  const hasRefreshError = query.isError && query.data != null;
  const collecting = query.data?.coverage.gaps.some((gap) => gap.kind === "collecting");

  return (
    <div className="card" data-testid="trading-activity-card" aria-busy={isBlocking || isUpdating}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div>
          <div className="label">Trading Activity</div>
          <div style={{ display: "flex", gap: 4, marginTop: 5 }}>
            {(["execution", "signals"] as const).map((value) => (
              <button
                key={value}
                data-testid={`mode-${value}`}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                style={{
                  ...tabStyle,
                  fontWeight: mode === value ? 700 : 400,
                  background: mode === value ? "var(--blue)" : "transparent",
                  color: mode === value ? "#fff" : "var(--text-muted)",
                }}
              >
                {value === "execution" ? "Execution" : "Signals"}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {RANGE_OPTIONS.map((option, index) => (
            <button
              key={option.label}
              aria-pressed={rangeIdx === index}
              className={rangeIdx === index ? "btn-success" : "btn-secondary"}
              style={{ padding: "2px 8px", fontSize: 10 }}
              onClick={() => setRangeIdx(index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {isBlocking ? (
        <ActivityMessage label={`Loading ${range.label} activity…`} loading />
      ) : isHardError ? (
        <ActivityMessage
          label={`Couldn't load ${range.label} activity`}
          retry={() => void query.refetch()}
        />
      ) : !query.data ? (
        <ActivityMessage label="No activity response" />
      ) : (
        <div data-testid="trading-activity-shell" style={{ minHeight: HEIGHT }}>
          <div data-testid="activity-summary" style={{ fontSize: 10, color: "var(--text-dim)" }}>
            {formatDuration(query.data.coverage.coveredMs)} verified ·{" "}
            {formatDuration(query.data.coverage.gapMs)} unavailable
            {collecting ? " · collecting current window" : ""}
            {isUpdating ? <span role="status"> · Updating…</span> : null}
            {hasRefreshError ? (
              <span role="alert">
                {" "}
                · Update failed <button onClick={() => void query.refetch()}>Retry</button>
              </span>
            ) : null}
          </div>
          <ActivityChart data={query.data} mode={mode} />
          {query.data.items.length === 0 ? (
            <div style={{ fontSize: 9, color: "var(--text-muted)" }}>
              No completed verified windows yet.
            </div>
          ) : null}
          <div style={{ fontSize: 9, color: "var(--text-muted)" }}>
            Bars are completed windows; dots show state at close. Shaded spans are unavailable, not
            zero activity.
          </div>
        </div>
      )}
    </div>
  );
}

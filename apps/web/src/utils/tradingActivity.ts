import type { TradingActivityResponse, TradingActivityWindow } from "../api/types.ts";

export type ActivityMode = "execution" | "signals";

export interface ActivityTimelineSegment {
  kind: "window" | "missing" | "collecting";
  startMs: number;
  endMs: number;
  leftPct: number;
  widthPct: number;
  item?: TradingActivityWindow;
}

export interface ActivityStateMarkerGroup {
  leftPct: number;
  count: number;
  firstEndedAt: string;
  lastEndedAt: string;
  latestState: string;
  stateCounts: Record<string, number>;
}

export const ACTIVITY_STATE_LABELS: Record<string, string> = {
  ACTIVELY_TRADING: "Trading",
  EXITS_ONLY: "Exits only",
  ALIVE_BUT_BLOCKED: "Blocked",
  PAUSED: "Paused",
  NO_SIGNALS: "No signals",
};

export const ACTIVITY_STATE_COLORS: Record<string, string> = {
  ACTIVELY_TRADING: "var(--green)",
  EXITS_ONLY: "#cc8800",
  ALIVE_BUT_BLOCKED: "var(--orange)",
  PAUSED: "var(--red)",
  NO_SIGNALS: "#666",
};

function timelinePosition(startMs: number, endMs: number, rangeStart: number, rangeMs: number) {
  return {
    leftPct: ((startMs - rangeStart) / rangeMs) * 100,
    widthPct: ((endMs - startMs) / rangeMs) * 100,
  };
}

export function buildActivityTimeline(data: TradingActivityResponse): ActivityTimelineSegment[] {
  const startMs = Date.parse(data.coverage.requestedStartAt);
  const endMs = Date.parse(data.coverage.requestedEndAt);
  const rangeMs = endMs - startMs;
  const gaps = data.coverage.gaps.map((gap) => {
    const gapStart = Date.parse(gap.startAt);
    const gapEnd = Date.parse(gap.endAt);
    return {
      kind: gap.kind,
      startMs: gapStart,
      endMs: gapEnd,
      ...timelinePosition(gapStart, gapEnd, startMs, rangeMs),
    };
  });
  const windows = data.items.map((item) => {
    const windowStart = Date.parse(item.windowStartedAt);
    const windowEnd = Date.parse(item.windowEndedAt);
    return {
      kind: "window" as const,
      startMs: windowStart,
      endMs: windowEnd,
      item,
      ...timelinePosition(windowStart, windowEnd, startMs, rangeMs),
    };
  });
  return [...gaps, ...windows].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export function formatDuration(durationMs: number): string {
  const minutes = Math.max(0, Math.round(durationMs / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  return [days && `${days}d`, hours && `${hours}h`, (rest || (!days && !hours)) && `${rest}m`]
    .filter(Boolean)
    .join(" ");
}

function formatUtc(iso: string): string {
  const date = new Date(iso);
  return `${date.toISOString().slice(5, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

function rejectionSummary(reasons: Record<string, number>): string {
  return Object.entries(reasons)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason.replaceAll("_", " ")}: ${count}`)
    .join(", ");
}

export function formatActivityTooltip(item: TradingActivityWindow, mode: ActivityMode): string {
  const interval = `${formatUtc(item.windowStartedAt)}–${formatUtc(item.windowEndedAt).slice(6)}`;
  if (mode === "execution") {
    const orders = `${item.ordersAccepted} accepted order${item.ordersAccepted === 1 ? "" : "s"} ($${item.orderNotionalUsdc.toFixed(2)})`;
    const fills = `${item.fillsReceived} fill${item.fillsReceived === 1 ? "" : "s"} ($${item.fillNotionalUsdc.toFixed(2)})`;
    return `${interval} · ${orders} · ${fills} · state ${ACTIVITY_STATE_LABELS[item.tradingState] ?? item.tradingState}`;
  }
  const reasons = rejectionSummary(item.rejectionReasons);
  const state = ACTIVITY_STATE_LABELS[item.tradingState] ?? item.tradingState;
  return `${interval} · ${item.signalsProduced} produced · ${item.signalsApproved} approved · ${item.signalsRejected} rejected${reasons ? ` · ${reasons}` : ""} · state ${state}`;
}

export function buildStateMarkerGroups(
  items: TradingActivityWindow[],
  rangeStartAt: string,
  rangeEndAt: string,
  bucketCount: number,
): ActivityStateMarkerGroup[] {
  const startMs = Date.parse(rangeStartAt);
  const rangeMs = Date.parse(rangeEndAt) - startMs;
  const groups = new Map<number, ActivityStateMarkerGroup>();
  for (const item of items) {
    const endedMs = Date.parse(item.windowEndedAt);
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor(((endedMs - startMs) / rangeMs) * bucketCount)),
    );
    const group = groups.get(index);
    const counts = group?.stateCounts ?? {};
    counts[item.tradingState] = (counts[item.tradingState] ?? 0) + 1;
    groups.set(index, {
      leftPct: ((index + 0.5) / bucketCount) * 100,
      count: (group?.count ?? 0) + 1,
      firstEndedAt: group?.firstEndedAt ?? item.windowEndedAt,
      lastEndedAt: item.windowEndedAt,
      latestState: item.tradingState,
      stateCounts: counts,
    });
  }
  return [...groups.values()];
}

export function formatStateMarkerGroup(group: ActivityStateMarkerGroup): string {
  const states = Object.entries(group.stateCounts)
    .map(([state, count]) => `${ACTIVITY_STATE_LABELS[state] ?? state}: ${count}`)
    .join(", ");
  return `${group.count} state-at-close observation${group.count === 1 ? "" : "s"}, ${formatUtc(group.firstEndedAt)}–${formatUtc(group.lastEndedAt)} · ${states}`;
}

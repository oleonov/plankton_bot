import { describe, it, expect } from "vitest";
import { aggregateSnapshots, collapseStates } from "../../utils/tradingActivity.ts";
import type { TradingActivitySnapshot } from "../../api/types.ts";

function snap(
  tradingState: string,
  produced: number,
  approved: number,
  rejected: number,
  capturedAt: string,
): TradingActivitySnapshot {
  return {
    tradingState,
    signalsProduced: produced,
    signalsApproved: approved,
    signalsRejected: rejected,
    capturedAt,
  };
}

describe("aggregateSnapshots", () => {
  it("groups snapshots into time buckets summing signals", () => {
    const snapshots = [
      snap("ACTIVELY_TRADING", 10, 3, 7, "2026-03-31T10:00:00Z"),
      snap("ACTIVELY_TRADING", 20, 5, 15, "2026-03-31T10:10:00Z"),
      snap("ALIVE_BUT_BLOCKED", 15, 0, 15, "2026-03-31T10:20:00Z"),
    ];
    // 30-min bucket → all three collapse into one bucket
    const result = aggregateSnapshots(snapshots, 30);
    expect(result).toHaveLength(1);
    expect(result[0]!.signalsProduced).toBe(45);
    expect(result[0]!.signalsApproved).toBe(8);
    expect(result[0]!.signalsRejected).toBe(37);
  });

  it("splits into multiple buckets", () => {
    const snapshots = [
      snap("ACTIVELY_TRADING", 10, 3, 7, "2026-03-31T10:00:00Z"),
      snap("ACTIVELY_TRADING", 20, 5, 15, "2026-03-31T11:00:00Z"),
    ];
    // 30-min buckets → two separate buckets
    const result = aggregateSnapshots(snapshots, 30);
    expect(result).toHaveLength(2);
  });

  it("returns empty for empty input", () => {
    expect(aggregateSnapshots([], 30)).toEqual([]);
  });
});

describe("collapseStates", () => {
  it("merges consecutive same-state snapshots", () => {
    const snapshots = [
      snap("ACTIVELY_TRADING", 10, 3, 7, "2026-03-31T10:00:00Z"),
      snap("ACTIVELY_TRADING", 20, 5, 15, "2026-03-31T10:10:00Z"),
      snap("ALIVE_BUT_BLOCKED", 15, 0, 15, "2026-03-31T10:20:00Z"),
      snap("ALIVE_BUT_BLOCKED", 12, 0, 12, "2026-03-31T10:30:00Z"),
      snap("ACTIVELY_TRADING", 8, 2, 6, "2026-03-31T10:40:00Z"),
    ];
    const result = collapseStates(snapshots);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      state: "ACTIVELY_TRADING",
      startAt: "2026-03-31T10:00:00Z",
      endAt: "2026-03-31T10:10:00Z",
    });
    expect(result[1]).toEqual({
      state: "ALIVE_BUT_BLOCKED",
      startAt: "2026-03-31T10:20:00Z",
      endAt: "2026-03-31T10:30:00Z",
    });
    expect(result[2]).toEqual({
      state: "ACTIVELY_TRADING",
      startAt: "2026-03-31T10:40:00Z",
      endAt: "2026-03-31T10:40:00Z",
    });
  });

  it("returns empty for empty input", () => {
    expect(collapseStates([])).toEqual([]);
  });

  it("handles single snapshot", () => {
    const result = collapseStates([snap("PAUSED", 0, 0, 0, "2026-03-31T10:00:00Z")]);
    expect(result).toHaveLength(1);
    expect(result[0]!.state).toBe("PAUSED");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildActivityTimeline,
  formatActivityTooltip,
  formatDuration,
} from "../../utils/tradingActivity.ts";
import type { TradingActivityResponse, TradingActivityWindow } from "../../api/types.ts";

const START = "2026-09-04T00:00:00.000Z";
const END = "2026-09-04T01:00:00.000Z";

function window(overrides: Partial<TradingActivityWindow> = {}): TradingActivityWindow {
  return {
    tradingState: "ACTIVELY_TRADING",
    signalsProduced: 4,
    signalsApproved: 2,
    signalsRejected: 2,
    capturedAt: "2026-09-04T00:20:00.000Z",
    windowVersion: 2,
    windowStartedAt: "2026-09-04T00:10:00.000Z",
    windowEndedAt: "2026-09-04T00:20:00.000Z",
    ordersAccepted: 2,
    orderNotionalUsdc: 3.5,
    fillsReceived: 1,
    fillNotionalUsdc: 1.25,
    rejectionReasons: { max_open_value: 2 },
    ...overrides,
  };
}

function response(): TradingActivityResponse {
  return {
    items: [window()],
    coverage: {
      requestedStartAt: START,
      requestedEndAt: END,
      coveredMs: 10 * 60_000,
      gapMs: 50 * 60_000,
      gapCount: 2,
      coveragePercent: 100 / 6,
      gaps: [
        { startAt: START, endAt: "2026-09-04T00:10:00.000Z", durationMs: 600_000, kind: "missing" },
        {
          startAt: "2026-09-04T00:20:00.000Z",
          endAt: END,
          durationMs: 2_400_000,
          kind: "collecting",
        },
      ],
      excludedRows: { legacy: 3, invalid: 1, outsideRange: 0 },
    },
  };
}

describe("buildActivityTimeline", () => {
  it("uses actual interval widths and keeps missing and collecting spans distinct", () => {
    const result = buildActivityTimeline(response());
    expect(result.map((segment) => segment.kind)).toEqual(["missing", "window", "collecting"]);
    expect(result[0]?.leftPct).toBeCloseTo(0);
    expect(result[0]?.widthPct).toBeCloseTo(100 / 6);
    expect(result[1]?.leftPct).toBeCloseTo(100 / 6);
    expect(result[1]?.widthPct).toBeCloseTo(100 / 6);
    expect(result[2]?.leftPct).toBeCloseTo(100 / 3);
    expect(result[2]?.widthPct).toBeCloseTo(200 / 3);
  });
});

describe("activity labels", () => {
  it("reports exact execution and signal facts without treating gaps as zeros", () => {
    const item = window();
    expect(formatActivityTooltip(item, "execution")).toContain(
      "2 accepted orders ($3.50) · 1 fill ($1.25)",
    );
    expect(formatActivityTooltip(item, "signals")).toContain(
      "4 produced · 2 approved · 2 rejected · max open value: 2",
    );
    expect(formatActivityTooltip(item, "signals")).toContain("state Trading");
    expect(formatDuration(23 * 60 * 60_000 + 40 * 60_000)).toBe("23h 40m");
  });
});

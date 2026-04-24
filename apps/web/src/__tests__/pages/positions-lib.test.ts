import { describe, it, expect } from "vitest";
import type { PositionDTO } from "../../api/types.ts";
import {
  countsByPhase,
  deriveMarketState,
  deriveResolutionTag,
  endsMsFrom,
  fmtAgo,
  fmtDuration,
  fmtEndsLabel,
  fmtMoney,
  fmtPct,
  getPositionTotalPnl,
  groupPositions,
  lastActionMinutes,
  matchesSearch,
  outcomeKind,
  urgencyClass,
} from "../../pages/positions/lib.ts";

const MINUS = "\u2212";

function position(overrides: Partial<PositionDTO>): PositionDTO {
  return {
    positionId: "p",
    tokenId: "t",
    side: "buy",
    size: 1,
    avgEntryPrice: 0.1,
    costBasisUsdc: 1,
    currentValueUsdc: 1.5,
    realizedPnl: 0,
    status: "open",
    openedAt: "2026-04-20T00:00:00Z",
    closedAt: null,
    updatedAt: "2026-04-24T00:00:00Z",
    slug: "slug",
    eventSlug: "event",
    question: "question",
    outcome: "Yes",
    conditionId: null,
    endDate: null,
    resolution: null,
    resolutionStatus: null,
    phase: "S1",
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    lastActionAt: "2026-04-24T00:00:00Z",
    ...overrides,
  };
}

describe("fmtMoney", () => {
  it("returns $0.00 for zero or NaN", () => {
    expect(fmtMoney(0)).toBe("$0.00");
    expect(fmtMoney(Number.NaN)).toBe("$0.00");
  });
  it("renders positive without sign by default", () => {
    expect(fmtMoney(3.14)).toBe("$3.14");
  });
  it("renders signed positive when showSign=true", () => {
    expect(fmtMoney(3.14, { showSign: true })).toBe("+$3.14");
  });
  it("renders negative with U+2212 minus (not hyphen)", () => {
    expect(fmtMoney(-2.5)).toBe(`${MINUS}$2.50`);
    expect(fmtMoney(-2.5, { showSign: true })).toBe(`${MINUS}$2.50`);
  });
});

describe("fmtPct", () => {
  it("returns empty string when basis is zero", () => {
    expect(fmtPct(5, 0)).toBe("");
  });
  it("renders signed percent with 1 decimal", () => {
    expect(fmtPct(1, 10)).toBe("+10.0%");
    expect(fmtPct(-1, 10)).toBe(`${MINUS}10.0%`);
  });
});

describe("fmtDuration + fmtEndsLabel", () => {
  it("renders minutes under an hour", () => {
    expect(fmtDuration(10 * 60_000)).toBe("10m");
  });
  it("renders hours under 48h", () => {
    expect(fmtDuration(3 * 3_600_000)).toBe("3h");
  });
  it("renders days for 2+ days", () => {
    expect(fmtDuration(5 * 86_400_000)).toBe("5d");
  });
  it("labels expired", () => {
    expect(fmtEndsLabel(-1000)).toBe("Expired");
  });
  it("labels non-expired with 'left'", () => {
    expect(fmtEndsLabel(30 * 60_000)).toBe("30m left");
  });
  it("handles no deadline", () => {
    expect(fmtEndsLabel(Number.POSITIVE_INFINITY)).toBe("No deadline");
  });
});

describe("urgencyClass", () => {
  it("expired for negative ms", () => {
    expect(urgencyClass(-1)).toBe("expired");
  });
  it("hot for <1h", () => {
    expect(urgencyClass(30 * 60_000)).toBe("hot");
  });
  it("urgent for <6h", () => {
    expect(urgencyClass(3 * 3_600_000)).toBe("urgent");
  });
  it("empty for later", () => {
    expect(urgencyClass(24 * 3_600_000)).toBe("");
  });
  it("empty for +Infinity", () => {
    expect(urgencyClass(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("endsMsFrom", () => {
  it("returns +Infinity when endDate is null", () => {
    expect(endsMsFrom(null)).toBe(Number.POSITIVE_INFINITY);
  });
  it("computes diff against provided now", () => {
    const now = Date.parse("2026-04-24T10:00:00Z");
    const ms = endsMsFrom("2026-04-24T11:00:00Z", now);
    expect(ms).toBe(3_600_000);
  });
});

describe("deriveMarketState + deriveResolutionTag", () => {
  it("closed status → closed market", () => {
    expect(deriveMarketState("closed")).toBe("closed");
  });
  it("dust status → closed market", () => {
    expect(deriveMarketState("dust")).toBe("closed");
  });
  it("open status → open market", () => {
    expect(deriveMarketState("open")).toBe("open");
  });
  it("resolutionStatus=detected → resolving tag", () => {
    expect(deriveResolutionTag("detected", null)).toBe("resolving");
  });
  it("resolutionStatus=settled → null tag", () => {
    expect(deriveResolutionTag("settled", null)).toBeNull();
  });
  it("past endDate → expired tag", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(deriveResolutionTag(null, past)).toBe("expired");
  });
  it("future endDate → null tag", () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(deriveResolutionTag(null, future)).toBeNull();
  });
});

describe("getPositionTotalPnl", () => {
  it("returns realizedPnl only for closed", () => {
    expect(
      getPositionTotalPnl(
        position({ status: "closed", realizedPnl: 10, currentValueUsdc: 5, costBasisUsdc: 4 }),
      ),
    ).toBe(10);
  });
  it("returns realized + unrealized for open", () => {
    expect(
      getPositionTotalPnl(
        position({ status: "open", realizedPnl: 1, currentValueUsdc: 10, costBasisUsdc: 4 }),
      ),
    ).toBe(7);
  });
  it("treats null currentValue as zero", () => {
    expect(
      getPositionTotalPnl(
        position({ status: "open", realizedPnl: 0, currentValueUsdc: null, costBasisUsdc: 2 }),
      ),
    ).toBe(-2);
  });
});

describe("matchesSearch", () => {
  it("empty query matches everything", () => {
    expect(matchesSearch(position({}), "")).toBe(true);
    expect(matchesSearch(position({}), "  ")).toBe(true);
  });
  it("matches on question", () => {
    expect(matchesSearch(position({ question: "Will BTC hit 150k?" }), "btc")).toBe(true);
  });
  it("matches on position id", () => {
    expect(matchesSearch(position({ positionId: "pos-abc-123" }), "abc")).toBe(true);
  });
  it("matches on outcome", () => {
    expect(matchesSearch(position({ outcome: "Pacers" }), "pacer")).toBe(true);
  });
  it("returns false for a non-match", () => {
    expect(matchesSearch(position({ question: "ETH" }), "dogecoin")).toBe(false);
  });
});

describe("outcomeKind", () => {
  const cases: Array<[string | null, string]> = [
    ["Yes", "yes"],
    ["Up", "yes"],
    ["No", "no"],
    ["Down", "no"],
    ["Pacers", "neutral"],
    [null, "neutral"],
  ];
  it.each(cases)("%s → %s", (input, expected) => {
    expect(outcomeKind(input)).toBe(expected);
  });
});

describe("countsByPhase", () => {
  it("sums per-phase counts", () => {
    const rows = [
      position({ phase: "S1" }),
      position({ phase: "S2" }),
      position({ phase: "S2" }),
      position({ phase: "S0" }),
    ];
    expect(countsByPhase(rows)).toEqual({ all: 4, S0: 1, S1: 1, S2: 2, S3: 0 });
  });
});

describe("lastActionMinutes", () => {
  it("returns +Infinity when timestamp is null", () => {
    expect(lastActionMinutes(null)).toBe(Number.POSITIVE_INFINITY);
  });
  it("computes minutes against provided now", () => {
    const now = Date.parse("2026-04-24T10:00:00Z");
    expect(lastActionMinutes("2026-04-24T09:30:00Z", now)).toBe(30);
  });
});

describe("fmtAgo", () => {
  it("returns empty string for null", () => {
    expect(fmtAgo(null)).toBe("");
  });
  it("renders a duration against provided now", () => {
    const now = Date.parse("2026-04-24T10:00:00Z");
    expect(fmtAgo("2026-04-24T09:00:00Z", now)).toBe("1h ago");
  });
});

describe("groupPositions — by phase", () => {
  it("orders by S2/S3/S1/S0 and drops empty buckets", () => {
    const rows = [position({ phase: "S1" }), position({ phase: "S2" }), position({ phase: "S0" })];
    const groups = groupPositions(rows, "phase");
    expect(groups.map((g) => g.key)).toEqual([
      "Accumulating (S2)",
      "First Entry (S1)",
      "Idle (S0)",
    ]);
  });
});

describe("groupPositions — by pnl", () => {
  it("splits gains vs flat/losses", () => {
    const rows = [
      position({ status: "closed", realizedPnl: 5 }),
      position({ status: "closed", realizedPnl: -3 }),
      position({ status: "closed", realizedPnl: 0 }),
    ];
    const groups = groupPositions(rows, "pnl");
    expect(groups).toHaveLength(2);
    expect(groups[0]!.key).toBe("Gains");
    expect(groups[0]!.items).toHaveLength(1);
    expect(groups[1]!.key).toBe("Flat / Losses");
    expect(groups[1]!.items).toHaveLength(2);
  });
});

describe("groupPositions — by ends", () => {
  it("buckets expired / <1h / <24h / later", () => {
    const now = Date.now();
    const rows = [
      position({ endDate: new Date(now - 60_000).toISOString() }),
      position({ endDate: new Date(now + 30 * 60_000).toISOString() }),
      position({ endDate: new Date(now + 5 * 3_600_000).toISOString() }),
      position({ endDate: new Date(now + 48 * 3_600_000).toISOString() }),
    ];
    const groups = groupPositions(rows, "ends");
    const keys = groups.map((g) => g.key);
    expect(keys).toEqual(["Expired", "Closing < 1h", "Closing today", "Later"]);
  });
});

describe("groupPositions — by lastAction recency", () => {
  it("buckets <15m / <1h / today / older", () => {
    const now = Date.now();
    const rows = [
      position({ lastActionAt: new Date(now - 5 * 60_000).toISOString() }),
      position({ lastActionAt: new Date(now - 30 * 60_000).toISOString() }),
      position({ lastActionAt: new Date(now - 5 * 3_600_000).toISOString() }),
      position({ lastActionAt: new Date(now - 48 * 3_600_000).toISOString() }),
    ];
    const groups = groupPositions(rows, "lastAction");
    expect(groups.map((g) => g.key)).toEqual([
      "Active now",
      "Recent (last hour)",
      "Today",
      "Older",
    ]);
  });
});

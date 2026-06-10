import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  createTokenId,
  type ExecutionPolicy,
  type LegState,
  type NormalizedMarket,
  type Position,
} from "@krabs/domain";
import { projectTrackQShadow, type TrackQShadowProjection } from "../decision-planner.js";

const tokenId = createTokenId("track-q-token");
const now = Date.parse("2026-06-11T00:00:00.000Z");

function market(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId,
    conditionId: "condition",
    slug: "track-q-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Track Q?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: "2026-09-01T00:00:00.000Z",
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.005,
    bestAsk: 0.045,
    midPrice: 0.025,
    spread: 0.04,
    liquidity: 500,
    minOrderSize: 5,
    gammaCreatedAt: "2026-06-10T00:00:00.000Z",
    snapshotTs: now,
    ...overrides,
  };
}

function leg(overrides: Partial<LegState> = {}): LegState {
  return {
    tokenId,
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    firstTradePrice: 0.02,
    firstTradeAt: "2026-06-01T00:00:00.000Z",
    lastTradeAt: "2026-06-01T00:10:00.000Z",
    updatedAt: "2026-06-01T00:10:00.000Z",
    cumulativeBuySize: 100,
    cumulativeBuyNotional: 1,
    cumulativeSellSize: 0,
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: "position" as Position["positionId"],
    tokenId,
    conditionId: "condition" as Position["conditionId"],
    side: "buy",
    size: 100,
    avgEntryPrice: 0.02,
    costBasisUsdc: 2,
    currentValueUsdc: 2,
    realizedPnl: 0,
    status: "open",
    entryStyle: "probe",
    openedAt: "2026-06-01T00:00:00.000Z",
    closedAt: null,
    updatedAt: "2026-06-01T00:10:00.000Z",
    ...overrides,
  };
}

const policy: ExecutionPolicy = {
  ...DEFAULT_EXECUTION_POLICY,
  profitTarget: { ...DEFAULT_EXECUTION_POLICY.profitTarget, enabled: true, holdSecondsMin: 0 },
};

function project(
  overrides: {
    market?: NormalizedMarket;
    legState?: LegState;
    position?: Position | null;
    executionPolicy?: ExecutionPolicy | null;
    evalPrice?: number;
  } = {},
): TrackQShadowProjection | null {
  const m = overrides.market ?? market();
  return projectTrackQShadow({
    market: m,
    legState: overrides.legState ?? leg(),
    position: overrides.position === undefined ? position() : overrides.position,
    executionPolicy: overrides.executionPolicy === undefined ? policy : overrides.executionPolicy,
    evalPrice: overrides.evalPrice ?? (m.midPrice as number),
    now,
  });
}

// Invariant asserted on every non-null projection: F1 <= p3 <= min(insideAsk, 0.97), on grid.
function assertInvariant(p: TrackQShadowProjection, tickSize: number): void {
  expect(p.p3CandidatePrice).toBeGreaterThanOrEqual(p.bidAnchoredPrice - 1e-9);
  if (p.insideAsk != null) {
    expect(p.p3CandidatePrice).toBeLessThanOrEqual(Math.min(p.insideAsk, 0.97) + 1e-9);
  } else {
    expect(p.p3CandidatePrice).toBeLessThanOrEqual(0.97 + 1e-9);
  }
  const ticks = p.p3CandidatePrice / tickSize;
  expect(Math.abs(ticks - Math.round(ticks))).toBeLessThan(1e-6);
}

describe("projectTrackQShadow", () => {
  it("returns null when bestBid is missing or non-positive", () => {
    expect(project({ market: market({ bestBid: null }) })).toBeNull();
    expect(project({ market: market({ bestBid: 0 }) })).toBeNull();
  });

  it("returns null when tickSize is invalid", () => {
    expect(project({ market: market({ tickSize: 0 }) })).toBeNull();
  });

  it("activates the tier floor on a wide book and lifts F1 to the tier target", () => {
    // bestBid 0.005 / bestAsk 0.045 / mid 0.025 → spread/mid = 1.6 (wide).
    // F1 = bestBid + 4 ticks = 0.009. avgEntry 0.02 → markup 1.36 → tier 0.0272.
    const p = project()!;
    expect(p).not.toBeNull();
    expect(p.bidAnchoredPrice).toBeCloseTo(0.009, 9);
    expect(p.tierMarkup).toBe(1.36);
    expect(p.tierTarget).toBeCloseTo(0.0272, 9);
    expect(p.p3CandidatePrice).toBeCloseTo(0.027, 9);
    expect(p.p3CandidatePrice).toBeGreaterThan(p.bidAnchoredPrice);
    expect(p.p3WouldActivate).toBe(true);
    expect(p.reason).toBe("tier_floor_applied");
    assertInvariant(p, 0.001);
  });

  it("does not activate when avgEntry is unavailable (p3 == F1)", () => {
    const p = project({ position: null })!;
    expect(p.avgEntry).toBeNull();
    expect(p.tierTarget).toBeNull();
    expect(p.p3CandidatePrice).toBe(p.bidAnchoredPrice);
    expect(p.p3WouldActivate).toBe(false);
    expect(p.reason).toBe("avg_entry_unavailable");
    assertInvariant(p, 0.001);
  });

  it("excludes the cheap longshot tail (avgEntry < 0.02) from activation", () => {
    const p = project({ position: position({ avgEntryPrice: 0.01 }) })!;
    expect(p.tierMarkup).toBe(2.5);
    expect(p.tierTarget).toBeCloseTo(0.025, 9); // recorded for analysis
    expect(p.p3CandidatePrice).toBe(p.bidAnchoredPrice); // but not proposed
    expect(p.p3WouldActivate).toBe(false);
    expect(p.reason).toBe("cheap_tail_excluded");
    assertInvariant(p, 0.001);
  });

  it("does not activate on a narrow book even when the tier exceeds F1", () => {
    // bestBid 0.09 / bestAsk 0.11 / mid 0.1 → spread/mid = 0.2 (narrow).
    const narrow = market({
      tickSize: 0.01,
      bestBid: 0.09,
      bestAsk: 0.11,
      midPrice: 0.1,
      spread: 0.02,
    });
    const p = project({ market: narrow, position: position({ avgEntryPrice: 0.05 }) })!;
    expect(p.currentGuardWouldSuppress).toBe(false);
    expect(p.p3CandidatePrice).toBe(p.bidAnchoredPrice);
    expect(p.p3WouldActivate).toBe(false);
    expect(p.reason).toBe("book_not_wide");
    assertInvariant(p, 0.01);
  });

  it("does not activate when F1 already sits at or above the tier target", () => {
    // wide book, but avgEntry 0.3 → tier 0.351 <= F1 0.44.
    const wide = market({
      tickSize: 0.01,
      bestBid: 0.4,
      bestAsk: 0.9,
      midPrice: 0.65,
      spread: 0.5,
    });
    const p = project({ market: wide, position: position({ avgEntryPrice: 0.3 }) })!;
    expect(p.currentGuardWouldSuppress).toBe(true);
    expect(p.bidAnchoredPrice).toBeCloseTo(0.44, 9);
    expect(p.tierTarget).toBeCloseTo(0.351, 9);
    expect(p.p3CandidatePrice).toBe(p.bidAnchoredPrice);
    expect(p.p3WouldActivate).toBe(false);
    expect(p.reason).toBe("f1_already_above_tier");
    assertInvariant(p, 0.01);
  });

  it("caps the candidate at the inside ask when the tier target exceeds it", () => {
    // wide book, tier target 0.068 but inside ask only 0.019.
    const wide = market({
      tickSize: 0.001,
      bestBid: 0.005,
      bestAsk: 0.02,
      midPrice: 0.0125,
      spread: 0.015,
    });
    const p = project({ market: wide, position: position({ avgEntryPrice: 0.05 }) })!;
    expect(p.insideAsk).toBeCloseTo(0.019, 9);
    expect(p.tierTarget).toBeCloseTo(0.068, 9);
    expect(p.p3CandidatePrice).toBeCloseTo(0.019, 9); // capped at inside ask, never crosses
    expect(p.p3CandidatePrice).toBeGreaterThan(p.bidAnchoredPrice);
    expect(p.p3WouldActivate).toBe(true);
    expect(p.reason).toBe("tier_capped_at_inside_ask");
    assertInvariant(p, 0.001);
  });

  it("records both current (>0.5) and proposed (>1.636) guard suppression flags", () => {
    const veryWide = market({
      bestBid: 0.002,
      bestAsk: 0.05,
      midPrice: 0.026,
      spread: 0.048,
    });
    const p = project({ market: veryWide })!;
    expect(p.spreadMidRatio).toBeGreaterThan(1.636);
    expect(p.currentGuardWouldSuppress).toBe(true);
    expect(p.proposedGuardWouldSuppress).toBe(true);
    expect(p.bidAskRatio).toBeCloseTo(0.002 / 0.05, 9);
  });

  it("never flags a D8 divergence — the D8 trigger is decoupled from the P3 candidate (Sub-Track Q.A)", () => {
    // avgBuyPrice = notional/size = 1/100 = 0.01 → D8 threshold ratio 2.0 (price < 0.02 bucket).
    // evalPrice 0.015 → ratio 1.5 (no fire). The P3 candidate 0.027 (ratio 2.7) WOULD clear the
    // threshold, but D8 no longer evaluates at the P3 price — both branches use the eval price, so
    // the shadow divergence is 0 by construction.
    const p = project({ evalPrice: 0.015 })!;
    expect(p.p3CandidatePrice).toBeGreaterThan(0.015); // the candidate genuinely differs…
    expect(p.d8FireAtCurrentPrice).toBe(false);
    expect(p.d8FireAtP3Candidate).toBe(false); // …yet D8 is evaluated at the eval price, not P3
    expect(p.d8FireWouldChange).toBe(false);
  });

  it("reports no D8 divergence when both prices clear the threshold", () => {
    // evalPrice 0.03 → ratio 3.0 (fire). P3 candidate 0.027 → ratio 2.7 (fire). No change.
    const p = project({ evalPrice: 0.03 })!;
    expect(p.d8FireAtCurrentPrice).toBe(true);
    expect(p.d8FireAtP3Candidate).toBe(true);
    expect(p.d8FireWouldChange).toBe(false);
  });

  it("never produces a non-finite or crossed price across a sweep of books", () => {
    const books: Array<Partial<NormalizedMarket>> = [
      { bestBid: 0.005, bestAsk: 0.045, midPrice: 0.025, spread: 0.04, tickSize: 0.001 },
      { bestBid: 0.01, bestAsk: 0.99, midPrice: 0.5, spread: 0.98, tickSize: 0.01 },
      { bestBid: 0.4, bestAsk: 0.42, midPrice: 0.41, spread: 0.02, tickSize: 0.01 },
      { bestBid: 0.005, bestAsk: 0.006, midPrice: 0.0055, spread: 0.001, tickSize: 0.001 },
      { bestBid: 0.95, bestAsk: 0.99, midPrice: 0.97, spread: 0.04, tickSize: 0.01 },
    ];
    for (const b of books) {
      const m = market(b);
      const p = project({ market: m, position: position({ avgEntryPrice: 0.5 }) });
      if (p == null) continue;
      expect(Number.isFinite(p.p3CandidatePrice)).toBe(true);
      assertInvariant(p, m.tickSize);
    }
  });
});

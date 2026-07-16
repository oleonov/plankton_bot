import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOUNCE_EXIT,
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_GATE_ENTRY,
  createTokenId,
  type ExecutionPolicy,
  type LegState,
  type NormalizedMarket,
  type Position,
  type QdPreResolutionExitPolicy,
} from "@krabs/domain";
import {
  evaluateBounceBackstopEligibility,
  evaluateQdPreResolutionExit,
  type QdShadowProjection,
} from "../qd-pre-resolution-exit.js";

const tokenId = createTokenId("qd-token");
const now = Date.parse("2026-06-11T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

function endDateAt(ttcMs: number): string {
  return new Date(now + ttcMs).toISOString();
}

function market(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId,
    conditionId: "condition",
    slug: "qd-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Q.D?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    // Default: 1h to close → within the 2h TTC threshold.
    endDate: endDateAt(HOUR_MS),
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
    // Illiquid cohort by default — the population D9's liquidity gate excludes.
    publicTradeCount24h: 5,
    // Long-lived market by default → not a "short market" (lifetime ≫ 4h).
    gammaCreatedAt: "2026-01-01T00:00:00.000Z",
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
    firstTradePrice: 0.01,
    // Long hold so D8's hold-time gate is satisfied (D8 fire depends only on the
    // eval price the caller passes).
    firstTradeAt: "2026-06-01T00:00:00.000Z",
    lastTradeAt: "2026-06-01T00:10:00.000Z",
    updatedAt: "2026-06-01T00:10:00.000Z",
    cumulativeBuySize: 100,
    cumulativeBuyNotional: 1, // avg buy 0.01 → D8 threshold 2.0 (<0.02 bucket)
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
    avgEntryPrice: 0.03, // in cohort (<0.05), above the ultra-cheap lottery tail
    costBasisUsdc: 3,
    currentValueUsdc: 3,
    realizedPnl: 0,
    status: "open",
    entryStyle: "probe",
    openedAt: "2026-06-01T00:00:00.000Z",
    closedAt: null,
    updatedAt: "2026-06-01T00:10:00.000Z",
    ...overrides,
  };
}

const QD_DEFAULTS: QdPreResolutionExitPolicy = {
  enabled: true,
  ttcThresholdMs: 2 * HOUR_MS,
  tierCeiling: 0.05,
  bidFloorAbs: 0.01,
  salvageEnabled: false,
  salvageTtcMs: 30 * MIN_MS,
  salvageFloorRatio: 0.5,
};

function policyWith(
  qd: Partial<QdPreResolutionExitPolicy> = {},
  base: Partial<ExecutionPolicy> = {},
): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    profitTarget: { ...DEFAULT_EXECUTION_POLICY.profitTarget, enabled: true, holdSecondsMin: 0 },
    preResolutionExit: { ...QD_DEFAULTS, ...qd },
    ...base,
  };
}

function evaluate(
  overrides: {
    market?: NormalizedMarket;
    legState?: LegState;
    position?: Position | null;
    executionPolicy?: ExecutionPolicy | null;
    d8EvalPrice?: number;
    d9EvalPrice?: number;
    hasActiveSell?: boolean;
  } = {},
): QdShadowProjection | null {
  return evaluateQdPreResolutionExit({
    market: overrides.market ?? market(),
    legState: overrides.legState ?? leg(),
    position: overrides.position === undefined ? position() : overrides.position,
    executionPolicy:
      overrides.executionPolicy === undefined ? policyWith() : overrides.executionPolicy,
    now,
    // Defaults chosen so neither D8 nor D9 fires; tests opt into a collision.
    d8EvalPrice: overrides.d8EvalPrice ?? 0.01, // ratio 1.0 < threshold 2.0 → no D8
    d9EvalPrice: overrides.d9EvalPrice ?? 0.005,
    hasActiveSell: overrides.hasActiveSell ?? false,
  });
}

describe("evaluateQdPreResolutionExit — null guards", () => {
  it("returns null when bestBid is missing or non-positive", () => {
    expect(evaluate({ market: market({ bestBid: null }) })).toBeNull();
    expect(evaluate({ market: market({ bestBid: 0 }) })).toBeNull();
  });

  it("returns null when tickSize is invalid", () => {
    expect(evaluate({ market: market({ tickSize: 0 }) })).toBeNull();
  });
});

describe("evaluateQdPreResolutionExit — eligibility gates", () => {
  it("is disabled when the master flag is off", () => {
    const p = evaluate({ executionPolicy: policyWith({ enabled: false }) })!;
    expect(p.qdWouldActivate).toBe(false);
    expect(p.reason).toBe("disabled");
  });

  it("reports no_position when avg entry is unavailable", () => {
    const p = evaluate({ position: null })!;
    expect(p.avgEntry).toBeNull();
    expect(p.qdWouldActivate).toBe(false);
    expect(p.reason).toBe("no_position");
  });

  it("excludes positions above the tier ceiling (0.051) and admits the boundary (0.049)", () => {
    const out = evaluate({
      position: position({ avgEntryPrice: 0.051 }),
      market: market({ bestBid: 0.06, bestAsk: 0.08, midPrice: 0.07 }),
    })!;
    expect(out.reason).toBe("wrong_tier");
    expect(out.qdWouldActivate).toBe(false);

    const inCohort = evaluate({
      position: position({ avgEntryPrice: 0.049 }),
      market: market({ bestBid: 0.05, bestAsk: 0.08, midPrice: 0.065 }),
    })!;
    expect(inCohort.reason).toBe("would_fire");
    expect(inCohort.activationMode).toBe("mode_a");
    expect(inCohort.qdWouldActivate).toBe(true);
  });
});

describe("evaluateQdPreResolutionExit — TTC gate", () => {
  it("fires just below the TTC threshold and defers just above it", () => {
    const below = evaluate({
      market: market({ endDate: endDateAt(HOUR_MS), bestBid: 0.03, bestAsk: 0.05, midPrice: 0.04 }),
    })!;
    expect(below.reason).toBe("would_fire");
    expect(below.qdWouldActivate).toBe(true);

    const above = evaluate({
      market: market({
        endDate: endDateAt(3 * HOUR_MS),
        bestBid: 0.03,
        bestAsk: 0.05,
        midPrice: 0.04,
      }),
    })!;
    expect(above.reason).toBe("ttc_too_far");
    expect(above.qdWouldActivate).toBe(false);
  });

  it("reports ttc_unavailable when the market has no endDate", () => {
    const p = evaluate({
      market: market({ endDate: null as unknown as string, bestBid: 0.03, bestAsk: 0.05 }),
    })!;
    expect(p.reason).toBe("ttc_unavailable");
    expect(p.qdWouldActivate).toBe(false);
  });

  it("uses the 0.25×lifetime fraction on short markets (no immediate fire after entry)", () => {
    // Lifetime 2h (< 2×threshold = 4h) → short market; effective threshold = 30m.
    const shortMarket = market({
      gammaCreatedAt: new Date(now - HOUR_MS).toISOString(),
      endDate: endDateAt(HOUR_MS), // TTC 1h ≥ 30m effective → defer
      bestBid: 0.03,
      bestAsk: 0.05,
      midPrice: 0.04,
    });
    const deferred = evaluate({ market: shortMarket })!;
    expect(deferred.shortMarket).toBe(true);
    expect(deferred.reason).toBe("ttc_too_far");

    const firing = evaluate({
      market: market({
        gammaCreatedAt: new Date(now - HOUR_MS).toISOString(),
        endDate: endDateAt(20 * MIN_MS), // TTC 20m < 30m effective → within
        bestBid: 0.03,
        bestAsk: 0.05,
        midPrice: 0.04,
      }),
    })!;
    expect(firing.shortMarket).toBe(true);
    expect(firing.qdWouldActivate).toBe(true);
  });
});

describe("evaluateQdPreResolutionExit — bid quality (T5)", () => {
  it("excludes lottery-ticket bids below the 0.01 floor", () => {
    const p = evaluate({
      market: market({ bestBid: 0.009, bestAsk: 0.05, midPrice: 0.03 }),
    })!;
    expect(p.qualifyingBid).toBe(false);
    expect(p.reason).toBe("no_qualifying_bid");
    expect(p.qdWouldActivate).toBe(false);
  });

  it("admits a 0.011 bid past the floor but holds when it is below entry (Mode A)", () => {
    const p = evaluate({
      market: market({ bestBid: 0.011, bestAsk: 0.05, midPrice: 0.03 }),
      position: position({ avgEntryPrice: 0.03 }),
    })!;
    expect(p.qualifyingBid).toBe(true);
    expect(p.modeAApplies).toBe(false);
    expect(p.reason).toBe("below_entry_hold");
    expect(p.qdWouldActivate).toBe(false);
  });
});

describe("evaluateQdPreResolutionExit — Mode A (profit-lock, default)", () => {
  it("holds when bestBid is below avg entry", () => {
    const p = evaluate({
      market: market({ bestBid: 0.02, bestAsk: 0.05, midPrice: 0.035 }),
      position: position({ avgEntryPrice: 0.03 }),
    })!;
    expect(p.bidVsAvgEntry).toBeCloseTo(0.02 / 0.03, 9);
    expect(p.modeAApplies).toBe(false);
    expect(p.reason).toBe("below_entry_hold");
  });

  it("fires when bestBid is at or above avg entry", () => {
    const p = evaluate({
      market: market({ bestBid: 0.03, bestAsk: 0.05, midPrice: 0.04 }),
      position: position({ avgEntryPrice: 0.03 }),
    })!;
    expect(p.modeAApplies).toBe(true);
    expect(p.activationMode).toBe("mode_a");
    expect(p.reason).toBe("would_fire");
    expect(p.qdWouldActivate).toBe(true);
  });
});

describe("evaluateQdPreResolutionExit — Mode B (salvage, opt-in)", () => {
  it("fires when salvage is enabled, TTC is imminent, and bestBid clears the salvage floor", () => {
    const p = evaluate({
      executionPolicy: policyWith({ salvageEnabled: true }),
      market: market({
        endDate: endDateAt(20 * MIN_MS), // imminent (< 30m)
        bestBid: 0.018, // 0.6× of 0.03 ≥ 0.5× floor
        bestAsk: 0.05,
        midPrice: 0.034,
      }),
      position: position({ avgEntryPrice: 0.03 }),
    })!;
    expect(p.imminentTtc).toBe(true);
    expect(p.modeBApplies).toBe(true);
    expect(p.activationMode).toBe("mode_b_salvage");
    expect(p.qdWouldActivate).toBe(true);
  });

  it("holds when bestBid is below the salvage floor (0.4× < 0.5×)", () => {
    const p = evaluate({
      executionPolicy: policyWith({ salvageEnabled: true }),
      market: market({
        endDate: endDateAt(20 * MIN_MS),
        bestBid: 0.012, // 0.4× of 0.03 < 0.5× floor
        bestAsk: 0.05,
        midPrice: 0.031,
      }),
      position: position({ avgEntryPrice: 0.03 }),
    })!;
    expect(p.modeBApplies).toBe(false);
    expect(p.reason).toBe("below_entry_hold");
    expect(p.qdWouldActivate).toBe(false);
  });

  it("records Mode B applicability for analysis even while salvage is OFF (no activation)", () => {
    const p = evaluate({
      executionPolicy: policyWith({ salvageEnabled: false }),
      market: market({
        endDate: endDateAt(20 * MIN_MS),
        bestBid: 0.018, // would clear the salvage floor if it were on
        bestAsk: 0.05,
        midPrice: 0.034,
      }),
      position: position({ avgEntryPrice: 0.03 }),
    })!;
    expect(p.modeBApplies).toBe(true); // logged for the shadow synthesis
    expect(p.modeAApplies).toBe(false);
    expect(p.qdWouldActivate).toBe(false); // but salvage is off → no activation
    expect(p.activationMode).toBe("not_activated");
    expect(p.reason).toBe("below_entry_hold");
  });
});

describe("evaluateQdPreResolutionExit — D8/D9 precedence (T4)", () => {
  it("keeps D8 predicate telemetry but does not yield without an active SELL", () => {
    const p = evaluate({
      market: market({ bestBid: 0.03, bestAsk: 0.05, midPrice: 0.04 }),
      position: position({ avgEntryPrice: 0.03 }),
      d8EvalPrice: 0.03, // ratio 3.0 ≥ threshold 2.0 → D8 fires
    })!;
    expect(p.d8Fired).toBe(true);
    expect(p.d9Fired).toBe(false);
    expect(p.reason).toBe("would_fire");
    expect(p.activationMode).toBe("mode_a");
    expect(p.qdWouldActivate).toBe(true);
  });

  it("keeps D9 predicate telemetry but does not yield without an active SELL", () => {
    const p = evaluate({
      executionPolicy: policyWith(
        {},
        {
          lossExit: { ...DEFAULT_EXECUTION_POLICY.lossExit, enabled: true },
        },
      ),
      market: market({
        bestBid: 0.03,
        bestAsk: 0.05,
        midPrice: 0.04,
        publicTradeCount24h: 50, // liquid → D9 gate passes
      }),
      position: position({ avgEntryPrice: 0.03 }),
      d8EvalPrice: 0.005, // no D8
      d9EvalPrice: 0.005, // ratio 0.5 < 1.0 → in loss → D9 fires
    })!;
    expect(p.d9Fired).toBe(true);
    expect(p.d8Fired).toBe(false);
    expect(p.reason).toBe("would_fire");
    expect(p.activationMode).toBe("mode_a");
    expect(p.qdWouldActivate).toBe(true);
  });
});

describe("evaluateQdPreResolutionExit — position state (T3)", () => {
  it("defers when a working SELL order already exists", () => {
    const p = evaluate({
      market: market({ bestBid: 0.03, bestAsk: 0.05, midPrice: 0.04 }),
      position: position({ avgEntryPrice: 0.03 }),
      hasActiveSell: true,
    })!;
    expect(p.reason).toBe("has_active_sell");
    expect(p.qdWouldActivate).toBe(false);
  });
});

describe("evaluateQdPreResolutionExit — pricing (F1 + F2, TTC-tiered anchor)", () => {
  it("uses anchorTicks=4 at moderate TTC and applies no F2 cap on a wide book", () => {
    const p = evaluate({
      market: market({
        endDate: endDateAt(HOUR_MS), // moderate (≥ 30m, < 2h)
        bestBid: 0.03,
        bestAsk: 0.045,
        midPrice: 0.0375,
      }),
      position: position({ avgEntryPrice: 0.03 }),
    })!;
    expect(p.imminentTtc).toBe(false);
    expect(p.anchorTicks).toBe(4);
    // F1 = bestBid + 4 ticks = 0.034; F2 cap 0.0408 does not bind.
    expect(p.candidatePrice).toBeCloseTo(0.034, 9);
  });

  it("degrades to anchorTicks=0 (place at bestBid) at imminent TTC", () => {
    const p = evaluate({
      executionPolicy: policyWith({ salvageEnabled: true }),
      market: market({
        endDate: endDateAt(20 * MIN_MS), // imminent (< 30m)
        bestBid: 0.03,
        bestAsk: 0.045,
        midPrice: 0.0375,
      }),
      position: position({ avgEntryPrice: 0.03 }),
    })!;
    expect(p.imminentTtc).toBe(true);
    expect(p.anchorTicks).toBe(0);
    expect(p.candidatePrice).toBeCloseTo(0.03, 9); // exactly bestBid
  });

  it("binds the F2 tier cap when F1 sits inside a tight spread above the tier", () => {
    const p = evaluate({
      market: market({
        endDate: endDateAt(HOUR_MS),
        tickSize: 0.001,
        bestBid: 0.05,
        bestAsk: 0.07,
        midPrice: 0.06,
      }),
      position: position({ avgEntryPrice: 0.03 }),
    })!;
    // F1 = 0.054 (bestBid + 4 ticks), F2 cap = 0.03 × 1.36 = 0.0408 → floor 0.040.
    expect(p.f2Cap).toBeCloseTo(0.0408, 9);
    expect(p.candidatePrice).toBeCloseTo(0.04, 9);
    expect(p.candidatePrice).toBeLessThan(p.bidAnchoredPrice);
  });
});

// docs/plans/2026-07-16-bounce-exit-ladder-redesign.md Phase 3 (REV3 R2-H1):
// the GATE-scoped bounce-exit backstop wrapper. Reuses this file's Mode-A/B
// shape via evaluateQdPreResolutionExit, but with `ttcThresholdMs` overridden
// to `bounceExit.backstopTtcHours` and `tierCeiling` overridden to
// `gateEntry.maxPrice` — both proven explicitly below, distinct from the
// general (unmodified) Q.D shadow covered by the describe blocks above.
describe("evaluateBounceBackstopEligibility", () => {
  const ENABLED_BOUNCE_EXIT = {
    ...DEFAULT_BOUNCE_EXIT,
    enabled: true,
    mode: "micro_live" as const,
    whitelistConditionIds: ["condition"],
    backstopTtcHours: 2,
  };

  function backstopPolicy(
    overrides: {
      bounceExit?: Partial<ExecutionPolicy["bounceExit"]>;
      gateEntry?: Partial<ExecutionPolicy["gateEntry"]>;
    } = {},
  ): ExecutionPolicy {
    return {
      ...DEFAULT_EXECUTION_POLICY,
      preResolutionExit: QD_DEFAULTS,
      bounceExit: { ...ENABLED_BOUNCE_EXIT, ...overrides.bounceExit },
      gateEntry: { ...DEFAULT_GATE_ENTRY, ...overrides.gateEntry },
    };
  }

  function evalBackstop(
    overrides: {
      market?: NormalizedMarket;
      legState?: LegState;
      position?: Position | null;
      executionPolicy?: ExecutionPolicy;
      d8EvalPrice?: number;
      d9EvalPrice?: number;
      hasActiveSell?: boolean;
    } = {},
  ): boolean {
    return evaluateBounceBackstopEligibility({
      market: overrides.market ?? market(),
      legState: overrides.legState ?? leg(),
      position: overrides.position === undefined ? position() : overrides.position,
      executionPolicy: overrides.executionPolicy ?? backstopPolicy(),
      now,
      d8EvalPrice: overrides.d8EvalPrice ?? 0.01,
      d9EvalPrice: overrides.d9EvalPrice ?? 0.005,
      hasActiveSell: overrides.hasActiveSell ?? false,
    });
  }

  it("is true near resolution with a qualifying bid at/above avg entry (Mode A shape reused)", () => {
    expect(
      evalBackstop({
        market: market({
          endDate: endDateAt(HOUR_MS),
          bestBid: 0.03,
          bestAsk: 0.05,
          midPrice: 0.04,
        }),
        position: position({ avgEntryPrice: 0.03 }),
      }),
    ).toBe(true);
  });

  it("still fires for a GATE entry priced above Q.D's own 0.05 tier ceiling but within the GATE band (0.15)", () => {
    const entryOverrides = {
      market: market({ endDate: endDateAt(HOUR_MS), bestBid: 0.1, bestAsk: 0.12, midPrice: 0.11 }),
      position: position({ avgEntryPrice: 0.1 }),
    };

    // Contrast: the general (unmodified) Q.D shadow rejects this same
    // position/market outright — proves the override is doing real work,
    // not that 0.1 happens to qualify under Q.D's own tierCeiling.
    const generalQd = evaluate(entryOverrides)!;
    expect(generalQd.reason).toBe("wrong_tier");
    expect(generalQd.qdWouldActivate).toBe(false);

    expect(evalBackstop(entryOverrides)).toBe(true);
  });

  it("still enforces a tier ceiling — false once avgEntry clears the GATE band (gateEntry.maxPrice)", () => {
    expect(
      evalBackstop({
        market: market({
          endDate: endDateAt(HOUR_MS),
          bestBid: 0.16,
          bestAsk: 0.18,
          midPrice: 0.17,
        }),
        position: position({ avgEntryPrice: 0.16 }),
      }),
    ).toBe(false);
  });

  // Phase 3 Codex FIX 3: GATE admission is inclusive (avgEntry <= maxPrice,
  // 0.15 by default), but Q.D's own tier check is exclusive
  // (avgEntry >= tierCeiling → wrong_tier). A GATE entry at exactly the
  // admission ceiling must still be backstop-eligible — the GATE wrapper's
  // tierCeilingInclusive override is what makes that true.
  it("is eligible for a GATE entry at exactly gateEntry.maxPrice (0.15) — inclusive tier boundary", () => {
    expect(
      evalBackstop({
        market: market({
          endDate: endDateAt(HOUR_MS),
          bestBid: 0.15,
          bestAsk: 0.17,
          midPrice: 0.16,
        }),
        position: position({ avgEntryPrice: 0.15 }),
      }),
    ).toBe(true);
  });

  it("is NOT eligible one tick above gateEntry.maxPrice (0.151) — inclusive boundary does not widen the band", () => {
    expect(
      evalBackstop({
        market: market({
          endDate: endDateAt(HOUR_MS),
          bestBid: 0.151,
          bestAsk: 0.17,
          midPrice: 0.16,
        }),
        position: position({ avgEntryPrice: 0.151 }),
      }),
    ).toBe(false);
  });

  it("is false once TTC exceeds bounceExit.backstopTtcHours (converted to ms)", () => {
    const oneHourWindow = backstopPolicy({ bounceExit: { backstopTtcHours: 1 } });
    expect(
      evalBackstop({
        executionPolicy: oneHourWindow,
        market: market({
          endDate: endDateAt(59 * MIN_MS),
          bestBid: 0.03,
          bestAsk: 0.05,
          midPrice: 0.04,
        }),
        position: position({ avgEntryPrice: 0.03 }),
      }),
    ).toBe(true);

    expect(
      evalBackstop({
        executionPolicy: oneHourWindow,
        market: market({
          endDate: endDateAt(61 * MIN_MS),
          bestBid: 0.03,
          bestAsk: 0.05,
          midPrice: 0.04,
        }),
        position: position({ avgEntryPrice: 0.03 }),
      }),
    ).toBe(false);
  });

  it("is false when there is no open position (no_position)", () => {
    expect(
      evalBackstop({
        market: market({
          endDate: endDateAt(HOUR_MS),
          bestBid: 0.03,
          bestAsk: 0.05,
          midPrice: 0.04,
        }),
        position: null,
      }),
    ).toBe(false);
  });

  it("is false when a (caller-filtered) active sell is already resting", () => {
    expect(
      evalBackstop({
        market: market({
          endDate: endDateAt(HOUR_MS),
          bestBid: 0.03,
          bestAsk: 0.05,
          midPrice: 0.04,
        }),
        position: position({ avgEntryPrice: 0.03 }),
        hasActiveSell: true,
      }),
    ).toBe(false);
  });

  it("is false when the bid is below the qualifying-bid floor", () => {
    expect(
      evalBackstop({
        market: market({
          endDate: endDateAt(HOUR_MS),
          bestBid: 0.009,
          bestAsk: 0.05,
          midPrice: 0.03,
        }),
        position: position({ avgEntryPrice: 0.03 }),
      }),
    ).toBe(false);
  });

  it("is false when the bid qualifies but sits below avg entry and salvage (Mode B) is off", () => {
    expect(
      evalBackstop({
        market: market({
          endDate: endDateAt(HOUR_MS),
          bestBid: 0.02,
          bestAsk: 0.05,
          midPrice: 0.035,
        }),
        position: position({ avgEntryPrice: 0.03 }),
      }),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  createTokenId,
  DEFAULT_GATE_ENTRY,
  type AlgoDecisionRule,
  type AlgoSizeRule,
  type GateEntryPolicy,
  type NormalizedMarket,
} from "@krabs/domain";
import {
  GATE_RULE_VERSION,
  LIVE_FEATURE_SET,
  evaluateTwoLaneEntryShadow,
} from "../two-lane-entry-shadow.js";

const tokenId = createTokenId("two-lane-token");

// 40-day lifespan: createdAt → endDate spans 40d (research `created` = gamma createdAt).
const CREATED_AT = "2026-05-01T00:00:00.000Z";
const END_40D = "2026-06-10T00:00:00.000Z";
const END_5D = "2026-05-06T00:00:00.000Z";
const END_10D = "2026-05-11T00:00:00.000Z";

function market(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId,
    conditionId: "two-lane-condition",
    slug: "two-lane-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Two lane?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: END_40D,
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.04,
    bestAsk: 0.06,
    midPrice: 0.05,
    spread: 0.02,
    liquidity: 500,
    minOrderSize: 5,
    tags: ["sports"],
    gammaCreatedAt: CREATED_AT,
    snapshotTs: Date.parse(CREATED_AT),
    ...overrides,
  };
}

// Single FALLBACK BUY size rule controls proposedNotional deterministically.
function buySizeRules(sizeUsdc: number): AlgoSizeRule[] {
  return [
    {
      id: 1,
      actionType: "BUY",
      priority: 99,
      ruleId: "FALLBACK",
      stateCondition: "ANY",
      priceOperator: null,
      priceValue: null,
      nthBuy: null,
      buyCountMin: null,
      buyCountMax: null,
      sizeUsdc,
    },
  ];
}

const DECISION_RULES: AlgoDecisionRule[] = [
  {
    id: 99,
    priority: 99,
    ruleId: "FALLBACK",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    timeSinceLastOperator: null,
    timeSinceLastSeconds: null,
    buyCountMin: null,
    buyCountMax: null,
    holdDurationOperator: null,
    holdDurationSeconds: null,
    action: "BUY",
  },
];

function evaluate(
  overrides: {
    market?: NormalizedMarket;
    r23MaxMidpoint?: number | null;
    sizeUsdc?: number;
    gateEntryPolicy?: GateEntryPolicy | null;
  } = {},
) {
  return evaluateTwoLaneEntryShadow({
    market: overrides.market ?? market(),
    r23MaxMidpoint: overrides.r23MaxMidpoint ?? null,
    executionPolicy: null, // forces the DEFAULT enabled R23 policy (ratio 0.683)
    buySizeRules: buySizeRules(overrides.sizeUsdc ?? 1),
    decisionRules: DECISION_RULES,
    gateEntryPolicy: overrides.gateEntryPolicy ?? null,
  });
}

describe("evaluateTwoLaneEntryShadow", () => {
  it("classifies BOTH when R23 fires and the gate passes", () => {
    // mid 0.05 / max 0.20 → ratio 0.25 ≤ 0.683 (dip fires); size 1 ≤ 13; lifespan 40d > 21.
    const p = evaluate({ r23MaxMidpoint: 0.2, sizeUsdc: 1 });
    expect(p.r23Match).toBe(true);
    expect(p.gateMatch).toBe(true);
    expect(p.laneClass).toBe("BOTH");
    expect(p.scoreVersion).toBe(GATE_RULE_VERSION);
    expect(p.featureSet).toBe(LIVE_FEATURE_SET);
  });

  it("classifies R23_ONLY when R23 fires but the gate fails on lifespan", () => {
    const p = evaluate({
      market: market({ endDate: END_5D }),
      r23MaxMidpoint: 0.2,
      sizeUsdc: 1,
    });
    expect(p.r23Match).toBe(true);
    expect(p.gateMatch).toBe(false);
    expect(p.laneClass).toBe("R23_ONLY");
    expect(p.gateComponents.lifespan_gt_21d).toBe(false);
  });

  it("classifies GATE_ONLY on a non-dip long-life cheap candidate", () => {
    // mid 0.12 / max 0.13 → ratio 0.923 > 0.683 (no dip); gate passes.
    const p = evaluate({
      market: market({ midPrice: 0.12 }),
      r23MaxMidpoint: 0.13,
      sizeUsdc: 1,
    });
    expect(p.r23Match).toBe(false);
    expect(p.gateMatch).toBe(true);
    expect(p.laneClass).toBe("GATE_ONLY");
    // every gate input passes except the inert own_token_readd (fail) and the
    // live-unavailable category_not_blocked (unknown).
    expect(p.gateComponents.size_le_13).toBe(true);
    expect(p.gateComponents.price_gt_0_01).toBe(true);
    expect(p.gateComponents.cheap_side_le_055).toBe(true);
    expect(p.gateComponents.lifespan_gt_21d).toBe(true);
    expect(p.gateComponents.own_token_readd).toBe(false);
    expect(p.gateComponents.category_not_blocked).toBe("unknown");
    // category never makes the candidate UNKNOWN, but is reported missing.
    expect(p.missingComponents).toContain("category_not_blocked");
  });

  it("classifies NEITHER on a non-dip short-life candidate", () => {
    const p = evaluate({
      market: market({ midPrice: 0.12, endDate: END_5D }),
      r23MaxMidpoint: 0.13,
      sizeUsdc: 1,
    });
    expect(p.r23Match).toBe(false);
    expect(p.gateMatch).toBe(false);
    expect(p.laneClass).toBe("NEITHER");
  });

  it("returns UNKNOWN with missing price components when midPrice is absent", () => {
    const p = evaluate({
      market: market({ midPrice: null }),
      r23MaxMidpoint: 0.2,
    });
    expect(p.laneClass).toBe("UNKNOWN");
    expect(p.price).toBeNull();
    expect(p.gateComponents.price_gt_0_01).toBe("unknown");
    expect(p.gateComponents.cheap_side_le_055).toBe("unknown");
    expect(p.missingComponents).toContain("price_gt_0_01");
  });

  it("returns UNKNOWN when lifespan is undeterminable (gammaCreatedAt null)", () => {
    const p = evaluate({
      market: market({ midPrice: 0.12, gammaCreatedAt: null }),
      r23MaxMidpoint: 0.13,
    });
    expect(p.laneClass).toBe("UNKNOWN");
    expect(p.lifespanDays).toBeNull();
    expect(p.gateComponents.lifespan_gt_21d).toBe("unknown");
    expect(p.missingComponents).toContain("lifespan_gt_21d");
  });

  it("keeps own_token_readd inert (always false) on first-entry", () => {
    expect(evaluate({ r23MaxMidpoint: 0.2 }).gateComponents.own_token_readd).toBe(false);
    expect(
      evaluate({ market: market({ midPrice: 0.12 }), r23MaxMidpoint: 0.13 }).gateComponents
        .own_token_readd,
    ).toBe(false);
  });

  it("treats R23 no-history as r23Match=false, not UNKNOWN", () => {
    // r23MaxMidpoint null → R23 no-history; gate still passes → GATE_ONLY.
    const p = evaluate({ market: market({ midPrice: 0.12 }), r23MaxMidpoint: null });
    expect(p.r23Match).toBe(false);
    expect(p.r23NoHistory).toBe(true);
    expect(p.laneClass).not.toBe("UNKNOWN");
    expect(p.laneClass).toBe("GATE_ONLY");
  });

  it("derives proposedNotional from evaluateSize, not from any fired signal", () => {
    // non-dip candidate (no fire): notional must still come from the size rule.
    const p = evaluate({
      market: market({ midPrice: 0.12 }),
      r23MaxMidpoint: 0.13,
      sizeUsdc: 7,
    });
    expect(p.r23Match).toBe(false);
    expect(p.proposedNotional).toBe(7);
    expect(p.gateComponents.size_le_13).toBe(true);
  });
});

describe("evaluateTwoLaneEntryShadow — gateEntryPolicy injection", () => {
  it("gateEntryPolicy=null behaves identically to omitting it (defaults apply)", () => {
    const m = market({ midPrice: 0.12 });
    const omitted = evaluate({ market: m, r23MaxMidpoint: 0.13 });
    const explicitNull = evaluate({ market: m, r23MaxMidpoint: 0.13, gateEntryPolicy: null });
    expect(explicitNull).toEqual(omitted);
  });

  it("overrides the lifespan threshold when a gateEntryPolicy is injected", () => {
    // 10-day lifespan fails the fixed GATE_MIN_LIFESPAN_DAYS=21 default.
    const shortLifeMarket = market({ midPrice: 0.12, endDate: END_10D });
    const withoutPolicy = evaluate({ market: shortLifeMarket, r23MaxMidpoint: 0.13 });
    expect(withoutPolicy.gateComponents.lifespan_gt_21d).toBe(false);
    expect(withoutPolicy.laneClass).toBe("NEITHER");

    const gateEntryPolicy: GateEntryPolicy = { ...DEFAULT_GATE_ENTRY, minLifespanDays: 5 };
    const withPolicy = evaluate({
      market: shortLifeMarket,
      r23MaxMidpoint: 0.13,
      gateEntryPolicy,
    });
    expect(withPolicy.gateComponents.lifespan_gt_21d).toBe(true);
    expect(withPolicy.laneClass).toBe("GATE_ONLY");
  });

  it("overrides the price ceiling when a gateEntryPolicy is injected", () => {
    // 0.60 fails the fixed GATE_MAX_PRICE=0.55 default.
    const pricierMarket = market({ midPrice: 0.6 });
    const withoutPolicy = evaluate({ market: pricierMarket, r23MaxMidpoint: 0.13 });
    expect(withoutPolicy.gateComponents.cheap_side_le_055).toBe(false);

    const gateEntryPolicy: GateEntryPolicy = { ...DEFAULT_GATE_ENTRY, maxPrice: 0.65 };
    const withPolicy = evaluate({ market: pricierMarket, r23MaxMidpoint: 0.13, gateEntryPolicy });
    expect(withPolicy.gateComponents.cheap_side_le_055).toBe(true);
  });

  it("GATE_MAX_NOTIONAL (size_le_13) is never overridden by gateEntryPolicy", () => {
    const gateEntryPolicy: GateEntryPolicy = { ...DEFAULT_GATE_ENTRY, minPrice: 0, maxPrice: 1 };
    const p = evaluate({
      market: market({ midPrice: 0.12 }),
      r23MaxMidpoint: 0.13,
      sizeUsdc: 999,
      gateEntryPolicy,
    });
    expect(p.gateComponents.size_le_13).toBe(false);
    expect(p.gateMatch).toBe(false);
  });
});

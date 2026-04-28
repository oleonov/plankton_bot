import { describe, it, expect } from "vitest";
import { buildLocalFillFromExchangeFill } from "../modules/reconciliation/fill-reconciler.js";
import {
  createConditionId,
  createOrderId,
  createTokenId,
  type ExchangeFill,
  type MarketFeeInfo,
  type Order,
} from "@plankton/domain";

const baseLocalOrder: Pick<
  Order,
  "orderId" | "conditionId" | "signalId" | "signalReason" | "decisionRuleId" | "signalTimestamp"
> = {
  orderId: createOrderId("ord-1"),
  conditionId: createConditionId("0xcond"),
  signalId: null,
  signalReason: null,
  decisionRuleId: null,
  signalTimestamp: null,
};

function makeBuyTakerFill(overrides: Partial<ExchangeFill> = {}): ExchangeFill {
  return {
    fillId: "fill-1",
    orderId: "ord-1",
    clientOrderId: "cloid-1",
    tokenId: createTokenId("tok-1"),
    side: "buy",
    price: 0.5,
    size: 100,
    grossSize: 100,
    liquidityRole: "taker",
    fee: 0,
    feeRateBps: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("buildLocalFillFromExchangeFill — V2 fee metadata", () => {
  it("recomputes net shares from grossSize when V2 feeInfo is present (exponent=1)", () => {
    // V2 SDK fee model: platformFeeRate = rate * (p*(1-p))^e.
    // For taker BUY, share fee = grossSize * platformFeeRate / price.
    // rate=0.04, e=1, p=0.5 → platformFeeRate = 0.04 * 0.25 = 0.01.
    // shareFee = 100 * 0.01 / 0.5 = 2 → net size = 98.
    const fill = makeBuyTakerFill({ grossSize: 100, size: 100, feeRateBps: 0 });
    const feeInfo: MarketFeeInfo = { rate: 0.04, exponent: 1, takerOnly: false };

    const result = buildLocalFillFromExchangeFill(fill, baseLocalOrder, undefined, feeInfo);

    expect(result.fill.size).toBeCloseTo(98, 9);
    // fee USDC = grossSize * platformFeeRate = 100 * 0.01 = 1
    expect(result.fill.fee).toBeCloseTo(1, 9);
  });

  it("treats feeInfo.rate=0 as authoritative zero-fee market (no fee, full shares)", () => {
    // mapper saw feeRateBps=10 (0.001) and baked a V1 share fee. With V2
    // feeInfo.rate=0, the reconciler must override and emit zero fee + full
    // gross shares.
    const fill = makeBuyTakerFill({ grossSize: 100, size: 99.95, feeRateBps: 10 });
    const feeInfo: MarketFeeInfo = { rate: 0, exponent: 1, takerOnly: false };

    const result = buildLocalFillFromExchangeFill(fill, baseLocalOrder, undefined, feeInfo);

    expect(result.fill.size).toBeCloseTo(100, 9);
    expect(result.fill.fee).toBe(0);
  });

  it("applies non-trivial exponent (e=2) to platform fee rate", () => {
    // rate=0.04, e=2, p=0.5 → platformFeeRate = 0.04 * (0.25)^2 = 0.0025.
    // shareFee = 100 * 0.0025 / 0.5 = 0.5 → net size = 99.5
    // fee USDC = 100 * 0.0025 = 0.25
    const fill = makeBuyTakerFill({ grossSize: 100, size: 100, feeRateBps: 0 });
    const feeInfo: MarketFeeInfo = { rate: 0.04, exponent: 2, takerOnly: false };

    const result = buildLocalFillFromExchangeFill(fill, baseLocalOrder, undefined, feeInfo);

    expect(result.fill.size).toBeCloseTo(99.5, 9);
    expect(result.fill.fee).toBeCloseTo(0.25, 9);
  });

  it("treats exponent=0 as a flat-rate fee (does not coerce to 1)", () => {
    // rate=0.04, e=0, p=0.5 → platformFeeRate = 0.04 * 1 = 0.04.
    // shareFee = 100 * 0.04 / 0.5 = 8 → net size = 92.
    // fee USDC = 100 * 0.04 = 4.
    const fill = makeBuyTakerFill({ grossSize: 100, size: 100, feeRateBps: 0 });
    const feeInfo: MarketFeeInfo = { rate: 0.04, exponent: 0, takerOnly: false };

    const result = buildLocalFillFromExchangeFill(fill, baseLocalOrder, undefined, feeInfo);

    expect(result.fill.size).toBeCloseTo(92, 9);
    expect(result.fill.fee).toBeCloseTo(4, 9);
  });

  it("does NOT recompute net shares for SELL (taker SELL has no share fee)", () => {
    const fill = makeBuyTakerFill({
      side: "sell",
      grossSize: 100,
      size: 100,
      feeRateBps: 0,
    });
    const feeInfo: MarketFeeInfo = { rate: 0.04, exponent: 1, takerOnly: false };

    const result = buildLocalFillFromExchangeFill(fill, baseLocalOrder, undefined, feeInfo);

    expect(result.fill.size).toBe(100);
    // SELL fee USDC still computed from V2: grossSize * rate * p*(1-p) = 100 * 0.04 * 0.25 = 1
    expect(result.fill.fee).toBeCloseTo(1, 9);
  });

  it("falls back to mapper-baked size when no feeInfo is supplied", () => {
    const fill = makeBuyTakerFill({ grossSize: 100, size: 97, feeRateBps: 600 });

    const result = buildLocalFillFromExchangeFill(fill, baseLocalOrder, undefined, null);

    expect(result.fill.size).toBe(97);
  });
});

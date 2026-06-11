import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELL_LOOP_GUARD_POLICY,
  classifySellLoopGuardReject,
  classifySellLoopGuardSkip,
  createSellLoopGuardBucket,
  getSellLoopGuardSnapshot,
  recordSellLoopGuardOutcome,
  resetSellLoopGuardBucket,
  type LoopGuardOutcomeKind,
  type SellLoopGuardPolicy,
  type TokenLoopBucket,
} from "../index.js";

const T0 = 1_700_000_000_000;
const SIX_HOURS = 6 * 60 * 60_000;

function policy(overrides: Partial<SellLoopGuardPolicy> = {}): SellLoopGuardPolicy {
  return { ...DEFAULT_SELL_LOOP_GUARD_POLICY, ...overrides };
}

function recordSequence(
  bucket: TokenLoopBucket,
  outcome: LoopGuardOutcomeKind,
  count: number,
  startMs: number,
  stepMs: number,
  pol: SellLoopGuardPolicy,
): number {
  let activatedAt = -1;
  for (let i = 0; i < count; i++) {
    const result = recordSellLoopGuardOutcome(bucket, outcome, startMs + i * stepMs, pol);
    if (result.activated) activatedAt = i;
  }
  return activatedAt;
}

describe("sell loop guard state", () => {
  it("10 post-only no-op events within 6h activates the guard", () => {
    const pol = policy();
    const bucket = createSellLoopGuardBucket();
    const activatedAt = recordSequence(bucket, "post_only_cross_pre_submit", 10, T0, 60_000, pol);
    expect(activatedAt).toBe(9);
    const snap = getSellLoopGuardSnapshot(bucket, T0 + 10 * 60_000, pol);
    expect(snap?.blocked).toBe(true);
    expect(snap?.activeCount).toBe(10);
    expect(snap?.reasonCode).toBe("sell_loop_guard");
  });

  it("9 events within 6h does not activate the guard", () => {
    const pol = policy();
    const bucket = createSellLoopGuardBucket();
    const activatedAt = recordSequence(bucket, "post_only_cross_pre_submit", 9, T0, 60_000, pol);
    expect(activatedAt).toBe(-1);
    const snap = getSellLoopGuardSnapshot(bucket, T0 + 9 * 60_000, pol);
    expect(snap?.blocked).toBe(false);
    expect(snap?.activeCount).toBe(9);
  });

  it("10 events spread over 7h does not activate after old events expire", () => {
    const pol = policy();
    const bucket = createSellLoopGuardBucket();
    // 47 minutes apart => total span ~7.05h, no 6h window ever holds 10.
    const activatedAt = recordSequence(
      bucket,
      "post_only_cross_pre_submit",
      10,
      T0,
      47 * 60_000,
      pol,
    );
    expect(activatedAt).toBe(-1);
    const snap = getSellLoopGuardSnapshot(bucket, T0 + 9 * 47 * 60_000, pol);
    expect(snap?.blocked).toBe(false);
    expect(snap!.activeCount).toBeLessThan(10);
  });

  it("mixed 5 local skips + 5 exchange no-id rejects activates the guard", () => {
    const pol = policy();
    const bucket = createSellLoopGuardBucket();
    recordSequence(bucket, "post_only_cross_pre_submit", 5, T0, 60_000, pol);
    const activatedAt = recordSequence(
      bucket,
      "exchange_no_order_id",
      5,
      T0 + 5 * 60_000,
      60_000,
      pol,
    );
    expect(activatedAt).toBe(4);
    const snap = getSellLoopGuardSnapshot(bucket, T0 + 10 * 60_000, pol);
    expect(snap?.blocked).toBe(true);
    expect(snap?.lastOutcome).toBe("exchange_no_order_id");
  });

  it("disabled policy never activates and returns null snapshot", () => {
    const pol = policy({ enabled: false });
    const bucket = createSellLoopGuardBucket();
    const activatedAt = recordSequence(bucket, "post_only_cross_pre_submit", 20, T0, 60_000, pol);
    expect(activatedAt).toBe(-1);
    expect(getSellLoopGuardSnapshot(bucket, T0, pol)).toBeNull();
  });

  it("countPostOnlyCrossPreSubmit=false ignores local skip events", () => {
    const pol = policy({ countPostOnlyCrossPreSubmit: false });
    const bucket = createSellLoopGuardBucket();
    const activatedAt = recordSequence(bucket, "post_only_cross_pre_submit", 20, T0, 60_000, pol);
    expect(activatedAt).toBe(-1);
    expect(getSellLoopGuardSnapshot(bucket, T0, pol)?.activeCount).toBe(0);
  });

  it("countExchangeNoOrderId=false ignores exchange no-id events", () => {
    const pol = policy({ countExchangeNoOrderId: false });
    const bucket = createSellLoopGuardBucket();
    const activatedAt = recordSequence(bucket, "exchange_no_order_id", 20, T0, 60_000, pol);
    expect(activatedAt).toBe(-1);
    expect(getSellLoopGuardSnapshot(bucket, T0, pol)?.activeCount).toBe(0);
  });

  it("cooldown expires and the guard becomes inactive", () => {
    const pol = policy();
    const bucket = createSellLoopGuardBucket();
    recordSequence(bucket, "post_only_cross_pre_submit", 10, T0, 60_000, pol);
    const blockedSnap = getSellLoopGuardSnapshot(bucket, T0 + 10 * 60_000, pol);
    expect(blockedSnap?.blocked).toBe(true);
    expect(blockedSnap?.blockedUntilMs).not.toBeNull();
    const afterCooldown = getSellLoopGuardSnapshot(bucket, T0 + 10 * 60_000 + SIX_HOURS + 1, pol);
    expect(afterCooldown?.blocked).toBe(false);
    expect(afterCooldown?.blockedUntilMs).toBeNull();
  });

  it("reset clears events and active cooldown", () => {
    const pol = policy();
    const bucket = createSellLoopGuardBucket();
    recordSequence(bucket, "post_only_cross_pre_submit", 10, T0, 60_000, pol);
    expect(getSellLoopGuardSnapshot(bucket, T0 + 10 * 60_000, pol)?.blocked).toBe(true);
    resetSellLoopGuardBucket(bucket);
    const snap = getSellLoopGuardSnapshot(bucket, T0 + 10 * 60_000, pol);
    expect(snap?.blocked).toBe(false);
    expect(snap?.activeCount).toBe(0);
    expect(snap?.blockedUntilMs).toBeNull();
  });
});

describe("sell loop guard event classification", () => {
  it("OrderSkipped post-only-cross-pre-submit / sell counts", () => {
    expect(
      classifySellLoopGuardSkip({ side: "sell", reasonCode: "post-only-cross-pre-submit" }),
    ).toBe("post_only_cross_pre_submit");
  });

  it("OrderSkipped buy does not count", () => {
    expect(
      classifySellLoopGuardSkip({ side: "buy", reasonCode: "post-only-cross-pre-submit" }),
    ).toBeNull();
  });

  it("OrderSkipped with another reason does not count", () => {
    expect(classifySellLoopGuardSkip({ side: "sell", reasonCode: "min-size" })).toBeNull();
  });

  it('OrderRejected reason="exchange returned no order id" / sell counts', () => {
    expect(
      classifySellLoopGuardReject({ side: "sell", reason: "exchange returned no order id" }),
    ).toBe("exchange_no_order_id");
  });

  it('OrderRejected exchangeErrorMessage="exchange returned no order id" / sell counts', () => {
    expect(
      classifySellLoopGuardReject({
        side: "sell",
        reason: "order rejected",
        exchangeErrorMessage: "exchange returned no order id",
      }),
    ).toBe("exchange_no_order_id");
  });

  it('OrderRejected reason="gateway returned success without order id" / sell counts', () => {
    expect(
      classifySellLoopGuardReject({
        side: "sell",
        reason: "gateway returned success without order id",
      }),
    ).toBe("exchange_no_order_id");
  });

  it("min-size, balance, and capacity rejects do not count", () => {
    expect(
      classifySellLoopGuardReject({ side: "sell", reason: "min order size not met" }),
    ).toBeNull();
    expect(
      classifySellLoopGuardReject({ side: "sell", reason: "insufficient balance" }),
    ).toBeNull();
    expect(classifySellLoopGuardReject({ side: "sell", reason: "capacity exceeded" })).toBeNull();
    expect(
      classifySellLoopGuardReject({ side: "buy", reason: "exchange returned no order id" }),
    ).toBeNull();
  });
});

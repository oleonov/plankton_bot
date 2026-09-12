import { describe, expect, it, vi } from "vitest";
import {
  createBuySignalBudgetCircuitBreaker,
  computeDynamicSellCapacityLimits,
  evaluateTotalOrdersCapacity,
  evaluateWalletBuyCapacity,
  evaluateWalletSellCapacity,
  readWalletBalanceUsdc,
  resolveProtectedWalletBuyRequirement,
  resolveEntriesBlocked,
} from "../wallet-buy-budget.js";
import {
  DEFAULT_EXECUTION_POLICY,
  type BuyCapacityPolicy,
  type ExecutionPolicy,
  type OrderCapacityPolicy,
  type OrderRepository,
  type Signal,
  type ProfileId,
  type SellCapacityPolicy,
} from "@krabs/domain";

const buyPolicy: BuyCapacityPolicy = {
  enabled: true,
  minNewEntryWalletHeadroomUsdc: 7,
  minAddWalletHeadroomUsdc: 5,
  minViableEntryUsdc: 1,
  maxOpenBuyOrders: 25,
  maxOpenBuyOrdersPerToken: 2,
};

const sellPolicy: SellCapacityPolicy = {
  enabled: true,
  mode: "legacy_global",
  maxOpenSellOrders: 10,
  maxOpenSellOrdersPerToken: 2,
  profileLadderLiveRungsPerPosition: 2,
  minNonLadderReserve: 10,
  nonLadderReserveRatio: 0.25,
  hardMaxOpenSellOrders: 200,
};

const orderPolicy: OrderCapacityPolicy = {
  enabled: true,
  maxOpenOrdersTotal: 22,
};

describe("candidate budget preflight", () => {
  function fixture(balance: number | null = 10) {
    const orderRepo = {
      findOpenCapacityProjection: vi.fn(
        () => [] as ReturnType<NonNullable<OrderRepository["findOpenCapacityProjection"]>>,
      ),
      sumOpenBuyNotional: vi.fn(() => 0),
    };
    const policy = {
      ...DEFAULT_EXECUTION_POLICY,
      buyCapacity: { ...buyPolicy },
      orderCapacity: { ...orderPolicy },
    };
    const breaker = createBuySignalBudgetCircuitBreaker({
      orderRepo,
      executionPolicy: () => policy,
      activeProfile: "paper" as ProfileId,
      controlDb: { prepare: () => ({ get: () => ({ wallet_balance_usdc: balance }) }) },
    });
    const signal = { tokenId: "candidate", side: "buy", reason: "probe-entry" } as Signal;
    return {
      orderRepo,
      policy,
      signal,
      attempt: (amount = 0.99, context?: Parameters<typeof breaker.canAttemptBuy>[2]) =>
        breaker.canAttemptBuy(amount, signal, context),
    };
  }

  it("shares failed-burst reads, refreshes before admission, and expires at the next microtask", async () => {
    const f = fixture();
    for (let i = 0; i < 20; i++) expect(f.attempt(8.41).canAttempt).toBe(false);
    expect(f.orderRepo.findOpenCapacityProjection).toHaveBeenCalledTimes(1);
    expect(f.orderRepo.sumOpenBuyNotional).toHaveBeenCalledExactlyOnceWith("remaining");
    f.orderRepo.sumOpenBuyNotional.mockReturnValue(3);
    expect(f.attempt().canAttempt).toBe(false); // reused facts would admit, refreshed facts reject
    expect(f.orderRepo.findOpenCapacityProjection).toHaveBeenCalledTimes(2);
    f.orderRepo.sumOpenBuyNotional.mockReturnValue(0);
    expect(f.attempt().canAttempt).toBe(false);
    await Promise.resolve();
    expect(f.attempt().canAttempt).toBe(true);
    expect(f.orderRepo.findOpenCapacityProjection).toHaveBeenCalledTimes(3);
    expect(f.attempt().canAttempt).toBe(true); // admission discards the snapshot
    expect(f.orderRepo.findOpenCapacityProjection).toHaveBeenCalledTimes(4);
  });

  it("propagates projection errors, caches them within the burst, and recovers next microtask", async () => {
    const f = fixture();
    const error = new Error("projection unavailable");
    f.orderRepo.findOpenCapacityProjection.mockImplementation(() => {
      throw error;
    });
    for (let i = 0; i < 20; i++) expect(() => f.attempt()).toThrow(error);
    expect(f.orderRepo.findOpenCapacityProjection).toHaveBeenCalledTimes(1);
    expect(f.orderRepo.sumOpenBuyNotional).not.toHaveBeenCalled();
    f.orderRepo.findOpenCapacityProjection.mockReturnValue([]);
    expect(() => f.attempt()).toThrow(error);
    await Promise.resolve();
    expect(f.attempt().canAttempt).toBe(true);
    expect(f.orderRepo.findOpenCapacityProjection).toHaveBeenCalledTimes(2);
    expect(f.orderRepo.sumOpenBuyNotional).toHaveBeenCalledExactlyOnceWith("remaining");
  });

  it.each([
    ["same-token BUY", "candidate", "buy", 2, "per_token_buy_limit"],
    ["global BUY", "other", "buy", 25, "buy_order_count_limit"],
    ["SELL total", "other", "sell", 22, "total_orders_capacity_exhausted"],
  ] as const)(
    "refreshes %s counts before admitting from a cached rejection",
    async (_label, tokenId, side, count, reasonCode) => {
      const f = fixture();
      expect(f.attempt(8.41).canAttempt).toBe(false);
      f.orderRepo.findOpenCapacityProjection.mockReturnValue(
        Array.from({ length: count }, () => ({ tokenId: tokenId as Signal["tokenId"], side })),
      );
      expect(f.attempt()).toMatchObject({ canAttempt: false, reasonCode, activateCooldown: false });
      expect(f.orderRepo.findOpenCapacityProjection).toHaveBeenCalledTimes(2);
      expect(f.orderRepo.sumOpenBuyNotional).toHaveBeenCalledTimes(2);
      f.orderRepo.findOpenCapacityProjection.mockReturnValue([]);
      expect(f.attempt()).toMatchObject({ canAttempt: false, reasonCode });
      expect(f.orderRepo.findOpenCapacityProjection).toHaveBeenCalledTimes(2);
      await Promise.resolve();
      expect(f.attempt().canAttempt).toBe(true);
      expect(f.orderRepo.findOpenCapacityProjection).toHaveBeenCalledTimes(3);
      expect(f.attempt().canAttempt).toBe(true);
      expect(f.orderRepo.findOpenCapacityProjection).toHaveBeenCalledTimes(4);
      expect(f.orderRepo.sumOpenBuyNotional.mock.calls).toEqual(Array(4).fill(["remaining"]));
    },
  );

  it("propagates a fresh projection failure instead of admitting from cached facts", async () => {
    const f = fixture();
    expect(f.attempt(8.41).canAttempt).toBe(false);
    f.orderRepo.findOpenCapacityProjection.mockImplementation(() => {
      throw new Error("refresh unavailable");
    });
    expect(() => f.attempt()).toThrow("refresh unavailable");
    expect(() => f.attempt()).toThrow("refresh unavailable");
    expect(f.orderRepo.findOpenCapacityProjection).toHaveBeenCalledTimes(2);
    expect(f.orderRepo.sumOpenBuyNotional).toHaveBeenCalledTimes(1);
    f.orderRepo.findOpenCapacityProjection.mockReturnValue([]);
    await Promise.resolve();
    expect(f.attempt().canAttempt).toBe(true);
    expect(f.orderRepo.findOpenCapacityProjection).toHaveBeenCalledTimes(3);
    expect(f.orderRepo.sumOpenBuyNotional).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["per_token_buy_limit", { pendingPreOpenBuyCountForToken: 2 }],
    ["buy_order_count_limit", { pendingPreOpenBuyCount: 25 }],
    ["total_orders_capacity_exhausted", { pendingPreOpenBuyCount: 22 }],
  ])("enforces %s before returning unknown wallet", (reasonCode, pending) => {
    const f = fixture(null);
    expect(f.attempt().canAttempt).toBeNull();
    expect(
      f.attempt(0.99, {
        pendingPreOpenBuyCount: 0,
        pendingPreOpenBuyCountForToken: 0,
        pendingPreOpenBuyNotionalUsdc: 0,
        ...pending,
      }),
    ).toMatchObject({ canAttempt: false, reasonCode, activateCooldown: false });
  });

  it("recomputes pending money, entry/add headroom and policy for each candidate", () => {
    const f = fixture();
    expect(f.attempt(8.41).canAttempt).toBe(false);
    const pending = {
      pendingPreOpenBuyCount: 1,
      pendingPreOpenBuyCountForToken: 0,
      pendingPreOpenBuyNotionalUsdc: 2,
    };
    expect(f.attempt(0.99, pending).canAttempt).toBe(false);
    f.signal.reason = "scale-in" as Signal["reason"];
    expect(f.attempt(0.99, pending).canAttempt).toBe(true);
    f.policy.buyCapacity.maxOpenBuyOrders = 1;
    expect(f.attempt(0.99, pending)).toMatchObject({
      reasonCode: "buy_order_count_limit",
      activateCooldown: false,
    });
  });
});

function evaluateBuyOrderSlots(
  maxOpenBuyOrders: number,
  openBuyOrderCount: number,
  protectedOpenBuySlots = 0,
) {
  return evaluateWalletBuyCapacity({
    policy: { ...buyPolicy, maxOpenBuyOrders },
    snapshot: null,
    requiredNotionalUsdc: 1,
    signalReason: "probe-entry",
    openBuyOrderCount,
    protectedOpenBuySlots,
  });
}

describe("order capacity policy evaluators", () => {
  it("protects one capture slot from ordinary BUYs and caps the exact capture before pending", () => {
    const nowMs = Date.parse("2026-08-20T11:00:00.000Z");
    const makerEntry: ExecutionPolicy["makerEntry"] = {
      ...DEFAULT_EXECUTION_POLICY.makerEntry,
      mode: "micro_live",
      microMaxOrderUsdc: 1,
      microLiveWindow: {
        activatedAtUtc: "2026-08-20T10:00:00.000Z",
        expiresAtUtc: "2026-08-20T12:00:00.000Z",
        maxCumulativeAcceptedPendingUsdc: 44,
        captureNextR23: true,
      },
    };
    const ordinary = resolveProtectedWalletBuyRequirement({
      makerEntry,
      authorization: null,
      proposedNotionalUsdc: 2,
      pendingBuyNotionalUsdc: 3,
      nowMs,
    });
    const capture = resolveProtectedWalletBuyRequirement({
      makerEntry,
      authorization: {
        conditionId: "cond",
        source: "strategy",
        side: "buy",
        entryStyle: "maker",
        postOnly: true,
        decisionRuleId: "R23_DIP_TRIGGER",
        signalReason: "probe-entry",
        signalTimestamp: new Date(nowMs).toISOString(),
      },
      proposedNotionalUsdc: 7,
      pendingBuyNotionalUsdc: 3,
      nowMs,
    });

    expect(ordinary).toMatchObject({
      requiredNotionalUsdc: 6,
      protectedHeadroomUsdc: 1,
      protectedOpenBuySlots: 1,
    });
    expect(capture).toMatchObject({
      requiredNotionalUsdc: 4,
      protectedHeadroomUsdc: 0,
      protectedOpenBuySlots: 0,
      exactCaptureNextR23: true,
    });

    const ordinaryAt24 = evaluateBuyOrderSlots(25, 24, ordinary.protectedOpenBuySlots);
    const captureAt24 = evaluateBuyOrderSlots(25, 24, capture.protectedOpenBuySlots);
    expect(ordinaryAt24).toMatchObject({
      allowed: false,
      reason: "buy_order_count_limit",
      maxOpenBuyOrders: 25,
      protectedOpenBuySlots: 1,
      effectiveMaxOpenBuyOrders: 24,
    });
    expect(captureAt24).toMatchObject({ allowed: true, effectiveMaxOpenBuyOrders: 25 });
    expect(evaluateBuyOrderSlots(25, 25, capture.protectedOpenBuySlots).allowed).toBe(false);
  });

  it("keeps inactive capture and configured unlimited/one-slot policies unambiguous", () => {
    const inactive = resolveProtectedWalletBuyRequirement({
      makerEntry: {
        ...DEFAULT_EXECUTION_POLICY.makerEntry,
        mode: "micro_live",
        microLiveWindow: {
          activatedAtUtc: "2026-08-20T10:00:00.000Z",
          expiresAtUtc: "2026-08-20T12:00:00.000Z",
          maxCumulativeAcceptedPendingUsdc: 44,
          captureNextR23: true,
        },
      },
      authorization: null,
      proposedNotionalUsdc: 1,
      pendingBuyNotionalUsdc: 0,
      nowMs: Date.parse("2026-08-20T12:00:00.000Z"),
    });
    expect(inactive.protectedOpenBuySlots).toBe(0);
    expect(evaluateBuyOrderSlots(25, 24, inactive.protectedOpenBuySlots).allowed).toBe(true);

    const unlimited = evaluateBuyOrderSlots(0, 999, 1);
    const oneSlotReserved = evaluateBuyOrderSlots(1, 0, 1);
    const oneSlotCapture = evaluateBuyOrderSlots(1, 0);
    expect(unlimited).toMatchObject({ allowed: true, effectiveMaxOpenBuyOrders: 0 });
    expect(oneSlotReserved).toMatchObject({ allowed: false, effectiveMaxOpenBuyOrders: 0 });
    expect(oneSlotCapture).toMatchObject({ allowed: true, effectiveMaxOpenBuyOrders: 1 });
  });

  it.each([
    [24, true],
    [25, false],
    [26, false],
  ])("evaluates BUY global cap at open count %i", (openBuyOrderCount, allowed) => {
    const decision = evaluateBuyOrderSlots(25, openBuyOrderCount);

    expect(decision.allowed).toBe(allowed);
    expect(decision.reason).toBe(allowed ? null : "buy_order_count_limit");
  });

  it("keeps cash-headroom rejects distinct from available BUY slots", () => {
    const decision = evaluateWalletBuyCapacity({
      policy: buyPolicy,
      snapshot: {
        walletBalanceUsdc: 10,
        walletBufferUsdc: 0.3,
        reservedBuyUsdc: 1,
        freeUsdcForNewOrders: 8.7,
      },
      requiredNotionalUsdc: 2,
      signalReason: "probe-entry",
      openBuyOrderCount: 1,
    });
    expect(decision).toMatchObject({ allowed: false, reason: "wallet_buy_capacity_exhausted" });
    expect(decision.availableAfterOrderUsdc).toBeCloseTo(6.7);
  });

  it("reserves the final shared order slot without changing the unlimited sentinel", () => {
    expect(
      evaluateTotalOrdersCapacity({
        policy: orderPolicy,
        openOrdersTotal: 21,
        protectedOpenOrderSlots: 1,
      }),
    ).toMatchObject({ allowed: false, effectiveMaxOpenOrdersTotal: 21 });
    expect(
      evaluateTotalOrdersCapacity({
        policy: { ...orderPolicy, maxOpenOrdersTotal: 0 },
        openOrdersTotal: 999,
        protectedOpenOrderSlots: 1,
      }).allowed,
    ).toBe(true);
  });

  it.each([
    [9, true],
    [10, false],
    [11, false],
  ])("evaluates SELL global cap at open count %i", (openSellOrderCount, allowed) => {
    const decision = evaluateWalletSellCapacity({
      policy: sellPolicy,
      openSellOrderCount,
    });

    expect(decision.allowed).toBe(allowed);
  });

  it.each([
    [21, true],
    [22, false],
    [23, false],
  ])("evaluates total open-order cap at open count %i", (openOrdersTotal, allowed) => {
    const decision = evaluateTotalOrdersCapacity({
      policy: orderPolicy,
      openOrdersTotal,
    });

    expect(decision.allowed).toBe(allowed);
  });

  it("caches wallet balance control-DB reads briefly for a BUY burst", () => {
    const get = vi.fn().mockReturnValue({ wallet_balance_usdc: 12.34 });
    const controlDb = {
      prepare: vi.fn().mockReturnValue({ get }),
    };
    const profile = "paper" as ProfileId;

    expect(readWalletBalanceUsdc(controlDb, profile)).toBe(12.34);
    expect(readWalletBalanceUsdc(controlDb, profile)).toBe(12.34);

    expect(controlDb.prepare).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("computes dynamic profile-ladder capacity from profile-owned open positions", () => {
    const dynamicPolicy: SellCapacityPolicy = {
      ...sellPolicy,
      mode: "source_aware_dynamic",
      profileLadderLiveRungsPerPosition: 2,
      minNonLadderReserve: 10,
      nonLadderReserveRatio: 0.25,
      hardMaxOpenSellOrders: 200,
    };

    expect(
      computeDynamicSellCapacityLimits({
        policy: dynamicPolicy,
        profileOwnedOpenPositionCount: 67,
      }),
    ).toMatchObject({
      profileOwnedOpenPositionCount: 67,
      profileLadderCapRaw: 134,
      nonLadderReserve: 34,
      dynamicGlobalCap: 168,
      effectiveProfileLadderCap: 134,
    });

    expect(
      computeDynamicSellCapacityLimits({
        policy: dynamicPolicy,
        profileOwnedOpenPositionCount: 11,
      }).profileLadderCapRaw,
    ).toBe(22);

    expect(
      computeDynamicSellCapacityLimits({
        policy: dynamicPolicy,
        profileOwnedOpenPositionCount: 9,
      }).profileLadderCapRaw,
    ).toBe(18);
  });

  it("protects the non-ladder reserve when hardMax truncates dynamic capacity", () => {
    const dynamicPolicy: SellCapacityPolicy = {
      ...sellPolicy,
      mode: "source_aware_dynamic",
      profileLadderLiveRungsPerPosition: 2,
      minNonLadderReserve: 10,
      nonLadderReserveRatio: 0.25,
      hardMaxOpenSellOrders: 200,
    };

    const limits = computeDynamicSellCapacityLimits({
      policy: dynamicPolicy,
      profileOwnedOpenPositionCount: 100,
    });
    expect(limits).toMatchObject({
      profileOwnedOpenPositionCount: 100,
      profileLadderCapRaw: 200,
      nonLadderReserve: 50,
      dynamicGlobalCap: 200,
      effectiveProfileLadderCap: 150,
    });

    const ladderDecision = evaluateWalletSellCapacity({
      policy: dynamicPolicy,
      source: "profile_ladder",
      openSellOrderCount: 150,
      openProfileLadderSellOrderCount: 150,
      openNonProfileLadderSellOrderCount: 0,
      profileOwnedOpenPositionCount: 100,
    });
    expect(ladderDecision.allowed).toBe(false);
    expect(ladderDecision.rejectionDetail).toBe("profile_ladder_cap");
    expect(ladderDecision.dynamic?.effectiveProfileLadderCap).toBe(150);

    const d8Decision = evaluateWalletSellCapacity({
      policy: dynamicPolicy,
      source: "D8",
      openSellOrderCount: 150,
      openProfileLadderSellOrderCount: 150,
      openNonProfileLadderSellOrderCount: 0,
      profileOwnedOpenPositionCount: 100,
    });
    expect(d8Decision.allowed).toBe(true);
  });

  it("blocks profile_ladder at the dynamic cap while preserving non-ladder reserve", () => {
    const dynamicPolicy: SellCapacityPolicy = {
      ...sellPolicy,
      mode: "source_aware_dynamic",
      profileLadderLiveRungsPerPosition: 2,
      minNonLadderReserve: 10,
      nonLadderReserveRatio: 0.25,
      hardMaxOpenSellOrders: 200,
    };

    const ladderDecision = evaluateWalletSellCapacity({
      policy: dynamicPolicy,
      source: "profile_ladder",
      openSellOrderCount: 20,
      openProfileLadderSellOrderCount: 20,
      openNonProfileLadderSellOrderCount: 0,
      profileOwnedOpenPositionCount: 10,
    });
    expect(ladderDecision.allowed).toBe(false);
    expect(ladderDecision.dynamic?.profileLadderCapRaw).toBe(20);
    expect(ladderDecision.dynamic?.effectiveProfileLadderCap).toBe(20);

    const d8Decision = evaluateWalletSellCapacity({
      policy: dynamicPolicy,
      source: "D8",
      openSellOrderCount: 20,
      openProfileLadderSellOrderCount: 20,
      openNonProfileLadderSellOrderCount: 0,
      profileOwnedOpenPositionCount: 10,
    });
    expect(d8Decision.allowed).toBe(true);
  });

  it("keeps hardMaxOpenSellOrders as the final dynamic safety rail", () => {
    const dynamicPolicy: SellCapacityPolicy = {
      ...sellPolicy,
      mode: "source_aware_dynamic",
      profileLadderLiveRungsPerPosition: 2,
      minNonLadderReserve: 10,
      nonLadderReserveRatio: 0.25,
      hardMaxOpenSellOrders: 21,
    };

    const decision = evaluateWalletSellCapacity({
      policy: dynamicPolicy,
      source: "D8",
      openSellOrderCount: 21,
      openProfileLadderSellOrderCount: 20,
      openNonProfileLadderSellOrderCount: 1,
      profileOwnedOpenPositionCount: 10,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.dynamic?.dynamicGlobalCap).toBe(21);
  });

  it("clamps profile ladder capacity to zero when hardMax is below the reserve", () => {
    const dynamicPolicy: SellCapacityPolicy = {
      ...sellPolicy,
      mode: "source_aware_dynamic",
      profileLadderLiveRungsPerPosition: 2,
      minNonLadderReserve: 10,
      nonLadderReserveRatio: 0.25,
      hardMaxOpenSellOrders: 8,
    };

    const limits = computeDynamicSellCapacityLimits({
      policy: dynamicPolicy,
      profileOwnedOpenPositionCount: 10,
    });
    expect(limits).toMatchObject({
      profileLadderCapRaw: 20,
      nonLadderReserve: 10,
      dynamicGlobalCap: 8,
      effectiveProfileLadderCap: 0,
    });

    const decision = evaluateWalletSellCapacity({
      policy: dynamicPolicy,
      source: "profile_ladder",
      openSellOrderCount: 0,
      openProfileLadderSellOrderCount: 0,
      openNonProfileLadderSellOrderCount: 0,
      profileOwnedOpenPositionCount: 10,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.rejectionDetail).toBe("profile_ladder_cap");
  });

  it("preserves legacy_global source-blind behavior", () => {
    const legacyPolicy: SellCapacityPolicy = {
      ...sellPolicy,
      mode: "legacy_global",
      profileLadderLiveRungsPerPosition: 2,
      minNonLadderReserve: 10,
      nonLadderReserveRatio: 0.25,
      hardMaxOpenSellOrders: 200,
    };

    const decision = evaluateWalletSellCapacity({
      policy: legacyPolicy,
      source: "D8",
      openSellOrderCount: 10,
      openProfileLadderSellOrderCount: 10,
      openNonProfileLadderSellOrderCount: 0,
      profileOwnedOpenPositionCount: 10,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.maxOpenSellOrders).toBe(10);
    expect(decision.dynamic).toBeNull();
  });
});

describe("resolveEntriesBlocked (diagnostic-only)", () => {
  it("blocks when hard-blocked regardless of capacity", () => {
    expect(
      resolveEntriesBlocked({
        hardAllowed: false,
        newEntryCapacityUsdc: 100,
        minViableEntryUsdc: 1,
      }),
    ).toBe(true);
  });

  it("blocks when deployable capacity is below the minimum viable entry", () => {
    expect(
      resolveEntriesBlocked({
        hardAllowed: true,
        newEntryCapacityUsdc: 0.4,
        minViableEntryUsdc: 1,
      }),
    ).toBe(true);
  });

  it("does NOT block when capacity is at or above the minimum viable entry", () => {
    expect(
      resolveEntriesBlocked({ hardAllowed: true, newEntryCapacityUsdc: 1, minViableEntryUsdc: 1 }),
    ).toBe(false);
    expect(
      resolveEntriesBlocked({ hardAllowed: true, newEntryCapacityUsdc: 5, minViableEntryUsdc: 1 }),
    ).toBe(false);
  });

  it("does NOT block when capacity is unknown (null) — unknown is not blocked", () => {
    expect(
      resolveEntriesBlocked({
        hardAllowed: true,
        newEntryCapacityUsdc: null,
        minViableEntryUsdc: 1,
      }),
    ).toBe(false);
  });
});

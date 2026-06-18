import { describe, expect, it, vi } from "vitest";
import {
  computeDynamicSellCapacityLimits,
  evaluateTotalOrdersCapacity,
  evaluateWalletBuyCapacity,
  evaluateWalletSellCapacity,
  readWalletBalanceUsdc,
} from "../wallet-buy-budget.js";
import type {
  BuyCapacityPolicy,
  OrderCapacityPolicy,
  ProfileId,
  SellCapacityPolicy,
} from "@krabs/domain";

const buyPolicy: BuyCapacityPolicy = {
  enabled: true,
  minNewEntryWalletHeadroomUsdc: 7,
  minAddWalletHeadroomUsdc: 5,
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

describe("order capacity policy evaluators", () => {
  it.each([
    [24, true],
    [25, false],
    [26, false],
  ])("evaluates BUY global cap at open count %i", (openBuyOrderCount, allowed) => {
    const decision = evaluateWalletBuyCapacity({
      policy: buyPolicy,
      snapshot: null,
      requiredNotionalUsdc: 1,
      signalReason: "probe-entry",
      openBuyOrderCount,
    });

    expect(decision.allowed).toBe(allowed);
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

import { describe, expect, it, vi } from "vitest";
import {
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
  maxOpenBuyOrders: 15,
  maxOpenBuyOrdersPerToken: 2,
};

const sellPolicy: SellCapacityPolicy = {
  enabled: true,
  maxOpenSellOrders: 10,
  maxOpenSellOrdersPerToken: 2,
};

const orderPolicy: OrderCapacityPolicy = {
  enabled: true,
  maxOpenOrdersTotal: 22,
};

describe("order capacity policy evaluators", () => {
  it.each([
    [14, true],
    [15, false],
    [16, false],
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
});

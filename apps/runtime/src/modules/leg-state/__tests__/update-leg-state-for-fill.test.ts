import { describe, it, expect, vi } from "vitest";
import type {
  LegState,
  LegStateRepository,
  LegStateTransition,
  LegStateTransitionRepository,
} from "@plankton/domain";
import { createTokenId } from "@plankton/domain";
import type { Logger } from "../../../logger.js";
import {
  recordLegStateClearTransition,
  updateLegStateForFill,
} from "../update-leg-state-for-fill.js";

function createMockLegStateRepo(): LegStateRepository {
  const store = new Map<string, LegState>();
  return {
    get: vi.fn((tokenId) => store.get(tokenId) ?? null),
    upsert: vi.fn((state: LegState) => store.set(state.tokenId, state)),
    delete: vi.fn((tokenId) => {
      store.delete(tokenId);
    }),
    getAll: vi.fn(() => [...store.values()]),
  };
}

function createMockLogger(): Logger {
  const log: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return log as Logger;
}

function createMockTransitionRepo(): LegStateTransitionRepository {
  const store: LegStateTransition[] = [];
  return {
    insert: vi.fn((transition) => {
      store.push({ ...transition, id: store.length + 1, createdAt: "2026-01-01T00:00:00Z" });
      return true;
    }),
    findByTokenId: vi.fn(() => store),
    findByPositionId: vi.fn(() => store),
  };
}

const TOKEN = createTokenId("tok-1");

describe("updateLegStateForFill", () => {
  it("inserts new row with buyCount=1 on first buy fill", () => {
    const repo = createMockLegStateRepo();
    const log = createMockLogger();

    updateLegStateForFill(
      repo,
      { tokenId: TOKEN, side: "buy", price: 0.42, filledAt: "2026-01-01T00:00:00Z" },
      log,
      "2026-01-01T00:00:01Z",
    );

    expect(repo.get(TOKEN)).toEqual({
      tokenId: TOKEN,
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.42,
      firstTradeAt: "2026-01-01T00:00:00Z",
      lastTradeAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
    });
  });

  it("increments buyCount on subsequent buy fills and preserves firstTrade", () => {
    const repo = createMockLegStateRepo();
    const log = createMockLogger();

    updateLegStateForFill(
      repo,
      { tokenId: TOKEN, side: "buy", price: 0.42, filledAt: "2026-01-01T00:00:00Z" },
      log,
      "2026-01-01T00:00:01Z",
    );
    updateLegStateForFill(
      repo,
      { tokenId: TOKEN, side: "buy", price: 0.11, filledAt: "2026-01-02T00:00:00Z" },
      log,
      "2026-01-02T00:00:01Z",
    );

    const state = repo.get(TOKEN);
    expect(state?.buyCount).toBe(2);
    expect(state?.firstTradePrice).toBe(0.42);
    expect(state?.firstTradeAt).toBe("2026-01-01T00:00:00Z");
    expect(state?.lastTradeAt).toBe("2026-01-02T00:00:00Z");
    expect(state?.lastAction).toBe("BUY");
  });

  it("increments sellCount and flips lastAction on sell fill after buys", () => {
    const repo = createMockLegStateRepo();
    const log = createMockLogger();

    updateLegStateForFill(
      repo,
      { tokenId: TOKEN, side: "buy", price: 0.42, filledAt: "2026-01-01T00:00:00Z" },
      log,
      "2026-01-01T00:00:01Z",
    );
    updateLegStateForFill(
      repo,
      { tokenId: TOKEN, side: "sell", price: 0.5, filledAt: "2026-01-03T00:00:00Z" },
      log,
      "2026-01-03T00:00:01Z",
    );

    const state = repo.get(TOKEN);
    expect(state?.buyCount).toBe(1);
    expect(state?.sellCount).toBe(1);
    expect(state?.lastAction).toBe("SELL");
    expect(state?.lastTradeAt).toBe("2026-01-03T00:00:00Z");
    expect(state?.firstTradePrice).toBe(0.42);
  });

  it("skips and warns when SELL arrives with no existing leg state", () => {
    const repo = createMockLegStateRepo();
    const log = createMockLogger();

    updateLegStateForFill(
      repo,
      { tokenId: TOKEN, side: "sell", price: 0.5, filledAt: "2026-01-03T00:00:00Z" },
      log,
      "2026-01-03T00:00:01Z",
    );

    expect(repo.get(TOKEN)).toBeNull();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("uses the caller-supplied `now` for updatedAt (deterministic under test)", () => {
    const repo = createMockLegStateRepo();
    const log = createMockLogger();

    updateLegStateForFill(
      repo,
      { tokenId: TOKEN, side: "buy", price: 0.1, filledAt: "2026-01-01T00:00:00Z" },
      log,
      "2099-12-31T23:59:59Z",
    );

    expect(repo.get(TOKEN)?.updatedAt).toBe("2099-12-31T23:59:59Z");
  });

  it("records audited fill transitions with before/after phases and counts", () => {
    const repo = createMockLegStateRepo();
    const transitionRepo = createMockTransitionRepo();
    const log = createMockLogger();

    updateLegStateForFill(
      repo,
      {
        tokenId: TOKEN,
        side: "buy",
        price: 0.1,
        filledAt: "2026-01-01T00:00:00Z",
        fillId: "fill-1" as any,
        orderId: "ord-1" as any,
        clientOrderId: "coid-1" as any,
        conditionId: "cond-1" as any,
        size: 5,
        sizeUsdc: 0.5,
      },
      log,
      "2026-01-01T00:00:01Z",
      { transitionRepo },
    );

    expect(transitionRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: TOKEN,
        fillId: "fill-1",
        fromPhase: "S0",
        toPhase: "S1",
        action: "BUY",
        fromBuyCount: 0,
        toBuyCount: 1,
        price: 0.1,
        size: 5,
        sizeUsdc: 0.5,
      }),
    );
  });

  it("records clear transitions to S0 before leg state deletion", () => {
    const transitionRepo = createMockTransitionRepo();
    const log = createMockLogger();
    const existing: LegState = {
      tokenId: TOKEN,
      buyCount: 2,
      sellCount: 1,
      lastAction: "SELL",
      firstTradePrice: 0.03,
      firstTradeAt: "2026-01-01T00:00:00Z",
      lastTradeAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };

    recordLegStateClearTransition({
      transitionRepo,
      tokenId: TOKEN,
      existing,
      positionId: "pos-1" as any,
      action: "CLEAR",
      reason: "position_size_zero",
      occurredAt: "2026-01-03T00:00:00Z",
      log,
    });

    expect(transitionRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: "pos-1",
        fromPhase: "S3",
        toPhase: "S0",
        action: "CLEAR",
        fromBuyCount: 2,
        fromSellCount: 1,
        toBuyCount: 0,
        toSellCount: 0,
      }),
    );
  });
});

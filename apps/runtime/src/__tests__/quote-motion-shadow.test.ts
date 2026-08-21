import { describe, expect, it, vi } from "vitest";
import {
  BOUNCE_EXIT_TARGET_RULE_ID,
  createConditionId,
  createOrderId,
  createPositionId,
  createTokenId,
  R23_DIP_TRIGGER_RULE_ID,
  type InventoryLot,
  type Order,
  type OrderBookSnapshot,
  type Position,
} from "@krabs/domain";
import {
  QUOTE_MOTION_HEARTBEAT_MS,
  runQuoteMotionShadowPass,
  type QuoteMotionOriginV1,
  type QuoteMotionState,
} from "../quote-motion-shadow.js";

const NOW = Date.parse("2026-08-21T03:00:00.000Z");
const TOKEN = createTokenId("quote-token");
const CONDITION = createConditionId("quote-condition");
const POSITION = createPositionId("quote-position");

function origin(kind: QuoteMotionOriginV1["kind"]): QuoteMotionOriginV1 {
  return {
    version: 1,
    kind,
    cohortId: "cohort-1",
    originalSuggestedPrice: kind === "r23_capture" ? 0.12 : 0.2,
    originalTargetPrice: kind === "bounce_exit_target" ? 0.2 : null,
    entryPriceCeiling: kind === "r23_capture" ? 0.45 : null,
    policySchemaVersion: 11,
    policyControlRevision: 42,
    initialBook: {
      depthStatus: "full",
      bestBid: 0.1,
      bestAsk: 0.13,
      tickSize: 0.01,
      snapshotTs: NOW,
      source: "fresh-cache",
    },
  };
}

function order(kind: QuoteMotionOriginV1["kind"], overrides: Partial<Order> = {}): Order {
  const buy = kind === "r23_capture";
  return {
    orderId: createOrderId(`${kind}-order`),
    clientOrderId: `${kind}-client` as Order["clientOrderId"],
    tokenId: TOKEN,
    conditionId: CONDITION,
    positionId: buy ? null : POSITION,
    side: buy ? "buy" : "sell",
    orderType: "GTC",
    postOnly: true,
    price: buy ? 0.1 : 0.2,
    size: 5,
    sizeUsdc: buy ? 0.5 : 1,
    status: "open",
    exchangeOrderId: "exchange-order",
    signalId: "signal",
    signalReason: buy ? "probe-entry" : "bounce-exit-target",
    decisionRuleId: buy ? R23_DIP_TRIGGER_RULE_ID : BOUNCE_EXIT_TARGET_RULE_ID,
    entryStyle: "maker",
    metadata: {
      quoteMotionV1: origin(kind),
      ...(buy
        ? {
            makerMicroLiveLifecycle: {
              kind: "r23_capture",
              activatedAtUtc: new Date(NOW - 60_000).toISOString(),
              expiresAtUtc: new Date(NOW + 60_000).toISOString(),
              fillWaitMs: 2 * 60 * 60_000,
            },
          }
        : {}),
    },
    botRunId: "run" as Order["botRunId"],
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function book(bestBid = 0.1, bestAsk = 0.13, tickSize = 0.01): OrderBookSnapshot {
  return {
    tokenId: TOKEN,
    bids: [
      { price: bestBid, size: 10 },
      { price: bestBid - tickSize, size: 20 },
    ],
    asks: [
      { price: bestAsk, size: 10 },
      { price: bestAsk + tickSize, size: 20 },
    ],
    bestBid,
    bestAsk,
    midPrice: (bestBid + bestAsk) / 2,
    spread: bestAsk - bestBid,
    timestamp: NOW,
  };
}

function position(): Position {
  return {
    positionId: POSITION,
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "buy",
    size: 5,
    avgEntryPrice: 0.1,
    costBasisUsdc: 0.5,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: "open",
    entryStyle: "maker",
    openedAt: new Date(NOW - 60_000).toISOString(),
    closedAt: null,
    updatedAt: new Date(NOW).toISOString(),
  };
}

function lot(): InventoryLot {
  return {
    lotId: "lot" as InventoryLot["lotId"],
    positionId: POSITION,
    tokenId: TOKEN,
    side: "buy",
    size: 5,
    remainingSize: 5,
    entryPrice: 0.1,
    costUsdc: 0.5,
    fillId: "fill" as InventoryLot["fillId"],
    createdAt: new Date(NOW - 60_000).toISOString(),
  };
}

function harness(
  openOrders: Order[],
  currentBook: OrderBookSnapshot | null = book(),
  currentTickSize = 0.01,
) {
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const deps = {
    orderRepo: { findOpen: () => openOrders },
    fillRepo: { findByOrderId: () => [], findByOrderIds: () => [] },
    positionRepo: { findById: () => position() },
    inventoryLotRepo: { findOpen: () => [lot()] },
    riskEventRepo: { insert: vi.fn((event) => events.push(event)) },
    getFreshBook: vi.fn(async (_tokenId: string, sampledAtMs: number) =>
      currentBook
        ? {
            book: currentBook,
            cachedAtMs: sampledAtMs,
            snapshotTs: sampledAtMs,
            tickSize: currentTickSize,
            source: "clob:ws",
          }
        : null,
    ),
    maxBookAgeMs: 3_000,
  };
  return { deps, events, states: new Map<string, QuoteMotionState>() };
}

describe("quote-motion shadow", () => {
  it("removes our visible bid before evaluating BID+1 and never self-chases", async () => {
    const current = order("r23_capture", { size: 10 });
    const h = harness([current], book(0.1, 0.13));
    await runQuoteMotionShadowPass(h.deps, h.states, NOW);
    expect(h.events[0]?.payload).toMatchObject({
      kind: "r23_capture",
      classification: "buy-hold",
      externalBestBid: 0.09,
      candidatePrice: null,
    });
  });

  it("records a bounded BID+1 opportunity without mutating or publishing an order", async () => {
    const current = order("r23_capture", { size: 2 });
    const h = harness([current], book(0.1, 0.13));
    await runQuoteMotionShadowPass(h.deps, h.states, NOW);
    expect(current.price).toBe(0.1);
    expect(h.events[0]?.payload).toMatchObject({
      classification: "buy-up-opportunity",
      candidatePrice: 0.11,
      externalBestAsk: 0.13,
    });
  });

  it("fails closed when local residual exceeds visible depth", async () => {
    const h = harness([order("r23_capture", { size: 11 })], book());
    await runQuoteMotionShadowPass(h.deps, h.states, NOW);
    expect(h.events[0]?.payload).toMatchObject({
      classification: "self-book-ambiguous",
      candidatePrice: null,
    });
  });

  it("does not subtract a pending sibling that is not confirmed resting", async () => {
    const resting = order("r23_capture", { size: 2 });
    const pending = order("r23_capture", {
      orderId: createOrderId("pending-sibling"),
      status: "pending",
      size: 9,
    });
    const h = harness([resting, pending], book());
    await runQuoteMotionShadowPass(h.deps, h.states, NOW);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.payload).toMatchObject({
      classification: "buy-up-opportunity",
      candidatePrice: 0.11,
    });
  });

  it("uses the current tick rather than the order-origin tick", async () => {
    const h = harness([order("r23_capture", { size: 2 })], book(0.1, 0.14, 0.02), 0.02);
    await runQuoteMotionShadowPass(h.deps, h.states, NOW);
    expect(h.events[0]?.payload).toMatchObject({
      classification: "buy-up-opportunity",
      candidatePrice: 0.12,
      tickSize: 0.02,
    });
  });

  it("records ASK-1 relative to the immutable target with complete lot facts", async () => {
    const h = harness([order("bounce_exit_target")], book(0.15, 0.18));
    await runQuoteMotionShadowPass(h.deps, h.states, NOW);
    expect(h.events[0]?.payload).toMatchObject({
      kind: "bounce_exit_target",
      classification: "sell-below-target",
      candidatePrice: 0.17,
      priceGiveUp: 0.03,
      lotFacts: {
        status: "available",
        count: 1,
        remainingSize: 5,
        remainingCostUsdc: 0.5,
        maxEntryPrice: 0.1,
      },
    });
  });

  it("emits on transition and then only on the five-minute heartbeat", async () => {
    const h = harness([order("r23_capture", { size: 2 })]);
    await runQuoteMotionShadowPass(h.deps, h.states, NOW);
    await runQuoteMotionShadowPass(h.deps, h.states, NOW + QUOTE_MOTION_HEARTBEAT_MS - 1);
    await runQuoteMotionShadowPass(h.deps, h.states, NOW + QUOTE_MOTION_HEARTBEAT_MS);

    expect(h.events).toHaveLength(2);
  });

  it("ignores forged provenance and does not fetch a book for it", async () => {
    const forged = order("bounce_exit_target", { postOnly: false });
    const h = harness([forged]);
    expect(await runQuoteMotionShadowPass(h.deps, h.states, NOW)).toEqual({
      eligible: 0,
      emitted: 0,
    });
    expect(h.deps.getFreshBook).not.toHaveBeenCalled();
  });
});

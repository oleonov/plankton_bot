import { describe, expect, it, vi } from "vitest";
import {
  BOUNCE_EXIT_TARGET_RULE_ID,
  DEFAULT_EXECUTION_POLICY,
  R23_DIP_TRIGGER_RULE_ID,
  createConditionId,
  createFillId,
  createLotId,
  createOrderId,
  createPositionId,
  createTokenId,
  type Fill,
  type InventoryLot,
  type NormalizedMarket,
  type Order,
  type OrderBookSnapshot,
  type Position,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  computeBounceAskCaptureCandidate,
  computeBounceAskCaptureInitialPrice,
  resolveProvenBounceAskOrigin,
} from "../bounce-ask-capture.js";
import { BounceAskCaptureLifecycleModule } from "../modules/bounce-ask-capture/bounce-ask-capture-lifecycle-module.js";

const NOW = Date.parse("2026-08-23T00:00:00.000Z");
const COHORT = "2026-08-01T00:00:00.000Z";
const tokenId = createTokenId("ask-token");
const conditionId = createConditionId("ask-condition");
const positionId = createPositionId("ask-position");

function order(id: string, overrides: Partial<Order> = {}): Order {
  return {
    orderId: createOrderId(id),
    clientOrderId: `client-${id}` as Order["clientOrderId"],
    tokenId,
    conditionId,
    positionId,
    side: "sell",
    postOnly: true,
    entryStyle: "maker",
    price: 0.4,
    size: 10,
    status: "open",
    signalReason: "repricing-exit",
    decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
    ...overrides,
  } as Order;
}

function quoteMotion(kind: "r23_capture" | "bounce_exit_target", cohort = COHORT) {
  return {
    version: 1,
    kind,
    cohortId: cohort,
    originalSuggestedPrice: kind === "r23_capture" ? 0.2 : 0.4,
    originalTargetPrice: kind === "bounce_exit_target" ? 0.3 : null,
    entryPriceCeiling: kind === "r23_capture" ? 0.25 : null,
    policySchemaVersion: DEFAULT_EXECUTION_POLICY.version,
    policyControlRevision: 7,
    initialBook: {
      depthStatus: "full",
      bestBid: 0.34,
      bestAsk: 0.36,
      tickSize: 0.01,
      snapshotTs: NOW,
      source: "clob",
    },
  };
}

function book(): OrderBookSnapshot {
  return {
    tokenId,
    bids: [{ price: 0.34, size: 20 }],
    asks: [
      { price: 0.36, size: 10 },
      { price: 0.4, size: 10 },
    ],
    minOrderSize: 1,
    timestamp: NOW,
  } as OrderBookSnapshot;
}

function buyRoot(id: string, cohort = COHORT): Order {
  const rootOrderId = createOrderId(id);
  return order(id, {
    orderId: rootOrderId,
    side: "buy",
    signalReason: "probe-entry",
    decisionRuleId: R23_DIP_TRIGGER_RULE_ID,
    metadata: {
      quoteMotionV1: quoteMotion("r23_capture", cohort),
      makerCaptureLineageV1: {
        version: 1,
        rootOrderId,
        predecessorOrderId: null,
        replacementIndex: 0,
        rootNotionalUsdc: 2,
      },
    },
  });
}

function position(size = 10): Position {
  return {
    positionId,
    tokenId,
    conditionId,
    size,
    status: "open",
  } as Position;
}

function fillFor(root: Order, id: string, size = 5): Fill {
  return {
    fillId: createFillId(id),
    orderId: root.orderId,
    tokenId,
    side: "buy",
    size,
  } as Fill;
}

function lotFor(fill: Fill, id: string, size = 5): InventoryLot {
  return {
    lotId: createLotId(id),
    positionId,
    tokenId,
    remainingSize: size,
    fillId: fill.fillId,
  } as InventoryLot;
}

function chainUsage(id: Order["orderId"]) {
  return { trusted: true, rootOrderId: id } as any;
}

describe("bounce ASK capture", () => {
  it("subtracts our confirmed SELL and enforces target and downward bounds", () => {
    const input = {
      book: book(),
      tickSize: 0.01,
      ownSellOrders: [order("own-sell", { price: 0.36 })],
      fillsByOrder: new Map<string, readonly Fill[]>(),
      predecessorPrice: 0.4,
      originalTargetPrice: 0.3,
    };

    expect(computeBounceAskCaptureCandidate(input)).toMatchObject({ ok: true, price: 0.39 });
    expect(computeBounceAskCaptureInitialPrice(input)).toMatchObject({ ok: true, price: 0.39 });
    expect(computeBounceAskCaptureInitialPrice({ ...input, originalTargetPrice: 0.4 })).toEqual({
      ok: false,
      reason: "no-valid-move",
    });
    expect(computeBounceAskCaptureCandidate({ ...input, originalTargetPrice: 0.4 })).toEqual({
      ok: false,
      reason: "no-valid-move",
    });
    expect(computeBounceAskCaptureCandidate({ ...input, predecessorPrice: 0.39 })).toEqual({
      ok: false,
      reason: "no-valid-move",
    });
  });

  it("proves every remaining FIFO lot and fails closed on a mixed cohort", () => {
    const roots = [buyRoot("buy-a"), buyRoot("buy-b")];
    const fills = roots.map((root, index) => fillFor(root, `fill-${index}`));
    const lots = fills.map((fill, index) => lotFor(fill, `lot-${index}`));
    const sell = order("sell-root");
    const byId = new Map(roots.map((root) => [String(root.orderId), root]));
    const deps = {
      orderRepo: {
        findById: (id: Order["orderId"]) => byId.get(String(id)) ?? null,
        getMakerCaptureChainUsage: chainUsage,
      },
      fillRepo: { findByTokenId: () => fills },
      positionRepo: { findById: () => position() },
      inventoryLotRepo: { findOpen: () => lots },
    };

    expect(resolveProvenBounceAskOrigin(sell, COHORT, deps)?.sourceBuyRootOrderIds).toEqual(
      roots.map((root) => root.orderId),
    );
    byId.set(String(roots[1]!.orderId), buyRoot("buy-b", "2026-08-02T00:00:00.000Z"));
    expect(resolveProvenBounceAskOrigin(sell, COHORT, deps)).toBeNull();
  });

  it("claims durably before cancel, prevents a sibling, and terminalizes dust", async () => {
    const bus = new InProcessEventBus();
    const buy = buyRoot("buy-root");
    const fill = fillFor(buy, "buy-fill", 10);
    const lot = lotFor(fill, "buy-lot", 10);
    const currentPosition = position();
    let sell = order("sell-root", {
      metadata: { bounceRung: { rungIndex: 0 }, quoteMotionV1: quoteMotion("bounce_exit_target") },
    });
    let intent: any = null;
    let policyEnabled = true;
    const effects: string[] = [];
    const terminal = vi.fn();
    const repo: any = {
      findOpen: () => [sell],
      findById: (id: Order["orderId"]) =>
        String(id) === String(buy.orderId)
          ? buy
          : String(id) === String(sell.orderId)
            ? sell
            : null,
      getMakerCaptureChainUsage: chainUsage,
      updateMetadataIfUnchanged: (_id: unknown, _before: unknown, metadata: Order["metadata"]) =>
        (sell = { ...sell, metadata: metadata ?? null }),
      isOrderManagedByNonterminalBounceAskCaptureIntent: () => intent !== null,
      claimBounceAskCaptureIntent: (claimed: unknown) => {
        effects.push("claim");
        intent = claimed;
        return true;
      },
      findRecoverableBounceAskCaptureIntents: () => [],
      findBounceAskCaptureIntentByPredecessor: () => intent,
      markBounceAskCaptureTerminal: terminal,
    };
    const module = new BounceAskCaptureLifecycleModule({
      bus,
      orderRepo: repo,
      fillRepo: { findByOrderId: () => [], findByOrderIds: () => [], findByTokenId: () => [fill] },
      positionRepo: { findById: () => currentPosition },
      inventoryLotRepo: { findOpen: () => [lot] },
      policySnapshot: () => ({
        policy: {
          ...DEFAULT_EXECUTION_POLICY,
          bounceAskCapture: {
            enabled: policyEnabled,
            sourceCohortActivatedAtUtc: COHORT,
            maxRepricesPerRoot: 1,
          },
        },
        controlRevision: 7,
      }),
      candidateBookCache: {
        prime: async () =>
          new Map([
            [
              String(tokenId),
              {
                tokenId: String(tokenId),
                sourceKind: "rest",
                bookSource: "clob",
                cachedAtMs: NOW,
                sourcePolledAtMs: NOW,
                snapshotTs: NOW,
                book: book(),
              },
            ],
          ]),
      },
      log: { child: () => ({ info: vi.fn(), error: vi.fn() }) } as any,
      now: () => NOW,
    });
    bus.subscribe("CancelOrderRequested", async () => {
      effects.push(intent ? "cancel-after-claim" : "cancel-before-claim");
    });
    await module.start();
    const market = {
      tokenId,
      conditionId,
      active: true,
      tradable: true,
      acceptingOrders: true,
      enableOrderBook: true,
      tickSize: 0.01,
      snapshotTs: NOW,
    } as unknown as NormalizedMarket;
    await bus.publish("NormalizedMarketUpdated", { markets: [market], timestamp: NOW });
    await bus.publish("NormalizedMarketUpdated", { markets: [market], timestamp: NOW });
    expect(effects).toEqual(["claim", "cancel-after-claim"]);
    policyEnabled = false;
    await (module as any).advance(intent);
    expect(terminal).toHaveBeenCalledWith(intent.intentId, "failed", "policy-cohort-lineage-drift");
    expect(effects).toEqual(["claim", "cancel-after-claim"]);
    policyEnabled = true;

    sell = { ...sell, status: "cancelled" };
    currentPosition.size = lot.remainingSize = 0.5;
    await bus.publish("OrderCancelled", {
      commandId: "ask-cancel" as any,
      orderId: sell.orderId,
      tokenId,
      conditionId,
      reason: "bounce_ask_capture_reprice",
      signalReason: sell.signalReason,
      timestamp: NOW,
    });
    expect(terminal).toHaveBeenCalledWith(intent.intentId, "dust", "replacement-below-minimum");
    await module.stop();
  });
});

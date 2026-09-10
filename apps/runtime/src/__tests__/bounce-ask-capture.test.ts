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
  TokenMinimumAuthority,
  type Fill,
  type InventoryLot,
  type NormalizedMarket,
  type Order,
  type OrderBookSnapshot,
  type Position,
} from "@krabs/domain";
import { LiveExchangeGateway, LiveMarketDataGateway } from "@krabs/exchange";
import {
  OrderBuilder,
  type UserOrderV2,
  type CreateOrderOptions,
} from "@polymarket/clob-client-v2";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  computeBounceAskCaptureCandidate,
  computeBounceAskCaptureInitialPrice,
  resolveBounceAskPolicyOrigin,
  resolveProvenBounceAskOrigin,
} from "../bounce-ask-capture.js";
import { BounceAskCaptureLifecycleModule } from "../modules/bounce-ask-capture/bounce-ask-capture-lifecycle-module.js";

const NOW = Date.parse("2026-08-23T00:00:00.000Z");
const COHORT = "2026-08-01T00:00:00.000Z";
const tokenId = createTokenId("123456789");
const conditionId = createConditionId("ask-condition");
const positionId = createPositionId("ask-position");

function prospectiveGateway() {
  const builder = new OrderBuilder(
    {
      getAddress: async () => "0x1111111111111111111111111111111111111111",
      _signTypedData: async () => `0x${"11".repeat(65)}`,
    },
    137,
  );
  const client = {
    chainId: 137,
    createOrder: vi.fn((order: UserOrderV2, options: CreateOrderOptions) =>
      builder.buildOrder(order, options, 2),
    ),
    postOrder: vi.fn(),
    getOrderBook: vi.fn().mockResolvedValue({ min_order_size: "1" }),
  };
  const gateway = new LiveExchangeGateway({ client });
  const marketData = new LiveMarketDataGateway({ client });
  const source = new TokenMinimumAuthority(
    async (id) => {
      await marketData.getOrderBook(createTokenId(id));
      return true;
    },
    () => {},
  );
  marketData.setTokenMinimumAuthority(source);
  gateway.setTokenMinimumSource(source);
  return gateway;
}

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

function quoteMotion(
  kind: "r23_capture" | "bounce_exit_target",
  cohort = COHORT,
  permanentR23ActivationId: string | null = null,
) {
  return {
    version: 1,
    kind,
    cohortId: cohort,
    originalSuggestedPrice: kind === "r23_capture" ? 0.2 : 0.4,
    originalTargetPrice: kind === "bounce_exit_target" ? 0.3 : null,
    entryPriceCeiling: kind === "r23_capture" ? 0.25 : null,
    policySchemaVersion: DEFAULT_EXECUTION_POLICY.version,
    policyControlRevision: 7,
    permanentR23ActivationId,
    permanentR23ActivatedAtUtc: permanentR23ActivationId ? cohort : null,
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

function buyRoot(
  id: string,
  cohort = COHORT,
  permanentR23ActivationId: string | null = null,
): Order {
  const rootOrderId = createOrderId(id);
  return order(id, {
    orderId: rootOrderId,
    side: "buy",
    signalReason: "probe-entry",
    decisionRuleId: R23_DIP_TRIGGER_RULE_ID,
    metadata: {
      quoteMotionV1: quoteMotion("r23_capture", cohort, permanentR23ActivationId),
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

function captureModule(
  overrides: Partial<ConstructorParameters<typeof BounceAskCaptureLifecycleModule>[0]> = {},
) {
  return new BounceAskCaptureLifecycleModule({
    bus: new InProcessEventBus(),
    orderRepo: {} as any,
    fillRepo: {} as any,
    positionRepo: {} as any,
    inventoryLotRepo: {} as any,
    policySnapshot: () => ({
      policy: {
        ...DEFAULT_EXECUTION_POLICY,
        bounceAskCapture: { ...DEFAULT_EXECUTION_POLICY.bounceAskCapture, enabled: true },
      },
      controlRevision: 7,
    }),
    log: { child: () => ({ info: vi.fn(), error: vi.fn() }) } as any,
    now: () => NOW,
    ...overrides,
  });
}

describe("bounce ASK capture", () => {
  it.each(["current", "stale", "invalidated"])(
    "checks %s work after awaiting token recovery",
    async (state) => {
      let now = NOW;
      const findOpen = vi.fn(() => [order("target")]);
      const module = captureModule({
        orderRepo: { findOpen } as any,
        now: () => now,
      });
      await module.start();
      let release!: () => void;
      const recovery = vi
        .spyOn(module as any, "recover")
        .mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
      const claim = vi.spyOn(module as any, "tryClaim").mockResolvedValue(undefined);
      findOpen.mockClear();
      const work = (module as any).captureMarket({ markets: [{ tokenId }], timestamp: NOW });
      expect(recovery).toHaveBeenCalledWith(new Set([String(tokenId)]));
      expect(findOpen).not.toHaveBeenCalled();
      if (state === "stale") now += 3_001;
      if (state === "invalidated") (module as any).captureWork.invalidate();
      release();
      await work;
      expect(findOpen).toHaveBeenCalledWith(tokenId);
      expect(claim).toHaveBeenCalledTimes(state === "current" ? 1 : 0);
      recovery.mockRestore();
      await module.stop();
    },
  );

  it("splits market batches into scoped open reads and skips empty batches", async () => {
    const bus = new InProcessEventBus();
    const findOpen = vi.fn(() => []);
    const module = captureModule({ bus, orderRepo: { findOpen } as any });
    await module.start();
    findOpen.mockClear();
    await bus.publish("NormalizedMarketUpdated", { markets: [], timestamp: NOW });
    expect(findOpen).not.toHaveBeenCalled();
    const other = createTokenId("other-ask-market");
    await bus.publish("NormalizedMarketUpdated", {
      markets: [tokenId, other].map((id) => ({ tokenId: id, active: true }) as NormalizedMarket),
      timestamp: NOW,
    });
    await vi.waitFor(() => expect(findOpen).toHaveBeenCalledTimes(2));
    expect(findOpen.mock.calls).toEqual([[tokenId], [other]]);
    await module.stop();
  });

  it("bounds its market cache across tracked removal and restart", async () => {
    const bus = new InProcessEventBus();
    const module = new BounceAskCaptureLifecycleModule({
      bus,
      orderRepo: { findOpen: () => [] } as any,
      fillRepo: {} as any,
      positionRepo: {} as any,
      inventoryLotRepo: {} as any,
      policySnapshot: () => ({
        policy: {
          ...DEFAULT_EXECUTION_POLICY,
          bounceAskCapture: { ...DEFAULT_EXECUTION_POLICY.bounceAskCapture, enabled: false },
        },
        controlRevision: 7,
      }),
      log: { child: () => ({ info: vi.fn(), error: vi.fn() }) } as any,
      now: () => NOW,
    });
    const retainedTokenId = createTokenId("ask-retained-token");
    const cache = (module as any).markets as Map<string, NormalizedMarket>;
    const normalizedMarket = (id: typeof tokenId) =>
      ({ tokenId: id, active: true, snapshotTs: NOW }) as NormalizedMarket;
    await module.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [normalizedMarket(tokenId), normalizedMarket(retainedTokenId)],
      timestamp: NOW,
    });
    await bus.publish("TrackedMarketsChanged", {
      addedTokenIds: [],
      removedTokenIds: [tokenId],
      activeTokenIds: [retainedTokenId],
      timestamp: NOW,
    });

    expect.soft([...cache.keys()]).toEqual([String(retainedTokenId)]);
    await module.stop();
    expect.soft(cache.size).toBe(0);
    await module.start();
    expect.soft(cache.size).toBe(0);

    const refreshed = normalizedMarket(tokenId);
    await bus.publish("NormalizedMarketUpdated", { markets: [refreshed], timestamp: NOW });
    expect(cache.get(String(tokenId))).toBe(refreshed);
    await module.stop();
  });

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

  it("proves permanent ASK ownership only when every FIFO lot has the same permanent activation", () => {
    const activationId = "permanent-r23-activation-1";
    const source = {
      sourceCohortActivatedAtUtc: COHORT,
      permanentR23ActivationId: activationId,
      permanentR23ActivatedAtUtc: COHORT,
    };
    const roots = [
      buyRoot("permanent-a", COHORT, activationId),
      buyRoot("permanent-b", COHORT, activationId),
    ];
    const fills = roots.map((root, index) => fillFor(root, `permanent-fill-${index}`));
    const lots = fills.map((fill, index) => lotFor(fill, `permanent-lot-${index}`));
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

    expect(
      resolveProvenBounceAskOrigin(order("permanent-sell"), source, deps)?.sourceBuyRootOrderIds,
    ).toEqual(roots.map((root) => root.orderId));
    expect(
      resolveBounceAskPolicyOrigin(
        positionId,
        tokenId,
        {
          enabled: true,
          ...source,
          sourceCohortActivatedAtUtc: "",
          maxRepricesPerRoot: 5,
        },
        deps,
      )?.sourceCohortActivatedAtUtc,
    ).toBe(COHORT);

    byId.set(String(roots[1]!.orderId), buyRoot("permanent-b", COHORT, null));
    expect(resolveProvenBounceAskOrigin(order("permanent-sell"), source, deps)).toBeNull();
    byId.set(String(roots[0]!.orderId), buyRoot("permanent-a", COHORT, null));
    expect(
      resolveBounceAskPolicyOrigin(
        positionId,
        tokenId,
        {
          enabled: true,
          ...source,
          sourceCohortActivatedAtUtc: COHORT,
          maxRepricesPerRoot: 5,
        },
        deps,
      )?.permanentR23ActivationId,
    ).toBeNull();
  });

  it.each([
    ["v120", null],
    ["permanent recovery after disabled cancel", "permanent-r23-activation-1"],
  ])("claims durably before cancel and preserves %s coverage", async (_, activationId) => {
    const bus = new InProcessEventBus();
    const buy = buyRoot("buy-root", COHORT, activationId);
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
      findOpen: vi.fn((scope?: Order["tokenId"]) =>
        [order("foreign", { tokenId: createTokenId("foreign") }), sell].filter(
          (candidate) => scope === undefined || candidate.tokenId === scope,
        ),
      ),
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
      findBounceAskCaptureIntentBySignal: () => intent,
      markBounceAskCaptureReady: (_id: unknown, price: number, size: number, prepared: unknown) => {
        intent = {
          ...intent,
          status: "ready",
          candidatePrice: price,
          replacementSize: size,
          proof: { ...intent.proof, prepared },
        };
        return true;
      },
      markBounceAskCaptureTerminal: terminal,
    };
    const module = new BounceAskCaptureLifecycleModule({
      bus,
      orderRepo: repo,
      gateway: prospectiveGateway(),
      fillRepo: { findByOrderId: () => [], findByOrderIds: () => [], findByTokenId: () => [fill] },
      positionRepo: { findById: () => currentPosition },
      inventoryLotRepo: { findOpen: () => [lot] },
      policySnapshot: () => ({
        policy: {
          ...DEFAULT_EXECUTION_POLICY,
          bounceAskCapture: {
            ...DEFAULT_EXECUTION_POLICY.bounceAskCapture,
            enabled: policyEnabled,
            sourceCohortActivatedAtUtc: activationId ? "" : COHORT,
            permanentR23ActivationId: activationId,
            permanentR23ActivatedAtUtc: activationId ? COHORT : null,
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
    bus.subscribe("SignalProduced", async () => {
      effects.push("replacement-signal");
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
    repo.findOpen.mockClear();
    await bus.publish("NormalizedMarketUpdated", { markets: [market], timestamp: NOW });
    await bus.publish("NormalizedMarketUpdated", { markets: [market], timestamp: NOW });
    await vi.waitFor(() => expect(effects).toEqual(["claim", "cancel-after-claim"]));
    expect(repo.findOpen).toHaveBeenCalledWith(tokenId);
    expect(intent.predecessorOrderId).toBe(sell.orderId);
    policyEnabled = false;
    if (activationId) {
      sell = { ...sell, status: "cancelled" };
      await bus.publish("OrderCancelled", {
        commandId: "ask-cancel" as any,
        orderId: sell.orderId,
        tokenId,
        conditionId,
        reason: "bounce_ask_capture_reprice",
        signalReason: sell.signalReason,
        timestamp: NOW,
      });
      await vi.waitFor(() =>
        expect(effects).toEqual(["claim", "cancel-after-claim", "replacement-signal"]),
      );
      expect(terminal).not.toHaveBeenCalled();
      await module.stop();
      return;
    }
    await (module as any).advance(intent);
    expect(terminal).toHaveBeenCalledWith(intent.intentId, "failed", "policy-cohort-lineage-drift");
    expect(effects).toEqual(["claim", "cancel-after-claim"]);
    policyEnabled = true;
    terminal.mockClear();

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
    expect(terminal).not.toHaveBeenCalled();
    expect(effects).toEqual(["claim", "cancel-after-claim"]);
    await module.stop();
  });
});

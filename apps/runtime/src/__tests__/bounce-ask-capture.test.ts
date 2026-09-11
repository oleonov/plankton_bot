import { describe, expect, it, vi } from "vitest";
import {
  createCommandId,
  BOUNCE_EXIT_TARGET_RULE_ID,
  DEFAULT_EXECUTION_POLICY,
  R23_DIP_TRIGGER_RULE_ID,
  createConditionId,
  createFillId,
  createLotId,
  createOrderId,
  createPositionId,
  createTokenId,
  minimumRetryIdentity,
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

async function recoveryFixture(recoveryClass: "data" | "minimum" | null = "data") {
  const bus = new InProcessEventBus();
  const buy = buyRoot("recovery-buy");
  const fill = fillFor(buy, "recovery-fill", 10);
  const lot = lotFor(fill, "recovery-lot", 10);
  const pos = position();
  const lineage = {
    version: 1,
    rootOrderId: createOrderId("recovery-sell"),
    predecessorOrderId: null,
    replacementIndex: 0,
    positionId,
    sourceCohortActivatedAtUtc: COHORT,
    originalTargetPrice: 0.3,
    sourceBuyRootOrderIds: [buy.orderId],
  };
  const f = {
    now: NOW,
    paused: false,
    revision: 7 as number | null,
    minimum: 1 as number | null,
    sell: order("recovery-sell", {
      status: "open",
      createdAt: new Date(NOW - 10_000).toISOString(),
      cancelAgeMs: 10_000,
      metadata: {
        bounceAskCaptureLineageV1: lineage,
      },
    }),
    intent: null as any,
    child: null as Order | null,
    fills: [] as Fill[],
    pos,
    lot,
    buy,
    market: {
      tokenId,
      conditionId,
      active: true,
      tradable: true,
      acceptingOrders: true,
      enableOrderBook: true,
      tickSize: 0.01,
      snapshotTs: NOW,
    } as unknown as NormalizedMarket,
  };
  const repo: any = {
    findById: (id: Order["orderId"]) =>
      [f.sell, buy, f.child].find((order) => order?.orderId === id) ?? null,
    findByClientOrderId: () => f.child,
    findOpen: () => [],
    getMakerCaptureChainUsage: chainUsage,
    findRecoverableBounceAskCaptureIntents: () =>
      ["cancel_pending", "ready", "submitted"].includes(f.intent?.status) ? [f.intent] : [],
    claimBounceAskCaptureIntent: (intent: unknown) => {
      f.intent = intent;
      return true;
    },
    findBounceAskCaptureIntentBySignal: () => f.intent,
    findBounceAskCaptureIntentByPredecessor: () => f.intent,
    updateMetadataIfUnchanged: vi.fn((_id, before, metadata) => {
      if (before !== f.sell.metadata) return null;
      return (f.sell = { ...f.sell, metadata });
    }),
    markBounceAskCaptureReady: vi.fn((_id, price, size, prepared) => {
      f.intent = {
        ...f.intent,
        status: "ready",
        candidatePrice: price,
        replacementSize: size,
        proof: { ...f.intent.proof, prepared },
      };
      return true;
    }),
    markBounceAskCaptureTerminal: vi.fn((_id, status, failure) => {
      f.intent = { ...f.intent, status, failure };
      return true;
    }),
    resetBounceAskCaptureSubmitted: vi.fn((_id, childId) => {
      if (f.intent.status !== "submitted" || f.intent.childOrderId !== childId) return false;
      f.intent = {
        ...f.intent,
        status: "ready",
        childOrderId: null,
        proof: { ...f.intent.proof, submit: null },
      };
      return true;
    }),
  };
  const prime = vi.fn(
    async () =>
      new Map([
        [
          String(tokenId),
          {
            tokenId: String(tokenId),
            sourceKind: "rest" as const,
            bookSource: "clob" as const,
            snapshotTs: f.now,
            cachedAtMs: f.now,
            sourcePolledAtMs: f.now,
            book: { ...book(), timestamp: f.now, minOrderSize: f.minimum },
          },
        ],
      ]),
  );
  const module = captureModule({
    bus,
    orderRepo: repo,
    runtimeControl: { isPaused: () => f.paused },
    now: () => f.now,
    fillRepo: {
      findByOrderId: () => f.fills,
      findByOrderIds: () => [],
      findByTokenId: () => [fill],
    },
    positionRepo: { findById: () => pos },
    inventoryLotRepo: { findOpen: () => [lot] },
    candidateBookCache: { prime },
    policySnapshot: () => ({
      policy: {
        ...DEFAULT_EXECUTION_POLICY,
        bounceAskCapture: {
          ...DEFAULT_EXECUTION_POLICY.bounceAskCapture,
          enabled: true,
          sourceCohortActivatedAtUtc: COHORT,
        },
      },
      controlRevision: f.revision,
    }),
  });
  const signals = vi.fn();
  bus.subscribe("SignalProduced", signals);
  await module.start();
  (module as any).markets.set(String(tokenId), f.market);
  await (module as any).tryClaim(f.sell, NOW, (module as any).deps.policySnapshot());
  f.sell = {
    ...f.sell,
    status: "cancelled",
    metadata: {
      ...f.sell.metadata,
      bounceAskCaptureRecoveryV1: recoveryClass
        ? { ...(f.sell.metadata?.bounceAskCaptureRecoveryV1 as object), recoveryClass }
        : undefined,
    },
  };
  (module as any).markets.clear();
  prime.mockClear();
  await (module as any).advance(f.intent);
  const advance = async () => {
    (module as any).markets.set(String(tokenId), f.market);
    await (module as any).advance(f.intent);
  };
  return { f, module, repo, prime, signals, advance, bus };
}

describe("bounce ASK capture", () => {
  it.each(["diagnostic", "read", "terminal-throw", "terminal-false", "persistent"])(
    "guards expiry storage failure: %s",
    async (failure) => {
      vi.useFakeTimers();
      const { f, module, repo, signals } = await recoveryFixture();
      try {
        const busy = () => {
          throw new Error("SQLITE_BUSY");
        };
        const terminal = repo.markBounceAskCaptureTerminal.getMockImplementation();
        if (failure === "diagnostic")
          repo.updateMetadataIfUnchanged.mockClear().mockImplementation(busy);
        if (failure === "read")
          vi.spyOn(repo, "findBounceAskCaptureIntentBySignal").mockImplementationOnce(busy);
        if (failure === "terminal-throw")
          repo.markBounceAskCaptureTerminal.mockImplementationOnce(busy);
        if (failure === "terminal-false")
          repo.markBounceAskCaptureTerminal.mockReturnValueOnce(false);
        if (failure === "persistent") repo.markBounceAskCaptureTerminal.mockImplementation(busy);
        f.paused = true;
        f.now += 3_000;
        await expect(vi.advanceTimersByTimeAsync(3_000)).resolves.toBe(vi);
        expect(f.intent.status).toBe(failure === "diagnostic" ? "failed" : "cancel_pending");
        if (failure === "diagnostic")
          expect(repo.markBounceAskCaptureTerminal.mock.invocationCallOrder[0]).toBeLessThan(
            repo.updateMetadataIfUnchanged.mock.invocationCallOrder[0],
          );
        f.now += 2_000;
        await expect(vi.advanceTimersByTimeAsync(2_000)).resolves.toBe(vi);
        if (failure === "persistent") {
          expect(f.intent.status).toBe("cancel_pending");
          expect(repo.markBounceAskCaptureTerminal).toHaveBeenCalledTimes(2);
          expect(vi.getTimerCount()).toBe(0);
          await module.stop();
          repo.markBounceAskCaptureTerminal.mockImplementation(terminal);
          await module.start();
        }
        expect(f.intent.failure).toBe("post-cancel-data-expired");
        expect(signals).not.toHaveBeenCalled();
      } finally {
        await module.stop();
        vi.useRealTimers();
      }
    },
  );

  it.each(["submitted", "ready", "classification-conflict"])(
    "preserves never-posted minimum recovery after expiry and restart: %s",
    async (mode) => {
      vi.useFakeTimers();
      const { f, module, repo, advance, signals } = await recoveryFixture();
      try {
        await advance();
        signals.mockClear();
        f.child = order("minimum-child", {
          status: "rejected",
          exchangeErrorCode: "INVALID_SIZE",
          exchangeErrorMessage: "token-minimum-unavailable",
        });
        const identity = minimumRetryIdentity(f.child);
        f.child.metadata = {
          minimumOriginalIntentV1: identity,
          neverPostedMinimumV1: {
            version: 1,
            orderId: f.child.orderId,
            identity,
            originalIdentity: identity,
          },
        };
        if (mode === "submitted") {
          f.intent.status = "submitted";
          f.intent.childOrderId = f.child.orderId;
        }
        if (mode === "classification-conflict")
          repo.updateMetadataIfUnchanged.mockReturnValueOnce(null);
        f.paused = true;
        f.now += 3_001;
        await vi.advanceTimersByTimeAsync(3_001);
        expect(f.intent.status).toBe(mode === "submitted" ? "submitted" : "ready");
        await module.stop();
        await module.start();
        expect(f.sell.metadata?.bounceAskCaptureRecoveryV1).toMatchObject({
          recoveryClass: "minimum",
        });
        expect(signals).not.toHaveBeenCalled();
        f.paused = false;
        f.market.snapshotTs = f.now;
        await advance();
        expect(f.intent.status).toBe("ready");
        expect(signals).toHaveBeenCalledOnce();
        expect(repo.resetBounceAskCaptureSubmitted).toHaveBeenCalledTimes(
          mode === "submitted" ? 1 : 0,
        );
      } finally {
        await module.stop();
        vi.useRealTimers();
      }
    },
  );

  it("fails a new claim before cancellation if its discriminator CAS conflicts", async () => {
    const { f, module, repo, bus } = await recoveryFixture();
    f.sell = { ...f.sell, status: "open" };
    const cancelled = vi.fn();
    bus.subscribe("CancelOrderRequested", async () => {
      cancelled();
    });
    repo.updateMetadataIfUnchanged.mockReturnValue(null);
    (module as any).markets.set(String(tokenId), f.market);
    await (module as any).tryClaim(f.sell, NOW, (module as any).deps.policySnapshot());
    expect(f.intent.failure).toBe("diagnostic-write-conflict");
    expect(f.sell.status).toBe("open");
    expect(cancelled).not.toHaveBeenCalled();
    await module.stop();
  });

  it.each([
    ["throw", "none"],
    ["read-back", "none"],
    ["throw", "throw"],
    ["throw", "false"],
    ["read-back", "throw"],
    ["false", "throw"],
    ["false", "false"],
  ])("retains failed initial marker %s with terminal failure %s", async (marker, terminal) => {
    const { f, module, repo, bus, signals } = await recoveryFixture();
    await module.stop();
    f.intent = null;
    f.sell = {
      ...f.sell,
      status: "open",
      metadata: { bounceAskCaptureLineageV1: f.sell.metadata?.bounceAskCaptureLineageV1 },
    };
    repo.findOpen = () => (f.intent ? [] : [f.sell]);
    (module as any).deps.gateway = prospectiveGateway();
    const logged = vi.spyOn((module as any).log, "error");
    const cancelled = vi.fn();
    bus.subscribe("CancelOrderRequested", cancelled);
    const initialError = new Error("SQLITE_BUSY: initial marker");
    const writeMarker = repo.updateMetadataIfUnchanged.getMockImplementation()!;
    repo.updateMetadataIfUnchanged.mockImplementationOnce((...args: unknown[]) => {
      if (marker === "false") return null;
      if (marker === "read-back") writeMarker(...args);
      throw initialError;
    });
    const writeTerminal = repo.markBounceAskCaptureTerminal.getMockImplementation()!;
    if (terminal === "throw")
      repo.markBounceAskCaptureTerminal.mockImplementation(() => {
        throw new Error("SQLITE_BUSY: terminal");
      });
    if (terminal === "false") repo.markBounceAskCaptureTerminal.mockReturnValue(false);
    const event = async () => {
      await bus.publish("NormalizedMarketUpdated", { markets: [f.market], timestamp: f.now });
      await (module as any).captureWork.drain();
    };
    try {
      await module.start();
      await event();
      await event();
      expect(cancelled).not.toHaveBeenCalled();
      if (marker !== "false")
        expect(logged).toHaveBeenCalledWith(
          expect.objectContaining({ err: initialError }),
          "bounce ASK capture handler failed; durable state retained",
        );
      if (terminal !== "none") {
        expect(f.intent.status).toBe("cancel_pending");
        await module.stop();
        await module.start();
        await event();
        expect(cancelled).not.toHaveBeenCalled();
        repo.markBounceAskCaptureTerminal.mockImplementation(writeTerminal);
        await event();
      }
      expect(f.intent).toMatchObject({ status: "failed", failure: "diagnostic-write-conflict" });
      expect(f.sell.status).toBe("open");
      expect(cancelled).not.toHaveBeenCalled();
      expect(signals).not.toHaveBeenCalled();
    } finally {
      await module.stop();
    }
  });

  it("defers a stale cancelled ASK and prepares the current residual on fresh recovery", async () => {
    const { f, module, advance, signals, repo } = await recoveryFixture();
    f.market.snapshotTs = NOW - 3_001;
    await advance();
    expect(f.intent.status).toBe("cancel_pending");
    repo.updateMetadataIfUnchanged.mockClear();
    await advance();
    expect(repo.updateMetadataIfUnchanged).not.toHaveBeenCalled();
    expect(f.sell.metadata?.bounceAskCaptureRecoveryV1).toMatchObject({
      recoveryClass: "data",
      phase: "deferred",
      reason: "normalized-data-stale",
      deadlineMs: NOW + 3_000,
    });
    f.fills = [{ size: 2 } as Fill];
    f.pos.size = f.lot.remainingSize = 8;
    f.market.snapshotTs = NOW;
    await advance();
    expect(f.intent.replacementSize).toBe(8);
    expect(repo.markBounceAskCaptureReady).toHaveBeenCalledOnce();
    expect(signals.mock.calls[0]?.[0].signal.suggestedSize).toBe(8);
    await module.stop();
  });

  it("expires missing data while paused without a future event or a book fetch", async () => {
    vi.useFakeTimers();
    try {
      const { f, module, prime } = await recoveryFixture();
      f.paused = true;
      f.now += 3_000;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(f.intent.failure).toBe("post-cancel-data-expired");
      expect(prime).not.toHaveBeenCalled();
      await module.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([1_000, 3_000])(
    "leaves late cancellation recovery stopped and restores the fixed deadline after %sms",
    async (elapsed) => {
      vi.useFakeTimers();
      const { f, module, repo, prime, signals, bus } = await recoveryFixture();
      try {
        await module.stop();
        repo.updateMetadataIfUnchanged.mockClear();
        f.now += elapsed;
        await bus.publish("OrderCancelled", {
          commandId: createCommandId("late-cancel"),
          orderId: f.sell.orderId,
          tokenId,
          conditionId,
          reason: "bounce_ask_capture_reprice",
          signalReason: f.sell.signalReason,
          timestamp: f.now,
        });
        expect(f.intent.status).toBe("cancel_pending");
        expect(repo.markBounceAskCaptureTerminal).not.toHaveBeenCalled();
        expect(repo.updateMetadataIfUnchanged).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        f.paused = true;
        await module.start();
        expect(f.intent.status).toBe(elapsed === 3_000 ? "failed" : "cancel_pending");
        f.now = NOW + 3_000;
        await vi.advanceTimersByTimeAsync(3_000 - elapsed);
        expect(f.intent.failure).toBe("post-cancel-data-expired");
        expect(f.sell.metadata?.bounceAskCaptureRecoveryV1).toMatchObject({
          cancellationAnchorMs: NOW,
          deadlineMs: NOW + 3_000,
        });
        expect(prime).not.toHaveBeenCalled();
        expect(signals).not.toHaveBeenCalled();
      } finally {
        await module.stop();
        vi.useRealTimers();
      }
    },
  );

  it.each(["data", "minimum", null] as const)(
    "preserves %s history across paused missing-market restart",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const { f, module, prime } = await recoveryFixture(kind);
        await module.stop();
        f.paused = true;
        f.now += 1_000;
        await module.start();
        f.now += 2_000;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(f.intent.status).toBe(kind === "data" ? "failed" : "cancel_pending");
        await module.stop();
        await module.start();
        expect(f.intent.status).toBe(kind === "data" ? "failed" : "cancel_pending");
        expect(prime).not.toHaveBeenCalled();
        await module.stop();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["data", "minimum", null] as const)(
    "classifies stale %s history explicitly",
    async (kind) => {
      const { f, module, advance } = await recoveryFixture(kind);
      f.market.snapshotTs = NOW - 3_001;
      await advance();
      expect(f.intent.status).toBe(kind === "data" ? "cancel_pending" : "failed");
      expect(f.sell.metadata?.bounceAskCaptureRecoveryV1).toMatchObject({
        reason: "normalized-data-stale",
      });
      await module.stop();
    },
  );

  it.each(["persisted", "conflict", "unknown"])(
    "retires the data timer only after minimum classification is %s",
    async (mode) => {
      vi.useFakeTimers();
      try {
        const { f, module, advance, repo, signals } = await recoveryFixture();
        f.pos.size = f.lot.remainingSize = 0.5;
        if (mode === "unknown") f.minimum = null;
        if (mode === "conflict") repo.updateMetadataIfUnchanged.mockReturnValue(null);
        await advance();
        expect(f.sell.metadata?.bounceAskCaptureRecoveryV1).toMatchObject({
          recoveryClass: mode === "conflict" ? "data" : "minimum",
        });
        await module.stop();
        f.paused = true;
        f.now += 3_001;
        await module.start();
        expect(f.intent.status).toBe(mode === "conflict" ? "failed" : "cancel_pending");
        expect(signals).not.toHaveBeenCalled();
        await module.stop();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["invalid-anchor", "unlinked-pending", "submitted-missing"])(
    "checks durable expiry ownership: %s",
    async (mode) => {
      const { f, module, advance } = await recoveryFixture();
      if (mode === "invalid-anchor") f.sell = { ...f.sell, cancelAgeMs: null };
      if (mode === "unlinked-pending") f.child = order("child", { status: "pending" });
      if (mode === "submitted-missing") f.intent.status = "submitted";
      f.now += 3_001;
      await advance();
      expect(f.intent.failure).toBe(
        mode === "invalid-anchor" ? "invalid-cancellation-anchor" : null,
      );
      await module.stop();
    },
  );

  it.each([
    ["stale", "normalized-data-stale"],
    ["timestamp", "normalized-timestamp-invalid"],
    ["position", "invalid-position"],
    ["lots", "invalid-lots"],
    ["buy", "invalid-buy-root"],
    ["cohort", "invalid-cohort"],
    ["roots", "invalid-root-set"],
    ["market", "market-prohibited"],
    ["revision", "null-control-revision"],
    ["residual", null],
    ["pause", null],
    ["stop", null],
  ] as const)("reloads %s after book await", async (mode, reason) => {
    const { f, module, advance, prime, signals } = await recoveryFixture();
    const read = prime.getMockImplementation()!;
    let release!: () => void;
    prime.mockImplementationOnce(async () => {
      await new Promise<void>((done) => {
        release = done;
      });
      return read();
    });
    const work = advance();
    if (mode === "stale") f.market.snapshotTs = NOW - 3_001;
    if (mode === "timestamp") f.market.snapshotTs = NaN;
    if (mode === "position") f.pos.status = "closed";
    if (mode === "lots") f.lot.remainingSize = 9;
    if (mode === "buy") f.buy.side = "sell";
    if (mode === "cohort")
      f.buy.metadata = { ...f.buy.metadata, quoteMotionV1: quoteMotion("r23_capture", "other") };
    if (mode === "roots")
      (f.sell.metadata!.bounceAskCaptureLineageV1 as any).sourceBuyRootOrderIds = ["other"];
    if (mode === "market") f.market.acceptingOrders = false;
    if (mode === "revision") f.revision = null;
    if (mode === "residual") {
      f.fills = [{ size: 2 } as Fill];
      f.pos.size = f.lot.remainingSize = 8;
    }
    if (mode === "pause") f.paused = true;
    const stopping = mode === "stop" ? module.stop() : null;
    release();
    await work;
    await stopping;
    if (reason) expect(f.sell.metadata?.bounceAskCaptureRecoveryV1).toMatchObject({ reason });
    expect(f.intent.status).toBe(
      mode === "residual"
        ? "ready"
        : ["stale", "timestamp", "pause", "stop"].includes(mode)
          ? "cancel_pending"
          : "failed",
    );
    expect(signals).toHaveBeenCalledTimes(mode === "residual" ? 1 : 0);
    if (mode === "residual") expect(f.intent.proof.prepared.replacementSize).toBe(8);
    await module.stop();
  });

  it.each([false, true])(
    "reclassifies a rejected await with permanent drift=%s",
    async (permanent) => {
      const { f, module, advance, prime } = await recoveryFixture();
      prime.mockImplementationOnce(async () => {
        if (permanent) f.pos.status = "closed";
        throw new Error("read failed");
      });
      await expect(advance()).rejects.toThrow("read failed");
      expect(f.intent.failure).toBe(permanent ? "invalid-position" : null);
      expect(f.sell.metadata?.bounceAskCaptureRecoveryV1).toMatchObject({
        reason: permanent ? "invalid-position" : "book-read-failed",
        deadlineMs: NOW + 3_000,
      });
      await module.stop();
    },
  );

  it("expires during a blocked read and prevents its late publication", async () => {
    vi.useFakeTimers();
    try {
      const { f, module, advance, prime, signals } = await recoveryFixture();
      const read = prime.getMockImplementation()!;
      let release!: () => void;
      prime.mockImplementationOnce(async () => {
        await new Promise<void>((done) => {
          release = done;
        });
        return read();
      });
      const work = advance();
      f.now += 3_000;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(f.intent.failure).toBe("post-cancel-data-expired");
      release();
      await work;
      expect(signals).not.toHaveBeenCalled();
      await module.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases an immutable ready proof after residual drift without rewriting it", async () => {
    const { f, module, advance, repo, signals } = await recoveryFixture();
    await advance();
    const proof = f.intent.proof;
    f.pos.size = f.lot.remainingSize = 8;
    await advance();
    expect(f.intent.failure).toBe("prepared-residual-changed");
    expect(f.intent.proof).toBe(proof);
    expect(repo.markBounceAskCaptureReady).toHaveBeenCalledOnce();
    expect(signals).toHaveBeenCalledOnce();
    await module.stop();
  });
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
      createdAt: new Date(NOW - 10_000).toISOString(),
      cancelAgeMs: 10_000,
      metadata: { bounceRung: { rungIndex: 0 }, quoteMotionV1: quoteMotion("bounce_exit_target") },
    });
    let intent: any = null;
    let policyEnabled = true;
    const effects: string[] = [];
    const terminal = vi.fn((_id, status, failure) => {
      intent = { ...intent, status, failure };
      return true;
    });
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
    expect(terminal).toHaveBeenCalledWith(intent.intentId, "failed", "policy-disabled");
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

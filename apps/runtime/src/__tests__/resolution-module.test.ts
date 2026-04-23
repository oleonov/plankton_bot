import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId, createPositionId } from "@plankton/domain";
import type {
  ExchangeGateway,
  MarketRepository,
  MarketResolutionRepository,
  OrderRepository,
  InventoryLotRepository,
  PositionRepository,
  TokenId,
} from "@plankton/domain";
import type { GammaResolutionClient } from "@plankton/exchange";
import { InProcessEventBus } from "@plankton/event-bus";
import { ResolutionModule } from "../modules/resolution/resolution-module.js";
import type {
  ResolutionDetector,
  DetectedResolution,
} from "../modules/resolution/resolution-detector.js";
import type { PositionSettler, SettledPosition } from "../modules/resolution/position-settler.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const TOK_YES = createTokenId("tok-yes");
const TOK_NO = createTokenId("tok-no");
const POS = createPositionId("pos-1");
const POS2 = createPositionId("pos-2");
const CONDITION = "condition-abc";

// ─── Mock factories ────────────────────────────────────────────────────────

function makeDetectedResolution(overrides?: Partial<DetectedResolution>): DetectedResolution {
  return {
    conditionId: CONDITION,
    resolution: "YES",
    winnerTokenId: TOK_YES,
    resolvedAt: "2026-01-15T00:00:00Z",
    source: "gamma-api",
    rawResponse: "{}",
    candidates: [
      {
        tokenId: TOK_YES,
        conditionId: CONDITION,
        slug: "will-x-happen",
        outcome: "YES",
        endDate: "2026-01-14T00:00:00Z",
        positionId: POS,
      },
    ],
    ...overrides,
  };
}

function makeSettledPosition(overrides?: Partial<SettledPosition>): SettledPosition {
  return {
    positionId: POS,
    tokenId: TOK_YES,
    resolution: "YES",
    settlementPrice: 1.0,
    realizedPnl: 0.8,
    size: 100,
    avgEntryPrice: 0.2,
    timestamp: Date.now(),
    ...overrides,
  };
}

function createMockDetector(): ResolutionDetector {
  return {
    detect: vi.fn<(graceMinutes: number) => Promise<DetectedResolution[]>>().mockResolvedValue([]),
    detectCondition: vi
      .fn<(conditionId: string) => Promise<DetectedResolution | null>>()
      .mockResolvedValue(null),
  } as unknown as ResolutionDetector;
}

function createMockSettler(): PositionSettler {
  return {
    settle: vi.fn<(resolution: DetectedResolution) => SettledPosition[]>().mockReturnValue([]),
    settleAlgoRedeem: vi
      .fn<(conditionIds: readonly string[]) => SettledPosition[]>()
      .mockReturnValue([]),
  } as unknown as PositionSettler;
}

function createMockMarketRepo(): MarketRepository {
  return {
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue(null),
    findByConditionId: vi.fn().mockReturnValue([]),
    upsertAll: vi.fn(),
    findAll: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
    iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    deactivateMissing: vi.fn().mockReturnValue(0),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
  } as unknown as MarketRepository;
}

function createMockOrderRepo(): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findByClientOrderId: vi.fn().mockReturnValue(null),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
  } as unknown as OrderRepository;
}

function createMockResolutionRepo(): MarketResolutionRepository {
  return {
    save: vi.fn(),
    findByConditionId: vi.fn().mockReturnValue(null),
    findAll: vi.fn().mockReturnValue([]),
    markSettled: vi.fn(),
    updateResolution: vi.fn(),
  } as unknown as MarketResolutionRepository;
}

function createMockGammaClient(): GammaResolutionClient {
  return {
    getMarketBySlug: vi.fn().mockResolvedValue(null),
    getMarketById: vi.fn().mockResolvedValue(null),
  } as unknown as GammaResolutionClient;
}

function createMockLotRepo(): InventoryLotRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue([]),
    findOpen: vi.fn().mockReturnValue([]),
    consumeFifo: vi.fn().mockReturnValue([]),
    settleAll: vi.fn(),
  } as unknown as InventoryLotRepository;
}

function createMockPositionRepo(): PositionRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(null),
    findByFamily: vi.fn().mockReturnValue([]),
    findOpen: vi.fn().mockReturnValue([]),
    findDust: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
  } as unknown as PositionRepository;
}

function createMockDb() {
  return {
    transaction: vi.fn((fn: (...args: unknown[]) => unknown) => {
      const wrapped = (...args: unknown[]) => fn(...args);
      return wrapped;
    }),
    prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
  };
}

function createMockGateway(
  balanceByToken?: Record<string, number>,
  outcomeBalanceByToken?: Record<string, bigint>,
): ExchangeGateway {
  return {
    getPositionBalance: vi.fn(async (tokenId: TokenId) => {
      return balanceByToken?.[String(tokenId)] ?? 0;
    }),
    getOutcomeTokenBalance: vi.fn(async (tokenId: TokenId) => {
      return outcomeBalanceByToken?.[String(tokenId)] ?? 0n;
    }),
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOpenOrdersForToken: vi.fn().mockResolvedValue([]),
    getFills: vi.fn().mockResolvedValue([]),
    getBalances: vi.fn().mockResolvedValue([]),
    redeemPositions: vi.fn().mockResolvedValue(undefined),
    hasPendingRedeemSubmission: vi.fn().mockReturnValue(false),
    mergePositions: vi
      .fn<(merges: { conditionId: string; amount: number }[]) => Promise<void>>()
      .mockResolvedValue(),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 0 }),
  } as unknown as ExchangeGateway;
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ResolutionModule", () => {
  let bus: InProcessEventBus;
  let detector: ReturnType<typeof createMockDetector>;
  let settler: ReturnType<typeof createMockSettler>;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let resolutionRepo: ReturnType<typeof createMockResolutionRepo>;
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let gammaClient: ReturnType<typeof createMockGammaClient>;
  let lotRepo: ReturnType<typeof createMockLotRepo>;
  let positionRepo: ReturnType<typeof createMockPositionRepo>;
  let mockDb: ReturnType<typeof createMockDb>;
  let mod: ResolutionModule;

  function createModule(overrides?: { gateway?: ExchangeGateway }) {
    return new ResolutionModule({
      detector: detector as unknown as ResolutionDetector,
      settler: settler as unknown as PositionSettler,
      marketRepo: marketRepo as unknown as MarketRepository,
      resolutionRepo: resolutionRepo as unknown as MarketResolutionRepository,
      orderRepo: orderRepo as unknown as OrderRepository,
      gammaClient: gammaClient as unknown as GammaResolutionClient,
      lotRepo: lotRepo as unknown as InventoryLotRepository,
      positionRepo: positionRepo as unknown as PositionRepository,
      db: mockDb as any,
      bus,
      log: log as any,
      checkIntervalMs: 60_000,
      graceMinutes: 30,
      ...(overrides?.gateway ? { gateway: overrides.gateway } : {}),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    bus = new InProcessEventBus();
    detector = createMockDetector();
    settler = createMockSettler();
    marketRepo = createMockMarketRepo();
    resolutionRepo = createMockResolutionRepo();
    orderRepo = createMockOrderRepo();
    gammaClient = createMockGammaClient();
    lotRepo = createMockLotRepo();
    positionRepo = createMockPositionRepo();
    mockDb = createMockDb();
    mod = createModule();
  });

  // ─── Detection ──────────────────────────────────────────────────────────

  it("returns 0 when detector finds no resolutions", async () => {
    const count = await mod.runCheck();
    expect(count).toBe(0);
    expect(detector.detect as any).toHaveBeenCalledWith(30);
  });

  it("passes graceMinutes to detector", async () => {
    const custom = new ResolutionModule({
      detector: detector as unknown as ResolutionDetector,
      settler: settler as unknown as PositionSettler,
      marketRepo: marketRepo as unknown as MarketRepository,
      resolutionRepo: resolutionRepo as unknown as MarketResolutionRepository,
      orderRepo: orderRepo as unknown as OrderRepository,
      gammaClient: gammaClient as unknown as GammaResolutionClient,
      lotRepo: lotRepo as unknown as InventoryLotRepository,
      positionRepo: positionRepo as unknown as PositionRepository,
      db: mockDb as any,
      bus,
      log: log as any,
      checkIntervalMs: 60_000,
      graceMinutes: 45,
    });
    await custom.runCheck();
    expect(detector.detect as any).toHaveBeenCalledWith(45);
  });

  // ─── Resolution persistence ─────────────────────────────────────────────

  it("saves resolution record with status 'detected'", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect(resolutionRepo.save as any).toHaveBeenCalledWith(
      expect.objectContaining({
        conditionId: CONDITION,
        resolution: "YES",
        source: "gamma-api",
        status: "detected",
      }),
    );
  });

  // ─── Market deactivation ────────────────────────────────────────────────

  it("deactivates markets for resolved conditions", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect(marketRepo.deactivate as any).toHaveBeenCalledWith(TOK_YES);
  });

  it("deactivates all tokens in a multi-token resolution", async () => {
    const resolution = makeDetectedResolution({
      candidates: [
        {
          tokenId: TOK_YES,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "YES",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS,
        },
        {
          tokenId: TOK_NO,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "NO",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS2,
        },
      ],
    });
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect(marketRepo.deactivate as any).toHaveBeenCalledWith(TOK_YES);
    expect(marketRepo.deactivate as any).toHaveBeenCalledWith(TOK_NO);
  });

  // ─── Settlement ─────────────────────────────────────────────────────────

  it("calls settler.settle and returns settled count", async () => {
    const resolution = makeDetectedResolution();
    const settled = [makeSettledPosition()];
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue(settled);

    const count = await mod.runCheck();

    expect(count).toBe(1);
    expect(settler.settle as any).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION }),
    );
  });

  it("accumulates settled count across multiple resolutions", async () => {
    const r1 = makeDetectedResolution({ conditionId: "cond-1" });
    const r2 = makeDetectedResolution({ conditionId: "cond-2" });
    (detector.detect as any).mockResolvedValue([r1, r2]);
    (settler.settle as any)
      .mockReturnValueOnce([makeSettledPosition()])
      .mockReturnValueOnce([makeSettledPosition(), makeSettledPosition()]);

    const count = await mod.runCheck();
    expect(count).toBe(3);
  });

  // ─── Event publishing ──────────────────────────────────────────────────

  it("publishes MarketResolved event", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    const events: unknown[] = [];
    bus.subscribe("MarketResolved", async (e) => {
      events.push(e);
    });

    await mod.runCheck();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        conditionId: CONDITION,
        resolution: "YES",
        source: "gamma-api",
      }),
    );
  });

  it("publishes PositionSettled events for each settled position", async () => {
    const resolution = makeDetectedResolution();
    const settled = [
      makeSettledPosition({ positionId: POS }),
      makeSettledPosition({ positionId: POS2, tokenId: TOK_NO }),
    ];
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue(settled);

    const events: unknown[] = [];
    bus.subscribe("PositionSettled", async (e) => {
      events.push(e);
    });

    await mod.runCheck();

    expect(events).toHaveLength(2);
  });

  // ─── Unknown resolution guard ────────────────────────────────────────

  it("does not settle when resolution is unknown (delisted market)", async () => {
    const resolution = makeDetectedResolution({
      resolution: "unknown",
      source: "gamma-delisted",
    });
    (detector.detect as any).mockResolvedValue([resolution]);

    const count = await mod.runCheck();

    expect(count).toBe(0);
    expect(settler.settle as any).not.toHaveBeenCalled();
  });

  it("still publishes MarketResolved for unknown resolution", async () => {
    const resolution = makeDetectedResolution({
      resolution: "unknown",
      source: "gamma-delisted",
    });
    (detector.detect as any).mockResolvedValue([resolution]);

    const events: unknown[] = [];
    bus.subscribe("MarketResolved", async (e) => {
      events.push(e);
    });

    await mod.runCheck();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ resolution: "unknown" }));
  });

  it("still deactivates markets for unknown resolution", async () => {
    const resolution = makeDetectedResolution({
      resolution: "unknown",
      source: "gamma-delisted",
    });
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect(marketRepo.deactivate as any).toHaveBeenCalledWith(TOK_YES);
  });

  it("still persists resolution record for unknown resolution with status 'detected'", async () => {
    const resolution = makeDetectedResolution({
      resolution: "unknown",
      source: "gamma-delisted",
    });
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect(resolutionRepo.save as any).toHaveBeenCalledWith(
      expect.objectContaining({
        conditionId: CONDITION,
        resolution: "unknown",
        status: "detected",
      }),
    );
  });

  // ─── Order cancellation on resolved markets ─────────────────────────────

  it("publishes CancelOrderRequested for open orders on resolved tokens", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);
    (orderRepo.findByTokenId as any).mockReturnValue([
      { orderId: "ord-1", status: "open" },
      { orderId: "ord-2", status: "filled" }, // should not be cancelled
      { orderId: "ord-3", status: "partially-filled" },
    ]);

    const cancelEvents: any[] = [];
    bus.subscribe("CancelOrderRequested", async (e) => {
      cancelEvents.push(e);
    });

    await mod.runCheck();

    expect(cancelEvents).toHaveLength(2);
    const cancelledIds = cancelEvents.map((e) => e.command.orderId).sort();
    expect(cancelledIds).toEqual(["ord-1", "ord-3"]);
    expect(cancelEvents[0].command.reason).toBe("market_resolved");
  });

  it("publishes CancelOrderRequested even when resolution is unknown", async () => {
    const resolution = makeDetectedResolution({
      resolution: "unknown",
      source: "gamma-delisted",
    });
    (detector.detect as any).mockResolvedValue([resolution]);
    (orderRepo.findByTokenId as any).mockReturnValue([{ orderId: "ord-1", status: "open" }]);

    const cancelEvents: any[] = [];
    bus.subscribe("CancelOrderRequested", async (e) => {
      cancelEvents.push(e);
    });

    await mod.runCheck();

    expect(cancelEvents).toHaveLength(1);
    expect(cancelEvents[0].command.orderId).toBe("ord-1");
  });

  it("consumes market-resolved WS hints, cancels open orders, and verifies via detector", async () => {
    const resolution = makeDetectedResolution();
    (detector.detectCondition as any).mockResolvedValue(resolution);
    (orderRepo.findByTokenId as any).mockReturnValue([
      { orderId: "ord-1", status: "open", exchangeOrderId: "exch-1" },
    ]);

    const cancelEvents: any[] = [];
    bus.subscribe("CancelOrderRequested", async (e) => {
      cancelEvents.push(e);
    });

    await mod.start();
    await bus.publish("MarketResolvedHint", {
      conditionId: CONDITION,
      marketId: "market-1",
      slug: "will-x-happen",
      tokenIds: [TOK_YES],
      winningTokenId: TOK_YES,
      timestamp: Date.now(),
    });
    await bus.drain();
    await mod.stop();

    expect(detector.detectCondition as any).toHaveBeenCalledWith(CONDITION);
    expect(cancelEvents).toHaveLength(1);
    expect(cancelEvents[0].command.reason).toBe("market_resolved");
    expect(mod.getHintMetricsSnapshot()).toEqual({
      resolutionWsHintsConsumed: 1,
    });
  });

  it("full cancel chain: MarketResolved triggers CancelOrderRequested with correct command shape", async () => {
    const resolution = makeDetectedResolution({
      candidates: [
        {
          tokenId: TOK_YES,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "YES",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS,
        },
        {
          tokenId: TOK_NO,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "NO",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS2,
        },
      ],
    });
    (detector.detect as any).mockResolvedValue([resolution]);
    (orderRepo.findByTokenId as any).mockImplementation((tokenId: TokenId) => {
      if (String(tokenId) === String(TOK_YES)) {
        return [{ orderId: "ord-yes", status: "open" }];
      }
      if (String(tokenId) === String(TOK_NO)) {
        return [{ orderId: "ord-no", status: "pending", exchangeOrderId: null }];
      }
      return [];
    });

    const resolvedEvents: any[] = [];
    const cancelEvents: any[] = [];
    bus.subscribe("MarketResolved", async (e) => {
      resolvedEvents.push(e);
    });
    bus.subscribe("CancelOrderRequested", async (e) => {
      cancelEvents.push(e);
    });

    await mod.runCheck();

    // MarketResolved was published
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]).toEqual(
      expect.objectContaining({
        conditionId: CONDITION,
        tokenIds: [TOK_YES, TOK_NO],
        resolution: "YES",
      }),
    );

    // CancelOrderRequested only for the open order with exchange ID
    expect(cancelEvents).toHaveLength(1);

    expect(cancelEvents[0].command).toEqual(
      expect.objectContaining({
        type: "CancelOrderCommand",
        orderId: "ord-yes",
        reason: "market_resolved",
      }),
    );

    // Pending order without exchange ID is locally cancelled
    expect(orderRepo.updateStatus as any).toHaveBeenCalledWith("ord-no", "cancelled");
  });

  it("publishes CancelOrderRequested for pending orders that have an exchange ID", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);
    (orderRepo.findByTokenId as any).mockReturnValue([
      { orderId: "ord-1", status: "pending", exchangeOrderId: "exch-123" },
    ]);

    const cancelEvents: any[] = [];
    bus.subscribe("CancelOrderRequested", async (e) => {
      cancelEvents.push(e);
    });

    await mod.runCheck();

    expect(cancelEvents).toHaveLength(1);
    expect(cancelEvents[0].command.orderId).toBe("ord-1");
    expect(orderRepo.updateStatus as any).not.toHaveBeenCalled();
  });

  it("locally cancels pending orders without exchange ID instead of publishing cancel event", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);
    (orderRepo.findByTokenId as any).mockReturnValue([
      { orderId: "ord-1", status: "pending", exchangeOrderId: null },
    ]);

    const cancelEvents: any[] = [];
    bus.subscribe("CancelOrderRequested", async (e) => {
      cancelEvents.push(e);
    });

    await mod.runCheck();

    expect(cancelEvents).toHaveLength(0);
    expect(orderRepo.updateStatus as any).toHaveBeenCalledWith("ord-1", "cancelled");
  });

  // ─── Balance verification (gateway-based settlement gate) ───────────────

  it("skips settlement when on-chain balance is non-zero", async () => {
    const gateway = createMockGateway({ "tok-yes": 50 });
    mod = createModule({ gateway });
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    const count = await mod.runCheck();

    expect(count).toBe(0);
    expect(settler.settle as any).not.toHaveBeenCalled();
    expect(gateway.getPositionBalance as any).toHaveBeenCalledWith(TOK_YES);
  });

  it("settles when on-chain balance is zero", async () => {
    const gateway = createMockGateway({ "tok-yes": 0 });
    mod = createModule({ gateway });
    const resolution = makeDetectedResolution();
    const settled = [makeSettledPosition()];
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue(settled);

    const count = await mod.runCheck();

    expect(count).toBe(1);
    expect(settler.settle as any).toHaveBeenCalled();
  });

  it("treats atomic dust balance as settled", async () => {
    const gateway = createMockGateway({ "tok-yes": 0.000001 });
    mod = createModule({ gateway });
    const resolution = makeDetectedResolution();
    const settled = [makeSettledPosition()];
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue(settled);

    const count = await mod.runCheck();

    expect(count).toBe(1);
    expect(settler.settle as any).toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "skipping settlement — on-chain token balance is non-zero",
    );
  });

  it("still deactivates markets and cancels orders when balance is non-zero", async () => {
    const gateway = createMockGateway({ "tok-yes": 100 });
    mod = createModule({ gateway });
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);
    (orderRepo.findByTokenId as any).mockReturnValue([{ orderId: "ord-1", status: "open" }]);

    const cancelEvents: any[] = [];
    bus.subscribe("CancelOrderRequested", async (e) => {
      cancelEvents.push(e);
    });

    await mod.runCheck();

    expect(marketRepo.deactivate as any).toHaveBeenCalledWith(TOK_YES);
    expect(cancelEvents).toHaveLength(1);
    expect(cancelEvents[0].command.orderId).toBe("ord-1");
  });

  it("publishes MarketResolved even when balance blocks settlement", async () => {
    const gateway = createMockGateway({ "tok-yes": 50 });
    mod = createModule({ gateway });
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    const events: unknown[] = [];
    bus.subscribe("MarketResolved", async (e) => {
      events.push(e);
    });

    await mod.runCheck();

    expect(events).toHaveLength(1);
  });

  it("defers settlement verification while redeem submission is still pending", async () => {
    const gateway = createMockGateway({ "tok-yes": 50 });
    (gateway.hasPendingRedeemSubmission as any).mockReturnValue(true);
    mod = createModule({ gateway });
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    const count = await mod.runCheck();

    expect(count).toBe(0);
    expect(gateway.redeemPositions).toHaveBeenCalledWith([CONDITION]);
    expect(gateway.getPositionBalance).not.toHaveBeenCalled();
    expect(settler.settle as any).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "skipping settlement — on-chain token balance is non-zero",
    );
  });

  it("settles without balance check when no gateway is provided", async () => {
    // No gateway = simulation/paper mode, settle immediately
    mod = createModule();
    const resolution = makeDetectedResolution();
    const settled = [makeSettledPosition()];
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue(settled);

    const count = await mod.runCheck();

    expect(count).toBe(1);
  });

  it("skips settlement and logs warning when balance check throws", async () => {
    const gateway = createMockGateway();
    (gateway.getPositionBalance as any).mockRejectedValue(new Error("Network error"));
    mod = createModule({ gateway });

    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    const count = await mod.runCheck();

    expect(count).toBe(0);
    expect(settler.settle as any).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: String(TOK_YES),
        conditionId: CONDITION,
      }),
      "skipping settlement — balance check failed",
    );
  });

  it("settles zero-balance candidates and skips errored ones in mixed batch", async () => {
    const gateway = createMockGateway({ "tok-yes": 0 });
    // TOK_NO balance check will throw
    (gateway.getPositionBalance as any).mockImplementation(async (tokenId: TokenId) => {
      if (String(tokenId) === "tok-yes") return 0;
      throw new Error("SDK timeout");
    });
    mod = createModule({ gateway });

    const resolution = makeDetectedResolution({
      candidates: [
        {
          tokenId: TOK_YES,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "YES",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS,
        },
        {
          tokenId: TOK_NO,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "NO",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS2,
        },
      ],
    });
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue([makeSettledPosition()]);

    await mod.runCheck();

    // settler should only receive the zero-balance candidate (TOK_YES)
    const settleArg = (settler.settle as any).mock.calls[0][0];
    expect(settleArg.candidates).toHaveLength(1);
    expect(settleArg.candidates[0].tokenId).toBe(TOK_YES);
  });

  it("filters mixed-balance candidates — settles only zero-balance tokens", async () => {
    const gateway = createMockGateway({ "tok-yes": 0, "tok-no": 25 });
    mod = createModule({ gateway });

    const resolution = makeDetectedResolution({
      candidates: [
        {
          tokenId: TOK_YES,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "YES",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS,
        },
        {
          tokenId: TOK_NO,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "NO",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS2,
        },
      ],
    });
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue([makeSettledPosition()]);

    await mod.runCheck();

    // settler should only receive the zero-balance candidate (TOK_YES)
    const settleArg = (settler.settle as any).mock.calls[0][0];
    expect(settleArg.candidates).toHaveLength(1);
    expect(settleArg.candidates[0].tokenId).toBe(TOK_YES);
  });

  // ─── Status tracking and settlement retry ──────────────────────────────

  it("calls markSettled when all candidates are settled (no gateway)", async () => {
    const resolution = makeDetectedResolution();
    const settled = [makeSettledPosition()];
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue(settled);

    await mod.runCheck();

    expect(resolutionRepo.markSettled as any).toHaveBeenCalledWith(CONDITION);
  });

  it("calls markSettled when all candidates pass balance check", async () => {
    const gateway = createMockGateway({ "tok-yes": 0 });
    mod = createModule({ gateway });
    const resolution = makeDetectedResolution();
    const settled = [makeSettledPosition()];
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue(settled);

    await mod.runCheck();

    expect(resolutionRepo.markSettled as any).toHaveBeenCalledWith(CONDITION);
  });

  it("does NOT call markSettled when some candidates have non-zero balance", async () => {
    const gateway = createMockGateway({ "tok-yes": 0, "tok-no": 25 });
    mod = createModule({ gateway });

    const resolution = makeDetectedResolution({
      candidates: [
        {
          tokenId: TOK_YES,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "YES",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS,
        },
        {
          tokenId: TOK_NO,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "NO",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS2,
        },
      ],
    });
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue([makeSettledPosition()]);

    await mod.runCheck();

    expect(resolutionRepo.markSettled as any).not.toHaveBeenCalled();
  });

  it("does NOT call markSettled for unknown resolution", async () => {
    const resolution = makeDetectedResolution({
      resolution: "unknown",
      source: "gamma-delisted",
    });
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect(resolutionRepo.markSettled as any).not.toHaveBeenCalled();
  });

  it("skips deactivation and cancel on retry (resolution already exists)", async () => {
    // Simulate retry: findByConditionId returns existing "detected" record
    (resolutionRepo.findByConditionId as any).mockReturnValue({
      conditionId: CONDITION,
      status: "detected",
    });

    const resolution = makeDetectedResolution();
    const settled = [makeSettledPosition()];
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue(settled);

    await mod.runCheck();

    // Should NOT save again (isRetry=true)
    expect(resolutionRepo.save as any).not.toHaveBeenCalled();
    // Should NOT deactivate or cancel on retry
    expect(marketRepo.deactivate as any).not.toHaveBeenCalled();
    // Should still settle
    expect(settler.settle as any).toHaveBeenCalled();
    // Should mark settled
    expect(resolutionRepo.markSettled as any).toHaveBeenCalledWith(CONDITION);
  });

  it("does not publish MarketResolved on retry", async () => {
    (resolutionRepo.findByConditionId as any).mockReturnValue({
      conditionId: CONDITION,
      status: "detected",
    });

    const resolution = makeDetectedResolution();
    const settled = [makeSettledPosition()];
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue(settled);

    const events: unknown[] = [];
    bus.subscribe("MarketResolved", async (e) => {
      events.push(e);
    });

    await mod.runCheck();

    expect(events).toHaveLength(0);
  });

  it("still publishes PositionSettled on retry when positions are settled", async () => {
    (resolutionRepo.findByConditionId as any).mockReturnValue({
      conditionId: CONDITION,
      status: "detected",
    });

    const resolution = makeDetectedResolution();
    const settled = [makeSettledPosition()];
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue(settled);

    const events: unknown[] = [];
    bus.subscribe("PositionSettled", async (e) => {
      events.push(e);
    });

    await mod.runCheck();

    expect(events).toHaveLength(1);
  });

  // ─── Re-entrancy guard ─────────────────────────────────────────────────

  it("prevents concurrent runCheck invocations", async () => {
    let resolveDetect: () => void;
    (detector.detect as any).mockReturnValue(
      new Promise<DetectedResolution[]>((r) => {
        resolveDetect = () => r([]);
      }),
    );

    const p1 = mod.runCheck();
    const p2 = mod.runCheck(); // should return 0 immediately

    const count2 = await p2;
    expect(count2).toBe(0);

    resolveDetect!();
    const count1 = await p1;
    expect(count1).toBe(0);
  });

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  it("stop clears interval", async () => {
    await mod.start();
    await mod.stop();
    // No assertions needed — just verifying no errors
  });

  it("healthCheck returns ok", async () => {
    const health = await mod.healthCheck();
    expect(health.ok).toBe(true);
  });

  // ─── Resolution recovery ─────────────────────────────────────────────────

  it("recoverUnresolved settles closed positions with orphaned lots", async () => {
    // Setup: market_resolution with detected/unknown
    (resolutionRepo.findAll as any).mockReturnValue([
      {
        conditionId: CONDITION,
        resolution: "unknown",
        resolvedAt: "2026-01-15T00:00:00Z",
        detectedAt: "2026-01-15T01:00:00Z",
        source: "gamma-delisted",
        rawResponse: null,
        status: "detected",
      },
    ]);

    // Mock: markets for this conditionId
    (marketRepo.findByConditionId as any).mockReturnValue([
      {
        tokenId: TOK_YES,
        conditionId: CONDITION,
        slug: "will-x-happen",
        outcome: "YES",
      },
    ]);

    // Mock: Gamma returns resolved market with outcomePrices and clobTokenIds
    (gammaClient.getMarketBySlug as any).mockResolvedValue({
      closed: true,
      umaResolutionStatus: null,
      closedTime: "2026-01-15T00:00:00Z",
      rawPayload: {
        outcomePrices: '["1","0"]',
        outcomes: '["Yes","No"]',
        clobTokenIds: `["${String(TOK_YES)}","${String(TOK_NO)}"]`,
      },
    });

    // Mock: positionRepo.findAll returns closed position
    (positionRepo.findAll as any).mockReturnValue([
      {
        positionId: POS,
        tokenId: TOK_YES,

        side: "BUY",
        size: 0,
        avgEntryPrice: 0.3,
        costBasisUsdc: 30,
        currentValueUsdc: 0,
        realizedPnl: 0,
        status: "closed",
        openedAt: "2026-01-10T00:00:00Z",
        closedAt: "2026-01-14T00:00:00Z",
        updatedAt: "2026-01-14T00:00:00Z",
      },
    ]);

    // Mock: lotRepo.findOpen returns open lots (orphaned)
    (lotRepo.findOpen as any).mockReturnValue([
      {
        lotId: "lot-1",
        positionId: POS,
        tokenId: TOK_YES,

        side: "BUY",
        size: 100,
        remainingSize: 100,
        entryPrice: 0.3,
        costUsdc: 30,
        fillId: "fill-1",
        createdAt: "2026-01-10T00:00:00Z",
      },
    ]);

    // start() triggers recoverUnresolved non-blocking; wait for it
    await mod.start();
    // Give async recoverUnresolved time to complete
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mod.stop();

    // Verify resolution was updated (outcome comes from Gamma payload as-is: "Yes")
    expect(resolutionRepo.updateResolution as any).toHaveBeenCalledWith(
      CONDITION,
      "Yes",
      "2026-01-15T00:00:00Z",
      "gamma-api",
    );

    // Verify lots were settled
    expect(lotRepo.settleAll as any).toHaveBeenCalledWith(POS);

    // Verify position was saved with size: 0 and updated realizedPnl
    expect(positionRepo.save as any).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: POS,
        size: 0,
        realizedPnl: 70, // (1.0 - 0.3) * 100
        currentValueUsdc: 0,
      }),
    );
  });

  it("recoverUnresolved matches outcome labels case-insensitively when winnerTokenId is unavailable", async () => {
    (resolutionRepo.findAll as any).mockReturnValue([
      {
        conditionId: CONDITION,
        resolution: "unknown",
        resolvedAt: "2026-01-15T00:00:00Z",
        detectedAt: "2026-01-15T01:00:00Z",
        source: "gamma-delisted",
        rawResponse: null,
        status: "detected",
      },
    ]);

    (marketRepo.findByConditionId as any).mockReturnValue([
      {
        tokenId: TOK_YES,
        conditionId: CONDITION,
        slug: "will-x-happen",
        outcome: " Yes ",
      },
    ]);

    (gammaClient.getMarketBySlug as any).mockResolvedValue({
      closed: true,
      umaResolutionStatus: null,
      closedTime: "2026-01-15T00:00:00Z",
      rawPayload: {
        outcomePrices: '["1","0"]',
        outcomes: '["yes","no"]',
      },
    });

    (positionRepo.findAll as any).mockReturnValue([
      {
        positionId: POS,
        tokenId: TOK_YES,

        side: "BUY",
        size: 0,
        avgEntryPrice: 0.3,
        costBasisUsdc: 30,
        currentValueUsdc: 0,
        realizedPnl: 0,
        status: "closed",
        openedAt: "2026-01-10T00:00:00Z",
        closedAt: "2026-01-14T00:00:00Z",
        updatedAt: "2026-01-14T00:00:00Z",
      },
    ]);

    (lotRepo.findOpen as any).mockReturnValue([
      {
        lotId: "lot-1",
        positionId: POS,
        tokenId: TOK_YES,

        side: "BUY",
        size: 10,
        remainingSize: 10,
        entryPrice: 0.3,
        costUsdc: 3,
        fillId: "fill-1",
        createdAt: "2026-01-10T00:00:00Z",
      },
    ]);

    await mod.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mod.stop();

    expect(positionRepo.save as any).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: POS,
        realizedPnl: 7,
        currentValueUsdc: 0,
      }),
    );
  });

  it("recoverUnresolved skips when Gamma still returns unknown", async () => {
    (resolutionRepo.findAll as any).mockReturnValue([
      {
        conditionId: CONDITION,
        resolution: "unknown",
        status: "detected",
        resolvedAt: "2026-01-15T00:00:00Z",
        detectedAt: "2026-01-15T01:00:00Z",
        source: "gamma-delisted",
        rawResponse: null,
      },
    ]);

    (marketRepo.findByConditionId as any).mockReturnValue([
      {
        tokenId: TOK_YES,
        conditionId: CONDITION,
        slug: "will-x-happen",
        outcome: "YES",
      },
    ]);

    // Gamma returns closed but no price data → still unknown
    (gammaClient.getMarketBySlug as any).mockResolvedValue({
      closed: true,
      umaResolutionStatus: null,
      closedTime: "2026-01-15T00:00:00Z",
      rawPayload: {},
    });

    await mod.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mod.stop();

    // Should not update resolution
    expect(resolutionRepo.updateResolution as any).not.toHaveBeenCalled();
    expect(lotRepo.settleAll as any).not.toHaveBeenCalled();
  });

  it("recoverUnresolved skips when Gamma lookup fails", async () => {
    (resolutionRepo.findAll as any).mockReturnValue([
      {
        conditionId: CONDITION,
        resolution: "unknown",
        status: "detected",
        resolvedAt: "2026-01-15T00:00:00Z",
        detectedAt: "2026-01-15T01:00:00Z",
        source: "gamma-delisted",
        rawResponse: null,
      },
    ]);

    (marketRepo.findByConditionId as any).mockReturnValue([
      {
        tokenId: TOK_YES,
        conditionId: CONDITION,
        slug: "will-x-happen",
        outcome: "YES",
      },
    ]);

    (gammaClient.getMarketBySlug as any).mockRejectedValue(new Error("Network error"));

    await mod.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mod.stop();

    expect(resolutionRepo.updateResolution as any).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION }),
      "recovery Gamma lookup failed — skipping",
    );
  });

  // ─── RedeemRequested (algo-triggered redeem) ─────────────────────────────

  describe("RedeemRequested (algo-triggered)", () => {
    it("no-ops when conditionIds is empty", async () => {
      await mod.start();
      await bus.publish("RedeemRequested", { conditionIds: [], timestamp: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await mod.stop();

      expect(settler.settleAlgoRedeem as any).not.toHaveBeenCalled();
    });

    it("settles local positions and publishes PositionSettled in all modes", async () => {
      const settledEvents: SettledPosition[] = [];
      const unsub = bus.subscribe("PositionSettled", async (p) => {
        settledEvents.push(p);
      });

      const settled = [makeSettledPosition({ resolution: "algo-redeem", settlementPrice: 0 })];
      (settler.settleAlgoRedeem as any).mockReturnValue(settled);

      await mod.start();
      await bus.publish("RedeemRequested", {
        conditionIds: [CONDITION],
        timestamp: Date.now(),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await mod.stop();
      unsub();

      expect(settler.settleAlgoRedeem as any).toHaveBeenCalledWith([CONDITION]);
      expect(settledEvents).toHaveLength(1);
      expect(settledEvents[0]!.resolution).toBe("algo-redeem");
      expect(settledEvents[0]!.settlementPrice).toBe(0);
    });

    it("submits on-chain redeem and settles locally when gateway succeeds", async () => {
      const gateway = createMockGateway();
      mod = createModule({ gateway });

      const settled = [makeSettledPosition({ resolution: "algo-redeem", settlementPrice: 0 })];
      (settler.settleAlgoRedeem as any).mockReturnValue(settled);

      await mod.start();
      await bus.publish("RedeemRequested", {
        conditionIds: [CONDITION],
        timestamp: Date.now(),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await mod.stop();

      expect(gateway.redeemPositions as any).toHaveBeenCalledWith([CONDITION]);
      expect(settler.settleAlgoRedeem as any).toHaveBeenCalledWith([CONDITION]);
    });

    it("does not settle locally when on-chain redeem throws", async () => {
      const gateway = createMockGateway();
      (gateway.redeemPositions as any).mockRejectedValue(new Error("relayer down"));
      mod = createModule({ gateway });

      const settled = [makeSettledPosition({ resolution: "algo-redeem", settlementPrice: 0 })];
      (settler.settleAlgoRedeem as any).mockReturnValue(settled);

      await mod.start();
      await bus.publish("RedeemRequested", {
        conditionIds: [CONDITION],
        timestamp: Date.now(),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await mod.stop();

      expect(settler.settleAlgoRedeem as any).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ conditionIds: [CONDITION] }),
        "algo-triggered on-chain redeem failed",
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ conditionIds: [CONDITION] }),
        "algo-triggered redeem skipped local settlement until on-chain redeem succeeds",
      );
    });

    describe("redeemability guard", () => {
      it("defers algo-redeem before market endDate and leaves orders untouched", async () => {
        const gateway = createMockGateway(undefined, { "tok-yes": 1n });
        mod = createModule({ gateway });

        (marketRepo.findByConditionId as any).mockImplementation((conditionId: string) =>
          conditionId === CONDITION
            ? [
                {
                  tokenId: TOK_YES,
                  conditionId,
                  slug: "future-market",
                  outcome: "YES",
                  endDate: new Date(Date.now() + 60_000).toISOString(),
                },
              ]
            : [],
        );
        (orderRepo.findByTokenId as any).mockReturnValue([
          {
            orderId: "ord-1",
            exchangeOrderId: "ex-1",
            tokenId: TOK_YES,
            status: "open",
            side: "buy",
          },
        ]);

        const cancels: Array<Record<string, unknown>> = [];
        const unsub = bus.subscribe("CancelOrderRequested", async (payload) => {
          cancels.push(payload as unknown as Record<string, unknown>);
        });

        await mod.start();
        await (mod as any).handleAlgoRedeem([CONDITION]);
        await mod.stop();
        unsub();

        expect(gateway.redeemPositions as any).not.toHaveBeenCalled();
        expect(settler.settleAlgoRedeem as any).not.toHaveBeenCalled();
        expect(cancels).toHaveLength(0);
        expect(log.info).toHaveBeenCalledWith(
          expect.objectContaining({ conditionId: CONDITION, reason: "before_end_date" }),
          "algo_redeem_deferred_not_redeemable",
        );
      });

      it("defers algo-redeem after endDate until Gamma reports the market closed", async () => {
        const gateway = createMockGateway(undefined, { "tok-yes": 1n });
        mod = createModule({ gateway });

        (marketRepo.findByConditionId as any).mockImplementation((conditionId: string) =>
          conditionId === CONDITION
            ? [
                {
                  tokenId: TOK_YES,
                  conditionId,
                  slug: "ended-market",
                  outcome: "YES",
                  endDate: new Date(Date.now() - 60_000).toISOString(),
                },
              ]
            : [],
        );
        (gammaClient.getMarketBySlug as any).mockResolvedValue({
          closed: false,
          closedTime: null,
          rawPayload: {},
          umaResolutionStatus: null,
        });

        await mod.start();
        await (mod as any).handleAlgoRedeem([CONDITION]);
        await mod.stop();

        expect(gateway.redeemPositions as any).not.toHaveBeenCalled();
        expect(settler.settleAlgoRedeem as any).not.toHaveBeenCalled();
        expect(gammaClient.getMarketBySlug as any).toHaveBeenCalledWith("ended-market");
        expect(log.info).toHaveBeenCalledWith(
          expect.objectContaining({ conditionId: CONDITION, reason: "gamma_unresolved" }),
          "algo_redeem_deferred_not_redeemable",
        );
      });

      it("allows algo-redeem after endDate once Gamma reports the market closed", async () => {
        const gateway = createMockGateway(undefined, { "tok-yes": 1n });
        mod = createModule({ gateway });

        (marketRepo.findByConditionId as any).mockImplementation((conditionId: string) =>
          conditionId === CONDITION
            ? [
                {
                  tokenId: TOK_YES,
                  conditionId,
                  slug: "closed-market",
                  outcome: "YES",
                  endDate: new Date(Date.now() - 60_000).toISOString(),
                },
              ]
            : [],
        );
        (gammaClient.getMarketBySlug as any).mockResolvedValue({
          closed: true,
          closedTime: new Date().toISOString(),
          rawPayload: {},
          umaResolutionStatus: "resolved",
        });
        (settler.settleAlgoRedeem as any).mockReturnValue([
          makeSettledPosition({ resolution: "algo-redeem", settlementPrice: 0 }),
        ]);

        await mod.start();
        await (mod as any).handleAlgoRedeem([CONDITION]);
        await mod.stop();

        expect(gammaClient.getMarketBySlug as any).toHaveBeenCalledWith("closed-market");
        expect(gateway.redeemPositions as any).toHaveBeenCalledWith([CONDITION]);
        expect(settler.settleAlgoRedeem as any).toHaveBeenCalledWith([CONDITION]);
      });
    });

    // Phase 2.B: per-conditionId back-off + circuit breaker. The production
    // baseline showed the same conditionId hitting the gateway up to 14× per
    // 24 h window; these tests pin the 3-failure → 1-hour lockout contract.
    describe("circuit breaker (Phase 2.B)", () => {
      it("opens circuit after 3 consecutive failures; 4th call skips gateway and does not settle locally", async () => {
        const gateway = createMockGateway();
        (gateway.redeemPositions as any).mockRejectedValue(new Error("relayer down"));
        mod = createModule({ gateway });

        const settled = [makeSettledPosition({ resolution: "algo-redeem", settlementPrice: 0 })];
        (settler.settleAlgoRedeem as any).mockReturnValue(settled);

        await mod.start();

        // Fire 3 failing attempts, separated enough that the per-attempt
        // back-off (1 min / 5 min) doesn't suppress them.
        const baseline = Date.now();
        let tick = baseline;
        vi.useFakeTimers();
        vi.setSystemTime(tick);
        for (let i = 0; i < 3; i++) {
          await (mod as any).handleAlgoRedeem([CONDITION]);
          tick += 10 * 60_000;
          vi.setSystemTime(tick);
        }
        expect(gateway.redeemPositions).toHaveBeenCalledTimes(3);

        // 4th attempt within 1h should be suppressed (circuit open).
        await (mod as any).handleAlgoRedeem([CONDITION]);
        expect(gateway.redeemPositions).toHaveBeenCalledTimes(3);
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ conditionIds: [CONDITION] }),
          "algo_redeem_circuit_open",
        );

        expect(settler.settleAlgoRedeem as any).not.toHaveBeenCalled();

        vi.useRealTimers();
        await mod.stop();
      });

      it("resets circuit after a successful gateway call", async () => {
        const gateway = createMockGateway();
        mod = createModule({ gateway });

        vi.useFakeTimers();
        const baseline = Date.now();
        let tick = baseline;
        vi.setSystemTime(tick);

        // Two failures raise failureCount to 2.
        (gateway.redeemPositions as any)
          .mockRejectedValueOnce(new Error("relayer down"))
          .mockRejectedValueOnce(new Error("relayer down"))
          .mockResolvedValueOnce(undefined);

        await mod.start();
        await (mod as any).handleAlgoRedeem([CONDITION]);
        tick += 6 * 60_000; // > 5 min back-off
        vi.setSystemTime(tick);
        await (mod as any).handleAlgoRedeem([CONDITION]);
        tick += 6 * 60_000;
        vi.setSystemTime(tick);

        // Third attempt succeeds → circuit entry must be cleared.
        await (mod as any).handleAlgoRedeem([CONDITION]);

        // After reset, two more failures within < 1m must still be throttled
        // (failureCount goes 0→1 again on the next failure; back-off kicks in).
        (gateway.redeemPositions as any).mockRejectedValue(new Error("relayer down"));
        tick += 1_000;
        vi.setSystemTime(tick);
        await (mod as any).handleAlgoRedeem([CONDITION]);
        // Now failureCount=1; a retry < 1 min later must be suppressed by
        // the back-off table (not the full circuit, since count < 3).
        const callCountAfterFirstPostResetFailure = (gateway.redeemPositions as any).mock.calls
          .length;
        tick += 30_000;
        vi.setSystemTime(tick);
        await (mod as any).handleAlgoRedeem([CONDITION]);
        expect((gateway.redeemPositions as any).mock.calls.length).toBe(
          callCountAfterFirstPostResetFailure,
        );

        vi.useRealTimers();
        await mod.stop();
      });

      it("honors per-attempt back-off window (1m after 1st, 5m after 2nd)", async () => {
        const gateway = createMockGateway();
        (gateway.redeemPositions as any).mockRejectedValue(new Error("relayer down"));
        mod = createModule({ gateway });

        vi.useFakeTimers();
        const baseline = Date.now();
        let tick = baseline;
        vi.setSystemTime(tick);

        await mod.start();

        // 1st attempt → fails.
        await (mod as any).handleAlgoRedeem([CONDITION]);
        expect(gateway.redeemPositions).toHaveBeenCalledTimes(1);

        // Retry 30 s later → within 1 min back-off, gateway is skipped.
        tick += 30_000;
        vi.setSystemTime(tick);
        await (mod as any).handleAlgoRedeem([CONDITION]);
        expect(gateway.redeemPositions).toHaveBeenCalledTimes(1);

        // After 61 s → back-off expired, gateway called again.
        tick += 31_000;
        vi.setSystemTime(tick);
        await (mod as any).handleAlgoRedeem([CONDITION]);
        expect(gateway.redeemPositions).toHaveBeenCalledTimes(2);

        // Now failureCount=2 → 5 min back-off. 4 min later: suppressed.
        tick += 4 * 60_000;
        vi.setSystemTime(tick);
        await (mod as any).handleAlgoRedeem([CONDITION]);
        expect(gateway.redeemPositions).toHaveBeenCalledTimes(2);

        // 6 min later: allowed again.
        tick += 2 * 60_000;
        vi.setSystemTime(tick);
        await (mod as any).handleAlgoRedeem([CONDITION]);
        expect(gateway.redeemPositions).toHaveBeenCalledTimes(3);

        vi.useRealTimers();
        await mod.stop();
      });
    });

    // Phase 3.B: skip gateway.redeemPositions when outcome-token balance is
    // already zero (already-redeemed or nothing-to-redeem). Local settle only
    // proceeds for already-redeemed or successfully submitted conditions.
    describe("already-redeemed pre-check (Phase 3.B)", () => {
      it("skips gateway.redeemPositions when all outcome-token balances are zero", async () => {
        const gateway = createMockGateway(undefined, { "tok-yes": 0n });
        mod = createModule({ gateway });

        (marketRepo.findByConditionId as any).mockReturnValue([
          { tokenId: TOK_YES, conditionId: CONDITION, slug: "x", outcome: "YES" },
        ]);
        const settled = [makeSettledPosition({ resolution: "algo-redeem", settlementPrice: 0 })];
        (settler.settleAlgoRedeem as any).mockReturnValue(settled);

        await mod.start();
        await (mod as any).handleAlgoRedeem([CONDITION]);
        await mod.stop();

        expect(gateway.getOutcomeTokenBalance as any).toHaveBeenCalledWith(TOK_YES);
        expect(gateway.redeemPositions as any).not.toHaveBeenCalled();
        // Already-redeemed conditions are still safe to close locally.
        expect(settler.settleAlgoRedeem as any).toHaveBeenCalledWith([CONDITION]);
      });

      it("still calls gateway.redeemPositions when at least one outcome-token balance is non-zero", async () => {
        const gateway = createMockGateway(undefined, { "tok-yes": 0n, "tok-no": 12345n });
        mod = createModule({ gateway });

        (marketRepo.findByConditionId as any).mockReturnValue([
          { tokenId: TOK_YES, conditionId: CONDITION, slug: "x", outcome: "YES" },
          { tokenId: TOK_NO, conditionId: CONDITION, slug: "x", outcome: "NO" },
        ]);
        (gammaClient.getMarketBySlug as any).mockResolvedValue({
          closed: true,
          closedTime: new Date().toISOString(),
          rawPayload: {},
          umaResolutionStatus: "resolved",
        });
        (settler.settleAlgoRedeem as any).mockReturnValue([]);

        await mod.start();
        await (mod as any).handleAlgoRedeem([CONDITION]);
        await mod.stop();

        expect(gateway.redeemPositions as any).toHaveBeenCalledWith([CONDITION]);
      });

      it("partitions a mixed batch — only already-redeemed conditions are skipped", async () => {
        const COND_A = "cond-a";
        const COND_B = "cond-b";
        const TOK_A = createTokenId("tok-a");
        const TOK_B = createTokenId("tok-b");
        const gateway = createMockGateway(undefined, { "tok-a": 0n, "tok-b": 500n });
        mod = createModule({ gateway });

        (marketRepo.findByConditionId as any).mockImplementation((cid: string) => {
          if (cid === COND_A)
            return [{ tokenId: TOK_A, conditionId: COND_A, slug: "a", outcome: "YES" }];
          if (cid === COND_B)
            return [{ tokenId: TOK_B, conditionId: COND_B, slug: "b", outcome: "YES" }];
          return [];
        });
        (gammaClient.getMarketBySlug as any).mockResolvedValue({
          closed: true,
          closedTime: new Date().toISOString(),
          rawPayload: {},
          umaResolutionStatus: "resolved",
        });
        (settler.settleAlgoRedeem as any).mockReturnValue([]);

        await mod.start();
        await (mod as any).handleAlgoRedeem([COND_A, COND_B]);
        await mod.stop();

        expect(gateway.redeemPositions as any).toHaveBeenCalledWith([COND_B]);
        expect(settler.settleAlgoRedeem as any).toHaveBeenCalledWith([COND_A, COND_B]);
      });

      it("falls through to gateway when the balance check throws (conservative)", async () => {
        const gateway = createMockGateway();
        (gateway.getOutcomeTokenBalance as any).mockRejectedValue(new Error("rpc timeout"));
        mod = createModule({ gateway });

        (marketRepo.findByConditionId as any).mockReturnValue([
          { tokenId: TOK_YES, conditionId: CONDITION, slug: "x", outcome: "YES" },
        ]);
        (gammaClient.getMarketBySlug as any).mockResolvedValue({
          closed: true,
          closedTime: new Date().toISOString(),
          rawPayload: {},
          umaResolutionStatus: "resolved",
        });
        (settler.settleAlgoRedeem as any).mockReturnValue([]);

        await mod.start();
        await (mod as any).handleAlgoRedeem([CONDITION]);
        await mod.stop();

        expect(gateway.redeemPositions as any).toHaveBeenCalledWith([CONDITION]);
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ conditionId: CONDITION, tokenId: String(TOK_YES) }),
          "algo_redeem_precheck_failed",
        );
      });

      it("routes to the gateway when no markets are known for a conditionId", async () => {
        const gateway = createMockGateway();
        mod = createModule({ gateway });

        (marketRepo.findByConditionId as any).mockReturnValue([]);
        (settler.settleAlgoRedeem as any).mockReturnValue([]);

        await mod.start();
        await (mod as any).handleAlgoRedeem([CONDITION]);
        await mod.stop();

        expect(gateway.getOutcomeTokenBalance as any).not.toHaveBeenCalled();
        expect(gateway.redeemPositions as any).toHaveBeenCalledWith([CONDITION]);
      });

      it("isolates per-conditionId failure bookkeeping across a multi-id batch", async () => {
        const COND_A = "cond-a";
        const COND_B = "cond-b";
        const TOK_A = createTokenId("tok-a");
        const TOK_B = createTokenId("tok-b");
        const gateway = createMockGateway(undefined, { "tok-a": 7n, "tok-b": 11n });
        // Gateway fails for COND_A (called first), succeeds for COND_B.
        (gateway.redeemPositions as any)
          .mockRejectedValueOnce(new Error("relayer revert on cond-a"))
          .mockResolvedValueOnce(undefined);
        mod = createModule({ gateway });

        (marketRepo.findByConditionId as any).mockImplementation((cid: string) => {
          if (cid === COND_A)
            return [{ tokenId: TOK_A, conditionId: COND_A, slug: "a", outcome: "YES" }];
          if (cid === COND_B)
            return [{ tokenId: TOK_B, conditionId: COND_B, slug: "b", outcome: "YES" }];
          return [];
        });
        (gammaClient.getMarketBySlug as any).mockResolvedValue({
          closed: true,
          closedTime: new Date().toISOString(),
          rawPayload: {},
          umaResolutionStatus: "resolved",
        });
        (settler.settleAlgoRedeem as any).mockReturnValue([]);

        await mod.start();
        await (mod as any).handleAlgoRedeem([COND_A, COND_B]);
        await mod.stop();

        // Gateway called once per conditionId — not once for the whole batch.
        expect(gateway.redeemPositions as any).toHaveBeenCalledTimes(2);
        expect(gateway.redeemPositions as any).toHaveBeenNthCalledWith(1, [COND_A]);
        expect(gateway.redeemPositions as any).toHaveBeenNthCalledWith(2, [COND_B]);

        // Only the failing id accrues a failure entry; the sibling stays clean.
        expect((mod as any).redeemFailures.get(COND_A)?.failureCount).toBe(1);
        expect((mod as any).redeemFailures.has(COND_B)).toBe(false);
        expect(settler.settleAlgoRedeem as any).toHaveBeenCalledWith([COND_B]);
      });

      it("clears redeem-failure bookkeeping when pre-check skips the gateway", async () => {
        const gateway = createMockGateway(undefined, { "tok-yes": 0n });
        mod = createModule({ gateway });

        (marketRepo.findByConditionId as any).mockReturnValue([
          { tokenId: TOK_YES, conditionId: CONDITION, slug: "x", outcome: "YES" },
        ]);
        (settler.settleAlgoRedeem as any).mockReturnValue([]);

        await mod.start();

        // Seed a stale failure entry outside of any active back-off window
        // so partitionRedeemTargets still routes the id to gatewayTargets.
        (mod as any).redeemFailures.set(CONDITION, {
          failedAt: Date.now() - 2 * 60 * 60_000,
          failureCount: 2,
        });

        await (mod as any).handleAlgoRedeem([CONDITION]);

        expect(gateway.redeemPositions as any).not.toHaveBeenCalled();
        expect((mod as any).redeemFailures.has(CONDITION)).toBe(false);

        await mod.stop();
      });
    });

    it("cancels open orders for tokens belonging to algo-redeemed conditions", async () => {
      (marketRepo.findByConditionId as any).mockReturnValue([
        { tokenId: TOK_YES, conditionId: CONDITION, slug: "x", outcome: "YES" },
      ]);
      const openOrder = {
        orderId: "ord-1" as any,
        exchangeOrderId: "exch-1",
        tokenId: TOK_YES,

        status: "open",
        side: "buy",
      };
      (orderRepo.findByTokenId as any).mockReturnValue([openOrder]);

      const cancels: Array<Record<string, unknown>> = [];
      const unsub = bus.subscribe("CancelOrderRequested", async (p) => {
        cancels.push(p as unknown as Record<string, unknown>);
      });

      await mod.start();
      await bus.publish("RedeemRequested", {
        conditionIds: [CONDITION],
        timestamp: Date.now(),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await mod.stop();
      unsub();

      expect(cancels).toHaveLength(1);
    });
  });
});

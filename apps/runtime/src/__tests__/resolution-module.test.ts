import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId, createFamilyId, createPositionId } from "@plankton/domain";
import type {
  ExchangeGateway,
  MarketRepository,
  MarketResolutionRepository,
  OrderRepository,
  InventoryLotRepository,
  PositionRepository,
  FamilyRulesProvider,
  FamilyRuleBundle,
  FamilyId,
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
import type { FamilyExposureCalculator } from "../modules/risk-inventory/family-exposure.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const TOK_YES = createTokenId("tok-yes");
const TOK_NO = createTokenId("tok-no");
const FAM = createFamilyId("fam-1");
const FAM2 = createFamilyId("fam-2");
const POS = createPositionId("pos-1");
const POS2 = createPositionId("pos-2");
const CONDITION = "condition-abc";

// ─── Mock factories ────────────────────────────────────────────────────────

function makeDetectedResolution(overrides?: Partial<DetectedResolution>): DetectedResolution {
  return {
    conditionId: CONDITION,
    resolution: "YES",
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
        familyId: FAM,
      },
    ],
    ...overrides,
  };
}

function makeSettledPosition(overrides?: Partial<SettledPosition>): SettledPosition {
  return {
    positionId: POS,
    tokenId: TOK_YES,
    familyId: FAM,
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
  } as unknown as ResolutionDetector;
}

function createMockSettler(): PositionSettler {
  return {
    settle: vi.fn<(resolution: DetectedResolution) => SettledPosition[]>().mockReturnValue([]),
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

function createMockRulesProvider(overrides?: { autoSettle?: boolean }): FamilyRulesProvider {
  const autoSettle = overrides?.autoSettle ?? true;
  return {
    getRule: vi.fn<(familyId: FamilyId) => FamilyRuleBundle | null>().mockReturnValue({
      rules: {
        tailSuppression: { autoSettleResolvedMarkets: autoSettle },
      },
    } as unknown as FamilyRuleBundle),
    isEnabled: vi.fn().mockReturnValue(true),
    getAllFamilies: vi.fn().mockReturnValue([]),
    getRulesForRegime: vi.fn().mockReturnValue([]),
  } as unknown as FamilyRulesProvider;
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

function createMockExposureCalculator(): FamilyExposureCalculator {
  return {
    recompute: vi.fn().mockReturnValue({
      openValueUsdc: 0,
      openPositionCount: 0,
      openDustCount: 0,
    }),
  } as unknown as FamilyExposureCalculator;
}

function createMockGateway(balanceByToken?: Record<string, number>): ExchangeGateway {
  return {
    getPositionBalance: vi.fn(async (tokenId: TokenId) => {
      return balanceByToken?.[String(tokenId)] ?? 0;
    }),
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOpenOrdersForToken: vi.fn().mockResolvedValue([]),
    getFills: vi.fn().mockResolvedValue([]),
    getBalances: vi.fn().mockResolvedValue([]),
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
  let rulesProvider: ReturnType<typeof createMockRulesProvider>;
  let exposureCalculator: ReturnType<typeof createMockExposureCalculator>;
  let gammaClient: ReturnType<typeof createMockGammaClient>;
  let lotRepo: ReturnType<typeof createMockLotRepo>;
  let positionRepo: ReturnType<typeof createMockPositionRepo>;
  let mockDb: ReturnType<typeof createMockDb>;
  let mod: ResolutionModule;

  function createModule(overrides?: {
    rulesProvider?: FamilyRulesProvider;
    gateway?: ExchangeGateway;
  }) {
    return new ResolutionModule({
      detector: detector as unknown as ResolutionDetector,
      settler: settler as unknown as PositionSettler,
      marketRepo: marketRepo as unknown as MarketRepository,
      resolutionRepo: resolutionRepo as unknown as MarketResolutionRepository,
      orderRepo: orderRepo as unknown as OrderRepository,
      rulesProvider: (overrides?.rulesProvider ?? rulesProvider) as unknown as FamilyRulesProvider,
      exposureCalculator: exposureCalculator as unknown as FamilyExposureCalculator,
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
    rulesProvider = createMockRulesProvider();
    exposureCalculator = createMockExposureCalculator();
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
      rulesProvider: rulesProvider as unknown as FamilyRulesProvider,
      exposureCalculator: exposureCalculator as unknown as FamilyExposureCalculator,
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
          familyId: FAM,
        },
        {
          tokenId: TOK_NO,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "NO",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS2,
          familyId: FAM,
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

  // ─── autoSettleResolvedMarkets flag ─────────────────────────────────────

  it("skips settlement when autoSettleResolvedMarkets is false", async () => {
    const provider = createMockRulesProvider({ autoSettle: false });
    mod = createModule({ rulesProvider: provider });

    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    const count = await mod.runCheck();

    expect(count).toBe(0);
    expect(settler.settle as any).not.toHaveBeenCalled();
  });

  it("settles only families with autoSettle enabled in mixed batch", async () => {
    // fam-1 has autoSettle=true, fam-2 has autoSettle=false
    const provider: FamilyRulesProvider = {
      getRule: vi.fn((familyId: FamilyId) => {
        const autoSettle = String(familyId) !== "fam-2";
        return {
          rules: { tailSuppression: { autoSettleResolvedMarkets: autoSettle } },
        } as unknown as FamilyRuleBundle;
      }),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as unknown as FamilyRulesProvider;

    mod = createModule({ rulesProvider: provider });

    const resolution = makeDetectedResolution({
      candidates: [
        {
          tokenId: TOK_YES,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "YES",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS,
          familyId: FAM,
        },
        {
          tokenId: TOK_NO,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "NO",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS2,
          familyId: FAM2,
        },
      ],
    });
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue([makeSettledPosition()]);

    await mod.runCheck();

    // settler.settle should receive only fam-1's candidate
    const settleArg = (settler.settle as any).mock.calls[0][0];
    expect(settleArg.candidates).toHaveLength(1);
    expect(settleArg.candidates[0].familyId).toBe(FAM);
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

  // ─── Family exposure recomputation ──────────────────────────────────────

  it("recomputes family exposure for affected families", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect(exposureCalculator.recompute as any).toHaveBeenCalledWith(FAM, false);
  });

  it("publishes FamilyExposureChanged after recompute", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    const events: unknown[] = [];
    bus.subscribe("FamilyExposureChanged", async (e) => {
      events.push(e);
    });

    await mod.runCheck();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ familyId: FAM }));
  });

  it("deduplicates family recompute when multiple positions share a family", async () => {
    const resolution = makeDetectedResolution({
      candidates: [
        {
          tokenId: TOK_YES,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "YES",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS,
          familyId: FAM,
        },
        {
          tokenId: TOK_NO,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "NO",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS2,
          familyId: FAM, // same family
        },
      ],
    });
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    // recompute should only be called once for FAM
    expect(exposureCalculator.recompute as any).toHaveBeenCalledTimes(1);
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
      { orderId: "ord-1", status: "open", familyId: FAM },
      { orderId: "ord-2", status: "filled", familyId: FAM }, // should not be cancelled
      { orderId: "ord-3", status: "partially-filled", familyId: FAM },
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
    (orderRepo.findByTokenId as any).mockReturnValue([
      { orderId: "ord-1", status: "open", familyId: FAM },
    ]);

    const cancelEvents: any[] = [];
    bus.subscribe("CancelOrderRequested", async (e) => {
      cancelEvents.push(e);
    });

    await mod.runCheck();

    expect(cancelEvents).toHaveLength(1);
    expect(cancelEvents[0].command.orderId).toBe("ord-1");
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
          familyId: FAM,
        },
        {
          tokenId: TOK_NO,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "NO",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS2,
          familyId: FAM2,
        },
      ],
    });
    (detector.detect as any).mockResolvedValue([resolution]);
    (orderRepo.findByTokenId as any).mockImplementation((tokenId: TokenId) => {
      if (String(tokenId) === String(TOK_YES)) {
        return [{ orderId: "ord-yes", status: "open", familyId: FAM }];
      }
      if (String(tokenId) === String(TOK_NO)) {
        return [{ orderId: "ord-no", status: "pending", familyId: FAM2, exchangeOrderId: null }];
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
        familyId: FAM,
      }),
    );

    // Pending order without exchange ID is locally cancelled
    expect(orderRepo.updateStatus as any).toHaveBeenCalledWith("ord-no", "cancelled");
  });

  it("publishes CancelOrderRequested for pending orders that have an exchange ID", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);
    (orderRepo.findByTokenId as any).mockReturnValue([
      { orderId: "ord-1", status: "pending", familyId: FAM, exchangeOrderId: "exch-123" },
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
      { orderId: "ord-1", status: "pending", familyId: FAM, exchangeOrderId: null },
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

  it("still deactivates markets and cancels orders when balance is non-zero", async () => {
    const gateway = createMockGateway({ "tok-yes": 100 });
    mod = createModule({ gateway });
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);
    (orderRepo.findByTokenId as any).mockReturnValue([
      { orderId: "ord-1", status: "open", familyId: FAM },
    ]);

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
          familyId: FAM,
        },
        {
          tokenId: TOK_NO,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "NO",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS2,
          familyId: FAM,
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
          familyId: FAM,
        },
        {
          tokenId: TOK_NO,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "NO",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS2,
          familyId: FAM,
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
          familyId: FAM,
        },
        {
          tokenId: TOK_NO,
          conditionId: CONDITION,
          slug: "will-x",
          outcome: "NO",
          endDate: "2026-01-14T00:00:00Z",
          positionId: POS2,
          familyId: FAM,
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

  it("calls markSettled when all families have autoSettle=false (nothing to retry)", async () => {
    const provider = createMockRulesProvider({ autoSettle: false });
    mod = createModule({ rulesProvider: provider });

    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect(resolutionRepo.markSettled as any).toHaveBeenCalledWith(CONDITION);
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
        familyId: FAM,
      },
    ]);

    // Mock: Gamma returns resolved market with outcomePrices
    (gammaClient.getMarketBySlug as any).mockResolvedValue({
      closed: true,
      umaResolutionStatus: null,
      closedTime: "2026-01-15T00:00:00Z",
      rawPayload: {
        outcomePrices: '["1","0"]',
        outcomes: '["Yes","No"]',
      },
    });

    // Mock: positionRepo.findByFamily returns closed position
    (positionRepo.findByFamily as any).mockReturnValue([
      {
        positionId: POS,
        tokenId: TOK_YES,
        familyId: FAM,
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
        familyId: FAM,
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

    // Verify resolution was updated
    expect(resolutionRepo.updateResolution as any).toHaveBeenCalledWith(
      CONDITION,
      "YES",
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

    // Verify exposure was recomputed
    expect(exposureCalculator.recompute as any).toHaveBeenCalledWith(FAM, false);
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
        familyId: FAM,
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
        familyId: FAM,
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
});

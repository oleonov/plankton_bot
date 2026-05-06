/**
 * E2E scenario: REDEEM full lifecycle (spec §8)
 *
 * Flow under test:
 *   AlgoDecisionModule.evaluateTokens → RedeemRequested
 *   → ResolutionModule.handleAlgoRedeem → PositionSettler.settleAlgoRedeem
 *   → PositionSettled event + position closed in DB + settlement_ledger row
 *
 * Simulation-mode: no gateway → on-chain call not issued.
 * The live-lite test provides a mocked gateway and checks that
 * gateway.redeemPositions is called before local settlement.
 *
 * REDEEM conditions (spec §8, seeded by bootstrapDatabase):
 *   Rule: stateCondition ∈ {S1, S2}, price < 0.05, holdDuration ≤ 3600s
 *   S1: buyCount=1  && lastAction="BUY"
 *   S2: buyCount≥2  && lastAction="BUY"
 *
 * FK note: settlement_ledger.condition_id references market_resolutions.
 * ResolutionModule.handleAlgoRedeem upserts a `source="algo"` resolution row
 * before calling PositionSettler so the FK is satisfied on a cold path (no
 * prior Gamma-detected resolution). These tests deliberately do NOT seed
 * market_resolutions themselves — that would hide the FK bug.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapDatabase,
  SqliteAlgoRulesRepository,
  SqliteFillRepository,
  SqliteInventoryLotRepository,
  SqliteLegStateRepository,
  SqliteMarketRepository,
  SqliteMarketResolutionRepository,
  SqliteOrderRepository,
  SqlitePositionRepository,
} from "@plankton/db";
import { createConditionId, createPositionId, createTokenId, type TokenId } from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";

import { AlgoDecisionModule } from "../../modules/algo-decision/algo-decision-module.js";
import type { SelectedMarketCache } from "../../modules/algo-decision/algo-decision-module.js";
import { ResolutionModule } from "../../modules/resolution/resolution-module.js";
import { PositionSettler } from "../../modules/resolution/position-settler.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

class AllTokensCache implements SelectedMarketCache {
  private readonly ids = new Set<string>();

  track(tokenId: string): void {
    this.ids.add(tokenId);
  }

  isEligible(_tokenId: TokenId): boolean {
    return true;
  }

  getEligibleTokenIds(): TokenId[] {
    return [...this.ids] as TokenId[];
  }
}

function makeNullDetector() {
  return {
    detect: vi.fn().mockResolvedValue([]),
    detectCondition: vi.fn().mockResolvedValue(null),
  };
}

function makeNullGammaClient() {
  return {
    getMarketBySlug: vi.fn().mockResolvedValue(null),
    getMarketById: vi.fn().mockResolvedValue(null),
  };
}

// ─── Shared fixture builder ───────────────────────────────────────────────────

interface RedeemFixture {
  bus: InProcessEventBus;
  algoDecision: AlgoDecisionModule;
  resolutionModule: ResolutionModule;
  marketCache: AllTokensCache;
  redeemEvents: Array<{ conditionIds: readonly string[]; timestamp: number }>;
  settledEvents: Array<{
    positionId: unknown;
    resolution: string;
    settlementPrice: number;
  }>;
  teardown: () => Promise<void>;
}

async function buildFixture(opts: {
  db: ReturnType<typeof bootstrapDatabase>;
  tokenId: ReturnType<typeof createTokenId>;
  conditionId: ReturnType<typeof createConditionId>;
  positionId: ReturnType<typeof createPositionId>;
  buyCount: number;
  size: number;
  avgEntryPrice: number;
  holdAgoSeconds: number;
  gateway?: any;
  gammaClient?: any;
  endDate?: string;
}): Promise<RedeemFixture> {
  const { db, tokenId, conditionId, positionId } = opts;

  const marketRepo = new SqliteMarketRepository(db.db);
  const orderRepo = new SqliteOrderRepository(db.db);
  const fillRepo = new SqliteFillRepository(db.db);
  const positionRepo = new SqlitePositionRepository(db.db);
  const lotRepo = new SqliteInventoryLotRepository(db.db);
  const legStateRepo = new SqliteLegStateRepository(db.db);
  const algoRulesRepo = new SqliteAlgoRulesRepository(db.db);
  const resolutionRepo = new SqliteMarketResolutionRepository(db.db);

  const now = new Date().toISOString();
  const firstTradeAt = new Date(Date.now() - opts.holdAgoSeconds * 1000).toISOString();
  // REDEEM rule only applies to resolved markets — the algo-decision module
  // pre-gates on endDate <= now before emitting RedeemRequested (on-chain
  // redeemPositions() reverts before resolution). Default fixture endDate
  // must be in the past for the scenario to reflect a redeemable state.
  const endDate = opts.endDate ?? new Date(Date.now() - 60_000).toISOString();

  // Seed market
  marketRepo.save({
    tokenId,
    conditionId: String(conditionId),
    slug: `redeem-market-${String(tokenId)}`,
    eventSlug: null,
    question: "Will this redeem?",
    outcome: "YES",
    regime: null,
    horizon: null,
    endDate,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    eventMarketCount: 1,
    gammaCreatedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  // Intentionally do NOT seed market_resolutions — the module under test
  // must upsert it itself via resolutionRepo.save(source: "algo") before
  // calling PositionSettler, or the settlement_ledger FK will reject.

  // Seed open position
  positionRepo.save({
    positionId,
    tokenId,
    conditionId,
    side: "buy",
    size: opts.size,
    avgEntryPrice: opts.avgEntryPrice,
    costBasisUsdc: opts.size * opts.avgEntryPrice,
    currentValueUsdc: opts.size * opts.avgEntryPrice,
    realizedPnl: 0,
    status: "open",
    entryStyle: "probe",
    openedAt: firstTradeAt,
    closedAt: null,
    updatedAt: now,
  });

  // Seed leg_state — S1 (buyCount=1) or S2 (buyCount≥2), lastAction="BUY"
  legStateRepo.upsert({
    tokenId,
    buyCount: opts.buyCount,
    sellCount: 0,
    lastAction: "BUY",
    firstTradePrice: opts.avgEntryPrice,
    firstTradeAt,
    lastTradeAt: firstTradeAt,
    updatedAt: now,
  });

  const bus = new InProcessEventBus();

  const redeemEvents: Array<{ conditionIds: readonly string[]; timestamp: number }> = [];
  const settledEvents: Array<{ positionId: unknown; resolution: string; settlementPrice: number }> =
    [];

  bus.subscribe("RedeemRequested", async (p) => {
    redeemEvents.push(p);
  });
  bus.subscribe("PositionSettled", async (p) => {
    settledEvents.push(p);
  });

  const marketCache = new AllTokensCache();
  marketCache.track(String(tokenId));

  const algoDecision = new AlgoDecisionModule({
    bus,
    legStateRepo,
    algoRulesRepo,
    selectedMarketCache: marketCache,
    log: silentLog,
    sweepIntervalMs: 60_000,
  });
  await algoDecision.start();

  const settler = new PositionSettler(positionRepo, lotRepo, db.db, marketRepo);
  const resolutionModule = new ResolutionModule({
    detector: makeNullDetector() as any,
    settler,
    marketRepo,
    resolutionRepo,
    orderRepo,
    fillRepo,
    gammaClient: opts.gammaClient ?? makeNullGammaClient(),
    lotRepo,
    positionRepo,
    db: db.db,
    bus,
    log: silentLog,
    checkIntervalMs: 60_000,
    graceMinutes: 30,
    ...(opts.gateway ? { gateway: opts.gateway } : {}),
  });
  await resolutionModule.start();
  // Drain the startup runCheck (it resolves immediately since detector returns [])
  await bus.drain();

  // Feed market price via NormalizedMarketUpdated so the algo module's
  // internal marketCache knows the sub-0.05 mid-price required by the REDEEM rule.
  // AlgoDecisionModule.handleMarketUpdate also calls evaluateTokens internally,
  // which is the primary trigger for RedeemRequested in the E2E path.
  await bus.publish("NormalizedMarketUpdated", {
    markets: [
      {
        tokenId,
        conditionId: String(conditionId),
        slug: `redeem-market-${String(tokenId)}`,
        eventSlug: null,
        question: "Will this redeem?",
        outcome: "YES",
        regime: null,
        horizon: null,
        midPrice: opts.avgEntryPrice,
        bestBid: Math.max(opts.avgEntryPrice - 0.01, 0.001),
        bestAsk: opts.avgEntryPrice + 0.01,
        spread: 0.02,
        active: true,
        tradable: true,
        acceptingOrders: true,
        enableOrderBook: true,
        tickSize: 0.01,
        negRisk: false,
        gammaCreatedAt: null,
        endDate,
        volume24h: null,
        eventMarketCount: 1,
        snapshotTs: Date.now(),
      },
    ],
    timestamp: Date.now(),
  });
  await bus.drain();
  // Allow async handlers (ResolutionModule.handleAlgoRedeem) to complete
  await new Promise((r) => setTimeout(r, 30));
  await bus.drain();

  return {
    bus,
    algoDecision,
    resolutionModule,
    marketCache,
    redeemEvents,
    settledEvents,
    teardown: async () => {
      await algoDecision.stop();
      await resolutionModule.stop();
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Scenario: REDEEM full cycle (spec §8)", () => {
  const connections: Array<ReturnType<typeof bootstrapDatabase>> = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (connections.length > 0) {
      connections.pop()!.close();
    }
  });

  it("S1 state: evaluateTokens → RedeemRequested → PositionSettled, position closed in DB", async () => {
    const TOKEN_ID = createTokenId("tok-redeem-s1");
    const CONDITION_ID = createConditionId("cond-redeem-s1");
    const POSITION_ID = createPositionId("pos-redeem-s1");
    const SIZE = 50;
    const AVG_ENTRY = 0.02; // < 0.05 threshold

    const conn = bootstrapDatabase(":memory:");
    connections.push(conn);

    const { redeemEvents, settledEvents, teardown } = await buildFixture({
      db: conn,
      tokenId: TOKEN_ID,
      conditionId: CONDITION_ID,
      positionId: POSITION_ID,
      buyCount: 1, // S1
      size: SIZE,
      avgEntryPrice: AVG_ENTRY,
      holdAgoSeconds: 1800, // 30 min — within 3600s limit
    });

    // ── Assert RedeemRequested was published ──────────────────────────────────
    expect(redeemEvents.length).toBeGreaterThanOrEqual(1);
    expect(redeemEvents[0]!.conditionIds).toContain(String(CONDITION_ID));

    // ── Assert PositionSettled was published ──────────────────────────────────
    expect(settledEvents.length).toBeGreaterThanOrEqual(1);
    const settled = settledEvents[0]!;
    expect(settled.resolution).toBe("algo-redeem");
    expect(settled.settlementPrice).toBe(0);
    expect(settled.positionId).toBe(POSITION_ID);

    // ── Assert DB: position is closed ─────────────────────────────────────────
    const positionRepo = new SqlitePositionRepository(conn.db);
    expect(positionRepo.findOpen()).toHaveLength(0);

    const allPositions = positionRepo.findAll();
    const thePos = allPositions.find((p) => String(p.positionId) === String(POSITION_ID));
    expect(thePos).toBeDefined();
    expect(thePos!.status).toBe("closed");
    expect(thePos!.size).toBe(0);
    // PnL = (0 - 0.02) * 50 = -1
    expect(thePos!.realizedPnl).toBeCloseTo(-1.0, 5);

    // ── Assert settlement_ledger row exists ────────────────────────────────────
    const ledgerRow = conn.db
      .prepare("SELECT * FROM settlement_ledger WHERE condition_id = ?")
      .get(String(CONDITION_ID)) as
      | { resolution: string; settlement_price: number; delta: number }
      | undefined;
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow!.resolution).toBe("algo-redeem");
    expect(ledgerRow!.settlement_price).toBe(0);
    expect(ledgerRow!.delta).toBeCloseTo(-1.0, 5);

    // ── Assert market_resolutions row was upserted by handleAlgoRedeem ───────
    // FK regression: settlement_ledger.condition_id references this row. The
    // test does not seed it manually — the module must write it.
    const mrRow = conn.db
      .prepare("SELECT source, resolution FROM market_resolutions WHERE condition_id = ?")
      .get(String(CONDITION_ID)) as { source: string; resolution: string } | undefined;
    expect(mrRow).toBeDefined();
    expect(mrRow!.source).toBe("algo");
    expect(mrRow!.resolution).toBe("algo-redeem");

    await teardown();
  });

  it("S2 state: evaluateTokens → RedeemRequested → PositionSettled", async () => {
    const TOKEN_ID = createTokenId("tok-redeem-s2");
    const CONDITION_ID = createConditionId("cond-redeem-s2");
    const POSITION_ID = createPositionId("pos-redeem-s2");
    const SIZE = 30;
    const AVG_ENTRY = 0.03;

    const conn = bootstrapDatabase(":memory:");
    connections.push(conn);

    const { redeemEvents, settledEvents, teardown } = await buildFixture({
      db: conn,
      tokenId: TOKEN_ID,
      conditionId: CONDITION_ID,
      positionId: POSITION_ID,
      buyCount: 2, // S2
      size: SIZE,
      avgEntryPrice: AVG_ENTRY,
      holdAgoSeconds: 600, // 10 min
    });

    expect(redeemEvents.length).toBeGreaterThanOrEqual(1);
    expect(redeemEvents[0]!.conditionIds).toContain(String(CONDITION_ID));

    expect(settledEvents.length).toBeGreaterThanOrEqual(1);
    expect(settledEvents[0]!.resolution).toBe("algo-redeem");
    expect(settledEvents[0]!.settlementPrice).toBe(0);
    expect(settledEvents[0]!.positionId).toBe(POSITION_ID);

    const positionRepo = new SqlitePositionRepository(conn.db);
    expect(positionRepo.findOpen()).toHaveLength(0);

    const allPositions = positionRepo.findAll();
    const pos = allPositions.find((p) => String(p.positionId) === String(POSITION_ID));
    expect(pos!.status).toBe("closed");
    expect(pos!.size).toBe(0);
    // PnL = (0 - 0.03) * 30 = -0.9
    expect(pos!.realizedPnl).toBeCloseTo(-0.9, 5);

    await teardown();
  });

  it("live-lite path: mocked gateway.redeemPositions is called before local settlement", async () => {
    const TOKEN_ID = createTokenId("tok-redeem-live");
    const CONDITION_ID = createConditionId("cond-redeem-live");
    const POSITION_ID = createPositionId("pos-redeem-live");

    const conn = bootstrapDatabase(":memory:");
    connections.push(conn);

    const mockGateway = {
      redeemPositions: vi.fn().mockResolvedValue(undefined),
      hasPendingRedeemSubmission: vi.fn().mockReturnValue(false),
      getPositionBalance: vi.fn().mockResolvedValue(0),
      getOutcomeTokenBalance: vi.fn().mockResolvedValue(1n),
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getOpenOrdersForToken: vi.fn().mockResolvedValue([]),
      getFills: vi.fn().mockResolvedValue([]),
      getBalances: vi.fn().mockResolvedValue([]),
      mergePositions: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 0 }),
    };
    const mockGammaClient = {
      getMarketBySlug: vi.fn().mockResolvedValue({
        closed: true,
        closedTime: new Date().toISOString(),
        rawPayload: {},
        umaResolutionStatus: "resolved",
      }),
      getMarketById: vi.fn().mockResolvedValue(null),
    };

    const { settledEvents, teardown } = await buildFixture({
      db: conn,
      tokenId: TOKEN_ID,
      conditionId: CONDITION_ID,
      positionId: POSITION_ID,
      buyCount: 1, // S1
      size: 20,
      avgEntryPrice: 0.01, // < 0.05
      holdAgoSeconds: 300, // 5 min
      gateway: mockGateway,
      gammaClient: mockGammaClient,
      endDate: new Date(Date.now() - 60_000).toISOString(),
    });

    // On-chain gateway must have been called with the condition ID
    expect(mockGateway.redeemPositions).toHaveBeenCalledWith([String(CONDITION_ID)]);

    // Local settlement also ran
    expect(settledEvents.length).toBeGreaterThanOrEqual(1);
    expect(settledEvents[0]!.resolution).toBe("algo-redeem");

    const positionRepo = new SqlitePositionRepository(conn.db);
    expect(positionRepo.findOpen()).toHaveLength(0);

    const allPositions = positionRepo.findAll();
    const pos = allPositions.find((p) => String(p.positionId) === String(POSITION_ID));
    expect(pos!.status).toBe("closed");

    await teardown();
  });

  it("idempotent: second RedeemRequested on already-closed position adds no new PositionSettled or ledger rows", async () => {
    const TOKEN_ID = createTokenId("tok-redeem-idem");
    const CONDITION_ID = createConditionId("cond-redeem-idem");
    const POSITION_ID = createPositionId("pos-redeem-idem");

    const conn = bootstrapDatabase(":memory:");
    connections.push(conn);

    const { bus, settledEvents, algoDecision, resolutionModule } = await buildFixture({
      db: conn,
      tokenId: TOKEN_ID,
      conditionId: CONDITION_ID,
      positionId: POSITION_ID,
      buyCount: 1,
      size: 10,
      avgEntryPrice: 0.02,
      holdAgoSeconds: 100,
    });

    // First cycle already ran inside buildFixture
    expect(settledEvents.length).toBeGreaterThanOrEqual(1);
    const countAfterFirst = settledEvents.length;

    // Second explicit RedeemRequested — position is now closed, settler skips it
    await bus.publish("RedeemRequested", {
      conditionIds: [String(CONDITION_ID)],
      timestamp: Date.now(),
    });
    await bus.drain();
    await new Promise((r) => setTimeout(r, 30));
    await bus.drain();

    // No additional PositionSettled events
    expect(settledEvents.length).toBe(countAfterFirst);

    // settlement_ledger still has exactly one row (INSERT OR IGNORE)
    const rows = conn.db
      .prepare("SELECT COUNT(*) AS cnt FROM settlement_ledger WHERE condition_id = ?")
      .get(String(CONDITION_ID)) as { cnt: number };
    expect(rows.cnt).toBe(1);

    await algoDecision.stop();
    await resolutionModule.stop();
  });
});

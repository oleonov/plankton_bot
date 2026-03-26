import { describe, it, expect, vi } from "vitest";
import { bootstrapDatabase } from "@plankton/db";
import {
  SqlitePositionRepository,
  SqliteInventoryLotRepository,
  SqliteFamilyStateRepository,
} from "@plankton/db";
import { createFamilyId, createTokenId } from "@plankton/domain";
import type { FamilyRulesProvider, FamilyRuleBundle, FamilyRules, Regime } from "@plankton/domain";
import { FamilyExposureCalculator } from "../modules/risk-inventory/family-exposure.js";

// ─── Helpers ──────────────────────────────────────────────────────────

const FAM_ID = createFamilyId("fam-test");
const TOK_ID = createTokenId("tok-1");

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

function makeTailRules(overrides?: Record<string, unknown>) {
  return {
    maxOpenValueUsdc: 100,
    maxActiveMarkets: 5,
    maxDustPositions: 3,
    tailQuarantineThresholdUsdc: 50,
    tailQuarantineThresholdRatio: 0.5,
    staleTailPruneEnabled: false,
    thresholdCleanupRequired: false,
    autoSettleResolvedMarkets: true,
    ...overrides,
  };
}

function makeRuleBundle(tailOverrides?: Record<string, unknown>): FamilyRuleBundle {
  return {
    identity: {
      familyId: FAM_ID,
      familyKey: "test-fam",
      primaryCategory: "crypto",
      regime: "threshold" as Regime,
      horizon: "short",
      cadence: "daily",
      strategyProfile: "scalp" as any,
      topicKey: "test",
      slugPattern: "test*",
      notes: null,
    },
    evidence: {
      familyId: FAM_ID,
      evidenceStatus: "confirmed",
      evidenceScore: 80,
      promotionState: "scaled",
      localTradeCount: 10,
      localMarketCount: 3,
      localRealizedPnlFifo: 5,
      openTailCostUsdc: 0,
      tailAdjustedPnl: 5,
      remoteClosedRealizedPnl: null,
      openPositionCount: null,
      openDustCount: null,
      bothSidedEligible: false,
      heavyCampaignEligible: false,
      activeWindowEdgeScore: null,
      lastValidatedAt: null,
    },
    rules: {
      familyId: FAM_ID,
      universe: {
        enabled: true,
        action: "trade",
        priorityRank: 1,
        allowWeekends: false,
        sessionMode: "active-window",
      },
      entry: {
        entryMode: "probe-first",
        minEntryPrice: 0.05,
        maxEntryPrice: 0.95,
        maxInitialNotionalUsdc: 10,
        allowHighPriceOneShot: false,
        highPriceThreshold: 0.85,
        requireProvenFamilyAbovePrice: 0.7,
        preferredEntryBand: null,
        maxProbeCountPerMarket: null,
        entryCooldownSeconds: null,
        maxNewMarketsPerSession: null,
        probeSizeUsdc: 5,
        addSizeUsdc: 4,
      },
      scaleIn: {
        scaleMode: "confirm-only",
        defaultMaxBuysPerLeg: 3,
        heavyMaxBuysPerLeg: 5,
        allowHeavyCampaigns: false,
        requirePositiveRecycleHistoryForScale: false,
      },
      exit: {
        exitMode: "repricing-sell",
        primaryProfitModel: "sell-into-strength",
        allowRunnerExtension: false,
        preferFastRecycle: true,
        resolutionHoldingAllowed: false,
        resolutionBufferMinutes: 60,
        targetRoiBandLow: null,
        targetRoiBandHigh: null,
        maxUnmovedHoldHours: null,
        maxTailHoldHours: null,
      },
      twoSided: {
        allowTwoSided: false,
        twoSidedMode: "disabled",
        minActivityForTwoSided: null,
      },
      tailSuppression: makeTailRules(tailOverrides),
      session: {
        activeWindowsUtc: [],
        reducedWindowsUtc: [],
        weekdayBias: "normal",
        weekendMode: "normal",
      },
    } as FamilyRules,
  };
}

function createMockRulesProvider(
  bundle: FamilyRuleBundle | null = makeRuleBundle(),
): FamilyRulesProvider {
  return {
    getRule: vi.fn().mockReturnValue(bundle),
    isEnabled: vi.fn().mockReturnValue(bundle !== null),
    getAllFamilies: vi.fn().mockReturnValue(bundle ? [bundle.identity] : []),
    getRulesForRegime: vi.fn().mockReturnValue([]),
  };
}

function seedFamily(db: import("better-sqlite3").Database) {
  db.exec(`
    INSERT OR IGNORE INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
    VALUES ('${String(FAM_ID)}', 'test-fam', 'crypto', 'threshold', 'short', 'daily', 'scalp');

    INSERT OR REPLACE INTO family_runtime_state (family_id, runtime_mode, open_value_usdc, open_position_count, open_dust_count,
      active_market_count, current_tail_cost_usdc, tail_adjusted_pnl_live, updated_at)
    VALUES ('${String(FAM_ID)}', 'active', 0, 0, 0, 0, 0, 0, '${new Date().toISOString()}');
  `);
}

function seedPosition(
  db: import("better-sqlite3").Database,
  opts: {
    positionId: string;
    tokenId: string;
    realizedPnl: number;
    status?: string;
    costBasisUsdc?: number;
  },
) {
  const status = opts.status ?? "open";
  const cost = opts.costBasisUsdc ?? 5;
  db.exec(`
    INSERT OR REPLACE INTO positions (position_id, token_id, family_id, side, size, avg_entry_price, cost_basis_usdc,
      current_value_usdc, realized_pnl, status, opened_at, updated_at)
    VALUES ('${opts.positionId}', '${opts.tokenId}', '${String(FAM_ID)}', 'buy', 100, 0.05, ${cost},
      ${cost}, ${opts.realizedPnl}, '${status}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  `);
}

let seedCounter = 0;

function seedLot(
  db: import("better-sqlite3").Database,
  opts: {
    lotId: string;
    positionId: string;
    tokenId: string;
    remainingSize: number;
    entryPrice: number;
  },
) {
  // Seed the order + fill chain required by FK constraints
  const n = ++seedCounter;
  const orderId = `ord-seed-${n}`;
  const fillId = `fill-seed-${n}`;
  db.exec(`
    INSERT OR IGNORE INTO orders (order_id, client_order_id, token_id, family_id, side, order_type, price, size, size_usdc, status, bot_run_id, created_at, updated_at)
    VALUES ('${orderId}', 'plk_seed_${n}', '${opts.tokenId}', '${String(FAM_ID)}', 'buy', 'GTC', ${opts.entryPrice}, ${opts.remainingSize}, ${opts.remainingSize * opts.entryPrice}, 'filled', 'run-seed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

    INSERT OR IGNORE INTO fills (fill_id, order_id, token_id, family_id, side, price, size, size_usdc, fee, filled_at, reconciled)
    VALUES ('${fillId}', '${orderId}', '${opts.tokenId}', '${String(FAM_ID)}', 'buy', ${opts.entryPrice}, ${opts.remainingSize}, ${opts.remainingSize * opts.entryPrice}, 0, '2026-01-01T00:00:00Z', 0);

    INSERT OR REPLACE INTO inventory_lots (lot_id, position_id, token_id, family_id, side, size, remaining_size,
      entry_price, cost_usdc, fill_id, created_at)
    VALUES ('${opts.lotId}', '${opts.positionId}', '${opts.tokenId}', '${String(FAM_ID)}', 'buy',
      ${opts.remainingSize}, ${opts.remainingSize}, ${opts.entryPrice}, ${opts.remainingSize * opts.entryPrice},
      '${fillId}', '2026-01-01T00:00:00Z');
  `);
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("FamilyExposureCalculator effective mode", () => {
  it("sets effectiveMode to active when tail health is good", () => {
    const conn = bootstrapDatabase(":memory:");
    seedFamily(conn.db);
    seedPosition(conn.db, { positionId: "pos-1", tokenId: String(TOK_ID), realizedPnl: 10 });
    seedLot(conn.db, {
      lotId: "lot-1",
      positionId: "pos-1",
      tokenId: String(TOK_ID),
      remainingSize: 10,
      entryPrice: 0.05,
    });

    const posRepo = new SqlitePositionRepository(conn.db);
    const lotRepo = new SqliteInventoryLotRepository(conn.db);
    const stateRepo = new SqliteFamilyStateRepository(conn.db);
    const rulesProvider = createMockRulesProvider();

    const calc = new FamilyExposureCalculator(
      stateRepo,
      posRepo,
      lotRepo,
      silentLog,
      rulesProvider,
    );
    const result = calc.recompute(FAM_ID, true);

    expect(result.effectiveMode).toBe("active");
    expect(result.derivedModeReason).toBeNull();
    conn.close();
  });

  it("sets effectiveMode to probe-only when tailAdjustedPnlLive < 0", () => {
    const conn = bootstrapDatabase(":memory:");
    seedFamily(conn.db);
    // realizedPnl = -5, tailCost = 10 => tailAdjustedPnl = -5 - 10 = -15
    seedPosition(conn.db, { positionId: "pos-1", tokenId: String(TOK_ID), realizedPnl: -5 });
    seedLot(conn.db, {
      lotId: "lot-1",
      positionId: "pos-1",
      tokenId: String(TOK_ID),
      remainingSize: 100,
      entryPrice: 0.1,
    });

    const posRepo = new SqlitePositionRepository(conn.db);
    const lotRepo = new SqliteInventoryLotRepository(conn.db);
    const stateRepo = new SqliteFamilyStateRepository(conn.db);
    const rulesProvider = createMockRulesProvider();

    const calc = new FamilyExposureCalculator(
      stateRepo,
      posRepo,
      lotRepo,
      silentLog,
      rulesProvider,
    );
    const result = calc.recompute(FAM_ID, true);

    expect(result.tailAdjustedPnlLive).toBeLessThan(0);
    expect(result.effectiveMode).toBe("probe-only");
    expect(result.derivedModeReason).toContain("tailAdjustedPnl");
    conn.close();
  });

  it("sets effectiveMode to reduce-only when tail cost exceeds threshold", () => {
    const conn = bootstrapDatabase(":memory:");
    seedFamily(conn.db);
    seedPosition(conn.db, { positionId: "pos-1", tokenId: String(TOK_ID), realizedPnl: 100 });
    // tailCost = 1000 * 0.1 = 100 > threshold 50
    seedLot(conn.db, {
      lotId: "lot-1",
      positionId: "pos-1",
      tokenId: String(TOK_ID),
      remainingSize: 1000,
      entryPrice: 0.1,
    });

    const posRepo = new SqlitePositionRepository(conn.db);
    const lotRepo = new SqliteInventoryLotRepository(conn.db);
    const stateRepo = new SqliteFamilyStateRepository(conn.db);
    const rulesProvider = createMockRulesProvider();

    const calc = new FamilyExposureCalculator(
      stateRepo,
      posRepo,
      lotRepo,
      silentLog,
      rulesProvider,
    );
    const result = calc.recompute(FAM_ID, true);

    expect(result.currentTailCostUsdc).toBeGreaterThan(50);
    expect(result.effectiveMode).toBe("reduce-only");
    expect(result.derivedModeReason).toContain("tail cost");
    conn.close();
  });

  it("sets effectiveMode to reduce-only when tail/pnl ratio exceeds threshold", () => {
    const conn = bootstrapDatabase(":memory:");
    seedFamily(conn.db);
    // realizedPnl = 10, tailCost = 100 * 0.08 = 8, ratio = 8/10 = 0.8 > 0.5 threshold
    seedPosition(conn.db, { positionId: "pos-1", tokenId: String(TOK_ID), realizedPnl: 10 });
    seedLot(conn.db, {
      lotId: "lot-1",
      positionId: "pos-1",
      tokenId: String(TOK_ID),
      remainingSize: 100,
      entryPrice: 0.08,
    });

    const posRepo = new SqlitePositionRepository(conn.db);
    const lotRepo = new SqliteInventoryLotRepository(conn.db);
    const stateRepo = new SqliteFamilyStateRepository(conn.db);
    const rulesProvider = createMockRulesProvider();

    const calc = new FamilyExposureCalculator(
      stateRepo,
      posRepo,
      lotRepo,
      silentLog,
      rulesProvider,
    );
    const result = calc.recompute(FAM_ID, true);

    expect(result.effectiveMode).toBe("reduce-only");
    expect(result.derivedModeReason).toContain("ratio");
    conn.close();
  });

  it("returns null effectiveMode when rulesProvider not available", () => {
    const conn = bootstrapDatabase(":memory:");
    seedFamily(conn.db);
    seedPosition(conn.db, { positionId: "pos-1", tokenId: String(TOK_ID), realizedPnl: 0 });
    seedLot(conn.db, {
      lotId: "lot-1",
      positionId: "pos-1",
      tokenId: String(TOK_ID),
      remainingSize: 10,
      entryPrice: 0.05,
    });

    const posRepo = new SqlitePositionRepository(conn.db);
    const lotRepo = new SqliteInventoryLotRepository(conn.db);
    const stateRepo = new SqliteFamilyStateRepository(conn.db);

    const calc = new FamilyExposureCalculator(stateRepo, posRepo, lotRepo, silentLog);
    const result = calc.recompute(FAM_ID, true);

    // effectiveMode retains whatever was in the existing state (null by default)
    expect(result.effectiveMode).toBeNull();
    conn.close();
  });
});

import { describe, it, expect, vi } from "vitest";
import { bootstrapDatabase } from "@plankton/db";
import {
  SqlitePositionRepository,
  SqliteInventoryLotRepository,
  SqliteFamilyStateRepository,
} from "@plankton/db";
import { createFamilyId, createTokenId } from "@plankton/domain";
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


function seedFamily(db: import("better-sqlite3").Database) {
  db.exec(`
    INSERT OR IGNORE INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
    VALUES ('${String(FAM_ID)}', 'test-fam', 'crypto', 'threshold', 'short', 'daily', 'scalp');

    INSERT OR REPLACE INTO family_runtime_state (family_id, open_value_usdc, open_position_count, open_dust_count,
      active_market_count, current_tail_cost_usdc, tail_adjusted_pnl_live, updated_at)
    VALUES ('${String(FAM_ID)}', 0, 0, 0, 0, 0, 0, '${new Date().toISOString()}');
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

describe("FamilyExposureCalculator", () => {
  it("computes openValue, counts, tail cost, and tailAdjustedPnlLive correctly", () => {
    const conn = bootstrapDatabase(":memory:");
    seedFamily(conn.db);
    seedPosition(conn.db, {
      positionId: "pos-1",
      tokenId: String(TOK_ID),
      realizedPnl: 10,
      costBasisUsdc: 8,
    });
    seedLot(conn.db, {
      lotId: "lot-1",
      positionId: "pos-1",
      tokenId: String(TOK_ID),
      remainingSize: 10,
      entryPrice: 0.3,
    });

    const posRepo = new SqlitePositionRepository(conn.db);
    const lotRepo = new SqliteInventoryLotRepository(conn.db);
    const stateRepo = new SqliteFamilyStateRepository(conn.db);

    const calc = new FamilyExposureCalculator(stateRepo, posRepo, lotRepo, silentLog);
    const result = calc.recompute(FAM_ID, true);

    expect(result.openPositionCount).toBe(1);
    expect(result.openValueUsdc).toBe(8);
    expect(result.currentTailCostUsdc).toBeCloseTo(3, 2);
    expect(result.tailAdjustedPnlLive).toBeCloseTo(7, 2);
    conn.close();
  });
});

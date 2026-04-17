import { describe, it, expect } from "vitest";
import { bootstrapDatabase } from "@plankton/db";
import { ScoreComputer } from "../modules/evidence/score-computer.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

const FAMILY_ID = "fam-test";

function freshDb() {
  const conn = bootstrapDatabase(":memory:");
  return conn;
}

function seedFamily(db: import("better-sqlite3").Database) {
  db.exec(`
    INSERT INTO family_catalog
      (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, created_at)
    VALUES ('${FAMILY_ID}', 'test-fam', 'crypto', 'threshold', 'short', 'daily', 'scalp', '2026-01-01T00:00:00Z');

    INSERT INTO family_runtime_state
      (family_id, open_value_usdc, open_position_count, open_dust_count,
       active_market_count, current_tail_cost_usdc, tail_adjusted_pnl_live, updated_at)
    VALUES ('${FAMILY_ID}', 10, 2, 1, 3, 5.0, 12.5, '2026-03-20T00:00:00Z');
  `);
}

let seedCounter = 0;

function seedFillChain(
  db: import("better-sqlite3").Database,
  opts: {
    tokenId?: string;
    side?: string;
    signalReason?: string;
  } = {},
) {
  const n = ++seedCounter;
  const orderId = `ord-${n}`;
  const fillId = `fill-${n}`;
  const tokenId = opts.tokenId ?? `tok-${n}`;
  const side = opts.side ?? "buy";
  const signalReason = opts.signalReason ?? null;

  db.exec(`
    INSERT INTO orders
      (order_id, client_order_id, token_id, family_id, side, order_type, price, size, size_usdc,
       status, bot_run_id, signal_reason, created_at, updated_at)
    VALUES ('${orderId}', 'plk_${n}', '${tokenId}', '${FAMILY_ID}', '${side}', 'GTC',
      0.10, 50, 5.0, 'filled', 'run-1', ${signalReason ? `'${signalReason}'` : "NULL"},
      '2026-01-15T00:00:00Z', '2026-01-15T00:00:00Z');

    INSERT INTO fills
      (fill_id, order_id, token_id, family_id, side, price, size, size_usdc, fee, filled_at)
    VALUES ('${fillId}', '${orderId}', '${tokenId}', '${FAMILY_ID}', '${side}',
      0.10, 50, 5.0, 0, '2026-01-15T00:00:00Z');
  `);

  return { orderId, fillId, tokenId };
}

function seedPosition(
  db: import("better-sqlite3").Database,
  positionId: string,
  opts: {
    tokenId?: string;
    status?: string;
    realizedPnl?: number;
    updatedAt?: string;
  } = {},
) {
  const tokenId = opts.tokenId ?? `tok-${positionId}`;
  const status = opts.status ?? "open";
  const realizedPnl = opts.realizedPnl ?? 0;
  const updatedAt = opts.updatedAt ?? "2026-03-20T00:00:00Z";

  db.exec(`
    INSERT INTO positions
      (position_id, token_id, family_id, side, size, avg_entry_price, cost_basis_usdc,
       realized_pnl, status, opened_at, updated_at)
    VALUES ('${positionId}', '${tokenId}', '${FAMILY_ID}', 'buy', 100, 0.10, 10.0,
      ${realizedPnl}, '${status}', '2026-01-01T00:00:00Z', '${updatedAt}');
  `);
}

function seedPnlLedger(
  db: import("better-sqlite3").Database,
  fillId: string,
  positionId: string,
  delta: number,
) {
  db.exec(`
    INSERT INTO pnl_ledger (fill_id, position_id, family_id, delta, filled_at)
    VALUES ('${fillId}', '${positionId}', '${FAMILY_ID}', ${delta}, '2026-02-01T00:00:00Z');
  `);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ScoreComputer", () => {
  describe("computeRecycleMetrics", () => {
    it("returns zeroes for family with no activity", () => {
      const conn = freshDb();
      seedFamily(conn.db);
      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeRecycleMetrics(FAMILY_ID);

      expect(m.tradeCount).toBe(0);
      expect(m.distinctMarkets).toBe(0);
      expect(m.tailAdjustedPnl).toBe(12.5); // from runtime state
      expect(m.repricingExits).toBe(0);
      expect(m.totalNonSettlementClosed).toBe(0);
      conn.close();
    });

    it("counts fills and distinct tokens", () => {
      const conn = freshDb();
      seedFamily(conn.db);
      seedFillChain(conn.db, { tokenId: "tok-A" });
      seedFillChain(conn.db, { tokenId: "tok-A" });
      seedFillChain(conn.db, { tokenId: "tok-B" });

      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeRecycleMetrics(FAMILY_ID);

      expect(m.tradeCount).toBe(3);
      expect(m.distinctMarkets).toBe(2);
      conn.close();
    });

    it("counts repricing exits with positive PnL", () => {
      const conn = freshDb();
      seedFamily(conn.db);
      const f1 = seedFillChain(conn.db, { signalReason: "repricing-exit" });
      const f2 = seedFillChain(conn.db, { signalReason: "repricing-exit" });
      const f3 = seedFillChain(conn.db, { signalReason: "repricing-exit" });
      seedPosition(conn.db, "pos-1", { status: "closed" });
      seedPosition(conn.db, "pos-2", { status: "closed" });
      seedPosition(conn.db, "pos-3", { status: "closed" });

      // pos-1: positive PnL, pos-2: negative PnL, pos-3: positive PnL
      seedPnlLedger(conn.db, f1.fillId, "pos-1", 5.0);
      seedPnlLedger(conn.db, f2.fillId, "pos-2", -3.0);
      seedPnlLedger(conn.db, f3.fillId, "pos-3", 2.0);

      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeRecycleMetrics(FAMILY_ID);

      expect(m.repricingExits).toBe(2); // pos-1 and pos-3
      conn.close();
    });

    it("counts non-settlement closed positions", () => {
      const conn = freshDb();
      seedFamily(conn.db);
      seedPosition(conn.db, "pos-1", { status: "closed" });
      seedPosition(conn.db, "pos-2", { status: "closed" });
      seedPosition(conn.db, "pos-3", { status: "closed" });

      // pos-3 was settled via resolution
      conn.db.exec(`
        INSERT INTO market_resolutions (condition_id, resolution, resolved_at, detected_at, source)
        VALUES ('cond-3', 'YES', '2026-02-01', '2026-02-01', 'api');
        INSERT INTO settlement_ledger
          (settlement_id, condition_id, position_id, token_id, family_id, resolution,
           settlement_price, size, delta, settled_at)
        VALUES ('set-3', 'cond-3', 'pos-3', 'tok-pos-3', '${FAMILY_ID}', 'YES', 1.0, 100, 10, '2026-02-01');
      `);

      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeRecycleMetrics(FAMILY_ID);

      expect(m.totalNonSettlementClosed).toBe(2);
      conn.close();
    });
  });

  describe("computeToxicityMetrics", () => {
    it("reads dust/position counts from runtime state", () => {
      const conn = freshDb();
      seedFamily(conn.db);
      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeToxicityMetrics(FAMILY_ID);

      expect(m.dustCount).toBe(1);
      expect(m.positionCount).toBe(2);
      expect(m.tailCostUsdc).toBe(5.0);
      conn.close();
    });

    it("sums realized PnL from positions", () => {
      const conn = freshDb();
      seedFamily(conn.db);
      seedPosition(conn.db, "pos-a", { realizedPnl: 10 });
      seedPosition(conn.db, "pos-b", { realizedPnl: -3, status: "closed" });

      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeToxicityMetrics(FAMILY_ID);

      expect(m.realizedPnlUsdc).toBe(7);
      conn.close();
    });

    it("counts reduce-only state transitions", () => {
      const conn = freshDb();
      seedFamily(conn.db);
      conn.db.exec(`
        INSERT INTO state_transitions (entity_type, entity_id, from_state, to_state, trigger_type, reason)
        VALUES ('family', '${FAMILY_ID}', 'active', 'reduce-only', 'system', 'tail cost');
        INSERT INTO state_transitions (entity_type, entity_id, from_state, to_state, trigger_type, reason)
        VALUES ('family', '${FAMILY_ID}', 'reduce-only', 'active', 'operator', 'recovered');
        INSERT INTO state_transitions (entity_type, entity_id, from_state, to_state, trigger_type, reason)
        VALUES ('family', '${FAMILY_ID}', 'active', 'reduce-only', 'system', 'tail cost again');
      `);

      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeToxicityMetrics(FAMILY_ID);

      expect(m.reduceOnlyCount).toBe(2);
      conn.close();
    });

    it("counts reduce-only transitions for the active profile only", () => {
      const conn = freshDb();
      seedFamily(conn.db);
      conn.db.exec(`
        INSERT INTO state_transitions (
          entity_type, entity_id, profile, from_state, to_state, trigger_type, reason
        ) VALUES
          ('family', '${FAMILY_ID}', 'live-lite', 'active', 'reduce-only', 'system', 'live demotion'),
          ('family', '${FAMILY_ID}', 'paper', 'active', 'reduce-only', 'system', 'paper demotion'),
          ('family', '${FAMILY_ID}', 'live-lite', 'active', 'reduce-only', 'system', 'live demotion again')
      `);

      const sc = new ScoreComputer(conn.db, conn.db, "live-lite");
      const m = sc.computeToxicityMetrics(FAMILY_ID);

      expect(m.reduceOnlyCount).toBe(2);
      conn.close();
    });

    it("falls back to legacy NULL-profile reduce-only transitions when scoped rows are absent", () => {
      const conn = freshDb();
      seedFamily(conn.db);
      conn.db.exec(`
        INSERT INTO state_transitions (
          entity_type, entity_id, profile, from_state, to_state, trigger_type, reason
        ) VALUES
          ('family', '${FAMILY_ID}', NULL, 'active', 'reduce-only', 'system', 'legacy demotion'),
          ('family', '${FAMILY_ID}', 'paper', 'active', 'reduce-only', 'system', 'paper demotion')
      `);

      const sc = new ScoreComputer(conn.db, conn.db, "live-lite");
      const m = sc.computeToxicityMetrics(FAMILY_ID);

      expect(m.reduceOnlyCount).toBe(1);
      conn.close();
    });

    it("computes weeks deployed from family_catalog created_at", () => {
      const conn = freshDb();
      seedFamily(conn.db);
      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeToxicityMetrics(FAMILY_ID);

      // Family created 2026-01-01, now is ~2026-03-28 => ~12 weeks
      expect(m.weeksDeployed).toBeGreaterThan(8);
      conn.close();
    });

    it("counts stale open positions based on updated_at threshold", () => {
      const conn = freshDb();
      seedFamily(conn.db);

      // Stale position (updated long ago)
      seedPosition(conn.db, "pos-stale", { updatedAt: "2026-01-01T00:00:00Z" });
      // Fresh position
      seedPosition(conn.db, "pos-fresh", { updatedAt: new Date().toISOString() });

      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeToxicityMetrics(FAMILY_ID, 48);

      expect(m.staleCount).toBe(1);
      expect(m.totalOpen).toBe(2);
      conn.close();
    });
  });
});

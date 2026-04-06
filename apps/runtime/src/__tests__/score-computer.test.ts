import { describe, it, expect } from "vitest";
import { bootstrapDatabase } from "@plankton/db";
import { ScoreComputer } from "../modules/evidence/score-computer.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

const CANDIDATE_ID = "cand-1";
const FAMILY_ID = "fam-test";

function freshDb() {
  const conn = bootstrapDatabase(":memory:");
  return conn;
}

function seedCandidate(db: import("better-sqlite3").Database) {
  db.exec(`
    INSERT INTO family_candidates
      (candidate_id, family_key, regime, horizon, cadence, primary_category, strategy_profile,
       active_market_count, cluster_volume_24h, status, first_seen_at, last_seen_at)
    VALUES
      ('${CANDIDATE_ID}', 'test-key', 'threshold', 'daily', 'daily', 'crypto', 'scalp',
       4, 30000, 'discovered', '2026-01-01', '2026-03-20');
  `);
}

function seedObservations(db: import("better-sqlite3").Database, dates: string[], marketCount = 3) {
  for (const d of dates) {
    db.exec(`
      INSERT INTO candidate_observations (candidate_id, active_market_count, cluster_volume_24h, observed_at)
      VALUES ('${CANDIDATE_ID}', ${marketCount}, 25000, '${d}');
    `);
  }
}

function seedObservationMarkets(
  db: import("better-sqlite3").Database,
  observedAt: string,
  markets: { conditionId: string; slug: string; endDate: string | null }[],
) {
  for (const m of markets) {
    db.exec(`
      INSERT INTO candidate_observation_markets
        (candidate_id, observed_at, condition_id, slug, end_date, volume_24h)
      VALUES ('${CANDIDATE_ID}', '${observedAt}', '${m.conditionId}', '${m.slug}',
        ${m.endDate ? `'${m.endDate}'` : "NULL"}, 10000);
    `);
  }
}

function seedFamily(db: import("better-sqlite3").Database) {
  db.exec(`
    INSERT INTO family_catalog
      (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, created_at)
    VALUES ('${FAMILY_ID}', 'test-fam', 'crypto', 'threshold', 'short', 'daily', 'scalp', '2026-01-01T00:00:00Z');

    INSERT INTO family_runtime_state
      (family_id, runtime_mode, open_value_usdc, open_position_count, open_dust_count,
       active_market_count, current_tail_cost_usdc, tail_adjusted_pnl_live, updated_at)
    VALUES ('${FAMILY_ID}', 'active', 10, 2, 1, 3, 5.0, 12.5, '2026-03-20T00:00:00Z');
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
  describe("computeRecurrenceMetrics", () => {
    it("returns zeroes for unknown candidate", () => {
      const conn = freshDb();
      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeRecurrenceMetrics("nonexistent");

      expect(m.spanDays).toBe(0);
      expect(m.presenceDays).toBe(0);
      expect(m.totalDays).toBe(0);
      expect(m.cadenceMean).toBe(0);
      expect(m.cadenceStddev).toBe(0);
      expect(m.distinctConditions).toBe(0);
      conn.close();
    });

    it("computes span, presence, and total days from observations", () => {
      const conn = freshDb();
      seedCandidate(conn.db);
      // 5 observations across 3 distinct dates, span = 10 days
      seedObservations(conn.db, [
        "2026-03-01T10:00:00Z",
        "2026-03-01T14:00:00Z",
        "2026-03-05T10:00:00Z",
        "2026-03-08T10:00:00Z",
        "2026-03-11T10:00:00Z",
      ]);

      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeRecurrenceMetrics(CANDIDATE_ID);

      expect(m.spanDays).toBeCloseTo(10, 0);
      // All have active_market_count=3 >= 2, so presence = total = 4 distinct dates
      expect(m.presenceDays).toBe(4);
      expect(m.totalDays).toBe(4);
      conn.close();
    });

    it("excludes observations with active_market_count < 2 from presence", () => {
      const conn = freshDb();
      seedCandidate(conn.db);
      seedObservations(conn.db, ["2026-03-01T10:00:00Z"], 3); // qualifies
      seedObservations(conn.db, ["2026-03-02T10:00:00Z"], 1); // does not qualify

      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeRecurrenceMetrics(CANDIDATE_ID);

      expect(m.totalDays).toBe(2);
      expect(m.presenceDays).toBe(1);
      conn.close();
    });

    it("computes cadence stats from inter-day gaps", () => {
      const conn = freshDb();
      seedCandidate(conn.db);
      // Days: Mar 1, Mar 3, Mar 5 → gaps: 2, 2 → mean=2, stddev=0
      seedObservations(conn.db, [
        "2026-03-01T10:00:00Z",
        "2026-03-03T10:00:00Z",
        "2026-03-05T10:00:00Z",
      ]);

      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeRecurrenceMetrics(CANDIDATE_ID);

      expect(m.cadenceMean).toBeCloseTo(2, 1);
      expect(m.cadenceStddev).toBeCloseTo(0, 1);
      conn.close();
    });

    it("counts distinct conditions from observation markets", () => {
      const conn = freshDb();
      seedCandidate(conn.db);
      seedObservations(conn.db, ["2026-03-01T10:00:00Z"]);
      seedObservationMarkets(conn.db, "2026-03-01T10:00:00Z", [
        { conditionId: "c1", slug: "s1", endDate: null },
        { conditionId: "c2", slug: "s2", endDate: null },
        { conditionId: "c3", slug: "s3", endDate: null },
      ]);

      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeRecurrenceMetrics(CANDIDATE_ID);

      expect(m.distinctConditions).toBe(3);
      conn.close();
    });
  });

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

  describe("computeLiveViabilityMetrics", () => {
    it("returns zeroes for unknown candidate", () => {
      const conn = freshDb();
      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeLiveViabilityMetrics("nonexistent", "daily");

      expect(m.activeMarketCount).toBe(0);
      expect(m.healthyEndDateFraction).toBe(0);
      expect(m.clusterVolume24h).toBe(0);
      conn.close();
    });

    it("reads market count and volume from candidate row", () => {
      const conn = freshDb();
      seedCandidate(conn.db);
      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeLiveViabilityMetrics(CANDIDATE_ID, "daily");

      expect(m.activeMarketCount).toBe(4);
      expect(m.clusterVolume24h).toBe(30000);
      conn.close();
    });

    it("computes healthy end date fraction from latest observation markets", () => {
      const conn = freshDb();
      seedCandidate(conn.db);
      const obsDate = "2026-03-20T10:00:00Z";
      seedObservations(conn.db, [obsDate]);

      // 2 markets with end dates within daily health window, 1 expired
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      seedObservationMarkets(conn.db, obsDate, [
        { conditionId: "c1", slug: "s1", endDate: tomorrow },
        { conditionId: "c2", slug: "s2", endDate: tomorrow },
        { conditionId: "c3", slug: "s3", endDate: "2025-01-01T00:00:00Z" },
      ]);

      const sc = new ScoreComputer(conn.db, conn.db);
      const m = sc.computeLiveViabilityMetrics(CANDIDATE_ID, "daily");

      // 2 of 3 are healthy
      expect(m.healthyEndDateFraction).toBeCloseTo(2 / 3, 1);
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

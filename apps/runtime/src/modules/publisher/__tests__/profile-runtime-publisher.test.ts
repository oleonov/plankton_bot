import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, type DbConnection } from "@plankton/db";
import { ProfileRuntimePublisher } from "../profile-runtime-publisher.js";

const SCHEMAS_DIR = resolve(import.meta.dirname, "../../../../../../packages/db/src/schemas");
const CONTROL_SQL = readFileSync(resolve(SCHEMAS_DIR, "control.sql"), "utf-8");
const LEDGER_SQL = readFileSync(resolve(SCHEMAS_DIR, "ledger.sql"), "utf-8");

const PROFILE = "paper";
const FAMILY_A = "fam-alpha";
const FAMILY_B = "fam-beta";

function createControlDb(): DbConnection {
  const conn = openDatabase(":memory:");
  conn.db.exec(CONTROL_SQL);
  conn.db
    .prepare("INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)")
    .run(PROFILE, "Paper");
  conn.db
    .prepare(
      "INSERT INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(FAMILY_A, "alpha", "crypto", "binary", "short", "recurring", "scalp");
  conn.db
    .prepare(
      "INSERT INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(FAMILY_B, "beta", "crypto", "binary", "short", "recurring", "scalp");
  return conn;
}

function createLedgerDb(): DbConnection {
  const conn = openDatabase(":memory:");
  conn.db.exec(LEDGER_SQL);
  return conn;
}

function seedFamilyState(
  ledger: DbConnection,
  familyId: string,
  overrides: Record<string, unknown> = {},
): void {
  const defaults = {
    open_value_usdc: 0,
    open_position_count: 0,
    open_dust_count: 0,
    active_market_count: 0,
    current_tail_cost_usdc: 0,
    tail_adjusted_pnl_live: 0,
    last_entry_ts: null,
    last_exit_ts: null,
    ...overrides,
  };
  ledger.db
    .prepare(
      `INSERT INTO family_runtime_state
        (family_id, open_value_usdc, open_position_count, open_dust_count,
         active_market_count, current_tail_cost_usdc, tail_adjusted_pnl_live,
         last_entry_ts, last_exit_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      familyId,
      defaults.open_value_usdc,
      defaults.open_position_count,
      defaults.open_dust_count,
      defaults.active_market_count,
      defaults.current_tail_cost_usdc,
      defaults.tail_adjusted_pnl_live,
      defaults.last_entry_ts,
      defaults.last_exit_ts,
    );
}

// Minimal no-op logger satisfying pino.Logger shape
const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => log,
  level: "silent",
} as unknown as import("pino").Logger;

describe("ProfileRuntimePublisher", () => {
  let controlConn: DbConnection;
  let ledgerConn: DbConnection;
  let publisher: ProfileRuntimePublisher;
  let familyIds: string[];

  beforeEach(() => {
    controlConn = createControlDb();
    ledgerConn = createLedgerDb();
    familyIds = [FAMILY_A, FAMILY_B];

    publisher = new ProfileRuntimePublisher({
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      profile: PROFILE,
      deployedFamilyIds: () => familyIds,
      getPaused: () => false,
      log,
      intervalMs: 999_999, // large so timer never fires in tests
    });
  });

  afterEach(async () => {
    await publisher.stop();
    controlConn.close();
    ledgerConn.close();
  });

  function getRollups(): Array<Record<string, unknown>> {
    return controlConn.db
      .prepare("SELECT * FROM family_profile_rollups ORDER BY family_id")
      .all() as Array<Record<string, unknown>>;
  }

  function getSummary(): Record<string, unknown> | undefined {
    return controlConn.db
      .prepare("SELECT * FROM profile_summaries WHERE profile_id = ?")
      .get(PROFILE) as Record<string, unknown> | undefined;
  }

  it("publish() writes family_profile_rollups to control DB", async () => {
    seedFamilyState(ledgerConn, FAMILY_A, {
      open_value_usdc: 25.5,
      open_position_count: 3,
      active_market_count: 2,
      current_tail_cost_usdc: 4.2,
      tail_adjusted_pnl_live: -1.3,
      last_entry_ts: "2026-03-01T12:00:00Z",
    });
    seedFamilyState(ledgerConn, FAMILY_B, {
      open_value_usdc: 10,
      open_position_count: 1,
      active_market_count: 1,
    });

    await publisher.publish();

    const rollups = getRollups();
    expect(rollups).toHaveLength(2);

    const alpha = rollups.find((r) => r.family_id === FAMILY_A)!;
    expect(alpha.profile).toBe(PROFILE);
    expect(alpha.open_value_usdc).toBe(25.5);
    expect(alpha.open_positions).toBe(3);
    expect(alpha.active_markets).toBe(2);
    expect(alpha.tail_cost_usdc).toBe(4.2);
    expect(alpha.tail_adjusted_pnl).toBe(-1.3);
    expect(alpha.last_trade_at).toBe("2026-03-01T12:00:00Z");

    const beta = rollups.find((r) => r.family_id === FAMILY_B)!;
    expect(beta.open_value_usdc).toBe(10);
    expect(beta.open_positions).toBe(1);
  });

  it("publish() writes profile_summaries to control DB", async () => {
    seedFamilyState(ledgerConn, FAMILY_A, { open_value_usdc: 20 });
    seedFamilyState(ledgerConn, FAMILY_B, { open_value_usdc: 15 });

    // Seed some open orders and positions in ledger
    ledgerConn.db
      .prepare(
        `INSERT INTO orders (order_id, client_order_id, token_id, family_id, side, order_type, price, size, size_usdc, status, bot_run_id)
         VALUES ('o1', 'co1', 't1', ?, 'buy', 'limit', 0.5, 10, 5, 'open', 'run-1')`,
      )
      .run(FAMILY_A);
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, family_id, side, status)
         VALUES ('p1', 't1', ?, 'buy', 'open')`,
      )
      .run(FAMILY_A);
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, family_id, side, status)
         VALUES ('p2', 't2', ?, 'buy', 'open')`,
      )
      .run(FAMILY_B);

    await publisher.publish();

    const summary = getSummary()!;
    expect(summary.open_orders).toBe(1);
    expect(summary.open_positions).toBe(2);
    expect(summary.total_exposure_usdc).toBe(35); // 20 + 15
  });

  it("publish() computes balance_usdc as initial - exposure + realizedPnl", async () => {
    // Seed initial balance in profile_settings
    controlConn.db
      .prepare("INSERT INTO profile_settings (profile_id, initial_balance_usdc) VALUES (?, ?)")
      .run(PROFILE, 100);

    // Seed exposure: two families with open value
    seedFamilyState(ledgerConn, FAMILY_A, { open_value_usdc: 20 });
    seedFamilyState(ledgerConn, FAMILY_B, { open_value_usdc: 15 });

    // Seed realized PnL from closed positions
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, family_id, side, status, realized_pnl)
         VALUES ('closed-1', 't1', ?, 'buy', 'closed', 5.50)`,
      )
      .run(FAMILY_A);
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, family_id, side, status, realized_pnl)
         VALUES ('closed-2', 't2', ?, 'buy', 'closed', -2.00)`,
      )
      .run(FAMILY_B);

    await publisher.publish();

    const summary = getSummary()!;
    // balance = 100 (initial) - 35 (exposure) + 3.50 (realized PnL) = 68.50
    expect(summary.balance_usdc).toBeCloseTo(68.5, 1);
  });

  it("publish() writes wallet_balance_usdc from exchangeGateway", async () => {
    const walletPublisher = new ProfileRuntimePublisher({
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      profile: PROFILE,
      deployedFamilyIds: () => familyIds,
      getPaused: () => false,
      log,
      intervalMs: 999_999,
      exchangeGateway: {
        getBalances: async () => [{ asset: "USDC", available: 487.5, locked: 0 }],
      } as any,
    });

    seedFamilyState(ledgerConn, FAMILY_A);

    await walletPublisher.publish();

    const summary = getSummary()!;
    expect(summary.wallet_balance_usdc).toBeCloseTo(487.5, 1);
  });

  it("publish() keeps last wallet_balance_usdc on exchange error", async () => {
    // First publish with working gateway
    const workingPublisher = new ProfileRuntimePublisher({
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      profile: PROFILE,
      deployedFamilyIds: () => familyIds,
      getPaused: () => false,
      log,
      intervalMs: 999_999,
      exchangeGateway: {
        getBalances: async () => [{ asset: "USDC", available: 300, locked: 0 }],
      } as any,
    });

    seedFamilyState(ledgerConn, FAMILY_A);
    await workingPublisher.publish();
    expect(getSummary()!.wallet_balance_usdc).toBeCloseTo(300, 0);

    // Second publish with failing gateway — should retain 300
    const failingPublisher = new ProfileRuntimePublisher({
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      profile: PROFILE,
      deployedFamilyIds: () => familyIds,
      getPaused: () => false,
      log,
      intervalMs: 999_999,
      exchangeGateway: {
        getBalances: async () => {
          throw new Error("network timeout");
        },
      } as any,
    });

    await failingPublisher.publish();
    expect(getSummary()!.wallet_balance_usdc).toBeCloseTo(300, 0);
  });

  it("publish() writes null wallet_balance_usdc without exchangeGateway", async () => {
    seedFamilyState(ledgerConn, FAMILY_A);
    await publisher.publish();

    const summary = getSummary()!;
    expect(summary.wallet_balance_usdc).toBeNull();
  });

  it("second publish() upserts (no duplicate rows)", async () => {
    seedFamilyState(ledgerConn, FAMILY_A, { open_value_usdc: 10 });

    await publisher.publish();
    expect(getRollups()).toHaveLength(2); // A from state, B missing = defaults

    // Update ledger state
    ledgerConn.db
      .prepare("UPDATE family_runtime_state SET open_value_usdc = 42 WHERE family_id = ?")
      .run(FAMILY_A);

    await publisher.publish();

    const rollups = getRollups();
    expect(rollups).toHaveLength(2); // still 2, not 4
    const alpha = rollups.find((r) => r.family_id === FAMILY_A)!;
    expect(alpha.open_value_usdc).toBe(42);
  });

  it("empty families list produces no rollup rows but summary is still written", async () => {
    familyIds = [];

    await publisher.publish();

    expect(getRollups()).toHaveLength(0);
    const summary = getSummary()!;
    expect(summary).toBeDefined();
    expect(summary.open_orders).toBe(0);
    expect(summary.open_positions).toBe(0);
    expect(summary.total_exposure_usdc).toBe(0);
  });

  it("family without runtime state gets zero defaults in rollup", async () => {
    // No seedFamilyState calls -- FAMILY_A has no row in family_runtime_state
    familyIds = [FAMILY_A];

    await publisher.publish();

    const rollups = getRollups();
    expect(rollups).toHaveLength(1);
    const alpha = rollups[0]!;
    expect(alpha.open_value_usdc).toBe(0);
    expect(alpha.open_positions).toBe(0);
    expect(alpha.last_trade_at).toBeNull();
  });

  it("publishes active live families when markets are active", async () => {
    const activeFamilyIds: Array<string[] | null> = [];
    const livePublisher = new ProfileRuntimePublisher({
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      profile: PROFILE,
      deployedFamilyIds: () => familyIds,
      getPaused: () => false,
      log,
      intervalMs: 999_999,
      setLiveActiveFamilyAllowlist: (ids) => activeFamilyIds.push(ids),
    });

    ledgerConn.db.exec(`
      INSERT INTO markets
        (token_id, condition_id, slug, question, outcome, family_id, active, tick_size, neg_risk, created_at, updated_at)
      VALUES
        ('tok-a', 'cond-a', 'slug-a', 'Q', 'YES', 'fam-alpha', 1, 0.01, 0, datetime('now'), datetime('now')),
        ('tok-b', 'cond-b', 'slug-b', 'Q', 'YES', 'fam-beta', 0, 0.01, 0, datetime('now'), datetime('now'))
    `);

    await livePublisher.publish();

    expect(activeFamilyIds).toEqual([["fam-alpha"]]);
  });

  it("clears the dynamic live family filter when no active markets remain", async () => {
    const activeFamilyIds: Array<string[] | null> = [];
    const livePublisher = new ProfileRuntimePublisher({
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      profile: PROFILE,
      deployedFamilyIds: () => familyIds,
      getPaused: () => false,
      log,
      intervalMs: 999_999,
      setLiveActiveFamilyAllowlist: (ids) => activeFamilyIds.push(ids),
    });

    ledgerConn.db.exec(`
      INSERT INTO markets
        (token_id, condition_id, slug, question, outcome, family_id, active, tick_size, neg_risk, created_at, updated_at)
      VALUES ('tok-b', 'cond-b', 'slug-b', 'Q', 'YES', 'fam-beta', 0, 0.01, 0, datetime('now'), datetime('now'))
    `);

    await livePublisher.publish();

    expect(activeFamilyIds).toEqual([null]);
  });

  // ─── Scorecard tests ───────────────────────────────────────────────────

  function getScorecards(): Array<Record<string, unknown>> {
    return controlConn.db
      .prepare("SELECT * FROM family_validation_scorecards ORDER BY scorecard_id")
      .all() as Array<Record<string, unknown>>;
  }

  it("publish() writes validation scorecards for each deployed family", async () => {
    seedFamilyState(ledgerConn, FAMILY_A);
    seedFamilyState(ledgerConn, FAMILY_B);

    await publisher.publish();

    const scorecards = getScorecards();
    expect(scorecards).toHaveLength(2);

    // Phase 6: scorecards are no longer keyed by family_id — check by profile
    expect(scorecards.every((s) => s.profile === PROFILE)).toBe(true);
    expect(scorecards.every((s) => s.scorecard_id !== undefined)).toBe(true);
    expect(scorecards.every((s) => s.validated_at !== undefined)).toBe(true);
    expect(scorecards.every((s) => s.evidence_status === "unknown")).toBe(true);
    expect(scorecards.every((s) => s.trade_count === 0)).toBe(true);
    expect(scorecards.every((s) => s.market_count === 0)).toBe(true);
  });

  it("publish() writes two scorecard rows when two families are deployed", async () => {
    seedFamilyState(ledgerConn, FAMILY_A);
    seedFamilyState(ledgerConn, FAMILY_B);

    await publisher.publish();

    // One scorecard row per deployed family
    expect(getScorecards()).toHaveLength(2);
  });

  it("scorecard reflects non-zero trade metrics when fills exist", async () => {
    seedFamilyState(ledgerConn, FAMILY_A, { tail_adjusted_pnl_live: 5.0 });

    // Seed market, order, and fill in ledger
    ledgerConn.db
      .prepare(
        `INSERT INTO markets (token_id, condition_id, slug, question, outcome, family_id, tick_size)
         VALUES ('t1', 'c1', 'test', 'Q?', 'YES', ?, 0.01)`,
      )
      .run(FAMILY_A);
    ledgerConn.db
      .prepare(
        `INSERT INTO orders (order_id, client_order_id, token_id, family_id, side, order_type, price, size, size_usdc, status, bot_run_id)
         VALUES ('o1', 'co1', 't1', ?, 'buy', 'limit', 0.5, 10, 5, 'filled', 'run-1')`,
      )
      .run(FAMILY_A);
    ledgerConn.db
      .prepare(
        `INSERT INTO fills (fill_id, order_id, token_id, family_id, side, price, size, size_usdc, fee)
         VALUES ('f1', 'o1', 't1', ?, 'buy', 0.5, 10, 5, 0.01)`,
      )
      .run(FAMILY_A);
    ledgerConn.db
      .prepare(
        `INSERT INTO fills (fill_id, order_id, token_id, family_id, side, price, size, size_usdc, fee)
         VALUES ('f2', 'o1', 't1', ?, 'buy', 0.5, 10, 5, 0.01)`,
      )
      .run(FAMILY_A);

    familyIds = [FAMILY_A];
    await publisher.publish();

    const scorecards = getScorecards();
    expect(scorecards).toHaveLength(1);

    const card = scorecards[0]!;
    expect(card.trade_count).toBe(2);
    expect(card.market_count).toBe(1);
    expect(card.evidence_status).toBe("partial");
    expect(card.tail_adjusted_pnl).toBe(5.0);
    expect(card.recycle_score).toBeGreaterThan(0);
    const summary = JSON.parse(String(card.summary_json));
    expect(summary.repricingExits).toBe(0);
    expect(summary.executionTelemetry24h.totalFills).toBe(2);
    expect(summary.executionTelemetry24h.explicitFeesUsdc).toBe(0.02);
    expect(summary.executionCanary24h.required).toBe(true);
    expect(summary.executionCanary24h.eligible).toBe(false);
  });

  it("empty families list produces no scorecard rows", async () => {
    familyIds = [];

    await publisher.publish();

    expect(getScorecards()).toHaveLength(0);
  });

  // ─── Portfolio snapshot tests ──────────────────────────────────────────

  function getSnapshots(): Array<Record<string, unknown>> {
    return ledgerConn.db.prepare("SELECT * FROM portfolio_snapshots ORDER BY id").all() as Array<
      Record<string, unknown>
    >;
  }

  it("snapshot writes equity = wallet + mark-to-market position value (live-lite)", async () => {
    controlConn.db
      .prepare("INSERT OR IGNORE INTO profiles (profile_id, display_name) VALUES (?, ?)")
      .run("live-lite", "Live-Lite");
    const liveLitePublisher = new ProfileRuntimePublisher({
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      profile: "live-lite",
      deployedFamilyIds: () => familyIds,
      getPaused: () => false,
      log,
      intervalMs: 999_999,
      exchangeGateway: {
        getBalances: async () => [{ asset: "USDC", available: 200, locked: 0 }],
      } as any,
    });

    seedFamilyState(ledgerConn, FAMILY_A, { open_value_usdc: 30 });
    // Seed an open position with current_value_usdc (mark-to-market)
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, family_id, side, status, current_value_usdc)
         VALUES ('p-mtm', 't1', ?, 'buy', 'open', 50.0)`,
      )
      .run(FAMILY_A);

    await liveLitePublisher.publish();

    const snaps = getSnapshots();
    expect(snaps).toHaveLength(1);
    // equity = wallet (200) + mark-to-market position value (50) = 250
    expect(snaps[0]!.equity_usdc).toBeCloseTo(250, 1);
    expect(snaps[0]!.wallet_usdc).toBeCloseTo(200, 1);
    expect(snaps[0]!.position_value_usdc).toBeCloseTo(50, 1);
  });

  it("snapshot writes equity = balance + mark-to-market position value (paper/sim)", async () => {
    // Seed initial balance in profile_settings so computeBalance returns non-null
    controlConn.db
      .prepare("INSERT INTO profile_settings (profile_id, initial_balance_usdc) VALUES (?, ?)")
      .run(PROFILE, 500);

    seedFamilyState(ledgerConn, FAMILY_A, { open_value_usdc: 40 });
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, family_id, side, status, current_value_usdc)
         VALUES ('p-mtm2', 't1', ?, 'buy', 'open', 75.0)`,
      )
      .run(FAMILY_A);

    await publisher.publish();

    const snaps = getSnapshots();
    expect(snaps).toHaveLength(1);
    // balance = 500 (initial) - 40 (exposure) + 0 (realized PnL) = 460
    // equity = balance (460) + position_value (75) = 535
    expect(snaps[0]!.equity_usdc).toBeCloseTo(535, 1);
    expect(snaps[0]!.wallet_usdc).toBeNull();
    expect(snaps[0]!.position_value_usdc).toBeCloseTo(75, 1);
  });

  it("snapshot uses SUM(current_value_usdc), NOT open_value_usdc", async () => {
    controlConn.db
      .prepare("INSERT INTO profile_settings (profile_id, initial_balance_usdc) VALUES (?, ?)")
      .run(PROFILE, 1000);

    // open_value_usdc in family_runtime_state is cost basis — should NOT appear in position_value
    seedFamilyState(ledgerConn, FAMILY_A, { open_value_usdc: 999 });

    // Two positions with different current_value_usdc
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, family_id, side, status, current_value_usdc)
         VALUES ('p-a', 't1', ?, 'buy', 'open', 10.0)`,
      )
      .run(FAMILY_A);
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, family_id, side, status, current_value_usdc)
         VALUES ('p-b', 't2', ?, 'buy', 'open', 20.0)`,
      )
      .run(FAMILY_A);
    // Closed position should be excluded
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, family_id, side, status, current_value_usdc)
         VALUES ('p-c', 't3', ?, 'buy', 'closed', 500.0)`,
      )
      .run(FAMILY_A);

    await publisher.publish();

    const snaps = getSnapshots();
    expect(snaps).toHaveLength(1);
    // position_value = SUM(current_value_usdc WHERE status='open') = 10 + 20 = 30
    expect(snaps[0]!.position_value_usdc).toBeCloseTo(30, 1);
  });

  it("snapshot writes only every 5 min", async () => {
    controlConn.db
      .prepare("INSERT INTO profile_settings (profile_id, initial_balance_usdc) VALUES (?, ?)")
      .run(PROFILE, 100);

    seedFamilyState(ledgerConn, FAMILY_A);

    await publisher.publish();
    expect(getSnapshots()).toHaveLength(1);

    // Second publish immediately — should NOT produce another snapshot
    await publisher.publish();
    expect(getSnapshots()).toHaveLength(1);

    // Hack the internal timestamp to simulate 5 min elapsed
    (publisher as any).lastSnapshotAt = Date.now() - 5 * 60_000;

    await publisher.publish();
    expect(getSnapshots()).toHaveLength(2);
  });

  it("wallet null skips snapshot for live-lite", async () => {
    controlConn.db
      .prepare("INSERT OR IGNORE INTO profiles (profile_id, display_name) VALUES (?, ?)")
      .run("live-lite", "Live-Lite");
    const liveLitePublisher = new ProfileRuntimePublisher({
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      profile: "live-lite",
      deployedFamilyIds: () => familyIds,
      getPaused: () => false,
      log,
      intervalMs: 999_999,
      // No exchangeGateway → walletBalanceUsdc = null
    });

    seedFamilyState(ledgerConn, FAMILY_A);

    await liveLitePublisher.publish();

    expect(getSnapshots()).toHaveLength(0);
  });

  it("balance null skips snapshot for paper/sim", async () => {
    // No profile_settings row → computeBalance returns null
    seedFamilyState(ledgerConn, FAMILY_A);

    await publisher.publish();

    expect(getSnapshots()).toHaveLength(0);
  });

  it("old snapshots are pruned (>90 days)", async () => {
    controlConn.db
      .prepare("INSERT INTO profile_settings (profile_id, initial_balance_usdc) VALUES (?, ?)")
      .run(PROFILE, 100);

    seedFamilyState(ledgerConn, FAMILY_A);

    // Insert an old snapshot manually
    ledgerConn.db
      .prepare(
        `INSERT INTO portfolio_snapshots
          (profile, equity_usdc, wallet_usdc, position_value_usdc, realized_pnl_usdc, open_value_usdc, captured_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(PROFILE, 100, 0, 0, 0, "2025-01-01T00:00:00.000Z");

    expect(getSnapshots()).toHaveLength(1);

    // Publish should insert a new snapshot and prune the old one
    await publisher.publish();

    const snaps = getSnapshots();
    expect(snaps).toHaveLength(1);
    // The remaining snapshot should be the new one, not the old one from 2025-01-01
    expect(snaps[0]!.captured_at).not.toBe("2025-01-01T00:00:00.000Z");
  });
});

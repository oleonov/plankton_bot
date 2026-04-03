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
    effective_mode: null,
    last_entry_ts: null,
    last_exit_ts: null,
    ...overrides,
  };
  ledger.db
    .prepare(
      `INSERT INTO family_runtime_state
        (family_id, open_value_usdc, open_position_count, open_dust_count,
         active_market_count, current_tail_cost_usdc, tail_adjusted_pnl_live,
         effective_mode, last_entry_ts, last_exit_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      familyId,
      defaults.open_value_usdc,
      defaults.open_position_count,
      defaults.open_dust_count,
      defaults.active_market_count,
      defaults.current_tail_cost_usdc,
      defaults.tail_adjusted_pnl_live,
      defaults.effective_mode,
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
      effective_mode: "reduce-only",
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
    expect(alpha.effective_mode).toBe("reduce-only");
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
    expect(alpha.effective_mode).toBeNull();
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
      .prepare("SELECT * FROM family_validation_scorecards ORDER BY family_id")
      .all() as Array<Record<string, unknown>>;
  }

  function getLatest(familyId: string): Record<string, unknown> | undefined {
    return controlConn.db
      .prepare("SELECT * FROM family_validation_latest WHERE family_id = ? AND profile = ?")
      .get(familyId, PROFILE) as Record<string, unknown> | undefined;
  }

  it("publish() writes validation scorecards for each deployed family", async () => {
    seedFamilyState(ledgerConn, FAMILY_A);
    seedFamilyState(ledgerConn, FAMILY_B);

    await publisher.publish();

    const scorecards = getScorecards();
    expect(scorecards).toHaveLength(2);

    const alphaCard = scorecards.find((s) => s.family_id === FAMILY_A)!;
    expect(alphaCard.profile).toBe(PROFILE);
    expect(alphaCard.scorecard_id).toBeDefined();
    expect(alphaCard.validated_at).toBeDefined();
    expect(alphaCard.evidence_status).toBe("unknown");
    expect(alphaCard.trade_count).toBe(0);
    expect(alphaCard.market_count).toBe(0);
  });

  it("publish() updates family_validation_latest", async () => {
    seedFamilyState(ledgerConn, FAMILY_A);

    await publisher.publish();

    const latest = getLatest(FAMILY_A);
    expect(latest).toBeDefined();
    expect(latest!.scorecard_id).toBeDefined();

    const scorecards = getScorecards();
    const alphaCard = scorecards.find((s) => s.family_id === FAMILY_A)!;
    expect(latest!.scorecard_id).toBe(alphaCard.scorecard_id);
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
});

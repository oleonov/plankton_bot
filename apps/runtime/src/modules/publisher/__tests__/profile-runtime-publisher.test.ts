import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, type DbConnection } from "@krabs/db";
import { ProfileRuntimePublisher } from "../profile-runtime-publisher.js";

const SCHEMAS_DIR = resolve(import.meta.dirname, "../../../../../../packages/db/src/schemas");
const CONTROL_SQL = readFileSync(resolve(SCHEMAS_DIR, "control.sql"), "utf-8");
const LEDGER_SQL = readFileSync(resolve(SCHEMAS_DIR, "ledger.sql"), "utf-8");

const PROFILE = "paper";

function createControlDb(): DbConnection {
  const conn = openDatabase(":memory:");
  conn.db.exec(CONTROL_SQL);
  conn.db
    .prepare("INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)")
    .run(PROFILE, "Paper");
  return conn;
}

function createLedgerDb(): DbConnection {
  const conn = openDatabase(":memory:");
  conn.db.exec(LEDGER_SQL);
  return conn;
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

  beforeEach(() => {
    controlConn = createControlDb();
    ledgerConn = createLedgerDb();

    publisher = new ProfileRuntimePublisher({
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      profile: PROFILE,
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

  function getSummary(): Record<string, unknown> | undefined {
    return controlConn.db
      .prepare("SELECT * FROM profile_summaries WHERE profile_id = ?")
      .get(PROFILE) as Record<string, unknown> | undefined;
  }

  it("publish() writes profile_summaries to control DB", async () => {
    // Seed some open orders and positions in ledger
    ledgerConn.db
      .prepare(
        `INSERT INTO orders (order_id, client_order_id, token_id, side, order_type, price, size, size_usdc, status, bot_run_id)
         VALUES ('o1', 'co1', 't1', 'buy', 'limit', 0.5, 10, 5, 'open', 'run-1')`,
      )
      .run();
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, status, cost_basis_usdc)
         VALUES ('p1', 't1', 'buy', 'open', 20)`,
      )
      .run();
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, status, cost_basis_usdc)
         VALUES ('p2', 't2', 'buy', 'open', 15)`,
      )
      .run();

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

    // Seed exposure: two open positions
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, status, cost_basis_usdc)
         VALUES ('open-1', 't1', 'buy', 'open', 20)`,
      )
      .run();
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, status, cost_basis_usdc)
         VALUES ('open-2', 't2', 'buy', 'open', 15)`,
      )
      .run();

    // Seed realized PnL from closed positions
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, status, realized_pnl)
         VALUES ('closed-1', 't3', 'buy', 'closed', 5.50)`,
      )
      .run();
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, status, realized_pnl)
         VALUES ('closed-2', 't4', 'buy', 'closed', -2.00)`,
      )
      .run();

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
      getPaused: () => false,
      log,
      intervalMs: 999_999,
      exchangeGateway: {
        getBalances: async () => [{ asset: "USDC", available: 487.5, locked: 0 }],
      } as any,
    });

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
      getPaused: () => false,
      log,
      intervalMs: 999_999,
      exchangeGateway: {
        getBalances: async () => [{ asset: "USDC", available: 300, locked: 0 }],
      } as any,
    });

    await workingPublisher.publish();
    expect(getSummary()!.wallet_balance_usdc).toBeCloseTo(300, 0);

    // Second publish with failing gateway — should retain 300
    const failingPublisher = new ProfileRuntimePublisher({
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      profile: PROFILE,
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
    await publisher.publish();

    const summary = getSummary()!;
    expect(summary.wallet_balance_usdc).toBeNull();
  });

  it("second publish() upserts (no duplicate rows)", async () => {
    await publisher.publish();

    const count1 = (
      controlConn.db.prepare("SELECT COUNT(*) as cnt FROM profile_summaries").get() as {
        cnt: number;
      }
    ).cnt;
    expect(count1).toBe(1);

    await publisher.publish();

    const count2 = (
      controlConn.db.prepare("SELECT COUNT(*) as cnt FROM profile_summaries").get() as {
        cnt: number;
      }
    ).cnt;
    expect(count2).toBe(1);
  });

  it("publish() summary is written even with no positions or orders", async () => {
    await publisher.publish();

    const summary = getSummary()!;
    expect(summary).toBeDefined();
    expect(summary.open_orders).toBe(0);
    expect(summary.open_positions).toBe(0);
    expect(summary.total_exposure_usdc).toBe(0);
  });

  it("a second start() does not leak the first interval past stop()", async () => {
    // `start()` awaits `publish()`, so two starts can be inside it at once: a start the supervisor's
    // stop gave up waiting for is still live when the restart behind it runs. Overwriting a live
    // handle leaves an interval nothing holds — `stop()` clears only the last one written, and the
    // orphan keeps writing profile_summaries after the runtime reports STOPPED.
    vi.useFakeTimers();
    const restarted = new ProfileRuntimePublisher({
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      profile: PROFILE,
      getPaused: () => false,
      log,
      intervalMs: 1_000,
    });
    const publishSpy = vi.spyOn(restarted, "publish");
    try {
      await restarted.start();
      await restarted.start();
      await restarted.stop();

      const publishesAtStop = publishSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(publishSpy.mock.calls.length).toBe(publishesAtStop);
    } finally {
      await restarted.stop();
      vi.useRealTimers();
    }
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
      getPaused: () => false,
      log,
      intervalMs: 999_999,
      exchangeGateway: {
        getBalances: async () => [{ asset: "USDC", available: 200, locked: 0 }],
      } as any,
    });

    // Seed an open position with current_value_usdc (mark-to-market)
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, status, current_value_usdc)
         VALUES ('p-mtm', 't1', 'buy', 'open', 50.0)`,
      )
      .run();

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

    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, status, cost_basis_usdc, current_value_usdc)
         VALUES ('p-mtm2', 't1', 'buy', 'open', 40, 75.0)`,
      )
      .run();

    await publisher.publish();

    const snaps = getSnapshots();
    expect(snaps).toHaveLength(1);
    // balance = 500 (initial) - 40 (exposure) + 0 (realized PnL) = 460
    // equity = balance (460) + position_value (75) = 535
    expect(snaps[0]!.equity_usdc).toBeCloseTo(535, 1);
    expect(snaps[0]!.wallet_usdc).toBeNull();
    expect(snaps[0]!.position_value_usdc).toBeCloseTo(75, 1);
  });

  it("snapshot uses SUM(current_value_usdc), NOT cost_basis_usdc", async () => {
    controlConn.db
      .prepare("INSERT INTO profile_settings (profile_id, initial_balance_usdc) VALUES (?, ?)")
      .run(PROFILE, 1000);

    // Two positions with different current_value_usdc
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, status, cost_basis_usdc, current_value_usdc)
         VALUES ('p-a', 't1', 'buy', 'open', 999, 10.0)`,
      )
      .run();
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, status, current_value_usdc)
         VALUES ('p-b', 't2', 'buy', 'open', 20.0)`,
      )
      .run();
    // Closed position should be excluded
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, status, current_value_usdc)
         VALUES ('p-c', 't3', 'buy', 'closed', 500.0)`,
      )
      .run();

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
      getPaused: () => false,
      log,
      intervalMs: 999_999,
      // No exchangeGateway → walletBalanceUsdc = null
    });

    await liveLitePublisher.publish();

    expect(getSnapshots()).toHaveLength(0);
  });

  it("balance null skips snapshot for paper/sim", async () => {
    // No profile_settings row → computeBalance returns null
    await publisher.publish();

    expect(getSnapshots()).toHaveLength(0);
  });

  it("old snapshots are pruned (>90 days)", async () => {
    controlConn.db
      .prepare("INSERT INTO profile_settings (profile_id, initial_balance_usdc) VALUES (?, ?)")
      .run(PROFILE, 100);

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

  it("prunes a row on the cutoff's own calendar day (ISO-vs-space lexical mismatch)", async () => {
    controlConn.db
      .prepare("INSERT INTO profile_settings (profile_id, initial_balance_usdc) VALUES (?, ?)")
      .run(PROFILE, 100);

    // SQLite's old `datetime('now', '-90 days')` cutoff rendered as space-form
    // ("YYYY-MM-DD HH:MM:SS"); since ' ' (0x20) sorts below 'T' (0x54), a canonical-ISO row on the
    // cutoff's own calendar day always compared as "newer" than that cutoff, no matter its
    // time-of-day, and was never deleted. This row is 6 minutes past the 90-day horizon but shares
    // the cutoff's calendar day — exactly the case the lexical bug missed.
    const staleIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000 - 6 * 60 * 1000).toISOString();
    ledgerConn.db
      .prepare(
        `INSERT INTO portfolio_snapshots
          (profile, equity_usdc, wallet_usdc, position_value_usdc, realized_pnl_usdc, open_value_usdc, captured_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(PROFILE, 100, 0, 0, 0, staleIso);

    expect(getSnapshots()).toHaveLength(1);

    await publisher.publish();

    const remaining = getSnapshots().map((s) => s.captured_at);
    expect(remaining).not.toContain(staleIso);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, type DbConnection } from "@plankton/db";
import type { Logger } from "../logger.js";
import { ProfileRuntimePublisher } from "../modules/publisher/profile-runtime-publisher.js";

const CONTROL_SQL = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/db/src/schemas/control.sql"),
  "utf-8",
);
const LEDGER_SQL = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/db/src/schemas/ledger.sql"),
  "utf-8",
);

const noopLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
  child() {
    return noopLog;
  },
} as unknown as Logger;

function createControlDb(): DbConnection {
  const conn = openDatabase(":memory:");
  conn.db.exec(CONTROL_SQL);
  // Seed required reference rows
  conn.db
    .prepare("INSERT INTO profiles (profile_id, display_name) VALUES ('paper', 'Paper')")
    .run();
  conn.db
    .prepare("INSERT INTO profile_settings (profile_id, initial_balance_usdc) VALUES ('paper', 1000)")
    .run();
  // Seed family_catalog entry (FK target for rollups and scorecards)
  conn.db
    .prepare(
      `INSERT INTO family_catalog
         (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
       VALUES ('fam-1', 'test-key', 'crypto', 'neutral', 'short', 'daily', 'scalp')`,
    )
    .run();
  return conn;
}

function createLedgerDb(): DbConnection {
  const conn = openDatabase(":memory:");
  conn.db.exec(LEDGER_SQL);
  // Seed a family_runtime_state row so readFamilyMetrics returns data
  conn.db
    .prepare(
      `INSERT INTO family_runtime_state
         (family_id, open_value_usdc, open_position_count, active_market_count,
          current_tail_cost_usdc, tail_adjusted_pnl_live)
       VALUES ('fam-1', 25.0, 2, 1, 3.0, 5.0)`,
    )
    .run();
  return conn;
}

describe("ProfileRuntimePublisher atomicity", () => {
  let controlConn: DbConnection;
  let ledgerConn: DbConnection;
  let publisher: ProfileRuntimePublisher;

  beforeEach(() => {
    controlConn = createControlDb();
    ledgerConn = createLedgerDb();
    publisher = new ProfileRuntimePublisher({
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      profile: "paper",
      deployedFamilyIds: () => ["fam-1"],
      getPaused: () => false,
      log: noopLog,
      intervalMs: 999_999, // prevent auto-timer from firing
    });
  });

  afterEach(() => {
    controlConn.close();
    ledgerConn.close();
  });

  it("writes rollups, profile summary, and scorecards in a single publish()", async () => {
    await publisher.publish();

    const rollup = controlConn.db
      .prepare("SELECT * FROM family_profile_rollups WHERE family_id = 'fam-1' AND profile = 'paper'")
      .get() as Record<string, unknown> | undefined;
    expect(rollup).toBeDefined();
    expect(rollup!["open_value_usdc"]).toBe(25.0);
    expect(rollup!["open_positions"]).toBe(2);

    const summary = controlConn.db
      .prepare("SELECT * FROM profile_summaries WHERE profile_id = 'paper'")
      .get() as Record<string, unknown> | undefined;
    expect(summary).toBeDefined();
    expect(summary!["paused"]).toBe(0);

    const scorecards = controlConn.db
      .prepare("SELECT * FROM family_validation_scorecards WHERE family_id = 'fam-1'")
      .all();
    expect(scorecards.length).toBe(1);

    const latest = controlConn.db
      .prepare("SELECT * FROM family_validation_latest WHERE family_id = 'fam-1' AND profile = 'paper'")
      .get() as Record<string, unknown> | undefined;
    expect(latest).toBeDefined();
  });

  it("rolls back all writes when the transaction fails mid-way", async () => {
    // Drop the scorecards table so the write fails inside the transaction
    controlConn.db.exec("DROP TABLE family_validation_latest");
    controlConn.db.exec("DROP TABLE family_validation_scorecards");

    await expect(publisher.publish()).rejects.toThrow();

    // Rollups should NOT have been persisted (transaction rolled back)
    const rollup = controlConn.db
      .prepare("SELECT * FROM family_profile_rollups WHERE family_id = 'fam-1' AND profile = 'paper'")
      .get();
    expect(rollup).toBeUndefined();

    // Profile summary should NOT have been persisted either
    const summary = controlConn.db
      .prepare("SELECT * FROM profile_summaries WHERE profile_id = 'paper'")
      .get();
    expect(summary).toBeUndefined();
  });
});

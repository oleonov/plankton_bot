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
    .prepare(
      "INSERT INTO profile_settings (profile_id, initial_balance_usdc) VALUES ('paper', 1000)",
    )
    .run();
  return conn;
}

function createLedgerDb(): DbConnection {
  const conn = openDatabase(":memory:");
  conn.db.exec(LEDGER_SQL);
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
      getPaused: () => false,
      log: noopLog,
      intervalMs: 999_999, // prevent auto-timer from firing
    });
  });

  afterEach(() => {
    controlConn.close();
    ledgerConn.close();
  });

  it("writes profile summary in a single publish()", async () => {
    await publisher.publish();

    const summary = controlConn.db
      .prepare("SELECT * FROM profile_summaries WHERE profile_id = 'paper'")
      .get() as Record<string, unknown> | undefined;
    expect(summary).toBeDefined();
    expect(summary!["paused"]).toBe(0);
    expect(summary!["open_orders"]).toBe(0);
    expect(summary!["open_positions"]).toBe(0);
  });

  it("rolls back the write when the transaction fails", async () => {
    // Drop profile_summaries so the write fails inside the transaction
    controlConn.db.exec("DROP TABLE profile_summaries");

    await expect(publisher.publish()).rejects.toThrow();

    // Confirm the table is gone (not re-created by a partial write)
    const tables = controlConn.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='profile_summaries'")
      .all();
    expect(tables).toHaveLength(0);
  });

  it("second publish upserts — exactly one summary row", async () => {
    await publisher.publish();
    await publisher.publish();

    const count = (
      controlConn.db
        .prepare("SELECT COUNT(*) as cnt FROM profile_summaries WHERE profile_id = 'paper'")
        .get() as { cnt: number }
    ).cnt;
    expect(count).toBe(1);
  });
});

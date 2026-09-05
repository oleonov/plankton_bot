import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignalActivityWindow } from "../signal-activity-window.js";

const START_MS = Date.parse("2026-09-04T00:00:00.000Z");
const WINDOW_MS = 10 * 60 * 1000;

function createTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE trading_state_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trading_state TEXT NOT NULL,
      signals_produced INTEGER NOT NULL,
      signals_approved INTEGER NOT NULL,
      signals_rejected INTEGER NOT NULL,
      captured_at TEXT NOT NULL,
      window_version INTEGER,
      window_started_at TEXT,
      window_ended_at TEXT,
      orders_accepted INTEGER,
      order_notional_usdc REAL,
      fills_received INTEGER,
      fill_notional_usdc REAL,
      rejection_reasons_json TEXT
    );
  `);
}

describe("SignalActivityWindow", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createTable(db);
  });

  afterEach(() => db.close());

  it("persists one truthful >=10m execution and signal window", () => {
    const activity = new SignalActivityWindow(db, START_MS);
    activity.recordSignalProduced();
    activity.recordSignalApproved(true);
    activity.recordSignalRejected("open value would be 15.50 USDC, exceeds max 10 USDC");
    activity.recordOrderPlaced(0.2, 5);
    activity.recordFill(0.75);

    expect(activity.closeIfDue(START_MS + WINDOW_MS - 1, false)).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM trading_state_snapshots").get()).toEqual({
      count: 0,
    });

    expect(activity.closeIfDue(START_MS + WINDOW_MS, false)).toBe(true);
    expect(db.prepare("SELECT * FROM trading_state_snapshots").get()).toMatchObject({
      trading_state: "ACTIVELY_TRADING",
      signals_produced: 1,
      signals_approved: 1,
      signals_rejected: 1,
      window_version: 2,
      window_started_at: "2026-09-04T00:00:00.000Z",
      window_ended_at: "2026-09-04T00:10:00.000Z",
      orders_accepted: 1,
      order_notional_usdc: 1,
      fills_received: 1,
      fill_notional_usdc: 0.75,
      rejection_reasons_json: '{"max_open_value":1}',
    });
  });

  it("uses pause state at close and resets only after a successful insert", () => {
    const activity = new SignalActivityWindow(db, START_MS);
    activity.recordSignalProduced();
    expect(activity.getStartedAtMs()).toBe(START_MS);
    db.exec(`
      CREATE TRIGGER reject_activity_window BEFORE INSERT ON trading_state_snapshots
      BEGIN SELECT RAISE(ABORT, 'busy'); END;
    `);

    expect(() => activity.closeIfDue(START_MS + WINDOW_MS, true)).toThrow("busy");
    expect(activity.getStartedAtMs()).toBe(START_MS);
    db.exec("DROP TRIGGER reject_activity_window");
    expect(activity.closeIfDue(START_MS + WINDOW_MS + 1, true)).toBe(true);
    expect(activity.getStartedAtMs()).toBe(START_MS + WINDOW_MS + 1);

    const first = db.prepare("SELECT * FROM trading_state_snapshots").get();
    expect(first).toMatchObject({
      trading_state: "PAUSED",
      signals_produced: 1,
      window_started_at: "2026-09-04T00:00:00.000Z",
    });

    expect(activity.closeIfDue(START_MS + 2 * WINDOW_MS, false)).toBe(false);
    db.prepare(
      `INSERT INTO trading_state_snapshots
         (trading_state, signals_produced, signals_approved, signals_rejected, captured_at)
       VALUES ('NO_SIGNALS', 0, 0, 0, '2020-01-01 00:00:00')`,
    ).run();
    expect(activity.closeIfDue(START_MS + 2 * WINDOW_MS + 1, false)).toBe(true);
    expect(
      db.prepare("SELECT signals_produced FROM trading_state_snapshots ORDER BY id DESC").get(),
    ).toEqual({ signals_produced: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM trading_state_snapshots WHERE captured_at < '2021'")
        .get(),
    ).toEqual({ count: 0 });
  });
});

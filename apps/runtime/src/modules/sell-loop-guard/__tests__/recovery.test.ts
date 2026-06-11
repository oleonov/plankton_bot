import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverSellLoopGuardEvents } from "../recovery.js";

const TOKEN = "tok-recover-1";
const NOW = Date.parse("2026-06-11T12:00:00.000Z");
const WINDOW_MS = 6 * 60 * 60_000;
const WINDOW_START = NOW - WINDOW_MS;
const NO_ID_MESSAGE = "exchange returned no order id";
const SUCCESS_NO_ID_MESSAGE = "gateway returned success without order id";

let db: Database.Database;

function createSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE orders (
      order_id TEXT PRIMARY KEY,
      client_order_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      condition_id TEXT NOT NULL DEFAULT '',
      side TEXT NOT NULL,
      order_type TEXT NOT NULL DEFAULT 'limit',
      price REAL NOT NULL DEFAULT 0,
      size REAL NOT NULL DEFAULT 0,
      size_usdc REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      exchange_error_message TEXT,
      exchange_rejection_reason TEXT,
      bot_run_id TEXT NOT NULL DEFAULT 'run',
      created_at TEXT NOT NULL
    );
    CREATE TABLE risk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

interface RejectedOrderRow {
  id: string;
  token?: string;
  message: string | null;
  createdAtMs: number;
  side?: string;
  status?: string;
}

function insertRejectedOrder(d: Database.Database, row: RejectedOrderRow): void {
  d.prepare(
    `INSERT INTO orders (order_id, client_order_id, token_id, side, status, exchange_error_message, bot_run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'run', ?)`,
  ).run(
    row.id,
    row.id,
    row.token ?? TOKEN,
    row.side ?? "sell",
    row.status ?? "rejected",
    row.message,
    new Date(row.createdAtMs).toISOString(),
  );
}

interface RiskEventRow {
  token?: string;
  reasonCode?: string;
  side?: string;
  createdAtMs: number;
  eventType?: string;
}

function insertRiskEvent(d: Database.Database, row: RiskEventRow): void {
  const payload = JSON.stringify({
    tokenId: row.token ?? TOKEN,
    side: row.side ?? "sell",
    reasonCode: row.reasonCode ?? "post-only-cross-pre-submit",
  });
  // risk_events.created_at uses SQLite datetime('now') space format (UTC, second precision).
  const createdAt = new Date(row.createdAtMs).toISOString().slice(0, 19).replace("T", " ");
  d.prepare(`INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)`).run(
    row.eventType ?? "order_skipped",
    payload,
    createdAt,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
});

afterEach(() => {
  db.close();
});

describe("recoverSellLoopGuardEvents", () => {
  it("recovers recent exchange no-id rejections and local skips within the window", () => {
    for (let i = 0; i < 9; i++) {
      insertRejectedOrder(db, {
        id: `o-${i}`,
        message: NO_ID_MESSAGE,
        createdAtMs: NOW - i * 60_000,
      });
    }
    insertRiskEvent(db, { createdAtMs: NOW - 30_000 });

    const events = recoverSellLoopGuardEvents(db, WINDOW_START);

    expect(events).toHaveLength(10);
    expect(events.every((e) => e.tokenId === TOKEN)).toBe(true);
    expect(events.filter((e) => e.outcome === "exchange_no_order_id")).toHaveLength(9);
    expect(events.filter((e) => e.outcome === "post_only_cross_pre_submit")).toHaveLength(1);
  });

  it("counts gateway-success-without-order-id rejections", () => {
    insertRejectedOrder(db, {
      id: "o-success-no-id",
      message: SUCCESS_NO_ID_MESSAGE,
      createdAtMs: NOW - 60_000,
    });

    const events = recoverSellLoopGuardEvents(db, WINDOW_START);

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("exchange_no_order_id");
  });

  it("returns events sorted ascending by timestamp", () => {
    insertRejectedOrder(db, { id: "o-late", message: NO_ID_MESSAGE, createdAtMs: NOW - 10_000 });
    insertRejectedOrder(db, { id: "o-early", message: NO_ID_MESSAGE, createdAtMs: NOW - 100_000 });

    const events = recoverSellLoopGuardEvents(db, WINDOW_START);

    expect(events).toHaveLength(2);
    expect(events[0]!.timestampMs).toBeLessThan(events[1]!.timestampMs);
  });

  it("excludes rows older than the window", () => {
    for (let i = 0; i < 10; i++) {
      insertRejectedOrder(db, {
        id: `old-${i}`,
        message: NO_ID_MESSAGE,
        createdAtMs: WINDOW_START - (i + 1) * 60_000,
      });
    }
    insertRiskEvent(db, { createdAtMs: WINDOW_START - 60_000 });

    const events = recoverSellLoopGuardEvents(db, WINDOW_START);

    expect(events).toHaveLength(0);
  });

  it("does not rely on deduped order_rejected risk events for recovery", () => {
    // Only deduped order_rejected risk events exist (no orders rows). The guard
    // must not count these — they are the deduplicated audit stream.
    insertRiskEvent(db, {
      eventType: "order_rejected",
      reasonCode: NO_ID_MESSAGE,
      createdAtMs: NOW - 30_000,
    });

    const events = recoverSellLoopGuardEvents(db, WINDOW_START);

    expect(events).toHaveLength(0);
  });

  it("ignores non-target reject reasons and BUY side", () => {
    insertRejectedOrder(db, {
      id: "balance",
      message: "insufficient balance",
      createdAtMs: NOW - 60_000,
    });
    insertRejectedOrder(db, {
      id: "buy-no-id",
      side: "buy",
      message: NO_ID_MESSAGE,
      createdAtMs: NOW - 60_000,
    });
    insertRiskEvent(db, { side: "buy", createdAtMs: NOW - 30_000 });

    const events = recoverSellLoopGuardEvents(db, WINDOW_START);

    expect(events).toHaveLength(0);
  });
});

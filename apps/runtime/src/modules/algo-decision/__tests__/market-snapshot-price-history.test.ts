import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createTokenId } from "@krabs/domain";
import { MarketSnapshotPriceHistoryProvider } from "../market-snapshot-price-history.js";

describe("MarketSnapshotPriceHistoryProvider", () => {
  let db: Database.Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  function setupDb(): Database.Database {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE market_snapshots (
        token_id TEXT NOT NULL,
        best_bid REAL,
        best_ask REAL,
        last_price REAL,
        captured_at TEXT NOT NULL
      );
    `);
    return db;
  }

  it("computes the max normalized midpoint inside the requested window", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    const insert = conn.prepare(
      "INSERT INTO market_snapshots (token_id, best_bid, best_ask, last_price, captured_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("tok", 0.09, 0.11, null, "2026-05-18T10:00:00.000Z");
    insert.run("tok", 0.18, 0.22, null, "2026-05-18T11:00:00.000Z");
    insert.run("tok", 0.15, 0.17, null, "2026-05-18T12:00:00.000Z");
    insert.run("tok", 0.48, 0.52, null, "2026-05-17T11:59:59.000Z");

    const provider = new MarketSnapshotPriceHistoryProvider(conn);

    expect(provider.maxMidpointInWindow(createTokenId("tok"), 24 * 60 * 60_000, now)).toBeCloseTo(
      0.2,
      8,
    );
  });

  it("falls back to last_price and returns null when no window rows have price", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    const insert = conn.prepare(
      "INSERT INTO market_snapshots (token_id, best_bid, best_ask, last_price, captured_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("tok", null, null, 0.07, "2026-05-18T11:00:00.000Z");
    insert.run("other", null, null, null, "2026-05-18T11:00:00.000Z");

    const provider = new MarketSnapshotPriceHistoryProvider(conn);

    expect(provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now)).toBe(0.07);
    expect(provider.maxMidpointInWindow(createTokenId("other"), 60 * 60_000, now)).toBeNull();
    expect(provider.maxMidpointInWindow(createTokenId("missing"), 60 * 60_000, now)).toBeNull();
  });

  it("caches window max results briefly to avoid per-tick full DB rescans", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    const insert = conn.prepare(
      "INSERT INTO market_snapshots (token_id, best_bid, best_ask, last_price, captured_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("tok", 0.09, 0.11, null, "2026-05-18T11:00:00.000Z");

    const provider = new MarketSnapshotPriceHistoryProvider(conn);

    expect(provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now)).toBeCloseTo(
      0.1,
      8,
    );

    insert.run("tok", 0.29, 0.31, null, "2026-05-18T12:00:01.000Z");

    expect(
      provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now + 1_000),
    ).toBeCloseTo(0.1, 8);
    expect(
      provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now + 61_000),
    ).toBeCloseTo(0.3, 8);
  });

  it("tracks window max cache hit rate", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    conn
      .prepare(
        "INSERT INTO market_snapshots (token_id, best_bid, best_ask, last_price, captured_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("tok", 0.09, 0.11, null, "2026-05-18T11:00:00.000Z");
    const provider = new MarketSnapshotPriceHistoryProvider(conn);

    provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now);
    provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now + 1_000);

    expect(provider.getWindowMaxCacheMetrics()).toMatchObject({
      invocations: 2,
      hits: 1,
      misses: 1,
      hitRate: 0.5,
      entries: 1,
    });
  });
});

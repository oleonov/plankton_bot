import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteLegStateRepository } from "../repositories/leg-state-repository.js";
import { createTokenId } from "@plankton/domain";
import type { LegState } from "@plankton/domain";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN = createTokenId("tok-test");

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  const base = readFileSync(
    join(import.meta.dirname, "../migrations/028_algo_engine.sql"),
    "utf-8",
  );
  const cumulativeSizes = readFileSync(
    join(import.meta.dirname, "../migrations/050_leg_states_cumulative_sizes.sql"),
    "utf-8",
  );
  db.exec(base);
  // Migration 050's backfill subqueries reference fills; in the production
  // migration order this table exists from migration 001. Stub the minimum
  // shape here so the UPDATE has something to scan against.
  db.exec(`CREATE TABLE IF NOT EXISTS fills (
    fill_id TEXT PRIMARY KEY,
    token_id TEXT NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL,
    size_usdc REAL,
    filled_at TEXT NOT NULL
  )`);
  db.exec(cumulativeSizes);
  return db;
}

describe("SqliteLegStateRepository", () => {
  let db: Database.Database;
  let repo: SqliteLegStateRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteLegStateRepository(db);
  });

  it("returns null for unknown token", () => {
    expect(repo.get(TOKEN)).toBeNull();
  });

  it("upserts and retrieves a leg state", () => {
    const state: LegState = {
      tokenId: TOKEN,
      buyCount: 2,
      sellCount: 1,
      lastAction: "SELL",
      firstTradePrice: 0.03,
      firstTradeAt: "2026-01-01T00:00:00Z",
      lastTradeAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      cumulativeBuySize: 200,
      cumulativeBuyNotional: 6,
      cumulativeSellSize: 50,
    };
    repo.upsert(state);
    const result = repo.get(TOKEN);
    expect(result).not.toBeNull();
    expect(result!.buyCount).toBe(2);
    expect(result!.sellCount).toBe(1);
    expect(result!.lastAction).toBe("SELL");
    expect(result!.cumulativeBuySize).toBe(200);
    expect(result!.cumulativeBuyNotional).toBe(6);
    expect(result!.cumulativeSellSize).toBe(50);
  });

  it("updates existing leg state on upsert", () => {
    const state: LegState = {
      tokenId: TOKEN,
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.03,
      firstTradeAt: "2026-01-01T00:00:00Z",
      lastTradeAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      cumulativeBuySize: 100,
      cumulativeBuyNotional: 3,
      cumulativeSellSize: 0,
    };
    repo.upsert(state);
    repo.upsert({
      ...state,
      buyCount: 3,
      lastAction: "BUY",
      lastTradeAt: "2026-01-03T00:00:00Z",
      updatedAt: "2026-01-03T00:00:00Z",
      cumulativeBuySize: 300,
      cumulativeBuyNotional: 9,
    });
    const result = repo.get(TOKEN);
    expect(result!.buyCount).toBe(3);
    expect(result!.cumulativeBuySize).toBe(300);
    expect(result!.cumulativeBuyNotional).toBe(9);
  });

  it("deletes a leg state", () => {
    repo.upsert({
      tokenId: TOKEN,
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.03,
      firstTradeAt: "2026-01-01T00:00:00Z",
      lastTradeAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      cumulativeBuySize: 100,
      cumulativeBuyNotional: 3,
      cumulativeSellSize: 0,
    });
    repo.delete(TOKEN);
    expect(repo.get(TOKEN)).toBeNull();
  });

  it("migration 050 backfills cumulative_* on existing leg_states from fills history", () => {
    // Fresh DB simulating pre-migration state: leg_states without cumulative
    // columns + populated fills. Migration 050 must populate the cumulative
    // columns in-place — runStartupPositionAdoption only seeds rows for
    // tokens *without* a leg_states row, so existing rows would otherwise
    // stay at the column DEFAULT 0 forever.
    const fresh = new Database(":memory:");
    const base = readFileSync(
      join(import.meta.dirname, "../migrations/028_algo_engine.sql"),
      "utf-8",
    );
    fresh.exec(base);
    fresh.exec(`CREATE TABLE fills (
      fill_id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL,
      size_usdc REAL,
      filled_at TEXT NOT NULL
    )`);
    fresh
      .prepare(
        `INSERT INTO leg_states (token_id, buy_count, sell_count, last_action, first_trade_price, first_trade_at, last_trade_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "tok-bf",
        2,
        0,
        "BUY",
        0.1,
        "2026-01-01T00:00:00Z",
        "2026-01-02T00:00:00Z",
        "2026-01-02T00:00:00Z",
      );

    // Two BUYs and one SELL, all after first_trade_at — must all count.
    const insertFill = fresh.prepare(
      `INSERT INTO fills (fill_id, token_id, side, price, size, size_usdc, filled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertFill.run("f1", "tok-bf", "buy", 0.1, 100, 10, "2026-01-01T00:00:00Z");
    insertFill.run("f2", "tok-bf", "buy", 0.2, 50, 11, "2026-01-02T00:00:00Z"); // sizeUsdc != price*size on purpose
    insertFill.run("f3", "tok-bf", "sell", 0.3, 30, 9, "2026-01-02T00:00:00Z");
    // Pre-leg fill (filled_at < first_trade_at) — must NOT leak in.
    insertFill.run("f0", "tok-bf", "buy", 0.05, 999, 100, "2025-12-31T23:59:59Z");

    const cumulativeSizes = readFileSync(
      join(import.meta.dirname, "../migrations/050_leg_states_cumulative_sizes.sql"),
      "utf-8",
    );
    fresh.exec(cumulativeSizes);

    const row = fresh
      .prepare(
        `SELECT cumulative_buy_size, cumulative_buy_notional, cumulative_sell_size
           FROM leg_states WHERE token_id = ?`,
      )
      .get("tok-bf") as Record<string, number>;
    expect(row.cumulative_buy_size).toBe(150); // 100 + 50; pre-leg 999 excluded
    expect(row.cumulative_buy_notional).toBeCloseTo(10 + 11, 10); // sizeUsdc, not price*size
    expect(row.cumulative_sell_size).toBe(30);
    fresh.close();
  });

  it("getAll returns all leg states", () => {
    const tok2 = createTokenId("tok-2");
    repo.upsert({
      tokenId: TOKEN,
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.03,
      firstTradeAt: "2026-01-01T00:00:00Z",
      lastTradeAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      cumulativeBuySize: 100,
      cumulativeBuyNotional: 3,
      cumulativeSellSize: 0,
    });
    repo.upsert({
      tokenId: tok2,
      buyCount: 2,
      sellCount: 1,
      lastAction: "SELL",
      firstTradePrice: 0.05,
      firstTradeAt: "2026-01-01T00:00:00Z",
      lastTradeAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      cumulativeBuySize: 200,
      cumulativeBuyNotional: 10,
      cumulativeSellSize: 100,
    });
    expect(repo.getAll().length).toBe(2);
  });
});

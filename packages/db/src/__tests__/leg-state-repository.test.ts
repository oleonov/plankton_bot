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
  const sql = readFileSync(join(import.meta.dirname, "../migrations/028_algo_engine.sql"), "utf-8");
  db.exec(sql);
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
      firstEntryFillPrice: 0.03,
      firstTradeAt: "2026-01-01T00:00:00Z",
      lastTradeAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    repo.upsert(state);
    const result = repo.get(TOKEN);
    expect(result).not.toBeNull();
    expect(result!.buyCount).toBe(2);
    expect(result!.sellCount).toBe(1);
    expect(result!.lastAction).toBe("SELL");
  });

  it("updates existing leg state on upsert", () => {
    const state: LegState = {
      tokenId: TOKEN,
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstEntryFillPrice: 0.03,
      firstTradeAt: "2026-01-01T00:00:00Z",
      lastTradeAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    repo.upsert(state);
    repo.upsert({
      ...state,
      buyCount: 3,
      lastAction: "BUY",
      lastTradeAt: "2026-01-03T00:00:00Z",
      updatedAt: "2026-01-03T00:00:00Z",
    });
    const result = repo.get(TOKEN);
    expect(result!.buyCount).toBe(3);
  });

  it("deletes a leg state", () => {
    repo.upsert({
      tokenId: TOKEN,
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstEntryFillPrice: 0.03,
      firstTradeAt: "2026-01-01T00:00:00Z",
      lastTradeAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    repo.delete(TOKEN);
    expect(repo.get(TOKEN)).toBeNull();
  });

  it("getAll returns all leg states", () => {
    const tok2 = createTokenId("tok-2");
    repo.upsert({
      tokenId: TOKEN,
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstEntryFillPrice: 0.03,
      firstTradeAt: "2026-01-01T00:00:00Z",
      lastTradeAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    repo.upsert({
      tokenId: tok2,
      buyCount: 2,
      sellCount: 1,
      lastAction: "SELL",
      firstEntryFillPrice: 0.05,
      firstTradeAt: "2026-01-01T00:00:00Z",
      lastTradeAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    expect(repo.getAll().length).toBe(2);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteMarketSnapshotRepository } from "../repositories/market-snapshot-repository.js";
import { createTokenId } from "@plankton/domain";
import type { MarketSnapshot } from "@plankton/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteMarketSnapshotRepository;

function insertMarket(db: import("better-sqlite3").Database, tokenId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO markets (token_id, condition_id, slug, question, outcome, active, tick_size, neg_risk, created_at, updated_at)
     VALUES (?, 'cond-1', 'test-slug', 'test?', 'YES', 1, 0.01, 0, datetime('now'), datetime('now'))`,
  ).run(tokenId);
}

function makeSnapshot(overrides?: Partial<MarketSnapshot>): MarketSnapshot {
  return {
    tokenId: createTokenId("tok-1"),
    bestBid: 0.45,
    bestAsk: 0.55,
    lastPrice: null,
    volume24h: null,
    liquidity: null,
    capturedAt: "2026-03-22T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteMarketSnapshotRepository(conn.db);
  insertMarket(conn.db, "tok-1");
  insertMarket(conn.db, "tok-2");
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteMarketSnapshotRepository", () => {
  it("saveBatch inserts rows", () => {
    const batch = [makeSnapshot(), makeSnapshot({ tokenId: createTokenId("tok-2"), bestBid: 0.6 })];
    repo.saveBatch(batch);

    const rows = conn.db
      .prepare("SELECT * FROM market_snapshots ORDER BY token_id")
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.token_id).toBe("tok-1");
    expect(rows[0]!.best_bid).toBe(0.45);
    expect(rows[1]!.token_id).toBe("tok-2");
    expect(rows[1]!.best_bid).toBe(0.6);
  });

  it("saveBatch with empty array is a no-op", () => {
    repo.saveBatch([]);
    const count = conn.db.prepare("SELECT COUNT(*) as c FROM market_snapshots").get() as {
      c: number;
    };
    expect(count.c).toBe(0);
  });

  it("prune deletes rows older than cutoff", () => {
    repo.saveBatch([
      makeSnapshot({ capturedAt: "2026-03-10T00:00:00.000Z" }),
      makeSnapshot({
        tokenId: createTokenId("tok-2"),
        capturedAt: "2026-03-22T00:00:00.000Z",
      }),
    ]);

    const deleted = repo.prune("2026-03-15T00:00:00.000Z");
    expect(deleted).toBe(1);

    const remaining = conn.db.prepare("SELECT * FROM market_snapshots").all() as Record<
      string,
      unknown
    >[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.token_id).toBe("tok-2");
  });

  it("prune returns 0 when nothing to delete", () => {
    repo.saveBatch([makeSnapshot()]);
    const deleted = repo.prune("2026-01-01T00:00:00.000Z");
    expect(deleted).toBe(0);
  });
});

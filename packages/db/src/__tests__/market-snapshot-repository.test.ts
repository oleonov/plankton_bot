import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteMarketSnapshotRepository } from "../repositories/market-snapshot-repository.js";
import { createTokenId } from "@krabs/domain";
import type { MarketSnapshot } from "@krabs/domain";

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
    publicTradeCount24h: null,
    capturedAt: "2026-03-22T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-test-"));
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
    expect(rows[0]!.public_trade_count_24h).toBeNull();
    expect(rows[1]!.token_id).toBe("tok-2");
    expect(rows[1]!.best_bid).toBe(0.6);
  });

  it("persists public trade count", () => {
    repo.saveBatch([makeSnapshot({ publicTradeCount24h: 41 })]);

    const row = conn.db.prepare("SELECT public_trade_count_24h FROM market_snapshots").get() as {
      public_trade_count_24h: unknown;
    };
    expect(row.public_trade_count_24h).toBe(41);
  });

  it("saveBatch with empty array is a no-op", () => {
    repo.saveBatch([]);
    const count = conn.db.prepare("SELECT COUNT(*) as c FROM market_snapshots").get() as {
      c: number;
    };
    expect(count.c).toBe(0);
  });

  it("saveBatchWithPositionValuations writes snapshots and liquidation values together", () => {
    conn.db
      .prepare(
        `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, updated_at)
       VALUES ('pos-1', 'tok-1', 'cond-1', 'buy', 100, 0.1, 10, 50, 0, 'open',
               '2026-06-12T00:00:00.000Z', '2026-06-12T00:00:00.000Z')`,
      )
      .run();

    repo.saveBatchWithPositionValuations?.(
      [makeSnapshot()],
      [
        {
          tokenId: createTokenId("tok-1"),
          currentValueUsdc: 50,
          liquidationValueUsdc: 21.4,
          liquidationPrice: 0.214,
          liquidationDepthExhausted: false,
          updatedAt: "2026-06-12T12:00:00.000Z",
        },
      ],
    );

    const snapshotCount = conn.db
      .prepare("SELECT COUNT(*) AS count FROM market_snapshots")
      .get() as {
      count: number;
    };
    expect(snapshotCount.count).toBe(1);

    const position = conn.db
      .prepare(
        `SELECT current_value_usdc, liquidation_value_usdc, liquidation_price,
                liquidation_depth_exhausted, liquidation_value_updated_at, updated_at
         FROM positions WHERE token_id = 'tok-1'`,
      )
      .get() as Record<string, unknown>;
    expect(position).toEqual({
      current_value_usdc: 50,
      liquidation_value_usdc: 21.4,
      liquidation_price: 0.214,
      liquidation_depth_exhausted: 0,
      liquidation_value_updated_at: "2026-06-12T12:00:00.000Z",
      updated_at: "2026-06-12T12:00:00.000Z",
    });
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

  it("prune preserves explicit active tokens even when older than cutoff", () => {
    repo.saveBatch([
      makeSnapshot({ capturedAt: "2026-03-10T00:00:00.000Z" }),
      makeSnapshot({
        tokenId: createTokenId("tok-2"),
        capturedAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);

    const deleted = repo.prune("2026-03-15T00:00:00.000Z", {
      preserveTokenIds: [createTokenId("tok-1")],
    });
    expect(deleted).toBe(1);

    const remaining = conn.db.prepare("SELECT token_id FROM market_snapshots").all() as {
      token_id: string;
    }[];
    expect(remaining).toEqual([{ token_id: "tok-1" }]);
  });

  it("prune returns 0 when nothing to delete", () => {
    repo.saveBatch([makeSnapshot()]);
    const deleted = repo.prune("2026-01-01T00:00:00.000Z");
    expect(deleted).toBe(0);
  });
});

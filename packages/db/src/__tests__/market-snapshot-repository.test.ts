import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { RUNTIME_BUSY_TIMEOUT_MS, SHUTDOWN_BUSY_TIMEOUT_MS } from "../connection.js";
import { SqliteMarketSnapshotRepository } from "../repositories/market-snapshot-repository.js";
import { createPositionId, createTokenId } from "@krabs/domain";
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

function insertPosition(
  db: import("better-sqlite3").Database,
  args: { positionId: string; tokenId: string; size: number; status: string; currentValue: number },
): void {
  db.prepare(
    `INSERT INTO positions
       (position_id, token_id, condition_id, side, size, avg_entry_price,
        cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, updated_at)
     VALUES (?, ?, 'cond-1', 'buy', ?, 0.1, ?, ?, 0, ?,
             '2026-06-12T00:00:00.000Z', '2026-06-12T00:00:00.000Z')`,
  ).run(args.positionId, args.tokenId, args.size, args.size * 0.1, args.currentValue, args.status);
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
    insertPosition(conn.db, {
      positionId: "pos-1",
      tokenId: "tok-1",
      size: 100,
      status: "open",
      currentValue: 50,
    });

    repo.saveBatchWithPositionValuations?.(
      [makeSnapshot()],
      [
        {
          positionId: createPositionId("pos-1"),
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

  it("leaves the dust sibling untouched when only the open row is valued (#134)", () => {
    // Migration 032's unique index is PARTIAL, so an `open` row and a `dust` row on one token is a
    // LEGAL state. The UPDATE used to be keyed on `token_id`, which wrote the open row's
    // size-derived value onto the dust row — and refreshed the dust row's `updated_at`, the very
    // field the revaluation loop reads to decide whether a row still needs marking.
    insertPosition(conn.db, {
      positionId: "pos-open",
      tokenId: "tok-1",
      size: 100,
      status: "open",
      currentValue: 50,
    });
    insertPosition(conn.db, {
      positionId: "pos-dust",
      tokenId: "tok-1",
      size: 4,
      status: "dust",
      currentValue: 0.4,
    });

    repo.saveBatchWithPositionValuations?.(
      [makeSnapshot()],
      [
        {
          positionId: createPositionId("pos-open"),
          tokenId: createTokenId("tok-1"),
          currentValueUsdc: 60,
          liquidationValueUsdc: 48,
          liquidationPrice: 0.48,
          liquidationDepthExhausted: false,
          updatedAt: "2026-08-11T12:00:00.000Z",
        },
      ],
    );

    const rows = conn.db
      .prepare(
        `SELECT position_id, current_value_usdc, liquidation_value_usdc, updated_at
           FROM positions ORDER BY position_id`,
      )
      .all() as Record<string, unknown>[];
    expect(rows).toEqual([
      {
        position_id: "pos-dust",
        current_value_usdc: 0.4,
        liquidation_value_usdc: null,
        updated_at: "2026-06-12T00:00:00.000Z",
      },
      {
        position_id: "pos-open",
        current_value_usdc: 60,
        liquidation_value_usdc: 48,
        updated_at: "2026-08-11T12:00:00.000Z",
      },
    ]);
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

  describe("findLatestBboByTokens", () => {
    it("returns the latest best_bid/best_ask per token within 30 minutes", () => {
      const recentIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const olderIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      // Two snapshots for tok-1 (older first); only the later one should be returned.
      repo.saveBatch([
        makeSnapshot({
          tokenId: createTokenId("tok-1"),
          bestBid: 0.3,
          bestAsk: 0.4,
          capturedAt: olderIso,
        }),
        makeSnapshot({
          tokenId: createTokenId("tok-1"),
          bestBid: 0.43,
          bestAsk: 0.55,
          capturedAt: recentIso,
        }),
        makeSnapshot({
          tokenId: createTokenId("tok-2"),
          bestBid: 0.6,
          bestAsk: 0.7,
          capturedAt: recentIso,
        }),
      ]);

      const result = repo.findLatestBboByTokens([createTokenId("tok-1"), createTokenId("tok-2")]);

      expect(result.size).toBe(2);
      // tickSize comes from the markets JOIN (insertMarket uses tick_size=0.01)
      expect(result.get("tok-1")).toEqual({ bestBid: 0.43, bestAsk: 0.55, tickSize: 0.01 });
      expect(result.get("tok-2")).toEqual({ bestBid: 0.6, bestAsk: 0.7, tickSize: 0.01 });
    });

    it("excludes snapshots older than 30 minutes", () => {
      const staleIso = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      repo.saveBatch([makeSnapshot({ tokenId: createTokenId("tok-1"), capturedAt: staleIso })]);

      const result = repo.findLatestBboByTokens([createTokenId("tok-1")]);
      expect(result.size).toBe(0);
    });

    it("returns an empty map for an empty input array", () => {
      const result = repo.findLatestBboByTokens([]);
      expect(result.size).toBe(0);
    });

    it("does not include tokens absent from the table", () => {
      // tok-2 has no snapshot — should not appear in result
      const recentIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      repo.saveBatch([makeSnapshot({ tokenId: createTokenId("tok-1"), capturedAt: recentIso })]);

      const result = repo.findLatestBboByTokens([createTokenId("tok-1"), createTokenId("tok-2")]);
      expect(result.has("tok-1")).toBe(true);
      expect(result.has("tok-2")).toBe(false);
    });
  });

  describe("enterShutdownMode", () => {
    // market_snapshots keeps being written while modules stop: the MarketSnapshotReceived /
    // MarketSnapshotHeartbeat subscribers are permanent, and MarketDataModule.stop() flushes
    // pending stream updates through them. better-sqlite3 is synchronous, so one such write losing
    // the writer lock to the checkpoint worker freezes the event loop for the connection's full
    // runtime timeout — longer than the entire shutdown budget.
    const pragmaCalls: string[] = [];

    beforeEach(() => {
      pragmaCalls.length = 0;
      const original = conn.db.pragma.bind(conn.db);
      conn.db.pragma = ((source: string, options?: unknown) => {
        pragmaCalls.push(source);
        return original(source, options as never);
      }) as typeof conn.db.pragma;
    });

    function expectBoundedAndRestored(): void {
      expect(pragmaCalls).toContain(`busy_timeout = ${SHUTDOWN_BUSY_TIMEOUT_MS}`);
      // Restored, not left low: execution drains its order queue on this same connection and an
      // exchange-accepted order must still persist at the full runtime timeout.
      expect(pragmaCalls.at(-1)).toBe(`busy_timeout = ${RUNTIME_BUSY_TIMEOUT_MS}`);
      expect(conn.db.pragma("busy_timeout", { simple: true })).toBe(RUNTIME_BUSY_TIMEOUT_MS);
      pragmaCalls.length = 0;
    }

    it("leaves steady-state writes unbounded", () => {
      repo.saveBatch([makeSnapshot()]);
      repo.saveBatchWithPositionValuations([makeSnapshot()], []);
      repo.prune("2999-01-01T00:00:00.000Z");
      // The bound is per-write and shutdown-only: no pragma round-trip before enterShutdownMode.
      expect(pragmaCalls).toEqual([]);
    });

    it("bounds every write path to the teardown busy_timeout and restores the connection's own", () => {
      repo.enterShutdownMode();

      repo.saveBatch([makeSnapshot()]);
      expectBoundedAndRestored();

      repo.saveBatchWithPositionValuations([makeSnapshot({ bestBid: 0.46 })], []);
      expectBoundedAndRestored();

      // Both prune branches: the unfiltered DELETE and the preserve-list one are separate
      // statements, so a bound on only one of them still leaves the largest DELETE in the ledger
      // able to outlast the grace period.
      repo.prune("2999-01-01T00:00:00.000Z");
      expectBoundedAndRestored();

      repo.prune("2999-01-01T00:00:00.000Z", { preserveTokenIds: [createTokenId("tok-2")] });
      expectBoundedAndRestored();
    });

    it("still performs the write it bounds", () => {
      repo.saveBatch([makeSnapshot(), makeSnapshot({ tokenId: createTokenId("tok-2") })]);
      repo.enterShutdownMode();

      repo.saveBatch([makeSnapshot({ capturedAt: "2026-03-22T13:00:00.000Z" })]);
      const inserted = conn.db.prepare("SELECT COUNT(*) AS c FROM market_snapshots").get() as {
        c: number;
      };
      expect(inserted.c).toBe(3);

      expect(
        repo.prune("2999-01-01T00:00:00.000Z", { preserveTokenIds: [createTokenId("tok-2")] }),
      ).toBe(2);
      const remaining = conn.db.prepare("SELECT token_id FROM market_snapshots").all() as Array<{
        token_id: string;
      }>;
      expect(remaining.map((r) => r.token_id)).toEqual(["tok-2"]);
    });
  });
});

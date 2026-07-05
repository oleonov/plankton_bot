import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapLedgerDb } from "../../bootstrap.js";
import type { DbConnection } from "../../connection.js";
import { SqliteMarketSnapshotRepository } from "../market-snapshot-repository.js";
import { createTokenId } from "@krabs/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteMarketSnapshotRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-msr-"));
  conn = bootstrapLedgerDb(path.join(tmpDir, "ledger.db"));
  repo = new SqliteMarketSnapshotRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Insert a markets row before any snapshot — FK enforced in production and in tests.
function insertMarket(db: DbConnection["db"], tokenId: string, tickSize: number): void {
  db.prepare(
    `INSERT INTO markets
       (token_id, condition_id, slug, question, outcome, tick_size, neg_risk)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(tokenId, "cond-test", "test-slug", "Test?", "Yes", tickSize, 0);
}

function insertSnapshot(
  db: DbConnection["db"],
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  capturedAt: string,
): void {
  db.prepare(
    `INSERT INTO market_snapshots (token_id, best_bid, best_ask, captured_at)
     VALUES (?, ?, ?, ?)`,
  ).run(tokenId, bestBid, bestAsk, capturedAt);
}

describe("SqliteMarketSnapshotRepository.findLatestBboByTokens — tickSize JOIN", () => {
  it("returns the token's real tickSize (0.001) from the markets JOIN (Finding 3)", () => {
    const tokenId = createTokenId("tok-tick-001");
    const now = new Date().toISOString();

    // Market row with tick_size=0.001 (maker universe, NOT the default 0.01).
    insertMarket(conn.db, String(tokenId), 0.001);
    insertSnapshot(conn.db, String(tokenId), 0.43, 0.55, now);

    const result = repo.findLatestBboByTokens([tokenId]);
    const entry = result.get(String(tokenId));

    expect(entry).toBeDefined();
    expect(entry!.bestBid).toBeCloseTo(0.43);
    expect(entry!.bestAsk).toBeCloseTo(0.55);
    // tickSize must come from the markets JOIN, not be hardcoded or absent
    expect(entry!.tickSize).toBeCloseTo(0.001);
  });

  it("returns the latest snapshot (not an older one) with correct tickSize", () => {
    const tokenId = createTokenId("tok-multi");
    const now = new Date().toISOString();
    const earlier = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    insertMarket(conn.db, String(tokenId), 0.001);
    insertSnapshot(conn.db, String(tokenId), 0.3, 0.4, earlier);
    insertSnapshot(conn.db, String(tokenId), 0.43, 0.55, now);

    const result = repo.findLatestBboByTokens([tokenId]);
    const entry = result.get(String(tokenId));

    expect(entry!.bestBid).toBeCloseTo(0.43); // newest, not the older 0.30
    expect(entry!.tickSize).toBeCloseTo(0.001);
  });

  it("excludes snapshots older than 30 minutes", () => {
    const tokenId = createTokenId("tok-stale");
    const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString();

    insertMarket(conn.db, String(tokenId), 0.01);
    insertSnapshot(conn.db, String(tokenId), 0.43, 0.55, stale);

    const result = repo.findLatestBboByTokens([tokenId]);
    expect(result.has(String(tokenId))).toBe(false);
  });

  it("returns an empty map for an empty token list", () => {
    expect(repo.findLatestBboByTokens([])).toEqual(new Map());
  });

  it("handles a batch of tokens with different tick sizes", () => {
    const tok1 = createTokenId("tok-batch-1");
    const tok2 = createTokenId("tok-batch-2");
    const now = new Date().toISOString();

    insertMarket(conn.db, String(tok1), 0.001);
    insertMarket(conn.db, String(tok2), 0.01);
    insertSnapshot(conn.db, String(tok1), 0.43, 0.55, now);
    insertSnapshot(conn.db, String(tok2), 0.25, 0.3, now);

    const result = repo.findLatestBboByTokens([tok1, tok2]);

    expect(result.get(String(tok1))!.tickSize).toBeCloseTo(0.001);
    expect(result.get(String(tok2))!.tickSize).toBeCloseTo(0.01);
  });
});

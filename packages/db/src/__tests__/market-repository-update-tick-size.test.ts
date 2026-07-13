/**
 * updateTickSize (Phase 1 authoritative-tick fix).
 *
 * Covers:
 *  - Updates tick_size for all tokens sharing the same condition_id.
 *  - Writes ONLY tick_size + updated_at — does NOT touch score columns,
 *    neg_risk, active, or any other column (narrow-write invariant).
 *  - Is idempotent (calling twice with the same tick produces a stable row).
 *  - Unknown condition_id is silently ignored (no throw, no phantom rows).
 *  - Independent conditions are not cross-contaminated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import { SqliteMarketRepository } from "../repositories/market-repository.js";
import { createTokenId } from "@krabs/domain";
import type { Market } from "@krabs/domain";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-tick-upd-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeMarket(tokenId: string, conditionId: string, tickSize = 0.001): Market {
  const now = "2026-07-13T00:00:00.000Z";
  return {
    tokenId: createTokenId(tokenId),
    conditionId,
    slug: `slug-${tokenId}`,
    eventSlug: null,
    question: "Q?",
    outcome: "YES",
    outcomeIndex: 0,
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize,
    negRisk: false,
    eventMarketCount: 1,
    selectionStatus: "unknown",
    selectionWinningRuleId: null,
    gammaCreatedAt: null,
    groupItemTitle: null,
    groupItemThreshold: null,
    tags: null,
    score: null,
    scoreModelVersion: null,
    scoredAt: null,
    featuresCapturedAt: null,
    sigMid: null,
    sigCheapMid: null,
    sigLiquidity: null,
    sigVol24h: null,
    sigFeaturesAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("SqliteMarketRepository.updateTickSize", () => {
  it("updates tick_size for all tokens under the same conditionId", () => {
    const conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
    try {
      const repo = new SqliteMarketRepository(conn.db);
      // YES and NO tokens share the same conditionId
      repo.saveBatch([
        makeMarket("tok-yes", "cond-1", 0.001),
        makeMarket("tok-no", "cond-1", 0.001),
      ]);

      repo.updateTickSize("cond-1", 0.01);

      const rows = conn.db
        .prepare("SELECT token_id, tick_size FROM markets WHERE condition_id = 'cond-1'")
        .all() as Array<{ token_id: string; tick_size: number }>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.tick_size).toBe(0.01);
      }
    } finally {
      conn.close();
    }
  });

  it("does not touch score columns, neg_risk, or active (narrow-write invariant)", () => {
    const conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
    try {
      const repo = new SqliteMarketRepository(conn.db);
      const m = makeMarket("tok-yes", "cond-2", 0.001);
      repo.save(m);
      // Write a score row first to verify it survives the tick update
      repo.updateScoresBatch([
        {
          tokenId: m.tokenId,
          score: 0.42,
          modelVersion: "v1",
          scoredAt: "2026-07-13T00:00:00.000Z",
          featuresCapturedAt: "2026-07-13T00:00:00.000Z",
        },
      ]);

      repo.updateTickSize("cond-2", 0.01);

      const row = conn.db
        .prepare(
          "SELECT tick_size, neg_risk, active, score FROM markets WHERE token_id = 'tok-yes'",
        )
        .get() as { tick_size: number; neg_risk: number; active: number; score: number };

      expect(row.tick_size).toBe(0.01);
      expect(row.neg_risk).toBe(0); // unchanged
      expect(row.active).toBe(1); // unchanged
      expect(row.score).toBeCloseTo(0.42); // score column NOT clobbered
    } finally {
      conn.close();
    }
  });

  it("is idempotent — calling twice with the same value is a no-op", () => {
    const conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
    try {
      const repo = new SqliteMarketRepository(conn.db);
      repo.save(makeMarket("tok-yes", "cond-3", 0.001));
      repo.updateTickSize("cond-3", 0.01);
      repo.updateTickSize("cond-3", 0.01);
      const row = conn.db
        .prepare("SELECT tick_size FROM markets WHERE token_id = 'tok-yes'")
        .get() as { tick_size: number };
      expect(row.tick_size).toBe(0.01);
    } finally {
      conn.close();
    }
  });

  it("silently ignores an unknown conditionId without throwing", () => {
    const conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
    try {
      const repo = new SqliteMarketRepository(conn.db);
      expect(() => repo.updateTickSize("nonexistent-cond", 0.01)).not.toThrow();
    } finally {
      conn.close();
    }
  });

  it("does not cross-contaminate independent conditions", () => {
    const conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
    try {
      const repo = new SqliteMarketRepository(conn.db);
      repo.saveBatch([makeMarket("tok-a", "cond-a", 0.001), makeMarket("tok-b", "cond-b", 0.001)]);

      repo.updateTickSize("cond-a", 0.01);

      const rowA = conn.db
        .prepare("SELECT tick_size FROM markets WHERE token_id = 'tok-a'")
        .get() as { tick_size: number };
      const rowB = conn.db
        .prepare("SELECT tick_size FROM markets WHERE token_id = 'tok-b'")
        .get() as { tick_size: number };

      expect(rowA.tick_size).toBe(0.01);
      expect(rowB.tick_size).toBe(0.001); // untouched
    } finally {
      conn.close();
    }
  });
});

/**
 * Score-distribution snapshot tests (Step 3, audit doc §D7 / §F6 / §P4).
 *
 * Covers:
 *   - Active-universe scoping (inactive rows excluded)
 *   - Step2 scoping (matched_include + step2_fallback_include only contribute
 *     to scored/step2NoScore/stale/histogram/mean/median)
 *   - skippedNonStep2Included = active rows with non-Step2 status
 *   - Stale detection via features_captured_at < now − 4h
 *   - Histogram bucket boundaries (0.0 → 1.0 in 10 buckets)
 *   - Median for odd / even N
 *   - modelVersion = most-frequent score_model_version among scored rows
 *   - Empty universe returns zero counts and null mean/median
 */

import { describe, it, expect, beforeEach } from "vitest";
import { bootstrapDatabase, type DbConnection } from "@plankton/db";
import { computeScoreDistributionSnapshot } from "../modules/soft-ranking/score-distribution-snapshot.js";

const NOW = new Date("2026-05-05T12:00:00Z");

function fixedNow(): Date {
  return NOW;
}

interface MarketRow {
  tokenId: string;
  active?: number;
  selectionStatus?: string;
  score?: number | null;
  modelVersion?: string | null;
  scoredAt?: string | null;
  featuresCapturedAt?: string | null;
}

function insertMarket(conn: DbConnection, row: MarketRow): void {
  conn.db
    .prepare(
      `INSERT INTO markets (
        token_id, condition_id, slug, question, outcome, tick_size, neg_risk,
        active, tradable, selection_status, score, score_model_version,
        scored_at, features_captured_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.tokenId,
      `cond-${row.tokenId}`,
      `slug-${row.tokenId}`,
      "q",
      "Yes",
      0.01,
      0,
      row.active ?? 1,
      1,
      row.selectionStatus ?? "matched_include",
      row.score ?? null,
      row.modelVersion ?? null,
      row.scoredAt ?? null,
      row.featuresCapturedAt ?? null,
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
    );
}

describe("computeScoreDistributionSnapshot", () => {
  let conn: DbConnection;

  beforeEach(() => {
    conn = bootstrapDatabase(":memory:");
  });

  it("returns zero counts and null mean/median on an empty universe", () => {
    const snap = computeScoreDistributionSnapshot(conn.db, fixedNow);
    expect(snap.scoredMarkets).toBe(0);
    expect(snap.step2IncludedNoScore).toBe(0);
    expect(snap.skippedNonStep2Included).toBe(0);
    expect(snap.staleMarkets).toBe(0);
    expect(snap.mean).toBeNull();
    expect(snap.median).toBeNull();
    expect(snap.modelVersion).toBeNull();
    expect(snap.histogram.length).toBe(10);
    expect(snap.histogram.every((b) => b.count === 0)).toBe(true);
    expect(snap.capturedAt).toBe(NOW.toISOString());
  });

  it("scopes scored counts to active=1 + Step2-included rows only", () => {
    insertMarket(conn, {
      tokenId: "a",
      score: 0.7,
      modelVersion: "v1",
      featuresCapturedAt: "2026-05-05T11:00:00Z",
    });
    insertMarket(conn, {
      tokenId: "b",
      selectionStatus: "step2_fallback_include",
      score: 0.5,
      modelVersion: "v1",
      featuresCapturedAt: "2026-05-05T11:00:00Z",
    });
    // Inactive row — should not contribute anywhere.
    insertMarket(conn, {
      tokenId: "c",
      active: 0,
      score: 0.9,
      modelVersion: "v1",
      featuresCapturedAt: "2026-05-05T11:00:00Z",
    });
    // Excluded selection — counts toward skippedNonStep2Included.
    insertMarket(conn, {
      tokenId: "d",
      selectionStatus: "matched_exclude",
      score: 0.99,
      modelVersion: "v1",
      featuresCapturedAt: "2026-05-05T11:00:00Z",
    });

    const snap = computeScoreDistributionSnapshot(conn.db, fixedNow);
    expect(snap.scoredMarkets).toBe(2);
    expect(snap.step2IncludedNoScore).toBe(0);
    expect(snap.skippedNonStep2Included).toBe(1);
    expect(snap.modelVersion).toBe("v1");
    expect(snap.mean).toBeCloseTo(0.6, 6);
    expect(snap.median).toBeCloseTo(0.6, 6); // (0.5 + 0.7) / 2
  });

  it("counts step2-included rows without a score under step2IncludedNoScore", () => {
    insertMarket(conn, { tokenId: "a", score: null }); // matched_include + null score
    insertMarket(conn, { tokenId: "b", selectionStatus: "step2_fallback_include", score: null });
    insertMarket(conn, {
      tokenId: "c",
      score: 0.4,
      modelVersion: "v1",
      featuresCapturedAt: "2026-05-05T11:00:00Z",
    });

    const snap = computeScoreDistributionSnapshot(conn.db, fixedNow);
    expect(snap.scoredMarkets).toBe(1);
    expect(snap.step2IncludedNoScore).toBe(2);
    expect(snap.skippedNonStep2Included).toBe(0);
  });

  it("flags stale rows via features_captured_at < now − 4h", () => {
    insertMarket(conn, {
      tokenId: "fresh",
      score: 0.6,
      modelVersion: "v1",
      featuresCapturedAt: "2026-05-05T10:00:00Z", // 2h ago — fresh
    });
    insertMarket(conn, {
      tokenId: "edge",
      score: 0.5,
      modelVersion: "v1",
      featuresCapturedAt: "2026-05-05T08:00:00Z", // exactly 4h ago — fresh (>=)
    });
    insertMarket(conn, {
      tokenId: "stale",
      score: 0.4,
      modelVersion: "v1",
      featuresCapturedAt: "2026-05-05T07:00:00Z", // 5h ago — stale
    });

    const snap = computeScoreDistributionSnapshot(conn.db, fixedNow);
    expect(snap.scoredMarkets).toBe(3);
    expect(snap.staleMarkets).toBe(1);
  });

  it("places scores into the correct decile buckets (boundaries)", () => {
    const samples: Array<[string, number]> = [
      ["t-000", 0.0],
      ["t-099", 0.099],
      ["t-100", 0.1],
      ["t-499", 0.499],
      ["t-500", 0.5],
      ["t-899", 0.899],
      ["t-900", 0.9],
      ["t-100p", 1.0],
    ];
    for (const [tokenId, score] of samples) {
      insertMarket(conn, {
        tokenId,
        score,
        modelVersion: "v1",
        featuresCapturedAt: "2026-05-05T11:00:00Z",
      });
    }

    const snap = computeScoreDistributionSnapshot(conn.db, fixedNow);
    const counts = snap.histogram.map((b) => b.count);
    // Buckets: [0,0.1) [0.1,0.2) [0.2,0.3) [0.3,0.4) [0.4,0.5) [0.5,0.6) [0.6,0.7) [0.7,0.8) [0.8,0.9) [0.9,1.0]
    expect(counts).toEqual([2, 1, 0, 0, 1, 1, 0, 0, 1, 2]);
    expect(snap.scoredMarkets).toBe(8);
  });

  it("computes median for odd N (single middle row)", () => {
    insertMarket(conn, {
      tokenId: "a",
      score: 0.1,
      modelVersion: "v1",
      featuresCapturedAt: "2026-05-05T11:00:00Z",
    });
    insertMarket(conn, {
      tokenId: "b",
      score: 0.4,
      modelVersion: "v1",
      featuresCapturedAt: "2026-05-05T11:00:00Z",
    });
    insertMarket(conn, {
      tokenId: "c",
      score: 0.9,
      modelVersion: "v1",
      featuresCapturedAt: "2026-05-05T11:00:00Z",
    });

    const snap = computeScoreDistributionSnapshot(conn.db, fixedNow);
    expect(snap.median).toBeCloseTo(0.4, 6);
  });

  it("returns the most-frequent model version", () => {
    insertMarket(conn, {
      tokenId: "a",
      score: 0.5,
      modelVersion: "v1",
      featuresCapturedAt: "2026-05-05T11:00:00Z",
    });
    insertMarket(conn, {
      tokenId: "b",
      score: 0.5,
      modelVersion: "v2",
      featuresCapturedAt: "2026-05-05T11:00:00Z",
    });
    insertMarket(conn, {
      tokenId: "c",
      score: 0.5,
      modelVersion: "v2",
      featuresCapturedAt: "2026-05-05T11:00:00Z",
    });

    const snap = computeScoreDistributionSnapshot(conn.db, fixedNow);
    expect(snap.modelVersion).toBe("v2");
  });
});

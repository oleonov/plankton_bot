/**
 * Score-distribution snapshot — Step 3 / P4 (audit doc §D7).
 *
 * Single SQL aggregation over `markets` scoped to the active universe. Counts
 * are derived from the DB (not in-memory module state) so:
 *   - `staleMarkets` updates as time passes even without new events;
 *   - restarts don't lose telemetry — the persisted markers survive.
 *
 * Universe scope = `active = 1` (D7: conservative; goal is operator
 * visibility, not perfect accounting). `step2*` aggregates filter to
 * `selection_status IN ('matched_include','step2_fallback_include')`;
 * `skippedNonStep2Included` counts the complement within the active universe.
 *
 * Timestamp comparison uses `datetime(features_captured_at)` to coerce ISO-8601
 * UTC values into the same comparable form as `datetime('now','-4 hours')`.
 */

import type Database from "better-sqlite3";

export interface ScoreDistributionBucket {
  /** 1-based decile index, 1 = lowest scores (0.0–0.1), 10 = highest (0.9–1.0). */
  readonly decile: number;
  readonly count: number;
}

export interface ScoreDistributionSnapshot {
  readonly modelVersion: string | null;
  readonly scoredMarkets: number;
  readonly step2IncludedNoScore: number;
  readonly skippedNonStep2Included: number;
  readonly staleMarkets: number;
  readonly histogram: readonly ScoreDistributionBucket[];
  readonly mean: number | null;
  readonly median: number | null;
  readonly capturedAt: string;
}

const STEP2_AGG_SQL = `
  WITH step2 AS (
    SELECT score, score_model_version, features_captured_at
    FROM markets
    WHERE active = 1
      AND selection_status IN ('matched_include','step2_fallback_include')
  )
  SELECT
    SUM(CASE WHEN score IS NOT NULL THEN 1 ELSE 0 END) AS scored,
    SUM(CASE WHEN score IS NULL THEN 1 ELSE 0 END)     AS step2_no_score,
    SUM(CASE
          WHEN score IS NOT NULL
            AND features_captured_at IS NOT NULL
            AND datetime(features_captured_at) < datetime(?, '-4 hours')
          THEN 1 ELSE 0 END)                            AS stale,
    AVG(CASE WHEN score IS NOT NULL THEN score END)    AS mean_score,
    SUM(CASE WHEN score >= 0.0 AND score < 0.1 THEN 1 ELSE 0 END) AS b1,
    SUM(CASE WHEN score >= 0.1 AND score < 0.2 THEN 1 ELSE 0 END) AS b2,
    SUM(CASE WHEN score >= 0.2 AND score < 0.3 THEN 1 ELSE 0 END) AS b3,
    SUM(CASE WHEN score >= 0.3 AND score < 0.4 THEN 1 ELSE 0 END) AS b4,
    SUM(CASE WHEN score >= 0.4 AND score < 0.5 THEN 1 ELSE 0 END) AS b5,
    SUM(CASE WHEN score >= 0.5 AND score < 0.6 THEN 1 ELSE 0 END) AS b6,
    SUM(CASE WHEN score >= 0.6 AND score < 0.7 THEN 1 ELSE 0 END) AS b7,
    SUM(CASE WHEN score >= 0.7 AND score < 0.8 THEN 1 ELSE 0 END) AS b8,
    SUM(CASE WHEN score >= 0.8 AND score < 0.9 THEN 1 ELSE 0 END) AS b9,
    SUM(CASE WHEN score >= 0.9 AND score <= 1.0 THEN 1 ELSE 0 END) AS b10
  FROM step2
`;

const SKIPPED_AGG_SQL = `
  SELECT COUNT(*) AS skipped
  FROM markets
  WHERE active = 1
    AND (
      selection_status IS NULL
      OR selection_status NOT IN ('matched_include','step2_fallback_include')
    )
`;

// Scoped to the Step2-included population so the reported `modelVersion` is
// the dominant version of the rows that produced the histogram + counts. An
// active-but-non-Step2 row carrying a different version (left over from a
// previous selection-rule revision) must not mislead the snapshot.
const MODEL_VERSION_SQL = `
  SELECT score_model_version AS modelVersion
  FROM markets
  WHERE active = 1
    AND selection_status IN ('matched_include','step2_fallback_include')
    AND score IS NOT NULL
    AND score_model_version IS NOT NULL
  GROUP BY score_model_version
  ORDER BY COUNT(*) DESC
  LIMIT 1
`;

const MEDIAN_SQL_TEMPLATE = (count: number, offset: number): string => `
  SELECT score
  FROM markets
  WHERE active = 1
    AND selection_status IN ('matched_include','step2_fallback_include')
    AND score IS NOT NULL
  ORDER BY score ASC
  LIMIT ${count} OFFSET ${offset}
`;

interface AggregateRow {
  scored: number | null;
  step2_no_score: number | null;
  stale: number | null;
  mean_score: number | null;
  b1: number | null;
  b2: number | null;
  b3: number | null;
  b4: number | null;
  b5: number | null;
  b6: number | null;
  b7: number | null;
  b8: number | null;
  b9: number | null;
  b10: number | null;
}

function nz(v: number | null | undefined): number {
  return v == null ? 0 : v;
}

function computeMedian(db: Database.Database, scoredCount: number): number | null {
  if (scoredCount === 0) return null;
  if (scoredCount % 2 === 1) {
    const offset = Math.floor(scoredCount / 2);
    const row = db.prepare(MEDIAN_SQL_TEMPLATE(1, offset)).get() as { score: number } | undefined;
    return row?.score ?? null;
  }
  const offset = scoredCount / 2 - 1;
  const rows = db.prepare(MEDIAN_SQL_TEMPLATE(2, offset)).all() as Array<{ score: number }>;
  if (rows.length !== 2) return null;
  return (rows[0]!.score + rows[1]!.score) / 2;
}

export function computeScoreDistributionSnapshot(
  db: Database.Database,
  now: () => Date = () => new Date(),
): ScoreDistributionSnapshot {
  const nowIso = now().toISOString();
  const agg = db.prepare(STEP2_AGG_SQL).get(nowIso) as AggregateRow;
  const skippedRow = db.prepare(SKIPPED_AGG_SQL).get() as { skipped: number };
  const versionRow = db.prepare(MODEL_VERSION_SQL).get() as
    | { modelVersion: string | null }
    | undefined;

  const scored = nz(agg.scored);
  const histogram: ScoreDistributionBucket[] = [
    { decile: 1, count: nz(agg.b1) },
    { decile: 2, count: nz(agg.b2) },
    { decile: 3, count: nz(agg.b3) },
    { decile: 4, count: nz(agg.b4) },
    { decile: 5, count: nz(agg.b5) },
    { decile: 6, count: nz(agg.b6) },
    { decile: 7, count: nz(agg.b7) },
    { decile: 8, count: nz(agg.b8) },
    { decile: 9, count: nz(agg.b9) },
    { decile: 10, count: nz(agg.b10) },
  ];

  return {
    modelVersion: versionRow?.modelVersion ?? null,
    scoredMarkets: scored,
    step2IncludedNoScore: nz(agg.step2_no_score),
    skippedNonStep2Included: nz(skippedRow.skipped),
    staleMarkets: nz(agg.stale),
    histogram,
    mean: agg.mean_score == null ? null : Number(agg.mean_score),
    median: computeMedian(db, scored),
    capturedAt: nowIso,
  };
}

export const SCORE_DISTRIBUTION_METRIC_NAME = "score_distribution";

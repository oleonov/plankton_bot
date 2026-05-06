import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { SCORE_DISTRIBUTION_METRIC_NAME } from "./modules/soft-ranking/score-distribution-snapshot.js";

// ADR-020 §D4 score-column ownership invariant. When the soft-ranking
// artifact is missing or invalid the module enters disabled-no-op; this
// helper performs the two cleanups required by the disabled-state contract:
//   1. Delete the latest persisted score-distribution snapshot so the API
//      does not serve stale data as if it were current.
//   2. NULL out all four score-ownership columns
//      (`score`, `score_model_version`, `scored_at`, `features_captured_at`)
//      so `effectiveScore` in the repository ranking cannot keep returning
//      leftover values from before the disable.
export function softRankingDisabledCleanup(db: Database.Database, log: Logger): void {
  try {
    db.prepare("DELETE FROM runtime_metrics WHERE metric_name = ?").run(
      SCORE_DISTRIBUTION_METRIC_NAME,
    );
  } catch (err) {
    log.warn({ err }, "score_distribution disabled-state cleanup failed");
  }
  try {
    const result = db
      .prepare(
        "UPDATE markets SET score = NULL, score_model_version = NULL, scored_at = NULL, features_captured_at = NULL WHERE score IS NOT NULL OR score_model_version IS NOT NULL OR scored_at IS NOT NULL OR features_captured_at IS NOT NULL",
      )
      .run();
    if (result.changes > 0) {
      log.info({ rows: result.changes }, "soft_ranking_disabled_score_columns_cleared");
    }
  } catch (err) {
    log.warn({ err }, "soft_ranking_disabled_score_columns_clear_failed");
  }
}

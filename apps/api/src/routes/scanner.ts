/**
 * Scanner-side telemetry routes.
 *
 * `GET /scanner/score-distribution` — Step 3 / P4 (audit doc §D7 / §F6).
 * Reads the latest `score_distribution` row written by `SoftRankingScoreModule`
 * from `runtime_metrics`. The API process has no live runtime-module reference
 * (different process), so the DB is the cross-process source of truth.
 *
 * Profile-aware: resolves the ledger DB for the currently active profile via
 * `runtime_control_state.current_profile` + `LedgerPool`, falling back to the
 * server's startup-fixed ledger when control.db / pool aren't available
 * (legacy/test paths). This mirrors the pattern in `routes/status.ts` so a
 * post-startup profile switch keeps `/score-distribution` honest.
 *
 * Returns 503 if no snapshot has been written yet — this is the pre-first-flush
 * state and the rollback state when the soft-ranking module is disabled (no
 * artifact). Operators can disambiguate via the runtime healthcheck.
 */

import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok, fail } from "../errors.js";
import type { LedgerPool } from "../ledger-pool.js";
import { resolveActiveLedger } from "../active-ledger.js";

interface ScannerOpts {
  ledgerDb: Database.Database;
  controlDb?: Database.Database;
  ledgerPool?: LedgerPool;
}

const SCORE_DISTRIBUTION_METRIC_NAME = "score_distribution";

export const scannerRoutes: FastifyPluginAsync<ScannerOpts> = async (app, opts) => {
  const { ledgerDb, controlDb, ledgerPool } = opts;

  app.get("/scanner/score-distribution", async (_req, reply) => {
    const { db: ledger } = resolveActiveLedger(ledgerDb, controlDb, ledgerPool);
    const row = ledger
      .prepare(
        "SELECT labels, captured_at FROM runtime_metrics WHERE metric_name = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
      )
      .get(SCORE_DISTRIBUTION_METRIC_NAME) as
      | { labels: string | null; captured_at: string }
      | undefined;
    if (!row || !row.labels) {
      return reply.code(503).send(fail("NO_SNAPSHOT", "score-distribution snapshot unavailable"));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.labels);
    } catch {
      return reply
        .code(503)
        .send(fail("CORRUPT_SNAPSHOT", "score-distribution snapshot is not valid JSON"));
    }
    return reply.send(ok(parsed));
  });
};

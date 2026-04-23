import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import type { LedgerPool } from "../ledger-pool.js";
import { ok } from "../errors.js";
import { resolveActiveLedger } from "./status.js";

interface DriftOpts {
  db: Database.Database;
  controlDb?: Database.Database;
  ledgerPool?: LedgerPool;
}

interface PositionDriftRow {
  settlement_id: string;
  token_id: string;
  condition_id: string;
  detected_at: string;
  on_chain_balance: string;
  last_checked_at: string;
  status: "open" | "resolved";
  created_at: string;
}

export const driftRoutes: FastifyPluginAsync<DriftOpts> = async (app, opts) => {
  app.get("/drift", async (_request) => {
    const { db } = resolveActiveLedger(opts.db, opts.controlDb, opts.ledgerPool);
    const rows = db
      .prepare(
        `SELECT settlement_id, token_id, condition_id, detected_at,
                on_chain_balance, last_checked_at, status, created_at
           FROM position_drifts
          WHERE status = 'open'
          ORDER BY detected_at DESC
          LIMIT 200`,
      )
      .all() as PositionDriftRow[];

    return ok({
      items: rows.map((row) => ({
        settlementId: row.settlement_id,
        tokenId: row.token_id,
        conditionId: row.condition_id,
        detectedAt: row.detected_at,
        onChainBalance: row.on_chain_balance,
        lastCheckedAt: row.last_checked_at,
        status: row.status,
      })),
      totalCount: rows.length,
    });
  });
};

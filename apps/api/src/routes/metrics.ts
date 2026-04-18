import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { computeExecutionTelemetry } from "../execution-telemetry.js";
import { ok, fail } from "../errors.js";
import type { LedgerPool } from "../ledger-pool.js";

interface MetricsOpts {
  ledgerDb: Database.Database;
  ledgerPool?: LedgerPool;
}

export const metricsRoutes: FastifyPluginAsync<MetricsOpts> = async (app, opts) => {
  const { ledgerDb, ledgerPool } = opts;

  app.get("/metrics", async () => {
    const positions = ledgerDb
      .prepare("SELECT status, COUNT(*) as cnt FROM positions GROUP BY status")
      .all() as Array<{ status: string; cnt: number }>;

    const orders = ledgerDb
      .prepare("SELECT status, COUNT(*) as cnt FROM orders GROUP BY status")
      .all() as Array<{ status: string; cnt: number }>;

    const totalFills = ledgerDb
      .prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(size_usdc),0) as volume FROM fills")
      .get() as { cnt: number; volume: number };

    const pnl = ledgerDb
      .prepare("SELECT COALESCE(SUM(realized_pnl),0) as total FROM positions")
      .get() as { total: number };

    const executionTelemetry = computeExecutionTelemetry(ledgerDb);

    return ok({
      positions: Object.fromEntries(positions.map((r) => [r.status, r.cnt])),
      orders: Object.fromEntries(orders.map((r) => [r.status, r.cnt])),
      fills: {
        count: totalFills.cnt,
        volumeUsdc: totalFills.volume,
        makerCount: executionTelemetry.makerFills,
        takerCount: executionTelemetry.takerFills,
        unknownCount: executionTelemetry.unknownFills,
        explicitFeesUsdc: executionTelemetry.explicitFeesUsdc,
        feeLeakageRatio: executionTelemetry.feeLeakageRatio,
      },
      totalRealizedPnl: pnl.total,
    });
  });

  // ── GET /metrics/events ───────────────────────────────────────────────
  // Aggregate PnL + volume grouped by event_slug.
  // Per-profile: resolves the ledger via ledgerPool when profileId is provided,
  // otherwise falls back to the startup ledgerDb.
  app.get("/metrics/events", async (req, reply) => {
    const { profileId, limit } = req.query as { profileId?: string; limit?: string };
    if (!profileId) return reply.code(400).send(fail("BAD_REQUEST", "profileId required"));
    const db = ledgerPool?.get(profileId) ?? null;
    if (!db) return reply.code(404).send(fail("LEDGER_NOT_FOUND", `no ledger for profile ${profileId}`));
    const cap = Math.min(Number(limit ?? 20), 100);
    const rows = db
      .prepare(
        `SELECT m.event_slug AS eventSlug,
                SUM(p.realized_pnl) AS realizedPnl,
                SUM(p.current_value_usdc - p.cost_basis_usdc) AS unrealizedPnl,
                SUM(p.cost_basis_usdc) AS volumeUsdc,
                COUNT(*) AS positionCount
         FROM positions p
         JOIN markets m ON m.token_id = p.token_id
         WHERE m.event_slug IS NOT NULL
         GROUP BY m.event_slug
         ORDER BY ABS(IFNULL(SUM(p.realized_pnl),0) + IFNULL(SUM(p.current_value_usdc - p.cost_basis_usdc),0)) DESC
         LIMIT ?`,
      )
      .all(cap);
    return reply.send(ok({ events: rows }));
  });
};

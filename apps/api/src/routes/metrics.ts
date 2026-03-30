import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok } from "../errors.js";

interface MetricsOpts {
  controlDb: Database.Database;
  ledgerDb: Database.Database;
}

export const metricsRoutes: FastifyPluginAsync<MetricsOpts> = async (app, opts) => {
  const { ledgerDb } = opts;

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

    return ok({
      positions: Object.fromEntries(positions.map((r) => [r.status, r.cnt])),
      orders: Object.fromEntries(orders.map((r) => [r.status, r.cnt])),
      fills: { count: totalFills.cnt, volumeUsdc: totalFills.volume },
      totalRealizedPnl: pnl.total,
    });
  });

  app.get("/metrics/families", async () => {
    const rows = ledgerDb
      .prepare(
        `SELECT fs.family_id, fs.runtime_mode, fs.open_value_usdc,
                fs.open_position_count, fs.tail_adjusted_pnl_live,
                fs.quarantine_reason, fs.updated_at
         FROM family_runtime_state fs
         ORDER BY fs.open_value_usdc DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    return ok(
      rows.map((r) => ({
        familyId: r.family_id,
        runtimeMode: r.runtime_mode,
        openValueUsdc: r.open_value_usdc,
        openPositionCount: r.open_position_count,
        tailAdjustedPnlLive: r.tail_adjusted_pnl_live,
        quarantineReason: r.quarantine_reason,
        effectiveMode: (r.effective_mode as string | null) ?? null,
        derivedModeReason: (r.derived_mode_reason as string | null) ?? null,
        updatedAt: r.updated_at,
      })),
    );
  });
};

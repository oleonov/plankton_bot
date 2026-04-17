import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import {
  computeExecutionTelemetry,
  computeExecutionTelemetryByFamily,
  emptyExecutionTelemetry,
} from "../execution-telemetry.js";
import { ok } from "../errors.js";

interface MetricsOpts {
  controlDb: Database.Database;
  ledgerDb: Database.Database;
}

export const metricsRoutes: FastifyPluginAsync<MetricsOpts> = async (app, opts) => {
  const { controlDb, ledgerDb } = opts;

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

  app.get("/metrics/families", async () => {
    const executionMap24h = computeExecutionTelemetryByFamily(ledgerDb, {
      sinceIso: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const catalogRows = controlDb.prepare("SELECT * FROM family_catalog").all() as Array<
      Record<string, unknown>
    >;
    const catalogMap = new Map(catalogRows.map((row) => [row.family_id, row]));
    const rows = ledgerDb
      .prepare(
        `SELECT fs.family_id, fs.open_value_usdc,
                fs.open_position_count, fs.tail_adjusted_pnl_live,
                fs.updated_at
         FROM family_runtime_state fs
         ORDER BY fs.open_value_usdc DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    return ok(
      rows.map((r) => {
        const catalog = catalogMap.get(String(r.family_id));
        return {
          familyId: r.family_id,
          familyKey: catalog?.family_key ?? String(r.family_id),
          feeTier: catalog?.fee_tier ?? null,
          requiresPostOnlyForLive:
            catalog?.requires_post_only_for_live == null
              ? null
              : catalog.requires_post_only_for_live === 1,
          openValueUsdc: r.open_value_usdc,
          openPositionCount: r.open_position_count,
          tailAdjustedPnlLive: r.tail_adjusted_pnl_live,
          executionTelemetry24h: {
            windowHours: 24,
            ...(executionMap24h.get(String(r.family_id)) ?? emptyExecutionTelemetry()),
          },
          updatedAt: r.updated_at,
        };
      }),
    );
  });
};

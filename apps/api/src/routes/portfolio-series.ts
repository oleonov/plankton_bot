import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok } from "../errors.js";

interface PortfolioSeriesOpts {
  db: Database.Database;
  controlDb?: Database.Database;
}

export const portfolioSeriesRoutes: FastifyPluginAsync<PortfolioSeriesOpts> = async (app, opts) => {
  const { db, controlDb } = opts;

  app.get<{ Querystring: { interval?: string } }>("/metrics/portfolio-series", async (request) => {
    const interval = request.query.interval ?? "1d";

    // Resolve current profile
    let profile: string | null = null;
    if (controlDb) {
      try {
        const row = controlDb
          .prepare("SELECT current_profile FROM runtime_control_state WHERE id = 1")
          .get() as { current_profile: string | null } | undefined;
        profile = row?.current_profile ?? null;
      } catch {
        /* legacy DBs without runtime_control_state */
      }
    }
    const effectiveProfile = profile ?? "simulation";

    // Rolling windows with downsampling
    const bucketMinutes: Record<string, number> = {
      "1d": 5,
      "1w": 15,
      "1m": 60,
      all: 360,
    };
    const sinceMap: Record<string, string> = {
      "1d": "-1 day",
      "1w": "-7 days",
      "1m": "-30 days",
      all: "-90 days",
    };
    const since = sinceMap[interval] ?? "-1 day";
    const bucket = bucketMinutes[interval] ?? 5;

    // Downsampled series: last snapshot per time bucket
    const items = db
      .prepare(
        `SELECT ps.equity_usdc, ps.realized_pnl_usdc, ps.position_value_usdc, ps.captured_at
         FROM portfolio_snapshots ps
         INNER JOIN (
           SELECT MAX(id) as max_id
           FROM portfolio_snapshots
           WHERE profile = ? AND captured_at >= datetime('now', ?)
           GROUP BY strftime('%Y-%m-%d', captured_at) || 'T' ||
             printf('%02d', (CAST(strftime('%H', captured_at) AS INTEGER) * 60
               + CAST(strftime('%M', captured_at) AS INTEGER)) / ?)
         ) b ON ps.id = b.max_id
         ORDER BY ps.captured_at ASC`,
      )
      .all(effectiveProfile, since, bucket) as Array<{
      equity_usdc: number;
      realized_pnl_usdc: number;
      position_value_usdc: number;
      captured_at: string;
    }>;

    // Baseline: exact first raw snapshot in window
    const baselineRow = db
      .prepare(
        `SELECT equity_usdc FROM portfolio_snapshots
         WHERE profile = ? AND captured_at >= datetime('now', ?)
         ORDER BY captured_at ASC LIMIT 1`,
      )
      .get(effectiveProfile, since) as { equity_usdc: number } | undefined;

    // Fallback to initial_balance_usdc from profile_settings
    let initialBalance = 0;
    if (!baselineRow && controlDb) {
      try {
        const settingsRow = controlDb
          .prepare("SELECT initial_balance_usdc FROM profile_settings WHERE profile_id = ?")
          .get(effectiveProfile) as { initial_balance_usdc: number | null } | undefined;
        initialBalance = settingsRow?.initial_balance_usdc ?? 0;
      } catch {
        /* legacy DBs without profile_settings */
      }
    }

    const baseline = baselineRow?.equity_usdc ?? initialBalance;
    const currentEquity = items.length > 0 ? items[items.length - 1]!.equity_usdc : baseline;

    return ok({
      items: items.map((p) => ({
        equityUsdc: p.equity_usdc,
        realizedPnlUsdc: p.realized_pnl_usdc,
        positionValueUsdc: p.position_value_usdc,
        capturedAt: p.captured_at,
      })),
      baseline,
      currentEquity,
      portfolioPnl: currentEquity - baseline,
      interval,
    });
  });
};

import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok } from "../errors.js";

interface PnlSeriesOpts {
  db: Database.Database;
}

interface PnlSeriesQuery {
  days?: string;
}

interface DailyBucket {
  date: string;
  daily_pnl: number;
}

export const pnlSeriesRoutes: FastifyPluginAsync<PnlSeriesOpts> = async (app, opts) => {
  app.get<{ Querystring: PnlSeriesQuery }>("/metrics/pnl-series", async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 14, 1), 90);

    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString();

    const rows = opts.db
      .prepare(
        `SELECT date(filled_at) AS date, SUM(delta) AS daily_pnl
         FROM pnl_ledger
         WHERE filled_at >= ?
         GROUP BY date(filled_at)
         ORDER BY date(filled_at)`,
      )
      .all(sinceStr) as DailyBucket[];

    // Compute cumulative sum
    let cumulative = 0;
    const items = rows.map((row) => {
      cumulative += row.daily_pnl;
      return { date: row.date, realizedPnl: cumulative };
    });

    return ok({ items });
  });
};

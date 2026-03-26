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
    since.setUTCHours(0, 0, 0, 0);
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

    // Start from pre-window cumulative so the chart reflects total realized PnL
    const preWindow = opts.db
      .prepare(`SELECT COALESCE(SUM(delta), 0) AS total FROM pnl_ledger WHERE filled_at < ?`)
      .get(sinceStr) as { total: number };
    let cumulative = preWindow.total;
    const items = rows.map((row) => {
      cumulative += row.daily_pnl;
      return { date: row.date, realizedPnl: cumulative };
    });

    // Prepend a $0 baseline point when the chart would otherwise start mid-air.
    // Only when there's no pre-window PnL and at least one data point.
    if (preWindow.total === 0 && items.length > 0) {
      const firstDate = new Date(items[0]!.date + "T00:00:00Z");
      firstDate.setUTCDate(firstDate.getUTCDate() - 1);
      const baselineDate = firstDate.toISOString().slice(0, 10);
      items.unshift({ date: baselineDate, realizedPnl: 0 });
    }

    return ok({ items });
  });
};

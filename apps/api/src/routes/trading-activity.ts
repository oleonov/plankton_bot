import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok } from "../errors.js";

interface TradingActivityOpts {
  db: Database.Database;
}

interface TradingActivityQuery {
  days?: string;
}

interface SnapshotRow {
  trading_state: string;
  signals_produced: number;
  signals_approved: number;
  signals_rejected: number;
  captured_at: string;
}

export const tradingActivityRoutes: FastifyPluginAsync<TradingActivityOpts> = async (app, opts) => {
  app.get<{ Querystring: TradingActivityQuery }>("/metrics/trading-activity", async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 14, 1), 14);

    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString();

    const rows = opts.db
      .prepare(
        `SELECT trading_state, signals_produced, signals_approved, signals_rejected, captured_at
         FROM trading_state_snapshots
         WHERE captured_at >= ?
         ORDER BY captured_at ASC`,
      )
      .all(sinceStr) as SnapshotRow[];

    const items = rows.map((r) => ({
      tradingState: r.trading_state,
      signalsProduced: r.signals_produced,
      signalsApproved: r.signals_approved,
      signalsRejected: r.signals_rejected,
      capturedAt: r.captured_at,
    }));

    return ok({ items });
  });
};

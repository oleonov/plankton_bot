import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ledgerInstant } from "@krabs/db";
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

    // Both sides go through `ledgerInstant()`: the bind is an ISO instant, while
    // `captured_at TEXT NOT NULL DEFAULT (datetime('now'))` survives on the production table
    // (SQLite has no `ALTER COLUMN … SET DEFAULT`), so a writer that omits the column would
    // render space-form — and ' ' (0x20) < 'T' (0x54) puts every such row below every same-day
    // ISO bind, silently dropping it from the window and mis-ordering the series. Cold route
    // over a table 14-day retention caps at ~2k rows, so losing the index seek costs nothing.
    const rows = opts.db
      .prepare(
        `SELECT trading_state, signals_produced, signals_approved, signals_rejected, captured_at
         FROM trading_state_snapshots
         WHERE ${ledgerInstant("captured_at")} >= ${ledgerInstant("?")}
         ORDER BY ${ledgerInstant("captured_at")} ASC`,
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

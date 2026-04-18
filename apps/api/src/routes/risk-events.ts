import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok } from "../errors.js";
import { normalizeRiskEvent } from "./normalize-risk-event.js";

interface RiskEventsOpts {
  db: Database.Database;
}

interface RiskEventQuery {
  event_type?: string;
  limit?: string;
  cursor?: string;
  page?: string;
}

export const riskEventsRoutes: FastifyPluginAsync<RiskEventsOpts> = async (app, opts) => {
  app.get<{ Querystring: RiskEventQuery }>("/risk-events", async (request) => {
    const { event_type, cursor } = request.query;
    const limit = Math.min(Number(request.query.limit) || 50, 200);
    const page = Math.max(Number(request.query.page) || 1, 1);
    const pageRequested = request.query.page != null;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (event_type) {
      conditions.push("event_type = ?");
      params.push(event_type);
    }

    if (!pageRequested && cursor) {
      conditions.push("id < ?");
      params.push(Number(cursor));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = opts.db
      .prepare(`SELECT COUNT(*) as cnt FROM risk_events ${where}`)
      .get(...params) as { cnt: number };
    const totalCount = countRow.cnt;

    const offset = pageRequested ? (page - 1) * limit : 0;
    const queryParams = [...params, limit];
    const offsetClause = pageRequested ? " OFFSET ?" : "";
    if (pageRequested) queryParams.push(offset);

    const rows = opts.db
      .prepare(`SELECT * FROM risk_events ${where} ORDER BY id DESC LIMIT ?${offsetClause}`)
      .all(...queryParams) as Array<{
      id: number;
      event_type: string;
      payload: string;
      created_at: string;
    }>;

    const items = rows.map(normalizeRiskEvent);
    const nextCursor =
      !pageRequested && rows.length === limit ? String(rows[rows.length - 1]!.id) : null;

    return ok({
      items,
      nextCursor,
      totalCount,
      page: pageRequested ? page : undefined,
      pageSize: pageRequested ? limit : undefined,
      totalPages: pageRequested ? Math.max(1, Math.ceil(totalCount / limit)) : undefined,
    });
  });
};

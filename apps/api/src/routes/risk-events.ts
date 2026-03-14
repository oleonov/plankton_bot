import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok } from "../errors.js";
import { normalizeRiskEvent } from "./normalize-risk-event.js";

interface RiskEventsOpts {
  db: Database.Database;
}

interface RiskEventQuery {
  family_id?: string;
  event_type?: string;
  limit?: string;
  cursor?: string;
}

export const riskEventsRoutes: FastifyPluginAsync<RiskEventsOpts> = async (app, opts) => {
  app.get<{ Querystring: RiskEventQuery }>("/risk-events", async (request) => {
    const { family_id, event_type, cursor } = request.query;
    const limit = Math.min(Number(request.query.limit) || 50, 200);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (family_id) {
      conditions.push("family_id = ?");
      params.push(family_id);
    }

    if (event_type) {
      conditions.push("event_type = ?");
      params.push(event_type);
    }

    if (cursor) {
      conditions.push("id < ?");
      params.push(Number(cursor));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const rows = opts.db
      .prepare(`SELECT * FROM risk_events ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params) as Array<{
        id: number;
        event_type: string;
        family_id: string | null;
        payload: string;
        created_at: string;
      }>;

    const items = rows.map(normalizeRiskEvent);
    const nextCursor = rows.length === limit
      ? String(rows[rows.length - 1]!.id)
      : null;

    return ok({ items, nextCursor });
  });
};

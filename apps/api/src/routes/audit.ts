import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok } from "../errors.js";

interface AuditOpts {
  controlDb: Database.Database;
}

export const auditRoutes: FastifyPluginAsync<AuditOpts> = async (app, opts) => {
  const { controlDb } = opts;

  // ── GET /audit ───────────────────────────────────────────────────────
  app.get("/audit", async (request) => {
    const { limit = "50", cursor, type, profile, familyId } = request.query as Record<
      string,
      string | undefined
    >;
    const lim = Math.min(Number(limit) || 50, 200);

    let where = "WHERE 1=1";
    const params: unknown[] = [];

    if (cursor) {
      where += " AND t.created_at < ?";
      params.push(cursor);
    }
    if (type) {
      where += " AND t.trigger_type = ?";
      params.push(type);
    }
    if (profile) {
      where += " AND t.profile = ?";
      params.push(profile);
    }
    if (familyId) {
      where += " AND t.entity_id = ?";
      params.push(familyId);
    }

    params.push(lim + 1);

    const rows = controlDb
      .prepare(
        `SELECT id, entity_type, entity_id, from_state, to_state,
                trigger_type, initiator, reason, profile, created_at
         FROM state_transitions t
         ${where}
         ORDER BY t.created_at DESC
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    const hasMore = rows.length > lim;
    const items = hasMore ? rows.slice(0, lim) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]!.created_at as string) : null;

    return ok({ items, nextCursor });
  });
};

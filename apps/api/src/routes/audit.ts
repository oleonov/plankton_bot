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
    const {
      limit = "50",
      cursor,
      page,
      type,
      profile,
      familyId,
    } = request.query as Record<string, string | undefined>;
    const lim = Math.min(Number(limit) || 50, 200);
    const pageNum = Math.max(Number(page) || 1, 1);
    const pageRequested = page != null;

    let where = "WHERE 1=1";
    const params: unknown[] = [];

    if (!pageRequested && cursor) {
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

    const totalCount = (
      controlDb
        .prepare(`SELECT COUNT(*) as cnt FROM state_transitions t ${where}`)
        .get(...params) as { cnt: number }
    ).cnt;

    const queryParams = [...params, pageRequested ? lim : lim + 1];
    const offsetClause = pageRequested ? " OFFSET ?" : "";
    if (pageRequested) {
      queryParams.push((pageNum - 1) * lim);
    }

    const rows = controlDb
      .prepare(
        `SELECT id, entity_type, entity_id, from_state, to_state,
                trigger_type, initiator, reason, profile, created_at
         FROM state_transitions t
         ${where}
         ORDER BY t.created_at DESC
         LIMIT ?${offsetClause}`,
      )
      .all(...queryParams) as Array<Record<string, unknown>>;

    const hasMore = !pageRequested && rows.length > lim;
    const items = hasMore ? rows.slice(0, lim) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]!.created_at as string) : null;

    return ok({
      items,
      nextCursor,
      totalCount,
      page: pageRequested ? pageNum : undefined,
      pageSize: pageRequested ? lim : undefined,
      totalPages: pageRequested ? Math.max(1, Math.ceil(totalCount / lim)) : undefined,
    });
  });
};

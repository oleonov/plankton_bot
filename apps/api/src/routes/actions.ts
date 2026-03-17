import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok, ApiError } from "../errors.js";

interface ActionOpts {
  db: Database.Database;
}

function insertCommand(
  db: Database.Database,
  action: string,
  targetId: string | null,
  reason: string | null,
): number {
  const info = db
    .prepare(
      `INSERT INTO operator_commands
         (action, target_id, reason, status, created_at, applied_at)
       VALUES (?, ?, ?, 'pending', ?, NULL)`,
    )
    .run(action, targetId, reason, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export const actionRoutes: FastifyPluginAsync<ActionOpts> = async (app, opts) => {
  // Global actions
  app.post<{ Body: { reason?: string } }>("/actions/pause", async (request) => {
    const body = (request.body ?? {}) as { reason?: string };
    const id = insertCommand(opts.db, "pause", null, body.reason ?? null);
    return ok({ commandId: id, status: "enqueued" });
  });

  app.post<{ Body: { reason?: string } }>("/actions/resume", async (request) => {
    const body = (request.body ?? {}) as { reason?: string };
    const id = insertCommand(opts.db, "resume", null, body.reason ?? null);
    return ok({ commandId: id, status: "enqueued" });
  });

  // Family-scoped actions
  for (const [path, action] of [
    ["reduce-only", "family_reduce_only"],
    ["quarantine", "family_quarantine"],
    ["activate", "family_activate"],
  ] as const) {
    app.post<{ Params: { familyId: string }; Body: { reason?: string } }>(
      `/actions/family/:familyId/${path}`,
      async (request) => {
        const { familyId } = request.params;

        // Validate family exists
        const exists = opts.db
          .prepare("SELECT 1 FROM family_catalog WHERE family_id = ?")
          .get(familyId);
        if (!exists) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");

        const body = (request.body ?? {}) as { reason?: string };
        const id = insertCommand(opts.db, action, familyId, body.reason ?? null);
        return ok({ commandId: id, status: "enqueued" });
      },
    );
  }
};

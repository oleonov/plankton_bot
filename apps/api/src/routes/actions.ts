import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok, ApiError } from "../errors.js";
import { getActor } from "../auth.js";

interface ActionOpts {
  db: Database.Database;
}

function insertCommand(
  db: Database.Database,
  action: string,
  targetId: string | null,
  reason: string | null,
  actor: string = "operator",
): number {
  const info = db
    .prepare(
      `INSERT INTO operator_commands
         (action, target_id, reason, initiator_type, initiator, status, created_at, applied_at)
       VALUES (?, ?, ?, 'operator', ?, 'pending', ?, NULL)`,
    )
    .run(action, targetId, reason, actor, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export const actionRoutes: FastifyPluginAsync<ActionOpts> = async (app, opts) => {
  // Global actions
  app.post<{ Body: { reason?: string } }>("/actions/pause", async (request) => {
    const body = (request.body ?? {}) as { reason?: string };
    const actor = getActor(request);
    const id = insertCommand(opts.db, "pause", null, body.reason ?? null, actor);
    return ok({ commandId: id, status: "enqueued" });
  });

  app.post<{ Body: { reason?: string } }>("/actions/resume", async (request) => {
    const body = (request.body ?? {}) as { reason?: string };
    const actor = getActor(request);
    const id = insertCommand(opts.db, "resume", null, body.reason ?? null, actor);
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
        const actor = getActor(request);
        const id = insertCommand(opts.db, action, familyId, body.reason ?? null, actor);
        return ok({ commandId: id, status: "enqueued" });
      },
    );
  }

  // ── POST /actions/family/:familyId/promote ─────────────────────────────
  app.post<{ Params: { familyId: string }; Body: { reason?: string } }>(
    "/actions/family/:familyId/promote",
    async (request) => {
      const { familyId } = request.params;
      const exists = opts.db
        .prepare("SELECT 1 FROM family_catalog WHERE family_id = ?")
        .get(familyId);
      if (!exists) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");

      const actor = getActor(request);
      const result = opts.db.transaction(() => {
        const info = opts.db
          .prepare(
            `UPDATE promotion_proposals
             SET status = 'approved', resolved_at = datetime('now'), resolved_by = ?
             WHERE family_id = ? AND status = 'pending'`,
          )
          .run(actor, familyId);
        if (info.changes === 0) {
          throw new ApiError(
            409,
            `no pending promotion proposal for family ${familyId}`,
            "NO_PENDING_PROPOSAL",
          );
        }

        const proposal = opts.db
          .prepare(
            `SELECT id FROM promotion_proposals
             WHERE family_id = ? AND status = 'approved'
             ORDER BY resolved_at DESC LIMIT 1`,
          )
          .get(familyId) as { id: number };

        const commandId = insertCommand(
          opts.db,
          "family_promote_scaled",
          familyId,
          (request.body as { reason?: string })?.reason ?? null,
          actor,
        );

        opts.db
          .prepare("UPDATE promotion_proposals SET applied_command_id = ? WHERE id = ?")
          .run(commandId, proposal.id);

        return { commandId, proposalId: proposal.id };
      }).immediate();

      return ok(result);
    },
  );

  // ── POST /actions/family/:familyId/reset-to-probe ─────────────────────
  app.post<{ Params: { familyId: string }; Body: { reason?: string } }>(
    "/actions/family/:familyId/reset-to-probe",
    async (request) => {
      const { familyId } = request.params;
      const exists = opts.db
        .prepare("SELECT 1 FROM family_catalog WHERE family_id = ?")
        .get(familyId);
      if (!exists) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");

      const body = (request.body ?? {}) as { reason?: string };
      const actor = getActor(request);
      const id = insertCommand(opts.db, "family_reset_to_probe", familyId, body.reason ?? null, actor);
      return ok({ commandId: id, status: "enqueued" });
    },
  );

  // ── POST /actions/switch-profile ──────────────────────────────────
  app.post<{ Body: { toProfile: string; ledgerResetPolicy?: string; reason?: string } }>(
    "/actions/switch-profile",
    async (request) => {
      const body = (request.body ?? {}) as {
        toProfile?: string;
        ledgerResetPolicy?: string;
        reason?: string;
      };
      const { toProfile, ledgerResetPolicy } = body;

      if (!toProfile) throw new ApiError(400, "toProfile is required", "MISSING_FIELD");

      const db = opts.db;

      // Precheck 1: target profile exists
      const profileExists = db.prepare("SELECT 1 FROM profiles WHERE profile_id = ?").get(toProfile);
      if (!profileExists) {
        throw new ApiError(404, `profile '${toProfile}' not found`, "PROFILE_NOT_FOUND");
      }

      // Precheck 2: no active switch in progress
      const activeSwitch = db
        .prepare(
          "SELECT switch_id FROM profile_switch_requests WHERE state NOT IN ('completed', 'failed', 'rolled_back')",
        )
        .get();
      if (activeSwitch) {
        throw new ApiError(409, "switch already in progress", "SWITCH_IN_PROGRESS");
      }

      // Precheck 3: not switching to current profile
      const controlState = db
        .prepare("SELECT current_profile, desired_profile FROM runtime_control_state WHERE id = 1")
        .get() as { current_profile: string | null; desired_profile: string | null } | undefined;
      const fromProfile =
        controlState?.current_profile ?? controlState?.desired_profile ?? "simulation";
      if (fromProfile === toProfile) {
        throw new ApiError(409, `already on profile '${toProfile}'`, "SAME_PROFILE");
      }

      const actor = getActor(request);
      const switchId = randomUUID();
      db.prepare(
        `INSERT INTO profile_switch_requests
           (switch_id, from_profile, to_profile, ledger_reset_policy, state, requested_by, requested_at)
         VALUES (?, ?, ?, ?, 'requested', ?, datetime('now'))`,
      ).run(switchId, fromProfile, toProfile, ledgerResetPolicy ?? "preserve", actor);

      return ok({ switchId, status: "requested" });
    },
  );
};

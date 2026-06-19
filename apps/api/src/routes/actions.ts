import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { isSupportedRuntimeProfile, SUPPORTED_RUNTIME_PROFILE } from "@krabs/domain";
import type { LedgerPool } from "../ledger-pool.js";
import { ok, ApiError } from "../errors.js";
import { getActor } from "../auth.js";
interface ActionOpts {
  db: Database.Database;
  controlDb?: Database.Database;
  ledgerDb?: Database.Database;
  ledgerPool?: LedgerPool;
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
  const controlDb = opts.controlDb ?? opts.db;

  // Global actions
  app.post<{ Body: { reason?: string } }>("/actions/pause", async (request) => {
    const body = (request.body ?? {}) as { reason?: string };
    const actor = getActor(request);
    const id = insertCommand(controlDb, "pause", null, body.reason ?? null, actor);
    return ok({ commandId: id, status: "enqueued" });
  });

  app.post<{ Body: { reason?: string } }>("/actions/resume", async (request) => {
    const body = (request.body ?? {}) as { reason?: string };
    const actor = getActor(request);
    const id = insertCommand(controlDb, "resume", null, body.reason ?? null, actor);
    return ok({ commandId: id, status: "enqueued" });
  });

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
      if (!isSupportedRuntimeProfile(toProfile)) {
        throw new ApiError(
          409,
          `cannot switch to '${toProfile}': only '${SUPPORTED_RUNTIME_PROFILE}' is a supported runtime profile`,
          "UNSUPPORTED_RUNTIME_PROFILE",
        );
      }

      const db = controlDb;

      // Precheck 1: target profile exists
      const profileExists = db
        .prepare("SELECT 1 FROM profiles WHERE profile_id = ?")
        .get(toProfile);
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

import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import {
  isSupportedRuntimeProfile,
  parseExecutionPolicyJson,
  SUPPORTED_RUNTIME_PROFILE,
} from "@krabs/domain";
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

function markerExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ApiError(503, "resume fence is unavailable", "RESUME_FENCE_UNAVAILABLE");
  }
}

function rollbackMarkerPaths(): { deploy: string; rollback: string } {
  if (process.env.NODE_ENV === "test") {
    return {
      deploy: process.env.KRABS_DEPLOY_MARKER_PATH ?? "/opt/krabs/config/deploy-in-progress.json",
      rollback:
        process.env.KRABS_ROLLBACK_MARKER_PATH ?? "/opt/krabs/config/rollback-in-progress.json",
    };
  }
  return {
    deploy: "/app/config/deploy-in-progress.json",
    rollback: "/app/config/rollback-in-progress.json",
  };
}

function enqueueResume(db: Database.Database, reason: string | null, actor: string): number {
  const paths = rollbackMarkerPaths();
  return db
    .transaction(() => {
      if (markerExists(paths.deploy)) {
        throw new ApiError(409, "deployment is in progress", "DEPLOY_IN_PROGRESS");
      }
      if (markerExists(paths.rollback)) {
        throw new ApiError(409, "rollback is in progress", "ROLLBACK_IN_PROGRESS");
      }
      return insertCommand(db, "resume", null, reason, actor);
    })
    .immediate();
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
    const id = enqueueResume(controlDb, body.reason ?? null, actor);
    return ok({ commandId: id, status: "enqueued" });
  });

  app.post<{ Body: { reason?: string; activationTs?: string } }>(
    "/actions/cancel-maker-buys",
    async (request) => {
      const body = (request.body ?? {}) as { reason?: string; activationTs?: string };
      if (typeof body.reason !== "string" || body.reason.trim() === "") {
        throw new ApiError(400, "reason is required", "MISSING_FIELD");
      }
      if (typeof body.activationTs !== "string") {
        throw new ApiError(400, "activationTs is required", "MISSING_FIELD");
      }
      const date = new Date(body.activationTs);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== body.activationTs) {
        throw new ApiError(400, "activationTs must be a canonical ISO instant", "INVALID_FIELD");
      }
      let profileId: string | null = null;
      try {
        const state = controlDb
          .prepare(
            "SELECT current_profile, desired_profile FROM runtime_control_state WHERE id = 1",
          )
          .get() as { current_profile: string | null; desired_profile: string | null } | undefined;
        profileId = state?.current_profile ?? state?.desired_profile ?? null;
      } catch (error) {
        if (
          (error as { code?: string }).code !== "SQLITE_ERROR" ||
          !(error as Error).message.includes("no such table: runtime_control_state")
        ) {
          throw error;
        }
        profileId = "simulation";
      }
      const settings = profileId
        ? (controlDb
            .prepare("SELECT execution_policy_json FROM profile_settings WHERE profile_id = ?")
            .get(profileId) as { execution_policy_json: string | null } | undefined)
        : undefined;
      const parsed = parseExecutionPolicyJson(settings?.execution_policy_json ?? null);
      if (parsed.issues.length > 0 || parsed.policy.makerEntry.mode !== "off") {
        throw new ApiError(409, "maker entry mode must be off", "MAKER_MODE_NOT_OFF");
      }
      const id = insertCommand(
        controlDb,
        "cancel_maker_buys",
        date.toISOString(),
        body.reason,
        getActor(request),
      );
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

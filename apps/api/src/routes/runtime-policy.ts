import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import {
  readContinuationMode,
  readContinuationModeVersion,
  setContinuationMode,
} from "@plankton/db";
import type { ContinuationMode } from "@plankton/domain";
import { ok, ApiError } from "../errors.js";
import { getActor } from "../auth.js";

interface RuntimePolicyOpts {
  controlDb: Database.Database;
}

const VALID_MODES: readonly ContinuationMode[] = ["leg_local", "market_wide"];

function isContinuationMode(value: unknown): value is ContinuationMode {
  return typeof value === "string" && (VALID_MODES as readonly string[]).includes(value);
}

/**
 * ADR-016: operator surface for the Post-Entry Continuation Filter mode.
 * `GET` returns current mode + version; `PATCH` flips and bumps the version
 * so runtime hot-reload picks it up on its next poll. Same auth posture as
 * /actions/pause: `getActor()` resolves the operator from the request.
 */
export const runtimePolicyRoutes: FastifyPluginAsync<RuntimePolicyOpts> = async (app, opts) => {
  const { controlDb } = opts;

  app.get("/runtime/policy", async () => {
    return ok({
      continuationMode: readContinuationMode(controlDb),
      continuationModeVersion: readContinuationModeVersion(controlDb),
    });
  });

  app.patch<{ Body: { continuationMode?: string; reason?: string } }>(
    "/runtime/policy",
    async (request) => {
      const body = (request.body ?? {}) as { continuationMode?: string; reason?: string };
      const requested = body.continuationMode;
      if (!isContinuationMode(requested)) {
        throw new ApiError(
          400,
          `continuationMode must be one of: ${VALID_MODES.join(", ")}`,
          "INVALID_CONTINUATION_MODE",
        );
      }

      const before = readContinuationMode(controlDb);
      const result = setContinuationMode(controlDb, requested);

      if (result.changed) {
        const actor = getActor(request);
        controlDb
          .prepare(
            `INSERT INTO operator_commands
               (action, target_id, reason, initiator_type, initiator, status, created_at, applied_at)
             VALUES (?, NULL, ?, 'operator', ?, 'applied', datetime('now'), datetime('now'))`,
          )
          .run(
            `set_continuation_mode:${requested}`,
            body.reason ?? `flip ${before} → ${requested}`,
            actor,
          );
      }

      return ok({
        continuationMode: requested,
        continuationModeVersion: result.version,
        changed: result.changed,
      });
    },
  );
};

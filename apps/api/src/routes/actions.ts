import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import type { LedgerPool } from "../ledger-pool.js";
import {
  emptyExecutionTelemetrySnapshot,
  evaluateExecutionCanaryGate,
  isPromotionBlockedByExecutionCanary,
  parseValidationScorecardSummary,
} from "@plankton/domain";
import { ok, ApiError } from "../errors.js";
import { getActor } from "../auth.js";
import { resolveActiveLedger } from "./status.js";

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

function formatExecutionCanaryBlockers(
  blockers: Array<{ metric: string; current: number }>,
): string {
  return blockers
    .map((blocker) => {
      if (blocker.metric === "24h fills") return `${blocker.current} fills`;
      if (blocker.metric === "Maker ratio %") return `${blocker.current}% maker`;
      if (blocker.metric === "Explicit fees (USDC)") return `$${blocker.current} fees`;
      if (blocker.metric === "Fee leakage %") return `${blocker.current}% leakage`;
      return `${blocker.current} ${blocker.metric.toLowerCase()}`;
    })
    .join(", ");
}

function assertPromotionExecutionCanary(
  db: Database.Database,
  familyId: string,
  profile: string | null | undefined,
): void {
  const family = db
    .prepare(
      `SELECT *
       FROM family_catalog
       WHERE family_id = ?`,
    )
    .get(familyId) as Record<string, unknown> | undefined;
  if (!family) {
    throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");
  }

  const scorecard = db
    .prepare(
      `SELECT summary_json
       FROM family_validation_scorecards
       WHERE family_id = ? AND (? IS NULL OR profile = ?)
       ORDER BY validated_at DESC
       LIMIT 1`,
    )
    .get(familyId, profile ?? null, profile ?? null) as { summary_json: string | null } | undefined;
  const summary = parseValidationScorecardSummary(scorecard?.summary_json ?? null);
  const executionCanary = evaluateExecutionCanaryGate({
    primaryCategory: String(family.primary_category ?? "other"),
    feeTier: (family.fee_tier as import("@plankton/domain").FeeTier | null | undefined) ?? null,
    liveWalletRequirement:
      (family.live_wallet_requirement as
        | import("@plankton/domain").LiveWalletRequirement
        | null
        | undefined) ?? null,
    requiresPostOnlyForLive:
      family.requires_post_only_for_live == null ? null : family.requires_post_only_for_live === 1,
    executionTelemetry: summary?.executionTelemetry24h ?? emptyExecutionTelemetrySnapshot(),
  });

  if (
    !isPromotionBlockedByExecutionCanary(
      profile as import("@plankton/domain").ProfileId,
      executionCanary,
    )
  ) {
    return;
  }

  const failed = executionCanary.blockers.filter((blocker) => !blocker.passed);
  const detail = formatExecutionCanaryBlockers(
    failed.map((blocker) => ({ metric: blocker.metric, current: blocker.current })),
  );
  throw new ApiError(
    409,
    `promotion blocked by execution canary: ${detail}`,
    "PROMOTION_BLOCKED_BY_EXECUTION_CANARY",
  );
}

export const actionRoutes: FastifyPluginAsync<ActionOpts> = async (app, opts) => {
  const controlDb = opts.controlDb ?? opts.db;
  const fallbackLedgerDb = opts.ledgerDb ?? opts.db;

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
        const exists = controlDb
          .prepare("SELECT 1 FROM family_catalog WHERE family_id = ?")
          .get(familyId);
        if (!exists) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");

        const body = (request.body ?? {}) as { reason?: string };
        const actor = getActor(request);
        const id = insertCommand(controlDb, action, familyId, body.reason ?? null, actor);
        return ok({ commandId: id, status: "enqueued" });
      },
    );
  }

  app.post<{
    Body: { profile?: string; slotsNeeded?: number; reason?: string };
  }>("/actions/rotate-weak-families", async (request) => {
    const body = (request.body ?? {}) as {
      profile?: string;
      slotsNeeded?: number;
      reason?: string;
    };
    const requestedProfile = body.profile?.trim() || null;
    const slotsNeeded = Math.min(Math.max(Math.floor(body.slotsNeeded ?? 0), 0), 10);
    if (slotsNeeded < 1) {
      throw new ApiError(400, "slotsNeeded must be integer >= 1", "INVALID_SLOTS_NEEDED");
    }

    const currentProfile = (
      controlDb.prepare("SELECT current_profile FROM runtime_control_state WHERE id = 1").get() as
        | { current_profile: string | null }
        | undefined
    )?.current_profile;
    const profile = requestedProfile ?? currentProfile;
    if (!profile) {
      throw new ApiError(409, "no active profile available for rotation", "NO_ACTIVE_PROFILE");
    }

    const activeLedger =
      requestedProfile && opts.ledgerPool
        ? (opts.ledgerPool.get(profile) ?? fallbackLedgerDb)
        : resolveActiveLedger(fallbackLedgerDb, controlDb, opts.ledgerPool).db;

    const openPositionFamilies = new Set(
      (
        activeLedger
          .prepare("SELECT DISTINCT family_id FROM positions WHERE status = 'open'")
          .all() as Array<{ family_id: string | null }>
      )
        .map((row) => row.family_id)
        .filter(
          (familyId): familyId is string => typeof familyId === "string" && familyId.length > 0,
        ),
    );

    const openOrderFamilies = new Set(
      (
        activeLedger
          .prepare(
            "SELECT DISTINCT family_id FROM orders WHERE status IN ('pending', 'open', 'partially-filled')",
          )
          .all() as Array<{ family_id: string | null }>
      )
        .map((row) => row.family_id)
        .filter(
          (familyId): familyId is string => typeof familyId === "string" && familyId.length > 0,
        ),
    );

    const rotatableCandidates = controlDb
      .prepare(
        `SELECT fd.family_id, COALESCE(r.tail_adjusted_pnl, 0) as pnl
         FROM family_deployments fd
         LEFT JOIN family_profile_rollups r
           ON fd.family_id = r.family_id AND r.profile = fd.profile
         WHERE fd.profile = ? AND fd.enabled = 1
         ORDER BY COALESCE(r.tail_adjusted_pnl, 0) ASC, fd.family_id ASC`,
      )
      .all(profile) as Array<{ family_id: string; pnl: number }>;

    const toDisable = rotatableCandidates
      .filter((candidate) => {
        return (
          !openPositionFamilies.has(candidate.family_id) &&
          !openOrderFamilies.has(candidate.family_id)
        );
      })
      .slice(0, slotsNeeded);

    const now = new Date().toISOString();
    let commandId: number | null = null;
    if (toDisable.length > 0) {
      controlDb.transaction(() => {
        const disableStmt = controlDb.prepare(
          "UPDATE family_deployments SET enabled = 0, updated_at = ? WHERE family_id = ? AND profile = ?",
        );
        for (const candidate of toDisable) {
          disableStmt.run(now, candidate.family_id, profile);
        }
        const info = controlDb
          .prepare(
            `INSERT INTO operator_commands
               (action, reason, initiator_type, initiator, status, created_at, applied_at)
             VALUES ('rules_reload', ?, 'system', 'auto-rotation', 'pending', ?, NULL)`,
          )
          .run(body.reason ?? `rotated ${toDisable.length} weak families`, now);
        commandId = Number(info.lastInsertRowid);
      })();
    }

    return ok({
      profile,
      rotated: toDisable.length,
      familyIds: toDisable.map((candidate) => candidate.family_id),
      commandId,
    });
  });

  // ── POST /actions/family/:familyId/promote ─────────────────────────────
  app.post<{
    Params: { familyId: string };
    Body: {
      reason?: string;
      maxOpenValueUsdc?: number;
      maxActiveMarkets?: number;
      maxDustPositions?: number;
    };
  }>("/actions/family/:familyId/promote", async (request) => {
    const { familyId } = request.params;
    const exists = controlDb
      .prepare("SELECT 1 FROM family_catalog WHERE family_id = ?")
      .get(familyId);
    if (!exists) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");

    const actor = getActor(request);
    const body = (request.body ?? {}) as {
      reason?: string;
      maxOpenValueUsdc?: number;
      maxActiveMarkets?: number;
      maxDustPositions?: number;
    };

    // Encode caps in reason JSON so command-poller can use them
    const caps = {
      maxOpenValueUsdc: body.maxOpenValueUsdc,
      maxActiveMarkets: body.maxActiveMarkets,
      maxDustPositions: body.maxDustPositions,
    };
    const hasCaps =
      caps.maxOpenValueUsdc != null ||
      caps.maxActiveMarkets != null ||
      caps.maxDustPositions != null;
    if (hasCaps) {
      if (
        caps.maxOpenValueUsdc != null &&
        (!Number.isFinite(caps.maxOpenValueUsdc) || caps.maxOpenValueUsdc < 1)
      ) {
        throw new ApiError(400, "maxOpenValueUsdc must be >= 1", "INVALID_CAPS");
      }
      if (
        caps.maxActiveMarkets != null &&
        (!Number.isInteger(caps.maxActiveMarkets) || caps.maxActiveMarkets < 1)
      ) {
        throw new ApiError(400, "maxActiveMarkets must be integer >= 1", "INVALID_CAPS");
      }
      if (
        caps.maxDustPositions != null &&
        (!Number.isInteger(caps.maxDustPositions) || caps.maxDustPositions < 0)
      ) {
        throw new ApiError(400, "maxDustPositions must be integer >= 0", "INVALID_CAPS");
      }
    }
    const reason = hasCaps
      ? JSON.stringify({ reason: body.reason ?? "operator approved", caps })
      : (body.reason ?? null);

    const result = controlDb
      .transaction(() => {
        const proposal = controlDb
          .prepare(
            `SELECT id, profile
             FROM promotion_proposals
             WHERE family_id = ? AND status = 'pending'
             ORDER BY created_at DESC
             LIMIT 1`,
          )
          .get(familyId) as { id: number; profile: string | null } | undefined;
        if (!proposal) {
          throw new ApiError(
            409,
            `no pending promotion proposal for family ${familyId}`,
            "NO_PENDING_PROPOSAL",
          );
        }

        assertPromotionExecutionCanary(controlDb, familyId, proposal.profile);

        const info = controlDb
          .prepare(
            `UPDATE promotion_proposals
             SET status = 'approved', resolved_at = datetime('now'), resolved_by = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(actor, proposal.id);
        if (info.changes === 0) {
          throw new ApiError(
            409,
            `no pending promotion proposal for family ${familyId}`,
            "NO_PENDING_PROPOSAL",
          );
        }

        const commandId = insertCommand(
          controlDb,
          "family_promote_scaled",
          familyId,
          reason,
          actor,
        );

        controlDb
          .prepare("UPDATE promotion_proposals SET applied_command_id = ? WHERE id = ?")
          .run(commandId, proposal.id);

        return { commandId, proposalId: proposal.id };
      })
      .immediate();

    return ok(result);
  });

  // ── POST /actions/family/:familyId/reset-to-probe ─────────────────────
  app.post<{ Params: { familyId: string }; Body: { reason?: string } }>(
    "/actions/family/:familyId/reset-to-probe",
    async (request) => {
      const { familyId } = request.params;
      const exists = controlDb
        .prepare("SELECT 1 FROM family_catalog WHERE family_id = ?")
        .get(familyId);
      if (!exists) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");

      const body = (request.body ?? {}) as { reason?: string };
      const actor = getActor(request);
      const id = insertCommand(
        controlDb,
        "family_reset_to_probe",
        familyId,
        body.reason ?? null,
        actor,
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

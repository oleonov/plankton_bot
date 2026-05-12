import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { SqliteLegStateRepository, SqliteRiskEventRepository } from "@krabs/db";
import { createTokenId } from "@krabs/domain";
import type { LedgerPool } from "../ledger-pool.js";
import { ok, ApiError } from "../errors.js";
import { getActor } from "../auth.js";
import { resolveActiveLedger } from "./status.js";

interface AbandonedDustOpts {
  db: Database.Database;
  controlDb?: Database.Database;
  ledgerPool?: LedgerPool;
}

export const abandonedDustRoutes: FastifyPluginAsync<AbandonedDustOpts> = async (app, opts) => {
  app.post<{ Body: { tokenId?: string; reason?: string } }>(
    "/abandoned-dust/reset",
    async (request) => {
      const body = (request.body ?? {}) as { tokenId?: string; reason?: string };
      const rawTokenId = body.tokenId?.trim();
      if (!rawTokenId) {
        throw new ApiError(400, "tokenId is required", "MISSING_FIELD");
      }

      const { db } = resolveActiveLedger(opts.db, opts.controlDb, opts.ledgerPool);
      const legStateRepo = new SqliteLegStateRepository(db);
      const tokenId = createTokenId(rawTokenId);
      const current = legStateRepo.get(tokenId);
      if (!current) {
        throw new ApiError(404, `leg state for token '${rawTokenId}' not found`, "NOT_FOUND");
      }

      const wasAbandoned = current.abandonedAtTs != null;
      const prevRejectCount = current.consecutiveSellResidualRejects ?? 0;
      const stateChanged = wasAbandoned || prevRejectCount > 0;
      const nowIso = new Date().toISOString();

      if (!stateChanged) {
        // Nothing to clear; skip the write to avoid a silent no-op audit gap.
        return ok({
          tokenId: rawTokenId,
          wasAbandoned: false,
          prevRejectCount: 0,
          resetAt: nowIso,
        });
      }

      legStateRepo.resetAbandoned(tokenId, nowIso);

      // Always audit any state-changing reset (abandoned legs OR partial reject
      // counters), so operator actions never silently clear DB state.
      const riskEventRepo = new SqliteRiskEventRepository(db);
      try {
        riskEventRepo.insert({
          eventType: "signal_suppressed",
          payload: {
            tokenId: rawTokenId,
            reasonCode: "dust-recovered:manual",
            source: "manual_api_reset",
            wasAbandoned,
            prevRejectCount,
            actor: getActor(request),
            reason: body.reason ?? null,
            signalTimestamp: nowIso,
          },
        });
      } catch (err) {
        app.log.warn(
          { err, tokenId: rawTokenId },
          "failed to persist dust-recovered:manual risk event",
        );
      }

      return ok({
        tokenId: rawTokenId,
        wasAbandoned,
        prevRejectCount,
        resetAt: nowIso,
      });
    },
  );
};

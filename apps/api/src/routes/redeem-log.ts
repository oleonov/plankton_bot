import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { SqliteRedeemLogRepository, type RedeemLogStatus, type RedeemLogQuery } from "@krabs/db";
import { ok, ApiError } from "../errors.js";

interface RedeemLogOpts {
  db: Database.Database;
}

interface RedeemLogQuerystring {
  limit?: string;
  offset?: string;
  status?: string;
  condition_id?: string;
  since_ts?: string;
  until_ts?: string;
}

const REDEEM_LOG_STATUSES = new Set<RedeemLogStatus>([
  "attempting",
  "success",
  "submitted",
  "pending",
  "skipped",
  "failed",
  "rejected",
  "failed_max_retries",
  "failed_orphaned",
]);

export const redeemLogRoutes: FastifyPluginAsync<RedeemLogOpts> = async (app, opts) => {
  const repo = new SqliteRedeemLogRepository(opts.db);

  app.get<{ Querystring: RedeemLogQuerystring }>("/redeem-log", async (request) => {
    const query = parseRedeemLogQuery(request.query);
    const entries = repo.list(query).map((entry) => ({
      id: entry.id,
      condition_id: entry.conditionId,
      token_ids: entry.tokenIds,
      attempt_ts: entry.attemptTs,
      status: entry.status,
      tx_hash: entry.txHash,
      gas_used: entry.gasUsed,
      error_msg: entry.errorMsg,
      retry_count: entry.retryCount,
      details_json: entry.detailsJson,
    }));
    const totalCount = repo.count(query);
    return ok({ total_count: totalCount, entries });
  });

  app.get("/redeem-log/summary", async () => {
    const summary = repo.summarize(Date.now());
    return ok({
      total_attempts_24h: summary.totalAttempts24h,
      by_status: {
        attempting: summary.byStatus.attempting,
        success: summary.byStatus.success,
        submitted: summary.byStatus.submitted,
        pending: summary.byStatus.pending,
        skipped: summary.byStatus.skipped,
        failed: summary.byStatus.failed,
        rejected: summary.byStatus.rejected,
        failed_max_retries: summary.byStatus.failed_max_retries,
        failed_orphaned: summary.byStatus.failed_orphaned,
      },
      total_usdc_redeemed_24h: null,
      latest_attempt_ts: summary.latestAttemptTs,
      oldest_in_flight: summary.oldestInFlight
        ? {
            condition_id: summary.oldestInFlight.conditionId,
            attempt_ts: summary.oldestInFlight.attemptTs,
            age_minutes: summary.oldestInFlight.ageMinutes,
          }
        : null,
    });
  });
};

function parseRedeemLogQuery(raw: RedeemLogQuerystring): RedeemLogQuery {
  const status = raw.status ? parseStatus(raw.status) : undefined;
  return {
    limit: clampInt(raw.limit, 100, 1, 1000),
    offset: clampInt(raw.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    ...(status ? { status } : {}),
    ...(raw.condition_id ? { conditionId: raw.condition_id } : {}),
    ...parseOptionalTs(raw.since_ts, "since_ts"),
    ...parseOptionalTs(raw.until_ts, "until_ts"),
  };
}

function parseStatus(raw: string): RedeemLogStatus {
  if (REDEEM_LOG_STATUSES.has(raw as RedeemLogStatus)) return raw as RedeemLogStatus;
  throw new ApiError(400, `invalid redeem status: ${raw}`, "BAD_REQUEST");
}

function parseOptionalTs(raw: string | undefined, key: "since_ts" | "until_ts") {
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ApiError(400, `${key} must be a finite timestamp`, "BAD_REQUEST");
  }
  return key === "since_ts" ? { sinceTs: value } : { untilTs: value };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

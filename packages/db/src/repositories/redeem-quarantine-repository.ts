import type Database from "better-sqlite3";

import { nowIso, toSqliteDateTime } from "../db-timestamp.js";

export interface RedeemQuarantineState {
  conditionId: string;
  consecutiveStateFailedCount: number;
  redeemQuarantineUntilTs: number | null;
  lastStateFailedTs: number | null;
  positionRows: number;
  totalBasisUsdc: number;
}

export interface RedeemQuarantineStateFailedResult extends RedeemQuarantineState {
  enteredQuarantine: boolean;
}

export interface RedeemQuarantineResetResult {
  conditionId: string;
  changedRows: number;
  previousConsecutiveStateFailedCount: number;
  previousRedeemQuarantineUntilTs: number | null;
  reset: boolean;
}

export interface RedeemQuarantineSummary {
  quarantinedCount: number;
  totalBasisUsdc: number;
  oldestQuarantineAgeHours: number;
  expired24h: number;
  manualResets24h: number;
}

type RawRedeemQuarantineState = {
  condition_id: string;
  consecutive_state_failed_count: number | null;
  redeem_quarantine_until_ts: number | null;
  last_state_failed_ts: number | null;
  position_rows: number;
  total_basis_usdc: number | null;
};

export class SqliteRedeemQuarantineRepository {
  constructor(private readonly db: Database.Database) {}

  findByConditionIds(conditionIds: readonly string[]): Map<string, RedeemQuarantineState> {
    if (conditionIds.length === 0) return new Map();
    const unique = [...new Set(conditionIds)];
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT condition_id,
                COALESCE(MAX(consecutive_state_failed_count), 0) AS consecutive_state_failed_count,
                MAX(redeem_quarantine_until_ts) AS redeem_quarantine_until_ts,
                MAX(last_state_failed_ts) AS last_state_failed_ts,
                COUNT(*) AS position_rows,
                COALESCE(SUM(cost_basis_usdc), 0) AS total_basis_usdc
           FROM positions
          WHERE condition_id IN (${placeholders})
          GROUP BY condition_id`,
      )
      .all(...unique) as RawRedeemQuarantineState[];
    return new Map(rows.map((row) => [row.condition_id, mapState(row)]));
  }

  recordStateFailed(input: {
    conditionId: string;
    nowTs: number;
    threshold: number;
    ttlMs: number;
  }): RedeemQuarantineStateFailedResult {
    const before = this.findOne(input.conditionId);
    const previousCount = before?.consecutiveStateFailedCount ?? 0;
    const previousUntil = before?.redeemQuarantineUntilTs ?? null;
    const nextCount = previousCount + 1;
    const nextUntil = nextCount >= input.threshold ? input.nowTs + input.ttlMs : previousUntil;
    const enteredQuarantine =
      nextUntil !== null &&
      nextUntil > input.nowTs &&
      (previousUntil === null || previousUntil <= input.nowTs);

    this.db
      .prepare(
        `UPDATE positions
            SET consecutive_state_failed_count = ?,
                redeem_quarantine_until_ts = ?,
                last_state_failed_ts = ?,
                updated_at = ?
          WHERE condition_id = ?`,
      )
      .run(nextCount, nextUntil, input.nowTs, nowIso(), input.conditionId);

    return {
      ...(this.findOne(input.conditionId) ?? {
        conditionId: input.conditionId,
        consecutiveStateFailedCount: nextCount,
        redeemQuarantineUntilTs: nextUntil,
        lastStateFailedTs: input.nowTs,
        positionRows: 0,
        totalBasisUsdc: 0,
      }),
      enteredQuarantine,
    };
  }

  /**
   * Quarantine a condition the relayer rejected as a benign zero-position-balance
   * precheck skip. Reuses `redeem_quarantine_until_ts` so the existing sweep gate
   * (and `clearExpired`/`clearAfterSuccess`) handle it for free.
   *
   * A zero-balance skip is NOT a settlement failure, so the STATE_FAILED markers
   * are reset (`consecutive_state_failed_count = 0`, `last_state_failed_ts = NULL`).
   * This keeps the quarantine unambiguously classifiable as a benign zero-balance
   * quarantine (count 0) rather than a STATE_FAILED one (count > 0) even when the
   * condition previously accumulated state-failed strikes — without a schema change.
   */
  recordBenignZeroBalanceSkip(input: {
    conditionId: string;
    nowTs: number;
    ttlMs: number;
  }): RedeemQuarantineStateFailedResult {
    const before = this.findOne(input.conditionId);
    const previousUntil = before?.redeemQuarantineUntilTs ?? null;
    const nextUntil = Math.max(previousUntil ?? 0, input.nowTs + input.ttlMs);
    const enteredQuarantine = previousUntil === null || previousUntil <= input.nowTs;

    this.db
      .prepare(
        `UPDATE positions
            SET redeem_quarantine_until_ts = ?,
                consecutive_state_failed_count = 0,
                last_state_failed_ts = NULL,
                updated_at = ?
          WHERE condition_id = ?`,
      )
      .run(nextUntil, nowIso(), input.conditionId);

    return {
      ...(this.findOne(input.conditionId) ?? {
        conditionId: input.conditionId,
        consecutiveStateFailedCount: 0,
        redeemQuarantineUntilTs: nextUntil,
        lastStateFailedTs: null,
        positionRows: 0,
        totalBasisUsdc: 0,
      }),
      enteredQuarantine,
    };
  }

  clearAfterSuccess(conditionId: string): RedeemQuarantineResetResult {
    return this.resetCondition(conditionId);
  }

  clearExpired(conditionId: string): RedeemQuarantineResetResult {
    return this.resetCondition(conditionId);
  }

  summarizeQuarantine(nowTs: number): RedeemQuarantineSummary {
    const active = this.db
      .prepare(
        `SELECT COUNT(DISTINCT condition_id) AS quarantined_count,
                COALESCE(SUM(cost_basis_usdc), 0) AS total_basis_usdc,
                MIN(last_state_failed_ts) AS oldest_state_failed_ts
           FROM positions
          WHERE redeem_quarantine_until_ts IS NOT NULL
            AND redeem_quarantine_until_ts > ?`,
      )
      .get(nowTs) as {
      quarantined_count: number;
      total_basis_usdc: number;
      oldest_state_failed_ts: number | null;
    };
    const eventCounts = this.countRiskEventsSince(nowTs - 24 * 60 * 60_000);
    return {
      quarantinedCount: active.quarantined_count,
      totalBasisUsdc: active.total_basis_usdc,
      oldestQuarantineAgeHours:
        active.oldest_state_failed_ts === null
          ? 0
          : Math.max(0, (nowTs - active.oldest_state_failed_ts) / 3_600_000),
      expired24h: eventCounts.get("redeem_quarantine_expired") ?? 0,
      manualResets24h: eventCounts.get("redeem_quarantine_manual_reset") ?? 0,
    };
  }

  private findOne(conditionId: string): RedeemQuarantineState | null {
    const row = this.db
      .prepare(
        `SELECT condition_id,
                COALESCE(MAX(consecutive_state_failed_count), 0) AS consecutive_state_failed_count,
                MAX(redeem_quarantine_until_ts) AS redeem_quarantine_until_ts,
                MAX(last_state_failed_ts) AS last_state_failed_ts,
                COUNT(*) AS position_rows,
                COALESCE(SUM(cost_basis_usdc), 0) AS total_basis_usdc
           FROM positions
          WHERE condition_id = ?
          GROUP BY condition_id`,
      )
      .get(conditionId) as RawRedeemQuarantineState | undefined;
    return row ? mapState(row) : null;
  }

  private resetCondition(conditionId: string): RedeemQuarantineResetResult {
    const before = this.findOne(conditionId);
    const result = this.db
      .prepare(
        `UPDATE positions
            SET consecutive_state_failed_count = 0,
                redeem_quarantine_until_ts = NULL,
                updated_at = ?
          WHERE condition_id = ?`,
      )
      .run(nowIso(), conditionId);
    const previousCount = before?.consecutiveStateFailedCount ?? 0;
    const previousUntil = before?.redeemQuarantineUntilTs ?? null;
    return {
      conditionId,
      changedRows: result.changes,
      previousConsecutiveStateFailedCount: previousCount,
      previousRedeemQuarantineUntilTs: previousUntil,
      reset: previousCount > 0 || previousUntil !== null,
    };
  }

  private countRiskEventsSince(sinceTs: number): Map<string, number> {
    const since = toSqliteDateTime(sinceTs);
    const rows = this.db
      .prepare(
        `SELECT event_type, COUNT(*) AS count
           FROM risk_events
          WHERE event_type IN ('redeem_quarantine_expired', 'redeem_quarantine_manual_reset')
            AND created_at >= ?
          GROUP BY event_type`,
      )
      .all(since) as Array<{ event_type: string; count: number }>;
    return new Map(rows.map((row) => [row.event_type, row.count]));
  }
}

function mapState(row: RawRedeemQuarantineState): RedeemQuarantineState {
  return {
    conditionId: row.condition_id,
    consecutiveStateFailedCount: row.consecutive_state_failed_count ?? 0,
    redeemQuarantineUntilTs: row.redeem_quarantine_until_ts,
    lastStateFailedTs: row.last_state_failed_ts,
    positionRows: row.position_rows,
    totalBasisUsdc: row.total_basis_usdc ?? 0,
  };
}

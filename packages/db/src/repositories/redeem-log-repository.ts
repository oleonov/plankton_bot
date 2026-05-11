import type Database from "better-sqlite3";

export type RedeemLogStatus =
  | "attempting"
  | "success"
  | "submitted"
  | "pending"
  | "skipped"
  | "failed"
  | "rejected"
  | "failed_max_retries"
  | "failed_orphaned";

export interface RedeemLogEntry {
  conditionId: string;
  tokenIds: readonly string[];
  attemptTs: number;
  status: RedeemLogStatus;
  txHash?: string | null;
  gasUsed?: number | null;
  errorMsg?: string | null;
  retryCount?: number;
  details?: Record<string, unknown> | null;
}

export interface RedeemLogRow {
  id: number;
  conditionId: string;
  tokenIds: string[];
  attemptTs: number;
  status: RedeemLogStatus;
  txHash: string | null;
  gasUsed: number | null;
  errorMsg: string | null;
  retryCount: number;
  detailsJson: string | null;
}

export interface RedeemLogQuery {
  limit: number;
  offset: number;
  status?: RedeemLogStatus | undefined;
  conditionId?: string | undefined;
  sinceTs?: number | undefined;
  untilTs?: number | undefined;
}

export interface RedeemLogSummary {
  totalAttempts24h: number;
  byStatus: Record<RedeemLogStatus, number>;
  latestAttemptTs: number | null;
  oldestInFlight: { conditionId: string; attemptTs: number; ageMinutes: number } | null;
}

interface RawRedeemLogRow {
  id: number;
  condition_id: string;
  token_ids: string;
  attempt_ts: number;
  status: RedeemLogStatus;
  tx_hash: string | null;
  gas_used: number | null;
  error_msg: string | null;
  retry_count: number;
  details_json: string | null;
}

const REDEEM_LOG_STATUSES: readonly RedeemLogStatus[] = [
  "attempting",
  "success",
  "submitted",
  "pending",
  "skipped",
  "failed",
  "rejected",
  "failed_max_retries",
  "failed_orphaned",
];

const ACTIVE_REDEEM_LOG_STATUS_SQL = "'attempting','submitted','pending'";

export class SqliteRedeemLogRepository {
  private readonly insertStmt;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO redeem_log
         (condition_id, token_ids, attempt_ts, status, tx_hash, gas_used, error_msg,
          retry_count, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  insert(entry: RedeemLogEntry): void {
    this.insertStmt.run(
      entry.conditionId,
      JSON.stringify(entry.tokenIds),
      entry.attemptTs,
      entry.status,
      entry.txHash ?? null,
      entry.gasUsed ?? null,
      entry.errorMsg ?? null,
      entry.retryCount ?? 0,
      entry.details ? JSON.stringify(entry.details) : null,
    );
  }

  updateLatestActiveAttempt(entry: Omit<RedeemLogEntry, "attemptTs">): boolean {
    const result = this.db
      .prepare(
        `UPDATE redeem_log
            SET token_ids = ?,
                status = ?,
                tx_hash = ?,
                gas_used = ?,
                error_msg = ?,
                retry_count = ?,
                details_json = ?
          WHERE id = (
            SELECT id
              FROM redeem_log
             WHERE condition_id = ?
               AND status IN (${ACTIVE_REDEEM_LOG_STATUS_SQL})
             ORDER BY attempt_ts DESC, id DESC
             LIMIT 1
          )`,
      )
      .run(
        JSON.stringify(entry.tokenIds),
        entry.status,
        entry.txHash ?? null,
        entry.gasUsed ?? null,
        entry.errorMsg ?? null,
        entry.retryCount ?? 0,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.conditionId,
      );
    return result.changes > 0;
  }

  findRecentActiveAttempts(sinceTs: number): Array<{
    id: number;
    conditionId: string;
    tokenIds: string[];
    attemptTs: number;
    status: RedeemLogStatus;
    detailsJson: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.condition_id, a.token_ids, a.attempt_ts, a.status, a.details_json
           FROM redeem_log a
          WHERE a.status IN (${ACTIVE_REDEEM_LOG_STATUS_SQL})
            AND a.attempt_ts > ?
            AND NOT EXISTS (
              SELECT 1
                FROM redeem_log b
               WHERE b.condition_id = a.condition_id
                 AND (b.attempt_ts > a.attempt_ts OR (b.attempt_ts = a.attempt_ts AND b.id > a.id))
            )
          ORDER BY a.attempt_ts DESC`,
      )
      .all(sinceTs) as RawRedeemLogRow[];
    return rows.map((row) => ({
      id: row.id,
      conditionId: row.condition_id,
      tokenIds: parseTokenIds(row.token_ids),
      attemptTs: row.attempt_ts,
      status: row.status,
      detailsJson: row.details_json,
    }));
  }

  hasRecentActiveAttempt(conditionId: string, sinceTs: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
           FROM redeem_log a
          WHERE a.condition_id = ?
            AND a.status IN (${ACTIVE_REDEEM_LOG_STATUS_SQL})
            AND a.attempt_ts > ?
            AND NOT EXISTS (
              SELECT 1
                FROM redeem_log b
               WHERE b.condition_id = a.condition_id
                 AND (b.attempt_ts > a.attempt_ts OR (b.attempt_ts = a.attempt_ts AND b.id > a.id))
            )
          LIMIT 1`,
      )
      .get(conditionId, sinceTs);
    return row !== undefined;
  }

  findLatestAttemptTs(conditionId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT attempt_ts
           FROM redeem_log
          WHERE condition_id = ?
          ORDER BY attempt_ts DESC, id DESC
          LIMIT 1`,
      )
      .get(conditionId) as { attempt_ts: number } | undefined;
    return row?.attempt_ts ?? null;
  }

  markOrphanedActiveAttempts(
    cutoffTs: number,
    errorMsg: string,
  ): Array<{
    id: number;
    conditionId: string;
    attemptTs: number;
    status: RedeemLogStatus;
  }> {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.condition_id, a.attempt_ts, a.status
           FROM redeem_log a
          WHERE a.status IN (${ACTIVE_REDEEM_LOG_STATUS_SQL})
            AND a.attempt_ts <= ?
            AND NOT EXISTS (
              SELECT 1
                FROM redeem_log b
               WHERE b.condition_id = a.condition_id
                 AND (b.attempt_ts > a.attempt_ts OR (b.attempt_ts = a.attempt_ts AND b.id > a.id))
            )
          ORDER BY a.attempt_ts ASC`,
      )
      .all(cutoffTs) as Array<{
      id: number;
      condition_id: string;
      attempt_ts: number;
      status: RedeemLogStatus;
    }>;
    const update = this.db.prepare(
      `UPDATE redeem_log
          SET status = 'failed_orphaned',
              error_msg = COALESCE(error_msg, ?)
        WHERE id = ?`,
    );
    const tx = this.db.transaction(() => {
      for (const row of rows) update.run(errorMsg, row.id);
    });
    tx();
    return rows.map((row) => ({
      id: row.id,
      conditionId: row.condition_id,
      attemptTs: row.attempt_ts,
      status: row.status,
    }));
  }

  list(query: RedeemLogQuery): RedeemLogRow[] {
    const { where, params } = buildWhere(query);
    const rows = this.db
      .prepare(
        `SELECT id, condition_id, token_ids, attempt_ts, status, tx_hash, gas_used,
                error_msg, retry_count, details_json
           FROM redeem_log
          ${where}
          ORDER BY attempt_ts DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, query.limit, query.offset) as RawRedeemLogRow[];
    return rows.map(mapRedeemLogRow);
  }

  count(query: Omit<RedeemLogQuery, "limit" | "offset">): number {
    const { where, params } = buildWhere({ ...query, limit: 1, offset: 0 });
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM redeem_log ${where}`)
      .get(...params) as { count: number };
    return row.count;
  }

  summarize(now: number): RedeemLogSummary {
    const sinceTs = now - 24 * 60 * 60_000;
    const statusRows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count
           FROM redeem_log
          WHERE attempt_ts >= ?
          GROUP BY status`,
      )
      .all(sinceTs) as Array<{ status: RedeemLogStatus; count: number }>;
    const byStatus = Object.fromEntries(REDEEM_LOG_STATUSES.map((status) => [status, 0])) as Record<
      RedeemLogStatus,
      number
    >;
    for (const row of statusRows) byStatus[row.status] = row.count;

    const latest = this.db
      .prepare(`SELECT MAX(attempt_ts) AS attempt_ts FROM redeem_log`)
      .get() as { attempt_ts: number | null };
    const oldestActive = this.findRecentActiveAttempts(0).at(-1);
    return {
      totalAttempts24h: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      byStatus,
      latestAttemptTs: latest.attempt_ts ?? null,
      oldestInFlight: oldestActive
        ? {
            conditionId: oldestActive.conditionId,
            attemptTs: oldestActive.attemptTs,
            ageMinutes: Math.max(0, (now - oldestActive.attemptTs) / 60_000),
          }
        : null,
    };
  }
}

function buildWhere(query: RedeemLogQuery): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.status) {
    clauses.push("status = ?");
    params.push(query.status);
  }
  if (query.conditionId) {
    clauses.push("condition_id = ?");
    params.push(query.conditionId);
  }
  if (query.sinceTs !== undefined) {
    clauses.push("attempt_ts >= ?");
    params.push(query.sinceTs);
  }
  if (query.untilTs !== undefined) {
    clauses.push("attempt_ts <= ?");
    params.push(query.untilTs);
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function mapRedeemLogRow(row: RawRedeemLogRow): RedeemLogRow {
  return {
    id: row.id,
    conditionId: row.condition_id,
    tokenIds: parseTokenIds(row.token_ids),
    attemptTs: row.attempt_ts,
    status: row.status,
    txHash: row.tx_hash,
    gasUsed: row.gas_used,
    errorMsg: row.error_msg,
    retryCount: row.retry_count,
    detailsJson: row.details_json,
  };
}

function parseTokenIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

import type Database from "better-sqlite3";
import { createTokenId, type TokenId } from "@krabs/domain";

export interface DustAutoCloseState {
  tokenId: TokenId;
  status: "attempted" | "non_closeable";
  lastAttemptAtMs: number;
  lastAttemptReason: string | null;
  nextRetryAtMs: number;
  consecutiveAttempts: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DustAutoCloseRepository {
  getState(tokenId: TokenId): DustAutoCloseState | null;
  getNextRetryAt(tokenId: TokenId): number | null;
  markAttempted(tokenId: TokenId, reason: string, nowMs: number, nextRetryAtMs: number): void;
  markNonCloseable(tokenId: TokenId, reason: string, nowMs: number, nextRetryAtMs: number): void;
  markSuccessful(tokenId: TokenId): void;
}

export class SqliteDustAutoCloseRepository implements DustAutoCloseRepository {
  constructor(private readonly db: Database.Database) {}

  getState(tokenId: TokenId): DustAutoCloseState | null {
    const row = this.db
      .prepare(
        `SELECT token_id, status, last_attempt_at_ms, last_attempt_reason,
                next_retry_at_ms, consecutive_attempts, created_at_ms, updated_at_ms
         FROM dust_auto_close_state
         WHERE token_id = ?`,
      )
      .get(tokenId) as DustAutoCloseStateRow | undefined;
    return row == null ? null : toState(row);
  }

  getNextRetryAt(tokenId: TokenId): number | null {
    const row = this.db
      .prepare(`SELECT next_retry_at_ms FROM dust_auto_close_state WHERE token_id = ?`)
      .get(tokenId) as { next_retry_at_ms: number } | undefined;
    return row?.next_retry_at_ms ?? null;
  }

  markAttempted(tokenId: TokenId, reason: string, nowMs: number, nextRetryAtMs: number): void {
    this.upsertState(tokenId, "attempted", reason, nowMs, nextRetryAtMs);
  }

  markNonCloseable(
    tokenId: TokenId,
    reason: string,
    nowMs: number,
    nextRetryAtMs: number,
  ): void {
    this.upsertState(tokenId, "non_closeable", reason, nowMs, nextRetryAtMs);
  }

  markSuccessful(tokenId: TokenId): void {
    this.db.prepare(`DELETE FROM dust_auto_close_state WHERE token_id = ?`).run(tokenId);
  }

  private upsertState(
    tokenId: TokenId,
    status: DustAutoCloseState["status"],
    reason: string,
    nowMs: number,
    nextRetryAtMs: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO dust_auto_close_state
         (token_id, status, last_attempt_at_ms, last_attempt_reason, next_retry_at_ms,
          consecutive_attempts, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(token_id) DO UPDATE SET
           status = excluded.status,
           last_attempt_at_ms = excluded.last_attempt_at_ms,
           last_attempt_reason = excluded.last_attempt_reason,
           next_retry_at_ms = excluded.next_retry_at_ms,
           consecutive_attempts = dust_auto_close_state.consecutive_attempts + 1,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(tokenId, status, nowMs, reason, nextRetryAtMs, nowMs, nowMs);
  }
}

interface DustAutoCloseStateRow {
  token_id: string;
  status: DustAutoCloseState["status"];
  last_attempt_at_ms: number;
  last_attempt_reason: string | null;
  next_retry_at_ms: number;
  consecutive_attempts: number;
  created_at_ms: number;
  updated_at_ms: number;
}

function toState(row: DustAutoCloseStateRow): DustAutoCloseState {
  return {
    tokenId: createTokenId(row.token_id),
    status: row.status,
    lastAttemptAtMs: row.last_attempt_at_ms,
    lastAttemptReason: row.last_attempt_reason,
    nextRetryAtMs: row.next_retry_at_ms,
    consecutiveAttempts: row.consecutive_attempts,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

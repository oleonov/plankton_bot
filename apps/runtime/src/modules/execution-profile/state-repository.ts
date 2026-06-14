import type Database from "better-sqlite3";
import { createConditionId, createTokenId, type TokenId } from "@krabs/domain";

import type {
  ExecutionProfileStateRecord,
  ExecutionProfileStateRepository,
  Profile,
  ProfileState,
} from "./types.js";

interface ExecutionProfileStateRow {
  token_id: string;
  condition_id: string;
  profile: Profile;
  state: ProfileState;
  assumed_at: string;
  last_avg_entry: number;
  last_transition_at: string;
  active_ladder_id: string | null;
  handoff_started_at: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export class SqliteExecutionProfileStateRepository implements ExecutionProfileStateRepository {
  constructor(private readonly db: Database.Database) {}

  upsertState(state: ExecutionProfileStateRecord): void {
    this.db
      .prepare(
        `INSERT INTO execution_profile_state
         (token_id, condition_id, profile, state, assumed_at, last_avg_entry,
          last_transition_at, active_ladder_id, handoff_started_at, metadata_json,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_id) DO UPDATE SET
           condition_id = excluded.condition_id,
           profile = excluded.profile,
           state = excluded.state,
           assumed_at = excluded.assumed_at,
           last_avg_entry = excluded.last_avg_entry,
           last_transition_at = excluded.last_transition_at,
           active_ladder_id = excluded.active_ladder_id,
           handoff_started_at = excluded.handoff_started_at,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.tokenId,
        state.conditionId,
        state.profile,
        state.state,
        state.assumedAt,
        state.lastAvgEntry,
        state.lastTransitionAt,
        state.activeLadderId,
        state.handoffStartedAt,
        state.metadata == null ? null : JSON.stringify(state.metadata),
        state.createdAt,
        state.updatedAt,
      );
  }

  getState(tokenId: TokenId): ExecutionProfileStateRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM execution_profile_state WHERE token_id = ?`)
      .get(tokenId) as ExecutionProfileStateRow | undefined;
    return row == null ? null : toRecord(row);
  }

  findAllActive(): ExecutionProfileStateRecord[] {
    return this.findRows(`SELECT * FROM execution_profile_state WHERE state != 'CLOSED'`);
  }

  findByState(state: ProfileState): ExecutionProfileStateRecord[] {
    return this.findRows(`SELECT * FROM execution_profile_state WHERE state = ?`, state);
  }

  findOrphans(openTokenIds: readonly TokenId[]): ExecutionProfileStateRecord[] {
    const open = new Set(openTokenIds.map(String));
    return this.findAllActive().filter((state) => !open.has(String(state.tokenId)));
  }

  delete(tokenId: TokenId): void {
    this.db.prepare(`DELETE FROM execution_profile_state WHERE token_id = ?`).run(tokenId);
  }

  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private findRows(sql: string, ...args: unknown[]): ExecutionProfileStateRecord[] {
    const rows = this.db.prepare(sql).all(...args) as ExecutionProfileStateRow[];
    return rows.map(toRecord);
  }
}

export class InMemoryExecutionProfileStateRepository implements ExecutionProfileStateRepository {
  private states = new Map<string, ExecutionProfileStateRecord>();

  constructor(initial: readonly ExecutionProfileStateRecord[] = []) {
    for (const state of initial) this.upsertState(state);
  }

  upsertState(state: ExecutionProfileStateRecord): void {
    this.states.set(String(state.tokenId), cloneState(state));
  }

  getState(tokenId: TokenId): ExecutionProfileStateRecord | null {
    const state = this.states.get(String(tokenId));
    return state == null ? null : cloneState(state);
  }

  findAllActive(): ExecutionProfileStateRecord[] {
    return this.values().filter((state) => state.state !== "CLOSED");
  }

  findByState(state: ProfileState): ExecutionProfileStateRecord[] {
    return this.values().filter((row) => row.state === state);
  }

  findOrphans(openTokenIds: readonly TokenId[]): ExecutionProfileStateRecord[] {
    const open = new Set(openTokenIds.map(String));
    return this.findAllActive().filter((state) => !open.has(String(state.tokenId)));
  }

  delete(tokenId: TokenId): void {
    this.states.delete(String(tokenId));
  }

  runInTransaction<T>(fn: () => T): T {
    const before = new Map(this.states);
    try {
      return fn();
    } catch (err) {
      this.states = before;
      throw err;
    }
  }

  private values(): ExecutionProfileStateRecord[] {
    return [...this.states.values()].map(cloneState);
  }
}

function toRecord(row: ExecutionProfileStateRow): ExecutionProfileStateRecord {
  return {
    tokenId: createTokenId(row.token_id),
    conditionId: createConditionId(row.condition_id),
    profile: row.profile,
    state: row.state,
    assumedAt: row.assumed_at,
    lastAvgEntry: row.last_avg_entry,
    lastTransitionAt: row.last_transition_at,
    activeLadderId: row.active_ladder_id,
    handoffStartedAt: row.handoff_started_at,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseMetadata(raw: string | null): Readonly<Record<string, unknown>> | null {
  if (raw == null || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function cloneState(state: ExecutionProfileStateRecord): ExecutionProfileStateRecord {
  return {
    ...state,
    metadata: state.metadata == null ? null : { ...state.metadata },
  };
}

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const PAGE_SIZE = 500;
const OFFSET_CAP = 3_000;
const OVERLAP_SECONDS = 24 * 60 * 60;
const INITIAL_SECONDS = 72 * 60 * 60;
const DATA_API_URL = "https://data-api.polymarket.com/activity";
const TRANSIENT_IDENTITY_OUTCOME_INDEX = 999;
const TRANSIENT_IDENTITY_ROWS_STATE = "v2_transient_identity_rows_seen";
const TRANSIENT_IDENTITY_LAST_SEEN_STATE = "v2_transient_identity_last_seen_at";
export type ShadowActivityRow = {
  transactionHash: string;
  timestamp: number;
  conditionId: string;
  asset: string;
  outcome: string;
  outcomeIndex: number;
  price: number;
  size: number;
  usdcSize: number;
};
export type ShadowTarget = {
  tokenId: string;
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  generation: number;
  baseline: boolean;
  detectionLagMs: number;
  coverageStartedAt: number;
  coverageEndsAt: number;
  downstreamGraceStartedAt: number | null;
  downstreamGraceEndsAt: number | null;
};
export type ShadowObservation = ShadowTarget & {
  stage: string;
  result: string;
  observedAt: number;
  payload: Readonly<Record<string, unknown>>;
};
export class ActivitySourceSaturatedError extends Error {}
type FetchPage = (url: URL, signal?: AbortSignal) => Promise<unknown>;
export async function fetchActivityWindow(
  fetchPage: FetchPage,
  cursorSeconds: number | null,
  nowSeconds: number,
  wallet = "test-wallet",
  signal?: AbortSignal,
): Promise<ShadowActivityRow[]> {
  signal?.throwIfAborted();
  const floor =
    cursorSeconds == null ? nowSeconds - INITIAL_SECONDS : cursorSeconds - OVERLAP_SECONDS;
  const deduped = new Map<string, ShadowActivityRow>();
  let offset = 0;
  let end: number | null = null;
  for (;;) {
    const url = new URL(DATA_API_URL);
    url.searchParams.set("user", wallet);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sortBy", "TIMESTAMP");
    url.searchParams.set("sortDirection", "DESC");
    if (end != null) url.searchParams.set("end", String(end));
    const raw = await fetchPage(url, signal);
    if (!Array.isArray(raw)) throw new Error("invalid activity response");
    if (raw.length === 0) break;
    const timestamps = raw.map(readTimestamp);
    const pageMin = Math.min(...timestamps);
    for (const item of raw) {
      if (!isBuyTrade(item)) continue;
      const row = parseActivityRow(item);
      if (row.timestamp >= floor) deduped.set(activityKey(row), row);
    }
    if (pageMin <= floor || raw.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (offset < OFFSET_CAP) continue;
    await fetchBoundarySecond(fetchPage, wallet, pageMin, deduped, floor, signal);
    end = pageMin - 1;
    offset = 0;
  }
  return [...deduped.values()];
}

async function fetchBoundarySecond(
  fetchPage: FetchPage,
  wallet: string,
  timestamp: number,
  rows: Map<string, ShadowActivityRow>,
  floor: number,
  signal?: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset <= OFFSET_CAP; offset += PAGE_SIZE) {
    const url = new URL(DATA_API_URL);
    for (const [key, value] of Object.entries({
      user: wallet,
      limit: PAGE_SIZE,
      offset,
      sortBy: "TIMESTAMP",
      sortDirection: "DESC",
      start: timestamp,
      end: timestamp,
    })) {
      url.searchParams.set(key, String(value));
    }
    signal?.throwIfAborted();
    const raw = await fetchPage(url, signal);
    if (!Array.isArray(raw)) throw new Error("invalid activity response");
    if (offset === OFFSET_CAP) {
      if (raw.length > 0) throw new ActivitySourceSaturatedError();
      return;
    }
    for (const item of raw) {
      if (readTimestamp(item) !== timestamp) throw new Error("invalid boundary activity timestamp");
      if (isBuyTrade(item)) {
        const row = parseActivityRow(item);
        if (row.timestamp >= floor) rows.set(activityKey(row), row);
      }
    }
    if (raw.length < PAGE_SIZE) return;
  }
}

function isBuyTrade(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    String(row["type"] ?? "").toUpperCase() === "TRADE" &&
    String(row["side"] ?? "").toUpperCase() === "BUY"
  );
}

function readTimestamp(value: unknown): number {
  if (!value || typeof value !== "object") throw new Error("invalid activity timestamp");
  const timestamp = Number((value as Record<string, unknown>)["timestamp"]);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0)
    throw new Error("invalid activity timestamp");
  return timestamp;
}

function parseActivityRow(value: unknown): ShadowActivityRow {
  const row = value as Record<string, unknown>;
  const parsed = {
    transactionHash: String(row["transactionHash"] ?? ""),
    timestamp: readTimestamp(value),
    conditionId: String(row["conditionId"] ?? ""),
    asset: String(row["asset"] ?? ""),
    outcome: String(row["outcome"] ?? ""),
    outcomeIndex: Number(row["outcomeIndex"]),
    price: Number(row["price"]),
    size: Number(row["size"]),
    usdcSize: Number(row["usdcSize"]),
  };
  if (
    !parsed.transactionHash ||
    !parsed.conditionId ||
    !parsed.asset ||
    !parsed.outcome ||
    !Number.isInteger(parsed.outcomeIndex) ||
    parsed.outcomeIndex < 0 ||
    !Number.isFinite(parsed.price) ||
    parsed.price <= 0 ||
    !Number.isFinite(parsed.size) ||
    parsed.size <= 0 ||
    !Number.isFinite(parsed.usdcSize) ||
    parsed.usdcSize <= 0
  )
    throw new Error("invalid BUY activity row");
  return parsed;
}

function activityKey(row: ShadowActivityRow): string {
  return [row.transactionHash, row.conditionId, row.asset, row.outcomeIndex].join("\0");
}
const V2_STAGES = ["scanner", "tracking", "normalized", "algo", "signal"] as const;
const GRACE_STAGES = ["grace_tracking", "grace_normalized", "grace_algo", "grace_signal"] as const;
type PollStatus = "ok" | "unavailable" | "source_saturated" | "interrupted";

export class ShadowStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.createLegacySchema();
    this.migrateV3(Date.now());
    this.finalizeInterruptedPolls(Date.now());
    if (path !== ":memory:") chmodSync(path, 0o600);
  }

  readCursor(): number | null {
    return this.readIntegerState("v2_activity_cursor");
  }

  isBaselineDone(): boolean {
    return this.readState("v2_baseline_done") === "1";
  }

  beginPoll(startedAt: number): number {
    const cursor = this.readCursor();
    return Number(
      this.db
        .prepare(
          `INSERT INTO shadow_poll_runs_v2
          (started_at,status,cursor_before) VALUES (?,'running',?)`,
        )
        .run(startedAt, cursor).lastInsertRowid,
    );
  }

  failPoll(pollId: number, status: Exclude<PollStatus, "ok">, code: string, at: number): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE shadow_poll_runs_v2 SET completed_at=?,status=?,error_code=?,cursor_after=?
          WHERE poll_id=? AND status='running'`,
        )
        .run(at, status, code, this.readCursor(), pollId);
      this.setState("v2_last_failure_at", String(at));
      this.setState("v2_consecutive_failures", String(this.failureCount() + 1));
    })();
  }

  commitActivity(
    rows: readonly ShadowActivityRow[],
    baseline: boolean,
    detectedAt: number,
    coverageMs = 60_000,
    pollId?: number,
  ): ShadowTarget[] {
    const normalized = rows.map(parseActivityRow);
    const canonical = normalized.filter(
      (row) => row.outcomeIndex !== TRANSIENT_IDENTITY_OUTCOME_INDEX,
    );
    const transientCount = normalized.length - canonical.length;
    return this.db.transaction(() => {
      this.recordTransientIdentityRows(transientCount, detectedAt);
      const inserted = this.insertActivity(canonical, baseline, detectedAt);
      const groups = this.collectUnmapped(canonical);
      const targets = [...groups.values()].map((group) =>
        this.createTarget(group, baseline, detectedAt, coverageMs),
      );
      this.advanceCursor(canonical);
      if (baseline) this.setState("v2_baseline_done", "1");
      this.finishSuccessfulPoll(pollId, detectedAt, normalized.length, inserted, targets.length);
      return targets;
    })();
  }

  readTargets(): ShadowTarget[] {
    const rows = this.db
      .prepare(
        `${targetSelect()} FROM shadow_targets_v2 WHERE closed_at IS NULL
        ORDER BY token_id, condition_id, outcome_index, generation`,
      )
      .all() as Array<Omit<ShadowTarget, "baseline"> & { baseline: number }>;
    return rows.map(normalizeTarget);
  }

  recordObservation(input: ShadowObservation): void {
    this.recordObservations([input]);
  }

  recordObservations(inputs: readonly ShadowObservation[]): void {
    this.db.transaction(() => {
      for (const input of inputs) this.recordObservationInner(input);
    })();
  }

  completeSuccessfulScan(
    inputs: readonly ShadowObservation[],
    scanStartedAt: number,
    completedAt: number,
    downstreamGraceMs: number,
  ): ShadowTarget[] {
    return this.db.transaction(() => {
      for (const input of inputs) this.recordObservationInner(input);
      const granted = new Map<string, ShadowTarget>();
      for (const input of inputs) {
        const target = this.grantDownstreamGrace(
          input,
          scanStartedAt,
          completedAt,
          downstreamGraceMs,
        );
        if (target) granted.set(targetKey(target), target);
      }
      return [...granted.values()];
    })();
  }

  maintain(
    now: number,
    retentionMs: number,
    activeScanStarts: readonly number[] = [],
  ): ShadowTarget[] {
    return this.db.transaction(() => {
      const expired = this.readExpiredTargets(now);
      const closed = expired.filter((target) =>
        this.finalizeExpiredTarget(target, now, activeScanStarts),
      );
      this.prune(now - retentionMs);
      return closed;
    })();
  }

  readObservation(
    target: Pick<ShadowTarget, "conditionId" | "tokenId" | "outcomeIndex" | "generation">,
    stage: string,
  ): { outcome: string; lastSeenAt: number } | null {
    return (
      (this.db
        .prepare(
          `SELECT result outcome, last_seen_at lastSeenAt FROM shadow_observations_v2
          WHERE condition_id=? AND token_id=? AND outcome_index=? AND generation=? AND stage=?
          ORDER BY last_seen_at DESC LIMIT 1`,
        )
        .get(target.conditionId, target.tokenId, target.outcomeIndex, target.generation, stage) as
        | { outcome: string; lastSeenAt: number }
        | undefined) ?? null
    );
  }

  healthState(): {
    lastSuccessAt: number | null;
    consecutiveFailures: number;
    transientIdentityRowsSeen: number;
    transientIdentityLastSeenAt: number | null;
  } {
    return {
      lastSuccessAt: this.readIntegerState("v2_last_success_at"),
      consecutiveFailures: this.failureCount(),
      transientIdentityRowsSeen: this.readIntegerState(TRANSIENT_IDENTITY_ROWS_STATE) ?? 0,
      transientIdentityLastSeenAt: this.readIntegerState(TRANSIENT_IDENTITY_LAST_SEEN_STATE),
    };
  }

  close(): void {
    this.db.close();
  }

  private createLegacySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shadow_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plankton_buy_activity (
        transaction_hash TEXT NOT NULL, condition_id TEXT NOT NULL, token_id TEXT NOT NULL,
        outcome TEXT NOT NULL, outcome_index INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
        price REAL NOT NULL, size REAL NOT NULL, usdc_size REAL NOT NULL,
        first_seen_at INTEGER NOT NULL, is_baseline INTEGER NOT NULL, target_generation INTEGER,
        PRIMARY KEY(transaction_hash, condition_id, token_id, outcome_index)
      );
      CREATE TABLE IF NOT EXISTS shadow_targets (
        condition_id TEXT NOT NULL, token_id TEXT NOT NULL, outcome TEXT NOT NULL,
        outcome_index INTEGER NOT NULL, generation INTEGER NOT NULL, is_baseline INTEGER NOT NULL,
        first_buy_at INTEGER NOT NULL, last_buy_at INTEGER NOT NULL, detected_at INTEGER NOT NULL,
        scanner_at INTEGER, scanner_outcome TEXT, tracked_at INTEGER, normalized_at INTEGER,
        algo_at INTEGER, planner_signal_at INTEGER, signal_at INTEGER,
        PRIMARY KEY(condition_id, token_id, outcome_index, generation)
      );
      CREATE TABLE IF NOT EXISTS shadow_observations (
        condition_id TEXT NOT NULL, token_id TEXT NOT NULL, outcome_index INTEGER NOT NULL,
        generation INTEGER NOT NULL, stage TEXT NOT NULL, result TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, seen_count INTEGER NOT NULL,
        payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY(condition_id, token_id, outcome_index, generation, stage, result, payload_hash),
        FOREIGN KEY(condition_id, token_id, outcome_index, generation)
          REFERENCES shadow_targets(condition_id, token_id, outcome_index, generation) ON DELETE CASCADE
      );`);
  }

  private migrateV3(now: number): void {
    this.db.transaction(() => {
      if (!this.hasActivityColumn("target_generation_v2"))
        this.db.exec("ALTER TABLE plankton_buy_activity ADD COLUMN target_generation_v2 INTEGER");
      this.db.exec(v2SchemaSql());
      if (!this.hasTargetColumn("downstream_grace_started_at"))
        this.db.exec(
          "ALTER TABLE shadow_targets_v2 ADD COLUMN downstream_grace_started_at INTEGER",
        );
      if (!this.hasTargetColumn("downstream_grace_ends_at"))
        this.db.exec("ALTER TABLE shadow_targets_v2 ADD COLUMN downstream_grace_ends_at INTEGER");
      if (this.readState("v2_started_at") == null) this.setState("v2_started_at", String(now));
      this.db.pragma("user_version = 3");
    })();
  }

  private hasActivityColumn(name: string): boolean {
    return (this.db.pragma("table_info(plankton_buy_activity)") as Array<{ name: string }>).some(
      (column) => column.name === name,
    );
  }

  private hasTargetColumn(name: string): boolean {
    return (this.db.pragma("table_info(shadow_targets_v2)") as Array<{ name: string }>).some(
      (column) => column.name === name,
    );
  }

  private finalizeInterruptedPolls(now: number): void {
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE shadow_poll_runs_v2 SET completed_at=?,status='interrupted',
          error_code='worker_interrupted',cursor_after=cursor_before WHERE status='running'`,
        )
        .run(now);
      if (result.changes === 0) return;
      this.setState("v2_last_failure_at", String(now));
      this.setState("v2_consecutive_failures", String(this.failureCount() + result.changes));
    })();
  }

  private insertActivity(
    rows: readonly ShadowActivityRow[],
    baseline: boolean,
    at: number,
  ): number {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO plankton_buy_activity
      (transaction_hash,condition_id,token_id,outcome,outcome_index,occurred_at,price,size,
       usdc_size,first_seen_at,is_baseline,target_generation) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`);
    let inserted = 0;
    for (const row of rows) {
      inserted += insert.run(...activityValues(row), at, baseline ? 1 : 0).changes;
    }
    return inserted;
  }

  private collectUnmapped(rows: readonly ShadowActivityRow[]): Map<string, ShadowActivityRow[]> {
    const groups = new Map<string, ShadowActivityRow[]>();
    const read = this.db.prepare(`${activitySelect()} WHERE transaction_hash=? AND condition_id=?
      AND token_id=? AND outcome_index=? AND target_generation_v2 IS NULL`);
    for (const row of rows) {
      const stored = read.get(row.transactionHash, row.conditionId, row.asset, row.outcomeIndex) as
        | ShadowActivityRow
        | undefined;
      if (!stored) continue;
      const key = pairKey(stored.conditionId, stored.asset, stored.outcomeIndex);
      groups.set(key, [...(groups.get(key) ?? []), stored]);
    }
    return groups;
  }

  private createTarget(
    rows: readonly ShadowActivityRow[],
    baseline: boolean,
    detectedAt: number,
    coverageMs: number,
  ): ShadowTarget {
    const first = rows[0]!;
    if (rows.some((row) => row.outcome !== first.outcome))
      throw new Error("target outcome identity mismatch");
    const generation = this.nextGeneration(first);
    const times = rows.map((row) => row.timestamp);
    const target: ShadowTarget = {
      tokenId: first.asset,
      conditionId: first.conditionId,
      outcome: first.outcome,
      outcomeIndex: first.outcomeIndex,
      generation,
      baseline,
      detectionLagMs: Math.max(0, detectedAt - Math.max(...times) * 1_000),
      coverageStartedAt: detectedAt,
      coverageEndsAt: detectedAt + coverageMs,
      downstreamGraceStartedAt: null,
      downstreamGraceEndsAt: null,
    };
    this.insertTarget(target, Math.min(...times), Math.max(...times), detectedAt);
    this.linkActivity(rows, generation);
    return target;
  }

  private nextGeneration(row: ShadowActivityRow): number {
    const prior = this.db
      .prepare(
        `SELECT outcome,MAX(generation) generation FROM shadow_targets_v2
        WHERE condition_id=? AND token_id=? AND outcome_index=?`,
      )
      .get(row.conditionId, row.asset, row.outcomeIndex) as {
      outcome: string | null;
      generation: number | null;
    };
    if (prior.outcome != null && prior.outcome !== row.outcome)
      throw new Error("target outcome identity mismatch");
    return Number(prior.generation ?? 0) + 1;
  }

  private insertTarget(
    target: ShadowTarget,
    firstBuyAt: number,
    lastBuyAt: number,
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO shadow_targets_v2
        (condition_id,token_id,outcome,outcome_index,generation,is_baseline,first_buy_at,last_buy_at,
         detected_at,coverage_started_at,coverage_ends_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        target.conditionId,
        target.tokenId,
        target.outcome,
        target.outcomeIndex,
        target.generation,
        target.baseline ? 1 : 0,
        firstBuyAt,
        lastBuyAt,
        at,
        target.coverageStartedAt,
        target.coverageEndsAt,
      );
  }

  private linkActivity(rows: readonly ShadowActivityRow[], generation: number): void {
    const link = this.db.prepare(`UPDATE plankton_buy_activity SET target_generation_v2=?
      WHERE transaction_hash=? AND condition_id=? AND token_id=? AND outcome_index=?
      AND target_generation_v2 IS NULL`);
    for (const row of rows)
      link.run(generation, row.transactionHash, row.conditionId, row.asset, row.outcomeIndex);
  }

  private advanceCursor(rows: readonly ShadowActivityRow[]): void {
    const next = rows.reduce((max, row) => Math.max(max, row.timestamp), this.readCursor() ?? 0);
    if (next > 0) this.setState("v2_activity_cursor", String(next));
  }

  private recordTransientIdentityRows(count: number, at: number): void {
    if (count === 0) return;
    const seen = this.readIntegerState(TRANSIENT_IDENTITY_ROWS_STATE) ?? 0;
    this.setState(TRANSIENT_IDENTITY_ROWS_STATE, String(seen + count));
    this.setState(TRANSIENT_IDENTITY_LAST_SEEN_STATE, String(at));
  }

  private finishSuccessfulPoll(
    pollId: number | undefined,
    at: number,
    seen: number,
    inserted: number,
    targets: number,
  ): void {
    if (pollId != null)
      this.db
        .prepare(
          `UPDATE shadow_poll_runs_v2 SET completed_at=?,status='ok',cursor_after=?,
          rows_seen=?,rows_inserted=?,targets_created=? WHERE poll_id=? AND status='running'`,
        )
        .run(at, this.readCursor(), seen, inserted, targets, pollId);
    this.setState("v2_last_success_at", String(at));
    this.setState("v2_consecutive_failures", "0");
  }

  private recordObservationInner(input: ShadowObservation): void {
    const row = this.db
      .prepare(
        `${targetSelect()} FROM shadow_targets_v2 WHERE condition_id=? AND token_id=?
        AND outcome_index=? AND generation=? AND closed_at IS NULL`,
      )
      .get(input.conditionId, input.tokenId, input.outcomeIndex, input.generation) as
      | (Omit<ShadowTarget, "baseline"> & { baseline: number })
      | undefined;
    if (!row || row.outcome !== input.outcome) return;
    const observation = observationForWindow(input, normalizeTarget(row));
    if (!observation) return;
    if (observation.stage !== "scanner" && this.hasStageGap(observation, observation.stage)) return;
    this.upsertObservation(observation, this.compactPolicies(observation.payload));
  }

  private grantDownstreamGrace(
    input: ShadowObservation,
    scanStartedAt: number,
    completedAt: number,
    downstreamGraceMs: number,
  ): ShadowTarget | null {
    if (input.stage !== "scanner" || input.result !== "include" || downstreamGraceMs <= 0)
      return null;
    const downstreamGraceEndsAt = completedAt + downstreamGraceMs;
    const result = this.db
      .prepare(
        `UPDATE shadow_targets_v2 SET
          downstream_grace_started_at=MAX(coverage_ends_at,?),downstream_grace_ends_at=?
        WHERE condition_id=? AND token_id=? AND outcome_index=? AND generation=?
          AND outcome=? AND is_baseline=0 AND closed_at IS NULL
          AND downstream_grace_ends_at IS NULL
          AND coverage_started_at<=? AND ?<coverage_ends_at
          AND coverage_started_at<=? AND ?<coverage_ends_at AND coverage_ends_at<?`,
      )
      .run(
        completedAt,
        downstreamGraceEndsAt,
        input.conditionId,
        input.tokenId,
        input.outcomeIndex,
        input.generation,
        input.outcome,
        scanStartedAt,
        scanStartedAt,
        input.observedAt,
        input.observedAt,
        downstreamGraceEndsAt,
      );
    if (result.changes === 0) return null;
    return this.readTarget(input);
  }

  private readTarget(
    target: Pick<ShadowTarget, "conditionId" | "tokenId" | "outcomeIndex" | "generation">,
  ): ShadowTarget {
    const row = this.db
      .prepare(
        `${targetSelect()} FROM shadow_targets_v2 WHERE condition_id=? AND token_id=?
        AND outcome_index=? AND generation=?`,
      )
      .get(target.conditionId, target.tokenId, target.outcomeIndex, target.generation) as Omit<
      ShadowTarget,
      "baseline"
    > & { baseline: number };
    return normalizeTarget(row);
  }

  private compactPolicies(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const compact = { ...payload };
    for (const key of ["marketSelectionPolicy", "executionPolicy"] as const) {
      if (compact[key] == null) continue;
      const json = canonicalJson(compact[key]);
      const hash = createHash("sha256").update(json).digest("hex");
      this.setState(`v2_policy:${key}:${hash}`, json);
      delete compact[key];
      compact[`${key}Hash`] = hash;
    }
    return compact;
  }

  private upsertObservation(input: ShadowObservation, payload: Record<string, unknown>): void {
    const payloadJson = canonicalJson(payload);
    this.db
      .prepare(
        `INSERT INTO shadow_observations_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(condition_id,token_id,outcome_index,generation,stage,result,payload_hash)
        DO UPDATE SET last_seen_at=excluded.last_seen_at,seen_count=seen_count+1`,
      )
      .run(
        input.conditionId,
        input.tokenId,
        input.outcomeIndex,
        input.generation,
        input.stage,
        input.result,
        input.observedAt,
        input.observedAt,
        1,
        createHash("sha256").update(payloadJson).digest("hex"),
        payloadJson,
      );
  }

  private readExpiredTargets(now: number): ShadowTarget[] {
    const rows = this.db
      .prepare(
        `${targetSelect()} FROM shadow_targets_v2
        WHERE closed_at IS NULL AND coverage_ends_at<=? ORDER BY coverage_ends_at`,
      )
      .all(now) as Array<Omit<ShadowTarget, "baseline"> & { baseline: number }>;
    return rows.map(normalizeTarget);
  }

  private finalizeExpiredTarget(
    target: ShadowTarget,
    now: number,
    activeScanStarts: readonly number[],
  ): boolean {
    const deferScanner = activeScanStarts.some(
      (startedAt) => target.coverageStartedAt <= startedAt && startedAt < target.coverageEndsAt,
    );
    for (const stage of V2_STAGES) {
      if (stage === "scanner" && deferScanner) continue;
      this.finalizeStageGap(target, stage);
    }
    if (target.downstreamGraceEndsAt != null) {
      if (!this.finalizeGrace(target, now) || deferScanner) return false;
      this.closeTarget(target);
      return true;
    }
    if (deferScanner) return false;
    this.closeTarget(target);
    return true;
  }

  private finalizeGrace(target: ShadowTarget, now: number): boolean {
    const endsAt = target.downstreamGraceEndsAt!;
    if (now < endsAt) return false;
    for (const stage of GRACE_STAGES) this.finalizeStageGap(target, stage, endsAt);
    return true;
  }

  private closeTarget(target: ShadowTarget): void {
    this.db
      .prepare(
        `UPDATE shadow_targets_v2 SET closed_at=?,close_reason=?
        WHERE condition_id=? AND token_id=? AND outcome_index=? AND generation=? AND closed_at IS NULL`,
      )
      .run(
        target.coverageEndsAt,
        "window_elapsed",
        target.conditionId,
        target.tokenId,
        target.outcomeIndex,
        target.generation,
      );
  }

  private finalizeStageGap(
    target: ShadowTarget,
    stage: string,
    observedAt = target.coverageEndsAt,
  ): void {
    if (this.hasStageEvidence(target, stage) || this.hasStageGap(target, stage)) return;
    const payload = {
      meaning: stage.startsWith("grace_")
        ? "best_effort_post_scan_downstream_observation_absent"
        : "best_effort_post_detection_observation_absent",
    };
    this.upsertObservation(
      { ...target, stage, result: "telemetry_gap", observedAt, payload },
      payload,
    );
  }

  private hasStageEvidence(target: ShadowTarget, stage: string): boolean {
    const signalClause = stage.endsWith("signal") ? " AND result='produced_buy'" : "";
    return (
      this.db
        .prepare(
          `SELECT 1 FROM shadow_observations_v2 WHERE condition_id=? AND token_id=?
          AND outcome_index=? AND generation=? AND stage=? AND result!='telemetry_gap'${signalClause}
          LIMIT 1`,
        )
        .get(target.conditionId, target.tokenId, target.outcomeIndex, target.generation, stage) !=
      null
    );
  }

  private hasStageGap(
    target: Pick<ShadowTarget, "conditionId" | "tokenId" | "outcomeIndex" | "generation">,
    stage: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM shadow_observations_v2 WHERE condition_id=? AND token_id=?
          AND outcome_index=? AND generation=? AND stage=? AND result='telemetry_gap' LIMIT 1`,
        )
        .get(target.conditionId, target.tokenId, target.outcomeIndex, target.generation, stage) !=
      null
    );
  }

  private prune(beforeMs: number): void {
    this.db.prepare("DELETE FROM plankton_buy_activity WHERE first_seen_at < ?").run(beforeMs);
    this.db.prepare("DELETE FROM shadow_targets WHERE detected_at < ?").run(beforeMs);
    this.db.prepare("DELETE FROM shadow_targets_v2 WHERE detected_at < ?").run(beforeMs);
    this.db
      .prepare("DELETE FROM shadow_poll_runs_v2 WHERE started_at < ? AND status!='running'")
      .run(beforeMs);
  }

  private failureCount(): number {
    return this.readIntegerState("v2_consecutive_failures") ?? 0;
  }

  private readIntegerState(key: string): number | null {
    const raw = this.readState(key);
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }

  private readState(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM shadow_state WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO shadow_state(key,value) VALUES (?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(key, value);
  }
}

function activityValues(row: ShadowActivityRow): readonly unknown[] {
  return [
    row.transactionHash,
    row.conditionId,
    row.asset,
    row.outcome,
    row.outcomeIndex,
    row.timestamp,
    row.price,
    row.size,
    row.usdcSize,
  ];
}

function activitySelect(): string {
  return `SELECT transaction_hash transactionHash,occurred_at timestamp,condition_id conditionId,
    token_id asset,outcome,outcome_index outcomeIndex,price,size,usdc_size usdcSize
    FROM plankton_buy_activity`;
}

function targetSelect(): string {
  return `SELECT token_id tokenId,condition_id conditionId,outcome,outcome_index outcomeIndex,
    generation,is_baseline baseline,detected_at-last_buy_at*1000 detectionLagMs,
    coverage_started_at coverageStartedAt,coverage_ends_at coverageEndsAt,
    downstream_grace_started_at downstreamGraceStartedAt,
    downstream_grace_ends_at downstreamGraceEndsAt`;
}

function normalizeTarget(row: Omit<ShadowTarget, "baseline"> & { baseline: number }): ShadowTarget {
  return { ...row, baseline: Boolean(row.baseline) };
}

function v2SchemaSql(): string {
  return `CREATE TABLE IF NOT EXISTS shadow_targets_v2 (
      condition_id TEXT NOT NULL,token_id TEXT NOT NULL,outcome TEXT NOT NULL,
      outcome_index INTEGER NOT NULL,generation INTEGER NOT NULL,is_baseline INTEGER NOT NULL,
      first_buy_at INTEGER NOT NULL,last_buy_at INTEGER NOT NULL,detected_at INTEGER NOT NULL,
      coverage_started_at INTEGER NOT NULL,coverage_ends_at INTEGER NOT NULL,
      closed_at INTEGER,close_reason TEXT,
      PRIMARY KEY(condition_id,token_id,outcome_index,generation)
    );
    CREATE TABLE IF NOT EXISTS shadow_observations_v2 (
      condition_id TEXT NOT NULL,token_id TEXT NOT NULL,outcome_index INTEGER NOT NULL,
      generation INTEGER NOT NULL,stage TEXT NOT NULL,result TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,seen_count INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,
      PRIMARY KEY(condition_id,token_id,outcome_index,generation,stage,result,payload_hash),
      FOREIGN KEY(condition_id,token_id,outcome_index,generation)
        REFERENCES shadow_targets_v2(condition_id,token_id,outcome_index,generation) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS shadow_poll_runs_v2 (
      poll_id INTEGER PRIMARY KEY AUTOINCREMENT,started_at INTEGER NOT NULL,completed_at INTEGER,
      status TEXT NOT NULL,error_code TEXT,cursor_before INTEGER,cursor_after INTEGER,
      rows_seen INTEGER NOT NULL DEFAULT 0,rows_inserted INTEGER NOT NULL DEFAULT 0,
      targets_created INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_targets_v2_open
      ON shadow_targets_v2(closed_at,coverage_ends_at);`;
}

function pairKey(conditionId: string, tokenId: string, outcomeIndex: number): string {
  return `${conditionId}\0${tokenId}\0${outcomeIndex}`;
}

function targetKey(
  target: Pick<ShadowTarget, "conditionId" | "tokenId" | "outcomeIndex" | "generation">,
): string {
  return `${target.conditionId}\0${target.tokenId}\0${target.outcomeIndex}\0${target.generation}`;
}

function observationForWindow(
  observation: ShadowObservation,
  target: ShadowTarget,
): ShadowObservation | null {
  if (observation.stage.startsWith("grace_"))
    return target.downstreamGraceStartedAt != null &&
      target.downstreamGraceEndsAt != null &&
      target.downstreamGraceStartedAt <= observation.observedAt &&
      observation.observedAt < target.downstreamGraceEndsAt
      ? observation
      : null;
  if (
    target.coverageStartedAt <= observation.observedAt &&
    observation.observedAt < target.coverageEndsAt
  )
    return observation;
  if (
    observation.stage !== "scanner" &&
    target.downstreamGraceStartedAt != null &&
    target.downstreamGraceEndsAt != null &&
    target.downstreamGraceStartedAt <= observation.observedAt &&
    observation.observedAt < target.downstreamGraceEndsAt
  )
    return { ...observation, stage: `grace_${observation.stage}` };
  return null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export type ShadowWorkerConfig = {
  dbPath: string;
  wallet: string;
  pollMs: number;
  retentionMs: number;
  timeouts: { scannerMs: number; trackingMs: number; algoMs: number };
};

type ShadowWorkerPort = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
};

export class ShadowWorkerRuntime {
  private readonly store: ShadowStore;
  private readonly scans = new Map<
    string,
    { startedAt: number; observations: ShadowObservation[] }
  >();
  private timer: ReturnType<typeof setInterval> | null = null;
  private controller: AbortController | null = null;
  private inFlight: Promise<void> | null = null;
  private stopping = false;
  private saturated = false;
  private source = "starting";

  constructor(
    private readonly config: ShadowWorkerConfig,
    private readonly port: ShadowWorkerPort,
    private readonly fetchPage: FetchPage = fetchJson,
  ) {
    this.store = new ShadowStore(config.dbPath);
  }

  start(): void {
    this.maintainTargets(Date.now());
    this.port.on("message", (message) => this.onMessage(message));
    this.port.postMessage({ type: "ready", targets: this.store.readTargets() });
    this.timer = setInterval(() => this.startTick(), this.config.pollMs);
    this.startTick();
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.inFlight;
    this.store.close();
    this.port.postMessage({ type: "stopped" });
  }

  private startTick(): void {
    if (this.stopping || this.inFlight) return;
    const controller = new AbortController();
    this.controller = controller;
    const tick = this.runTick(controller.signal).finally(() => {
      if (this.inFlight === tick) this.inFlight = null;
      if (this.controller === controller) this.controller = null;
    });
    this.inFlight = tick;
  }

  private async runTick(signal: AbortSignal): Promise<void> {
    if (!this.saturated) await this.pollSource(signal);
    this.maintainTargets(Date.now());
    if (!this.stopping) this.publishHealth();
  }

  private async pollSource(signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    const pollId = this.store.beginPoll(startedAt);
    try {
      const rows = await fetchActivityWindow(
        this.fetchPage,
        this.store.readCursor(),
        Math.floor(startedAt / 1_000),
        this.config.wallet,
        signal,
      );
      const detectedAt = Date.now();
      const targets = this.store.commitActivity(
        rows,
        !this.store.isBaselineDone(),
        detectedAt,
        coverageWindowMs(this.config.timeouts),
        pollId,
      );
      for (const target of targets) this.port.postMessage({ type: "target_added", target });
      this.source = "ok";
    } catch (error) {
      const status = pollFailureStatus(error, signal);
      this.store.failPoll(pollId, status, pollFailureCode(error, signal), Date.now());
      this.saturated = status === "source_saturated";
      this.source = status;
    }
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value["type"] === "shutdown") void this.shutdown();
    else if (value["type"] === "scan_started") this.startScan(value);
    else if (value["type"] === "scan_evaluation") this.addScanEvaluation(value);
    else if (value["type"] === "scan_completed") this.completeScan(value);
    else if (value["type"] === "scan_failed") this.failScan(value);
    else if (value["type"] === "observation")
      this.store.recordObservation(value as unknown as ShadowObservation);
  }

  private addScanEvaluation(value: Record<string, unknown>): void {
    const scan = this.scans.get(String(value["scanId"]));
    if (scan) scan.observations.push(value["observation"] as ShadowObservation);
  }

  private startScan(value: Record<string, unknown>): void {
    const scanId = value["scanId"];
    const startedAt = Number(value["observedAt"]);
    if (typeof scanId !== "string" || scanId.length === 0) return;
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0) return;
    this.scans.set(scanId, { startedAt, observations: [] });
  }

  private completeScan(value: Record<string, unknown>): void {
    const scanId = String(value["scanId"]);
    const scan = this.scans.get(scanId);
    const completedAt = messageTime(value);
    const granted = scan
      ? this.store.completeSuccessfulScan(
          scan.observations,
          scan.startedAt,
          completedAt,
          downstreamGraceWindowMs(this.config.timeouts),
        )
      : [];
    this.scans.delete(scanId);
    for (const target of granted) this.port.postMessage({ type: "target_grace_started", target });
    this.maintainTargets(completedAt);
  }

  private failScan(value: Record<string, unknown>): void {
    this.scans.delete(String(value["scanId"]));
    this.maintainTargets(messageTime(value));
  }

  private maintainTargets(now: number): void {
    const activeStarts = [...this.scans.values()].map((scan) => scan.startedAt);
    this.emitClosed(this.store.maintain(now, this.config.retentionMs, activeStarts));
  }

  private emitClosed(targets: readonly ShadowTarget[]): void {
    for (const target of targets) this.port.postMessage({ type: "target_closed", target });
  }

  private publishHealth(): void {
    this.port.postMessage({
      type: "health",
      source: this.source,
      cursor: this.store.readCursor(),
      targets: this.store.readTargets().length,
      ...this.store.healthState(),
    });
  }
}

function coverageWindowMs(timeouts: ShadowWorkerConfig["timeouts"]): number {
  return 2 * timeouts.scannerMs + 2 * timeouts.trackingMs + 2 * timeouts.algoMs;
}

function downstreamGraceWindowMs(timeouts: ShadowWorkerConfig["timeouts"]): number {
  return 2 * timeouts.trackingMs + 2 * timeouts.algoMs;
}

function messageTime(value: Record<string, unknown>): number {
  const observedAt = Number(value["observedAt"]);
  return Number.isSafeInteger(observedAt) && observedAt > 0 ? observedAt : Date.now();
}

function pollFailureStatus(error: unknown, signal: AbortSignal): Exclude<PollStatus, "ok"> {
  if (error instanceof ActivitySourceSaturatedError) return "source_saturated";
  return signal.aborted ? "interrupted" : "unavailable";
}

function pollFailureCode(error: unknown, signal: AbortSignal): string {
  if (error instanceof ActivitySourceSaturatedError) return "source_saturated";
  if (signal.aborted) return "worker_stopping";
  return "source_unavailable";
}

if (parentPort && workerData) {
  new ShadowWorkerRuntime(workerData as ShadowWorkerConfig, parentPort).start();
}

async function fetchJson(url: URL, signal?: AbortSignal): Promise<unknown> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
    : AbortSignal.timeout(5_000);
  const response = await fetch(url, { signal: requestSignal });
  if (!response.ok) throw new Error(`activity HTTP ${response.status}`);
  return response.json();
}

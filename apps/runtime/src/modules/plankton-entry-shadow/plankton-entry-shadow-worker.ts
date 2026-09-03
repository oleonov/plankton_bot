import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const PAGE_SIZE = 500;
const OFFSET_CAP = 3_000;
const OVERLAP_SECONDS = 24 * 60 * 60;
const INITIAL_SECONDS = 72 * 60 * 60;
const DATA_API_URL = "https://data-api.polymarket.com/activity";
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
};
export type ShadowObservation = ShadowTarget & {
  stage: string;
  result: string;
  observedAt: number;
  payload: Readonly<Record<string, unknown>>;
};
export class ActivitySourceSaturatedError extends Error {}
type FetchPage = (url: URL) => Promise<unknown>;
export async function fetchActivityWindow(
  fetchPage: FetchPage,
  cursorSeconds: number | null,
  nowSeconds: number,
  wallet = "test-wallet",
): Promise<ShadowActivityRow[]> {
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
    const raw = await fetchPage(url);
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
    await fetchBoundarySecond(fetchPage, wallet, pageMin, deduped, floor);
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
    const raw = await fetchPage(url);
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
export class ShadowStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
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
        scanner_at INTEGER, scanner_outcome TEXT,
        tracked_at INTEGER, normalized_at INTEGER, algo_at INTEGER,
        planner_signal_at INTEGER, signal_at INTEGER,
        PRIMARY KEY(condition_id, token_id, outcome_index, generation)
      );
      CREATE TABLE IF NOT EXISTS shadow_observations (
        condition_id TEXT NOT NULL, token_id TEXT NOT NULL, outcome_index INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        stage TEXT NOT NULL, result TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL, seen_count INTEGER NOT NULL,
        payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY(condition_id, token_id, outcome_index, generation, stage, result, payload_hash),
        FOREIGN KEY(condition_id, token_id, outcome_index, generation)
          REFERENCES shadow_targets(condition_id, token_id, outcome_index, generation) ON DELETE CASCADE
      );
    `);
    if (path !== ":memory:") chmodSync(path, 0o600);
  }

  readCursor(): number | null {
    const row = this.db
      .prepare("SELECT value FROM shadow_state WHERE key='activity_cursor'")
      .get() as { value: string } | undefined;
    const value = Number(row?.value);
    return row && Number.isSafeInteger(value) ? value : null;
  }

  isBaselineDone(): boolean {
    return this.db.prepare("SELECT 1 FROM shadow_state WHERE key='baseline_done'").get() != null;
  }

  commitActivity(
    rows: readonly ShadowActivityRow[],
    baseline: boolean,
    detectedAt: number,
  ): ShadowTarget[] {
    const normalized = rows.map(parseActivityRow);
    return this.db.transaction(() => {
      const groups = new Map<string, ShadowActivityRow[]>();
      const insert = this.db.prepare(`INSERT OR IGNORE INTO plankton_buy_activity
        (transaction_hash,condition_id,token_id,outcome,outcome_index,occurred_at,price,size,
         usdc_size,first_seen_at,is_baseline,target_generation) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`);
      for (const row of normalized) {
        const result = insert.run(
          row.transactionHash,
          row.conditionId,
          row.asset,
          row.outcome,
          row.outcomeIndex,
          row.timestamp,
          row.price,
          row.size,
          row.usdcSize,
          detectedAt,
          baseline ? 1 : 0,
        );
        if (result.changes === 0) continue;
        const key = pairKey(row.conditionId, row.asset, row.outcomeIndex);
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
      }
      const targets = [...groups.values()].map((group) =>
        this.createTarget(group, baseline, detectedAt),
      );
      const nextCursor = normalized.reduce(
        (max, row) => Math.max(max, row.timestamp),
        this.readCursor() ?? 0,
      );
      if (nextCursor > 0) this.setState("activity_cursor", String(nextCursor));
      if (baseline) this.setState("baseline_done", "1");
      return targets;
    })();
  }

  readTargets(): ShadowTarget[] {
    const rows = this.db
      .prepare(
        `SELECT token_id tokenId, condition_id conditionId, outcome, outcome_index outcomeIndex,
          generation, is_baseline baseline, detected_at-last_buy_at*1000 detectionLagMs
          FROM shadow_targets t
        WHERE NOT EXISTS (SELECT 1 FROM shadow_targets newer WHERE newer.condition_id=t.condition_id
          AND newer.token_id=t.token_id AND newer.outcome_index=t.outcome_index
          AND newer.generation>t.generation) ORDER BY token_id, condition_id`,
      )
      .all() as Array<Omit<ShadowTarget, "baseline"> & { baseline: number }>;
    return rows.map((row) => ({ ...row, baseline: Boolean(row.baseline) }));
  }

  recordObservation(input: ShadowObservation): void {
    this.recordObservations([input]);
  }
  recordObservations(inputs: readonly ShadowObservation[]): void {
    this.db.transaction(() => {
      const target = this.db.prepare(`SELECT outcome FROM shadow_targets
        WHERE condition_id=? AND token_id=? AND outcome_index=? AND generation=?
        AND NOT EXISTS (SELECT 1 FROM shadow_targets newer WHERE
          newer.condition_id=shadow_targets.condition_id AND newer.token_id=shadow_targets.token_id
          AND newer.outcome_index=shadow_targets.outcome_index
          AND newer.generation>shadow_targets.generation)`);
      const upsert = this.db.prepare(`INSERT INTO shadow_observations VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(condition_id,token_id,outcome_index,generation,stage,result,payload_hash)
        DO UPDATE SET last_seen_at=excluded.last_seen_at, seen_count=seen_count+1`);
      for (const input of inputs) {
        const current = target.get(
          input.conditionId,
          input.tokenId,
          input.outcomeIndex,
          input.generation,
        ) as { outcome: string } | undefined;
        if (!current || current.outcome !== input.outcome) continue;
        const payloadJson = canonicalJson(input.payload);
        upsert.run(
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
        this.markStage(input);
      }
    })();
  }

  recordTimeouts(
    now: number,
    timeouts: { scannerMs: number; trackingMs: number; algoMs: number },
  ): void {
    const rows = this.db
      .prepare(
        `SELECT condition_id conditionId, token_id tokenId, outcome,
      outcome_index outcomeIndex, generation, is_baseline baseline,
      detected_at detectedAt, scanner_at scannerAt,
      scanner_outcome scannerOutcome, tracked_at trackedAt, normalized_at normalizedAt, algo_at algoAt,
      planner_signal_at plannerSignalAt, signal_at signalAt
      FROM shadow_targets t WHERE NOT EXISTS (SELECT 1 FROM shadow_targets newer
        WHERE newer.condition_id=t.condition_id AND newer.token_id=t.token_id
        AND newer.outcome_index=t.outcome_index AND newer.generation>t.generation)`,
      )
      .all() as Array<ShadowTarget & Record<string, number | string | null>>;
    for (const row of rows) {
      const stage =
        row.scannerAt == null && now > Number(row.detectedAt) + timeouts.scannerMs
          ? "scanner"
          : row.scannerOutcome === "include" &&
              row.trackedAt == null &&
              now > Number(row.scannerAt) + timeouts.trackingMs
            ? "tracking"
            : row.trackedAt != null &&
                row.normalizedAt == null &&
                now > Number(row.trackedAt) + timeouts.trackingMs
              ? "normalized"
              : row.normalizedAt != null &&
                  row.algoAt == null &&
                  now > Number(row.normalizedAt) + timeouts.algoMs
                ? "algo"
                : row.plannerSignalAt != null &&
                    row.signalAt == null &&
                    now > Number(row.plannerSignalAt) + timeouts.algoMs
                  ? "signal"
                  : null;
      if (!stage || this.readObservation(row, stage)?.outcome === "telemetry_gap") continue;
      this.recordObservation({
        ...row,
        stage,
        result: "telemetry_gap",
        observedAt: now,
        payload: { meaning: "best_effort_runtime_observation_absent" },
      });
    }
  }

  readObservation(
    target: Pick<ShadowTarget, "conditionId" | "tokenId" | "outcomeIndex" | "generation">,
    stage: string,
  ): { outcome: string; lastSeenAt: number } | null {
    return (
      (this.db
        .prepare(
          `SELECT result outcome, last_seen_at lastSeenAt FROM shadow_observations
      WHERE condition_id=? AND token_id=? AND outcome_index=? AND generation=? AND stage=?
      ORDER BY last_seen_at DESC LIMIT 1`,
        )
        .get(target.conditionId, target.tokenId, target.outcomeIndex, target.generation, stage) as
        | { outcome: string; lastSeenAt: number }
        | undefined) ?? null
    );
  }

  prune(beforeMs: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM plankton_buy_activity WHERE first_seen_at < ?").run(beforeMs);
      this.db.prepare("DELETE FROM shadow_targets WHERE detected_at < ?").run(beforeMs);
    })();
  }
  close(): void {
    this.db.close();
  }

  private setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO shadow_state(key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(key, value);
  }

  private createTarget(
    rows: readonly ShadowActivityRow[],
    baseline: boolean,
    detectedAt: number,
  ): ShadowTarget {
    const first = rows[0]!;
    if (rows.some((row) => row.outcome !== first.outcome))
      throw new Error("target outcome identity mismatch");
    const args = [first.conditionId, first.asset, first.outcomeIndex] as const;
    const prior = this.db
      .prepare(
        `SELECT outcome, MAX(generation) generation FROM shadow_targets
        WHERE condition_id=? AND token_id=? AND outcome_index=?`,
      )
      .get(...args) as { outcome: string | null; generation: number | null };
    if (prior.outcome != null && prior.outcome !== first.outcome)
      throw new Error("target outcome identity mismatch");
    const generation = Number(prior.generation ?? 0) + 1;
    const times = rows.map((row) => row.timestamp);
    this.db
      .prepare(
        `INSERT INTO shadow_targets
      (condition_id,token_id,outcome,outcome_index,generation,is_baseline,
       first_buy_at,last_buy_at,detected_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        first.conditionId,
        first.asset,
        first.outcome,
        first.outcomeIndex,
        generation,
        baseline ? 1 : 0,
        Math.min(...times),
        Math.max(...times),
        detectedAt,
      );
    const link = this.db.prepare(`UPDATE plankton_buy_activity SET target_generation=?
      WHERE transaction_hash=? AND condition_id=? AND token_id=? AND outcome_index=?`);
    for (const row of rows)
      link.run(generation, row.transactionHash, row.conditionId, row.asset, row.outcomeIndex);
    return {
      tokenId: first.asset,
      conditionId: first.conditionId,
      outcome: first.outcome,
      outcomeIndex: first.outcomeIndex,
      generation,
      baseline,
      detectionLagMs: Math.max(0, detectedAt - Math.max(...times) * 1_000),
    };
  }

  private markStage(input: ShadowObservation): void {
    const column =
      input.stage === "scanner"
        ? "scanner_at"
        : input.stage === "tracking"
          ? "tracked_at"
          : input.stage === "normalized"
            ? "normalized_at"
            : input.stage === "algo"
              ? "algo_at"
              : input.stage === "signal"
                ? "signal_at"
                : null;
    if (!column || input.result === "telemetry_gap") return;
    const outcome = input.stage === "scanner" ? ", scanner_outcome=?" : "";
    this.db
      .prepare(
        `UPDATE shadow_targets SET ${column}=?${outcome}
      WHERE condition_id=? AND token_id=? AND outcome_index=? AND generation=?`,
      )
      .run(
        input.observedAt,
        ...(input.stage === "scanner" ? [input.result] : []),
        input.conditionId,
        input.tokenId,
        input.outcomeIndex,
        input.generation,
      );
    if (
      input.stage === "algo" &&
      input.result === "planner_result" &&
      input.payload["type"] === "signal"
    ) {
      this.db
        .prepare(
          `UPDATE shadow_targets SET planner_signal_at=?
        WHERE condition_id=? AND token_id=? AND outcome_index=? AND generation=?`,
        )
        .run(
          input.observedAt,
          input.conditionId,
          input.tokenId,
          input.outcomeIndex,
          input.generation,
        );
    }
  }
}

function pairKey(conditionId: string, tokenId: string, outcomeIndex: number): string {
  return `${conditionId}\0${tokenId}\0${outcomeIndex}`;
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

type WorkerConfig = {
  dbPath: string;
  wallet: string;
  pollMs: number;
  retentionMs: number;
  timeouts: { scannerMs: number; trackingMs: number; algoMs: number };
};

if (parentPort && workerData) {
  const port = parentPort;
  const config = workerData as WorkerConfig;
  const store = new ShadowStore(config.dbPath);
  const scans = new Map<string, ShadowObservation[]>();
  let polling = false;
  let saturated = false;
  const publishHealth = (source: string): void =>
    port.postMessage({
      type: "health",
      source,
      cursor: store.readCursor(),
      targets: store.readTargets().length,
    });
  const poll = async (): Promise<void> => {
    if (polling || saturated) return;
    polling = true;
    try {
      const baseline = !store.isBaselineDone();
      const rows = await fetchActivityWindow(
        fetchJson,
        store.readCursor(),
        Math.floor(Date.now() / 1000),
        config.wallet,
      );
      const targets = store.commitActivity(rows, baseline, Date.now());
      for (const target of targets) port.postMessage({ type: "target_added", target });
      store.recordTimeouts(Date.now(), config.timeouts);
      store.prune(Date.now() - config.retentionMs);
      publishHealth("ok");
    } catch (error) {
      saturated = error instanceof ActivitySourceSaturatedError;
      publishHealth(saturated ? "source_saturated" : "unavailable");
    } finally {
      polling = false;
    }
  };

  port.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value["type"] === "scan_started") scans.set(String(value["scanId"]), []);
    else if (value["type"] === "scan_evaluation") {
      const scan = scans.get(String(value["scanId"]));
      if (scan) scan.push(value["observation"] as ShadowObservation);
    } else if (value["type"] === "scan_completed") {
      const id = String(value["scanId"]);
      const scan = scans.get(id);
      if (scan) store.recordObservations(scan);
      scans.delete(id);
    } else if (value["type"] === "scan_failed") scans.delete(String(value["scanId"]));
    else if (value["type"] === "observation")
      store.recordObservation(value as unknown as ShadowObservation);
    else if (value["type"] === "shutdown") {
      clearInterval(timer);
      store.close();
      port.postMessage({ type: "stopped" });
    }
  });
  port.postMessage({ type: "ready", targets: store.readTargets() });
  const timer = setInterval(() => void poll(), config.pollMs);
  void poll();
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`activity HTTP ${response.status}`);
  return response.json();
}

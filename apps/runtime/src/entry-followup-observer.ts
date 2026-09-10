import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  ExecutionPolicy,
  GateEntryPolicy,
  Market,
  TokenId,
  TrackedForPricing,
} from "@krabs/domain";
import { isGateWhitelisted } from "@krabs/domain";
import { RuntimeMetricWriter } from "./runtime-metric-writer.js";

const BUCKET_MS = 5 * 60_000;
const HISTORY_SLOTS = 865;
const RECORD_CAP = 50;
const PAYLOAD_CAP = 128 * 1024;
const SCHEMA_VERSION = 1;
const COLLECTION_KEYS = [
  "discoveryActive",
  "discoveryCompleted",
  "gate",
  "transitions",
  "amendments",
] as const;
const COVERAGE_COUNTERS = [
  "droppedDiscovery",
  "droppedTransitions",
  "omittedGateRowsLowerBound",
  "omittedGateConditions",
  "droppedAmendments",
  "gapBuckets",
  "droppedRequestLeases",
  "lateExpired",
  "writeFailures",
] as const;
const IDENTITY_FIELDS: Record<string, readonly string[]> = {
  gate: ["tokenId", "conditionId", "cohortGeneration"],
  transitions: ["tokenId", "epoch", "evalId", "cohortGeneration"],
  amendments: ["tokenId", "epoch", "generation", "requestId"],
  discoveryActive: ["tokenId", "epoch", "conditionId", "generation"],
  discoveryCompleted: ["tokenId", "epoch", "conditionId", "generation"],
};

const CAUSE_BITS = {
  market_update: 1,
  minimum_change: 2,
  full_sweep: 4,
  lifecycle: 8,
  retry: 16,
} as const;
export type EntryFollowupCause = keyof typeof CAUSE_BITS;

type DiscoveryRecord = {
  epoch: string;
  tokenId: string;
  conditionId: string;
  generation: number;
  firstObservedAt: number;
  lastFreshConfirmedAt: number;
  rank: number;
  denominator: number;
  sampleMethod: "evenly_spaced_stable_50";
  request?: { id: number; sequence: number; requestedAt: number };
  response?: { result: "returned" | "missing" | "request_failed"; observedAt: number };
  firstAlgo?: { evalId: number; observedAt: number; preplanner: string; plannerOccurred: boolean };
  downstreamFailureAt?: number;
  endedAt?: number;
  censorReason?: string;
};

export type EntryFollowupEvaluation = {
  epoch: string;
  evalId: number;
  tokenId: string;
  cohortGeneration: number | null;
  visitedAt: number;
  outcomeAt?: number;
  causeMask: number;
  preplanner: string;
  plannerOutcome: string | null;
  plannerReason: string | null;
  candidateNotionalUsdc: number | null;
  candidateAt: number | null;
  preflight: "not_called" | "true" | "false" | "unknown" | "unavailable" | "threw";
  rawReason: string | null;
  effectiveSuppression: string | null;
  effectiveReason: string | null;
  cooldownUntilMs: number;
  cooldownElapsed: boolean;
  repeats: number;
};

export type EntryFollowupGateState = {
  tokenId: string;
  selected: boolean;
  bypass: boolean;
  marketCache: "present" | "missing";
  marketFreshAt: number | null;
  leg: "present" | "absent" | "unknown";
  position: "present" | "absent" | "unknown";
  minimum: { remembered: number | null; observedAt: number | null; result: number | null };
  cooldownUntilMs: number;
  cooldownElapsed: boolean;
};

type Amendment = Pick<DiscoveryRecord, "epoch" | "generation" | "tokenId"> & {
  requestId: number;
  eventTime: number;
  result: string;
  firstAlgo?: DiscoveryRecord["firstAlgo"];
};

type Coverage = Record<(typeof COVERAGE_COUNTERS)[number], number> & {
  incomplete: boolean;
  recoveryGap: string | null;
};

type Bucket = {
  schemaVersion: number;
  epoch: string;
  bucketNumber: number;
  bucketStart: number;
  bucketEnd: number;
  capturedAt: number;
  discoveryActive: DiscoveryRecord[];
  gate: Array<Record<string, unknown>>;
  priorSnapshot?: Pick<Bucket, "epoch" | "capturedAt" | "discoveryActive" | "gate">;
  discoveryCompleted: DiscoveryRecord[];
  transitions: EntryFollowupEvaluation[];
  amendments: Amendment[];
  coverage: Coverage;
};

type PassCause = { mask: number; cohortGeneration: number | null };
type Pass = { causes: Map<string, PassCause>; visited: Set<string> };
type RequestLease = Pick<DiscoveryRecord, "epoch" | "generation" | "tokenId"> & {
  requestedAt: number;
  retained: boolean;
  responseCompleted?: boolean;
  firstAlgo?: DiscoveryRecord["firstAlgo"];
};

export interface EntryFollowupObserverDeps {
  dbPath: string;
  policy: () => ExecutionPolicy | GateEntryPolicy | null;
  now?: () => number;
}

export class EntryFollowupObserver {
  private readonly epoch = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  private readonly now: () => number;
  private db: Database.Database | null = null;
  private writer: RuntimeMetricWriter | null = null;
  private stopped = false;
  private bucket: Bucket;
  private pending: Bucket | null = null;
  private active = new Map<string, DiscoveryRecord>();
  private gateGenerations = new Map<string, number>();
  private gateMembers = new Set<string>();
  private latestEvaluations = new Map<string, EntryFollowupEvaluation>();
  private lastTransitions = new Map<string, EntryFollowupEvaluation>();
  private pendingCauses = new Map<string, number>();
  private passes = new Map<number, Pass>();
  private requestLeases = new Map<number, RequestLease[]>();
  private requestLeaseCount = 0;
  private nextDiscoveryGeneration = 0;
  private nextGateGeneration = 0;
  private nextRequestId = 0;
  private nextEvalId = 0;
  private nextPassId = 0;
  private durableBucketNumber: number | null = null;
  private gateStateReader: ((ids: readonly TokenId[]) => EntryFollowupGateState[]) | null = null;
  private policyKey: string | null = null;

  constructor(private readonly deps: EntryFollowupObserverDeps) {
    this.now = deps.now ?? Date.now;
    this.bucket = this.newBucket(this.now());
    this.openAndRecover();
    if (this.db) this.refreshGate();
  }

  setGateStateReader(reader: (ids: readonly TokenId[]) => EntryFollowupGateState[]): void {
    this.gateStateReader = reader;
  }

  observeDiscoveryTier(tier: TrackedForPricing, freshAt: number): void {
    if (this.stopped) return;
    this.rollBucket(freshAt);
    const capacity = Math.min(tier.discoveryOnly.length, tier.discoveryCapacityCount ?? 0);
    const live = [...tier.executionCritical, ...tier.planktonSignature, ...tier.entryCandidates];
    for (const record of [...this.active.values()]) {
      const index = tier.discoveryOnly.findIndex(
        (market) => String(market.tokenId) === record.tokenId,
      );
      if (index >= 0 && index < capacity) {
        record.lastFreshConfirmedAt = freshAt;
        record.rank = index + 1;
        record.denominator = capacity;
        continue;
      }
      const destination =
        index >= capacity
          ? "v4_reject"
          : live.some((market) => String(market.tokenId) === record.tokenId)
            ? "ws_promotion"
            : "left_tier";
      this.endDiscovery(record, freshAt, destination);
    }
    for (const index of this.sampleIndexes(capacity)) {
      if (this.active.size >= RECORD_CAP) break;
      const market = tier.discoveryOnly[index]!;
      const tokenId = String(market.tokenId);
      if (this.active.has(tokenId)) continue;
      const generation = ++this.nextDiscoveryGeneration;
      this.active.set(tokenId, {
        epoch: this.epoch,
        tokenId,
        conditionId: String(market.conditionId),
        generation,
        firstObservedAt: freshAt,
        lastFreshConfirmedAt: freshAt,
        rank: index + 1,
        denominator: capacity,
        sampleMethod: "evenly_spaced_stable_50",
      });
    }
  }

  beginDiscoveryRequest(markets: readonly Market[], requestedAt: number): number {
    if (this.stopped) return 0;
    this.rollBucket(requestedAt);
    const requestId = ++this.nextRequestId;
    const leases: RequestLease[] = [];
    for (const market of markets) {
      const record = this.active.get(String(market.tokenId));
      if (!record || record.request) continue;
      if (this.requestLeaseCount >= RECORD_CAP) {
        // Retain recent identities for late visits without accumulating completed requests.
        const [oldId, oldLeases] = this.requestLeases.entries().next().value!;
        oldLeases.shift();
        this.requestLeaseCount--;
        if (!oldLeases.length) this.requestLeases.delete(oldId);
        this.countCoverage("droppedRequestLeases");
      }
      record.request = { id: requestId, sequence: requestId, requestedAt };
      leases.push({
        tokenId: record.tokenId,
        epoch: record.epoch,
        generation: record.generation,
        requestedAt,
        retained: true,
      });
      this.requestLeaseCount++;
    }
    if (leases.length) this.requestLeases.set(requestId, leases);
    this.pruneObservedState();
    return requestId;
  }

  completeDiscoveryRequest(
    requestId: number,
    results: ReadonlyMap<string, "returned" | "missing"> | "request_failed",
    observedAt: number,
  ): void {
    if (this.stopped || requestId === 0) return;
    this.rollBucket(observedAt);
    for (const lease of this.requestLeases.get(requestId) ?? []) {
      if (lease.responseCompleted) continue;
      lease.responseCompleted = true;
      const result =
        results === "request_failed" ? results : (results.get(lease.tokenId) ?? "missing");
      const record = this.findMutableDiscovery(lease);
      if (record) record.response = { result, observedAt };
      else if (lease.retained && this.isWithinHistory(lease.requestedAt, observedAt)) {
        this.addAmendment({
          epoch: lease.epoch,
          generation: lease.generation,
          requestId,
          tokenId: lease.tokenId,
          eventTime: observedAt,
          result,
        });
      } else {
        this.countCoverage("lateExpired");
      }
    }
  }

  observeDiscoveryDownstreamFailure(requestId: number, observedAt: number): void {
    if (this.stopped) return;
    this.rollBucket(observedAt);
    for (const lease of this.requestLeases.get(requestId) ?? []) {
      const record = this.findMutableDiscovery(lease);
      if (record?.response) record.downstreamFailureAt = observedAt;
      else if (lease.retained && this.isWithinHistory(lease.requestedAt, observedAt)) {
        this.addAmendment({
          epoch: lease.epoch,
          generation: lease.generation,
          tokenId: lease.tokenId,
          requestId,
          eventTime: observedAt,
          result: "downstream_failed",
        });
      } else this.countCoverage("lateExpired");
    }
  }

  markCause(tokenId: TokenId | string, cause: EntryFollowupCause): void {
    if (this.stopped) return;
    this.rollBucket(this.now());
    this.refreshGate(false);
    const key = String(tokenId);
    if (!this.isObservedToken(key)) return;
    this.pendingCauses.set(key, (this.pendingCauses.get(key) ?? 0) | CAUSE_BITS[cause]);
  }

  capturePass(tokenIds: readonly TokenId[]): number {
    if (this.stopped) return 0;
    this.refreshGate(false);
    const causes = new Map<string, PassCause>();
    for (const tokenId of tokenIds) {
      const key = String(tokenId);
      const cause = this.pendingCauses.get(key);
      if (cause !== undefined) {
        causes.set(key, {
          mask: cause,
          cohortGeneration: this.gateMembers.has(key) ? (this.gateGenerations.get(key) ?? 1) : null,
        });
      }
      this.pendingCauses.delete(key);
    }
    if (causes.size === 0) return 0;
    if (this.passes.size >= 2) {
      this.noteGap("captured_pass_overflow", causes.size);
      return 0;
    }
    const id = ++this.nextPassId;
    this.passes.set(id, { causes, visited: new Set() });
    return id;
  }

  observeVisit(passId: number, tokenId: TokenId, visitedAt: number): void {
    if (this.stopped) return;
    this.rollBucket(visitedAt);
    this.refreshGate(false);
    const key = String(tokenId);
    const pass = this.passes.get(passId);
    const captured = pass?.causes.get(key);
    if (!captured && !this.isObservedToken(key)) return;
    pass?.visited.add(key);
    const evaluation: EntryFollowupEvaluation = {
      epoch: this.epoch,
      evalId: ++this.nextEvalId,
      tokenId: key,
      cohortGeneration: captured
        ? captured.cohortGeneration
        : this.gateMembers.has(key)
          ? (this.gateGenerations.get(key) ?? 1)
          : null,
      visitedAt,
      causeMask: captured?.mask ?? 0,
      preplanner: "started",
      plannerOutcome: null,
      plannerReason: null,
      candidateNotionalUsdc: null,
      candidateAt: null,
      preflight: "not_called",
      rawReason: null,
      effectiveSuppression: null,
      effectiveReason: null,
      cooldownUntilMs: 0,
      cooldownElapsed: false,
      repeats: 1,
    };
    this.latestEvaluations.set(key, evaluation);
    this.attachFirstAlgo(key, evaluation);
  }

  finishPass(passId: number, reason: string): void {
    const pass = this.passes.get(passId);
    if (!pass) return;
    const unvisited = [...pass.causes.keys()].filter((tokenId) => !pass.visited.has(tokenId));
    if (unvisited.length) this.noteGap(`captured_not_visited:${reason}`, unvisited.length);
    this.passes.delete(passId);
    this.pruneObservedState();
  }

  observeEvaluation(tokenId: TokenId, outcome: string, payload: Record<string, unknown>): void {
    if (this.stopped || outcome.includes("paused") || outcome === "overlap") return;
    this.rollBucket(this.now());
    const current = this.latestEvaluations.get(String(tokenId));
    if (!current) return;
    const next = structuredClone(current);
    next.outcomeAt = this.now();
    if (outcome === "planner_result") {
      next.preplanner = "passed";
      next.plannerOutcome = this.boundedCode(payload.type);
      const reasons = Array.isArray(payload.reasons) ? payload.reasons.map(String) : [];
      next.plannerReason = this.boundedCode(reasons[0]);
      if (payload.side === "buy" && typeof payload.candidateNotionalUsdc === "number") {
        next.candidateNotionalUsdc = payload.candidateNotionalUsdc;
        next.candidateAt = this.now();
      }
    } else if (outcome === "postplanner_guard") {
      next.effectiveSuppression = this.boundedCode(payload.guardReason) ?? "unknown";
      next.effectiveReason = this.boundedCode(payload.budgetReason);
      if (typeof payload.cooldownUntilMs === "number") {
        next.cooldownUntilMs = payload.cooldownUntilMs;
        next.cooldownElapsed = payload.cooldownUntilMs > 0 && this.now() >= payload.cooldownUntilMs;
      }
    } else {
      next.preplanner = this.boundedCode(outcome) ?? "unknown";
    }
    this.updateEvaluation(next);
    const terminal =
      outcome === "postplanner_guard"
        ? next.candidateNotionalUsdc !== null
        : outcome !== "planner_result" || next.plannerOutcome !== "signal";
    if (terminal) this.recordTransition(next);
  }

  observePreflight(
    tokenId: TokenId,
    outcome: EntryFollowupEvaluation["preflight"],
    reason: string | null,
    cooldownUntilMs: number,
    observedAt: number,
  ): void {
    if (this.stopped) return;
    this.rollBucket(observedAt);
    const current = this.latestEvaluations.get(String(tokenId));
    if (!current) return;
    this.updateEvaluation({
      ...structuredClone(current),
      preflight: outcome,
      rawReason: this.boundedCode(reason),
      cooldownUntilMs,
      cooldownElapsed: cooldownUntilMs > 0 && observedAt >= cooldownUntilMs,
    });
  }

  flush(observedAt = this.now()): void {
    if (this.stopped) return;
    this.flushInternal(observedAt);
  }

  private flushInternal(observedAt: number): void {
    if (!this.writer || !this.db) return;
    try {
      this.rollBucket(observedAt);
      const pendingBucket = this.pending;
      const current = this.payload(
        observedAt,
        pendingBucket?.bucketNumber ?? this.durableBucketNumber,
      );
      const pending = pendingBucket ? this.fitPayload(pendingBucket) : null;
      this.db.transaction(() => {
        if (pending)
          this.writer!.replaceLatest(
            this.historyName(pendingBucket!.bucketNumber),
            1,
            pending.json,
            pending.at,
          );
        this.writer!.replaceLatest("entry_followup_current", 1, current.json, current.at);
      })();
      if (this.pending) {
        this.durableBucketNumber = this.pending.bucketNumber;
        this.pending = null;
      }
    } catch {
      this.countCoverage("writeFailures");
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.flushInternal(this.now());
    try {
      this.db?.close();
    } catch {
      // Diagnostics must not prevent runtime teardown.
    }
    this.db = null;
    this.writer = null;
  }

  snapshot(): Record<string, unknown> {
    const at = this.now();
    this.rollBucket(at);
    return JSON.parse(this.payload(at).json) as Record<string, unknown>;
  }

  private openAndRecover(): void {
    try {
      this.db = new Database(this.deps.dbPath, { timeout: 0, fileMustExist: true });
      this.db.pragma("busy_timeout = 0");
      this.db.pragma("wal_autocheckpoint = 0");
      this.db.pragma("synchronous = NORMAL");
      this.writer = new RuntimeMetricWriter(this.db);
      try {
        this.recover();
      } catch {
        this.bucket.coverage.recoveryGap = "invalid_current";
        this.bucket.coverage.incomplete = true;
      }
    } catch {
      try {
        this.db?.close();
      } catch {
        // A failed diagnostic connection must not block startup.
      }
      this.db = null;
      this.writer = null;
      this.bucket.coverage.recoveryGap = "open_or_recovery_failed";
      this.bucket.coverage.incomplete = true;
    }
  }

  private recover(): void {
    const read = this.db!.prepare(
      "SELECT labels FROM runtime_metrics WHERE metric_name = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
    );
    const row = read.get("entry_followup_current") as { labels: string | null } | undefined;
    if (!row?.labels) {
      this.validateRecoverySlots(read, this.bucket.bucketNumber);
      this.noteGap("missing_current", 1);
      return;
    }
    const prior = this.parseCurrent(row.labels);
    this.validateRecoverySlots(read, prior.bucketNumber as number);
    const recovered = this.recoveredBucket(prior);
    if (recovered.bucketNumber === this.bucket.bucketNumber) this.mergeRecovered(recovered);
    else this.pending = recovered;
    const skipped = this.bucket.bucketNumber - recovered.bucketNumber - 1;
    if (skipped > 0) {
      this.bucket.coverage.gapBuckets += skipped;
      this.bucket.coverage.incomplete = true;
    }
    this.durableBucketNumber =
      typeof prior.durableBucketNumber === "number" ? prior.durableBucketNumber : null;
    this.noteGap("restart_boundary", 1);
  }

  private parseCurrent(labels: string): Record<string, unknown> {
    const value = this.parseStored(labels);
    const bucketNumber = value.bucketNumber as number;
    const age = this.bucket.bucketNumber - bucketNumber;
    if (age < 0 || age > HISTORY_SLOTS - 1) throw new Error("recovery payload age");
    return value;
  }

  private validateRecoverySlots(read: Database.Statement<[string]>, bucketNumber: number): void {
    for (const expected of [bucketNumber, bucketNumber - 1]) {
      const row = read.get(this.historyName(expected)) as { labels: string | null } | undefined;
      if (!row?.labels) continue;
      try {
        this.parseStored(row.labels, expected);
      } catch {
        this.noteGap("recovery_slot_identity", 1);
      }
    }
  }

  private parseStored(labels: string, expected?: number): Record<string, unknown> {
    if (Buffer.byteLength(labels) > PAYLOAD_CAP) throw new Error("recovery payload size");
    const value = JSON.parse(labels) as Record<string, unknown>;
    const number = value.bucketNumber;
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      typeof value.epoch !== "string" ||
      typeof number !== "number" ||
      (expected !== undefined && number !== expected) ||
      value.bucketStart !== number * BUCKET_MS ||
      value.bucketEnd !== (number + 1) * BUCKET_MS
    ) {
      throw new Error("recovery envelope");
    }
    for (const key of COLLECTION_KEYS) {
      const rows = value[key];
      if (rows !== undefined && (!Array.isArray(rows) || rows.length > RECORD_CAP)) {
        throw new Error(`recovery collection ${key}`);
      }
    }
    const prior = value.priorSnapshot as Record<string, unknown> | undefined;
    if (prior) {
      if (
        typeof prior.epoch !== "string" ||
        typeof prior.capturedAt !== "number" ||
        prior.capturedAt > this.now() ||
        !this.isWithinHistory(prior.capturedAt, this.now())
      )
        throw new Error("recovery checkpoint identity");
      for (const key of ["discoveryActive", "gate"]) {
        if (!Array.isArray(prior[key]) || prior[key].length > RECORD_CAP)
          throw new Error("recovery checkpoint cap");
      }
    }
    return value;
  }

  private recoveredBucket(value: Record<string, unknown>): Bucket {
    const bucket = this.newBucket(value.bucketStart as number);
    bucket.epoch = value.epoch as string;
    bucket.capturedAt = value.capturedAt as number;
    bucket.discoveryActive = (value.discoveryActive ?? []) as DiscoveryRecord[];
    bucket.gate = (value.gate ?? []) as Bucket["gate"];
    if (value.priorSnapshot)
      bucket.priorSnapshot = value.priorSnapshot as NonNullable<Bucket["priorSnapshot"]>;
    this.mergeCoverage(bucket.coverage, value.coverage as Partial<Coverage> | undefined);
    for (const row of (value.discoveryCompleted ?? []) as DiscoveryRecord[]) {
      this.addCompletedTo(bucket, row);
    }
    for (const row of (value.discoveryActive ?? []) as DiscoveryRecord[]) {
      this.addCompletedTo(bucket, {
        ...structuredClone(row),
        endedAt: row.lastFreshConfirmedAt,
        censorReason: "restart",
      });
    }
    bucket.transitions = (value.transitions ?? []) as EntryFollowupEvaluation[];
    bucket.amendments = (value.amendments ?? []) as Amendment[];
    return bucket;
  }

  private mergeRecovered(recovered: Bucket): void {
    this.bucket.priorSnapshot = recovered.priorSnapshot ?? {
      epoch: recovered.epoch,
      capturedAt: recovered.capturedAt,
      discoveryActive: recovered.discoveryActive,
      gate: recovered.gate,
    };
    for (const row of recovered.discoveryCompleted) this.addCompletedTo(this.bucket, row);
    for (const row of recovered.transitions) {
      if (this.bucket.transitions.length < RECORD_CAP) this.bucket.transitions.push(row);
      else this.countCoverage("droppedTransitions");
    }
    for (const row of recovered.amendments) this.addAmendment(row);
    this.mergeCoverage(this.bucket.coverage, recovered.coverage);
  }

  private refreshGate(force = true): void {
    try {
      const policy = this.deps.policy();
      const gate = policy && "gateEntry" in policy ? policy.gateEntry : policy;
      // Observe loaded policy only; never refresh the provider or infer unseen churn.
      const key = createHash("sha256").update(JSON.stringify(gate)).digest("hex");
      if (!force && key === this.policyKey) return;
      this.bucket.gate = this.gateRows(gate);
      this.policyKey = key;
    } catch {
      this.noteGap("gate_census_read_failed", 1);
    }
  }

  private gateRows(gate: GateEntryPolicy | null) {
    const conditionIds = gate?.whitelistConditionIds ?? [];
    const selectedConditions = conditionIds.slice(0, RECORD_CAP);
    this.bucket.coverage.omittedGateConditions = conditionIds.length - selectedConditions.length;
    this.bucket.coverage.omittedGateRowsLowerBound = 0;
    if (!this.db || !gate || selectedConditions.length === 0) {
      this.gateMembers.clear();
      this.gateGenerations.clear();
      this.pruneObservedState();
      return [];
    }
    const placeholders = selectedConditions.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT m.token_id tokenId, m.condition_id conditionId, m.outcome, m.outcome_index outcomeIndex,
              m.active, m.tradable, EXISTS(SELECT 1 FROM leg_states l WHERE l.token_id=m.token_id) ledgerLeg,
              EXISTS(SELECT 1 FROM positions p WHERE p.token_id=m.token_id AND p.status IN ('open','dust')) ledgerOpenPosition
         FROM markets m WHERE m.condition_id IN (${placeholders})
         ORDER BY m.condition_id, m.outcome_index, m.token_id LIMIT ${RECORD_CAP + 1}`,
      )
      .all(...selectedConditions) as Array<Record<string, unknown>>;
    const kept = rows.slice(0, RECORD_CAP);
    const ids = kept.map((row) => String(row.tokenId) as TokenId);
    let gateStates: EntryFollowupGateState[] = [];
    try {
      gateStates = this.gateStateReader?.(ids) ?? [];
    } catch {
      this.noteGap("gate_state_read_failed", ids.length);
    }
    const states = new Map(gateStates.map((state) => [state.tokenId, state]));
    const currentIds = new Set(ids.map(String));
    const generations = new Map<string, number>();
    for (const id of currentIds) {
      generations.set(
        id,
        this.gateMembers.has(id)
          ? (this.gateGenerations.get(id) ?? ++this.nextGateGeneration)
          : ++this.nextGateGeneration,
      );
    }
    this.gateMembers = currentIds;
    this.gateGenerations = generations;
    this.pruneObservedState();
    this.bucket.coverage.omittedGateRowsLowerBound = Math.max(0, rows.length - RECORD_CAP);
    if (
      this.bucket.coverage.omittedGateConditions ||
      this.bucket.coverage.omittedGateRowsLowerBound
    )
      this.bucket.coverage.incomplete = true;
    return kept.map((row) => {
      const tokenId = String(row.tokenId);
      const state = states.get(tokenId);
      const priorEvaluation = this.latestEvaluations.get(tokenId);
      const lastEvaluation =
        priorEvaluation?.cohortGeneration === this.gateGenerations.get(tokenId)
          ? priorEvaluation
          : undefined;
      return {
        observedAt: this.now(),
        tokenId,
        conditionId: String(row.conditionId),
        outcome: String(row.outcome),
        outcomeIndex: typeof row.outcomeIndex === "number" ? row.outcomeIndex : null,
        active: row.active === 1,
        tradable: row.tradable === 1,
        authorized: isGateWhitelisted(gate, String(row.conditionId)),
        ledgerLeg: row.ledgerLeg === 1,
        ledgerOpenPosition: row.ledgerOpenPosition === 1,
        cohortGeneration: this.gateGenerations.get(tokenId) ?? 1,
        ...(state ? { state } : {}),
        ...(lastEvaluation ? { lastEvaluation } : {}),
      };
    });
  }

  private payload(
    observedAt: number,
    durableBucketNumber = this.durableBucketNumber,
  ): { json: string; at: string } {
    this.refreshGate();
    this.bucket.capturedAt = observedAt;
    const body = {
      schemaVersion: this.bucket.schemaVersion,
      epoch: this.bucket.epoch,
      capturedAt: observedAt,
      bucketNumber: this.bucket.bucketNumber,
      bucketStart: this.bucket.bucketStart,
      bucketEnd: this.bucket.bucketEnd,
      durableBucketNumber,
      ...(this.bucket.priorSnapshot ? { priorSnapshot: this.bucket.priorSnapshot } : {}),
      discoveryActive: [...this.active.values()],
      discoveryCompleted: this.bucket.discoveryCompleted,
      gate: this.bucket.gate,
      transitions: this.bucket.transitions,
      amendments: this.bucket.amendments,
      coverage: { ...this.bucket.coverage },
    };
    return this.fitPayload(body);
  }

  private fitPayload(body: Record<string, unknown> | Bucket): { json: string; at: string } {
    const value = structuredClone(body) as Record<string, unknown>;
    const coverage = (value.coverage ??= {}) as Record<string, unknown>;
    const prior = value.priorSnapshot as Record<string, unknown> | undefined;
    if (prior) {
      // A restart checkpoint shares the same byte budget as its enclosing bucket.
      for (const key of ["gate", "discoveryActive"]) {
        if (this.payloadBytes(value) <= PAYLOAD_CAP) break;
        prior[key] = (prior[key] as unknown[]).map((row) => this.identityOnly(key, row));
        coverage.incomplete = true;
        coverage.priorSnapshotPayloadElided = true;
      }
    }
    for (const key of COLLECTION_KEYS) {
      const rows = value[key];
      if (!Array.isArray(rows)) continue;
      for (
        let index = rows.length - 1;
        index >= 0 && this.payloadBytes(value) > PAYLOAD_CAP;
        index--
      ) {
        const compact = this.identityOnly(key, rows[index]);
        if (this.payloadBytes(compact) >= this.payloadBytes(rows[index])) continue;
        rows[index] = compact;
        coverage.incomplete = true;
        coverage[`${key}PayloadElided`] = Number(coverage[`${key}PayloadElided`] ?? 0) + 1;
      }
    }
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > PAYLOAD_CAP)
      throw new Error("entry followup payload exceeds cap");
    const atMs =
      typeof value.bucketEnd === "number" ? Math.min(this.now(), value.bucketEnd) : this.now();
    return { json, at: new Date(atMs).toISOString() };
  }

  private rollBucket(at: number): void {
    const target = Math.floor(at / BUCKET_MS);
    if (target <= this.bucket.bucketNumber) {
      this.bucket.capturedAt = Math.max(this.bucket.capturedAt, at);
      return;
    }
    const priorNumber = this.bucket.bucketNumber;
    const next = this.newBucket(at);
    if (this.pending) {
      this.expireDiscardedDiscovery(this.bucket);
      this.mergeCoverage(next.coverage, this.bucket.coverage);
    } else {
      this.bucket.discoveryActive = structuredClone([...this.active.values()]);
      this.pending = structuredClone(this.bucket);
    }
    const skipped = target - priorNumber - 1 + (this.pending?.bucketNumber !== priorNumber ? 1 : 0);
    next.coverage.gapBuckets += skipped;
    next.coverage.incomplete ||= skipped > 0;
    next.gate = structuredClone(this.bucket.gate);
    this.bucket = next;
    this.lastTransitions.clear();
  }

  private newBucket(at: number): Bucket {
    const bucketNumber = Math.floor(at / BUCKET_MS);
    return {
      schemaVersion: SCHEMA_VERSION,
      epoch: this.epoch,
      bucketNumber,
      bucketStart: bucketNumber * BUCKET_MS,
      bucketEnd: (bucketNumber + 1) * BUCKET_MS,
      capturedAt: at,
      discoveryActive: [],
      gate: [],
      discoveryCompleted: [],
      transitions: [],
      amendments: [],
      coverage: {
        incomplete: false,
        droppedDiscovery: 0,
        droppedTransitions: 0,
        omittedGateRowsLowerBound: 0,
        omittedGateConditions: 0,
        droppedAmendments: 0,
        gapBuckets: 0,
        droppedRequestLeases: 0,
        lateExpired: 0,
        writeFailures: 0,
        recoveryGap: null,
      },
    };
  }

  private sampleIndexes(length: number): number[] {
    const wanted = Math.min(RECORD_CAP, length);
    if (wanted === 0) return [];
    if (wanted === 1) return [0];
    return Array.from({ length: wanted }, (_, index) =>
      Math.round((index * (length - 1)) / (wanted - 1)),
    );
  }

  private endDiscovery(record: DiscoveryRecord, endedAt: number, reason: string): void {
    this.active.delete(record.tokenId);
    const retained = this.addCompletedTo(this.bucket, {
      ...structuredClone(record),
      endedAt,
      censorReason: reason,
    });
    if (!retained) this.markLeasesExpired(record);
    this.pruneObservedState();
  }

  private addCompletedTo(bucket: Bucket, record: DiscoveryRecord): boolean {
    if (bucket.discoveryCompleted.length < RECORD_CAP) {
      bucket.discoveryCompleted.push(record);
      return true;
    }
    bucket.coverage.droppedDiscovery++;
    bucket.coverage.incomplete = true;
    return false;
  }

  private findMutableDiscovery(lease: RequestLease): DiscoveryRecord | null {
    const active = this.active.get(lease.tokenId);
    if (active?.epoch === lease.epoch && active.generation === lease.generation) return active;
    return (
      this.bucket.discoveryCompleted.find(
        (row) =>
          row.epoch === lease.epoch &&
          row.generation === lease.generation &&
          row.tokenId === lease.tokenId,
      ) ?? null
    );
  }

  private addAmendment(amendment: Amendment): void {
    const prior =
      amendment.firstAlgo &&
      this.bucket.amendments.find(
        (row) =>
          row.epoch === amendment.epoch &&
          row.generation === amendment.generation &&
          row.firstAlgo?.evalId === amendment.firstAlgo!.evalId,
      );
    if (prior) {
      Object.assign(prior, amendment);
      return;
    }
    if (this.bucket.amendments.length < RECORD_CAP) this.bucket.amendments.push({ ...amendment });
    else {
      this.countCoverage("droppedAmendments");
    }
  }

  private attachFirstAlgo(tokenId: string, evaluation: EntryFollowupEvaluation): void {
    for (const [requestId, leases] of this.requestLeases) {
      for (const lease of leases) {
        if (
          lease.tokenId !== tokenId ||
          !lease.retained ||
          !this.isWithinHistory(lease.requestedAt, this.now()) ||
          evaluation.visitedAt < lease.requestedAt ||
          (lease.firstAlgo && lease.firstAlgo.evalId !== evaluation.evalId)
        )
          continue;
        lease.firstAlgo = {
          evalId: evaluation.evalId,
          observedAt: evaluation.visitedAt,
          preplanner: evaluation.preplanner,
          plannerOccurred: evaluation.plannerOutcome !== null,
        };
        const record = this.findMutableDiscovery(lease);
        if (record) record.firstAlgo = { ...lease.firstAlgo };
        else
          this.addAmendment({
            epoch: lease.epoch,
            generation: lease.generation,
            tokenId,
            requestId,
            eventTime: this.now(),
            result: "first_algo",
            firstAlgo: { ...lease.firstAlgo },
          });
      }
    }
  }

  private updateEvaluation(next: EntryFollowupEvaluation): void {
    this.latestEvaluations.set(next.tokenId, next);
    this.attachFirstAlgo(next.tokenId, next);
  }

  private recordTransition(evaluation: EntryFollowupEvaluation): void {
    const previous = this.lastTransitions.get(evaluation.tokenId);
    if (previous && this.signature(previous) === this.signature(evaluation)) {
      previous.repeats++;
      evaluation.repeats = previous.repeats;
      return;
    }
    if (this.bucket.transitions.length < RECORD_CAP) {
      const copy = structuredClone(evaluation);
      this.bucket.transitions.push(copy);
      this.lastTransitions.set(evaluation.tokenId, copy);
    } else {
      this.countCoverage("droppedTransitions");
    }
  }

  private signature(row: EntryFollowupEvaluation): string {
    return JSON.stringify([
      row.epoch,
      row.cohortGeneration,
      row.preplanner,
      row.plannerOutcome,
      row.plannerReason,
      row.candidateNotionalUsdc,
      row.preflight,
      row.rawReason,
      row.effectiveSuppression,
      row.effectiveReason,
      row.cooldownElapsed,
    ]);
  }

  private historyName(bucketNumber: number): string {
    return `entry_followup_history_${((bucketNumber % HISTORY_SLOTS) + HISTORY_SLOTS) % HISTORY_SLOTS}`;
  }

  private noteGap(reason: string, count: number): void {
    this.bucket.coverage.incomplete = true;
    const suffix = `${reason}:${count}`;
    const prior = this.bucket.coverage.recoveryGap;
    this.bucket.coverage.recoveryGap = (prior ? `${prior},${suffix}` : suffix).slice(-512);
  }

  private countCoverage(key: (typeof COVERAGE_COUNTERS)[number], count = 1): void {
    this.bucket.coverage[key] += count;
    this.bucket.coverage.incomplete = true;
  }

  private isObservedToken(tokenId: string): boolean {
    return (
      this.gateMembers.has(tokenId) ||
      this.active.has(tokenId) ||
      [...this.requestLeases.values()].some((leases) =>
        leases.some(
          (lease) =>
            lease.tokenId === tokenId &&
            lease.retained &&
            this.isWithinHistory(lease.requestedAt, this.now()),
        ),
      )
    );
  }

  private boundedCode(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const code = String(value);
    return code.length <= 256 ? code : `${code.slice(0, 255)}…`;
  }

  private isWithinHistory(startedAt: number, observedAt: number): boolean {
    return observedAt - startedAt <= (HISTORY_SLOTS - 1) * BUCKET_MS;
  }

  private markLeasesExpired(record: DiscoveryRecord): void {
    for (const leases of this.requestLeases.values()) {
      for (const lease of leases) {
        if (
          lease.epoch === record.epoch &&
          lease.generation === record.generation &&
          lease.tokenId === record.tokenId
        ) {
          lease.retained = false;
        }
      }
    }
  }

  private expireDiscardedDiscovery(bucket: Bucket): void {
    for (const record of bucket.discoveryCompleted) this.markLeasesExpired(record);
  }

  private pruneObservedState(): void {
    for (const map of [this.pendingCauses, this.latestEvaluations]) {
      for (const key of map.keys()) {
        if (this.isObservedToken(key)) continue;
        if (
          map === this.latestEvaluations &&
          [...this.passes.values()].some((pass) => pass.visited.has(key))
        )
          continue;
        map.delete(key);
      }
    }
  }

  private mergeCoverage(target: Coverage, source?: Partial<Coverage>): void {
    if (!source) return;
    target.incomplete ||= source.incomplete === true;
    for (const key of COVERAGE_COUNTERS) {
      if (typeof source[key] === "number" && Number.isFinite(source[key]))
        target[key] += source[key];
    }
    if (typeof source.recoveryGap === "string" && source.recoveryGap) {
      target.recoveryGap = target.recoveryGap
        ? `${target.recoveryGap},${source.recoveryGap}`.slice(-512)
        : source.recoveryGap.slice(-512);
    }
  }

  private payloadBytes(value: unknown): number {
    return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
  }

  private identityOnly(key: string, value: unknown): Record<string, unknown> {
    const row = value as Record<string, unknown>;
    return {
      omitted: true,
      ...Object.fromEntries((IDENTITY_FIELDS[key] ?? []).map((field) => [field, row[field]])),
    };
  }
}

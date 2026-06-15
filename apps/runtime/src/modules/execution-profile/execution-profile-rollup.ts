import type {
  ExecutionProfileDecision,
  ExecutionProfileName,
  ScaleInMode,
  ScaleInReason,
} from "@krabs/domain";

import {
  EXECUTION_PROFILE_METRICS,
  EXECUTION_PROFILE_RISK_EVENTS,
  serializeExecutionProfileLabels,
  validateExecutionProfileLabels,
  writeExecutionProfileGaugeEvent,
  type ExecutionProfileEventMetricWriter,
} from "./execution-profile-metrics.js";

export interface ExecutionProfileRollupFacts {
  kind: "scale_in" | "cost_cap";
  profile: ExecutionProfileName;
  outcome: ExecutionProfileDecision;
  mode: ScaleInMode | "none";
  reason: ScaleInReason;
  sample: Readonly<Record<string, unknown>>;
}

export interface ExecutionProfileRollupDeps {
  windowMs: number;
  maxBuckets: number;
  now?: () => number;
  emit: (event: { eventType: string; payload: Record<string, unknown> }) => void;
  writeCounter: (name: string, value?: number, labels?: string) => void;
  writeEvent: ExecutionProfileEventMetricWriter["writeEvent"];
}

interface RollupBucket {
  facts: ExecutionProfileRollupFacts;
  count: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  firstPayloadSample: Readonly<Record<string, unknown>>;
  lastPayloadSample: Readonly<Record<string, unknown>>;
}

export class ExecutionProfileRollup {
  private readonly buckets = new Map<string, RollupBucket>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ExecutionProfileRollupDeps) {}

  record(facts: ExecutionProfileRollupFacts): boolean {
    validateExecutionProfileLabels(EXECUTION_PROFILE_METRICS.chainDecision, rollupLabels(facts));
    if (this.buckets.size >= this.deps.maxBuckets && !this.buckets.has(bucketKey(facts))) {
      this.flushAll("overflow");
      this.deps.writeCounter(
        EXECUTION_PROFILE_METRICS.rollupOverflow,
        1,
        serializeExecutionProfileLabels({ kind: facts.kind, profile: facts.profile }),
      );
    }

    const now = this.now();
    const key = bucketKey(facts);
    const existing = this.buckets.get(key);
    if (existing == null) {
      this.buckets.set(key, {
        facts,
        count: 1,
        firstSeenAtMs: now,
        lastSeenAtMs: now,
        firstPayloadSample: facts.sample,
        lastPayloadSample: facts.sample,
      });
    } else {
      existing.count += 1;
      existing.lastSeenAtMs = now;
      existing.lastPayloadSample = facts.sample;
    }
    return true;
  }

  bucketCount(): number {
    return this.buckets.size;
  }

  start(): void {
    if (this.deps.windowMs <= 0 || this.timer != null) return;
    this.timer = setInterval(() => this.flushAll("periodic"), this.deps.windowMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flushAll("shutdown");
  }

  flushAll(reason: string): void {
    if (this.buckets.size === 0) {
      this.writeBucketGauge(0);
      return;
    }
    const bucketCountBeforeFlush = this.buckets.size;
    const buckets = [...this.buckets.values()];
    this.buckets.clear();
    for (const bucket of buckets) this.flushBucket(bucket, reason);
    this.writeBucketGauge(bucketCountBeforeFlush);
  }

  private flushBucket(bucket: RollupBucket, flushReason: string): void {
    const labels = rollupLabels(bucket.facts);
    this.deps.emit({
      eventType: EXECUTION_PROFILE_RISK_EVENTS.decisionChainRollup,
      payload: {
        ...labels,
        count: bucket.count,
        windowMs: this.deps.windowMs,
        flushReason,
        firstSeenAt: new Date(bucket.firstSeenAtMs).toISOString(),
        lastSeenAt: new Date(bucket.lastSeenAtMs).toISOString(),
        firstPayloadSample: bucket.firstPayloadSample,
        lastPayloadSample: bucket.lastPayloadSample,
      },
    });
    this.deps.writeCounter(
      EXECUTION_PROFILE_METRICS.chainDecision,
      bucket.count,
      serializeExecutionProfileLabels(labels),
    );
  }

  private writeBucketGauge(bucketCount: number): void {
    writeExecutionProfileGaugeEvent(
      { writeEvent: this.deps.writeEvent },
      EXECUTION_PROFILE_METRICS.rollupBucketGauge,
      bucketCount,
      {},
      this.now(),
    );
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function bucketKey(facts: ExecutionProfileRollupFacts): string {
  return `${facts.kind}:${facts.profile}:${facts.outcome}:${facts.mode}:${facts.reason}`;
}

function rollupLabels(facts: ExecutionProfileRollupFacts): {
  kind: "scale_in" | "cost_cap";
  profile: ExecutionProfileName;
  outcome: ExecutionProfileDecision;
  mode: ScaleInMode | "none";
  reason: ScaleInReason;
} {
  return {
    kind: facts.kind,
    profile: facts.profile,
    outcome: facts.outcome,
    mode: facts.mode,
    reason: facts.reason,
  };
}

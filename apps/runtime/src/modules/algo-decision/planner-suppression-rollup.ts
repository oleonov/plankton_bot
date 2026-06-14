export const ROLLUP_SUPPRESSION_REASONS = new Set([
  "sell-spread-too-wide-below-avg-entry",
  "sell-spread-too-wide-avg-entry-unavailable",
]);

export const MAX_ROLLUP_BUCKETS = 10_000;
export const DEFAULT_PLANNER_SUPPRESSION_ROLLUP_WINDOW_MS = 5 * 60 * 1000;

export type PlannerSuppressionFlushReason =
  | "periodic"
  | "shutdown"
  | "overflow"
  | "order_placed"
  | "fill_received"
  | "position_settled"
  | "leg_state_cleared";

export type PlannerSuppressionFacts = {
  readonly tokenId: string;
  readonly conditionId: string | null;
  readonly reasonCode: string;
  readonly decisionRuleId: string | null;
  readonly side: string | null;
  readonly sample: Record<string, unknown>;
};

type PlannerSuppressionRollupBucket = {
  tokenId: string;
  conditionId: string | null;
  reasonCode: string;
  decisionRuleId: string | null;
  side: string | null;
  count: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  firstPayloadSample: Record<string, unknown>;
  lastPayloadSample: Record<string, unknown>;
};

export type PlannerSuppressionRollupEvent = {
  readonly eventType: "planner_suppressed_rollup";
  readonly payload: {
    readonly tokenId: string;
    readonly conditionId: string | null;
    readonly reasonCode: string;
    readonly decisionRuleId: string | null;
    readonly side: string | null;
    readonly count: number;
    readonly windowMs: number;
    readonly firstSeenAt: string;
    readonly lastSeenAt: string;
    readonly firstPayloadSample: Record<string, unknown>;
    readonly lastPayloadSample: Record<string, unknown>;
    readonly flushReason: PlannerSuppressionFlushReason;
    readonly schemaVersion: 1;
  };
};

export interface PlannerSuppressionRollupDeps {
  readonly windowMs: number;
  readonly maxBuckets?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly emit: (event: PlannerSuppressionRollupEvent) => void;
  readonly writeCounter?:
    | ((metricName: string, value: number, labels: string | null) => void)
    | undefined;
  readonly writeLatest?:
    | ((metricName: string, value: number, labels: string | null) => void)
    | undefined;
  readonly isRollupReason?: ((reasonCode: string) => boolean) | undefined;
}

export class PlannerSuppressionRollup {
  private readonly buckets = new Map<string, PlannerSuppressionRollupBucket>();
  private readonly windowMs: number;
  private readonly maxBuckets: number;
  private readonly now: () => number;
  private readonly isRollupReason: (reasonCode: string) => boolean;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: PlannerSuppressionRollupDeps) {
    this.windowMs = deps.windowMs;
    this.maxBuckets = deps.maxBuckets ?? MAX_ROLLUP_BUCKETS;
    this.now = deps.now ?? Date.now;
    this.isRollupReason =
      deps.isRollupReason ?? ((reasonCode) => ROLLUP_SUPPRESSION_REASONS.has(reasonCode));
  }

  record(facts: PlannerSuppressionFacts): boolean {
    if (this.windowMs === 0 || !this.isRollupReason(facts.reasonCode)) return false;

    const key = this.buildKey(facts);
    const nowMs = this.now();
    const existing = this.buckets.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAtMs = nowMs;
      existing.lastPayloadSample = facts.sample;
      return true;
    }

    if (this.buckets.size >= this.maxBuckets) {
      this.writeCounter("track_planner_rollup_overflow_count", 1, null);
      this.flushAll("overflow");
    }

    this.buckets.set(key, {
      tokenId: facts.tokenId,
      conditionId: facts.conditionId,
      reasonCode: facts.reasonCode,
      decisionRuleId: facts.decisionRuleId,
      side: facts.side,
      count: 1,
      firstSeenAtMs: nowMs,
      lastSeenAtMs: nowMs,
      firstPayloadSample: facts.sample,
      lastPayloadSample: facts.sample,
    });
    return true;
  }

  flushToken(tokenId: string, flushReason: PlannerSuppressionFlushReason): number {
    const buckets = [...this.buckets.values()].filter((bucket) => bucket.tokenId === tokenId);
    return this.flushBuckets(buckets, flushReason);
  }

  flushAll(flushReason: PlannerSuppressionFlushReason): number {
    return this.flushBuckets([...this.buckets.values()], flushReason);
  }

  bucketCount(): number {
    return this.buckets.size;
  }

  start(): void {
    if (this.windowMs === 0 || this.timer !== null) return;
    this.timer = setInterval(() => {
      this.flushAll("periodic");
    }, this.windowMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flushAll("shutdown");
  }

  private flushBuckets(
    buckets: readonly PlannerSuppressionRollupBucket[],
    flushReason: PlannerSuppressionFlushReason,
  ): number {
    if (buckets.length === 0) return 0;
    const bucketCountBeforeFlush = this.buckets.size;
    for (const bucket of buckets) {
      this.deps.emit(this.toEvent(bucket, flushReason));
      this.buckets.delete(this.buildBucketKey(bucket));
    }
    this.writeCounter("track_planner_rollup_flushed_events", buckets.length, null);
    this.writeLatest("track_planner_rollup_bucket_count_gauge", bucketCountBeforeFlush, null);
    return buckets.length;
  }

  private toEvent(
    bucket: PlannerSuppressionRollupBucket,
    flushReason: PlannerSuppressionFlushReason,
  ): PlannerSuppressionRollupEvent {
    return {
      eventType: "planner_suppressed_rollup",
      payload: {
        tokenId: bucket.tokenId,
        conditionId: bucket.conditionId,
        reasonCode: bucket.reasonCode,
        decisionRuleId: bucket.decisionRuleId,
        side: bucket.side,
        count: bucket.count,
        windowMs: this.windowMs,
        firstSeenAt: new Date(bucket.firstSeenAtMs).toISOString(),
        lastSeenAt: new Date(bucket.lastSeenAtMs).toISOString(),
        firstPayloadSample: bucket.firstPayloadSample,
        lastPayloadSample: bucket.lastPayloadSample,
        flushReason,
        schemaVersion: 1,
      },
    };
  }

  private buildKey(facts: PlannerSuppressionFacts): string {
    return [facts.tokenId, facts.reasonCode, facts.decisionRuleId ?? "", facts.side ?? ""].join(
      "|",
    );
  }

  private buildBucketKey(bucket: PlannerSuppressionRollupBucket): string {
    return [bucket.tokenId, bucket.reasonCode, bucket.decisionRuleId ?? "", bucket.side ?? ""].join(
      "|",
    );
  }

  private writeCounter(metricName: string, value: number, labels: string | null): void {
    this.deps.writeCounter?.(metricName, value, labels);
  }

  private writeLatest(metricName: string, value: number, labels: string | null): void {
    this.deps.writeLatest?.(metricName, value, labels);
  }
}

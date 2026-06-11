import type Database from "better-sqlite3";
import {
  classifySellLoopGuardReject,
  classifySellLoopGuardSkip,
  createSellLoopGuardBucket,
  createTokenId,
  getSellLoopGuardSnapshot,
  recordSellLoopGuardOutcome,
  resetSellLoopGuardBucket,
  shouldCountSellLoopGuardOutcome,
  type EventBus,
  type LoopGuardOutcomeKind,
  type OrderSide,
  type Position,
  type RiskEventRepository,
  type RuntimeEventMap,
  type RuntimeModule,
  type SellLoopGuardPolicy,
  type SellLoopGuardSnapshot,
  type TokenId,
  type TokenLoopBucket,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import { recoverSellLoopGuardEvents } from "./recovery.js";

const COUNTER_METRIC = "track_q_loop_guard_counter";
const TRIGGER_METRIC = "track_q_loop_guard_trigger_total";
const ACTIVE_TOKENS_METRIC = "track_q_loop_guard_active_tokens";
const ACTIVATION_REASON_CODE = "sell_loop_guard";

/** Narrow read surface the planner depends on; avoids coupling to the module. */
export interface SellLoopGuardReader {
  getSnapshot(tokenId: TokenId, nowMs?: number): SellLoopGuardSnapshot | null;
}

export interface SellLoopGuardModuleDeps {
  bus: EventBus;
  policy: () => SellLoopGuardPolicy;
  log: Logger;
  riskEventRepo?: RiskEventRepository | undefined;
  runtimeMetrics?: RuntimeMetricWriter | undefined;
  /** Ledger connection for startup recovery only; never written to. */
  db?: Database.Database | undefined;
  now?: (() => number) | undefined;
}

interface OutcomeContext {
  conditionId: string;
  decisionRuleId: string | null;
  signalReason: string | null;
  price: number | null;
  bestBid: number | null;
  bestAsk: number | null;
}

export class SellLoopGuardModule implements RuntimeModule, SellLoopGuardReader {
  private readonly log: Logger;
  private readonly buckets = new Map<string, TokenLoopBucket>();
  private unsubs: Array<() => void> = [];

  constructor(private readonly deps: SellLoopGuardModuleDeps) {
    this.log = deps.log.child({ component: "sell-loop-guard" });
  }

  async start(): Promise<void> {
    this.recoverFromDb();
    this.unsubs = [
      this.deps.bus.subscribe("OrderSkipped", (e) => this.onOrderSkipped(e)),
      this.deps.bus.subscribe("OrderRejected", (e) => this.onOrderRejected(e)),
      this.deps.bus.subscribe("OrderPlaced", (e) => this.onSellResetEvent(e.side, e.tokenId)),
      this.deps.bus.subscribe("FillReceived", (e) => this.onSellResetEvent(e.side, e.tokenId)),
      this.deps.bus.subscribe("PositionUpdated", (e) => this.onPositionUpdated(e.position)),
      this.deps.bus.subscribe("PositionSettled", async (e) => {
        this.reset(e.tokenId);
      }),
    ];
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: `tracked=${this.buckets.size}` };
  }

  getSnapshot(tokenId: TokenId, nowMs = this.now()): SellLoopGuardSnapshot | null {
    return getSellLoopGuardSnapshot(this.buckets.get(String(tokenId)), nowMs, this.deps.policy());
  }

  /** Clear all counted events for a token (loop escaped into open-order/fill/close). */
  reset(tokenId: TokenId): void {
    const bucket = this.buckets.get(String(tokenId));
    if (!bucket) return;
    resetSellLoopGuardBucket(bucket);
    this.updateActiveTokensGauge(this.now());
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async onOrderSkipped(e: RuntimeEventMap["OrderSkipped"]): Promise<void> {
    const outcome = classifySellLoopGuardSkip({ side: e.side, reasonCode: e.reasonCode });
    if (!outcome) return;
    this.record(e.tokenId, outcome, {
      conditionId: String(e.conditionId),
      decisionRuleId: e.decisionRuleId,
      signalReason: e.signalReason,
      price: e.price,
      bestBid: numberOrNull(e.details.bestBid),
      bestAsk: numberOrNull(e.details.bestAsk),
    });
  }

  private async onOrderRejected(e: RuntimeEventMap["OrderRejected"]): Promise<void> {
    const outcome = classifySellLoopGuardReject({
      side: e.side ?? "",
      reason: e.reason,
      exchangeErrorMessage: e.exchangeErrorMessage ?? null,
    });
    if (!outcome) return;
    this.record(e.tokenId, outcome, {
      conditionId: String(e.conditionId),
      decisionRuleId: e.decisionRuleId ?? null,
      signalReason: e.signalReason,
      price: null,
      bestBid: null,
      bestAsk: null,
    });
  }

  private async onSellResetEvent(side: OrderSide, tokenId: TokenId): Promise<void> {
    if (side !== "sell") return;
    this.reset(tokenId);
  }

  private async onPositionUpdated(position: Position): Promise<void> {
    if (position.status === "closed" || position.size <= 0) this.reset(position.tokenId);
  }

  private record(tokenId: TokenId, outcome: LoopGuardOutcomeKind, ctx: OutcomeContext): void {
    const policy = this.deps.policy();
    if (!shouldCountSellLoopGuardOutcome(outcome, policy)) return;
    const nowMs = this.now();
    const bucket = this.getOrCreateBucket(tokenId);
    this.deps.runtimeMetrics?.writeCounter(COUNTER_METRIC, 1, JSON.stringify({ outcome }));
    const { activated } = recordSellLoopGuardOutcome(bucket, outcome, nowMs, policy);
    if (activated) this.onActivated(tokenId, outcome, ctx, bucket, nowMs, policy);
  }

  private onActivated(
    tokenId: TokenId,
    outcome: LoopGuardOutcomeKind,
    ctx: OutcomeContext,
    bucket: TokenLoopBucket,
    nowMs: number,
    policy: SellLoopGuardPolicy,
  ): void {
    this.deps.runtimeMetrics?.writeCounter(TRIGGER_METRIC, 1, JSON.stringify({ outcome }));
    this.deps.riskEventRepo?.insert({
      eventType: "signal_suppressed",
      payload: {
        reasonCode: ACTIVATION_REASON_CODE,
        tokenId: String(tokenId),
        conditionId: ctx.conditionId,
        activeCount: bucket.events.length,
        threshold: policy.threshold,
        windowMs: policy.windowMs,
        cooldownMs: policy.cooldownMs,
        blockedUntil:
          bucket.blockedUntilMs != null ? new Date(bucket.blockedUntilMs).toISOString() : null,
        lastOutcome: outcome,
        decisionRuleId: ctx.decisionRuleId,
        signalReason: ctx.signalReason,
        price: ctx.price,
        bestBid: ctx.bestBid,
        bestAsk: ctx.bestAsk,
        source: ACTIVATION_REASON_CODE,
      },
    });
    this.updateActiveTokensGauge(nowMs);
    this.log.warn(
      {
        tokenId: String(tokenId),
        outcome,
        activeCount: bucket.events.length,
        threshold: policy.threshold,
        cooldownMs: policy.cooldownMs,
      },
      "sell loop guard activated -- suppressing SELL signals for cooldown",
    );
  }

  private updateActiveTokensGauge(nowMs: number): void {
    if (!this.deps.runtimeMetrics) return;
    let count = 0;
    for (const bucket of this.buckets.values()) {
      if (bucket.blockedUntilMs != null && nowMs < bucket.blockedUntilMs) count++;
    }
    this.deps.runtimeMetrics.writeLatest(ACTIVE_TOKENS_METRIC, count, null);
  }

  private getOrCreateBucket(tokenId: TokenId): TokenLoopBucket {
    const key = String(tokenId);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = createSellLoopGuardBucket();
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private recoverFromDb(): void {
    const db = this.deps.db;
    if (!db) return;
    const policy = this.deps.policy();
    if (!policy.enabled) return;
    const windowStartMs = this.now() - policy.windowMs;
    try {
      const events = recoverSellLoopGuardEvents(db, windowStartMs);
      for (const ev of events) {
        const bucket = this.getOrCreateBucket(createTokenId(ev.tokenId));
        recordSellLoopGuardOutcome(bucket, ev.outcome, ev.timestampMs, policy);
      }
      this.updateActiveTokensGauge(this.now());
      this.log.info(
        { recovered: events.length, trackedTokens: this.buckets.size },
        "sell loop guard recovered window state from durable rows",
      );
    } catch (err) {
      // Fail open: an unrecoverable read must not block all SELLs on boot.
      this.log.warn({ err }, "sell loop guard recovery failed; starting empty (fail-open)");
      this.deps.runtimeMetrics?.writeEvent("infra_alert", 1, "sell_loop_guard_recovery_failed");
    }
  }
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

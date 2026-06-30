import {
  type EventBus,
  type NormalizedMarket,
  type RiskEventRepository,
  type RuntimeEventMap,
  type RuntimeModule,
  type Signal,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import {
  computeDeadMarketScore,
  deriveDecisionType,
  deriveSourceGroup,
  DEAD_MARKET_COMPONENT_KEYS,
  type DeadMarketClassification,
  type DeadMarketDecisionType,
  type DeadMarketScoreResult,
  type DeadMarketSourceGroup,
} from "./dead-market-score.js";

export const DEAD_MARKET_SHADOW_RISK_EVENT_TYPE = "dead_market_shadow";

const EVALUATED_METRIC = "dead_market_shadow_evaluated_total";
const SCORE_BUCKET_METRIC = "dead_market_shadow_score_bucket_total";
const MISSING_COMPONENT_METRIC = "dead_market_shadow_missing_component_total";
const COMPONENT_METRIC = "dead_market_shadow_component_total";
// Named for what it actually measures: a top-of-book (bestBid && bestAsk)
// presence check, not full order-book depth. The module keeps no book cache.
const BBO_AVAILABLE_METRIC = "dead_market_shadow_bbo_available_total";

// Bounded version/feature-set labels so the live signal is never silently
// compared against the richer research score: live only computes 3 of the 6
// components (the Plankton/observer features are offline), captured explicitly
// here and by missing_component_total per-eval.
const SCORE_VERSION = "dead_market_v1";
const LIVE_FEATURE_SET = "live_3of6";

// Risk events are sampled only for candidates the score would act on (>= 2:
// downweight/block/hard-block). shadow_allow (0-1) is the common case and is
// captured by the aggregated metric counters instead, keeping the audit log
// bounded. This sampling threshold is logged at start() so it is never a
// silent cap.
const RISK_EVENT_MIN_SCORE = 2;
const DEFAULT_RISK_EVENT_COOLDOWN_MS = 10 * 60 * 1000;
const COOLDOWN_PRUNE_INTERVAL = 1000;

/** Narrow metric surface so tests and the runtime metric writer both satisfy it. */
export interface ShadowMetricSink {
  writeCounter(metricName: string, value?: number, labels?: string | null): void;
}

export interface DeadMarketShadowModuleDeps {
  bus: EventBus;
  log: Logger;
  metrics?: ShadowMetricSink | undefined;
  riskEventRepo?: RiskEventRepository | undefined;
  now?: (() => number) | undefined;
  riskEventCooldownMs?: number | undefined;
}

/**
 * Shadow-only observer for the Plankton "dead market" score. It subscribes to
 * SignalProduced for BUY candidates (first-entry and scale-in), computes the
 * score, and emits bounded telemetry + sampled risk events. It NEVER publishes
 * to the event bus, so it is structurally incapable of blocking, resizing, or
 * repricing a live order or of altering any RiskGate decision.
 */
export class DeadMarketShadowModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly cooldownMs: number;
  private readonly riskEventCooldown = new Map<string, number>();
  private callsSinceLastPrune = 0;
  private unsubs: Array<() => void> = [];

  constructor(private readonly deps: DeadMarketShadowModuleDeps) {
    this.log = deps.log.child({ component: "dead-market-shadow" });
    this.cooldownMs = deps.riskEventCooldownMs ?? DEFAULT_RISK_EVENT_COOLDOWN_MS;
  }

  async start(): Promise<void> {
    // Dead-market score reads the raw SignalProduced stream (every candidate the
    // strategy emits).
    this.unsubs = [this.deps.bus.subscribe("SignalProduced", (e) => this.onSignalProduced(e))];
    this.log.info(
      { riskEventMinScore: RISK_EVENT_MIN_SCORE, riskEventCooldownMs: this.cooldownMs },
      "dead-market shadow scoring started (observe-only; never affects live trading)",
    );
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: `cooldownKeys=${this.riskEventCooldown.size}` };
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async onSignalProduced(e: RuntimeEventMap["SignalProduced"]): Promise<void> {
    const { signal, market } = e;
    if (signal.side !== "buy") return;

    const sourceGroup = deriveSourceGroup(signal.decisionRuleId);
    // decisionType (entry/add) follows the strategy reason, independently of the
    // source-group label.
    const decisionType = deriveDecisionType(signal.reason);
    const price = Number.isFinite(signal.suggestedPrice) ? signal.suggestedPrice : null;

    const result = computeDeadMarketScore({
      selectedPrice: price,
      sourceGroup,
      gammaLiquidity: market.liquidity ?? null,
      // The Plankton observer is offline research-only; these features are not
      // available live yet, so they stay unknown (fail-open) rather than guessed.
      planktonActive24h: null,
      planktonEverTouched: null,
      observerDead: null,
    });

    this.emitMetrics(result, decisionType, sourceGroup, market);
    this.maybeRecordRiskEvent(result, decisionType, sourceGroup, signal, market, price);
  }

  private emitMetrics(
    result: DeadMarketScoreResult,
    decisionType: DeadMarketDecisionType,
    sourceGroup: DeadMarketSourceGroup,
    market: NormalizedMarket,
  ): void {
    const metrics = this.deps.metrics;
    if (!metrics) return;
    const classification = classificationLabel(result.classification);
    const scoreBucket = scoreBucketLabel(result.score);

    metrics.writeCounter(
      EVALUATED_METRIC,
      1,
      JSON.stringify({
        decisionType,
        classification,
        scoreBucket,
        sourceGroup,
        scoreVersion: SCORE_VERSION,
        featureSet: LIVE_FEATURE_SET,
      }),
    );
    metrics.writeCounter(
      SCORE_BUCKET_METRIC,
      1,
      JSON.stringify({
        decisionType,
        scoreBucket,
        scoreVersion: SCORE_VERSION,
        featureSet: LIVE_FEATURE_SET,
      }),
    );
    for (const key of DEAD_MARKET_COMPONENT_KEYS) {
      metrics.writeCounter(
        COMPONENT_METRIC,
        1,
        JSON.stringify({ component: key, present: result.components[key] }),
      );
    }
    for (const key of result.unknownComponents) {
      metrics.writeCounter(MISSING_COMPONENT_METRIC, 1, JSON.stringify({ component: key }));
    }
    const available = market.bestBid != null && market.bestAsk != null;
    metrics.writeCounter(BBO_AVAILABLE_METRIC, 1, JSON.stringify({ available }));
  }

  private maybeRecordRiskEvent(
    result: DeadMarketScoreResult,
    decisionType: DeadMarketDecisionType,
    sourceGroup: DeadMarketSourceGroup,
    signal: Signal,
    market: NormalizedMarket,
    price: number | null,
  ): void {
    const repo = this.deps.riskEventRepo;
    if (!repo || result.score < RISK_EVENT_MIN_SCORE) return;

    const scoreBucket = scoreBucketLabel(result.score);
    const classification = classificationLabel(result.classification);
    const key = `${signal.tokenId}:${scoreBucket}:${classification}`;
    const nowMs = this.now();
    const lastAt = this.riskEventCooldown.get(key);
    if (lastAt !== undefined && nowMs - lastAt < this.cooldownMs) return;
    this.riskEventCooldown.set(key, nowMs);
    this.pruneCooldownPeriodically(nowMs);

    repo.insert({
      eventType: DEAD_MARKET_SHADOW_RISK_EVENT_TYPE,
      payload: {
        tokenId: String(signal.tokenId),
        conditionId: String(signal.conditionId),
        marketTitle: market.question,
        decisionType,
        sourceGroup,
        decisionRuleId: signal.decisionRuleId,
        reason: signal.reason,
        price,
        gammaLiquidity: market.liquidity ?? null,
        score: result.score,
        classification: result.classification,
        scoreVersion: SCORE_VERSION,
        featureSet: LIVE_FEATURE_SET,
        components: result.components,
        unknownComponents: result.unknownComponents,
      },
    });
  }

  private pruneCooldownPeriodically(nowMs: number): void {
    this.callsSinceLastPrune += 1;
    if (this.callsSinceLastPrune < COOLDOWN_PRUNE_INTERVAL) return;
    this.callsSinceLastPrune = 0;
    for (const [key, ts] of this.riskEventCooldown) {
      if (nowMs - ts > this.cooldownMs) this.riskEventCooldown.delete(key);
    }
  }
}

function classificationLabel(classification: DeadMarketClassification): string {
  return classification.replace(/^shadow_/, "");
}

function scoreBucketLabel(score: number): string {
  return Number.isInteger(score) && score >= 0 && score <= 6 ? String(score) : "unknown";
}

/**
 * AlgoDecisionModule — subscribes to market updates and evaluates tokens against
 * the algo decision engine, emitting SignalProduced events.
 *
 * Subscribes to:
 *  - NormalizedMarketUpdated → update market cache, evaluate affected tokens
 *  - OrderPlaced (buy side) → track pending entries for deduplication
 *  - FillReceived (buy side) → clear pending entry on fill
 *  - OrderCancelled → clear pending entry by orderId
 *  - OrderRejected → clear pending entry by clientOrderId
 *
 * On sweep interval:
 *  - Prune expired pending entries (120s timeout)
 *  - Evaluate all eligible tokens against all leg states
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  EventBus,
  RuntimeModule,
  LegStateRepository,
  AlgoRulesRepository,
  NormalizedMarket,
  AlgoDecisionRule,
  AlgoSizeRule,
  RuntimeEventMap,
  TokenId,
  ConditionId,
  PositionRepository,
  DecisionSignalLog,
  DecisionSignalLogRepository,
  RiskEventRepository,
  MarketTradeCountProvider,
  ContinuationMode,
  ExecutionPolicy,
  TradeDecisionAction,
  LegState,
  Position,
} from "@krabs/domain";
import {
  deriveState,
  evaluateDecision,
  evaluateSize,
  resolveSignalReason,
  evaluateContinuation,
  evaluateMinMarketAge,
  matchRule,
  isAlive,
  evaluateD8ProfitRatio,
  evaluateD9LossExit,
  H5_WIDE_COHORT_GUARD_REASON,
  evaluateR23DipTrigger,
  R23_DIP_TRIGGER_RULE_ID,
  R23_NO_DIP_REASON,
  R23_NO_HISTORY_REASON,
  isAbandoned,
  shouldRecoverFromPriceMove,
} from "@krabs/domain";
import { readContinuationMode, readContinuationModeVersion } from "@krabs/db";
import type { EvalContext } from "@krabs/domain";
import type { RuntimeControl } from "@krabs/domain";
import type { Logger } from "../../logger.js";
import {
  classifyAddAgeBucket,
  classifyAddPriceChangeBucket,
  classifyExitPnlBucket,
  classifyHoldingTimeBucket,
  classifyNotionalBucket,
  classifySoldBoughtRatioBucket,
} from "../../executable-price.js";
import { SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON } from "../../internal-order-reasons.js";
import { isExecutableOrderSize } from "../../min-order-size.js";
import { WALLET_BUY_CAPACITY_EXHAUSTED_REASON } from "../../wallet-buy-budget.js";
import { SlidingLatencyWindow, type LatencySnapshot } from "./decision-metrics.js";
import { DecisionPersistenceBuffer } from "./async-decision-persistence.js";
import { DecisionWorkerPool } from "./decision-worker-pool.js";
import { ContinuationTradeCountCache } from "./continuation-trade-count-cache.js";
import type {
  DecisionMetricsDelta,
  DecisionPlanningInput,
  DecisionPlanSideEffect,
  DecisionSignalDraft,
} from "./decision-planner.js";
import type { PriceHistoryProvider } from "./market-snapshot-price-history.js";
import type { WindowMaxCacheMetrics } from "./market-snapshot-price-history.js";

// ─── SelectedMarketCache ─────────────────────────────────────────────────────

/**
 * External cache of markets selected for trading — used to gate new entries.
 * Tokens with an existing LegState bypass isEligible (see evaluateToken).
 */
export interface SelectedMarketCache {
  isEligible(tokenId: TokenId): boolean;
  getEligibleTokenIds(): TokenId[];
  /**
   * ADR-018 §D2 — optional Step 1 universe-filter funnel snapshot. Implemented
   * by `MarketSelectionCache`; absent on test stubs that don't need telemetry.
   */
  getUniverseFilterSnapshot?(): {
    readonly seen: number;
    readonly volumeZeroDropped: number;
    readonly volumeNullEvaluated: number;
    readonly volumePositiveEvaluated: number;
    readonly selectionRuleAdmitted: number;
    readonly selectionRuleRejected: number;
  };
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface PendingEntry {
  tokenId: string;
  signalId: string;
  suggestedSizeUsdc: number;
  reservedAt: number;
  clientOrderId: string | null;
  orderId: string | null;
}

type TokenEvalResult = {
  type: "signal";
  signal: import("@krabs/domain").Signal;
  market: NormalizedMarket;
  // Deferred persistence of decision_signal_log + signal_emitted risk_event.
  // Keep construction pure until `evaluateTokensInner` commits the signal
  // to the emit queue. Budget and exposure rejections happen downstream and
  // must not erase Step 5 trigger telemetry.
  commitLog: () => void;
} | null;

type DecisionEvalMetrics = {
  evalTotal: number;
  emitted: number;
  suppressedMarketNotLive: number;
  dropTriggerChecked: number;
  dropTriggerPassed: number;
  r23DipChecked: number;
  r23DipFired: number;
  r23NoHistory: number;
  r23NoDip: number;
  rejectNoDropSignal: number;
  allowNoDropData: number;
  livenessNotAcceptingOrders: number;
  livenessOrderBookDisabled: number;
  livenessBothFlags: number;
  wouldMatchRule: Map<string, number>;
};

export interface DecisionEvalMetricsSnapshot {
  evalTotal: number;
  emitted: number;
  suppressedMarketNotLive: number;
  dropTriggerChecked: number;
  dropTriggerPassed: number;
  r23DipChecked: number;
  r23DipFired: number;
  r23NoHistory: number;
  r23NoDip: number;
  rejectNoDropSignal: number;
  allowNoDropData: number;
  livenessNotAcceptingOrders: number;
  livenessOrderBookDisabled: number;
  livenessBothFlags: number;
  wouldMatchRule: Record<string, number>;
  decisionTickLatency: LatencySnapshot;
  r23Cache: WindowMaxCacheMetrics | null;
  capturedAt: string;
}

/**
 * ADR-016: which source the continuation gate consulted for `trade_count`.
 *  - `market_wide` — fresh value from `MarketTradeCountProvider`.
 *  - `leg_local_fallback` — provider returned `null` (network/timeout/parse);
 *    we degraded to ADR-010 D1 (per-leg `buyCount + sellCount`).
 *  - `leg_local` — operator policy is `leg_local`; provider was not consulted.
 */
type TradeCountSource = "market_wide" | "leg_local_fallback" | "leg_local";

type EmissionFacts = {
  firstTradePrice: number | null;
  firstTradeAt: string | null;
  legTradeCount: number;
  // ADR-027 §D-B — leg-local cumulative aggregates required to compute
  // exit-telemetry (rolling cost basis VWAP, sold/bought ratio, holding
  // time, first-sell flag) at SELL signal-emit time. Null when no
  // pre-existing leg state (i.e. first BUY emission).
  sellCountAtEmit?: number | null;
  cumulativeBuySize?: number | null;
  cumulativeBuyNotional?: number | null;
  cumulativeSellSize?: number | null;
  /**
   * ADR-027 §D-B — canonical rolling cost basis from `positions.avg_entry_price`,
   * sampled at signal-emit time. The runtime recomputes this via FIFO from
   * remaining lots after each SELL fill (`inventory-handler.ts`), so it stays
   * accurate across partial sells. The lifetime VWAP
   * (`cumulative_buy_notional / cumulative_buy_size`) only matches this on the
   * first SELL — subsequent SELLs need the rolling value or `exit_pnl_pct`
   * silently shifts. Null when no open position exists for the token.
   */
  currentAvgEntryPrice?: number | null;
  continuationStop?: boolean | null;
  continuationTradeCount?: number | null;
  continuationTradeCountSource?: TradeCountSource | null;
  // CHANGE A — D8 telemetry attached on the SELL signal that D8 fires.
  d8ProfitRatio?: number | null;
  d8Threshold?: number | null;
  d8AvgBuyPrice?: number | null;
  d9ProfitRatio?: number | null;
  d9AvgBuyPrice?: number | null;
  d9DaysToResolve?: number | null;
  d9PublicTradeCount24h?: number | null;
  r23DipRatio?: number | null;
  r23MaxMidpoint?: number | null;
  r23WindowMs?: number | null;
};

/**
 * ADR-022 §D-F — entry-price bucket categories aligned with R24 §9.6 buckets.
 * Buckets are right-closed: `<=0.005`, `(0.005-0.05]`, `(0.05-0.20]`, `>0.20`.
 */
type EntryPriceBucket = "<=0.005" | "0.005-0.05" | "0.05-0.20" | ">0.20";

function classifyEntryPriceBucket(price: number): EntryPriceBucket {
  if (price <= 0.005) return "<=0.005";
  if (price <= 0.05) return "0.005-0.05";
  if (price <= 0.2) return "0.05-0.20";
  return ">0.20";
}

function createDecisionEvalMetrics(): DecisionEvalMetrics {
  return {
    evalTotal: 0,
    emitted: 0,
    suppressedMarketNotLive: 0,
    dropTriggerChecked: 0,
    dropTriggerPassed: 0,
    r23DipChecked: 0,
    r23DipFired: 0,
    r23NoHistory: 0,
    r23NoDip: 0,
    rejectNoDropSignal: 0,
    allowNoDropData: 0,
    livenessNotAcceptingOrders: 0,
    livenessOrderBookDisabled: 0,
    livenessBothFlags: 0,
    wouldMatchRule: new Map<string, number>(),
  };
}

/**
 * ADR-022 §D-F — F-telemetry derived facts captured at signal-emission time.
 * `dropFromLastSeen` is `(price - prevMidPrice) / prevMidPrice` against the
 * immediately prior `NormalizedMarketUpdated` for this token; `null` on the
 * first observation. Sign convention: negative = price went down, positive =
 * price went up. `entryPriceBucket` mirrors R24 §9.6 buckets.
 */
type TriggerTelemetry = {
  dropFromLastSeen: number | null;
  entryPriceBucket: EntryPriceBucket;
  dropTriggerStatus: "bypass_probe" | "passed" | "rejected" | "no_drop_data" | "disabled";
  dropTriggerPct: number | null;
};

/**
 * ADR-027 §D-B — exit telemetry derived facts captured at SELL signal-emit
 * time. BUY/REDEEM rows return all-null. Rolling cost basis is sourced from
 * `positions.avg_entry_price` (recomputed via FIFO after each SELL fill in
 * `inventory-handler.ts`), with a fallback to lifetime VWAP
 * (`cumulative_buy_notional / cumulative_buy_size`) when the position row is
 * unavailable. The lifetime VWAP only matches `avg_entry_price` on the first
 * SELL — afterwards FIFO deductions diverge it. Holding time is signal-precise
 * (not fill-precise); §11.2 analysts filter `WHERE is_first_sell = 1` for the
 * canonical first-SELL distribution. Negative holding-time deltas (clock skew
 * / future firstTradeAt) collapse to null rather than `<1h`.
 */
type ExitTelemetry = Pick<
  DecisionSignalLog,
  | "isExit"
  | "isFirstSell"
  | "holdingTimeMs"
  | "holdingTimeBucket"
  | "exitPnlPct"
  | "exitPnlBucket"
  | "soldBoughtRatio"
  | "soldBoughtRatioBucket"
>;

const NON_SELL_EXIT_TELEMETRY: ExitTelemetry = {
  isExit: 0,
  isFirstSell: null,
  holdingTimeMs: null,
  holdingTimeBucket: null,
  exitPnlPct: null,
  exitPnlBucket: null,
  soldBoughtRatio: null,
  soldBoughtRatioBucket: null,
};

function computeExitTelemetry(
  side: "buy" | "sell",
  price: number,
  nowMs: number,
  emissionFacts: EmissionFacts,
): ExitTelemetry {
  if (side !== "sell") return NON_SELL_EXIT_TELEMETRY;

  const cumulativeBuySize = emissionFacts.cumulativeBuySize ?? 0;
  const cumulativeBuyNotional = emissionFacts.cumulativeBuyNotional ?? 0;
  const cumulativeSellSize = emissionFacts.cumulativeSellSize ?? 0;
  const sellCount = emissionFacts.sellCountAtEmit ?? 0;

  const firstTradeAtMs = emissionFacts.firstTradeAt
    ? new Date(emissionFacts.firstTradeAt).getTime()
    : null;
  const rawHoldingMs =
    firstTradeAtMs != null && Number.isFinite(firstTradeAtMs) ? nowMs - firstTradeAtMs : null;
  const holdingTimeMs = rawHoldingMs != null && rawHoldingMs >= 0 ? rawHoldingMs : null;

  const fallbackBasis = cumulativeBuySize > 0 ? cumulativeBuyNotional / cumulativeBuySize : null;
  const rollingBasis = emissionFacts.currentAvgEntryPrice ?? null;
  const costBasis =
    rollingBasis != null && rollingBasis > 0 && Number.isFinite(rollingBasis)
      ? rollingBasis
      : fallbackBasis;
  const exitPnlPct = costBasis != null && costBasis > 0 ? (price - costBasis) / costBasis : null;

  const soldBoughtRatio = cumulativeBuySize > 0 ? cumulativeSellSize / cumulativeBuySize : null;

  return {
    isExit: 1,
    isFirstSell: sellCount === 0 ? 1 : 0,
    holdingTimeMs,
    holdingTimeBucket: classifyHoldingTimeBucket(holdingTimeMs),
    exitPnlPct,
    exitPnlBucket: classifyExitPnlBucket(exitPnlPct),
    soldBoughtRatio,
    soldBoughtRatioBucket: classifySoldBoughtRatioBucket(soldBoughtRatio),
  };
}

type ContinuationFacts = {
  tradeCount: number;
  tradeCountSource: TradeCountSource;
  stop: boolean;
};

type SuppressionFacts = {
  tokenId: TokenId;
  conditionId: string | null;
  /**
   * Free-string code identifying the suppression reason. Currently emitted
   * by the AlgoDecisionModule sweep:
   *
   * - `market-cache-miss` — token in selection but no NormalizedMarket yet.
   * - `mid-price-unavailable` — market lacks a usable mid for the gate.
   * - `pending-buy-order` — open BUY order already exists for token.
   * - `market-not-live` — hard-liveness gate (acceptingOrders / book / spread).
   * - `continuation-stop` — leg failed R1/R2 continuation gate.
   * - `preserved-only-no-sell-rule` — preserved leg with no SELL rule match.
   * - `market_too_young` — Step 0 §P3, age < `entryMinMarketAgeSeconds`
   *   (spec §1.7 R1, `06:423`). Sticky → deduped via
   *   `DEDUPED_SUPPRESSION_REASONS`.
   * - `market_age_unknown` — Step 0 §P3, gammaCreatedAt is null/unparseable
   *   while the gate is enabled. Sticky → deduped.
   * - `d6-suppressed` — R37 $50-test guard: S2 + buyCount>=4 BUY is blocked
   *   unless the canonical D1 rule fired. Sticky → deduped.
   * - `no_drop_signal` — R54 drop-trigger gate blocked a non-probe BUY because
   *   the 1h reference price did not show a sufficient decline. Sticky → deduped.
   * - `post-buy-fill-cooldown` — short infrastructure delay after a BUY fill
   *   so exchange balance settlement can catch up before SELL placement.
   * - `h5-wide-cohort-guard` — ADR-031 D9 guard for S2 mid-entry
   *   long-horizon loss positions.
   * - `r23-no-history` / `r23-no-dip` — ADR-033 R23 entry dip trigger did
   *   not have a 24h max-midpoint reference or the current price did not meet
   *   the calibrated dip ratio.
   *
   * Adding a new reason: pick a kebab/snake-case identifier, document it
   * here, and decide whether it should join `DEDUPED_SUPPRESSION_REASONS`
   * (sticky reasons that fire on every sweep tick must, or they flood
   * `risk_events` ~1/sec).
   */
  reasonCode: string;
  reasons?: readonly string[];
  side?: "BUY" | "SELL" | "REDEEM" | null;
  decisionRuleId?: string | null;
  state: DecisionSignalLog["state"];
  price: number | null;
  buyCount: number;
  timeSinceLastSeconds: number | null;
  emissionFacts: EmissionFacts;
  timestamp: string;
  tradeCount?: number | null;
  tradeCountSource?: TradeCountSource | null;
};

interface ControlDbReader {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

export type BuySignalBudgetCircuitBreakerResult = {
  canAttempt: boolean;
  reasonCode?: string | undefined;
  activateCooldown?: boolean | undefined;
};

export interface BuySignalBudgetCircuitBreaker {
  canAttemptBuy(
    requiredNotionalUsdc: number,
    signal: import("@krabs/domain").Signal,
    context?: {
      pendingPreOpenBuyCount: number;
      pendingPreOpenBuyCountForToken: number;
      pendingPreOpenBuyNotionalUsdc: number;
    },
  ): BuySignalBudgetCircuitBreakerResult;
}

// ─── Deps ────────────────────────────────────────────────────────────────────

export interface AlgoDecisionModuleDeps {
  bus: EventBus;
  legStateRepo: LegStateRepository;
  algoRulesRepo: AlgoRulesRepository;
  /**
   * ADR-027 §D-B — used to read `positions.avg_entry_price` (FIFO-recomputed
   * after each SELL fill) at signal-emit time, so `exit_pnl_pct` reflects the
   * rolling cost basis of remaining lots rather than the lifetime buy VWAP.
   * Optional: omitted only by tests that don't exercise SELL telemetry.
   */
  positionRepo?: Pick<PositionRepository, "findByTokenId" | "findOpen"> | undefined;
  decisionSignalLogRepo?: DecisionSignalLogRepository | undefined;
  riskEventRepo?: RiskEventRepository | undefined;
  selectedMarketCache: SelectedMarketCache;
  runtimeControl?: RuntimeControl;
  controlDb?: ControlDbReader | undefined;
  /**
   * Operational circuit breaker for globally exhausted BUY budget. RiskInventory
   * still owns final budget rejection; this only prevents emitting thousands of
   * known-impossible BUY candidates while the wallet has no spendable balance.
   */
  buySignalBudgetCircuitBreaker?: BuySignalBudgetCircuitBreaker | undefined;
  buySignalBudgetCooldownMs?: number | undefined;
  /**
   * ADR-016 dependency. When provided AND the runtime_control_state policy is
   * `market_wide`, the post-entry continuation gate consults this provider
   * instead of the per-leg `buyCount + sellCount`. `null` returns from the
   * provider degrade transparently to leg-local (logged in suppression facts).
   */
  tradeCountProvider?: MarketTradeCountProvider | undefined;
  priceHistoryProvider?: PriceHistoryProvider | undefined;
  /**
   * Step 0 §P3 — DB-backed execution policy snapshot used by the min-age gate.
   * Reads `entryMinMarketAgeSeconds` to suppress first-BUY signals on markets
   * younger than the spec floor (2,504 s). When omitted, the gate is skipped
   * entirely (e.g. tests that don't supply a provider).
   */
  executionPolicy?: (() => ExecutionPolicy) | undefined;
  evalMetricsSink?: ((snapshot: DecisionEvalMetricsSnapshot) => void) | undefined;
  evalMetricsEmitIntervalMs?: number | undefined;
  decisionPersistenceMode?: "sync" | "async" | "worker" | undefined;
  decisionPersistenceWorkerDbPath?: string | undefined;
  decisionWorkerCount?: number | undefined;
  decisionWorkerBatchSize?: number | undefined;
  deferMarketUpdateEvaluation?: boolean | undefined;
  /**
   * v063 — when true, also writes `risk_events.signal_emitted` mirror rows on
   * every emit (the pre-v063 behaviour). Production defaults to false because
   * the mirror was write-only telemetry (~16M rows/day at the prod rate) and
   * directly contributed to the disk-full crash at v062. Tests pass true to
   * keep verifying the F-telemetry payload fields (dropFromLastSeen,
   * entryPriceBucket, r23DipRatio, …) that still live in the EmissionFacts
   * computation path even though they no longer reach the ledger.
   */
  persistSignalEmittedTelemetry?: boolean | undefined;
  log: Logger;
  sweepIntervalMs: number;
}

// ─── Module ──────────────────────────────────────────────────────────────────

const PENDING_ENTRY_TIMEOUT_MS = 120_000;
const SELL_ONLY: ReadonlySet<TradeDecisionAction> = new Set(["SELL"]);
/**
 * ADR-016: trade-count cap passed to the provider; matches R1 (`>= 6`) so the
 * provider can early-exit and never has to page beyond a single response.
 */
const CONTINUATION_TRADE_COUNT_CAP = 6;
/**
 * Cooperative yield interval inside the per-token evaluation loop. Sweep ticks
 * over 1000+ tokens were holding the event loop for hundreds of ms, delaying
 * AbortSignal timers behind their deadline. Yielding every 50 tokens keeps
 * loop p99 in baseline range without measurably affecting throughput
 * (one setImmediate hop per 50 token evaluations is cheap).
 */
const EVALUATE_YIELD_BATCH = 50;
const DIRTY_EVALUATION_DELAY_MS = 250;
const FULL_SWEEP_INTERVAL_MS = 60_000;
const NOISY_SUPPRESSION_DEDUPE_MS = 10 * 60 * 1000;
// The suppression cache holds the last NOISY_SUPPRESSION_DEDUPE_MS (10 min)
// of (tokenId, reason) pairs. At the worst observed signal-rate of ~15/sec ×
// 600 s = 9 000 unique keys/window. Cap MUST stay above 9 000: when the map
// exceeds the cap, `pruneSuppressionDedupe` evicts oldest keys even if their
// 10-min window hasn't expired, which would silently shrink the effective
// dedupe window. 10 000 covers worst case with ~10% headroom while keeping
// the worst-case Map ≈ 800 KB instead of ≈ 4 MB (50 000 was 5× over-budget).
const MAX_SUPPRESSION_DEDUPE_KEYS = 10_000;
const DEFAULT_BUY_BUDGET_COOLDOWN_MS = 15 * 60 * 1000;
const WALLET_BUY_BUDGET_EXHAUSTED_REASON = "wallet_buy_budget_exhausted";
const BUY_BUDGET_COOLDOWN_REASONS = new Set([
  WALLET_BUY_BUDGET_EXHAUSTED_REASON,
  WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
]);
const D6_SUPPRESSED_REASON = "d6-suppressed";
const DECISION_RULE_HOLD_REASON = "decision-rule-hold";
// CHANGE B — R67 spec 11.5 dust abandonment risk-event codes (kept colocated
// with other suppression reasons so the dedupe set below can reference them).
const DUST_ABANDONED_REASON = "dust-abandoned";
const DUST_RECOVERED_REASON = "dust-recovered";
// CHANGE A — D8 profit-ratio SELL trigger (R66 spec 14.Y).
const D8_PROFIT_RATIO_RULE_ID = "D8_PROFIT_RATIO";
const POST_BUY_FILL_COOLDOWN_REASON = "post-buy-fill-cooldown";
const DEDUPED_SUPPRESSION_REASONS = new Set([
  "market-cache-miss",
  "mid-price-unavailable",
  "pending-buy-order",
  "market-not-live",
  // continuation-stop is sticky: once a leg fails R1 it fails on every sweep
  // tick (≈1/sec) until the leg clears. Without dedupe, a handful of stuck
  // legs floods decision_signal_log with thousands of identical rows per hour
  // and drowns the genuine signal stream operators look at.
  "continuation-stop",
  // Step 0 §P3 min-age gate: both reasons are sticky on the legState==null
  // path — `market_too_young` repeats every sweep tick (≈1/sec) for up to
  // 2 504 s after first sighting; `market_age_unknown` repeats indefinitely
  // for legacy/null gammaCreatedAt rows. Both must dedupe like other sticky
  // suppressions to keep decision_signal_log readable.
  "market_too_young",
  "market_age_unknown",
  // R37: S2/buyCount>=4 BUY has moderate evidence but is disabled for the
  // $50 live test. This state is sticky across sweep ticks, so dedupe it.
  D6_SUPPRESSED_REASON,
  DECISION_RULE_HOLD_REASON,
  "no_drop_signal",
  SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
  // CHANGE B — abandoned-dust suppression repeats on every sweep tick for
  // the rest of the leg's life unless price-recovery / new BUY clears it.
  // Dedupe so decision_signal_log stays readable.
  DUST_ABANDONED_REASON,
  // order-size-below-minimum (perf-pack pre-filter): a sized leg whose
  // suggestedSize at the current price stays below market.minOrderSize is
  // sticky across sweep ticks (≈1/sec). Without dedupe each such token
  // would write a signal_suppressed row every tick, defeating the very
  // pipeline-volume reduction the pre-filter exists to achieve.
  // Kept per-token rather than added to ENTRY_SWEEP_AGGREGATED_*: below-min
  // is a per-leg pricing/budget condition, not a fleet-wide-unavailable
  // condition, so each token's row preserves a useful diagnostic dimension.
  "order-size-below-minimum",
  // Short-lived exchange settlement timing guard. Deduping keeps clustered
  // SELL-capable legs from writing several identical rows during a 5s window.
  POST_BUY_FILL_COOLDOWN_REASON,
  H5_WIDE_COHORT_GUARD_REASON,
  R23_NO_HISTORY_REASON,
  R23_NO_DIP_REASON,
]);
const ENTRY_SWEEP_AGGREGATED_SUPPRESSION_REASONS = new Set([
  "market-cache-miss",
  "mid-price-unavailable",
  "market-not-live",
  "market_too_young",
  "market_age_unknown",
  DECISION_RULE_HOLD_REASON,
]);

function findBuyBudgetCooldownReason(reason: string): string | null {
  const reasons = reason
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  for (const exactReason of reasons.length > 0 ? reasons : [reason]) {
    if (BUY_BUDGET_COOLDOWN_REASONS.has(exactReason)) return exactReason;
  }
  return null;
}

// Returns the largest plausible BUY order size for the
// `order-size-below-minimum` pre-filter. signal-to-order computes the actual
// size at the resolved execution price (bestBid for edge mode, bestAsk for
// opportunistic taker, anchor-derived for SELL). For BUY, dividing by the
// LOWEST realistic execution price yields the LARGEST possible share count,
// keeping this gate strictly more permissive than downstream: it suppresses
// only signals that cannot be executable under any pricing mode.
function computeBuyOrderSizeForFilter(
  suggestedSizeUsdc: number,
  market: NormalizedMarket,
  fallbackPrice: number,
): number {
  const bestBid = market.bestBid;
  const price =
    typeof bestBid === "number" && Number.isFinite(bestBid) && bestBid > 0
      ? bestBid
      : fallbackPrice;
  return price > 0 ? suggestedSizeUsdc / price : 0;
}

export class AlgoDecisionModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly persistence: DecisionPersistenceBuffer;
  private readonly decisionWorkerPool: DecisionWorkerPool;
  private readonly continuationTradeCountCache: ContinuationTradeCountCache | null;

  // Market cache — updated on every NormalizedMarketUpdated
  private readonly marketCache = new Map<string, NormalizedMarket>();
  private readonly legStateCache = new Map<string, LegState | null>();
  private readonly positionCache = new Map<string, Position | null>();
  private legStateCacheHydrated = false;
  private positionCacheHydrated = false;
  private readonly dirtyTokenIds = new Set<string>();
  private dirtyEvaluationTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFullSweepAt = 0;

  // ADR-022 §D-F — F-telemetry: previous midPrice per token, captured on each
  // NormalizedMarketUpdated BEFORE the cache is updated. Drives
  // `signal_emitted.payload.dropFromLastSeen`. Cleared on token eviction
  // (TrackedMarketsChanged.removedTokenIds) and on inactive markets so the
  // map stays bounded by the watch-set capacity.
  private readonly prevMidPrices = new Map<string, number>();

  // ADR-022 §D-F — F-telemetry: per-tick decisionRuleId histogram for the
  // healthcheck `triggerMix` segment. `lastTickRuleMix` is the snapshot from
  // the most recently completed evaluation pass, exposed read-only via
  // healthCheck; `currentTickRuleMix` is being filled by the in-flight pass
  // and swapped in at its end. Both reset on module restart.
  private lastTickRuleMix = new Map<string, number>();
  private currentTickRuleMix = new Map<string, number>();
  private lastEvalMetrics = createDecisionEvalMetrics();
  private currentEvalMetrics = createDecisionEvalMetrics();
  private lastEvalMetricsEmitAt = 0;
  private readonly decisionLatency = new SlidingLatencyWindow(100);

  // Rules — loaded once on start()
  private decisionRules: readonly AlgoDecisionRule[] = [];
  private buySizeRules: readonly AlgoSizeRule[] = [];
  private sellSizeRules: readonly AlgoSizeRule[] = [];

  // Pending entries — prevents re-signalling while a buy order is in-flight
  private readonly pendingEntries = new Map<string, PendingEntry>(); // tokenId → entry
  private readonly clientOrderToToken = new Map<string, string>(); // clientOrderId → tokenId
  private readonly orderIdToToken = new Map<string, string>(); // orderId → tokenId
  private readonly suppressionDedupe = new Map<string, number>();
  private readonly lastBuyFillByWallet = new Map<string, number>();
  private buyBudgetCooldownUntilMs = 0;
  private buyBudgetSuppressedSignals = 0;
  private buyBudgetRecoveryNotionalUsdc = 0;

  private tickCounter = 0;
  private unsubs: Array<() => void> = [];
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private started = false;
  // Skip-on-overlap guard for evaluateTokens. The same pass can be triggered
  // from `setInterval(sweep)` and from `handleMarketUpdate`/`handleNormalizedMarketUpdated`
  // back-to-back within one tick. Without this gate, market_wide prefetch fan-out
  // multiplies (N concurrent passes × prefetchConcurrency) and starves the
  // event loop — exactly the failure mode that auto-rolled back P8 canary #1.
  // Skipping (rather than queuing) is safe: marketCache is updated synchronously
  // by handlers, and the next sweep tick picks up the new state.
  private evaluating = false;

  // ADR-016 — operator policy + last-seen version for hot-reload.
  private continuationMode: ContinuationMode = "leg_local";
  private continuationModeVersion = -1;

  constructor(private readonly deps: AlgoDecisionModuleDeps) {
    this.log = deps.log.child({ module: "algo-decision" });
    this.persistence = new DecisionPersistenceBuffer(
      {
        decisionSignalLogRepo: deps.decisionSignalLogRepo,
        riskEventRepo: deps.riskEventRepo,
        log: this.log,
      },
      {
        mode: deps.decisionPersistenceMode ?? "sync",
        workerDbPath: deps.decisionPersistenceWorkerDbPath,
      },
    );
    this.decisionWorkerPool = new DecisionWorkerPool({
      workerCount: deps.decisionWorkerCount ?? 0,
      batchSize: deps.decisionWorkerBatchSize ?? 100,
      log: this.log,
    });
    this.continuationTradeCountCache = deps.tradeCountProvider
      ? new ContinuationTradeCountCache({
          provider: deps.tradeCountProvider,
          log: this.log,
        })
      : null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.decisionRules = this.deps.algoRulesRepo.getDecisionRules();
    this.buySizeRules = this.deps.algoRulesRepo.getSizeRules("BUY");
    this.sellSizeRules = this.deps.algoRulesRepo.getSizeRules("SELL");
    this.hydrateDecisionStateCaches();

    // Fail-closed at startup: without a FALLBACK decision rule, evaluateDecision
    // will throw on every sweep once an unmatched state appears. Refuse to
    // start so the operator sees a clean config error rather than a deferred
    // runtime crash.
    if (!this.decisionRules.some((r) => r.ruleId === "FALLBACK")) {
      throw new Error("FALLBACK rule missing from algo_decision_rules — supervisor cannot start");
    }

    this.refreshContinuationMode();
    this.decisionWorkerPool.start();
    this.log.info(
      {
        continuationMode: this.continuationMode,
        continuationModeVersion: Math.max(this.continuationModeVersion, 0),
        tradeCountProviderAttached: !!this.deps.tradeCountProvider,
      },
      "algo-decision continuation_mode loaded",
    );
    if (!this.deps.executionPolicy) {
      this.log.warn(
        "algo-decision execution policy provider missing; policy-gated entry checks disabled",
      );
    }

    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) => this.handleMarketUpdate(p)),
      this.deps.bus.subscribe("TrackedMarketsChanged", (p) => this.handleTrackedMarketsChanged(p)),
      this.deps.bus.subscribe("SignalRejected", (p) => this.handleSignalRejected(p)),
      this.deps.bus.subscribe("SignalConversionSkipped", (p) =>
        this.handleSignalConversionSkipped(p),
      ),
      this.deps.bus.subscribe("PlaceOrderRequested", (p) => this.handlePlaceOrderRequested(p)),
      this.deps.bus.subscribe("OrderPlaced", (p) => this.handleOrderPlaced(p)),
      this.deps.bus.subscribe("FillReceived", (p) => this.handleFillReceived(p)),
      this.deps.bus.subscribe("LegStateUpdated", (p) => this.handleLegStateUpdated(p)),
      this.deps.bus.subscribe("LegStateCleared", (p) => this.handleLegStateCleared(p)),
      this.deps.bus.subscribe("PositionUpdated", (p) => this.handlePositionUpdated(p)),
      this.deps.bus.subscribe("PositionSettled", (p) => this.handlePositionSettled(p)),
      this.deps.bus.subscribe("OrderCancelled", (p) => this.handleOrderCancelled(p)),
      this.deps.bus.subscribe("OrderRejected", (p) => this.handleOrderRejected(p)),
      this.deps.bus.subscribe("OperatorCommandApplied", (p) =>
        this.handleOperatorCommandApplied(p),
      ),
    );

    this.sweepHandle = setInterval(() => {
      this.sweep().catch((err) => this.log.error({ err }, "algo-decision sweep error"));
    }, this.deps.sweepIntervalMs);

    this.started = true;
    this.log.info({ sweepIntervalMs: this.deps.sweepIntervalMs }, "algo-decision module started");
  }

  async stop(): Promise<void> {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
    if (this.dirtyEvaluationTimer) {
      clearTimeout(this.dirtyEvaluationTimer);
      this.dirtyEvaluationTimer = null;
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    await this.persistence.stop();
    await this.decisionWorkerPool.stop();
    this.started = false;
    this.log.info("algo-decision module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.started) return { ok: false, detail: "not started" };
    const persistenceStats = this.persistence.getStats();
    const workerStats = this.decisionWorkerPool.getStats();
    const base =
      `ticks=${this.tickCounter} markets=${this.marketCache.size}` +
      ` dirty=${this.dirtyTokenIds.size} pending=${this.pendingEntries.size}` +
      ` persistenceQueued=${persistenceStats.queued}` +
      ` persistenceDropped=${persistenceStats.droppedWrites}` +
      ` decisionWorkers=${workerStats.workerCount}` +
      ` decisionWorkerInflight=${workerStats.inFlight}` +
      ` decisionWorkerFallbacks=${workerStats.localFallbacks}`;
    // ADR-018 §D2 — append Step 1 universe funnel when the cache supports it.
    const snap = this.deps.selectedMarketCache.getUniverseFilterSnapshot?.();
    const funnel = snap
      ? ` universeFunnel seen=${snap.seen} volumeZeroDropped=${snap.volumeZeroDropped} volumeNullEvaluated=${snap.volumeNullEvaluated} volumePositiveEvaluated=${snap.volumePositiveEvaluated} selectionRuleAdmitted=${snap.selectionRuleAdmitted} selectionRuleRejected=${snap.selectionRuleRejected}`
      : "";
    // ADR-022 §D-F — last-tick decisionRuleId histogram. Empty when no signals
    // emitted on the most recent completed pass; the segment is omitted in
    // that case to keep the line tidy. Sorted by ruleId for stable output.
    const ruleMix = this.formatTriggerMix(this.lastTickRuleMix);
    const evalMetrics = this.formatEvalMetrics(this.lastEvalMetrics);
    return { ok: true, detail: `${base}${funnel}${ruleMix}${evalMetrics}` };
  }

  private formatTriggerMix(mix: ReadonlyMap<string, number>): string {
    if (mix.size === 0) return "";
    const entries = [...mix.entries()].sort(([a], [b]) => a.localeCompare(b));
    const parts = entries.map(([ruleId, count]) => `${ruleId}=${count}`);
    return ` triggerMix ${parts.join(" ")}`;
  }

  private formatEvalMetrics(metrics: DecisionEvalMetrics): string {
    if (metrics.evalTotal === 0) return "";
    const wouldMatch = this.formatWouldMatchRuleMix(metrics.wouldMatchRule);
    return (
      ` eval_total=${metrics.evalTotal}` +
      ` emitted=${metrics.emitted}` +
      ` suppressed_market_not_live=${metrics.suppressedMarketNotLive}` +
      ` drop_checked=${metrics.dropTriggerChecked}` +
      ` drop_passed=${metrics.dropTriggerPassed}` +
      ` r23_checked=${metrics.r23DipChecked}` +
      ` r23_fired=${metrics.r23DipFired}` +
      ` r23_no_history=${metrics.r23NoHistory}` +
      ` r23_no_dip=${metrics.r23NoDip}` +
      ` reject_no_drop_signal=${metrics.rejectNoDropSignal}` +
      ` allow_no_drop_data=${metrics.allowNoDropData}` +
      ` liveness_not_accepting_orders=${metrics.livenessNotAcceptingOrders}` +
      ` liveness_order_book_disabled=${metrics.livenessOrderBookDisabled}` +
      ` liveness_both_flags=${metrics.livenessBothFlags}` +
      wouldMatch
    );
  }

  private formatWouldMatchRuleMix(mix: ReadonlyMap<string, number>): string {
    if (mix.size === 0) return "";
    const entries = [...mix.entries()].sort(([a], [b]) => a.localeCompare(b));
    const parts = entries.map(([ruleId, count]) => `${ruleId}=${count}`);
    return ` wouldMatchRule ${parts.join(" ")}`;
  }

  // ─── Event handlers ─────────────────────────────────────────────────────────

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    if (payload.markets.length === 0) {
      await this.evaluateTokens([]);
      return;
    }
    for (const market of payload.markets) {
      const tokenIdStr = String(market.tokenId);
      if (!market.active) {
        this.marketCache.delete(tokenIdStr);
        this.prevMidPrices.delete(tokenIdStr);
      } else {
        // ADR-022 §D-F — capture the immediately previous midPrice into
        // prevMidPrices BEFORE replacing the cache entry, so the next signal
        // emission can compute `dropFromLastSeen` against the second-latest
        // observation. If the prior update had no midPrice, clear the slot —
        // ADR-022 defines the reference as the IMMEDIATELY previous update,
        // not the last non-null sample, so a null gap resets the delta.
        const prior = this.marketCache.get(tokenIdStr);
        if (prior?.midPrice != null) {
          this.prevMidPrices.set(tokenIdStr, prior.midPrice);
        } else {
          this.prevMidPrices.delete(tokenIdStr);
        }
        this.marketCache.set(tokenIdStr, market);
        this.deps.priceHistoryProvider?.observeMarket?.(market);
      }
    }
    for (const market of payload.markets) {
      if (market.active) this.markDirty(market.tokenId);
    }
    if (this.deps.deferMarketUpdateEvaluation) {
      this.scheduleDirtyEvaluation();
    } else {
      await this.evaluateDirtyTokens();
    }
  }

  private async handleTrackedMarketsChanged(
    payload: RuntimeEventMap["TrackedMarketsChanged"],
  ): Promise<void> {
    // Tokens leaving the tracked universe never get a final NormalizedMarketUpdated
    // delivery, so marketCache would retain them forever. Evict on scanner churn.
    for (const tokenId of payload.removedTokenIds) {
      const tokenIdStr = String(tokenId);
      this.marketCache.delete(tokenIdStr);
      this.prevMidPrices.delete(tokenIdStr);
      this.dirtyTokenIds.delete(tokenIdStr);
      this.legStateCache.delete(tokenIdStr);
      this.positionCache.delete(tokenIdStr);
    }
    for (const tokenId of payload.addedTokenIds) {
      this.markDirty(tokenId);
    }
  }

  private async handleOrderPlaced(payload: RuntimeEventMap["OrderPlaced"]): Promise<void> {
    if (payload.side !== "buy") return;
    const tokenId = String(payload.tokenId);
    const existing = this.pendingEntries.get(tokenId);
    if (!existing) return;
    existing.clientOrderId = String(payload.clientOrderId);
    existing.orderId = String(payload.orderId);
    this.clientOrderToToken.set(existing.clientOrderId, tokenId);
    this.orderIdToToken.set(existing.orderId, tokenId);
  }

  private async handlePlaceOrderRequested(
    payload: RuntimeEventMap["PlaceOrderRequested"],
  ): Promise<void> {
    if (payload.command.side !== "buy") return;
    const tokenId = String(payload.command.tokenId);
    const existing = this.pendingEntries.get(tokenId);
    if (!existing) return;
    existing.clientOrderId = String(payload.command.clientOrderId);
    this.clientOrderToToken.set(existing.clientOrderId, tokenId);
  }

  private async handleFillReceived(payload: RuntimeEventMap["FillReceived"]): Promise<void> {
    const tokenId = String(payload.tokenId);
    this.clearPendingByTokenId(tokenId);
    this.markDirty(payload.tokenId);
    this.scheduleDirtyEvaluation(0);
    if (payload.side !== "buy") return;
    this.lastBuyFillByWallet.set(this.walletCooldownKey(), this.normalizeEventTimestamp(payload));
  }

  private async handleLegStateUpdated(payload: RuntimeEventMap["LegStateUpdated"]): Promise<void> {
    const tokenId = String(payload.legState.tokenId);
    this.legStateCache.set(tokenId, payload.legState);
    this.markDirty(payload.legState.tokenId);
    this.scheduleDirtyEvaluation(0);
  }

  private async handleLegStateCleared(payload: RuntimeEventMap["LegStateCleared"]): Promise<void> {
    const tokenId = String(payload.tokenId);
    this.legStateCache.delete(tokenId);
    this.positionCache.delete(tokenId);
    this.dirtyTokenIds.delete(tokenId);
  }

  private async handlePositionUpdated(payload: RuntimeEventMap["PositionUpdated"]): Promise<void> {
    const tokenId = String(payload.position.tokenId);
    if (payload.position.status === "closed" || payload.position.size <= 0) {
      this.legStateCache.delete(tokenId);
      this.positionCache.delete(tokenId);
      this.dirtyTokenIds.delete(tokenId);
      return;
    }
    this.positionCache.set(tokenId, payload.position);
    this.markDirty(payload.position.tokenId);
    this.scheduleDirtyEvaluation(0);
  }

  private async handlePositionSettled(payload: RuntimeEventMap["PositionSettled"]): Promise<void> {
    const tokenId = String(payload.tokenId);
    this.legStateCache.delete(tokenId);
    this.positionCache.delete(tokenId);
    this.dirtyTokenIds.delete(tokenId);
  }

  private walletCooldownKey(): string {
    // Runtime process owns one configured trading wallet/profile; keep the map
    // shape so multi-wallet runtimes can supply a real key without changing
    // suppression semantics.
    return "default";
  }

  private normalizeEventTimestamp(payload: RuntimeEventMap["FillReceived"]): number {
    return Number.isFinite(payload.timestamp) && payload.timestamp > 0
      ? payload.timestamp
      : Date.now();
  }

  private getPostBuyFillSellCooldown(
    now: number,
    executionPolicy: ExecutionPolicy | null = this.deps.executionPolicy?.() ?? null,
  ): {
    cooldownMs: number;
    ageMs: number;
    lastBuyFillAt: number;
  } | null {
    const cooldownMs = executionPolicy?.postBuyFillSellCooldownMs ?? 0;
    if (cooldownMs <= 0 || !Number.isFinite(cooldownMs)) return null;

    const lastBuyFillAt = this.lastBuyFillByWallet.get(this.walletCooldownKey());
    if (lastBuyFillAt == null) return null;
    const ageMs = Math.max(0, now - lastBuyFillAt);
    if (ageMs >= cooldownMs) return null;
    return { cooldownMs, ageMs, lastBuyFillAt };
  }

  private async handleSignalRejected(payload: RuntimeEventMap["SignalRejected"]): Promise<void> {
    const reasonCode = findBuyBudgetCooldownReason(payload.reason);
    if (payload.signal.side === "buy" && reasonCode) {
      this.activateBuyBudgetCooldown(
        payload.signal,
        payload.rejectedAt,
        "risk_rejection",
        reasonCode,
      );
    }
    this.clearPendingByTokenId(String(payload.signal.tokenId));
    this.markDirty(payload.signal.tokenId);
    this.scheduleDirtyEvaluation(0);
  }

  private async handleSignalConversionSkipped(
    payload: RuntimeEventMap["SignalConversionSkipped"],
  ): Promise<void> {
    this.clearPendingByTokenId(String(payload.signal.tokenId));
    this.markDirty(payload.signal.tokenId);
    this.scheduleDirtyEvaluation(0);
  }

  private async handleOrderCancelled(payload: RuntimeEventMap["OrderCancelled"]): Promise<void> {
    const orderId = String(payload.orderId);
    const tokenId = this.orderIdToToken.get(orderId);
    if (tokenId) {
      this.clearPendingByTokenId(tokenId);
      this.markDirty(tokenId as TokenId);
      this.scheduleDirtyEvaluation(0);
    }
  }

  private async handleOrderRejected(payload: RuntimeEventMap["OrderRejected"]): Promise<void> {
    const clientOrderId = String(payload.clientOrderId);
    const tokenId = this.clientOrderToToken.get(clientOrderId);
    if (tokenId) {
      this.clearPendingByTokenId(tokenId);
      this.markDirty(tokenId as TokenId);
      this.scheduleDirtyEvaluation(0);
    }
  }

  private async handleOperatorCommandApplied(
    payload: RuntimeEventMap["OperatorCommandApplied"],
  ): Promise<void> {
    if (payload.action !== "resume") return;
    await this.evaluateDirtyTokens();
  }

  // ─── Sweep ─────────────────────────────────────────────────────────────────

  /**
   * ADR-016: hot-reload `continuation_mode` from `runtime_control_state`.
   * Cheap version-poll first; only re-reads the mode column when the version
   * has bumped. Errors and missing columns degrade silently to `leg_local`
   * via `readContinuationMode/Version`'s try/catch.
   *
   * Tests pass a structural `prepare(...).get(...)` mock; production wires the
   * real `Database`, so the cast only bridges the narrow dependency type.
   */
  private refreshContinuationMode(): void {
    if (!this.deps.controlDb) return;
    const db = this.deps.controlDb as unknown as Database.Database;
    const newVersion = readContinuationModeVersion(db);
    if (newVersion === this.continuationModeVersion) return;
    const newMode = readContinuationMode(db);
    const previous = this.continuationMode;
    this.continuationMode = newMode;
    this.continuationModeVersion = newVersion;
    if (previous !== newMode && this.started) {
      this.log.info(
        { previous, current: newMode, version: newVersion },
        "continuation_mode_changed",
      );
    }
  }

  private hydrateDecisionStateCaches(): void {
    try {
      const canHydrateLegStates = typeof this.deps.legStateRepo.getAll === "function";
      const legStates = canHydrateLegStates ? this.deps.legStateRepo.getAll() : [];
      this.legStateCache.clear();
      for (const state of legStates) {
        this.legStateCache.set(String(state.tokenId), state);
      }
      this.legStateCacheHydrated = canHydrateLegStates;
      if (canHydrateLegStates) {
        this.log.info({ count: legStates.length }, "algo-decision leg state cache hydrated");
      }
    } catch (err) {
      this.legStateCacheHydrated = false;
      this.log.warn({ err }, "algo-decision leg state cache hydration failed");
    }

    try {
      const canHydratePositions = typeof this.deps.positionRepo?.findOpen === "function";
      const positions = canHydratePositions ? this.deps.positionRepo!.findOpen() : [];
      this.positionCache.clear();
      for (const position of positions) {
        this.positionCache.set(String(position.tokenId), position);
      }
      this.positionCacheHydrated = canHydratePositions;
      if (canHydratePositions) {
        this.log.info({ count: positions.length }, "algo-decision position cache hydrated");
      }
    } catch (err) {
      this.positionCacheHydrated = false;
      this.log.warn({ err }, "algo-decision position cache hydration failed");
    }
  }

  /** Prune stale pending entries and evaluate all eligible tokens. */
  async sweep(): Promise<void> {
    if (this.isPaused()) return;
    this.pruneExpiredPending();

    const now = Date.now();
    if (now - this.lastFullSweepAt >= FULL_SWEEP_INTERVAL_MS) {
      this.lastFullSweepAt = now;
      this.markFullSweepDirty();
    }
    await this.evaluateDirtyTokens();
  }

  private markFullSweepDirty(): void {
    const legStateTokenIds = new Set(
      [...this.legStateCache.entries()]
        .filter(([, state]) => state != null)
        .map(([tokenId]) => tokenId),
    );
    const eligibleTokenIds = this.deps.selectedMarketCache.getEligibleTokenIds();
    const eligibleSet = new Set(eligibleTokenIds.map(String));

    for (const tokenId of new Set([...legStateTokenIds, ...eligibleSet])) {
      this.dirtyTokenIds.add(tokenId);
    }
  }

  private markDirty(tokenId: TokenId | string): void {
    this.dirtyTokenIds.add(String(tokenId));
  }

  private scheduleDirtyEvaluation(delayMs = DIRTY_EVALUATION_DELAY_MS): void {
    if (this.dirtyEvaluationTimer !== null) return;
    this.dirtyEvaluationTimer = setTimeout(() => {
      this.dirtyEvaluationTimer = null;
      void this.evaluateDirtyTokens().catch((err) =>
        this.log.error({ err }, "algo-decision dirty evaluation error"),
      );
    }, delayMs);
  }

  private async evaluateDirtyTokens(): Promise<void> {
    if (this.isPaused()) return;
    if (this.evaluating) {
      this.scheduleDirtyEvaluation();
      return;
    }
    if (this.dirtyTokenIds.size === 0) return;
    const tokenIds = [...this.dirtyTokenIds] as TokenId[];
    this.dirtyTokenIds.clear();
    await this.evaluateTokens(tokenIds);
    if (this.dirtyTokenIds.size > 0) this.scheduleDirtyEvaluation();
  }

  // ─── Core evaluation ────────────────────────────────────────────────────────

  /** Evaluate a list of token IDs in one pass and emit CLOB trading signals. */
  async evaluateTokens(tokenIds: readonly TokenId[]): Promise<void> {
    if (this.isPaused()) return;
    if (this.evaluating) return;
    const startedAt = Date.now();
    this.evaluating = true;
    try {
      await this.evaluateTokensInner(tokenIds);
    } finally {
      this.decisionLatency.record(Date.now() - startedAt);
      this.evaluating = false;
      this.emitEvalMetricsSnapshot(Date.now());
    }
  }

  private async evaluateTokensInner(tokenIds: readonly TokenId[]): Promise<void> {
    this.refreshContinuationMode();
    this.tickCounter++;
    // ADR-022 §D-F — start a fresh in-flight histogram for this sweep.
    // The completed histogram is promoted into `lastTickRuleMix` at the END
    // of the sweep (see below), so healthcheck always reflects the most
    // recently completed pass rather than the one before it.
    this.currentTickRuleMix = new Map<string, number>();
    this.currentEvalMetrics = createDecisionEvalMetrics();
    const now = Date.now();

    // seqMap tracks sequence numbers: `${tokenId}|${side}` → next seq
    const seqMap = new Map<string, number>();
    const nextSeq = (key: string): number => {
      const n = seqMap.get(key) ?? 0;
      seqMap.set(key, n + 1);
      return n;
    };

    // ADR-016: in `market_wide` mode, batch-warm the trade-count cache for
    // all tokens that already have a leg (continuation gate is the only
    // consumer). Serial cache-misses inside the per-token loop would stack
    // ~75ms × N latency on the sweep; one parallel prefetch collapses it.
    const executionPolicy = this.deps.executionPolicy?.() ?? null;
    const postBuyCooldown = this.getPostBuyFillSellCooldown(now, executionPolicy);
    this.scheduleContinuationTradeCounts(tokenIds);
    await Promise.resolve();
    if (this.isPaused()) return;

    const inputs: DecisionPlanningInput[] = [];
    let processed = 0;
    for (const tokenId of tokenIds) {
      if (this.isPaused()) return;
      if (processed > 0 && processed % EVALUATE_YIELD_BATCH === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.isPaused()) return;
      }
      processed++;
      const input = await this.createDecisionPlanningInput(
        String(tokenId) as TokenId,
        now,
        executionPolicy,
        postBuyCooldown,
      );
      if (input) inputs.push(input);
    }

    const plans = await this.decisionWorkerPool.evaluate(inputs);
    for (const plan of plans) {
      if (this.isPaused()) return;
      this.applyDecisionMetricsDelta(plan.metrics);
      this.applyDecisionPlanSideEffects(plan.sideEffects, executionPolicy);
      for (const suppression of plan.suppressions) {
        this.recordDecisionSuppressed(suppression as SuppressionFacts);
      }
      if (plan.type !== "signal") continue;
      const result = this.materializeSignalDraft(plan.signal, now, nextSeq);
      if (result.signal.side === "buy") {
        if (this.shouldSuppressBuyForBudget(result.signal, now)) continue;
        if (this.isPaused()) return;
        this.reservePendingSignal(result.signal, now);
      }
      // Persist decision_signal_log / signal_emitted only after the
      // operational BUY-budget circuit breaker keeps the signal. RiskInventory
      // still owns final order-risk rejection; this prevents known-impossible
      // empty-wallet BUY candidates from flooding telemetry before Risk sees
      // the first rejection.
      this.currentEvalMetrics.emitted++;
      result.commitLog();
      if (this.isPaused()) return;
      await this.deps.bus.publish("SignalProduced", {
        signal: result.signal,
        market: result.market,
      });
    }

    // ADR-022 §D-F — promote the just-completed histogram so healthcheck
    // immediately reflects this sweep, not the previous one.
    this.lastTickRuleMix = this.currentTickRuleMix;
    this.lastEvalMetrics = this.currentEvalMetrics;
  }

  private async createDecisionPlanningInput(
    tokenId: TokenId,
    now: number,
    executionPolicy: ExecutionPolicy | null,
    postBuyCooldown: { cooldownMs: number; ageMs: number; lastBuyFillAt: number } | null,
  ): Promise<DecisionPlanningInput | null> {
    const legState = this.getCachedLegState(tokenId);
    const selectedForEntry = this.deps.selectedMarketCache.isEligible(tokenId);
    if (!legState && !selectedForEntry) return null;

    const market = this.marketCache.get(String(tokenId)) ?? null;
    const prevMidPrice = this.prevMidPrices.get(String(tokenId)) ?? null;
    const position = legState ? this.getCachedPosition(tokenId) : null;
    const continuationFacts =
      legState && market ? await this.resolveContinuationFactsForPlanner(market, legState) : null;
    const r23MaxMidpoint =
      !legState &&
      market?.midPrice != null &&
      executionPolicy?.r23DipTrigger?.enabled &&
      this.deps.priceHistoryProvider?.maxMidpointInWindow
        ? this.deps.priceHistoryProvider.maxMidpointInWindow(
            tokenId,
            executionPolicy.r23DipTrigger.windowMs,
            now,
          )
        : null;
    const dropReferencePrice =
      legState &&
      executionPolicy?.dropTrigger?.enabled &&
      this.deps.priceHistoryProvider?.findReferencePrice
        ? this.deps.priceHistoryProvider.findReferencePrice(
            tokenId,
            now - executionPolicy.dropTrigger.lookbackMs,
            executionPolicy.dropTrigger.historyMaxAgeMs,
          )
        : null;

    return {
      tokenId,
      now,
      selectedForEntry,
      hasPendingBuyOrder: this.pendingEntries.has(String(tokenId)),
      legState,
      position,
      market,
      prevMidPrice,
      decisionRules: this.decisionRules,
      buySizeRules: this.buySizeRules,
      sellSizeRules: this.sellSizeRules,
      executionPolicy,
      continuationFacts,
      continuationMode: this.continuationMode,
      r23MaxMidpoint,
      dropReferencePrice,
      postBuyCooldown,
    };
  }

  private async resolveContinuationFactsForPlanner(
    market: NormalizedMarket,
    legState: LegState,
  ): Promise<ContinuationFacts | null> {
    const legLocalCount = (legState.buyCount ?? 0) + (legState.sellCount ?? 0);
    const { count, source } = this.resolveContinuationTradeCount(
      market.conditionId as ConditionId,
      legLocalCount,
    );
    return {
      tradeCount: count,
      tradeCountSource: source,
      stop: !evaluateContinuation(count, legState.firstTradePrice),
    };
  }

  private applyDecisionMetricsDelta(delta: DecisionMetricsDelta): void {
    const metrics = this.currentEvalMetrics;
    metrics.evalTotal += delta.evalTotal;
    metrics.suppressedMarketNotLive += delta.suppressedMarketNotLive;
    metrics.dropTriggerChecked += delta.dropTriggerChecked;
    metrics.dropTriggerPassed += delta.dropTriggerPassed;
    metrics.r23DipChecked += delta.r23DipChecked;
    metrics.r23DipFired += delta.r23DipFired;
    metrics.r23NoHistory += delta.r23NoHistory;
    metrics.r23NoDip += delta.r23NoDip;
    metrics.rejectNoDropSignal += delta.rejectNoDropSignal;
    metrics.allowNoDropData += delta.allowNoDropData;
    metrics.livenessNotAcceptingOrders += delta.livenessNotAcceptingOrders;
    metrics.livenessOrderBookDisabled += delta.livenessOrderBookDisabled;
    metrics.livenessBothFlags += delta.livenessBothFlags;
    for (const [ruleId, count] of Object.entries(delta.wouldMatchRule)) {
      metrics.wouldMatchRule.set(ruleId, (metrics.wouldMatchRule.get(ruleId) ?? 0) + count);
    }
  }

  private applyDecisionPlanSideEffects(
    sideEffects: readonly DecisionPlanSideEffect[],
    executionPolicy: ExecutionPolicy | null,
  ): void {
    for (const sideEffect of sideEffects) {
      if (sideEffect.kind === "dust_recovered") {
        try {
          this.deps.legStateRepo.resetAbandoned(sideEffect.tokenId, sideEffect.timestamp);
          this.invalidateDecisionState(String(sideEffect.tokenId));
          this.persistence.enqueueRiskEvent({
            eventType: "signal_suppressed",
            payload: {
              tokenId: String(sideEffect.tokenId),
              conditionId: sideEffect.conditionId,
              reasonCode: DUST_RECOVERED_REASON,
              recoverySource: "price-recovery",
              currentPrice: sideEffect.currentPrice,
              abandonedAtPrice: sideEffect.abandonedAtPrice,
              signalTimestamp: sideEffect.timestamp,
            },
          });
        } catch (err) {
          this.deps.log.warn(
            { err, tokenId: String(sideEffect.tokenId) },
            "failed to persist dust-recovered transition (continuing evaluation)",
          );
        }
        continue;
      }
      if (sideEffect.kind === "sell_residual_reject") {
        if (!executionPolicy?.dustAbandonment.enabled) continue;
        const { count, markedAbandoned } = this.deps.legStateRepo.incrementSellResidualReject(
          sideEffect.tokenId,
          sideEffect.timestamp,
          { threshold: sideEffect.threshold, price: sideEffect.price },
        );
        this.invalidateDecisionState(String(sideEffect.tokenId));
        if (markedAbandoned) {
          this.persistence.enqueueRiskEvent({
            eventType: "signal_suppressed",
            payload: {
              tokenId: String(sideEffect.tokenId),
              conditionId: sideEffect.conditionId,
              reasonCode: DUST_ABANDONED_REASON,
              consecutiveRejects: count,
              abandonedAtPrice: sideEffect.price,
              signalTimestamp: sideEffect.timestamp,
            },
          });
        }
      }
    }
  }

  private materializeSignalDraft(
    draft: DecisionSignalDraft,
    now: number,
    nextSeq: (key: string) => number,
  ): NonNullable<TokenEvalResult> {
    const sequenceInTick = nextSeq(`${draft.market.tokenId}|${draft.side}`);
    const generatedAt = new Date(now).toISOString();
    const signal: import("@krabs/domain").Signal = {
      signalId: randomUUID(),
      tokenId: draft.market.tokenId,
      conditionId: draft.market.conditionId as ConditionId,
      side: draft.side,
      suggestedPrice: draft.suggestedPrice,
      suggestedSize: draft.suggestedSize,
      suggestedSizeUsdc: draft.suggestedSizeUsdc,
      reason: draft.reason,
      strategyTick: now,
      sequenceInTick,
      decisionRuleId: draft.decisionRuleId,
      sizingRuleId: draft.sizingRuleId,
      generatedAt,
    };
    return {
      type: "signal",
      signal,
      market: draft.market,
      commitLog: () => {
        this.recordDecisionSignal(
          {
            ...draft.logDraft,
            signalId: signal.signalId,
            tokenId: signal.tokenId,
            conditionId: signal.conditionId,
            signalTimestamp: generatedAt,
          },
          draft.emissionFacts,
          draft.triggerTelemetry,
        );
      },
    };
  }

  private emitEvalMetricsSnapshot(now: number): void {
    const sink = this.deps.evalMetricsSink;
    if (!sink) return;
    const intervalMs = this.deps.evalMetricsEmitIntervalMs ?? 60_000;
    if (now - this.lastEvalMetricsEmitAt < intervalMs) return;
    this.lastEvalMetricsEmitAt = now;
    sink({
      evalTotal: this.lastEvalMetrics.evalTotal,
      emitted: this.lastEvalMetrics.emitted,
      suppressedMarketNotLive: this.lastEvalMetrics.suppressedMarketNotLive,
      dropTriggerChecked: this.lastEvalMetrics.dropTriggerChecked,
      dropTriggerPassed: this.lastEvalMetrics.dropTriggerPassed,
      r23DipChecked: this.lastEvalMetrics.r23DipChecked,
      r23DipFired: this.lastEvalMetrics.r23DipFired,
      r23NoHistory: this.lastEvalMetrics.r23NoHistory,
      r23NoDip: this.lastEvalMetrics.r23NoDip,
      rejectNoDropSignal: this.lastEvalMetrics.rejectNoDropSignal,
      allowNoDropData: this.lastEvalMetrics.allowNoDropData,
      livenessNotAcceptingOrders: this.lastEvalMetrics.livenessNotAcceptingOrders,
      livenessOrderBookDisabled: this.lastEvalMetrics.livenessOrderBookDisabled,
      livenessBothFlags: this.lastEvalMetrics.livenessBothFlags,
      wouldMatchRule: Object.fromEntries(this.lastEvalMetrics.wouldMatchRule),
      decisionTickLatency: this.decisionLatency.snapshot(),
      r23Cache: this.deps.priceHistoryProvider?.getWindowMaxCacheMetrics?.() ?? null,
      capturedAt: new Date(now).toISOString(),
    });
  }

  /**
   * Batch-warm the continuation trade-count cache for tokens with an open leg.
   * Tokens without a leg never reach the continuation gate, so we skip them.
   * `prefetch` is optional on the interface; if absent we fall back to per-token
   * `countTrades` calls inside `evaluateToken` (cache will still help on
   * subsequent ticks within the TTL).
   */
  private scheduleContinuationTradeCounts(tokenIds: readonly TokenId[]): void {
    if (this.continuationMode !== "market_wide") return;
    const cache = this.continuationTradeCountCache;
    if (!cache) return;

    const conditionIds: ConditionId[] = [];
    const seen = new Set<string>();
    for (const tokenId of tokenIds) {
      const ls = this.getCachedLegState(tokenId);
      if (!ls) continue;
      const market = this.marketCache.get(String(tokenId));
      if (!market) continue;
      const cid = market.conditionId as ConditionId;
      if (seen.has(cid)) continue;
      seen.add(cid);
      conditionIds.push(cid);
    }
    if (conditionIds.length === 0) return;
    cache.schedule(conditionIds, CONTINUATION_TRADE_COUNT_CAP);
  }

  /**
   * ADR-016: resolve `trade_count` for the continuation gate. In `market_wide`
   * mode, consult the provider; null returns degrade to leg-local under D1.
   * In `leg_local` mode (or when no provider is wired), use the legacy
   * per-leg `buyCount + sellCount`. The chosen source is returned so
   * suppression telemetry can flag fallback paths for the operator.
   */
  private resolveContinuationTradeCount(
    conditionId: ConditionId,
    legLocalCount: number,
  ): { count: number; source: TradeCountSource } {
    if (this.continuationMode === "leg_local" || !this.continuationTradeCountCache) {
      return { count: legLocalCount, source: "leg_local" };
    }
    const fetched = this.continuationTradeCountCache.read(
      conditionId,
      CONTINUATION_TRADE_COUNT_CAP,
    );
    if (fetched === undefined) {
      this.continuationTradeCountCache.schedule([conditionId], CONTINUATION_TRADE_COUNT_CAP);
      return { count: legLocalCount, source: "leg_local_fallback" };
    }
    if (fetched === null) {
      return { count: legLocalCount, source: "leg_local_fallback" };
    }
    return { count: fetched, source: "market_wide" };
  }

  /** Evaluate a single token. Returns a signal, redeem, or null. */
  private async evaluateToken(
    tokenId: TokenId,
    now: number,
    nextSeq: (key: string) => number,
  ): Promise<TokenEvalResult> {
    const legState = this.getCachedLegState(tokenId);
    const selectedForEntry = this.deps.selectedMarketCache.isEligible(tokenId);

    // Avoid emitting suppression telemetry for the full unselected market
    // universe delivered by NormalizedMarketUpdated; it is selection-layer noise.
    if (!legState && !selectedForEntry) return null;
    this.currentEvalMetrics.evalTotal++;

    const state = deriveState(legState);
    const buyCount = legState?.buyCount ?? 0;
    const position = legState ? this.getCachedPosition(tokenId) : null;
    const emissionFacts: EmissionFacts = {
      firstTradePrice: legState?.firstTradePrice ?? null,
      firstTradeAt: legState?.firstTradeAt ?? null,
      legTradeCount: (legState?.buyCount ?? 0) + (legState?.sellCount ?? 0),
      sellCountAtEmit: legState?.sellCount ?? null,
      cumulativeBuySize: legState?.cumulativeBuySize ?? null,
      cumulativeBuyNotional: legState?.cumulativeBuyNotional ?? null,
      cumulativeSellSize: legState?.cumulativeSellSize ?? null,
      currentAvgEntryPrice: position?.avgEntryPrice ?? null,
    };
    const timeSinceLastSeconds = legState
      ? (now - new Date(legState.lastTradeAt).getTime()) / 1000
      : null;

    const market = this.marketCache.get(String(tokenId));
    if (!market) {
      this.recordDecisionSuppressed({
        tokenId,
        conditionId: null,
        reasonCode: "market-cache-miss",
        state,
        price: null,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: new Date(now).toISOString(),
      });
      return null;
    }

    const price = market.midPrice;
    if (price === null || price === undefined) {
      this.recordDecisionSuppressed({
        tokenId,
        conditionId: market.conditionId,
        reasonCode: "mid-price-unavailable",
        state,
        price: null,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: new Date(now).toISOString(),
      });
      return null;
    }

    // CHANGE B — R67 spec 11.5 dust abandonment. Re-engagement for an
    // abandoned token happens only through price recovery, a later BUY fill
    // (handled in update-leg-state-for-fill), or manual reset.
    if (legState && isAbandoned(legState) && this.deps.executionPolicy) {
      const dustPolicy = this.deps.executionPolicy().dustAbandonment;
      if (dustPolicy.enabled) {
        if (shouldRecoverFromPriceMove(legState, price, dustPolicy)) {
          const nowIso = new Date(now).toISOString();
          try {
            this.deps.legStateRepo.resetAbandoned(tokenId, nowIso);
            this.invalidateDecisionState(String(tokenId));
            this.persistence.enqueueRiskEvent({
              eventType: "signal_suppressed",
              payload: {
                tokenId: String(tokenId),
                conditionId: market.conditionId,
                reasonCode: DUST_RECOVERED_REASON,
                recoverySource: "price-recovery",
                currentPrice: price,
                abandonedAtPrice: legState.abandonedAtPrice ?? null,
                signalTimestamp: nowIso,
              },
            });
          } catch (err) {
            this.deps.log.warn(
              { err, tokenId: String(tokenId) },
              "failed to persist dust-recovered transition (continuing evaluation)",
            );
          }
          // Recovery clears the flag for the rest of this tick; continue
          // evaluation normally so D2/D4/D5/D7/D8 see a healthy leg.
        } else {
          this.recordDecisionSuppressed({
            tokenId,
            conditionId: market.conditionId,
            reasonCode: DUST_ABANDONED_REASON,
            side: null,
            state,
            price,
            buyCount,
            timeSinceLastSeconds,
            emissionFacts,
            timestamp: new Date(now).toISOString(),
          });
          return null;
        }
      }
    }

    // ADR-022 §D-F — F-telemetry derived facts. `prevMidPrices` is populated
    // in `handleMarketUpdate` BEFORE the cache is replaced, so at this point
    // it holds the second-latest midPrice for this token (or is empty on the
    // first observation, yielding `dropFromLastSeen=null`). Sign convention:
    // negative = price went down, positive = price went up.
    const prevMid = this.prevMidPrices.get(String(tokenId));
    const dropFromLastSeen = prevMid != null && prevMid > 0 ? (price - prevMid) / prevMid : null;
    const triggerTelemetry: TriggerTelemetry = {
      dropFromLastSeen,
      entryPriceBucket: classifyEntryPriceBucket(price),
      dropTriggerStatus: "disabled",
      dropTriggerPct: null,
    };

    // Skip tokens that already have a pending buy order in-flight
    if (!legState && this.pendingEntries.has(String(tokenId))) {
      this.recordDecisionSuppressed({
        tokenId,
        conditionId: market.conditionId,
        reasonCode: "pending-buy-order",
        side: "BUY",
        state,
        price,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: new Date(now).toISOString(),
      });
      return null;
    }

    const holdDurationSeconds = legState
      ? (now - new Date(legState.firstTradeAt).getTime()) / 1000
      : null;

    const ctx: EvalContext = {
      state,
      price,
      timeSinceLastSeconds,
      buyCount,
      holdDurationSeconds,
    };

    // Hard-liveness gate for CLOB signals. Real-resolution REDEEM is handled
    // by Resolution/Reconciliation outside this module. BUY/SELL signals
    // traverse the signal-to-order bridge, which calls this same `isAlive` and
    // rejects regardless of side. Suppress here to eliminate allocation churn
    // from producing signals the bridge will reject anyway. Shared `isAlive`
    // keeps the two gates in lockstep so they can't drift.
    const liveness = isAlive(market);
    if (!liveness.healthy) {
      this.recordLivenessSuppressedMetric(liveness.reasons, ctx);
      this.recordDecisionSuppressed({
        tokenId,
        conditionId: market.conditionId,
        reasonCode: "market-not-live",
        reasons: liveness.reasons,
        state,
        price,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: new Date(now).toISOString(),
      });
      return null;
    }

    // Step 0 §P3 — min-age gate. Fires only on the first-BUY branch
    // (`legState == null`). SELL / REDEEM / scale-in continuation must NOT be
    // suppressed for "too young" — by the time those decisions are reachable
    // the market has already been entered and the spec floor is moot.
    // Threshold = 0 ⇒ full bypass (simulation profile + fixture tests).
    if (!legState && this.deps.executionPolicy) {
      const policy = this.deps.executionPolicy();
      const ageResult = evaluateMinMarketAge({
        gammaCreatedAt: market.gammaCreatedAt ?? null,
        thresholdSeconds: policy.entryMinMarketAgeSeconds,
        nowMs: now,
      });
      if (!ageResult.ok) {
        this.recordDecisionSuppressed({
          tokenId,
          conditionId: market.conditionId,
          reasonCode: ageResult.reasonCode,
          side: "BUY",
          state,
          price,
          buyCount,
          timeSinceLastSeconds,
          emissionFacts,
          timestamp: new Date(now).toISOString(),
        });
        return null;
      }
    }

    // Preserved-for-lifecycle gate: market has an open leg but the CLOB no
    // longer accepts new entries (tradable=false). Per spec v2.2 §0 the
    // pre-entry filter is a NEW-BUY gate — preserved markets only emit SELL.
    // Keyed directly on market.tradable, not !isEligible(...), so unrelated
    // eligibility reasons (slug mismatch, etc.) do not force SELL-only.
    const preservedOnly = legState !== null && !market.tradable;

    // CHANGE A — D8_PROFIT_RATIO data-derived SELL trigger per R66 spec 14.Y.
    // Evaluated BEFORE continuation-stop / preserved-only / evaluateDecision so
    // a profit-take exit fires regardless of those gates. Hard-coded path (not
    // in decisionRules) because the threshold is a function of avg_buy_price;
    // AlgoDecisionRule.priceOperator cannot express dynamic thresholds.
    // avg_buy_price derived on the fly from cumulative_buy_notional /
    // cumulative_buy_size (migration 050) — no new column needed. Fires in S1/S2.
    if (legState && this.deps.executionPolicy) {
      const profitTargetPolicy = this.deps.executionPolicy().profitTarget;
      const d8 = evaluateD8ProfitRatio(
        {
          state,
          sellCount: legState.sellCount ?? 0,
          currentPrice: price,
          cumulativeBuySize: legState.cumulativeBuySize ?? 0,
          cumulativeBuyNotional: legState.cumulativeBuyNotional ?? 0,
          holdDurationSeconds,
        },
        profitTargetPolicy,
      );
      if (d8.fire) {
        const d8EmissionFacts: EmissionFacts = {
          ...emissionFacts,
          d8ProfitRatio: d8.profitRatio,
          d8Threshold: d8.threshold,
          d8AvgBuyPrice: d8.avgBuyPrice,
        };
        return this.buildSignalOrSuppressSellResidual(
          market,
          { action: "SELL", ruleId: D8_PROFIT_RATIO_RULE_ID },
          ctx,
          buyCount,
          now,
          nextSeq,
          d8EmissionFacts,
          triggerTelemetry,
          position,
        );
      }
    }

    // D9_LOSS_EXIT — R96 liquidity-aware loss exit. Evaluated after D8 so
    // profitable exits keep priority, but before static D-rules so D6 HOLD
    // cannot suppress a Plankton-mirror loss cut.
    if (legState && this.deps.executionPolicy) {
      const lossExitPolicy = this.deps.executionPolicy().lossExit;
      if (lossExitPolicy?.enabled) {
        const d9DaysToResolve = resolveDaysToResolve(market.endDate, now);
        const d9 = evaluateD9LossExit(
          {
            state,
            currentPrice: price,
            cumulativeBuySize: legState.cumulativeBuySize ?? 0,
            cumulativeBuyNotional: legState.cumulativeBuyNotional ?? 0,
            publicTradeCount24h: market.publicTradeCount24h ?? null,
            daysToResolve: d9DaysToResolve,
          },
          lossExitPolicy,
        );
        const d9EmissionFacts: EmissionFacts = {
          ...emissionFacts,
          d9ProfitRatio: d9.profitRatio,
          d9AvgBuyPrice: d9.avgBuyPrice,
          d9DaysToResolve: d9.daysToResolve,
          d9PublicTradeCount24h: d9.publicTradeCount24h,
        };
        if (d9.reason === H5_WIDE_COHORT_GUARD_REASON) {
          this.recordDecisionSuppressed({
            tokenId: market.tokenId,
            conditionId: market.conditionId,
            reasonCode: H5_WIDE_COHORT_GUARD_REASON,
            side: "SELL",
            decisionRuleId: "D9_LOSS_EXIT",
            state,
            price,
            buyCount,
            timeSinceLastSeconds,
            emissionFacts: d9EmissionFacts,
            timestamp: new Date(now).toISOString(),
          });
        }
        if (d9.fire) {
          return this.buildSignalOrSuppressSellResidual(
            market,
            { action: "SELL", ruleId: "D9_LOSS_EXIT" },
            ctx,
            buyCount,
            now,
            nextSeq,
            d9EmissionFacts,
            triggerTelemetry,
            position,
          );
        }
      }
    }

    // Post-entry continuation gate — only applies when we have a leg. It blocks
    // further entry/scale-in decisions, but SELL exits use the same D2/D4/D5/D7
    // rules and must remain reachable for existing inventory.
    let continuationFacts: ContinuationFacts | null = null;
    if (legState) {
      const { count: tradeCount, source: tradeCountSource } = this.resolveContinuationTradeCount(
        market.conditionId as ConditionId,
        emissionFacts.legTradeCount,
      );
      continuationFacts = {
        tradeCount,
        tradeCountSource,
        stop: !evaluateContinuation(tradeCount, legState.firstTradePrice),
      };
      if (continuationFacts.stop) {
        const sellMatch = matchRule(ctx, this.decisionRules, SELL_ONLY);
        if (sellMatch) {
          const emissionFactsWithContinuationStop = {
            ...emissionFacts,
            continuationStop: true,
            continuationTradeCount: continuationFacts.tradeCount,
            continuationTradeCountSource: continuationFacts.tradeCountSource,
          };
          return this.buildSignalOrSuppressSellResidual(
            market,
            sellMatch,
            ctx,
            buyCount,
            now,
            nextSeq,
            emissionFactsWithContinuationStop,
            triggerTelemetry,
            position,
          );
        }
        this.recordDecisionSuppressed({
          tokenId,
          conditionId: market.conditionId,
          reasonCode: "continuation-stop",
          state,
          price,
          buyCount,
          timeSinceLastSeconds,
          emissionFacts,
          timestamp: new Date(now).toISOString(),
          tradeCount: continuationFacts.tradeCount,
          tradeCountSource: continuationFacts.tradeCountSource,
        });
        return null;
      }
      if (preservedOnly) {
        // preserved-only: market de-listed for new entries, exit-only via SELL
        const sellMatch = matchRule(ctx, this.decisionRules, SELL_ONLY);
        if (!sellMatch) {
          this.recordDecisionSuppressed({
            tokenId,
            conditionId: market.conditionId,
            reasonCode: "preserved-only-no-sell-rule",
            side: "SELL",
            state,
            price,
            buyCount,
            timeSinceLastSeconds,
            emissionFacts,
            timestamp: new Date(now).toISOString(),
            tradeCount: continuationFacts.tradeCount,
            tradeCountSource: continuationFacts.tradeCountSource,
          });
          return null;
        }
        return this.buildSignalOrSuppressSellResidual(
          market,
          sellMatch,
          ctx,
          buyCount,
          now,
          nextSeq,
          emissionFacts,
          triggerTelemetry,
          position,
        );
      }
    }

    // ADR-033 — R23 dip-trigger first-entry rule. Evaluated after all
    // exit/continuation paths and before static DB rules so FALLBACK can be
    // neutralized to HOLD without removing the startup-required row.
    if (!legState && this.deps.executionPolicy) {
      const r23Policy = this.deps.executionPolicy().r23DipTrigger;
      if (r23Policy?.enabled) {
        this.currentEvalMetrics.r23DipChecked++;
        const maxMidpoint =
          this.deps.priceHistoryProvider?.maxMidpointInWindow?.(tokenId, r23Policy.windowMs, now) ??
          null;
        const r23 = evaluateR23DipTrigger(
          {
            state,
            currentMidpoint: price,
            maxMidpointInWindow: maxMidpoint,
          },
          r23Policy,
        );
        const r23EmissionFacts: EmissionFacts = {
          ...emissionFacts,
          r23DipRatio: r23.ratio,
          r23MaxMidpoint: r23.maxMidpoint,
          r23WindowMs: r23Policy.windowMs,
        };
        if (r23.reason === R23_NO_HISTORY_REASON) this.currentEvalMetrics.r23NoHistory++;
        if (r23.reason === R23_NO_DIP_REASON) this.currentEvalMetrics.r23NoDip++;
        if (r23.fire) {
          this.currentEvalMetrics.r23DipFired++;
          return this.buildSignalOrSuppressSellResidual(
            market,
            { action: "BUY", ruleId: R23_DIP_TRIGGER_RULE_ID },
            ctx,
            buyCount,
            now,
            nextSeq,
            r23EmissionFacts,
            triggerTelemetry,
            position,
          );
        }
        this.recordDecisionSuppressed({
          tokenId,
          conditionId: market.conditionId,
          reasonCode: r23.reason,
          side: "BUY",
          decisionRuleId: R23_DIP_TRIGGER_RULE_ID,
          state,
          price,
          buyCount,
          timeSinceLastSeconds,
          emissionFacts: r23EmissionFacts,
          timestamp: new Date(now).toISOString(),
        });
      }
    }

    // Decide action + size
    const decision = evaluateDecision(ctx, this.decisionRules);
    if (decision.action === "HOLD") {
      this.recordDecisionSuppressed({
        tokenId,
        conditionId: market.conditionId,
        reasonCode: decision.ruleId === "D6" ? D6_SUPPRESSED_REASON : DECISION_RULE_HOLD_REASON,
        side: decision.ruleId === "D6" ? "BUY" : null,
        decisionRuleId: decision.ruleId,
        state,
        price,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: new Date(now).toISOString(),
        tradeCount: continuationFacts?.tradeCount ?? null,
        tradeCountSource: continuationFacts?.tradeCountSource ?? null,
      });
      return null;
    }
    const tradeDecision = decision as { action: TradeDecisionAction; ruleId: string };
    return this.buildSignalOrSuppressSellResidual(
      market,
      tradeDecision,
      ctx,
      buyCount,
      now,
      nextSeq,
      emissionFacts,
      triggerTelemetry,
      position,
    );
  }

  private getCachedLegState(tokenId: TokenId): LegState | null {
    const key = String(tokenId);
    if (this.legStateCache.has(key)) return this.legStateCache.get(key) ?? null;
    if (this.legStateCacheHydrated) {
      this.legStateCache.set(key, null);
      return null;
    }
    const state = this.deps.legStateRepo.get(tokenId);
    this.legStateCache.set(key, state);
    return state;
  }

  private getCachedPosition(tokenId: TokenId): Position | null {
    const key = String(tokenId);
    if (this.positionCache.has(key)) return this.positionCache.get(key) ?? null;
    if (this.positionCacheHydrated) {
      this.positionCache.set(key, null);
      return null;
    }
    const position = this.deps.positionRepo?.findByTokenId(tokenId) ?? null;
    this.positionCache.set(key, position);
    return position;
  }

  private invalidateDecisionState(tokenId: string): void {
    this.legStateCache.delete(tokenId);
    this.positionCache.delete(tokenId);
  }

  private buildSignalOrSuppressSellResidual(
    market: NormalizedMarket,
    decision: { action: TradeDecisionAction; ruleId: string },
    ctx: EvalContext,
    buyCount: number,
    now: number,
    nextSeq: (key: string) => number,
    emissionFacts: EmissionFacts,
    triggerTelemetry: TriggerTelemetry,
    position: ReturnType<NonNullable<AlgoDecisionModuleDeps["positionRepo"]>["findByTokenId"]>,
  ): TokenEvalResult | null {
    if (this.shouldSuppressSellResidualBelowMinSize(decision, market, position)) {
      // CHANGE B — R67 spec 11.5 dust abandonment. Each suppression here
      // means position.size < market.minOrderSize so the executor cannot
      // submit a valid SELL. Count it against the policy threshold; when
      // we cross `maxConsecutiveRejects` mark the leg abandoned. The
      // counter resets to 0 on any BUY fill (update-leg-state-for-fill).
      const nowIso = new Date(now).toISOString();
      if (this.deps.executionPolicy) {
        const dustPolicy = this.deps.executionPolicy().dustAbandonment;
        if (dustPolicy.enabled) {
          const { count, markedAbandoned } = this.deps.legStateRepo.incrementSellResidualReject(
            market.tokenId,
            nowIso,
            { threshold: dustPolicy.maxConsecutiveRejects, price: ctx.price },
          );
          this.invalidateDecisionState(String(market.tokenId));
          if (markedAbandoned) {
            this.persistence.enqueueRiskEvent({
              eventType: "signal_suppressed",
              payload: {
                tokenId: String(market.tokenId),
                conditionId: market.conditionId,
                reasonCode: DUST_ABANDONED_REASON,
                consecutiveRejects: count,
                abandonedAtPrice: ctx.price,
                signalTimestamp: nowIso,
              },
            });
          }
        }
      }
      this.recordDecisionSuppressed({
        tokenId: market.tokenId,
        conditionId: market.conditionId,
        reasonCode: SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
        side: "SELL",
        decisionRuleId: decision.ruleId,
        state: ctx.state,
        price: ctx.price,
        buyCount,
        timeSinceLastSeconds: ctx.timeSinceLastSeconds,
        emissionFacts,
        timestamp: nowIso,
      });
      return null;
    }

    return this.buildSignal(
      market,
      decision,
      ctx,
      buyCount,
      now,
      nextSeq,
      emissionFacts,
      triggerTelemetry,
    );
  }

  private shouldSuppressSellResidualBelowMinSize(
    decision: { action: TradeDecisionAction; ruleId: string },
    market: NormalizedMarket,
    position: ReturnType<NonNullable<AlgoDecisionModuleDeps["positionRepo"]>["findByTokenId"]>,
  ): boolean {
    if (decision.action !== "SELL") return false;
    const minOrderSize = market.minOrderSize;
    const positionSize = position?.size;
    return (
      typeof minOrderSize === "number" &&
      Number.isFinite(minOrderSize) &&
      minOrderSize > 0 &&
      typeof positionSize === "number" &&
      Number.isFinite(positionSize) &&
      positionSize + 1e-9 < minOrderSize
    );
  }

  private evaluateDropTrigger(
    tokenId: TokenId,
    currentPrice: number,
    signalReason: string,
    nowMs: number,
  ): {
    allowed: boolean;
    status: TriggerTelemetry["dropTriggerStatus"];
    priceDropPct: number | null;
  } {
    const policy = this.deps.executionPolicy?.().dropTrigger;
    if (!policy?.enabled) return { allowed: true, status: "disabled", priceDropPct: null };
    if (signalReason === "probe-entry") {
      return { allowed: true, status: "bypass_probe", priceDropPct: null };
    }
    this.currentEvalMetrics.dropTriggerChecked++;
    const provider = this.deps.priceHistoryProvider;
    const referencePrice = provider?.findReferencePrice(
      tokenId,
      nowMs - policy.lookbackMs,
      policy.historyMaxAgeMs,
    );
    if (referencePrice == null || referencePrice <= 0 || !Number.isFinite(referencePrice)) {
      this.currentEvalMetrics.allowNoDropData++;
      return {
        allowed: policy.failOpenOnNoData,
        status: "no_drop_data",
        priceDropPct: null,
      };
    }
    const priceDropPct = (currentPrice - referencePrice) / referencePrice;
    if (priceDropPct > policy.thresholdPct) {
      this.currentEvalMetrics.rejectNoDropSignal++;
      return { allowed: false, status: "rejected", priceDropPct };
    }
    this.currentEvalMetrics.dropTriggerPassed++;
    return { allowed: true, status: "passed", priceDropPct };
  }

  private buildSignal(
    market: NormalizedMarket,
    decision: { action: TradeDecisionAction; ruleId: string },
    ctx: EvalContext,
    buyCount: number,
    now: number,
    nextSeq: (key: string) => number,
    emissionFacts: EmissionFacts,
    triggerTelemetry: TriggerTelemetry,
  ): TokenEvalResult {
    const side = decision.action === "BUY" ? "buy" : ("sell" as const);
    const reason = resolveSignalReason(side, buyCount);
    const postBuyCooldown = side === "sell" ? this.getPostBuyFillSellCooldown(now) : null;
    if (postBuyCooldown) {
      this.recordDecisionSuppressed({
        tokenId: market.tokenId,
        conditionId: market.conditionId,
        reasonCode: POST_BUY_FILL_COOLDOWN_REASON,
        side: "SELL",
        decisionRuleId: decision.ruleId,
        state: ctx.state,
        price: ctx.price,
        buyCount,
        timeSinceLastSeconds: ctx.timeSinceLastSeconds,
        emissionFacts,
        timestamp: new Date(now).toISOString(),
      });
      this.log.debug(
        {
          tokenId: String(market.tokenId),
          cooldownMs: postBuyCooldown.cooldownMs,
          ageMs: postBuyCooldown.ageMs,
          lastBuyFillAt: new Date(postBuyCooldown.lastBuyFillAt).toISOString(),
        },
        "SELL signal suppressed during post-BUY fill cooldown",
      );
      return null;
    }
    if (side === "buy") {
      const dropGate = this.evaluateDropTrigger(market.tokenId, ctx.price, reason, now);
      triggerTelemetry.dropTriggerStatus = dropGate.status;
      triggerTelemetry.dropTriggerPct = dropGate.priceDropPct;
      if (!dropGate.allowed) {
        this.recordDecisionSuppressed({
          tokenId: market.tokenId,
          conditionId: market.conditionId,
          reasonCode: dropGate.status === "no_drop_data" ? "no_drop_data" : "no_drop_signal",
          side: "BUY",
          decisionRuleId: decision.ruleId,
          state: ctx.state,
          price: ctx.price,
          buyCount,
          timeSinceLastSeconds: ctx.timeSinceLastSeconds,
          emissionFacts,
          timestamp: new Date(now).toISOString(),
        });
        return null;
      }
    }

    const sizeRules = decision.action === "BUY" ? this.buySizeRules : this.sellSizeRules;
    const nthBuy = buyCount + 1;
    const sizeResult = evaluateSize(
      decision.action,
      { state: ctx.state, price: ctx.price, nthBuy, buyCount },
      sizeRules,
    );

    const seqKey = `${market.tokenId}|${side}`;
    const sequenceInTick = nextSeq(seqKey);

    const suggestedSizeUsdc = sizeResult.sizeUsdc;
    const suggestedSize = ctx.price > 0 ? suggestedSizeUsdc / ctx.price : 0;

    // Pre-filter signals whose size CANNOT meet `market.minOrderSize` under
    // any realistic execution price. The downstream check in
    // `signal-to-order.resolveOrderSize` is authoritative — this gate exists
    // only to keep guaranteed-rejected signals off the bus + risk-gate +
    // pricing pipeline. To stay strictly more permissive than downstream,
    // BUY size is estimated at `market.bestBid` (the lowest realistic BUY
    // execution price; edge-mode pricing uses bestBid, taker mode uses
    // bestAsk which produces a smaller size). Falling back to ctx.price
    // (midPrice) when bestBid is unavailable. SELL stays more permissive
    // than execution by considering the leg's cumulative unsold size and
    // intentionally ignoring open SELL reservations; execution owns those
    // reserved-token-limit rejects.
    const sizeForExecutability =
      side === "buy"
        ? computeBuyOrderSizeForFilter(suggestedSizeUsdc, market, ctx.price)
        : Math.max(
            suggestedSize,
            Math.max(
              0,
              (emissionFacts.cumulativeBuySize ?? 0) - (emissionFacts.cumulativeSellSize ?? 0),
            ),
          );
    if (!isExecutableOrderSize(sizeForExecutability, market.minOrderSize)) {
      this.recordDecisionSuppressed({
        tokenId: market.tokenId,
        conditionId: market.conditionId,
        reasonCode: "order-size-below-minimum",
        side: side === "buy" ? "BUY" : "SELL",
        decisionRuleId: decision.ruleId,
        state: ctx.state,
        price: ctx.price,
        buyCount,
        timeSinceLastSeconds: ctx.timeSinceLastSeconds,
        emissionFacts,
        timestamp: new Date(now).toISOString(),
      });
      return null;
    }

    const signal: import("@krabs/domain").Signal = {
      signalId: randomUUID(),
      tokenId: market.tokenId,
      conditionId: market.conditionId as ConditionId,
      side,
      suggestedPrice: ctx.price,
      suggestedSize,
      suggestedSizeUsdc,
      reason,
      strategyTick: now,
      sequenceInTick,
      decisionRuleId: decision.ruleId,
      sizingRuleId: sizeResult.ruleId,
      generatedAt: new Date(now).toISOString(),
    };

    // Defer telemetry until the wallet-budget filter in `evaluateTokensInner`
    // has decided to keep this signal. Recording at construction time
    // overcounts decision_signal_log/signal_emitted by every tail-end signal
    // that gets silently dropped for lack of BUY headroom, breaking the
    // emitted-vs-suppressed accounting operators rely on.
    // ADR-026 §D-B — denormalize §11.1 adds telemetry at signal-emit time so
    // is_add / age / price-change / nth_buy distributions become first-class
    // queryable columns without retroactive joins against a mutating
    // leg_states.first_trade_at.
    const isAdd: 0 | 1 = side === "buy" && buyCount >= 1 ? 1 : 0;
    const isAddBuy = isAdd === 1;
    const firstTradeAtMs = emissionFacts.firstTradeAt
      ? new Date(emissionFacts.firstTradeAt).getTime()
      : null;
    // Negative deltas (clock skew / future firstTradeAt) stay null rather than
    // collapsing into "<60s" — bucket lower bound is 0ms inclusive.
    const rawAddAgeMs =
      isAddBuy && firstTradeAtMs != null && Number.isFinite(firstTradeAtMs)
        ? now - firstTradeAtMs
        : null;
    const addAgeMs = rawAddAgeMs != null && rawAddAgeMs >= 0 ? rawAddAgeMs : null;
    const firstPrice = emissionFacts.firstTradePrice;
    const addPriceChangePct =
      isAddBuy && firstPrice != null && firstPrice > 0
        ? (ctx.price - firstPrice) / firstPrice
        : null;
    const nthBuyAtEmit = side === "buy" ? nthBuy : null;

    // ADR-027 §D-B — denormalize §11.2 exit telemetry at SELL signal-emit time.
    // Mirrors the §D-B BUY-side adds-telemetry pattern: BUY/REDEEM rows carry
    // nulls so decision_signal_log stays one-row-per-emission.
    const exitTelemetry = computeExitTelemetry(side, ctx.price, now, emissionFacts);

    const commitLog = (): void => {
      this.recordDecisionSignal(
        {
          signalId: signal.signalId,
          tokenId: signal.tokenId,
          conditionId: signal.conditionId,
          side: side === "buy" ? "BUY" : "SELL",
          decisionRuleId: signal.decisionRuleId,
          sizingRuleId: signal.sizingRuleId,
          notionalBucket: classifyNotionalBucket(signal.suggestedSizeUsdc),
          state: ctx.state,
          price: ctx.price,
          buyCount,
          timeSinceLastSeconds: ctx.timeSinceLastSeconds,
          signalTimestamp: signal.generatedAt,
          isAdd: side === "buy" ? isAdd : null,
          addAgeMs,
          addAgeBucket: classifyAddAgeBucket(addAgeMs),
          addPriceChangePct,
          addPriceChangeBucket: classifyAddPriceChangeBucket(addPriceChangePct),
          nthBuyAtEmit,
          ...exitTelemetry,
        },
        emissionFacts,
        triggerTelemetry,
      );
    };

    return { type: "signal", signal, market, commitLog };
  }

  private recordDecisionSignal(
    signal: DecisionSignalLog,
    emissionFacts: EmissionFacts,
    triggerTelemetry: TriggerTelemetry,
  ): void {
    // ADR-022 §D-F — record this decisionRuleId in the per-tick histogram
    // BEFORE the repo writes so the healthcheck reflects the signal even if
    // persistence fails. Aggregation is in-memory only; failures here are
    // not user-visible. `decisionRuleId === null` is technically possible
    // per the DecisionSignalLog type — bucket those under the literal
    // "(null)" so they remain countable rather than silently dropped.
    const ruleKey = signal.decisionRuleId ?? "(null)";
    this.currentTickRuleMix.set(ruleKey, (this.currentTickRuleMix.get(ruleKey) ?? 0) + 1);

    this.persistence.enqueueDecisionSignal(signal);

    // v063 — `risk_events.signal_emitted` is a write-only JSON mirror of the
    // structured `decision_signal_log` row plus emission-facts (firstTradePrice,
    // r23DipRatio, dropFromLastSeen, …). At ~16M rows/day on prod it was a
    // primary driver of the disk-full crash at v062. Production now opts out
    // (`persistSignalEmittedTelemetry === false`), leaving the structured row
    // as the sole persisted record. Tests opt in so the F-telemetry payload
    // checks keep observing the emission-facts that still flow through the
    // computation path.
    if (this.deps.persistSignalEmittedTelemetry !== true) {
      return;
    }
    this.persistence.enqueueRiskEvent({
      eventType: "signal_emitted",
      payload: {
        signalId: signal.signalId,
        tokenId: String(signal.tokenId),
        conditionId: String(signal.conditionId),
        side: signal.side,
        decisionRuleId: signal.decisionRuleId,
        state: signal.state,
        price: signal.price,
        buyCount: signal.buyCount,
        timeSinceLastSeconds: signal.timeSinceLastSeconds,
        firstTradePrice: emissionFacts.firstTradePrice,
        legTradeCount: emissionFacts.legTradeCount,
        continuationStop: emissionFacts.continuationStop ?? null,
        tradeCount: emissionFacts.continuationTradeCount ?? null,
        tradeCountSource: emissionFacts.continuationTradeCountSource ?? null,
        continuationMode: this.continuationMode,
        // ADR-022 §D-F — F-telemetry fields surfaced for post-hoc R23/R24
        // distribution comparison.
        dropFromLastSeen: triggerTelemetry.dropFromLastSeen,
        entryPriceBucket: triggerTelemetry.entryPriceBucket,
        dropTriggerStatus: triggerTelemetry.dropTriggerStatus,
        dropTriggerPct: triggerTelemetry.dropTriggerPct,
        r23DipRatio: emissionFacts.r23DipRatio ?? null,
        r23MaxMidpoint: emissionFacts.r23MaxMidpoint ?? null,
        r23WindowMs: emissionFacts.r23WindowMs ?? null,
        d9ProfitRatio: emissionFacts.d9ProfitRatio ?? null,
        d9PublicTradeCount24h: emissionFacts.d9PublicTradeCount24h ?? null,
        // ADR-026 §D-B — §11.1 adds telemetry mirrored alongside the
        // decision_signal_log row.
        isAdd: signal.isAdd,
        addAgeMs: signal.addAgeMs,
        addAgeBucket: signal.addAgeBucket,
        addPriceChangePct: signal.addPriceChangePct,
        addPriceChangeBucket: signal.addPriceChangeBucket,
        nthBuyAtEmit: signal.nthBuyAtEmit,
        signalTimestamp: signal.signalTimestamp,
      },
    });
  }

  private recordLivenessSuppressedMetric(reasons: readonly string[], ctx: EvalContext): void {
    const metrics = this.currentEvalMetrics;
    metrics.suppressedMarketNotLive++;
    const notAcceptingOrders = reasons.includes("not_accepting_orders");
    const orderBookDisabled = reasons.includes("order_book_disabled");
    if (notAcceptingOrders) metrics.livenessNotAcceptingOrders++;
    if (orderBookDisabled) metrics.livenessOrderBookDisabled++;
    if (notAcceptingOrders && orderBookDisabled) metrics.livenessBothFlags++;

    const wouldMatch = evaluateDecision(ctx, this.decisionRules);
    metrics.wouldMatchRule.set(
      wouldMatch.ruleId,
      (metrics.wouldMatchRule.get(wouldMatch.ruleId) ?? 0) + 1,
    );
  }

  private recordDecisionSuppressed(facts: SuppressionFacts): void {
    if (!this.shouldPersistSuppressionEvent(facts)) return;

    this.persistence.enqueueRiskEvent({
      eventType: "signal_suppressed",
      payload: {
        tokenId: String(facts.tokenId),
        conditionId: facts.conditionId,
        reasonCode: facts.reasonCode,
        reasons: facts.reasons ?? null,
        side: facts.side ?? null,
        decisionRuleId: facts.decisionRuleId ?? null,
        state: facts.state,
        price: facts.price,
        buyCount: facts.buyCount,
        timeSinceLastSeconds: facts.timeSinceLastSeconds,
        firstTradePrice: facts.emissionFacts.firstTradePrice,
        legTradeCount: facts.emissionFacts.legTradeCount,
        d9ProfitRatio: facts.emissionFacts.d9ProfitRatio ?? null,
        d9AvgBuyPrice: facts.emissionFacts.d9AvgBuyPrice ?? null,
        d9DaysToResolve: facts.emissionFacts.d9DaysToResolve ?? null,
        d9PublicTradeCount24h: facts.emissionFacts.d9PublicTradeCount24h ?? null,
        r23DipRatio: facts.emissionFacts.r23DipRatio ?? null,
        r23MaxMidpoint: facts.emissionFacts.r23MaxMidpoint ?? null,
        r23WindowMs: facts.emissionFacts.r23WindowMs ?? null,
        tradeCount: facts.tradeCount ?? null,
        tradeCountSource: facts.tradeCountSource ?? null,
        continuationMode: this.continuationMode,
        signalTimestamp: facts.timestamp,
      },
    });
  }

  private shouldPersistSuppressionEvent(facts: SuppressionFacts): boolean {
    if (!DEDUPED_SUPPRESSION_REASONS.has(facts.reasonCode)) return true;

    const eventAt = Date.parse(facts.timestamp);
    const now = Number.isFinite(eventAt) ? eventAt : Date.now();
    const key = this.suppressionDedupeKey(facts);
    const lastAt = this.suppressionDedupe.get(key);
    if (lastAt != null && now - lastAt < NOISY_SUPPRESSION_DEDUPE_MS) return false;

    this.suppressionDedupe.set(key, now);
    if (this.suppressionDedupe.size > MAX_SUPPRESSION_DEDUPE_KEYS) {
      this.pruneSuppressionDedupe(now);
    }
    return true;
  }

  private suppressionDedupeKey(facts: SuppressionFacts): string {
    if (this.shouldAggregateEntrySuppression(facts)) {
      return [
        "entry-sweep",
        facts.reasonCode,
        facts.side ?? "",
        facts.decisionRuleId ?? "",
        facts.state,
        [...(facts.reasons ?? [])].sort().join(","),
        this.continuationMode,
      ].join("|");
    }

    return [
      facts.reasonCode,
      String(facts.tokenId),
      facts.conditionId ?? "",
      facts.side ?? "",
      this.continuationMode,
    ].join("|");
  }

  private shouldAggregateEntrySuppression(facts: SuppressionFacts): boolean {
    return (
      ENTRY_SWEEP_AGGREGATED_SUPPRESSION_REASONS.has(facts.reasonCode) &&
      facts.buyCount === 0 &&
      facts.emissionFacts.legTradeCount === 0
    );
  }

  private pruneSuppressionDedupe(now: number): void {
    for (const [key, lastAt] of this.suppressionDedupe) {
      if (now - lastAt >= NOISY_SUPPRESSION_DEDUPE_MS) {
        this.suppressionDedupe.delete(key);
      }
    }
    while (this.suppressionDedupe.size > MAX_SUPPRESSION_DEDUPE_KEYS) {
      const oldestKey = this.suppressionDedupe.keys().next().value;
      if (oldestKey === undefined) break;
      this.suppressionDedupe.delete(oldestKey);
    }
  }

  private shouldSuppressBuyForBudget(signal: import("@krabs/domain").Signal, now: number): boolean {
    if (signal.side !== "buy") return false;

    if (this.buyBudgetCooldownUntilMs > 0 && now >= this.buyBudgetCooldownUntilMs) {
      this.clearBuyBudgetCooldown(now, "expired");
    }

    if (this.buyBudgetCooldownUntilMs > now) {
      this.buyBudgetSuppressedSignals++;
      return true;
    }

    const canAttempt = this.canAttemptBuyNotional(signal.suggestedSizeUsdc, signal);
    if (canAttempt?.allowed === true) {
      return false;
    }

    if (canAttempt?.allowed === false) {
      if (canAttempt.activateCooldown) {
        this.activateBuyBudgetCooldown(signal, now, "decision_preflight", canAttempt.reasonCode);
      }
      this.buyBudgetSuppressedSignals++;
      return true;
    }
    return false;
  }

  private canAttemptBuyNotional(
    requiredNotionalUsdc: number,
    signal: import("@krabs/domain").Signal,
  ): { allowed: boolean; reasonCode: string; activateCooldown: boolean } | null {
    const circuitBreaker = this.deps.buySignalBudgetCircuitBreaker;
    if (!circuitBreaker) return null;

    try {
      const pending = this.pendingPreOpenBuy(signal.tokenId);
      const result = circuitBreaker.canAttemptBuy(requiredNotionalUsdc + pending.notional, signal, {
        pendingPreOpenBuyCount: pending.count,
        pendingPreOpenBuyCountForToken: pending.countForToken,
        pendingPreOpenBuyNotionalUsdc: pending.notional,
      });
      return {
        allowed: result.canAttempt,
        reasonCode: result.reasonCode ?? WALLET_BUY_BUDGET_EXHAUSTED_REASON,
        activateCooldown: result.activateCooldown ?? true,
      };
    } catch (err) {
      this.log.warn(
        {
          err,
          signalId: signal.signalId,
          tokenId: String(signal.tokenId),
          requiredNotionalUsdc,
        },
        "buy budget circuit breaker failed open",
      );
      return { allowed: true, reasonCode: "", activateCooldown: false };
    }
  }

  private activateBuyBudgetCooldown(
    signal: import("@krabs/domain").Signal,
    now: number,
    source: "decision_preflight" | "risk_rejection",
    reasonCode = WALLET_BUY_BUDGET_EXHAUSTED_REASON,
  ): void {
    this.buyBudgetRecoveryNotionalUsdc = Math.max(
      this.buyBudgetRecoveryNotionalUsdc,
      signal.suggestedSizeUsdc,
    );
    if (this.buyBudgetCooldownUntilMs > now) return;

    const cooldownMs = this.deps.buySignalBudgetCooldownMs ?? DEFAULT_BUY_BUDGET_COOLDOWN_MS;
    const cooldownUntilMs = now + cooldownMs;
    this.buyBudgetCooldownUntilMs = cooldownUntilMs;
    this.buyBudgetSuppressedSignals = 0;

    this.recordBuyBudgetCooldownActivated(signal, now, cooldownUntilMs, source, reasonCode);
    this.log.info(
      {
        signalId: signal.signalId,
        tokenId: String(signal.tokenId),
        requiredNotionalUsdc: signal.suggestedSizeUsdc,
        recoveryNotionalUsdc: this.buyBudgetRecoveryNotionalUsdc,
        cooldownUntil: new Date(cooldownUntilMs).toISOString(),
        source,
      },
      "buy budget circuit breaker activated",
    );
  }

  private clearBuyBudgetCooldown(now: number, reason: "expired"): void {
    const suppressedSignals = this.buyBudgetSuppressedSignals;
    this.buyBudgetCooldownUntilMs = 0;
    this.buyBudgetSuppressedSignals = 0;
    this.buyBudgetRecoveryNotionalUsdc = 0;

    this.log.info(
      { reason, suppressedSignals, clearedAt: new Date(now).toISOString() },
      "buy budget circuit breaker cleared",
    );
  }

  private recordBuyBudgetCooldownActivated(
    signal: import("@krabs/domain").Signal,
    now: number,
    cooldownUntilMs: number,
    source: "decision_preflight" | "risk_rejection",
    reasonCode: string,
  ): void {
    this.persistence.enqueueRiskEvent({
      eventType: "signal_suppressed",
      payload: {
        signalId: signal.signalId,
        tokenId: String(signal.tokenId),
        conditionId: String(signal.conditionId),
        reasonCode,
        side: "BUY",
        requiredNotionalUsdc: signal.suggestedSizeUsdc,
        recoveryNotionalUsdc: this.buyBudgetRecoveryNotionalUsdc,
        cooldownUntil: new Date(cooldownUntilMs).toISOString(),
        source,
        signalTimestamp: new Date(now).toISOString(),
      },
    });
  }

  private isPaused(): boolean {
    return this.deps.runtimeControl?.isPaused() ?? false;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private pruneExpiredPending(): void {
    const cutoff = Date.now() - PENDING_ENTRY_TIMEOUT_MS;
    for (const [tokenId, entry] of this.pendingEntries) {
      if (entry.reservedAt < cutoff) {
        this.clearPendingByTokenId(tokenId);
      }
    }
  }

  private clearPendingByTokenId(tokenId: string): void {
    const entry = this.pendingEntries.get(tokenId);
    if (!entry) return;
    this.pendingEntries.delete(tokenId);
    if (entry.clientOrderId) this.clientOrderToToken.delete(entry.clientOrderId);
    if (entry.orderId) this.orderIdToToken.delete(entry.orderId);
  }

  private pendingPreOpenBuy(tokenId: TokenId): {
    count: number;
    countForToken: number;
    notional: number;
  } {
    let count = 0;
    let countForToken = 0;
    let notional = 0;
    for (const entry of this.pendingEntries.values()) {
      if (entry.orderId === null) {
        count++;
        if (entry.tokenId === String(tokenId)) countForToken++;
        notional += entry.suggestedSizeUsdc;
      }
    }
    return { count, countForToken, notional };
  }

  private reservePendingSignal(signal: import("@krabs/domain").Signal, now: number): void {
    this.pendingEntries.set(String(signal.tokenId), {
      tokenId: String(signal.tokenId),
      signalId: signal.signalId,
      suggestedSizeUsdc: signal.suggestedSizeUsdc,
      reservedAt: now,
      clientOrderId: null,
      orderId: null,
    });
  }
}

function resolveDaysToResolve(endDate: string | null, nowMs: number): number | null {
  if (endDate == null || endDate.trim() === "") return null;
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(endMs)) return null;
  const daysToResolve = (endMs - nowMs) / 86_400_000;
  return Number.isFinite(daysToResolve) ? daysToResolve : null;
}

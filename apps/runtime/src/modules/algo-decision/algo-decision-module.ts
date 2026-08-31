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
  Order,
  OrderRepository,
  Fill,
  FillRepository,
  S1OwnershipReader,
  SellOrderSizingContext,
  MakerShadowOrder,
  MakerShadowOrderRepository,
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
  computeSellSizingPlan,
  S1_LADDER_RULE_ID,
  BOUNCE_EXIT_TARGET_RULE_ID,
  BOUNCE_EXIT_BACKSTOP_RULE_ID,
  createEntryFreshEdgeAttribution,
  isGateWhitelisted,
  isMakerCaptureNextR23OrderAuthorized,
  isPermanentR23OrderAuthorized,
} from "@krabs/domain";
import {
  isWorkingSellOrderStatus,
  ledgerInstant,
  parseLedgerInstantMs,
  readContinuationMode,
  readContinuationModeVersion,
} from "@krabs/db";
import type { EvalContext } from "@krabs/domain";
import type { RuntimeControl } from "@krabs/domain";
import type { Logger } from "../../logger.js";
import { isExitRecoveryFencedPredecessor } from "../execution/reservation-utils.js";
import {
  classifyAddAgeBucket,
  classifyAddPriceChangeBucket,
  classifyExitPnlBucket,
  classifyHoldingTimeBucket,
  classifyNotionalBucket,
  classifySoldBoughtRatioBucket,
} from "../../executable-price.js";
import {
  ENTRY_NOT_SELLABLE_REASON,
  MAKER_MICRO_CONDITION_CAP_EXCEEDED_REASON,
  MAKER_MICRO_DISTINCT_CONDITION_CAP_EXCEEDED_REASON,
  OPEN_POSITION_EXISTS_REASON,
  SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
  isMakerEntryInputsUnchangedReason,
} from "../../internal-order-reasons.js";
import { findPermanentR23LineageBlocker } from "../../maker-capture-reprice.js";
import { SAME_PRICE_COOLDOWN_REASON } from "../same-price-cooldown/same-price-cooldown-module.js";
import { TRACK_A_ADD_THROTTLE_REASON } from "../dead-market-shadow/track-a-add-throttle-shadow.js";
import {
  ENTRY_UNKNOWN_MIN_SKIP_REASON,
  MIN_ORDER_SIZE_HYDRATION_RETRY_MS,
  isExecutableOrderSize,
  isKnownMinOrderSize,
} from "../../min-order-size.js";
import { WALLET_BUY_CAPACITY_EXHAUSTED_REASON } from "../../wallet-buy-budget.js";
import { isBounceLadderEligible } from "../exit-ownership/bounce-eligibility.js";
import { isBounceOwned } from "../exit-ownership/is-bounce-owned.js";
import { SlidingLatencyWindow, type LatencySnapshot } from "./decision-metrics.js";
import { DecisionPersistenceBuffer } from "./async-decision-persistence.js";
import { DecisionWorkerPool } from "./decision-worker-pool.js";
import { ContinuationTradeCountCache } from "./continuation-trade-count-cache.js";
import {
  D8_PROFIT_BELOW_AVG_ENTRY_GUARD_REASON,
  D9_LOSS_EXIT_AVG_ENTRY_UNAVAILABLE_BYPASS_REASON,
  D9_LOSS_EXIT_BELOW_AVG_ENTRY_GUARD_REASON,
  ENTRY_MIN_ORDER_SIZE_UNKNOWN_REASON,
  STATIC_RULE_SELL_BELOW_AVG_ENTRY_GUARD_REASON,
  isOpenPosition,
  resolveMakerEntryR23Policy,
} from "./decision-planner.js";
import type {
  DecisionMetricsDelta,
  DecisionPlanningInput,
  DecisionPlanSideEffect,
  DecisionSignalDraft,
} from "./decision-planner.js";
import type { PriceHistoryProvider } from "./market-snapshot-price-history.js";
import type { SellLoopGuardReader } from "../sell-loop-guard/sell-loop-guard-module.js";
import type { R23MemoryMetrics, WindowMaxCacheMetrics } from "./market-snapshot-price-history.js";
import {
  ENTRY_FRESH_EDGE_WINDOW_MS,
  computeEntryFreshEdgeSignalFields,
  type EntryFreshEdgeSignalFields,
} from "./entry-fresh-edge.js";
import {
  computeEntryCategoryGateSignalFields,
  type EntryCategoryGateSignalFields,
} from "./entry-category-gate.js";
import {
  DEFAULT_PLANNER_SUPPRESSION_ROLLUP_WINDOW_MS,
  PlannerSuppressionRollup,
} from "./planner-suppression-rollup.js";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import {
  advanceShadowOrder,
  computeShadowOrderId,
  openNextLevelOrder,
} from "./maker-entry-shadow.js";

// Re-exported for existing consumers; the canonical contract now lives in @krabs/domain.
export type { S1OwnershipReader };

// ─── SelectedMarketCache ─────────────────────────────────────────────────────

/**
 * External cache of markets selected for trading — used to gate new entries.
 * Tokens with an existing LegState bypass isEligible (see evaluateToken).
 */
export interface SelectedMarketCache {
  isEligible(tokenId: TokenId): boolean;
  getEligibleTokenIds(): TokenId[];
  /**
   * GATE selection-bypass (docs/plans/2026-07-17-gate-entry-selection-bypass.md):
   * true when the token was rejected by v5.11 only via a bypassable hard data
   * filter, so the GATE lane may still evaluate it. Optional — absent on test
   * stubs; treated as `false` (no bypass) when not implemented.
   */
  isGateBypassEligible?(tokenId: TokenId): boolean;
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
  r23Memory: R23MemoryMetrics | null;
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

type ActiveMarketCapBackpressureSnapshot = {
  activeTokenIds: ReadonlySet<string>;
  capFull: boolean;
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
   * - `d9_loss_exit_below_avg_entry_guard` — Track D9-forced-low-exit
   *   guard: D9 fired, but the executable SELL was below the current
   *   position avg-entry.
   * - `d9_loss_exit_avg_entry_unavailable_guard_bypass` — same guard could
   *   not read a valid position avg-entry, so D9 stayed fail-open.
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
  extra?: Record<string, unknown>;
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

export interface ProfileLadderOwnershipReader {
  isProfileLadderOwned(tokenId: TokenId): boolean;
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
  orderRepo?:
    | Pick<
        OrderRepository,
        | "findByTokenId"
        | "findById"
        | "findRecentByTokenId"
        | "findOpen"
        | "findRecoverableMakerCaptureRepriceIntents"
        | "findMakerCaptureRepriceIntentByPredecessor"
        | "findMakerCaptureRepriceIntentBySignal"
        | "getMakerCaptureChainUsage"
        | "hasNonterminalBounceAskCaptureIntentForPosition"
      >
    | undefined;
  /**
   * Phase 3 fill-aware bounce-ladder accounting (docs/plans/2026-07-19-
   * sellable-sizing-bounce-for-all.md) — `resolveBounceLadderState` uses this
   * to compute ACTUAL filled shares per bounce-ladder order (reusing the same
   * findByOrderIds/findByOrderId fill-reduction shape as
   * modules/execution/reservation-utils.ts). Optional: omitted only by tests
   * that don't exercise bounce-ladder sizing (soldShares/openCommitment then
   * default to 0, matching pre-Phase-3 behavior).
   */
  fillRepo?: Pick<FillRepository, "findByOrderId" | "findByOrderIds"> | undefined;
  /**
   * Read-only startup recovery for recent BUY no-order-id rejects. The live
   * event path owns the cooldown in memory, but deploy/restart must not clear a
   * just-triggered no-id loop before reconciliation has had time to observe it.
   */
  ledgerDb?: Database.Database | undefined;
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
   * Live-lite active-market cap backpressure. This is an upstream optimization
   * only; RiskInventory and Execution keep the authoritative admission guards.
   */
  liveLiteGuard?: LiveLiteGuard | undefined;
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
  /**
   * Fire-and-forget request to fetch the REST order book for a token — the only
   * payload that carries `min_order_size` (the WSS `book` event omits it). Wired
   * to `CandidateBookCache.getFreshOrRefresh` in `index.ts`; the observed value
   * flows back into the market cache and reaches the next pricing snapshot.
   *
   * When it is NOT supplied (simulation, tests, any mode without a CLOB
   * gateway) the entry pre-filter that depends on it stays inert: suppressing
   * without the ability to hydrate would make the state permanent.
   */
  requestMinOrderSizeHydration?: ((tokenId: string) => void) | undefined;
  /**
   * Whether a hydrated minimum for THIS token can actually reach us. The
   * capability above is module-wide, but MarketData can only republish tokens
   * it caches — discovery-tier markets are deliberately excluded from those
   * caches, so for them the observed minimum is parked and dropped. Same
   * reasoning as an absent `requestMinOrderSizeHydration`, one token at a time:
   * without a delivery route the pre-filter must stay inert and let
   * signal-to-order fetch the minimum for the signal it is about to place.
   */
  canHydrateMinOrderSize?: ((tokenId: string) => boolean) | undefined;
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
  /**
   * Sub-Track Q.A — durable sink for the non-deduped Track Q shadow eval
   * counters. Optional: when omitted (tests/sim) the counters stay in-memory
   * only, exactly as before. Reuses the shared `runtime_metrics` writer; the
   * cumulative value is recovered offline via `SUM(value)` over the delta rows.
   */
  runtimeMetrics?: RuntimeMetricWriter | undefined;
  plannerSuppressionRollupWindowMs?: number | undefined;
  /**
   * Track Q loop guard read surface. When provided, the planner suppresses SELL
   * signal generation for tokens the guard reports as blocked. Optional: omitted
   * by tests/sim that don't exercise the breaker.
   */
  sellLoopGuard?: SellLoopGuardReader | undefined;
  /**
   * Track S1 read surface. When S1 has exclusive ownership of a token's SELL
   * flow, the planner suppresses ordinary SELL rules while leaving BUY paths
   * unchanged.
   */
  s1Ownership?: S1OwnershipReader | undefined;
  profileLadderOwnership?: ProfileLadderOwnershipReader | undefined;
  /**
   * Phase 3 — durable shadow order store for the maker-entry R23 projection.
   * Optional: when absent the tracker is a no-op (mode gating also applies).
   */
  makerShadowOrderRepo?: MakerShadowOrderRepository | undefined;
  /**
   * BBO snapshot fallback for `advanceMakerShadows`. Tokens evicted from the
   * in-memory `marketCache` (churned by TrackedMarketsChanged) have no live BBO.
   * When provided, the scale-in and advance loops do ONE batched lookup per tick
   * against the last-30-min snapshot table so churned tokens can still trigger.
   * Optional: when absent, the existing live-cache-only behaviour is preserved.
   */
  marketSnapshotRepo?:
    | {
        findLatestBboByTokens(
          tokenIds: readonly TokenId[],
        ): Map<string, { bestBid: number | null; bestAsk: number | null; tickSize: number | null }>;
      }
    | undefined;
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
const OPEN_POSITION_WORKING_SET_REFRESH_MS = 5 * 60_000;
const LIVE_LITE_ACTIVE_MARKETS_CAP_FULL_REASON = "live_lite_active_markets_cap_full";
const R23_PROBE_CAP_FULL_SKIP_METRIC = "r23_probe_skipped_active_market_cap_full_total";
const R23_PROBE_NO_ORDER_ID_COOLDOWN_REASON = "r23_probe_no_order_id_cooldown";
const R23_PROBE_NO_ORDER_ID_COOLDOWN_METRIC = "r23_probe_no_order_id_cooldown_suppressed_total";
const R23_PROBE_NO_ORDER_ID_RECOVERED_METRIC = "r23_probe_no_order_id_cooldown_recovered_total";
const R23_PROBE_MAKER_WINDOW_CAP_COOLDOWN_METRIC =
  "r23_probe_maker_window_cap_cooldown_suppressed_total";
const R23_PROBE_NO_ORDER_ID_COOLDOWN_MS = 15 * 60 * 1000;
const OPEN_POSITION_STALE_EVALUATION_WARN_MS = 24 * 60 * 60_000;
const MAKER_WINDOW_CAP_MARKET_INVARIANT_REASONS: ReadonlySet<string> = new Set([
  MAKER_MICRO_CONDITION_CAP_EXCEEDED_REASON,
  MAKER_MICRO_DISTINCT_CONDITION_CAP_EXCEEDED_REASON,
]);

/**
 * Conversion-skip reasons that are pure functions of the cached
 * market / price / liveness / open-order / leg state. A skip for any of these
 * will deterministically reproduce the identical skip if we re-evaluate before
 * the inputs change — and the inputs only change via events that already
 * re-trigger evaluation (NormalizedMarketUpdated on a 250 ms debounce,
 * LegStateUpdated, PositionUpdated, FillReceived) or the 60 s full sweep.
 *
 * Re-evaluating immediately (`scheduleDirtyEvaluation(0)`) on these reasons is a
 * busy-loop: see research_plankton/krabs_russia_ticker_rate_investigation_2026-05-24.md
 * — a single frozen-price dust leg drove a `same-price-cooldown` skip → 0 ms
 * re-flush cycle at ~220 Hz, writing 27 M decision_signal_log rows in 58 h.
 * The module now avoids self-triggering on these reasons; input-changing events
 * or the 60 s full sweep will re-evaluate them.
 *
 * Reasons NOT listed here (budget / placement-rate / order-lifetime gates that
 * can clear on their own as time passes) keep the conservative immediate
 * re-eval so a freed budget is acted on without waiting for the next event.
 */
const INPUTS_UNCHANGED_CONVERSION_SKIP_REASONS: ReadonlySet<string> = new Set([
  SAME_PRICE_COOLDOWN_REASON,
  ENTRY_NOT_SELLABLE_REASON,
  "position-concentration-below_min_after_clamp",
  "sell-order-acceptable-price-already-open",
  "order-size-below-minimum",
  "not_accepting_orders",
  "no_bid",
  "order_book_disabled",
  "execution-price-unavailable",
  "execution-price-invalid",
  "spread-above-cap",
  "one-sided-book",
  "dead-side-near-end",
  "price-above-entry-ceiling",
  "sell-price-below-signal-floor",
  "taker-below-margin",
  // The bridge's own literal for "this market's exchange minimum is unknown".
  // The planner guard above only pre-empts the emission for tokens market-data
  // can republish; on every other path (discovery tier, tracked-but-uncached)
  // the signal still reaches the bridge and skips here. Without this entry that
  // skip re-triggers itself at 0 ms — the exact production tight loop this
  // change exists to kill. The minimum arrives asynchronously, so the re-eval
  // that acts on it comes from the resulting market publish, or the 60 s sweep
  // when no publish route exists.
  ENTRY_UNKNOWN_MIN_SKIP_REASON,
  TRACK_A_ADD_THROTTLE_REASON,
]);

/**
 * Re-eval delay for a `SignalConversionSkipped`. Defers to the 250 ms debounce
 * only when EVERY reason is inputs-unchanged (so the skip cannot resolve until
 * an input-changing event re-triggers evaluation anyway). Empty/unknown reason
 * lists keep the conservative immediate (0 ms) path.
 */
export function conversionSkipReEvalDelayMs(reasons: readonly string[]): number {
  return isInputsUnchangedConversionSkip(reasons) ? DIRTY_EVALUATION_DELAY_MS : 0;
}

export function isInputsUnchangedConversionSkip(reasons: readonly string[]): boolean {
  if (reasons.length === 0) return false;
  return reasons.every(
    (reason) =>
      INPUTS_UNCHANGED_CONVERSION_SKIP_REASONS.has(reason) ||
      isMakerEntryInputsUnchangedReason(reason),
  );
}
const NOISY_SUPPRESSION_DEDUPE_MS = 10 * 60 * 1000;
const D9_PROFILE_OWNED_RISK_EVENT_DEDUPE_MS = 5 * 60 * 1000;
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
const PROFILE_LADDER_RULE_ID = "PROFILE_LADDER";
const PROFILE_LADDER_ORDER_SOURCE = "profile_ladder";
const POST_BUY_FILL_COOLDOWN_REASON = "post-buy-fill-cooldown";
export const DEDUPED_SUPPRESSION_REASONS = new Set([
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
  // Same stickiness as `order-size-below-minimum`, one step earlier: the
  // minimum stays unknown until a REST book lands, and every book tick in
  // between (measured: 545 554 rows/hour at peak) would write an identical row.
  ENTRY_MIN_ORDER_SIZE_UNKNOWN_REASON,
  // Short-lived exchange settlement timing guard. Deduping keeps clustered
  // SELL-capable legs from writing several identical rows during a 5s window.
  POST_BUY_FILL_COOLDOWN_REASON,
  H5_WIDE_COHORT_GUARD_REASON,
  // Sub-Track Q.A: sticky like the D9 below-entry guard — a leg whose decoupled
  // mid keeps D8 firing while the executable bid stays below entry re-suppresses
  // on every sweep tick until the book recovers. Dedupe to keep the log readable.
  D8_PROFIT_BELOW_AVG_ENTRY_GUARD_REASON,
  D9_LOSS_EXIT_BELOW_AVG_ENTRY_GUARD_REASON,
  D9_LOSS_EXIT_AVG_ENTRY_UNAVAILABLE_BYPASS_REASON,
  STATIC_RULE_SELL_BELOW_AVG_ENTRY_GUARD_REASON,
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

function formatSuppressionDedupeNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(9) : "";
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

function isNoOrderIdRejectText(values: readonly (string | null | undefined)[]): boolean {
  const text = values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" | ")
    .toLowerCase();
  return (
    text.includes("exchange returned no order id") ||
    text.includes("gateway returned success without order id")
  );
}

/**
 * Per-token maker-shadow ladder state, held in memory by the tracker.
 * `levels` contains ALL levels — open (pending/filled) and terminal
 * (harvested/marked/expired) — so shouldOpenNextLevel can count correctly
 * and avoid crossing the maxScaleInLevels cap even across restarts.
 */
interface MakerLadderState {
  ladderId: string;
  levels: MakerShadowOrder[];
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
  private lastOpenPositionWorkingSetRefreshAt = 0;
  private readonly openPositionLastEvaluatedAt = new Map<string, number>();

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
  // Track Q shadow telemetry (observe-only). `trackQShadowDedupe` rate-controls
  // the per-(token, reason) risk_event rows exactly like `suppressionDedupe`;
  // `trackQShadow` holds NON-deduped cumulative counters surfaced via
  // healthCheck so the full eval volume is queryable without log-line spam.
  // See research_plankton/track_q_shadow_design_2026-06-11.md.
  private readonly trackQShadowDedupe = new Map<string, number>();
  private readonly trackQShadow = {
    evals: 0,
    wouldActivate: 0,
    suppressionWouldClear: 0,
    proposedStillSuppressed: 0,
    d8FireWouldChange: 0,
    byReason: new Map<string, number>(),
    tokens: new Set<string>(),
  };
  // Sub-Track Q.D shadow telemetry (observe-only). Same dedupe/counter split as
  // Track Q: `trackQdShadowDedupe` rate-controls per-(token, reason) risk_event
  // rows; `trackQdShadow` holds NON-deduped cumulative counters surfaced via
  // healthCheck. See research_plankton/track_q_d_spec_2026-06-12.md.
  private readonly trackQdShadowDedupe = new Map<string, number>();
  private readonly trackQdShadow = {
    evals: 0,
    wouldActivate: 0,
    modeA: 0,
    modeB: 0,
    d8OrD9Collision: 0,
    byReason: new Map<string, number>(),
    tokens: new Set<string>(),
  };
  // Phase 3 — maker-entry shadow tracker.
  // makerShadowOpen: open (pending/filled) levels keyed by shadowOrderId —
  //   fast iteration for the per-tick advance loop.
  // makerShadowLadders: per-token ladder state (ALL levels incl. terminal) —
  //   used to check shouldOpenNextLevel and guard new ladder starts.
  // Both are hydrated from DB on startup. Gated on mode !== "off".
  private readonly makerShadowOpen = new Map<string, MakerShadowOrder>();
  private readonly makerShadowLadders = new Map<string, MakerLadderState>(); // keyed by tokenId string
  // ms since epoch of last TTL prune to avoid pruning on every sweep tick
  private makerShadowLastPruneAt = 0;
  private readonly legacyProfileOwnedGuardDedupe = new Map<string, number>();
  private readonly staticRuleSellBelowAvgEntryDedupe = new Map<string, number>();
  private readonly d9ProfileOwnedSuppressionDedupe = new Map<string, number>();
  private readonly minOrderSizeHydrationDedupe = new Map<string, number>();
  /**
   * Tokens whose entry was skipped on an unknown exchange minimum and that need
   * ONE deferred re-evaluation once the hydration retry window has elapsed.
   *
   * Deliberately NOT `dirtyTokenIds` + a delayed `scheduleDirtyEvaluation`: that
   * set is drained by ANY subsequent evaluation, so the token would be re-planned
   * within milliseconds — the incident loop — instead of after the backoff. The
   * delay must happen BEFORE the token becomes dirty, which is what this staging
   * set does.
   *
   * Bounded by construction: it is drained wholesale every
   * `MIN_ORDER_SIZE_HYDRATION_RETRY_MS`, so it holds at most the distinct tokens
   * suppressed inside one 60 s window (~900 at the worst observed 15 signals/s).
   */
  private readonly minOrderSizeRearmTokenIds = new Set<string>();
  private minOrderSizeRearmTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly lastBuyFillByWallet = new Map<string, number>();
  private readonly r23ProbeNoOrderIdCooldownUntilMs = new Map<string, number>();
  private readonly r23ProbeMakerWindowCapCooldowns = new Map<
    string,
    { blockedUntilMs: number; policyFingerprint: string; reason: string }
  >();
  private readonly probeOpenPositionBlocks = new Map<string, string>();
  private buyBudgetCooldownUntilMs = 0;
  private buyBudgetSuppressedSignals = 0;
  private buyBudgetRecoveryNotionalUsdc = 0;

  private tickCounter = 0;
  private unsubs: Array<() => void> = [];
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private readonly plannerRollup: PlannerSuppressionRollup;
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
    this.plannerRollup = new PlannerSuppressionRollup({
      windowMs:
        deps.plannerSuppressionRollupWindowMs ?? DEFAULT_PLANNER_SUPPRESSION_ROLLUP_WINDOW_MS,
      emit: (event) => this.persistence.enqueueRiskEvent(event),
      writeCounter: (metricName, value, labels) =>
        this.deps.runtimeMetrics?.writeCounter(metricName, value, labels),
      writeLatest: (metricName, value, labels) =>
        this.deps.runtimeMetrics?.writeLatest(metricName, value, labels),
    });
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
    this.recoverR23ProbeNoOrderIdCooldowns();
    this.hydrateMakerShadowOrders();
    this.lastOpenPositionWorkingSetRefreshAt = Date.now();
    this.refreshOpenPositionWorkingSet(this.lastOpenPositionWorkingSetRefreshAt, false);

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
    this.plannerRollup.start();

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
    if (this.minOrderSizeRearmTimer) {
      clearTimeout(this.minOrderSizeRearmTimer);
      this.minOrderSizeRearmTimer = null;
    }
    this.minOrderSizeRearmTokenIds.clear();
    this.r23ProbeMakerWindowCapCooldowns.clear();
    this.probeOpenPositionBlocks.clear();
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    await this.plannerRollup.stop();
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
    const trackQShadow = this.formatTrackQShadow();
    const trackQdShadow = this.formatQdShadow();
    return {
      ok: true,
      detail: `${base}${funnel}${ruleMix}${evalMetrics}${trackQShadow}${trackQdShadow}`,
    };
  }

  // Track Q shadow telemetry rollup. Omitted entirely until the first wide-book
  // shadow eval so the healthcheck line stays tidy. Counters are cumulative
  // since module start (never deduped) — the queryable per-event detail lives
  // in the deduped `track_q_shadow` risk_event rows.
  private formatTrackQShadow(): string {
    const c = this.trackQShadow;
    if (c.evals === 0) return "";
    const reasons = [...c.byReason.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ");
    return (
      ` trackQShadow evals=${c.evals} tokens=${c.tokens.size}` +
      ` wouldActivate=${c.wouldActivate} suppressionWouldClear=${c.suppressionWouldClear}` +
      ` proposedStillSuppressed=${c.proposedStillSuppressed}` +
      ` d8FireWouldChange=${c.d8FireWouldChange}` +
      (reasons ? ` trackQReasons ${reasons}` : "")
    );
  }

  // Sub-Track Q.D shadow rollup. Omitted entirely until the first in-cohort
  // shadow eval so the healthcheck line stays tidy. Counters are cumulative
  // since module start (never deduped) — the queryable per-event detail lives
  // in the deduped `track_q_d` risk_event rows.
  private formatQdShadow(): string {
    const c = this.trackQdShadow;
    if (c.evals === 0) return "";
    const reasons = [...c.byReason.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ");
    return (
      ` trackQdShadow evals=${c.evals} tokens=${c.tokens.size}` +
      ` wouldActivate=${c.wouldActivate} modeA=${c.modeA} modeB=${c.modeB}` +
      ` d8OrD9Collision=${c.d8OrD9Collision}` +
      (reasons ? ` trackQdReasons ${reasons}` : "")
    );
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
      if (!market.active || isKnownMinOrderSize(market.minOrderSize)) {
        this.releaseMinOrderSizeHydration(tokenIdStr);
      }
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
      const authoritativePosition = this.deps.positionRepo?.findByTokenId(tokenId) ?? null;
      if (!this.entryBlockingPositionFingerprint(authoritativePosition)) {
        this.probeOpenPositionBlocks.delete(tokenIdStr);
      }
      this.releaseMinOrderSizeHydration(tokenIdStr);
      const openPosition = this.findOpenPositionByTokenId(tokenId);
      if (openPosition) {
        this.positionCache.set(tokenIdStr, openPosition);
        this.legStateCache.delete(tokenIdStr);
        this.markDirty(tokenId);
        continue;
      }
      if (!this.pendingEntries.has(tokenIdStr)) {
        this.deps.priceHistoryProvider?.evictToken?.(tokenId);
      }
      this.dirtyTokenIds.delete(tokenIdStr);
      this.legStateCache.delete(tokenIdStr);
      this.positionCache.delete(tokenIdStr);
      this.openPositionLastEvaluatedAt.delete(tokenIdStr);
    }
    for (const tokenId of payload.addedTokenIds) {
      this.markDirty(tokenId);
    }
  }

  private async handleOrderPlaced(payload: RuntimeEventMap["OrderPlaced"]): Promise<void> {
    if (payload.side === "sell") {
      this.plannerRollup.flushToken(String(payload.tokenId), "order_placed");
    }
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
    this.plannerRollup.flushToken(String(payload.tokenId), "fill_received");
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
    this.plannerRollup.flushToken(tokenId, "leg_state_cleared");
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
    this.plannerRollup.flushToken(tokenId, "position_settled");
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
    const openPositionBlocked = this.blockProbeForOpenPosition(payload);
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
    if (openPositionBlocked) return;
    this.markDirty(payload.signal.tokenId);
    this.scheduleDirtyEvaluation(0);
  }

  private async handleSignalConversionSkipped(
    payload: RuntimeEventMap["SignalConversionSkipped"],
  ): Promise<void> {
    const tokenKey = String(payload.signal.tokenId);
    this.clearPendingByTokenId(tokenKey);
    if (isInputsUnchangedConversionSkip(payload.reasons)) {
      if (payload.reasons.includes(ENTRY_UNKNOWN_MIN_SKIP_REASON)) {
        this.scheduleMinOrderSizeRearm(tokenKey);
      }
      return;
    }
    this.markDirty(payload.signal.tokenId);
    this.scheduleDirtyEvaluation(conversionSkipReEvalDelayMs(payload.reasons));
  }

  /**
   * `entry_unknown_min` is inputs-unchanged like its neighbours, but unlike them
   * it has NO reliable event that re-triggers evaluation: the hydration this skip
   * provokes is asynchronous and may return no minimum at all (a partial `/books`
   * payload), in which case no market publish follows. The 60 s full sweep is not
   * the recovery route either — `markFullSweepDirty` unions leg state, OPEN
   * positions and `getEligibleTokenIds()`, and `eligible` / `gateBypassEligible`
   * are mutually exclusive in `market-selection-cache.ts`, so a GATE-bypass token
   * is never swept. Without this re-arm such a token waits for the next discovery
   * rotation (~8 h at 5 000 tokens / 50 per batch / 5 min) before trying again.
   *
   * One deferred re-evaluation per retry window is enough: it re-enters the
   * planner, which re-requests hydration under its own 60 s dedupe. If the
   * minimum is still unknown the skip re-arms once more — a 1/60 s cycle, four
   * orders of magnitude below the ~31/s that caused the incident.
   */
  private scheduleMinOrderSizeRearm(tokenKey: string): void {
    this.minOrderSizeRearmTokenIds.add(tokenKey);
    if (this.minOrderSizeRearmTimer !== null) return;
    this.minOrderSizeRearmTimer = setTimeout(() => {
      this.minOrderSizeRearmTimer = null;
      const tokenIds = [...this.minOrderSizeRearmTokenIds];
      this.minOrderSizeRearmTokenIds.clear();
      if (tokenIds.length === 0) return;
      for (const tokenId of tokenIds) this.markDirty(tokenId);
      this.scheduleDirtyEvaluation(0);
    }, MIN_ORDER_SIZE_HYDRATION_RETRY_MS);
  }

  private async handleOrderCancelled(payload: RuntimeEventMap["OrderCancelled"]): Promise<void> {
    if (this.isCurrentBounceTargetStaleTtlCancellation(payload)) {
      this.markDirty(payload.tokenId);
      this.scheduleDirtyEvaluation(0);
    }

    const orderId = String(payload.orderId);
    const tokenId = this.orderIdToToken.get(orderId);
    if (tokenId) {
      this.clearPendingByTokenId(tokenId);
      this.markDirty(tokenId as TokenId);
      this.scheduleDirtyEvaluation(0);
    }
  }

  private isCurrentBounceTargetStaleTtlCancellation(
    payload: RuntimeEventMap["OrderCancelled"],
  ): boolean {
    if (payload.reason !== "stale_exit_ttl") return false;
    const order = this.deps.orderRepo
      ?.findByTokenId(payload.tokenId)
      .find(
        (candidate) =>
          String(candidate.orderId) === String(payload.orderId) &&
          String(candidate.tokenId) === String(payload.tokenId) &&
          String(candidate.conditionId) === String(payload.conditionId),
      );
    if (
      order?.status !== "cancelled" ||
      order.side !== "sell" ||
      order.decisionRuleId !== BOUNCE_EXIT_TARGET_RULE_ID
    ) {
      return false;
    }
    const position = this.findOpenPositionByTokenId(payload.tokenId);
    if (!position || !isBounceOwned(position)) return false;
    return String(order.positionId ?? "") === String(position.positionId);
  }

  private async handleOrderRejected(payload: RuntimeEventMap["OrderRejected"]): Promise<void> {
    if (this.isR23ProbeNoOrderIdBuyRejection(payload)) {
      this.activateR23ProbeNoOrderIdCooldown(payload.tokenId, payload.timestamp);
    }
    if (this.isR23ProbeMakerWindowCapRejection(payload)) {
      this.activateR23ProbeMakerWindowCapCooldown(payload);
    }

    const clientOrderId = String(payload.clientOrderId);
    const tokenId = this.clientOrderToToken.get(clientOrderId);
    if (tokenId) {
      this.clearPendingByTokenId(tokenId);
      if (isMakerEntryInputsUnchangedReason(payload.reason)) return;
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
    this.maybePruneMakerShadows();

    const now = Date.now();
    if (now - this.lastOpenPositionWorkingSetRefreshAt >= OPEN_POSITION_WORKING_SET_REFRESH_MS) {
      this.lastOpenPositionWorkingSetRefreshAt = now;
      this.refreshOpenPositionWorkingSet(now, true);
    }
    if (now - this.lastFullSweepAt >= FULL_SWEEP_INTERVAL_MS) {
      this.lastFullSweepAt = now;
      this.markFullSweepDirty();
    }
    this.pruneR23ProbeNoOrderIdCooldowns(now);
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
    const openPositionTokenIds = this.refreshOpenPositionWorkingSet(Date.now(), false);

    for (const tokenId of new Set([...legStateTokenIds, ...eligibleSet, ...openPositionTokenIds])) {
      this.dirtyTokenIds.add(tokenId);
    }
  }

  private refreshOpenPositionWorkingSet(now: number, warnStale: boolean): string[] {
    const positions = this.deps.positionRepo?.findOpen?.() ?? [];
    const tokenIds: string[] = [];
    for (const position of positions) {
      if (!isOpenPosition(position)) continue;
      const tokenId = String(position.tokenId);
      tokenIds.push(tokenId);
      this.positionCache.set(tokenId, position);
      if (this.legStateCache.get(tokenId) === null) this.legStateCache.delete(tokenId);
      this.dirtyTokenIds.add(tokenId);
      if (warnStale) this.warnIfOpenPositionStale(position, now);
    }
    return tokenIds;
  }

  private warnIfOpenPositionStale(position: Position, now: number): void {
    const tokenId = String(position.tokenId);
    const lastEvaluatedAt = this.openPositionLastEvaluatedAt.get(tokenId);
    const openedAtMs = parseLedgerInstantMs(position.openedAt);
    const referenceMs =
      lastEvaluatedAt ??
      (Number.isFinite(openedAtMs) ? openedAtMs : parseLedgerInstantMs(position.updatedAt));
    if (!Number.isFinite(referenceMs)) return;
    if (now - referenceMs < OPEN_POSITION_STALE_EVALUATION_WARN_MS) return;
    this.log.warn(
      {
        tokenId,
        positionId: String(position.positionId),
        lastEvaluatedAt:
          lastEvaluatedAt !== undefined ? new Date(lastEvaluatedAt).toISOString() : null,
        openedAt: position.openedAt,
        ageMs: now - referenceMs,
      },
      "open position has not been evaluated recently",
    );
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
    const activeMarketCapBackpressure = this.getActiveMarketCapBackpressureSnapshot();
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
        activeMarketCapBackpressure,
      );
      if (input) inputs.push(input);
    }

    const plans = await this.decisionWorkerPool.evaluate(inputs);
    for (const plan of plans) {
      if (this.isPaused()) return;
      this.applyDecisionMetricsDelta(plan.metrics);
      this.applyDecisionPlanSideEffects(plan.sideEffects, executionPolicy);
      for (const suppression of plan.suppressions) {
        // Hydration first: recordDecisionSuppressed writes telemetry and can
        // throw (DB busy/locked), which would drop the very refresh that clears
        // the suppression and leave the loop re-emitting forever.
        this.requestMinOrderSizeHydrationFor(suppression as SuppressionFacts, now);
        this.recordDecisionSuppressed(suppression as SuppressionFacts);
      }
      if (plan.type !== "signal") continue;
      const result = this.materializeSignalDraft(plan.signal, now, nextSeq);
      if (result.signal.side === "buy") {
        if (this.hasActivePermanentR23Lineage(result.signal, executionPolicy, now)) continue;
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

    // Phase 3 — advance all open maker-entry shadows using latest market data.
    this.advanceMakerShadows(now, executionPolicy);

    // ADR-022 §D-F — promote the just-completed histogram so healthcheck
    // immediately reflects this sweep, not the previous one.
    this.lastTickRuleMix = this.currentTickRuleMix;
    this.lastEvalMetrics = this.currentEvalMetrics;
  }

  private hasActivePermanentR23Lineage(
    signal: RuntimeEventMap["SignalProduced"]["signal"],
    policy: ExecutionPolicy | null,
    nowMs: number,
  ): boolean {
    if (
      !policy ||
      signal.makerCaptureReprice !== undefined ||
      !isPermanentR23OrderAuthorized(policy.makerEntry, {
        conditionId: signal.conditionId,
        source: "strategy",
        side: signal.side,
        entryStyle: "maker",
        postOnly: true,
        decisionRuleId: signal.decisionRuleId,
        signalReason: signal.reason,
        signalTimestamp: signal.generatedAt,
      })
    ) {
      return false;
    }
    if (!this.deps.orderRepo) return true;
    return (
      findPermanentR23LineageBlocker({
        tokenId: signal.tokenId,
        policy,
        orderRepo: this.deps.orderRepo,
        nowMs,
      }) !== null
    );
  }

  /**
   * The planner's unknown-minimum suppression only breaks the loop if something
   * eventually hydrates the minimum — the book cache is filled ONLY reactively
   * (from `signal-to-order`), so a market that never emits never fetches a REST
   * book. Kick one refresh per token per `MIN_ORDER_SIZE_HYDRATION_RETRY_MS`
   * rather than per ~31/s tick, which is what caused the incident.
   *
   * The refresh is fire-and-forget and can fail silently — `/books` may omit the
   * token, or MarketData may park the value when the runtime pauses or its pricing
   * goes stale mid-flight. On THIS path the suppression happens before any signal
   * is emitted, so no `SignalConversionSkipped` ever arrives and the bridge-side
   * re-arm cannot cover it; `markFullSweepDirty` excludes GATE-bypass-only tokens
   * too. Without the re-arm below, a quiet GATE-bypass token whose refresh failed
   * stays suppressed until the next discovery rotation (~8 h). Re-arming
   * unconditionally rather than only on failure costs one redundant evaluation
   * when the refresh did work; the dedupe below bounds the REFRESH to one per
   * token per window either way.
   *
   * The re-arm must happen BEFORE the dedupe check and independently of it. The
   * re-arm timer is shared, so every token in a batch inherits the deadline of
   * whichever token started it: a token suppressed at t=59 s is re-evaluated at
   * t=60 s, one second into its own window. Gating the re-arm on the dedupe
   * would then drop it — the deduped tick returns early, nothing re-schedules
   * it, and the quiet GATE-bypass token this mechanism exists to recover waits
   * out the discovery rotation. Re-arming here keeps it in the cycle until a
   * tick lands outside its window and the refresh actually fires.
   */
  private requestMinOrderSizeHydrationFor(suppression: SuppressionFacts, now: number): void {
    if (suppression.reasonCode !== ENTRY_MIN_ORDER_SIZE_UNKNOWN_REASON) return;
    const requestHydration = this.deps.requestMinOrderSizeHydration;
    if (requestHydration == null) return;
    const tokenKey = String(suppression.tokenId);
    this.scheduleMinOrderSizeRearm(tokenKey);
    const allowed = this.dedupeAllows(
      this.minOrderSizeHydrationDedupe,
      tokenKey,
      now,
      MIN_ORDER_SIZE_HYDRATION_RETRY_MS,
    );
    if (!allowed) return;
    requestHydration(tokenKey);
  }

  /**
   * The dedupe window above is a retry backoff for a refresh that did NOT
   * produce a minimum (a `/books` payload can omit the token). It must not
   * outlive a refresh that DID: the token would otherwise keep its entry
   * blocked for the rest of the window after being dropped and re-added — a new
   * snapshot arrives with `minOrderSize: null` and no refresh is requested.
   * Released on the two edges that end an episode: the minimum landing, and the
   * token leaving the tracked universe.
   */
  private releaseMinOrderSizeHydration(tokenIdStr: string): void {
    this.minOrderSizeHydrationDedupe.delete(tokenIdStr);
  }

  /** Whether the entry pre-filter has a route to hydrate THIS token's minimum. */
  private canHydrateMinOrderSizeFor(tokenId: TokenId): boolean {
    if (this.deps.requestMinOrderSizeHydration == null) return false;
    return this.deps.canHydrateMinOrderSize?.(String(tokenId)) ?? true;
  }

  private async createDecisionPlanningInput(
    tokenId: TokenId,
    now: number,
    executionPolicy: ExecutionPolicy | null,
    postBuyCooldown: { cooldownMs: number; ageMs: number; lastBuyFillAt: number } | null,
    activeMarketCapBackpressure: ActiveMarketCapBackpressureSnapshot | null,
  ): Promise<DecisionPlanningInput | null> {
    const legState = this.getCachedLegState(tokenId);
    const openPosition = this.findOpenPositionByTokenId(tokenId);
    const selectedForEntry = this.deps.selectedMarketCache.isEligible(tokenId);
    const market = this.marketCache.get(String(tokenId)) ?? null;
    // GATE selection-bypass (docs/plans/2026-07-17-gate-entry-selection-bypass.md):
    // a whitelisted, tradable market that failed ONLY the v5.11 hard data filters is
    // admitted for evaluation here even when not `selectedForEntry`. It can then enter
    // ONLY via the GATE lane — the planner routes a `gateBypass` market on a pure GATE
    // path (never R23 / the generic rule table, which carry no $2 micro-cap).
    const gateBypass =
      !legState &&
      !selectedForEntry &&
      !openPosition &&
      market != null &&
      market.tradable === true &&
      isGateWhitelisted(executionPolicy?.gateEntry, market.conditionId) &&
      (this.deps.selectedMarketCache.isGateBypassEligible?.(tokenId) ?? false);
    if (!legState && !selectedForEntry && !openPosition && !gateBypass) return null;
    if (this.shouldSkipProbeForUnchangedOpenPosition(tokenId, legState)) {
      return null;
    }
    if (
      this.shouldSkipFlatProbeForActiveMarketCap(
        tokenId,
        legState,
        openPosition,
        selectedForEntry,
        activeMarketCapBackpressure,
      )
    ) {
      this.recordR23ProbeSkippedActiveMarketCapFull();
      return null;
    }
    if (
      this.shouldSkipFlatProbeForR23RejectionCooldown(
        tokenId,
        legState,
        openPosition,
        selectedForEntry,
        now,
        executionPolicy,
      )
    ) {
      this.recordR23ProbeRejectionCooldownSuppressed(tokenId);
      return null;
    }

    const prevMidPrice = this.prevMidPrices.get(String(tokenId)) ?? null;
    const position =
      legState || openPosition ? (openPosition ?? this.getCachedPosition(tokenId)) : null;
    if (openPosition) this.openPositionLastEvaluatedAt.set(String(tokenId), now);
    const continuationFacts =
      legState && market ? await this.resolveContinuationFactsForPlanner(market, legState) : null;
    // Maker-entry observation evaluates R23 independently of the live R23 toggle.
    // The live R23 decision remains gated on `enabled` in decision-planner.
    const r23MaxMidpoint =
      !legState && market?.midPrice != null && this.deps.priceHistoryProvider?.maxMidpointInWindow
        ? this.deps.priceHistoryProvider.maxMidpointInWindow(
            tokenId,
            resolveMakerEntryR23Policy(executionPolicy).windowMs,
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
    // Phase 4 bounce-for-all (docs/plans/2026-07-19-sellable-sizing-bounce-
    // for-all.md): resolve ladder state for ANY eligible open position, not
    // just GATE — gated by isBounceLadderEligible's appliesFromMs cutoff, so
    // pre-flag positions are untouched.
    // Release A Phase 3: a bounce OWNER (sticky exit_owner='bounce') is eligible for
    // ladder-state resolution regardless of the live whitelist/cutoff/sellableFlow
    // eligibility — owner-authoritative, so a flag rollback can't drop its state.
    const bounceLadderEligible =
      legState != null &&
      position != null &&
      (isBounceOwned(position) ||
        // 'profile' owners are never bounce-serviced; legacy eligibility is for
        // UNASSIGNED (NULL) positions only (owner-authoritative).
        (position.exitOwner == null &&
          isBounceLadderEligible(
            {
              entryLane: position.entryLane,
              openedAt: position.openedAt,
              firstTradeAt: legState.firstTradeAt,
            },
            executionPolicy?.sellableFlow,
          )));
    // fillAware = sellableFlow actually on — only then does the planner USE the
    // fill-aware fields, so only then do we pay (and risk) the fillRepo read.
    // Release A Phase 3: a bounce owner ALWAYS uses fill-aware accounting so its
    // dedup / residual can't regress after a sellableFlow rollback.
    const fillAware =
      isBounceOwned(position) ||
      (executionPolicy?.sellableFlow?.enabled === true &&
        executionPolicy.sellableFlow.appliesFromMs != null);
    const bounceLadderState =
      bounceLadderEligible && legState
        ? this.resolveBounceLadderState(tokenId, `${tokenId}:${legState.firstTradeAt}`, fillAware)
        : null;

    return {
      tokenId,
      now,
      selectedForEntry,
      gateBypass,
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
      latestSellOrder: legState ? this.getLatestSellOrderForSizing(tokenId) : null,
      hasActiveSellOrderForQd: legState ? this.hasActiveSellOrderForQd(tokenId) : false,
      placedBounceRungIndices: bounceLadderState?.placedRungIndices ?? [],
      originalLadderPositionSize: bounceLadderState?.originalPositionSize ?? null,
      bounceLadderSoldShares: bounceLadderState?.soldShares ?? 0,
      bounceLadderOpenCommitment: bounceLadderState?.openCommitment ?? 0,
      hasOpenBounceRung: bounceLadderState?.hasOpenBounceRung ?? false,
      hasActiveSellOrderForBounceBackstop: bounceLadderEligible
        ? this.hasActiveSellOrderForBounceBackstop(tokenId)
        : false,
      hasNonterminalBounceAskCaptureIntent:
        position != null &&
        this.deps.orderRepo?.hasNonterminalBounceAskCaptureIntentForPosition?.(
          position.positionId,
        ) === true,
      sellLoopGuard: this.deps.sellLoopGuard?.getSnapshot(tokenId, now) ?? null,
      // Release A Phase 3: MASK stale non-bounce ownership for a bounce owner — its
      // exit is exclusively the bounce ladder, so a stale s1/profile ownership flag
      // must not suppress the bounce servicing or a below-entry bounce backstop.
      // Safe because the atomic-deploy invariant + the P6 transition fence guarantee
      // no live non-bounce order/queued submission coexists with a bounce owner.
      s1Ownership: isBounceOwned(position)
        ? null
        : (this.deps.s1Ownership?.getSnapshot(tokenId) ?? null),
      profileLadderOwned: isBounceOwned(position)
        ? false
        : (this.deps.profileLadderOwnership?.isProfileLadderOwned(tokenId) ?? false),
      minOrderSizeHydrationAvailable: this.canHydrateMinOrderSizeFor(tokenId),
    };
  }

  private getActiveMarketCapBackpressureSnapshot(): ActiveMarketCapBackpressureSnapshot | null {
    const guard = this.deps.liveLiteGuard;
    if (!guard?.isActive) return null;

    const activeTokenIds = new Set<string>();
    for (const [tokenId, position] of this.positionCache.entries()) {
      if (isOpenPosition(position)) activeTokenIds.add(tokenId);
    }
    return {
      activeTokenIds,
      capFull: guard.wouldExceedActiveMarketsCap(activeTokenIds.size, 1),
    };
  }

  private shouldSkipFlatProbeForActiveMarketCap(
    tokenId: TokenId,
    legState: LegState | null,
    openPosition: Position | null,
    selectedForEntry: boolean,
    snapshot: ActiveMarketCapBackpressureSnapshot | null,
  ): boolean {
    if (!snapshot?.capFull) return false;
    if (!selectedForEntry) return false;
    if (legState || openPosition) return false;
    return !snapshot.activeTokenIds.has(String(tokenId));
  }

  private recordR23ProbeSkippedActiveMarketCapFull(): void {
    this.deps.runtimeMetrics?.writeCounter(
      R23_PROBE_CAP_FULL_SKIP_METRIC,
      1,
      JSON.stringify({
        reason: LIVE_LITE_ACTIVE_MARKETS_CAP_FULL_REASON,
        rule: R23_DIP_TRIGGER_RULE_ID,
        source: "probe-entry",
        mode: "live-lite",
        action: "skip",
      }),
    );
  }

  private shouldSkipFlatProbeForR23RejectionCooldown(
    tokenId: TokenId,
    legState: LegState | null,
    openPosition: Position | null,
    selectedForEntry: boolean,
    now: number,
    executionPolicy: ExecutionPolicy | null,
  ): boolean {
    if (!selectedForEntry) return false;
    if (legState || openPosition) return false;
    const key = String(tokenId);
    const makerCap = this.r23ProbeMakerWindowCapCooldowns.get(key);
    if (makerCap) {
      const policyFingerprint = this.makerWindowCapPolicyFingerprint(executionPolicy);
      if (now < makerCap.blockedUntilMs && policyFingerprint === makerCap.policyFingerprint) {
        return true;
      }
      this.r23ProbeMakerWindowCapCooldowns.delete(key);
    }
    const blockedUntilMs = this.r23ProbeNoOrderIdCooldownUntilMs.get(key);
    if (blockedUntilMs == null) return false;
    if (now < blockedUntilMs) return true;
    this.r23ProbeNoOrderIdCooldownUntilMs.delete(key);
    return false;
  }

  private recordR23ProbeRejectionCooldownSuppressed(tokenId: TokenId): void {
    const makerCap = this.r23ProbeMakerWindowCapCooldowns.get(String(tokenId));
    if (!makerCap) {
      this.recordR23ProbeNoOrderIdCooldownSuppressed();
      return;
    }
    this.deps.runtimeMetrics?.writeCounter(
      R23_PROBE_MAKER_WINDOW_CAP_COOLDOWN_METRIC,
      1,
      JSON.stringify({
        reason: makerCap.reason,
        rule: R23_DIP_TRIGGER_RULE_ID,
        source: "probe-entry",
        action: "skip",
      }),
    );
  }

  private recordR23ProbeNoOrderIdCooldownSuppressed(): void {
    this.deps.runtimeMetrics?.writeCounter(
      R23_PROBE_NO_ORDER_ID_COOLDOWN_METRIC,
      1,
      JSON.stringify({
        reason: R23_PROBE_NO_ORDER_ID_COOLDOWN_REASON,
        rule: R23_DIP_TRIGGER_RULE_ID,
        source: "probe-entry",
        action: "skip",
      }),
    );
  }

  private blockProbeForOpenPosition(event: RuntimeEventMap["SignalRejected"]): boolean {
    if (
      event.reason !== OPEN_POSITION_EXISTS_REASON ||
      event.signal.side !== "buy" ||
      event.signal.reason !== "probe-entry"
    ) {
      return false;
    }
    const position = this.deps.positionRepo?.findByTokenId(event.signal.tokenId) ?? null;
    const fingerprint = this.entryBlockingPositionFingerprint(position);
    if (!fingerprint) return false;
    this.probeOpenPositionBlocks.set(String(event.signal.tokenId), fingerprint);
    return true;
  }

  private shouldSkipProbeForUnchangedOpenPosition(
    tokenId: TokenId,
    legState: LegState | null,
  ): boolean {
    if (legState) return false;
    const key = String(tokenId);
    const blockedFingerprint = this.probeOpenPositionBlocks.get(key);
    if (!blockedFingerprint) return false;
    const position = this.deps.positionRepo?.findByTokenId(tokenId) ?? null;
    if (this.entryBlockingPositionFingerprint(position) === blockedFingerprint) return true;
    this.probeOpenPositionBlocks.delete(key);
    return false;
  }

  private entryBlockingPositionFingerprint(position: Position | null): string | null {
    if (!position || position.status === "closed") return null;
    return JSON.stringify([String(position.positionId), position.status]);
  }

  private isR23ProbeNoOrderIdBuyRejection(event: RuntimeEventMap["OrderRejected"]): boolean {
    if (event.side !== "buy") return false;
    if (event.decisionRuleId !== R23_DIP_TRIGGER_RULE_ID) return false;
    if (event.signalReason !== "probe-entry") return false;
    return isNoOrderIdRejectText([event.reason, event.exchangeErrorMessage]);
  }

  private isR23ProbeMakerWindowCapRejection(event: RuntimeEventMap["OrderRejected"]): boolean {
    return (
      event.side === "buy" &&
      event.decisionRuleId === R23_DIP_TRIGGER_RULE_ID &&
      event.signalReason === "probe-entry" &&
      MAKER_WINDOW_CAP_MARKET_INVARIANT_REASONS.has(event.reason)
    );
  }

  private activateR23ProbeMakerWindowCapCooldown(event: RuntimeEventMap["OrderRejected"]): void {
    const eventAt =
      Number.isFinite(event.timestamp) && event.timestamp > 0 ? event.timestamp : Date.now();
    const executionPolicy = this.deps.executionPolicy?.() ?? null;
    const expiresAtMs = Date.parse(executionPolicy?.makerEntry.microLiveWindow?.expiresAtUtc ?? "");
    const retryAt = eventAt + R23_PROBE_NO_ORDER_ID_COOLDOWN_MS;
    const blockedUntilMs =
      Number.isFinite(expiresAtMs) && expiresAtMs > eventAt
        ? Math.min(retryAt, expiresAtMs)
        : retryAt;
    this.r23ProbeMakerWindowCapCooldowns.set(String(event.tokenId), {
      blockedUntilMs,
      policyFingerprint: this.makerWindowCapPolicyFingerprint(executionPolicy),
      reason: event.reason,
    });
  }

  private makerWindowCapPolicyFingerprint(executionPolicy: ExecutionPolicy | null): string {
    return JSON.stringify([
      executionPolicy?.makerEntry.mode ?? null,
      executionPolicy?.makerEntry.microLiveWindow ?? null,
    ]);
  }

  private activateR23ProbeNoOrderIdCooldown(tokenId: TokenId, timestampMs: number): void {
    const eventAt = Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : Date.now();
    const blockedUntilMs = eventAt + R23_PROBE_NO_ORDER_ID_COOLDOWN_MS;
    const key = String(tokenId);
    const current = this.r23ProbeNoOrderIdCooldownUntilMs.get(key) ?? 0;
    if (blockedUntilMs > current) {
      this.r23ProbeNoOrderIdCooldownUntilMs.set(key, blockedUntilMs);
    }
  }

  private pruneR23ProbeNoOrderIdCooldowns(nowMs: number): void {
    for (const [tokenId, blockedUntilMs] of this.r23ProbeNoOrderIdCooldownUntilMs) {
      if (nowMs >= blockedUntilMs) this.r23ProbeNoOrderIdCooldownUntilMs.delete(tokenId);
    }
    for (const [tokenId, cooldown] of this.r23ProbeMakerWindowCapCooldowns) {
      if (nowMs >= cooldown.blockedUntilMs) {
        this.r23ProbeMakerWindowCapCooldowns.delete(tokenId);
      }
    }
  }

  private recoverR23ProbeNoOrderIdCooldowns(): void {
    const db = this.deps.ledgerDb;
    if (!db) return;

    const nowMs = Date.now();
    const cutoffIso = new Date(nowMs - R23_PROBE_NO_ORDER_ID_COOLDOWN_MS).toISOString();
    try {
      // `updated_at` mixes ISO and legacy SQLite space-format renderings of the same
      // instant (see @krabs/db ledgerInstant): within one calendar day the space form
      // sorts lexically BELOW an ISO string of the same instant, so both the cutoff
      // bound and the per-token "latest rejection" pick must compare via ledgerInstant()
      // rather than the raw TEXT — a raw `updated_at >= ?` / `MAX(updated_at)` can drop a
      // qualifying row or pick an older rejection, releasing the cooldown early. The
      // ROW_NUMBER pick mirrors findLatestBboByTokens in market-snapshot-repository.ts.
      const rows = db
        .prepare(
          `SELECT token_id, updated_at AS last_rejected_at
             FROM (
               SELECT token_id, updated_at,
                      ROW_NUMBER() OVER (
                        PARTITION BY token_id
                        ORDER BY ${ledgerInstant("updated_at")} DESC
                      ) AS rn
                 FROM orders
                WHERE side = 'buy'
                  AND status = 'rejected'
                  AND decision_rule_id = ?
                  AND signal_reason = 'probe-entry'
                  AND exchange_error_message IN (
                    'exchange returned no order id',
                    'gateway returned success without order id'
                  )
                  AND ${ledgerInstant("updated_at")} >= ${ledgerInstant("?")}
             )
            WHERE rn = 1`,
        )
        .all(R23_DIP_TRIGGER_RULE_ID, cutoffIso) as Array<{
        token_id: string;
        last_rejected_at: string | null;
      }>;

      let recovered = 0;
      for (const row of rows) {
        const rejectedAtMs = parseLedgerInstantMs(row.last_rejected_at);
        if (!Number.isFinite(rejectedAtMs)) continue;
        const blockedUntilMs = rejectedAtMs + R23_PROBE_NO_ORDER_ID_COOLDOWN_MS;
        if (blockedUntilMs <= nowMs) continue;
        this.r23ProbeNoOrderIdCooldownUntilMs.set(row.token_id, blockedUntilMs);
        recovered++;
      }
      if (recovered > 0) {
        this.deps.runtimeMetrics?.writeCounter(
          R23_PROBE_NO_ORDER_ID_RECOVERED_METRIC,
          recovered,
          JSON.stringify({
            reason: R23_PROBE_NO_ORDER_ID_COOLDOWN_REASON,
            rule: R23_DIP_TRIGGER_RULE_ID,
            source: "probe-entry",
            action: "recover",
          }),
        );
        this.log.warn(
          { recovered, cooldownMs: R23_PROBE_NO_ORDER_ID_COOLDOWN_MS },
          "recovered R23 probe no-order-id cooldowns from rejected orders",
        );
      }
    } catch (err) {
      this.log.warn({ err }, "failed to recover R23 probe no-order-id cooldowns");
    }
  }

  // Shared by every "recent sell order" consumer below (sizing, the general
  // Track Q shadow, the GATE bounce-exit backstop) — findRecentByTokenId is
  // an optional repo capability (some fixtures/backends don't implement it),
  // so every caller needs the identical fallback to an unbounded scan sorted
  // newest-first. Extracted once rather than copy-pasted a third time (CLAUDE.md DRY).
  private recentOrdersByToken(tokenId: TokenId): Order[] {
    const repo = this.deps.orderRepo;
    if (!repo) return [];
    return (
      repo.findRecentByTokenId?.(tokenId, 20) ??
      repo
        .findByTokenId(tokenId)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    );
  }

  private getLatestSellOrderForSizing(tokenId: TokenId): SellOrderSizingContext | null {
    const latest = this.recentOrdersByToken(tokenId).find((order) => order.side === "sell");
    if (!latest) return null;
    return {
      size: latest.size,
      fillProgressShares: latest.fillProgressShares ?? null,
      createdAt: latest.createdAt,
      status: latest.status,
      cancelReason: latest.cancelReason ?? null,
    };
  }

  private hasActiveSellOrderForQd(tokenId: TokenId): boolean {
    return this.recentOrdersByToken(tokenId).some(
      (order) =>
        order.side === "sell" &&
        order.decisionRuleId !== S1_LADDER_RULE_ID &&
        !isProfileLadderOrderForQd(order) &&
        isWorkingSellOrderStatus(order.status ?? null),
    );
  }

  // GATE-scoped bounce-exit backstop active-sell check (docs/plans/2026-07-16-
  // bounce-exit-ladder-redesign.md Phase 3, REV3 R2-H1): deliberately a
  // SIBLING of hasActiveSellOrderForQd above, not a reuse of it — the general
  // Track Q shadow's check must stay unchanged (it never excludes bounce
  // rungs), while the backstop's own check MUST exclude them: a resting
  // bounce rung is exactly what the backstop is about to cancel, so it must
  // never veto its own force-exit.
  private hasActiveSellOrderForBounceBackstop(tokenId: TokenId): boolean {
    return this.recentOrdersByToken(tokenId).some(
      (order) =>
        order.side === "sell" &&
        order.decisionRuleId !== S1_LADDER_RULE_ID &&
        order.decisionRuleId !== BOUNCE_EXIT_TARGET_RULE_ID &&
        order.decisionRuleId !== BOUNCE_EXIT_BACKSTOP_RULE_ID &&
        !isProfileLadderOrderForQd(order) &&
        isWorkingSellOrderStatus(order.status ?? null),
    );
  }

  // Bounce-exit ladder branch input (docs/plans/2026-07-16-bounce-exit-ladder-
  // redesign.md, Phase 2 + Phase 4): a single order scan derives both (a)
  // which rung indices are already placed (open OR filled — not just
  // "currently resting") for this position's ladder, so evaluateBounceExit
  // skips them and selects the next un-placed rung, and (b) the ladder's
  // PINNED original-position-size basis, recovered from the earliest placed
  // rung's own `originalPositionSize` metadata (Phase 4 add-invariance fix —
  // see `originalLadderPositionSize` doc in decision-planner.ts).
  // Uses findByTokenId (unbounded, all statuses) rather than the recent-N scan
  // the sibling helpers above use or findOpen()'s open-only scope — a filled
  // rung must still count as "placed" even though it's no longer open, and a
  // resting rung can outlive many newer BUY/add orders on the same token.
  // Cancelled/rejected rungs are NOT placed — they get retried.
  // Scoped to `ladderId` so a closed-then-reopened GATE position on the same
  // token starts a fresh ladder rather than inheriting a stale rung set.
  private resolveBounceLadderState(
    tokenId: TokenId,
    ladderId: string,
    fillAware: boolean,
  ): {
    placedRungIndices: readonly number[];
    originalPositionSize: number | null;
    soldShares: number;
    openCommitment: number;
    hasOpenBounceRung: boolean;
  } {
    const repo = this.deps.orderRepo;
    const emptyState = {
      placedRungIndices: [],
      originalPositionSize: null,
      soldShares: 0,
      openCommitment: 0,
      hasOpenBounceRung: false,
    };
    if (!repo) return emptyState;
    const indices = new Set<number>();
    // MIN, not first-seen: pins to whatever the smallest recorded value ever
    // was across all placed rungs. Since cumulativeBuySize only grows (an add
    // can only increase it, never decrease it), the smallest value any rung
    // ever recorded is necessarily the earliest (pre-add) one, regardless of
    // repository iteration order.
    let originalPositionSize: number | null = null;
    // Phase 3 fill-aware accounting (docs/plans/2026-07-19-sellable-sizing-
    // bounce-for-all.md): every non-rejected BOUNCE_EXIT_TARGET order on this
    // ladder, INCLUDING cancelled ones — a cancel-then-repost cycle must not
    // let an already-sold partial fill vanish from the accounting below.
    // Rejected orders never receive exchange fills, so they're excluded
    // exactly as before.
    const ladderOrders: Order[] = [];
    for (const order of repo.findByTokenId(tokenId)) {
      if (order.side !== "sell") continue;
      if (order.decisionRuleId !== BOUNCE_EXIT_TARGET_RULE_ID) continue;
      if (isExitRecoveryFencedPredecessor(order)) continue;
      if (order.status === "rejected") continue;
      const bounceRung = order.metadata?.bounceRung as
        | {
            ladderId?: string;
            rungIndex?: number;
            rungIndicesCovered?: number[];
            originalPositionSize?: number;
          }
        | undefined;
      if (!bounceRung || bounceRung.ladderId !== ladderId) continue;
      // Cancelled rungs are NOT "placed" — they get retried (unchanged from
      // pre-Phase-3 behavior) — but they still flow into `ladderOrders` below
      // so any partial fill they carry counts toward soldShares.
      if (order.status !== "cancelled") {
        // rungIndicesCovered (min-order rollover) marks every absorbed index
        // as placed, not just the order's own rungIndex.
        if (Array.isArray(bounceRung.rungIndicesCovered)) {
          for (const covered of bounceRung.rungIndicesCovered) {
            if (typeof covered === "number") indices.add(covered);
          }
        } else if (typeof bounceRung.rungIndex === "number") {
          indices.add(bounceRung.rungIndex);
        }
        if (
          typeof bounceRung.originalPositionSize === "number" &&
          Number.isFinite(bounceRung.originalPositionSize) &&
          (originalPositionSize === null || bounceRung.originalPositionSize < originalPositionSize)
        ) {
          originalPositionSize = bounceRung.originalPositionSize;
        }
      }
      ladderOrders.push(order);
    }

    // Flag-off failure-mode identity (Codex audit r4): the fill-aware read hits
    // fillRepo (a DB/ledger read that can throw). When sellableFlow is off the
    // planner ignores these fields entirely (GATE keeps its original index-driven
    // path), so skip the read — a fillRepo error must not kill a GATE decision
    // that master would have completed. placedRungIndices/originalPositionSize
    // (no fillRepo) are still resolved as before.
    const { soldShares, openCommitment, hasOpenBounceRung } = fillAware
      ? this.sumBounceLadderFills(ladderOrders)
      : { soldShares: 0, openCommitment: 0, hasOpenBounceRung: false };
    return {
      placedRungIndices: Array.from(indices),
      originalPositionSize,
      soldShares,
      openCommitment,
      hasOpenBounceRung,
    };
  }

  // Fill-reduction pattern mirrors modules/execution/reservation-utils.ts:50
  // (`getFilledSizeByOrderId`/`getRemainingOrderSize`) — duplicated rather
  // than imported since that helper is module-private there and this plan's
  // scope budget doesn't include touching that file to export it.
  private sumBounceLadderFills(ladderOrders: readonly Order[]): {
    soldShares: number;
    openCommitment: number;
    hasOpenBounceRung: boolean;
  } {
    const fillRepo = this.deps.fillRepo;
    const filledSizeByOrderId = new Map<string, number>();
    if (fillRepo && ladderOrders.length > 0) {
      const fills: Fill[] =
        fillRepo.findByOrderIds?.(ladderOrders.map((order) => order.orderId)) ??
        ladderOrders.flatMap((order) => fillRepo.findByOrderId(order.orderId));
      for (const fill of fills) {
        const key = String(fill.orderId);
        filledSizeByOrderId.set(key, (filledSizeByOrderId.get(key) ?? 0) + fill.size);
      }
    }
    let soldShares = 0;
    let openCommitment = 0;
    let hasOpenBounceRung = false;
    for (const order of ladderOrders) {
      const key = String(order.orderId);
      // Codex H3 fix: the reconciler marks an order "filled" within a 0.5%
      // shortfall tolerance, so a "filled" order's ACTUAL fills can be
      // slightly less than order.size — flooring at order.size whenever real
      // fill data exists would overstate soldShares and hide a real
      // (potentially >= min-order-size) residual on a large/cheap position.
      // Real fill data — any row the ledger actually returned for this
      // order (`.has`, not `?? 0`) — always wins. The order.size floor is a
      // fallback ONLY when the ledger has NO data at all for this order
      // (fillRepo unwired entirely, or a genuine ledger gap for a "filled"
      // order), so the never-oversell invariant still holds without data.
      const filled = filledSizeByOrderId.has(key)
        ? filledSizeByOrderId.get(key)!
        : order.status === "filled"
          ? order.size
          : 0;
      soldShares += filled;
      if (!isWorkingSellOrderStatus(order.status ?? null)) continue;
      const remaining = Math.max(0, order.size - filled);
      openCommitment += remaining;
      if (remaining > 0) hasOpenBounceRung = true;
    }
    return { soldShares, openCommitment, hasOpenBounceRung };
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
        continue;
      }
      if (sideEffect.kind === "track_q_shadow") {
        this.recordTrackQShadowSideEffect(sideEffect);
      }
      if (sideEffect.kind === "track_q_d") {
        this.recordQdShadowSideEffect(sideEffect);
      }
      if (sideEffect.kind === "maker_entry_shadow_open") {
        this.openMakerShadow(sideEffect, executionPolicy);
      }
      if (sideEffect.kind === "sell_loop_guard_suppressed") {
        this.deps.runtimeMetrics?.writeCounter(
          "track_q_loop_guard_suppressed_total",
          1,
          JSON.stringify({ decisionRuleId: sideEffect.decisionRuleId }),
        );
      }
      if (sideEffect.kind === "s1_ownership_blocked_sell") {
        this.deps.runtimeMetrics?.writeCounter(
          "track_s1_ownership_blocked_planner_sell",
          1,
          JSON.stringify({
            decisionRuleId: sideEffect.decisionRuleId,
            ownershipReason: sideEffect.ownershipReason,
          }),
        );
      }
      if (sideEffect.kind === "d9_suppressed_on_profile_owned") {
        this.deps.runtimeMetrics?.writeCounter("d9_suppressed_on_profile_owned", 1);
        this.deps.runtimeMetrics?.writeCounter("d9_would_have_fired_on_profile_owned", 1);
        if (!this.shouldPersistD9ProfileOwnedSuppressionEvent(sideEffect)) continue;
        this.persistence.enqueueRiskEvent({
          eventType: "d9_suppressed_on_profile_owned",
          payload: {
            tokenId: String(sideEffect.tokenId),
            conditionId: sideEffect.conditionId,
            decisionRuleId: sideEffect.decisionRuleId,
            price: sideEffect.price,
            state: sideEffect.state,
            d9Reason: sideEffect.d9Reason,
            emissionFacts: sideEffect.emissionFacts,
            signalTimestamp: sideEffect.timestamp,
          },
        });
      }
      if (sideEffect.kind === "legacy_guard_fired_on_profile_owned") {
        this.deps.runtimeMetrics?.writeCounter(
          "legacy_guard_fired_on_profile_owned",
          1,
          JSON.stringify({ guard: sideEffect.guard }),
        );
        if (!this.shouldPersistLegacyProfileOwnedGuardEvent(sideEffect)) continue;
        this.persistence.enqueueRiskEvent({
          eventType: "legacy_guard_fired_on_profile_owned",
          payload: {
            guard: sideEffect.guard,
            tokenId: String(sideEffect.tokenId),
            conditionId: sideEffect.conditionId,
            decisionRuleId: sideEffect.decisionRuleId,
            proposedPrice: sideEffect.proposedPrice,
            avgEntryPrice: sideEffect.avgEntryPrice,
            state: sideEffect.state,
            emissionFacts: sideEffect.emissionFacts,
            signalTimestamp: sideEffect.timestamp,
          },
        });
      }
      if (sideEffect.kind === "static_rule_sell_below_avg_entry_suppressed") {
        this.deps.runtimeMetrics?.writeCounter(
          "static_rule_sell_below_avg_entry_suppressed",
          1,
          JSON.stringify({ decisionRuleId: sideEffect.decisionRuleId }),
        );
        if (!this.shouldPersistStaticRuleSellBelowAvgEntryEvent(sideEffect)) continue;
        this.persistence.enqueueRiskEvent({
          eventType: "static_rule_sell_below_avg_entry_suppressed",
          payload: {
            decisionRuleId: sideEffect.decisionRuleId,
            tokenId: String(sideEffect.tokenId),
            conditionId: sideEffect.conditionId,
            avgEntryPrice: sideEffect.avgEntryPrice,
            proposedPrice: sideEffect.proposedPrice,
            floor: sideEffect.floor,
            entryFloorPrice: sideEffect.entryFloorPrice,
            positiveFloorPrice: sideEffect.positiveFloorPrice,
            profileLadderOwned: true,
            state: sideEffect.state,
            emissionFacts: sideEffect.emissionFacts,
            signalTimestamp: sideEffect.timestamp,
          },
        });
      }
      if (sideEffect.kind === "stock_close_tail_size_damp") {
        const metricName =
          sideEffect.action === "skip"
            ? "stock_close_yes_tail_size_damp_skipped_total"
            : sideEffect.action === "telemetry"
              ? "stock_close_yes_tail_size_damp_telemetry_total"
              : "stock_close_yes_tail_size_damp_applied_total";
        this.deps.runtimeMetrics?.writeCounter(
          metricName,
          1,
          JSON.stringify({
            reason: sideEffect.reason,
            marketClass: sideEffect.marketClass,
            confidence: sideEffect.confidence,
            thresholdBucket: sideEffect.thresholdBucket,
            action: sideEffect.action,
          }),
        );
        this.persistence.enqueueRiskEvent({
          eventType: `stock_close_yes_tail_size_damp_${sideEffect.action}`,
          payload: {
            tokenId: String(sideEffect.tokenId),
            conditionId: sideEffect.conditionId,
            decisionRuleId: sideEffect.decisionRuleId,
            reason: sideEffect.reason,
            baseSizeUsdc: sideEffect.baseSizeUsdc,
            dampedSizeUsdc: sideEffect.dampedSizeUsdc,
            rangePct: sideEffect.rangePct,
            marketClass: sideEffect.marketClass,
            confidence: sideEffect.confidence,
            thresholdBucket: sideEffect.thresholdBucket,
            signalTimestamp: sideEffect.timestamp,
          },
        });
      }
    }
  }

  private shouldPersistLegacyProfileOwnedGuardEvent(
    sideEffect: Extract<DecisionPlanSideEffect, { kind: "legacy_guard_fired_on_profile_owned" }>,
  ): boolean {
    const eventAt = Date.parse(sideEffect.timestamp);
    const now = Number.isFinite(eventAt) ? eventAt : Date.now();
    const key = [
      "legacy_guard_fired_on_profile_owned",
      sideEffect.guard,
      String(sideEffect.tokenId),
      sideEffect.decisionRuleId,
      sideEffect.state,
    ].join("|");
    return this.dedupeAllows(this.legacyProfileOwnedGuardDedupe, key, now);
  }

  private shouldPersistStaticRuleSellBelowAvgEntryEvent(
    sideEffect: Extract<
      DecisionPlanSideEffect,
      { kind: "static_rule_sell_below_avg_entry_suppressed" }
    >,
  ): boolean {
    const eventAt = Date.parse(sideEffect.timestamp);
    const now = Number.isFinite(eventAt) ? eventAt : Date.now();
    const key = [
      "static_rule_sell_below_avg_entry_suppressed",
      String(sideEffect.tokenId),
      sideEffect.decisionRuleId,
      sideEffect.state,
    ].join("|");
    return this.dedupeAllows(this.staticRuleSellBelowAvgEntryDedupe, key, now);
  }

  private shouldPersistD9ProfileOwnedSuppressionEvent(
    sideEffect: Extract<DecisionPlanSideEffect, { kind: "d9_suppressed_on_profile_owned" }>,
  ): boolean {
    const eventAt = Date.parse(sideEffect.timestamp);
    const now = Number.isFinite(eventAt) ? eventAt : Date.now();
    const key = [
      "d9_suppressed_on_profile_owned",
      String(sideEffect.tokenId),
      sideEffect.decisionRuleId,
      sideEffect.state,
      sideEffect.d9Reason,
      this.d9PriceBucket(sideEffect.price),
    ].join("|");
    return this.dedupeAllows(
      this.d9ProfileOwnedSuppressionDedupe,
      key,
      now,
      D9_PROFILE_OWNED_RISK_EVENT_DEDUPE_MS,
    );
  }

  /**
   * Track Q shadow telemetry sink (observe-only). Updates the non-deduped
   * cumulative counters surfaced via healthCheck, then persists a deduped,
   * structured `track_q_shadow` risk event so the unproven P3 tier floor can
   * be analysed offline against live wide-book SELLs. Never touches the order
   * price, the SELL suppression, D8, the spread threshold, or D9.
   */
  private recordTrackQShadowSideEffect(
    sideEffect: Extract<DecisionPlanSideEffect, { kind: "track_q_shadow" }>,
  ): void {
    const { projection } = sideEffect;
    const counters = this.trackQShadow;
    counters.evals += 1;
    counters.tokens.add(String(sideEffect.tokenId));
    counters.byReason.set(projection.reason, (counters.byReason.get(projection.reason) ?? 0) + 1);
    if (projection.p3WouldActivate) counters.wouldActivate += 1;
    if (projection.proposedGuardWouldSuppress) counters.proposedStillSuppressed += 1;
    // Emitted shadow events are gated on currentGuardWouldSuppress in the
    // planner, so "would clear" = the proposed 1.636 threshold no longer fires.
    if (projection.currentGuardWouldSuppress && !projection.proposedGuardWouldSuppress) {
      counters.suppressionWouldClear += 1;
    }
    if (projection.d8FireWouldChange) counters.d8FireWouldChange += 1;

    // Sub-Track Q.A — durably persist the non-deduped eval counters as summable
    // deltas (recovered offline via SUM), so the per-eval denominator survives a
    // restart. The shared writer batches these and flushes centrally (index.ts).
    // `tokens` is intentionally NOT persisted here: a distinct-set is not
    // summable across flushes — recover it from the deduped risk_events instead.
    const metrics = this.deps.runtimeMetrics;
    if (metrics) {
      metrics.writeCounter("track_q_shadow_evals_total", 1);
      metrics.writeCounter(
        "track_q_shadow_by_reason_total",
        1,
        JSON.stringify({ reason: projection.reason }),
      );
      if (projection.p3WouldActivate)
        metrics.writeCounter("track_q_shadow_would_activate_total", 1);
      if (projection.proposedGuardWouldSuppress) {
        metrics.writeCounter("track_q_shadow_proposed_still_suppressed_total", 1);
      }
      if (projection.currentGuardWouldSuppress && !projection.proposedGuardWouldSuppress) {
        metrics.writeCounter("track_q_shadow_suppression_would_clear_total", 1);
      }
      if (projection.d8FireWouldChange) {
        metrics.writeCounter("track_q_shadow_d8_fire_would_change_total", 1);
      }
    }

    const eventAt = Date.parse(sideEffect.timestamp);
    const now = Number.isFinite(eventAt) ? eventAt : Date.now();
    const key = `track_q_shadow|${String(sideEffect.tokenId)}|${projection.reason}`;
    if (!this.dedupeAllows(this.trackQShadowDedupe, key, now)) return;

    this.persistence.enqueueRiskEvent({
      eventType: "track_q_shadow",
      payload: {
        tokenId: String(sideEffect.tokenId),
        conditionId: sideEffect.conditionId,
        evalPrice: sideEffect.evalPrice,
        p3WouldActivate: projection.p3WouldActivate,
        reason: projection.reason,
        spreadMidRatio: projection.spreadMidRatio,
        bidAskRatio: projection.bidAskRatio,
        bidAnchoredPrice: projection.bidAnchoredPrice,
        tierMarkup: projection.tierMarkup,
        tierTarget: projection.tierTarget,
        insideAsk: projection.insideAsk,
        p3CandidatePrice: projection.p3CandidatePrice,
        avgEntry: projection.avgEntry,
        currentGuardWouldSuppress: projection.currentGuardWouldSuppress,
        proposedGuardWouldSuppress: projection.proposedGuardWouldSuppress,
        d8FireAtCurrentPrice: projection.d8FireAtCurrentPrice,
        d8FireAtP3Candidate: projection.d8FireAtP3Candidate,
        d8FireWouldChange: projection.d8FireWouldChange,
        signalTimestamp: sideEffect.timestamp,
      },
    });
  }

  /**
   * Sub-Track Q.D shadow telemetry sink (observe-only). Updates the non-deduped
   * cumulative counters surfaced via healthCheck, persists summable eval deltas
   * to runtime_metrics, then enqueues a deduped, structured `track_q_d` risk
   * event so the would-fire rate, Mode A/B distribution, bid quality, and
   * D8/D9 collision rate can be sized offline before any enforcement. Never
   * touches the order price, suppressions, the signal, D8, or D9.
   */
  private recordQdShadowSideEffect(
    sideEffect: Extract<DecisionPlanSideEffect, { kind: "track_q_d" }>,
  ): void {
    const { projection } = sideEffect;
    const counters = this.trackQdShadow;
    counters.evals += 1;
    counters.tokens.add(String(sideEffect.tokenId));
    counters.byReason.set(projection.reason, (counters.byReason.get(projection.reason) ?? 0) + 1);
    if (projection.qdWouldActivate) counters.wouldActivate += 1;
    if (projection.activationMode === "mode_a") counters.modeA += 1;
    if (projection.activationMode === "mode_b_salvage") counters.modeB += 1;
    if (projection.d8Fired || projection.d9Fired) counters.d8OrD9Collision += 1;

    // Durably persist non-deduped eval counters as summable deltas (recovered
    // offline via SUM), so the per-eval denominator survives a restart. Distinct
    // token/applicability sets are not summable across flushes — recover those
    // from the deduped risk_events instead.
    const metrics = this.deps.runtimeMetrics;
    if (metrics) {
      metrics.writeCounter("track_q_d_shadow_evals_total", 1);
      metrics.writeCounter(
        "track_q_d_shadow_by_reason_total",
        1,
        JSON.stringify({ reason: projection.reason }),
      );
      if (projection.qdWouldActivate)
        metrics.writeCounter("track_q_d_shadow_would_activate_total", 1);
      if (projection.activationMode === "mode_a")
        metrics.writeCounter("track_q_d_shadow_mode_a_total", 1);
      if (projection.activationMode === "mode_b_salvage")
        metrics.writeCounter("track_q_d_shadow_mode_b_total", 1);
      if (projection.modeAApplies) metrics.writeCounter("track_q_d_shadow_mode_a_applies_total", 1);
      if (projection.modeBApplies) metrics.writeCounter("track_q_d_shadow_mode_b_applies_total", 1);
      if (projection.d8Fired || projection.d9Fired) {
        metrics.writeCounter("track_q_d_shadow_d8_or_d9_collision_total", 1);
      }
    }

    const eventAt = Date.parse(sideEffect.timestamp);
    const now = Number.isFinite(eventAt) ? eventAt : Date.now();
    const key = `track_q_d|${String(sideEffect.tokenId)}|${projection.reason}`;
    if (!this.dedupeAllows(this.trackQdShadowDedupe, key, now)) return;

    this.persistence.enqueueRiskEvent({
      eventType: "track_q_d",
      payload: {
        tokenId: String(sideEffect.tokenId),
        conditionId: sideEffect.conditionId,
        qdWouldActivate: projection.qdWouldActivate,
        reason: projection.reason,
        activationMode: projection.activationMode,
        avgEntry: projection.avgEntry,
        ttcMs: projection.ttcMs,
        shortMarket: projection.shortMarket,
        withinTtc: projection.withinTtc,
        imminentTtc: projection.imminentTtc,
        qualifyingBid: projection.qualifyingBid,
        bidVsAvgEntry: projection.bidVsAvgEntry,
        modeAApplies: projection.modeAApplies,
        modeBApplies: projection.modeBApplies,
        d8Fired: projection.d8Fired,
        d9Fired: projection.d9Fired,
        bestBid: projection.bestBid,
        anchorTicks: projection.anchorTicks,
        bidAnchoredPrice: projection.bidAnchoredPrice,
        f2Cap: projection.f2Cap,
        candidatePrice: projection.candidatePrice,
        signalTimestamp: sideEffect.timestamp,
      },
    });
  }

  // ─── Phase 3: Maker-entry shadow tracker ────────────────────────────────────

  /**
   * Load open rows from DB into the in-memory maps at startup.
   * For each unique ladderId among open rows, load ALL levels (open + terminal)
   * so the tracker can reconstruct correct next-index and shouldOpenNextLevel
   * even when some levels are already in a terminal state.
   */
  private hydrateMakerShadowOrders(): void {
    const repo = this.deps.makerShadowOrderRepo;
    if (!repo) return;

    const openRows = repo.findOpen();
    // Group open rows by ladderId to identify active ladders
    const ladderIds = new Set(openRows.map((r) => r.ladderId));

    for (const ladderId of ladderIds) {
      const allLevels = repo.findLadder(ladderId);
      if (allLevels.length === 0) continue;
      const tokenStr = String(allLevels[0]!.tokenId);
      this.makerShadowLadders.set(tokenStr, { ladderId, levels: allLevels });
    }
    for (const row of openRows) {
      this.makerShadowOpen.set(row.shadowOrderId, row);
    }

    if (openRows.length > 0) {
      this.log.info(
        { openRows: openRows.length, ladders: ladderIds.size },
        "maker-entry shadow: hydrated open rows",
      );
    }
  }

  /** Persist + register a new pending shadow level 0 (from the planner's R23 side effect). */
  private openMakerShadow(
    sideEffect: Extract<DecisionPlanSideEffect, { kind: "maker_entry_shadow_open" }>,
    executionPolicy: ExecutionPolicy | null,
  ): void {
    if (executionPolicy?.makerEntry.mode === "off") return;
    const repo = this.deps.makerShadowOrderRepo;
    if (!repo) return;

    const tokenStr = String(sideEffect.tokenId);
    // Skip if the token already has open (pending/filled) levels — levels 1..N
    // are opened by the scale-in path in advanceMakerShadows, not by R23.
    if (this.hasOpenLevelsForToken(tokenStr)) return;

    const fillWaitMs = executionPolicy?.makerEntry.fillWaitMs ?? 300_000;
    const fillDeadlineMs = Date.parse(sideEffect.timestamp) + fillWaitMs;
    const shadowOrderId = computeShadowOrderId(tokenStr, sideEffect.timestamp);
    // Idempotent: skip if the deterministic ID already exists in the open set
    if (this.makerShadowOpen.has(shadowOrderId)) return;

    const order: MakerShadowOrder = {
      shadowOrderId,
      tokenId: sideEffect.tokenId,
      conditionId: sideEffect.conditionId,
      buyPx: sideEffect.buyPx,
      harvestPx: sideEffect.harvestPx,
      postedAt: sideEffect.timestamp,
      fillDeadline: new Date(fillDeadlineMs).toISOString(),
      stage: "pending",
      fillKind: null,
      fillPx: null,
      markPx: null,
      netMark: null,
      ladderId: shadowOrderId, // level 0: ladderId === shadowOrderId
      levelIndex: 0,
      filledAt: null,
      updatedAt: sideEffect.timestamp,
    };
    try {
      repo.upsert(order);
    } catch (err) {
      this.log.warn({ err, shadowOrderId }, "maker-entry shadow: failed to persist open row");
      return;
    }
    this.makerShadowOpen.set(shadowOrderId, order);
    // Start a new per-token ladder; overwrite any fully-terminal prior ladder.
    this.makerShadowLadders.set(tokenStr, { ladderId: shadowOrderId, levels: [order] });

    this.deps.runtimeMetrics?.writeCounter("maker_entry_shadow_opened_total", 1);
    this.persistence.enqueueRiskEvent({
      eventType: "maker_entry_shadow",
      payload: {
        transition: "opened",
        shadowOrderId,
        ladderId: shadowOrderId,
        levelIndex: 0,
        tokenId: tokenStr,
        conditionId: sideEffect.conditionId,
        buyPx: sideEffect.buyPx,
        harvestPx: sideEffect.harvestPx,
        postedAt: sideEffect.timestamp,
        fillDeadline: order.fillDeadline,
        r23Ratio: sideEffect.r23Ratio,
        r23MaxMidpoint: sideEffect.r23MaxMidpoint,
      },
    });
  }

  /** True when the token has at least one non-terminal (pending or filled) level. */
  private hasOpenLevelsForToken(tokenStr: string): boolean {
    for (const s of this.makerShadowOpen.values()) {
      if (String(s.tokenId) === tokenStr) return true;
    }
    return false;
  }

  /**
   * Advance all open shadow orders using the latest market data from the cache,
   * then check whether any active ladder should open a new scale-in level.
   * Called once per evaluation tick (after plans are processed).
   *
   * `executionPolicy` — hot-reloaded snapshot; gates mode and supplies policy
   * values (holdWindowMs, fillWaitMs, bidImproveTicks, scaleInStepPct, ...).
   */
  private advanceMakerShadows(now: number, executionPolicy: ExecutionPolicy | null): void {
    if (this.makerShadowOpen.size === 0 && this.makerShadowLadders.size === 0) return;
    const repo = this.deps.makerShadowOrderRepo;
    if (!repo) return;

    const nowIso = new Date(now).toISOString();
    const holdWindowMs = executionPolicy?.makerEntry.holdWindowMs ?? 10_800_000;

    // ── BBO fallback: snapshot lookup for tokens with absent or unusable live BBO ──
    // Tokens churned out of the WS subscription (TrackedMarketsChanged.removedTokenIds)
    // have their marketCache entry deleted. Additionally, a token may be in the cache
    // but with null/NaN/∞ bestBid or bestAsk (e.g. a stale pricing tick before the
    // first real update). Both cases are captured here so the snapshot fallback
    // covers the real failure mode, not just the cache-miss case.
    // ONE batched DB lookup is done per tick; live cache is always preferred when valid.
    const isLiveBboUsable = (tokenStr: string): boolean => {
      const live = this.marketCache.get(tokenStr);
      if (!live) return false;
      const bid = live.bestBid;
      const ask = live.bestAsk;
      return (
        typeof bid === "number" &&
        Number.isFinite(bid) &&
        bid > 0 &&
        typeof ask === "number" &&
        Number.isFinite(ask) &&
        ask > bid
      );
    };
    const missingTokenIds: TokenId[] = [];
    for (const [, shadow] of this.makerShadowOpen) {
      const tokenStr = String(shadow.tokenId);
      if (!isLiveBboUsable(tokenStr)) missingTokenIds.push(shadow.tokenId);
    }
    for (const tokenStr of this.makerShadowLadders.keys()) {
      if (!isLiveBboUsable(tokenStr)) missingTokenIds.push(tokenStr as TokenId);
    }
    type SnapshotBboEntry = {
      bestBid: number | null;
      bestAsk: number | null;
      tickSize: number | null;
    };
    const snapshotBbo: Map<string, SnapshotBboEntry> = new Map<string, SnapshotBboEntry>();
    if (missingTokenIds.length > 0 && this.deps.marketSnapshotRepo) {
      const fetched = this.deps.marketSnapshotRepo.findLatestBboByTokens(missingTokenIds);
      for (const [k, v] of fetched) snapshotBbo.set(k, v);
    }

    /**
     * Resolve a valid BBO for a token: prefer live marketCache (when valid),
     * fall back to snapshot. A BBO is valid only when bestBid and bestAsk are
     * both finite, bestBid > 0, and bestAsk > bestBid (non-crossed book).
     * NaN or ±Infinity values are treated as unusable to prevent NaN marks.
     */
    const resolveBbo = (tokenStr: string): { bestBid: number; bestAsk: number } | null => {
      // Try live cache first
      if (isLiveBboUsable(tokenStr)) {
        const live = this.marketCache.get(tokenStr)!;
        return { bestBid: live.bestBid as number, bestAsk: live.bestAsk as number };
      }
      // Fall back to snapshot BBO
      const snap = snapshotBbo.get(tokenStr);
      if (!snap) return null;
      const { bestBid, bestAsk } = snap;
      if (
        typeof bestBid !== "number" ||
        !Number.isFinite(bestBid) ||
        bestBid <= 0 ||
        typeof bestAsk !== "number" ||
        !Number.isFinite(bestAsk) ||
        bestAsk <= bestBid
      )
        return null;
      return { bestBid, bestAsk };
    };

    // ── Advance existing open levels ──────────────────────────────────────────
    for (const [shadowOrderId, shadow] of this.makerShadowOpen) {
      const tokenStr = String(shadow.tokenId);
      const bbo = resolveBbo(tokenStr);

      // Resolve the market view fed to advanceShadowOrder:
      //  • valid BBO (live or snapshot) → full advance: fill / harvest / mark / expire.
      //    advanceShadowOrder reads only bestBid/bestAsk; overlay the resolved BBO so a
      //    cache entry with null/NaN BBO uses the validated snapshot values, not the
      //    unusable live ones. (`live ?? stand-in` was wrong: when live IS present but
      //    carries null/NaN BBO, the ?? short-circuits and passes the broken values on.)
      //  • no BBO but the level is pending → a null-book view so the purely time-based
      //    expiry (now >= fillDeadline) still runs. Fill checks need a book and are
      //    correct no-ops on a null book. Without this, orders on dead/churned markets
      //    (no live BBO, snapshot older than the 30-min cutoff) never expire and linger
      //    in the open set forever.
      //  • no BBO and the level is filled → skip: marking needs a book, and marking at a
      //    null price on a transient BBO gap would corrupt the measurement.
      let marketForAdvance: NormalizedMarket | null;
      if (bbo) {
        const live = this.marketCache.get(tokenStr);
        marketForAdvance = live
          ? { ...live, bestBid: bbo.bestBid, bestAsk: bbo.bestAsk }
          : ({ bestBid: bbo.bestBid, bestAsk: bbo.bestAsk } as NormalizedMarket);
      } else if (shadow.stage === "pending") {
        marketForAdvance = { bestBid: null, bestAsk: null } as NormalizedMarket;
      } else {
        marketForAdvance = null;
      }
      if (!marketForAdvance) continue;

      const outcome = advanceShadowOrder(shadow, marketForAdvance, nowIso, holdWindowMs);
      if (!outcome.transition) continue;

      const updated: MakerShadowOrder = { ...shadow, ...outcome.update };
      try {
        repo.updateStage(shadowOrderId, outcome.update);
      } catch (err) {
        this.log.warn({ err, shadowOrderId }, "maker-entry shadow: failed to persist stage update");
        continue;
      }

      // Keep the ladder state in sync with the updated level
      const ladder = this.makerShadowLadders.get(tokenStr);
      if (ladder) {
        ladder.levels = ladder.levels.map((l) => (l.shadowOrderId === shadowOrderId ? updated : l));
      }

      // Remove from open set when terminal; keep for filled (harvest/mark next tick)
      if (
        updated.stage === "harvested" ||
        updated.stage === "marked" ||
        updated.stage === "expired"
      ) {
        this.makerShadowOpen.delete(shadowOrderId);
      } else {
        this.makerShadowOpen.set(shadowOrderId, updated);
      }

      this.emitMakerShadowTransition(updated, outcome.update.stage);
    }

    // ── Scale-in: open next levels where conditions are met ───────────────────
    // Gated on mode !== "off" so a hot-reload to off immediately stops new levels.
    if (executionPolicy?.makerEntry.mode === "off") return;
    if (!executionPolicy) return;

    for (const [tokenStr, ladderState] of this.makerShadowLadders) {
      // Skip if no open levels — the ladder is fully terminal; a new R23 will
      // start a fresh ladder.
      const hasOpen = ladderState.levels.some((l) => l.stage === "pending" || l.stage === "filled");
      if (!hasOpen) continue;

      const bbo = resolveBbo(tokenStr);
      if (!bbo) continue;

      // conditionId: from live market if present, else from the first ladder level
      // (always stored on MakerShadowOrder). tickSize: from live market when present,
      // then from the snapshot's markets JOIN (which returns the token's real tick), then
      // last-resort default 0.01 (standard Polymarket tick for binary markets).
      // Using the real tick is critical: maker tokens may have tick=0.001, and a wrong
      // tick shifts buyPx computation, preventing valid scale-in entries from opening.
      const live = this.marketCache.get(tokenStr);
      const conditionId = live?.conditionId ?? ladderState.levels[0]?.conditionId ?? "";
      const tickSize = live?.tickSize ?? snapshotBbo.get(tokenStr)?.tickSize ?? 0.01;

      const book = {
        bestBid: bbo.bestBid,
        bestAsk: bbo.bestAsk,
        tickSize,
      };
      const newLevel = openNextLevelOrder(
        ladderState,
        tokenStr,
        conditionId,
        book,
        executionPolicy.makerEntry,
        nowIso,
      );
      if (!newLevel) continue;
      // Idempotent: skip if already in-flight (same deterministic ID)
      if (this.makerShadowOpen.has(newLevel.shadowOrderId)) continue;

      try {
        repo.upsert(newLevel);
      } catch (err) {
        this.log.warn(
          { err, shadowOrderId: newLevel.shadowOrderId },
          "maker-entry shadow: failed to persist scale-in level",
        );
        continue;
      }

      this.makerShadowOpen.set(newLevel.shadowOrderId, newLevel);
      ladderState.levels.push(newLevel);

      this.deps.runtimeMetrics?.writeCounter("maker_entry_shadow_opened_total", 1);
      // Depth-tagged counter (level_index ≥ 1): lets the read-back chart scale-in
      // depth distribution without querying the full maker_shadow_orders table.
      this.deps.runtimeMetrics?.writeCounter(
        "maker_entry_shadow_level_opened_total",
        1,
        JSON.stringify({ level_index: newLevel.levelIndex }),
      );
      this.persistence.enqueueRiskEvent({
        eventType: "maker_entry_shadow",
        payload: {
          transition: "opened",
          shadowOrderId: newLevel.shadowOrderId,
          ladderId: ladderState.ladderId,
          levelIndex: newLevel.levelIndex,
          tokenId: tokenStr,
          conditionId,
          buyPx: newLevel.buyPx,
          harvestPx: newLevel.harvestPx,
          postedAt: nowIso,
          fillDeadline: newLevel.fillDeadline,
        },
      });
    }
  }

  private emitMakerShadowTransition(
    order: MakerShadowOrder,
    transition: "filled" | "harvested" | "marked" | "expired",
  ): void {
    const metricName = `maker_entry_shadow_${transition}_total`;
    const labels =
      transition === "filled"
        ? JSON.stringify({ fillKind: order.fillKind ?? "unknown" })
        : undefined;
    this.deps.runtimeMetrics?.writeCounter(metricName, 1, labels);
    this.persistence.enqueueRiskEvent({
      eventType: "maker_entry_shadow",
      payload: {
        transition,
        shadowOrderId: order.shadowOrderId,
        tokenId: String(order.tokenId),
        conditionId: order.conditionId,
        buyPx: order.buyPx,
        harvestPx: order.harvestPx,
        stage: order.stage,
        fillKind: order.fillKind,
        fillPx: order.fillPx,
        markPx: order.markPx,
        netMark: order.netMark,
        updatedAt: order.updatedAt,
      },
    });
  }

  /** TTL prune: remove expired rows older than 48 h from DB. */
  private maybePruneMakerShadows(): void {
    const repo = this.deps.makerShadowOrderRepo;
    if (!repo) return;
    const now = Date.now();
    const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1h
    if (now - this.makerShadowLastPruneAt < PRUNE_INTERVAL_MS) return;
    this.makerShadowLastPruneAt = now;
    const cutoff = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    try {
      const pruned = repo.pruneExpired(cutoff);
      if (pruned > 0) {
        this.log.info({ pruned, cutoff }, "maker-entry shadow: pruned expired rows");
      }
    } catch (err) {
      this.log.warn({ err }, "maker-entry shadow: prune failed");
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
      positionId: draft.positionId ?? null,
      ...(draft.bounceRung ? { bounceRung: draft.bounceRung } : {}),
    };
    const entryFreshEdgeTelemetry =
      signal.side === "buy"
        ? this.computeEntryFreshEdgeTelemetry(draft.market, now, signal, draft.logDraft.buyCount)
        : null;
    attachEntryFreshEdgeAttribution(signal, entryFreshEdgeTelemetry);
    const entryCategoryTelemetry =
      signal.side === "buy"
        ? this.computeEntryCategoryGateTelemetry(draft.market, now, signal, draft.logDraft.buyCount)
        : null;
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
            entryFreshEdgeKind: entryFreshEdgeTelemetry?.entryFreshEdgeKind ?? null,
            entryFreshEdgeShadowClass: entryFreshEdgeTelemetry?.entryFreshEdgeShadowClass ?? null,
            entryFreshEdgePayloadJson: entryFreshEdgeTelemetry?.entryFreshEdgePayloadJson ?? null,
            entryCategory: entryCategoryTelemetry?.entryCategory ?? null,
            entryCategoryGateClass: entryCategoryTelemetry?.entryCategoryGateClass ?? null,
            entryCategoryPayloadJson: entryCategoryTelemetry?.entryCategoryPayloadJson ?? null,
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
      r23Memory: this.deps.priceHistoryProvider?.snapshotMemoryMetrics?.(now) ?? null,
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
      if (this.findOpenPositionByTokenId(tokenId)) {
        const state = this.deps.legStateRepo.get(tokenId);
        this.legStateCache.set(key, state);
        return state;
      }
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
      const openPosition = this.findOpenPositionByTokenId(tokenId);
      if (openPosition) return openPosition;
      this.positionCache.set(key, null);
      return null;
    }
    const position = this.deps.positionRepo?.findByTokenId(tokenId) ?? null;
    this.positionCache.set(key, position);
    return position;
  }

  private findOpenPositionByTokenId(tokenId: TokenId): Position | null {
    const key = String(tokenId);
    const cached = this.positionCache.get(key);
    if (isOpenPosition(cached)) return cached;
    const position = this.deps.positionRepo?.findByTokenId(tokenId) ?? null;
    if (isOpenPosition(position)) {
      this.positionCache.set(key, position);
      return position;
    }
    return null;
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

    const position = side === "sell" ? this.getCachedPosition(market.tokenId) : null;
    const sellPlan =
      side === "sell" && position
        ? computeSellSizingPlan({
            position,
            sellCount: this.getCachedLegState(market.tokenId)?.sellCount ?? 0,
            price: ctx.price,
            nowMs: now,
            marketMinOrderSize: market.minOrderSize,
            latestSellOrder: this.getLatestSellOrderForSizing(market.tokenId),
            sellTimeoutMs: this.deps.executionPolicy?.().sellTimeoutMs,
          })
        : null;
    const suggestedSizeUsdc = sellPlan?.sizeUsdc ?? sizeResult.sizeUsdc;
    const suggestedSize = sellPlan?.size ?? (ctx.price > 0 ? suggestedSizeUsdc / ctx.price : 0);

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
    const entryFreshEdgeTelemetry =
      side === "buy" ? this.computeEntryFreshEdgeTelemetry(market, now, signal, buyCount) : null;
    attachEntryFreshEdgeAttribution(signal, entryFreshEdgeTelemetry);
    const entryCategoryTelemetry =
      side === "buy" ? this.computeEntryCategoryGateTelemetry(market, now, signal, buyCount) : null;

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
          entryFreshEdgeKind: entryFreshEdgeTelemetry?.entryFreshEdgeKind ?? null,
          entryFreshEdgeShadowClass: entryFreshEdgeTelemetry?.entryFreshEdgeShadowClass ?? null,
          entryFreshEdgePayloadJson: entryFreshEdgeTelemetry?.entryFreshEdgePayloadJson ?? null,
          entryCategory: entryCategoryTelemetry?.entryCategory ?? null,
          entryCategoryGateClass: entryCategoryTelemetry?.entryCategoryGateClass ?? null,
          entryCategoryPayloadJson: entryCategoryTelemetry?.entryCategoryPayloadJson ?? null,
        },
        emissionFacts,
        triggerTelemetry,
      );
    };

    return { type: "signal", signal, market, commitLog };
  }

  private computeEntryFreshEdgeTelemetry(
    market: NormalizedMarket,
    now: number,
    signal: import("@krabs/domain").Signal,
    buyCount: number,
  ): EntryFreshEdgeSignalFields | null {
    try {
      const policy = this.deps.executionPolicy?.();
      const marketAgeThresholdSeconds =
        buyCount === 0 && policy ? policy.entryMinMarketAgeSeconds : null;
      const marketAgeSeconds = computeMarketAgeSeconds(market.gammaCreatedAt, now);
      const marketAgeGatePassed =
        marketAgeThresholdSeconds != null
          ? evaluateMinMarketAge({
              gammaCreatedAt: market.gammaCreatedAt ?? null,
              thresholdSeconds: marketAgeThresholdSeconds,
              nowMs: now,
            }).ok
          : null;
      const provider = this.deps.priceHistoryProvider;
      return computeEntryFreshEdgeSignalFields({
        market,
        nowMs: now,
        decisionRuleId: signal.decisionRuleId,
        signalReason: signal.reason,
        buyCount,
        marketAgeSeconds,
        marketAgeThresholdSeconds,
        marketAgeGatePassed,
        windowStats: {
          "1h":
            provider?.midpointStatsInWindow?.(
              market.tokenId,
              ENTRY_FRESH_EDGE_WINDOW_MS["1h"],
              now,
            ) ?? null,
          "6h":
            provider?.midpointStatsInWindow?.(
              market.tokenId,
              ENTRY_FRESH_EDGE_WINDOW_MS["6h"],
              now,
            ) ?? null,
          "24h":
            provider?.midpointStatsInWindow?.(
              market.tokenId,
              ENTRY_FRESH_EDGE_WINDOW_MS["24h"],
              now,
            ) ?? null,
        },
      });
    } catch (err) {
      this.log.warn(
        {
          tokenId: String(market.tokenId),
          err: err instanceof Error ? err.message : String(err),
        },
        "entry fresh-edge telemetry failed",
      );
      return null;
    }
  }

  private computeEntryCategoryGateTelemetry(
    market: NormalizedMarket,
    now: number,
    signal: import("@krabs/domain").Signal,
    buyCount: number,
  ): EntryCategoryGateSignalFields | null {
    try {
      return computeEntryCategoryGateSignalFields({
        market,
        nowMs: now,
        decisionRuleId: signal.decisionRuleId,
        signalReason: signal.reason,
        buyCount,
      });
    } catch (err) {
      this.log.warn(
        {
          tokenId: String(market.tokenId),
          err: err instanceof Error ? err.message : String(err),
        },
        "entry category-gate telemetry failed",
      );
      return null;
    }
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
    const payload = this.buildSuppressionPayload(facts);
    this.deps.runtimeMetrics?.writeCounter(
      "track_planner_suppressed_total",
      1,
      JSON.stringify({ reason: facts.reasonCode }),
    );
    if (
      this.plannerRollup.record({
        tokenId: String(facts.tokenId),
        conditionId: facts.conditionId,
        reasonCode: facts.reasonCode,
        decisionRuleId: facts.decisionRuleId ?? null,
        side: facts.side ?? null,
        sample: payload,
      })
    ) {
      return;
    }
    if (!this.shouldPersistSuppressionEvent(facts)) return;

    this.persistence.enqueueRiskEvent({
      eventType: "signal_suppressed",
      payload,
    });
  }

  private buildSuppressionPayload(facts: SuppressionFacts): Record<string, unknown> {
    return {
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
      ...(facts.extra ?? {}),
      signalTimestamp: facts.timestamp,
    };
  }

  private shouldPersistSuppressionEvent(facts: SuppressionFacts): boolean {
    if (!DEDUPED_SUPPRESSION_REASONS.has(facts.reasonCode)) return true;

    const eventAt = Date.parse(facts.timestamp);
    const now = Number.isFinite(eventAt) ? eventAt : Date.now();
    return this.dedupeAllows(this.suppressionDedupe, this.suppressionDedupeKey(facts), now);
  }

  /**
   * Sliding-window dedupe shared by suppression telemetry and Track Q shadow
   * telemetry. Returns true the first time `key` is seen within
   * NOISY_SUPPRESSION_DEDUPE_MS (recording `now`), false while the window is
   * still open. Evicts via `pruneDedupe` when the cache exceeds the key cap.
   */
  private dedupeAllows(
    cache: Map<string, number>,
    key: string,
    now: number,
    windowMs = NOISY_SUPPRESSION_DEDUPE_MS,
  ): boolean {
    const lastAt = cache.get(key);
    if (lastAt != null && now - lastAt < windowMs) return false;
    cache.set(key, now);
    if (cache.size > MAX_SUPPRESSION_DEDUPE_KEYS) this.pruneDedupe(cache, now);
    return true;
  }

  private d9PriceBucket(price: number | null | undefined): string {
    return typeof price === "number" && Number.isFinite(price) ? price.toFixed(2) : "unknown";
  }

  private suppressionDedupeKey(facts: SuppressionFacts): string {
    if (this.isR23NoDipSuppression(facts)) {
      return [
        "r23-no-dip",
        facts.reasonCode,
        facts.side ?? "",
        facts.decisionRuleId ?? "",
        this.continuationMode,
      ].join("|");
    }

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

    if (facts.reasonCode === STATIC_RULE_SELL_BELOW_AVG_ENTRY_GUARD_REASON) {
      return [
        "static-rule-below-positive-floor",
        facts.reasonCode,
        String(facts.tokenId),
        facts.conditionId ?? "",
        facts.side ?? "",
        facts.decisionRuleId ?? "",
        facts.state,
        formatSuppressionDedupeNumber(facts.extra?.proposedExitPrice ?? facts.price),
        formatSuppressionDedupeNumber(facts.extra?.positiveFloorPrice ?? facts.extra?.floor),
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

  private isR23NoDipSuppression(facts: SuppressionFacts): boolean {
    return (
      facts.reasonCode === R23_NO_DIP_REASON && facts.decisionRuleId === R23_DIP_TRIGGER_RULE_ID
    );
  }

  private pruneDedupe(cache: Map<string, number>, now: number): void {
    for (const [key, lastAt] of cache) {
      if (now - lastAt >= NOISY_SUPPRESSION_DEDUPE_MS) {
        cache.delete(key);
      }
    }
    while (cache.size > MAX_SUPPRESSION_DEDUPE_KEYS) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  }

  private shouldSuppressBuyForBudget(signal: import("@krabs/domain").Signal, now: number): boolean {
    if (signal.side !== "buy") return false;

    if (this.buyBudgetCooldownUntilMs > 0 && now >= this.buyBudgetCooldownUntilMs) {
      this.clearBuyBudgetCooldown(now, "expired");
    }

    if (this.buyBudgetCooldownUntilMs > now) {
      if (this.isExactMakerCaptureSignal(signal, now)) {
        const captureAttempt = this.canAttemptBuyNotional(signal.suggestedSizeUsdc, signal);
        if (captureAttempt?.allowed === true) return false;
      }
      this.buyBudgetSuppressedSignals++;
      return true;
    }

    const canAttempt = this.canAttemptBuyNotional(signal.suggestedSizeUsdc, signal);
    if (canAttempt?.allowed === true) {
      return false;
    }

    if (canAttempt?.allowed === false) {
      if (canAttempt.activateCooldown && !this.isExactMakerCaptureSignal(signal, now)) {
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
      const result = circuitBreaker.canAttemptBuy(requiredNotionalUsdc, signal, {
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

  private isExactMakerCaptureSignal(signal: import("@krabs/domain").Signal, now: number): boolean {
    const makerEntry = this.deps.executionPolicy?.().makerEntry;
    return makerEntry
      ? isMakerCaptureNextR23OrderAuthorized(
          makerEntry,
          {
            conditionId: signal.conditionId,
            source: "strategy",
            side: signal.side,
            entryStyle: "maker",
            postOnly: true,
            decisionRuleId: signal.decisionRuleId,
            signalReason: signal.reason,
            signalTimestamp: signal.generatedAt,
          },
          now,
        )
      : false;
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

function attachEntryFreshEdgeAttribution(
  signal: import("@krabs/domain").Signal,
  telemetry: EntryFreshEdgeSignalFields | null,
): void {
  if (!telemetry?.entryFreshEdgeKind || !telemetry.entryFreshEdgeShadowClass) return;
  const attribution = createEntryFreshEdgeAttribution({
    signalId: signal.signalId,
    side: signal.side,
    decisionRuleId: signal.decisionRuleId,
    entryKind: telemetry.entryFreshEdgeKind,
    shadowClass: telemetry.entryFreshEdgeShadowClass,
  });
  if (attribution) signal.entryFreshEdgeAttribution = attribution;
}

function resolveDaysToResolve(endDate: string | null, nowMs: number): number | null {
  if (endDate == null || endDate.trim() === "") return null;
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(endMs)) return null;
  const daysToResolve = (endMs - nowMs) / 86_400_000;
  return Number.isFinite(daysToResolve) ? daysToResolve : null;
}

function isProfileLadderOrderForQd(order: Order): boolean {
  return (
    order.decisionRuleId === PROFILE_LADDER_RULE_ID ||
    order.metadata?.source === PROFILE_LADDER_ORDER_SOURCE
  );
}

function computeMarketAgeSeconds(gammaCreatedAt: string | null, nowMs: number): number | null {
  if (gammaCreatedAt == null || gammaCreatedAt.trim() === "") return null;
  const createdMs = Date.parse(gammaCreatedAt);
  if (!Number.isFinite(createdMs)) return null;
  const ageSeconds = (nowMs - createdMs) / 1000;
  return Number.isFinite(ageSeconds) && ageSeconds >= 0 ? ageSeconds : null;
}

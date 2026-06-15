import type {
  TokenId,
  ConditionId,
  OrderId,
  FillId,
  PositionId,
  ClientOrderId,
  LotId,
  BotRunId,
  SwitchId,
  ReportId,
  ImportId,
} from "./ids.js";
import type {
  Regime,
  WalletMode,
  OrderSide,
  OrderType,
  OrderStatus,
  LiquidityRole,
  PositionStatus,
  SignalReason,
  OperatorActionType,
  CommandStatus,
  ProfileId,
  SwitchState,
  PreflightKind,
  PreflightStatus,
  RuntimeStatus,
  LedgerResetPolicy,
} from "./enums.js";
import type { D9LossExitPolicy } from "./d9-loss-exit.js";

// ─── Market ───────────────────────────────────────────────────────────────────
//
// One row per outcome token (YES or NO).  A single Polymarket "question" maps
// to two Market rows that share the same conditionId.
//
// tokenId   — CLOB token ID; primary key; required by the order API.
// conditionId — groups the YES/NO pair; never used as a foreign key.
// tickSize  — minimum price increment; required by CLOB order construction.
// negRisk   — required flag for order signing with @polymarket/clob-client.

export interface Market {
  tokenId: TokenId;
  conditionId: string;
  slug: string;
  eventSlug: string | null;
  question: string;
  outcome: string;
  outcomeIndex?: number | null;
  regime: Regime | null;
  horizon: string | null;
  endDate: string | null; // ISO timestamp
  active: boolean;
  /**
   * CLOB is actively quoting and accepting orders for new entries.
   * Distinct from `active`: a market preserved-for-lifecycle (closed on CLOB
   * but with an open leg) keeps `active: true` so pricing continues flowing
   * for SELL/real-resolution settlement, while `tradable: false` suppresses
   * new BUY eligibility in MarketSelectionCache.
   */
  tradable: boolean;
  tickSize: number;
  negRisk: boolean;
  /**
   * Number of markets in the parent Gamma event — persisted by scanner.
   * Required: callers must always carry the authoritative value from
   * Gamma `eventContext.marketCount`. Retained for telemetry and future
   * ranking features; v5.11 hard admission no longer uses single-market
   * fallback.
   */
  eventMarketCount: number;
  /** Result of evaluatePreEntry for this market — persisted by scanner. */
  selectionStatus?: SelectionStatus;
  /** The winning rule ID from evaluatePreEntry, or null. */
  selectionWinningRuleId?: string | null;
  /**
   * Gamma `createdAt` (ISO-8601). Distinct from `createdAt` — that is the moment
   * the row was first written to our DB. Null for legacy rows / CLOB-only paths.
   * Source: spec §1.7 R14 (`age_at_entry`). Required at the type level so every
   * fixture must explicitly set it (Step 0 §P1 guard).
   */
  gammaCreatedAt: string | null;
  /**
   * Track B strike-signal fields (spec §4). Persisted for a future Track C; the
   * Track B classifier ignores group-item (F6, §3.6) and uses slug + tags.
   * Optional like other persisted-but-optional fields (`selectionStatus?`,
   * `score?`); the scanner write path sets them from `ClobMarket`.
   */
  groupItemTitle?: string | null;
  groupItemThreshold?: string | null;
  tags?: readonly string[] | null;
  /**
   * Step 3 (audit doc §D3) soft-ranking score columns. NULL = "not yet
   * scored" — never store 0 (a valid model output). Owned exclusively by
   * `MarketRepository.updateScoresBatch`; the saveBatch upsert path must
   * preserve these on conflict by NOT mentioning them in its SET clause.
   */
  score?: number | null;
  scoreModelVersion?: string | null;
  scoredAt?: string | null; // ISO timestamp — when the model ran
  featuresCapturedAt?: string | null; // ISO timestamp — when the input snapshot was observed
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

// ─── Order book snapshot ──────────────────────────────────────────────────────

export interface PriceLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  tokenId: TokenId;
  bids: PriceLevel[];
  asks: PriceLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  minOrderSize?: number | null;
  timestamp: number; // unix ms
}

export type MarketBookSource = "clob" | "gamma" | "gamma-fallback" | "simulation" | "unknown";

// ─── Market snapshot (persisted periodic summary) ─────────────────────────────

export interface MarketSnapshot {
  tokenId: TokenId;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  volume24h: number | null;
  liquidity: number | null;
  publicTradeCount24h: number | null;
  capturedAt: string; // ISO timestamp
}

// ─── Signal ───────────────────────────────────────────────────────────────────
//
// sequenceInTick: 0-based counter for signals sharing the same
// tokenId + side within one scanner tick (F3 resolution).
// Required for deterministic buildClientOrderId deduplication.

export interface Signal {
  signalId: string;
  tokenId: TokenId;
  conditionId: ConditionId;
  side: OrderSide;
  suggestedPrice: number;
  ladderTargetPrice?: number;
  suggestedSize: number; // share quantity
  suggestedSizeUsdc: number; // USDC notional (= suggestedSize × suggestedPrice)
  reason: SignalReason;
  strategyTick: number; // epoch ms of the scanner tick
  sequenceInTick: number; // 0-based within tick for same token+side
  decisionRuleId: string | null;
  sizingRuleId: string | null;
  generatedAt: string; // ISO timestamp
}

export interface DecisionSignalLog {
  signalId: string;
  tokenId: TokenId;
  conditionId: ConditionId;
  side: "BUY" | "SELL" | "REDEEM";
  decisionRuleId: string | null;
  sizingRuleId: string | null;
  notionalBucket: NotionalBucket | null;
  state: "OTHER" | "S1" | "S2" | "S3";
  price: number;
  buyCount: number;
  timeSinceLastSeconds: number | null;
  signalTimestamp: string;
  isAdd: 0 | 1 | null;
  addAgeMs: number | null;
  addAgeBucket: AddAgeBucket | null;
  addPriceChangePct: number | null;
  addPriceChangeBucket: AddPriceChangeBucket | null;
  nthBuyAtEmit: number | null;
  // ADR-027 §D-B — exit telemetry. `isExit` is denormalized as 1 for SELL
  // exits and 0 for non-SELL rows; SELL-only derived fields remain null on
  // BUY/REDEEM rows.
  isExit: 0 | 1 | null;
  isFirstSell: 0 | 1 | null;
  holdingTimeMs: number | null;
  holdingTimeBucket: HoldingTimeBucket | null;
  exitPnlPct: number | null;
  exitPnlBucket: ExitPnlBucket | null;
  soldBoughtRatio: number | null;
  soldBoughtRatioBucket: SoldBoughtRatioBucket | null;
  entryFreshEdgeKind?: "first_entry" | "ladder_or_scale_in" | null;
  entryFreshEdgeShadowClass?:
    | "FRESH_EDGE_UNKNOWN"
    | "PLAUSIBLE_DIP"
    | "AFTER_PUMP_EXPENSIVE"
    | "FALLING_WITHOUT_RECOVERY"
    | "RANGE_DATA_UNAVAILABLE"
    | null;
  entryFreshEdgePayloadJson?: string | null;
}

/**
 * ADR-024 §D-C / §D-D — sizing notional bucket taxonomy.
 * Mirrors canonical §4.6 USDC bucket boundaries at
 * `06_algorithm_spec.md:454-467`. Buckets are mutually exclusive and
 * ordered. The empty-tail buckets ($25-$50, $50-$100, >$100) are
 * preserved so production drift into them is visible rather than
 * collapsed into a single ≥$25 catch-all.
 */
export type NotionalBucket =
  | "<$0.10"
  | "$0.10-$0.50"
  | "$0.50-$1"
  | "$1-$2"
  | "$2-$5"
  | "$5-$10"
  | "$10-$25"
  | "$25-$50"
  | "$50-$100"
  | ">$100";

/**
 * ADR-025 §D-B — cancel-age bucket taxonomy.
 * Mirrors canonical §12.1 same-price gap distribution buckets at
 * `06_algorithm_spec.md` v5.13. Buckets are left-inclusive /
 * right-exclusive (`[lower, upper)`) except the unbounded `>7d`
 * tail. Used to classify the time elapsed between an order's
 * `createdAt` and its cancellation.
 */
export type CancelAgeBucket = "<1min" | "1-10min" | "10min-1h" | "1-6h" | "6-24h" | "1-7d" | ">7d";

/**
 * ADR-026 §D-C — add-age bucket taxonomy.
 * Mirrors canonical §11.1.2 add-timing distribution buckets at
 * `06_algorithm_spec.md` v5.13. Buckets are left-inclusive /
 * right-exclusive (`[lower, upper)`) except the unbounded `>7d`
 * tail. Used to classify the time between a leg's first BUY fill
 * and a subsequent add-BUY signal emission.
 */
export type AddAgeBucket =
  | "<60s"
  | "1-5min"
  | "5-30min"
  | "30min-1h"
  | "1-3h"
  | "3-12h"
  | "12-24h"
  | "1-7d"
  | ">7d";

/**
 * ADR-026 §D-C — add price-change-vs-first-BUY bucket taxonomy.
 * Mirrors canonical §11.1.3 add price-change distribution buckets
 * at `06_algorithm_spec.md` v5.13. Boundaries are signed fractional
 * (e.g. `-0.5` = `-50%`); left-inclusive / right-exclusive except
 * for the unbounded tails (`below -50%` and `above +50%`). Used to
 * classify `(addPrice - firstTradePrice) / firstTradePrice`.
 */
export type AddPriceChangeBucket =
  | "below -50%"
  | "-50% to -25%"
  | "-25% to -10%"
  | "-10% to 0%"
  | "0% to +10%"
  | "+10% to +25%"
  | "+25% to +50%"
  | "above +50%";

/**
 * ADR-027 §D-D — exit pnl bucket taxonomy.
 * Mirrors canonical §11.2 exit profit distribution buckets at
 * `06_algorithm_spec.md` v5.13. Boundaries are signed fractional
 * (e.g. `-0.5` = `-50%`); left-inclusive / right-exclusive except
 * for the unbounded tails (`<-50%` and `>+100%`). Used to classify
 * `(sellPrice - rollingCostBasis) / rollingCostBasis`.
 */
export type ExitPnlBucket =
  | "<-50%"
  | "-50% to -10%"
  | "-10% to 0%"
  | "0% to +5%"
  | "+5% to +10%"
  | "+10% to +25%"
  | "+25% to +50%"
  | "+50% to +100%"
  | ">+100%";

/**
 * ADR-027 §D-D — leg holding-time bucket taxonomy.
 * Mirrors canonical §11.2 holding-time-first-BUY-to-first-SELL
 * distribution buckets at `06_algorithm_spec.md` v5.13. Boundaries
 * are left-inclusive / right-exclusive except the unbounded `>30d`
 * tail. Used to classify `(sellTimestamp - firstBuyTimestamp)`.
 */
export type HoldingTimeBucket = "<1h" | "1-6h" | "6-24h" | "1-7d" | "7-30d" | ">30d";

/**
 * ADR-027 §D-D — sold/bought shares ratio bucket taxonomy.
 * Mirrors canonical §11.2 sold/bought shares ratio distribution
 * buckets at `06_algorithm_spec.md` v5.13. The `0%` bucket includes
 * <1% rounding (matches the spec's coarse zero classification);
 * the `>=100%` bucket includes ≥99% rounding. Used to classify
 * `cumulative_sell_size / cumulative_buy_size` at SELL emit time.
 */
export type SoldBoughtRatioBucket = "0%" | "1-25%" | "25-50%" | "50-75%" | "75-99%" | ">=100%";

// ─── Risk Decision ────────────────────────────────────────────────────────────

export interface RiskDecision {
  signalId: string;
  tokenId: TokenId;
  conditionId: ConditionId;
  approved: boolean;
  rejectionReasons: string[];
  checksPassed: string[];
  decidedAt: string; // ISO timestamp
}

// ─── Order ────────────────────────────────────────────────────────────────────
//
// size      — share quantity (what the CLOB exchange operates on).
// sizeUsdc  — USDC notional at the limit price (= size × price).
// Both fields are required; neither is nullable.

export interface Order {
  orderId: OrderId;
  clientOrderId: ClientOrderId;
  tokenId: TokenId;
  conditionId: ConditionId;
  side: OrderSide;
  orderType: OrderType;
  postOnly?: boolean;
  price: number;
  size: number; // shares
  sizeUsdc: number; // notional
  status: OrderStatus;
  cancelReason?: string | null;
  /** ADR-025 §D-B — cancel-age telemetry (ms between createdAt and cancel time). */
  cancelAgeMs?: number | null;
  /** ADR-025 §D-B — §12.1 cancel-age bucket. */
  cancelAgeBucket?: CancelAgeBucket | null;
  /** ADR-025 §D-B — sum of fills.shares for this order at cancel time. */
  fillProgressShares?: number | null;
  /** ADR-025 §D-B — denormalized host-market horizon at cancel time. */
  marketHorizon?: string | null;
  exchangeOrderId: string | null;
  signalId: string | null;
  signalReason: string | null;
  decisionRuleId?: string | null;
  signalTimestamp?: string | null;
  exchangeErrorCode?: string | null;
  exchangeErrorMessage?: string | null;
  exchangeErrorPayload?: string | null;
  exchangeRejectionReason?: string | null;
  metadata?: Readonly<Record<string, unknown>> | null;
  botRunId: BotRunId;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

// ─── Fill ─────────────────────────────────────────────────────────────────────
//
// Same dual-size convention as Order.

export interface Fill {
  fillId: FillId;
  orderId: OrderId;
  tokenId: TokenId;
  conditionId: ConditionId;
  side: OrderSide;
  price: number;
  size: number; // shares executed
  sizeUsdc: number; // notional (= size × price)
  liquidityRole: LiquidityRole;
  fee: number;
  feeRateBps: number;
  signalId?: string | null;
  decisionRuleId?: string | null;
  signalTimestamp?: string | null;
  filledAt: string; // ISO timestamp
}

// ─── Position ─────────────────────────────────────────────────────────────────

export interface Position {
  positionId: PositionId;
  tokenId: TokenId;
  conditionId: ConditionId;
  side: OrderSide;
  size: number; // current share quantity
  avgEntryPrice: number;
  costBasisUsdc: number; // total USDC paid to acquire current size
  currentValueUsdc: number | null;
  liquidationValueUsdc?: number | null;
  liquidationPrice?: number | null;
  liquidationDepthExhausted?: boolean | null;
  liquidationValueUpdatedAt?: string | null;
  realizedPnl: number;
  status: PositionStatus;
  entryStyle: "probe" | null;
  openedAt: string; // ISO timestamp
  closedAt: string | null; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

// ─── Inventory Lot (FIFO cost basis tracking) ────────────────────────────────

export interface InventoryLot {
  lotId: LotId;
  positionId: PositionId;
  tokenId: TokenId;
  side: OrderSide;
  size: number; // original lot size in shares
  remainingSize: number; // shares not yet matched against a sell
  entryPrice: number;
  costUsdc: number; // original USDC cost for this lot
  fillId: FillId;
  createdAt: string; // ISO timestamp
}

// ─── Operator Command (pending queue; API writes, runtime polls) ──────────────
//
// Implements the F4 resolution: two-table pattern.
// operator_commands holds pending work; operator_actions holds the audit trail.

export interface OperatorCommand {
  id: number;
  action: OperatorActionType;
  targetId: string | null; // currently always null — all live actions are global; kept for compatibility with legacy (rejected) scoped commands
  reason: string | null;
  status: CommandStatus;
  createdAt: string; // ISO timestamp
  appliedAt: string | null; // ISO timestamp; set when status transitions to applied/rejected
  initiatorType: "operator" | "system";
  initiator: string | null;
}

// ─── Operator Action (immutable audit log; runtime writes after applying) ─────

export interface OperatorAction {
  actionId: string;
  action: OperatorActionType;
  targetType: "bot" | "family" | "market" | "order";
  targetId: string;
  reason: string | null;
  performedAt: string; // ISO timestamp
}

// ─── NormalizedMarket ─────────────────────────────────────────────────────────
//
// In-memory view of a market enriched with live pricing, produced by the
// market-data module from ClobMarket + OrderBookSnapshot and used as the
// canonical market representation flowing through the event bus.

export interface NormalizedMarket {
  tokenId: TokenId;
  conditionId: string;
  slug: string;
  eventSlug: string | null;
  /** Number of markets in the parent Gamma event; retained for telemetry/ranking. */
  eventMarketCount: number;
  question: string;
  outcome: string;
  outcomeIndex?: number | null;
  regime: Regime | null;
  horizon: string | null;
  endDate: string | null;
  active: boolean;
  /** See `Market.tradable` — mirrors the persisted flag. */
  tradable: boolean;
  tickSize: number;
  negRisk: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize?: number | null;
  bestAskSize?: number | null;
  /**
   * Optional exchange-depth estimate after removing this bot's visible ask.
   * Present only when a caller can calculate it from a live book + open order.
   */
  askDepthExcludingOurs?: number | null;
  midPrice: number | null;
  spread: number | null;
  lastTradePrice?: number | null;
  lastTradeAt?: string | null;
  volume24h?: number | null;
  /**
   * Rolling 24-hour traded volume from Gamma (`volume24hr`/`volume24hrClob`).
   * Used by the soft-ranking score's `volume_24h` feature, which the LR model
   * was trained on. Distinct from `volume24h` above, which carries Gamma's
   * lifetime-cumulative `volumeNum` and is kept for backward compatibility.
   */
  volume24hr?: number | null;
  /** Rolling public Data API trade count over the last 24h, capped by provider policy. */
  publicTradeCount24h?: number | null;
  liquidity?: number | null;
  minOrderSize?: number | null;
  bookSource?: MarketBookSource | null;
  /**
   * Gamma createdAt (ISO-8601) propagated from `Market.gammaCreatedAt`. Null
   * when unknown. Required at the type level so every fixture must explicitly
   * set it (Step 0 §P1 guard).
   */
  gammaCreatedAt: string | null;
  /**
   * Track B strike-signal fields (spec §4) propagated from `Market`. Used by
   * `classifyMarketRegime` on the decision/exit paths (group-item ignored — F6).
   */
  groupItemTitle?: string | null;
  groupItemThreshold?: string | null;
  tags?: readonly string[] | null;
  /**
   * Step 3 (audit doc §D4 / §P3 step 0) — propagated verbatim from
   * `Market.selectionStatus` so downstream modules can filter on v5.11
   * admission without round-tripping to the DB. Null only on paths that
   * build a NormalizedMarket without a backing Market row.
   */
  selectionStatus?: SelectionStatus | null;
  snapshotTs: number; // unix ms when pricing was captured
  /**
   * Step 3 (audit doc §D4) — wall-clock (unix ms) of the most recent
   * REST/Gamma refresh of the score-feature inputs (`liquidity`, `volume24hr`).
   * Distinct from `snapshotTs`, which is bumped on every CLOB stream update
   * even though stream events do **not** carry fresh `liquidity`/`volume24hr`.
   * Soft-ranking uses this for the 4h freshness window so a chatty book stream
   * cannot mask hours-stale Gamma feature inputs. Null when the market has
   * never seen a REST refresh yet (skipped by scoring).
   */
  featuresCapturedTs?: number | null;
}

// ─── MarketResolution ────────────────────────────────────────────────────────

export interface MarketResolution {
  conditionId: string;
  resolution: string;
  resolvedAt: string; // ISO timestamp
  detectedAt: string; // ISO timestamp
  source: "gamma-api" | "gamma-delisted" | "manual" | "algo";
  rawResponse: string | null; // JSON for debugging
  status: "detected" | "settled";
}

// ─── ReconciliationResult ────────────────────────────────────────────────────

export interface ReconciliationResult {
  /** Unix ms when the reconciliation pass ran. */
  ranAt: number;
  openOrdersExchange: number;
  openOrdersLocal: number;
  missingFills: number;
  phantomOrders: number;
  positionDriftCount: number;
  /** True when no discrepancies were found. */
  clean: boolean;
  details: string[];
}

// ─── Profile Switching — New entities ────────────────────────────────────────

export interface Profile {
  profileId: ProfileId;
  displayName: string;
  description: string | null;
  createdAt: string;
}

export interface ProfileSettings {
  profileId: ProfileId;
  initialBalanceUsdc: number | null;
  envelopeJson: string | null;
  riskCapsJson: string | null;
  walletMode?: WalletMode | null;
  minOrderUsdc?: number | null;
  fallbackMinOrderUsdcRelayer?: number | null;
  fallbackMinOrderUsdcEoa?: number | null;
  relayerJson?: string | null;
  /**
   * ADR-015: DB-backed execution policy. JSON payload shaped by
   * `ExecutionPolicy` in this module. Null = runtime uses code defaults.
   */
  executionPolicyJson?: string | null;
  updatedAt: string;
}

/**
 * ADR-015 — DB-backed execution policy, stored per profile in
 * `profile_settings.execution_policy_json`. Supersedes the env-based
 * operator path documented in ADR-014. Pricing formula itself is unchanged.
 */
export type ExecutionPricingMode = "edge" | "bounded-midpoint";
export type ExecutionWideSpreadPolicy = "edge" | "skip";
export type ExecutionOneSidedPolicy = "edge" | "skip";
export type DeadSideGuardMode = "off" | "observe" | "enforce";

export interface DeadSideGuardPolicy {
  mode: DeadSideGuardMode;
  askCeiling: number;
  maxTimeToEndMs: number;
}

export interface ExecutionPricingPolicy {
  mode: ExecutionPricingMode;
  maxEntrySpreadTicks: number;
  maxExitSpreadTicks: number;
  maxImprovementTicks: number;
  minExitPriceSignalRatio: number;
  wideSpreadPolicy: ExecutionWideSpreadPolicy;
  oneSidedPolicy: ExecutionOneSidedPolicy;
}

export interface ExecutionPolicyTelemetry {
  deadSideCanary: boolean;
  pricingShadow: boolean;
}

export type OrderLifetimeEnforcementMode = "observe" | "enforce";
export type TokenOrderLifetimeMode = "PASSIVE" | "MIDDLE" | "BURST";
export type TokenOrderLifetimeConfidence = "low" | "medium" | "high";

export interface BurstOrderLifetimePolicy {
  candidateFirstFillLatencyMs: number;
  confirmSpanMs: number;
  confirmMedianGapMs: number;
  confirmFirstFillLatencyMs: number;
  confirmP75GapMs: number;
  confirmMaxSpanMs: number;
  lowTtlMs: number;
  mediumTtlMs: number;
  highTtlMs: number;
}

export interface MiddleOrderLifetimePolicy {
  minMedianGapMs: number;
  maxMedianGapMs: number;
  maxSpanMs: number;
  lowTtlMs: number;
  mediumTtlMs: number;
  highTtlMs: number;
}

export interface PassiveOrderLifetimePolicy {
  lowTtlMs: number;
  mediumTtlMs: number;
  highTtlMs: number;
  highConfidenceMinFills: number;
  highConfidenceMinSpanMs: number;
}

export interface OrderLifetimePolicy {
  enabled: boolean;
  enforcement: OrderLifetimeEnforcementMode;
  staleResetMs: number;
  safetyBufferMs: number;
  resolutionAggressiveWindowMs: number;
  resolutionStopWindowMs: number;
  resolutionExitTtlCapMs: number;
  relayerSubmitBudgetPerMinute: number;
  maxTransitionEventsPerTokenPerDay: number;
  oscillationTransitionLimitPerDay: number;
  burst: BurstOrderLifetimePolicy;
  middle: MiddleOrderLifetimePolicy;
  passive: PassiveOrderLifetimePolicy;
}

export interface AlgoTokenModeState {
  tokenId: TokenId;
  conditionId: ConditionId;
  outcomeIndex: number | null;
  mode: TokenOrderLifetimeMode;
  modeConfidence: TokenOrderLifetimeConfidence;
  modeStatus: "candidate" | "confirmed";
  modeSince: string;
  modeAssessedAt: string;
  ttlStage: number;
  lastFillAt: string | null;
  lastOrderAt: string | null;
  lastStaleCancelAt: string | null;
  fillCountWindow: number;
  orderCountWindow: number;
  firstFillLatencyMs: number | null;
  medianGapMs: number | null;
  p75GapMs: number | null;
  spanMs: number | null;
  lastFillTimestampsJson: string | null;
  transitionCountDay: number;
  transitionDay: string | null;
  resetReason: string | null;
  updatedAt: string;
}

export interface OrderPriceCooldown {
  tokenId: TokenId;
  side: OrderSide;
  priceX10000: number;
  staleCancelCount: number;
  cooldownUntilTsUtc: number;
  lastEventTsUtc: number;
}

export interface BuyGuardShortLifetimePolicy {
  /** Guard B: block new BUY admission on ultra-short crypto up/down markets when enabled. */
  enabled: boolean;
  /** Remaining time-to-close threshold, in hours. */
  thresholdHours: number;
}

export interface MarketSelectionPolicy {
  /** v5.11 hard admission: BUY candidates must have mid price below this ceiling. */
  maxMidPrice: number;
  /** v5.11 hard admission: BUY candidates must have normalized liquidity at/above this floor. */
  minLiquidity: number;
  /** Optional BUY regression guard; omitted legacy policy JSON falls back to defaults. */
  shortLifetime?: BuyGuardShortLifetimePolicy;
}

export interface BuyCapacityPolicy {
  /** BUY-only wallet reserve guard. SELL exits always bypass this policy. */
  enabled: boolean;
  /** Reserve kept after first-entry BUY placement. */
  minNewEntryWalletHeadroomUsdc: number;
  /** Reserve kept after scale-in/add BUY placement. */
  minAddWalletHeadroomUsdc: number;
  /** Maximum pending/open BUY orders across the profile wallet. */
  maxOpenBuyOrders: number;
  /** Maximum pending/open BUY orders for one token. */
  maxOpenBuyOrdersPerToken: number;
}

export interface SellCapacityPolicy {
  /** SELL-only open-order guard. BUY wallet reserves are configured separately. */
  enabled: boolean;
  /** Maximum pending/open SELL orders across the profile wallet. */
  maxOpenSellOrders: number;
  /** Maximum pending/open SELL orders for one token. */
  maxOpenSellOrdersPerToken: number;
}

export interface OrderCapacityPolicy {
  /** Shared BUY+SELL open-order guard. */
  enabled: boolean;
  /** Maximum pending/open orders across BUY and SELL sides. */
  maxOpenOrdersTotal: number;
}

export interface RepriceOnOutbidPolicy {
  enabled: boolean;
  /** Maximum number of outbid-driven cancel/reissue attempts in one signal chain. */
  maxRepriceCount: number;
}

export interface ExitRepriceOnDownpricePolicy {
  enabled: boolean;
  /** Minimum SELL price gap to current best bid, expressed in CLOB ticks. */
  thresholdTicks: number;
  /** Maximum confirmed downprice-driven cancel attempts tracked while a token has open SELLs. */
  maxRepricesPerOrder: number;
  /** Operational alert for SELL orders that remained far above the live bid. */
  stuckWarningEnabled: boolean;
  /** Minimum open SELL age before stuck warning checks run, in milliseconds. */
  stuckWarningAgeMs: number;
  /** Fractional gap `(orderPrice - bestBid) / orderPrice` required for stuck warning. */
  stuckWarningGapPct: number;
}

export type ExitPricingMode = "bid-anchored" | "midpoint-anchored" | "edge";

export interface OpportunisticTakerPolicy {
  enabled: boolean;
  /** Maximum top-of-book spread, in CLOB ticks, where placement may cross as taker. */
  maxSpreadTicks: number;
  /** Multiplier applied to market/order minimums before a taker placement is allowed. */
  safetyBuffer: number;
  /** Fallback USDC notional floor when CLOB market metadata lacks minOrderSize. */
  fallbackMinNotionalUsdc: number;
  /** Marketable BUY notional floor used by live-lite guards. */
  marketableBuyMinNotionalUsdc: number;
}

export interface TakerAtProfitPolicy {
  enabled: boolean;
  /** Gross exit multiple required before a SELL may cross as taker. */
  minGrossExitRatio: number;
  /** Maximum top-of-book spread, in CLOB ticks; null disables the spread cap. */
  maxSpreadTicks: number | null;
  /** Rules allowed to use the path. `all-sell` still excludes dust/redeem-like signals. */
  rules: "all-sell" | string[];
}

export interface TrackRHonestPricingPolicy {
  enabled: boolean;
  safetyMargin: number;
  requireFullDepth: boolean;
  universalFallbackRate: number;
  maxSaneThreshold: number;
  /** Track S5 P0a: on candidate-book miss for a held-position SELL, fall back to the open-position book. */
  exitBookFallback: boolean;
  /** Track S5 P0a: max age of the primary heartbeat book before it is treated as stale (ms). */
  exitBookStalenessMs: number;
  /** Track S5 P0a: TTL of the secondary direct-fetch book cache (ms). */
  exitBookFetchTtlMs: number;
  /** Track S5 P0b: allow a taker SELL to skip the Plankton sell-price cap when the live bid covers it. */
  takerCapSkip: boolean;
  /** Track S5 P1: allow a depth-exhausted taker SELL to place a partial (available-size) exit. */
  allowPartialExit: boolean;
  /** Track S5 P1: minimum partial size as a fraction of the position size. */
  partialExitMinFraction: number;
  /** Track S5 P1: minOrderSize fallback (shares) used when CLOB metadata lacks one. */
  partialExitMinShares: number;
  /** Track S5 P1: hard cap on partial exits per hour per token (in-memory, non-durable). */
  partialExitMaxPerHour: number;
}

export interface TrackS3SpreadTierPolicy {
  minMargin: number;
  maxSpreadTicks: number;
  label: string;
}

export interface TrackS3MarginAwareSpreadPolicy {
  enabled: boolean;
  baseCap: number;
  tiers: readonly TrackS3SpreadTierPolicy[];
}

export interface TrackS1MarkupCeilingsPolicy {
  cheapMax: number;
  midRange: number;
}

export interface TrackS1WalkingLadderPolicy {
  enabled: boolean;
  numTiers: number;
  bottomTierMarkup: number;
  volumeDistribution: readonly number[];
  markupCeilings: TrackS1MarkupCeilingsPolicy;
  handoffTimeToResolutionSeconds: number;
  handoffTimeoutSeconds: number;
  phantomOwnershipReleaseSeconds: number;
  maxOpenLadderTokens: number;
  s1MaxOrdersPerToken: number;
  maxLadderReplacementsPerHour: number;
  cheapLongshotMaxAvgEntry: number;
  thinSpreadTicks: number;
  bestBidDepthRatio: number;
  bottomRepriceBidMovePct: number;
  minBestBid: number;
}

export interface S1OwnershipSnapshot {
  owned: boolean;
  ladderId: string;
  assumedAtMs: number;
  reason: "eligible" | "active_ladder" | "handoff";
}

/**
 * Read-only view of the S1 ladder ownership map. Shared contract: the ladder
 * module implements it; the algo-decision planner and the signal-to-order
 * bridge consume it (the bridge for the Track S5 belt-and-suspenders guard).
 */
export interface S1OwnershipReader {
  getSnapshot(tokenId: TokenId): S1OwnershipSnapshot | null;
}

export type ExecutionProfileName = "cheap" | "medium" | "expensive";

export type ProfileLadderBand = "cheap" | "medium_low" | "medium_high" | "expensive";

export type ProfileLadderMode = "up" | "flat" | "avg_down";

export type ProfileLadderStatus =
  | "active"
  | "rebuilding"
  | "handoff_to_qd"
  | "closed"
  | "cancelled"
  | "orphan_recovered";

export type RungLifecycle = "planned" | "placed" | "partially_filled" | "filled" | "cancelled";

export type ProfileLadderSkipReason =
  | "sell_ladder_disabled"
  | "band_disabled"
  | "invalid_input"
  | "no_open_position"
  | "duplicate_ownership"
  | "below_min_order_size"
  | "invalid_bbo"
  | "invalid_tick_size";

export interface LadderRung {
  rungIndex: number;
  price: number;
  sizeShares: number;
  notionalUsd: number;
  multiplier: number;
  sizingFraction: number;
  lifecycle: RungLifecycle;
  orderId: string | null;
  filledSizeShares: number;
}

export interface LadderState {
  tokenId: TokenId;
  conditionId: ConditionId;
  ladderId: string;
  band: ProfileLadderBand;
  phase: number;
  status: ProfileLadderStatus;
  activeRungs: readonly LadderRung[];
  filledRungs: readonly LadderRung[];
  lastAvgEntry: number;
  lastCostBasisUsdc: number;
  lastMode: ProfileLadderMode;
  lastBboReferenceJson: string | null;
  lastRebuildAtMs: number | null;
  lastFillAtMs: number | null;
  staleCheckedAtMs: number | null;
  qdHandoffAtMs: number | null;
  closedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  metadataJson: string;
}

export interface ProfileLadderBandConfig {
  enabled: boolean;
  minAvgEntry: number | null;
  maxAvgEntry: number | null;
  multipliers: readonly number[];
  sizingVector: readonly number[];
  costCapUsd: number;
  allowFourthRung: boolean;
  fourthRungMinCostUsd: number;
}

export interface ProfileLadderRepriceConfig {
  majorBboMovePct: number;
  strongBboMovePct: number;
  cooldownMs: number;
}

export interface ProfileLadderStaleReviewConfig {
  enabled: boolean;
  staleAfterMs: number;
}

export interface ExecutionProfileSellLadderConfig {
  enabled: boolean;
  phase: number;
  decisionRuleId: string;
  orderTag: string;
  bands: Record<ProfileLadderBand, ProfileLadderBandConfig>;
  modeAdjustments: Record<ProfileLadderMode, number>;
  reprice: ProfileLadderRepriceConfig;
  staleReview: ProfileLadderStaleReviewConfig;
}

export interface LadderBuilderInput {
  tokenId: TokenId;
  conditionId: ConditionId;
  openedAt: string;
  avgEntryPrice: number;
  costBasisUsd: number;
  positionSizeShares: number;
  mode: ProfileLadderMode;
  bestBid: number | null;
  bestAsk: number | null;
  tickSize: number;
  minOrderSize: number;
  config: ExecutionProfileSellLadderConfig;
  previousBand: ProfileLadderBand | null;
}

export type LadderBuilderOutput =
  | {
      ok: true;
      ladderId: string;
      band: ProfileLadderBand;
      activeRungCount: number;
      rungs: readonly LadderRung[];
    }
  | {
      ok: false;
      reason: ProfileLadderSkipReason;
      band: ProfileLadderBand | null;
    };

export interface ExecutionProfileHysteresisBounds {
  cheapMediumLow: number;
  cheapMediumHigh: number;
  mediumExpensiveLow: number;
  mediumExpensiveHigh: number;
}

export interface ExecutionProfileFeatureToggle {
  enabled: boolean;
}

export interface ExecutionProfileScaleInFeatureToggle extends ExecutionProfileFeatureToggle {
  useRealFeed: boolean;
}

export interface HotSample {
  tsMs: number;
  midPrice: number;
}

export interface OhlcBucket {
  tokenId: TokenId;
  bucketStartMs: number;
  bucketGranularityMs: number;
  openMid: number;
  highMid: number;
  lowMid: number;
  closeMid: number;
  sampleCount: number;
  tradeCount: number;
  notionalSum: number;
  persisted: boolean;
}

export interface BookSignalsTradeStats {
  publicTradeCount3h: number;
  publicNotional3h: number | null;
  status: "unknown" | "stale" | "ok";
  windowStartMs: number;
}

export interface SignalSnapshot {
  tokenId: TokenId;
  computedAtMs: number;
  windowStartMs: number;
  hotSampleCount: number;
  warmBucketCount3h: number;
  recovery60: number;
  range60: number;
  std60: number;
  tradeCount3h: number;
  notional3h: number | null;
  midNow: number;
  midMin60m: number;
  midMax60m: number;
  midMean60m: number;
  insufficientForRecovery: boolean;
  insufficientForRange: boolean;
  insufficientForStd: boolean;
  insufficientForTradeCount: boolean;
}

export interface ExecutionProfileSignalFeedConfig {
  enabled: boolean;
  windowShortMs: number;
  windowLongMs: number;
  hotSampleTargetIntervalMs: number;
  warmBucketMs: number;
  coldArchiveBucketMs: number;
  retentionDays: number;
  minSamplesForSnapshot: number;
  minSamplesForRecovery60: number;
  minWarmBucketsForTradeCount: number;
  flushHotToWarmIntervalMs: number;
  flushWarmToColdIntervalMs: number;
  maintenanceIntervalMs: number;
}

export type ExecutionProfileStateName =
  | "SCANNING"
  | "PROBING"
  | "ACCUMULATING"
  | "EXITING"
  | "QD_HANDOFF"
  | "ABANDONED"
  | "ABANDONED_DORMANT"
  | "CLOSED";

export interface ExecutionProfileAbandonmentBandConfig {
  enabled: boolean;
  probeSizeMaxUsdc: number;
  maxProbeBuyCount: number;
  scaleInRequiredWithinMs: number;
}

export interface ExecutionProfileAbandonmentConfig {
  enabled: boolean;
  evaluationIntervalMs: number;
  maxTokensPerCycle: number;
  hardStaleFallbackMs: number;
  bands: Record<ProfileLadderBand, ExecutionProfileAbandonmentBandConfig>;
}

export type AbandonmentReason =
  | "qualified"
  | "abandonment_disabled"
  | "band_disabled"
  | "invalid_input"
  | "state_not_eligible"
  | "cost_above_probe_max"
  | "buy_count_above_probe_max"
  | "prior_sell"
  | "first_buy_missing"
  | "timer_not_elapsed"
  | "pending_scale_in"
  | "active_profile_ladder"
  | "active_sell_order";

export interface AbandonmentEvaluatorInput {
  band: ProfileLadderBand;
  state: "PROBING" | "ACCUMULATING";
  costBasisUsdc: number;
  buyCount: number;
  sellCount: number;
  firstBuyAtMs: number | null;
  nowMs: number;
  pendingScaleIn: boolean;
  activeProfileLadder: boolean;
  activeSellOrder: boolean;
}

export interface AbandonmentEvaluatorOutput {
  shouldAbandon: boolean;
  result: "abandoned" | "kept";
  reason: AbandonmentReason;
  band: ProfileLadderBand;
  timeSinceFirstBuyMs: number | null;
}

export type CostCapSeverity = "under_p75" | "between" | "over_p90";

export type CostCapCrossedBand = "none" | "normal" | "aggressive";

export type CostCapRequiredSignal = "none" | "confirmation" | "strong";

export type CostCapDecisionReason =
  | "cost_caps_disabled"
  | "under_normal_cap"
  | "between_requires_confirmation"
  | "between_confirmation_present"
  | "over_aggressive_requires_strong_signal"
  | "over_aggressive_strong_signal_present"
  | "hard_cap_at_aggressive";

export type CostCapSignalReason =
  | "recovery60_ge_moderate"
  | "recovery60_ge_10pct"
  | "volume_activity_confirmed"
  | "manual_operator_override"
  | "unknown";

export interface CostCapSignalContext {
  hasConfirmationSignal: boolean;
  hasStrongOverrideSignal: boolean;
  signalReasons: readonly CostCapSignalReason[];
}

export interface CostCapAction {
  side: "buy";
  kind: "scale_in";
  proposedNotionalUsd: number;
  proposedSizeShares?: number;
}

export interface CostCapInput {
  profile: ExecutionProfileName;
  currentCostUsd: number;
  action: CostCapAction;
  signals: CostCapSignalContext;
}

export interface ExecutionProfileCostCapsPolicy {
  enabled: boolean;
}

export type ScaleInMode = "up" | "flat" | "avg_down";

export type ManagerScaleInReason =
  | "add_in_flight"
  | "missing_position"
  | "not_active_state"
  | "missing_mark_price";

export type ScaleInReason =
  | "scale_in_disabled"
  | "invalid_inputs"
  | "time_gate_blocked"
  | "mode_no_signal"
  | "avg_down_no_recovery"
  | "avg_down_disabled"
  | "flat_no_trigger"
  | "below_min_add"
  | "cost_cap_blocked"
  | "allowed"
  | ManagerScaleInReason;

export type ExecutionProfileHealthStatus = "ok" | "warn";

export type FreshnessStatus = "ok" | "warn" | "disabled" | "stale" | "unknown" | "stub_active";

export type ExecutionProfileDecision = "allow" | "block" | "skip" | "disabled";

export interface ScaleInMarketSignals {
  recovery60: number;
  range60: number;
  std60: number;
  tradeCount3h: number;
  notional3h: number;
}

export interface ScaleInTriggerSignals {
  activity: boolean;
  recovery: boolean;
  volatility: boolean;
  range60Above: boolean;
  std60Above: boolean;
  notional3h: number;
}

export interface ScaleInInput {
  profile: ExecutionProfileName;
  currentCostUsd: number;
  avgEntryPrice: number;
  currentMarkPrice: number;
  timeSinceLastBuyMs: number;
  marketSignals: ScaleInMarketSignals;
  previousAddCount: number;
  initialProbeSizeUsd: number;
}

export interface ScaleInDecision {
  action: "add" | "skip";
  reason: ScaleInReason;
  mode?: ScaleInMode;
  proposedAddSizeUsd: number;
  sizingMultiplier: number;
  triggerSignals: ScaleInTriggerSignals;
  costCapContext: CostCapSignalContext;
}

export interface ScaleInConfig {
  enabled: boolean;
  profiles: ExecutionProfileProfilesPolicy;
}

export interface ExecutionProfileScaleInModePolicy {
  thresholdPct: number;
}

export interface ExecutionProfileScaleInAvgDownPolicy {
  enabled: boolean;
  thresholdPct: number;
  requireRecovery: boolean;
  recoveryThreshold: number;
}

export interface ExecutionProfileScaleInTriggersPolicy {
  activity: { tradeCount3hThreshold: number };
  recovery: { threshold: number; strongThreshold: number; strongActivityRecoveryFloor: number };
  volatility: { range60Threshold: number; std60Threshold: number };
  strongActivity: { tradeCount3hThreshold: number };
}

export interface ExecutionProfileScaleInProfilePolicy {
  initialProbeSizeUsd: number;
  sizingDecay: readonly number[];
  minTimeBetweenAddsMs: number;
  minAddNotionalUsd: number;
  modes: {
    up: ExecutionProfileScaleInModePolicy;
    flat: ExecutionProfileScaleInModePolicy;
    avgDown: ExecutionProfileScaleInAvgDownPolicy;
  };
  triggers: ExecutionProfileScaleInTriggersPolicy;
}

export interface ExecutionProfileCostCapProfilePolicy {
  normalCapUsd: number;
  aggressiveCapUsd: number;
  hardCapAtAggressive: boolean;
}

export interface ExecutionProfileProfilesPolicy {
  cheap: {
    costCaps: ExecutionProfileCostCapProfilePolicy;
    scaleIn: ExecutionProfileScaleInProfilePolicy;
  };
  medium: {
    costCaps: ExecutionProfileCostCapProfilePolicy;
    scaleIn: ExecutionProfileScaleInProfilePolicy;
  };
  expensive: {
    costCaps: ExecutionProfileCostCapProfilePolicy;
    scaleIn: ExecutionProfileScaleInProfilePolicy;
  };
}

export interface ExecutionProfileCostCapDecisionConfig {
  enabled: boolean;
  profiles: ExecutionProfileProfilesPolicy;
}

export interface ExecutionProfileMonitoringConfig {
  healthCheckIntervalMs: number;
  rollupWindowMs: number;
  maxRollupBuckets: number;
  pendingScaleInWarnAfterMs: number;
  healthRiskEventEveryMs: number;
  anomalyDetection: {
    enabled: boolean;
    cooldownMs: number;
  };
}

export interface CapDecision {
  allow: boolean;
  severity: CostCapSeverity;
  crossedBand: CostCapCrossedBand;
  reason: CostCapDecisionReason;
  requiredSignal: CostCapRequiredSignal;
  profile: ExecutionProfileName;
  currentCostUsd: number;
  roundedCurrentCostUsd: number;
  proposedNotionalUsd: number;
  projectedCostUsd: number;
  roundedProjectedCostUsd: number;
  normalCapUsd: number;
  aggressiveCapUsd: number;
  hardCapAtAggressive: boolean;
  signalReasons: readonly CostCapSignalReason[];
}

export interface ExecutionProfilePolicy {
  enabled: boolean;
  maxTokensPerCycle: number;
  qdHandoffThresholdMs: number;
  profileHysteresis: ExecutionProfileHysteresisBounds;
  costCaps: ExecutionProfileCostCapsPolicy;
  scaleIn: ExecutionProfileScaleInFeatureToggle;
  signalFeed: ExecutionProfileSignalFeedConfig;
  abandonment: ExecutionProfileAbandonmentConfig;
  profiles: ExecutionProfileProfilesPolicy;
  sellLadder: ExecutionProfileSellLadderConfig;
  adoptExistingPositions: ExecutionProfileFeatureToggle;
  adoptExistingS1Ladders: ExecutionProfileFeatureToggle;
  monitoring: ExecutionProfileMonitoringConfig;
}

export type TrackRFeeRateSource = "live" | "fill" | "fallback_category" | "fallback_universal";

export interface TrackRFeeQuote {
  rate: number;
  exponent: number;
  source: TrackRFeeRateSource;
  category?: string | null;
}

export interface TrackRTakerFeeProvider {
  resolveFeeQuote: (input: {
    conditionId: ConditionId;
    tokenId: TokenId;
    category?: string | null;
    policy: TrackRHonestPricingPolicy;
    nowMs: number;
  }) => Promise<TrackRFeeQuote | null>;
}

export interface DropTriggerPolicy {
  enabled: boolean;
  /** When true, missing 1h history allows the BUY and emits `no_drop_data` telemetry. */
  failOpenOnNoData: boolean;
  /** Required `(current - reference) / reference` delta for non-probe BUYs. */
  thresholdPct: number;
  /** Lookback window for the reference price. */
  lookbackMs: number;
  /** Maximum age around the reference timestamp before the history is treated as unavailable. */
  historyMaxAgeMs: number;
}

export interface R23DipTriggerPolicy {
  enabled: boolean;
  /** R23 dip ratio threshold: current midpoint / max(midpoint over window). */
  dropThresholdRatio: number;
  /** Lookback window used for max-midpoint peak detection. */
  windowMs: number;
}

export interface MultiBuyLadderPolicy {
  enabled: boolean;
  maxLadderFillsPerToken: number;
  ladderGapMs: number;
  perTokenUsdcCap: number;
  maxPriceDriftTicks: number;
  minStepFillRate: number;
}

export interface RedeemSweepPolicy {
  enabled: boolean;
  intervalMs: number;
  inFlightTtlMs: number;
  maxRetries: number;
  retryBackoffMs: number[];
  postRedeemVerifyDelayMs: number;
  circuitBreakerEnabled: boolean;
  stateFailedQuarantineThreshold: number;
  stateFailedQuarantineTtlHours: number;
}

export interface RaceProtectionPolicy {
  redeemInFlight: {
    enabled: boolean;
  };
}

/**
 * CHANGE A — D8 profit-ratio SELL trigger (R66 spec 14.Y).
 * See packages/domain/src/d8-profit-target.ts for evaluation semantics.
 */
export interface ProfitTargetPolicyConfig {
  enabled: boolean;
  /** Minimum holdSeconds gate. Default R66 median first-SELL holdTime = 5183s. */
  holdSecondsMin: number;
}

/**
 * CHANGE B — dust abandonment with auto-recovery (R67 spec 11.5).
 * See packages/domain/src/dust-abandonment.ts for evaluation semantics.
 */
export interface DustAbandonmentPolicyConfig {
  enabled: boolean;
  maxConsecutiveRejects: number;
  priceRecoveryRatio: number;
}

/**
 * CHANGE C — per-token rolling 24h reprice chain cap (R65 p90 = 13).
 * See packages/domain/src/reprice-chain.ts for evaluation semantics.
 */
export interface RepriceChainPolicyConfig {
  enabled: boolean;
  windowMs: number;
  maxChainCount: number;
  dynamicChainCap: DynamicChainCapPolicyConfig;
}

/**
 * Loop guard — token-level SELL circuit breaker for repeated no-op outcomes.
 * Counts realized no-op SELL outcomes (local post-only-cross skips and
 * exchange/gateway no-order-id rejections) per token in a sliding window and,
 * after `threshold`, suppresses SELL signal generation for that token during a
 * cooldown. Distinct from R65 (`repriceChain`), which caps reprice loops on
 * already-open orders. See packages/domain/src/sell-loop-guard.ts.
 */
export interface SellLoopGuardPolicy {
  enabled: boolean;
  windowMs: number;
  threshold: number;
  cooldownMs: number;
  countPostOnlyCrossPreSubmit: boolean;
  countExchangeNoOrderId: boolean;
}

export interface DynamicChainCapPolicyConfig {
  enabled: boolean;
  tradeCountThinThreshold: number;
  tradeCountLiquidThreshold: number;
  capThin: number;
  capMedium: number;
  capLiquid: number;
  capUnknown: number;
}

export interface ExitTtlByLiquidityPolicyConfig {
  enabled: boolean;
  thinMs: number;
  mediumMs: number;
}

/**
 * Sub-Track Q.D — pre-resolution forced exit on cheap longshots.
 * Safety-net SELL trigger that fires near resolution on a qualifying bid before
 * classified wide-spread suppression or missing working SELLs let a cheap
 * position settle at zero. See
 * research_plankton/track_q_d_spec_2026-06-12.md §1 + §3.3.
 *
 * Shipped as observe-only shadow first (`enabled:true` only records a
 * `track_q_d` side effect; no order is placed or repriced). `salvageEnabled`
 * gates Mode B (the flagged below-entry salvage deviation), default OFF.
 */
export interface QdPreResolutionExitPolicy {
  /** Master flag. Shadow phase records would-fire telemetry only. */
  enabled: boolean;
  /** T2: time-to-close window before resolution within which Q.D may fire. */
  ttcThresholdMs: number;
  /** T1: only cheap longshots (`avg_entry < tierCeiling`) are in cohort. */
  tierCeiling: number;
  /** T5: minimum absolute best bid that counts as a qualifying (non-lottery) bid. */
  bidFloorAbs: number;
  /** Mode B gate. When OFF, Q.D is Plankton-strict (Mode A: bid ≥ avg_entry). */
  salvageEnabled: boolean;
  /** Mode B only applies at imminent TTC (`TTC < salvageTtcMs`). */
  salvageTtcMs: number;
  /** Mode B salvage floor: fire when `bestBid ≥ salvageFloorRatio × avg_entry`. */
  salvageFloorRatio: number;
}

export interface ExecutionPolicy {
  version: number;
  entryPriceCeiling: number;
  /**
   * Step 0 §P3: minimum age between Gamma `createdAt` and the bot's first BUY,
   * in seconds. Default 2,504 (spec §1.7 R1, `06:423` — empirical lower bound
   * across historical Plankton trades). Set to 0 to bypass entirely
   * (simulation profile). Applied only on the first-BUY branch
   * (`legState == null`); SELL/REDEEM/continuation are NOT gated.
   */
  entryMinMarketAgeSeconds: number;
  exitOrderTtlMs: number;
  exitTtlByLiquidity: ExitTtlByLiquidityPolicyConfig;
  /** v064a: age after which an unfilled SELL escalates from single close to split sizing. */
  sellTimeoutMs: number;
  sellReplaceMinPriceDeltaTicks?: number;
  exitRepriceThresholdPct: number;
  exitRepriceThresholdTicks: number;
  marketSelection: MarketSelectionPolicy;
  buyCapacity: BuyCapacityPolicy;
  sellCapacity: SellCapacityPolicy;
  orderCapacity: OrderCapacityPolicy;
  deadSideGuard: DeadSideGuardPolicy;
  pricing: ExecutionPricingPolicy;
  /** SELL exit edge strategy. BUY pricing remains governed by `pricing.mode`. */
  exitPricingMode: ExitPricingMode;
  /** Number of CLOB ticks to place a bid-anchored SELL above current best bid. */
  exitBidAnchorTicks: number;
  /** Number of CLOB ticks to place a midpoint-anchored SELL above current midpoint. */
  exitMidpointAnchorTicks: number;
  opportunisticTaker: OpportunisticTakerPolicy;
  takerAtProfit: TakerAtProfitPolicy;
  trackR: TrackRHonestPricingPolicy;
  trackS3: TrackS3MarginAwareSpreadPolicy;
  trackS1: TrackS1WalkingLadderPolicy;
  executionProfile: ExecutionProfilePolicy;
  orderLifetime: OrderLifetimePolicy;
  /**
   * Cooldown after any BUY fill before emitting SELL exits from the same wallet.
   * Infrastructure timing guard for exchange balance settlement, not strategy logic.
   */
  postBuyFillSellCooldownMs: number;
  repriceOnOutbid: RepriceOnOutbidPolicy;
  exitRepriceOnDownprice: ExitRepriceOnDownpricePolicy;
  dropTrigger: DropTriggerPolicy;
  r23DipTrigger: R23DipTriggerPolicy;
  multiBuyLadder: MultiBuyLadderPolicy;
  redeemSweep: RedeemSweepPolicy;
  raceProtection: RaceProtectionPolicy;
  telemetry: ExecutionPolicyTelemetry;
  /** CHANGE A — D8 profit-ratio SELL trigger config. */
  profitTarget: ProfitTargetPolicyConfig;
  /** CHANGE B — dust abandonment config. */
  dustAbandonment: DustAbandonmentPolicyConfig;
  /** CHANGE C — per-token 24h reprice chain cap config. */
  repriceChain: RepriceChainPolicyConfig;
  /** Loop guard — token-level SELL circuit breaker for repeated no-op outcomes. */
  sellLoopGuard: SellLoopGuardPolicy;
  /** D9_LOSS_EXIT — R96 liquidity-aware loss exit trigger. Disabled by default. */
  lossExit: D9LossExitPolicy;
  /** Sub-Track Q.D — pre-resolution forced exit on cheap longshots (shadow). */
  preResolutionExit: QdPreResolutionExitPolicy;
  depositActivation: DepositActivationPolicy;
}

export interface DepositActivationPolicy {
  enabled: boolean;
  /** Minimum USDC-equivalent balance in cents (e.g. 100 = $1.00) to trigger activation. */
  minAmountUsdcCents: number;
}

export interface ProfileSummary {
  profileId: ProfileId;
  paused: boolean;
  lastRunAt: string | null;
  openOrders: number;
  openPositions: number;
  totalExposureUsdc: number;
  balanceUsdc: number | null;
  lastPreflightStatus: PreflightStatus | null;
  updatedAt: string;
}

/**
 * ADR-016: Post-Entry Continuation Filter mode.
 *  - `leg_local`   → ADR-010 D1 behavior (legState.buyCount + sellCount).
 *  - `market_wide` → spec-aligned trade_count via DataApiTradeCountProvider.
 */
export type ContinuationMode = "leg_local" | "market_wide";

export interface RuntimeControlState {
  currentProfile: ProfileId | null;
  desiredProfile: ProfileId | null;
  currentSwitchId: SwitchId | null;
  currentRunId: string | null;
  currentInstanceId: string | null;
  runtimeStatus: RuntimeStatus;
  paused: boolean;
  schemaVersion: number;
  /** ADR-015: bumped on every execution_policy_json write; drives runtime hot-reload. */
  executionPolicyVersion?: number;
  /** ADR-016: continuation gate mode. */
  continuationMode?: ContinuationMode;
  /** ADR-016: bumped on every continuation_mode write; drives runtime hot-reload. */
  continuationModeVersion?: number;
  updatedAt: string;
}

export interface SwitchRequest {
  switchId: SwitchId;
  fromProfile: ProfileId;
  toProfile: ProfileId;
  ledgerResetPolicy: LedgerResetPolicy;
  deployPlanJson: string | null;
  state: SwitchState;
  errorMessage: string | null;
  archivePath: string | null;
  requestedBy: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PreflightReport {
  reportId: ReportId;
  switchRequestId: SwitchId | null;
  profile: ProfileId;
  kind: PreflightKind;
  status: PreflightStatus;
  blockersJson: string | null;
  warningsJson: string | null;
  infoJson: string | null;
  createdAt: string;
}

export interface ServiceHeartbeat {
  serviceName: string;
  instanceId: string;
  profile: ProfileId | null;
  runId: string | null;
  lastHeartbeatAt: string;
  statusJson: string | null;
}

export interface ConfigImport {
  importId: ImportId;
  sourcePath: string | null;
  sourceChecksum: string;
  sourceVersion: number | null;
  resultJson: string | null;
  importedAt: string;
  importedBy: string | null;
}

export interface SettlementRecord {
  settlementId: string;
  conditionId: string;
  positionId: string;
  tokenId: string;
  resolution: string;
  settlementPrice: number;
  size: number;
  delta: number;
  settledAt: string;
  createdAt?: string;
}

export interface MergeRecord {
  mergeId: string;
  conditionId: string;
  mergedAmount: number;
  spreadPnl: number;
  mergedAt: string;
  createdAt?: string;
}

export interface PositionDrift {
  settlementId: string;
  tokenId: string;
  conditionId: string;
  detectedAt: string;
  onChainBalance: string;
  lastCheckedAt: string;
  status: "open" | "resolved";
  createdAt?: string;
}

/**
 * ADR-015 — one row per BUY/SELL signal that reaches execution-term
 * resolution (or is dead-side-enforce-skipped). Powers SQL + dashboard
 * comparison of edge vs bounded-midpoint pricing and dead-side buckets
 * over 24-72h rollout windows. Append-only; runtime never updates rows.
 */
export interface ExecutionPolicyObservation {
  profileId: string;
  signalId: string | null;
  clientOrderId: string | null;
  decisionRuleId: string | null;
  tokenId: string;
  marketSlug: string | null;
  side: "BUY" | "SELL";
  signalReason: string | null;
  selectedPricingMode: "edge" | "bounded-midpoint";
  selectedPrice: number | null;
  edgePrice: number | null;
  boundedPrice: number | null;
  boundedOutcome: "ok" | "edge-fallback" | "skip" | "invalid" | "not-computed";
  spreadTicks: number | null;
  improvementTicks: number | null;
  deadSideObserved: boolean;
  deadSideBucket: string | null;
  deadSideEnforceHit: boolean;
  deadSideX60: boolean;
  deadSideX120: boolean;
  deadSideX300: boolean;
  deadSideX900: boolean;
  timeToEndMs: number | null;
  skippedReason: string | null;
  pricingDeltaTicks: number | null;
  roundLevelHit: PricingRoundLevel | null;
  sizingRuleId: string | null;
  notionalBucket: NotionalBucket | null;
  sellShadowAvgEntry: number | null;
  sellShadowAvgEntrySource: SellShadowAvgEntrySource | null;
  sellShadowSignalPrice: number | null;
  sellShadowExecutionPrice: number | null;
  sellShadowExecutionVsSignalRatio: number | null;
  sellShadowExecutionVsAvgEntryRatio: number | null;
  sellShadowCap5Violation: boolean | null;
  sellShadowCap10Violation: boolean | null;
  sellShadowExitPricingMode: ExitPricingMode | null;
  sellShadowExitAnchorMode: string | null;
  createdAt?: string;
}

export type SellShadowAvgEntrySource =
  | "position_repo"
  | "missing_position_repo"
  | "missing_position"
  | "invalid_avg_entry"
  | "error";

/**
 * ADR-023 D-F pricing telemetry — round-level taxonomy from R29 evidence
 * (entry_trigger_threshold_refinement_results.json checkpoint 0).
 * Precedence is mutually exclusive top-down: a price classified as `min_tick`
 * never also counts as `0.05x`, even when both predicates match.
 */
export type PricingRoundLevel = "min_tick" | "0.05x" | "0.01x" | "0.005x" | "off-round";

// ─── Algo Decision Engine Types ─────────────────────────────────────────

export interface AlgoDecisionRule {
  id: number;
  priority: number;
  ruleId: string;
  stateCondition: string;
  priceOperator: string | null;
  priceValue: number | null;
  timeSinceLastOperator: string | null;
  timeSinceLastSeconds: number | null;
  buyCountMin: number | null;
  buyCountMax: number | null;
  holdDurationOperator: string | null;
  holdDurationSeconds: number | null;
  action: string;
}

export interface AlgoSizeRule {
  id: number;
  actionType: string;
  priority: number;
  ruleId: string;
  stateCondition: string;
  priceOperator: string | null;
  priceValue: number | null;
  nthBuy: number | null;
  buyCountMin: number | null;
  buyCountMax: number | null;
  sizeUsdc: number;
}

export interface LegState {
  tokenId: TokenId;
  buyCount: number;
  sellCount: number;
  lastAction: "BUY" | "SELL";
  /**
   * Price of the first BUY fill that opened this leg (post-entry, leg-local).
   * Used by the continuation filter (06 spec §0 / ADR D1). NOT Gamma market-wide first trade.
   */
  firstTradePrice: number;
  firstTradeAt: string;
  lastTradeAt: string;
  updatedAt: string;
  /**
   * ADR-027 §D-C — cumulative shares bought across all BUY fills on this leg.
   * Numerator of the sold/bought ratio; denominator of the rolling cost basis
   * VWAP. Optional in the type so legacy test fixtures stay valid; the
   * production read paths in `nextLegStateForFill` and the SQLite repo
   * coalesce undefined to 0. Re-materialised on next bot restart via
   * updateLegStateForFill replay.
   */
  cumulativeBuySize?: number;
  /**
   * ADR-027 §D-C — cumulative USDC paid across all BUY fills on this leg
   * (Σ size_usdc, with fallback to price * size for legacy fills missing
   * size_usdc). This is the lifetime buy-VWAP numerator; it equals
   * positions.avg_entry_price on the first SELL but diverges afterwards
   * because the inventory engine recomputes avg_entry_price via FIFO from
   * remaining lots. exit_pnl_pct accordingly sources the rolling basis
   * from positions.avg_entry_price; this column stays as audit telemetry
   * / fallback for the (test-only) no-positionRepo path. Optional — see
   * cumulativeBuySize.
   */
  cumulativeBuyNotional?: number;
  /**
   * ADR-027 §D-C — cumulative shares sold across all SELL fills on this leg.
   * Numerator of the sold/bought ratio. Optional — see cumulativeBuySize.
   */
  cumulativeSellSize?: number;
  /**
   * CHANGE B — dust abandonment counter. Increments by 1 every time
   * algo-decision suppresses a SELL via shouldSuppressSellResidualBelowMinSize
   * (position size < market.minOrderSize). Resets to 0 on any BUY fill.
   * When it crosses dustAbandonmentPolicy.maxConsecutiveRejects the leg is
   * marked abandoned (abandoned_at_*). Optional for legacy fixtures.
   */
  consecutiveSellResidualRejects?: number;
  /**
   * CHANGE B — price snapshot at the moment we declared the token abandoned.
   * Used by shouldRecoverFromPriceMove to detect ≥priceRecoveryRatio upward
   * recovery (R67 spec 11.5). Null while the leg is healthy.
   */
  abandonedAtPrice?: number | null;
  /**
   * CHANGE B — ISO timestamp matching abandonedAtPrice. Presence of this
   * field (non-null) is the canonical "is abandoned" signal.
   */
  abandonedAtTs?: string | null;
  /**
   * CHANGE C — JSON-serialized array of ISO timestamps for reprice events
   * (downpriced_reprice or sell_replace_reprice) inside the active rolling
   * 24h window. Entries older than policy.windowMs are filtered out on
   * evaluation, so the cap is enforced against a true rolling count.
   * Null until the first reprice event arrives.
   */
  repriceChainEvents24hJson?: string | null;
  /**
   * @deprecated Legacy fixed-window counter — kept on the type for backwards
   * compatibility with migration 057's first version. New code uses
   * repriceChainEvents24hJson instead.
   */
  repriceChainCount24h?: number;
  /**
   * @deprecated Legacy fixed-window start timestamp — see
   * repriceChainEvents24hJson docs.
   */
  repriceChainWindowStartTs?: string | null;
}

export type LegPhase = "S0" | "S1" | "S2" | "S3" | "S4";
export type LegStateTransitionAction = "BUY" | "SELL" | "CLEAR" | "SETTLE";

export interface LegStateTransition {
  id: number;
  tokenId: TokenId;
  positionId: PositionId | null;
  fillId: FillId | null;
  orderId: OrderId | null;
  clientOrderId: ClientOrderId | null;
  conditionId: ConditionId | null;
  fromPhase: LegPhase;
  toPhase: LegPhase;
  action: LegStateTransitionAction;
  price: number | null;
  size: number | null;
  sizeUsdc: number | null;
  fromBuyCount: number;
  fromSellCount: number;
  toBuyCount: number;
  toSellCount: number;
  reason: string;
  occurredAt: string;
  createdAt: string;
}

// ─── Selection Rules ─────────────────────────────────────────────────────

export type SelectionRuleType =
  | "include_prefix"
  | "exclude_prefix"
  | "include_slug"
  | "exclude_slug";

export interface SelectionRule {
  readonly ruleId: string;
  readonly profileId: string;
  readonly ruleType: SelectionRuleType;
  readonly pattern: string;
  readonly enabled: boolean;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SelectionRuleDraft {
  readonly ruleType: SelectionRuleType;
  readonly pattern: string;
  readonly enabled: boolean;
  readonly note?: string | null;
}

export type SelectionStatus =
  | "unknown"
  | "matched_include"
  | "matched_exclude"
  /** Legacy status kept for dashboards/migrations; v5.11 admission no longer emits it. */
  | "step2_fallback_include"
  | "fallback_exclude";

export interface SelectionDecision {
  readonly status: "include" | "exclude" | "no_match";
  readonly winningRuleId: string | null;
}

// Hard-liveness model (binary execution-feasibility only, not 06-selection).
// Fail-closed on null — absent affirmative signal is treated as "not alive".
//
// See docs/superpowers/specs/2026-04-18-hard-liveness-split-design.md.

export type HealthStatus = "unknown" | "healthy" | "unhealthy";

export type HealthFailReason = "not_accepting_orders" | "order_book_disabled" | "no_bid";

export interface HealthInput {
  readonly acceptingOrders?: boolean | null;
  readonly enableOrderBook?: boolean | null;
  readonly bestBid?: number | null;
  readonly bestAsk?: number | null;
}

export interface HealthResult {
  readonly healthy: boolean;
  readonly reasons: readonly HealthFailReason[];
}

/**
 * Granular reject reason emitted alongside `finalStatus: "EXCLUDE"`. Stable
 * strings — scanner observability counters and dashboards key off them, so
 * additions require coordinated metric updates.
 */
export type PreEntryRejectReason =
  | "rule_exclude"
  | "strike_min_horizon" // renamed from strike_short_horizon (Track B D1)
  | "strike_yes_tail_short_runway" // new (Track B D1)
  | "mid_price_too_high"
  | "liquidity_too_low"
  | "zero_coverage_category"
  | "buy_guard_short_lifetime";

export interface PreEntryEvaluation {
  readonly finalStatus: "INCLUDE" | "EXCLUDE";
  readonly selectionStatus: SelectionStatus;
  readonly winningRuleId: string | null;
  /** Fine-grained reason for EXCLUDE; absent on INCLUDE. */
  readonly rejectReason?: PreEntryRejectReason;
  /** Strike-pattern kind when the gate matched a strike slug; surfaced for metrics + audit. */
  readonly strikePattern?: "between" | "greater_or_less_than" | "above";
  /** Remaining horizon in hours at decision time; surfaced for metrics + audit. */
  readonly horizonHours?: number;
}

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
   * for SELL/REDEEM, while `tradable: false` suppresses new BUY eligibility
   * in MarketSelectionCache.
   */
  tradable: boolean;
  tickSize: number;
  negRisk: boolean;
  /**
   * Number of markets in the parent Gamma event — persisted by scanner.
   * Required: callers must always carry the authoritative value from
   * Gamma `eventContext.marketCount`. Silent `?? 1` fallbacks are
   * forbidden (see ADR-019 §D2 — they auto-INCLUDE multi-outcome markets
   * via STEP 2 fallback).
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
  /** Number of markets in the parent Gamma event. Used for STEP 2 fallback: no_match && eventMarketCount === 1 ⇒ INCLUDE. */
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
   * Step 3 (audit doc §D4 / §P3 step 0) — propagated verbatim from
   * `Market.selectionStatus` so the soft-ranking-score module can filter
   * on Step2 inclusion without round-tripping to the DB. Null only on
   * paths that build a NormalizedMarket without a backing Market row.
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
  wideSpreadPolicy: ExecutionWideSpreadPolicy;
  oneSidedPolicy: ExecutionOneSidedPolicy;
}

export interface ExecutionPolicyTelemetry {
  deadSideCanary: boolean;
  pricingShadow: boolean;
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
  deadSideGuard: DeadSideGuardPolicy;
  pricing: ExecutionPricingPolicy;
  telemetry: ExecutionPolicyTelemetry;
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
  createdAt?: string;
}

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

export interface PreEntryEvaluation {
  readonly finalStatus: "INCLUDE" | "EXCLUDE";
  readonly selectionStatus: SelectionStatus;
  readonly winningRuleId: string | null;
}

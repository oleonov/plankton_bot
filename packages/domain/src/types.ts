import type {
  TokenId,
  ConditionId,
  OrderId,
  FillId,
  PositionId,
  ClientOrderId,
  LotId,
  BotRunId,
  ScorecardId,
  SwitchId,
  ReportId,
  ImportId,
} from "./ids.js";
import type {
  Regime,
  WalletMode,
  EvidenceStatus,
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
  /** Number of markets in the parent Gamma event — persisted by scanner. Defaults to 1. */
  eventMarketCount?: number;
  /** Result of evaluatePreEntry for this market — persisted by scanner. */
  selectionStatus?: SelectionStatus;
  /** The winning rule ID from evaluatePreEntry, or null. */
  selectionWinningRuleId?: string | null;
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
// familyId + tokenId + side within one scanner tick (F3 resolution).
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
  sequenceInTick: number; // 0-based within tick for same family+token+side
  decisionRuleId: string | null;
  generatedAt: string; // ISO timestamp
}

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
  exchangeOrderId: string | null;
  signalId: string | null;
  signalReason: string | null;
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
  entryStyle: "spray" | "probe" | null;
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
  targetId: string | null; // familyId for family-scoped commands; null for global
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
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  lastTradePrice?: number | null;
  lastTradeAt?: string | null;
  volume24h?: number | null;
  liquidity?: number | null;
  minOrderSize?: number | null;
  bookSource?: MarketBookSource | null;
  snapshotTs: number; // unix ms when pricing was captured
}

// ─── MarketResolution ────────────────────────────────────────────────────────

export interface MarketResolution {
  conditionId: string;
  resolution: string;
  resolvedAt: string; // ISO timestamp
  detectedAt: string; // ISO timestamp
  source: "gamma-api" | "gamma-delisted" | "manual";
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
  updatedAt: string;
}

export interface ValidationScorecard {
  scorecardId: ScorecardId;
  profile: ProfileId;
  evidenceStatus: EvidenceStatus;
  evidenceScore: number;
  recurrenceScore: number | null;
  recycleScore: number | null;
  liveViabilityScore: number | null;
  toxicityPenalty: number | null;
  tradeCount: number;
  marketCount: number;
  realizedPnl: number;
  tailAdjustedPnl: number;
  bothSidedEligible: boolean;
  heavyCampaignEligible: boolean;
  activeWindowEdgeScore: number | null;
  summaryJson: string | null;
  validatedAt: string;
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

export interface RuntimeControlState {
  currentProfile: ProfileId | null;
  desiredProfile: ProfileId | null;
  currentSwitchId: SwitchId | null;
  currentRunId: string | null;
  currentInstanceId: string | null;
  runtimeStatus: RuntimeStatus;
  paused: boolean;
  schemaVersion: number;
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
  firstTradePrice: number;
  firstTradeAt: string;
  lastTradeAt: string;
  updatedAt: string;
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

export interface PreEntryEvaluation {
  readonly finalStatus: "INCLUDE" | "EXCLUDE";
  readonly selectionStatus: SelectionStatus;
  readonly winningRuleId: string | null;
}

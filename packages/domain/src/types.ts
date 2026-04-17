import type {
  TokenId,
  ConditionId,
  FamilyId,
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
  StrategyProfile,
  FeeTier,
  LiveWalletRequirement,
  WalletMode,
  EvidenceStatus,
  PromotionState,
  Action,
  RuntimeMode,
  EntryMode,
  ExitMode,
  ScaleMode,
  SessionMode,
  TwoSidedMode,
  WeekdayBias,
  ProfitModel,
  OrderSide,
  OrderType,
  OrderStatus,
  LiquidityRole,
  PositionStatus,
  SignalReason,
  OperatorActionType,
  CommandStatus,
  ProfileId,
  DeploymentStage,
  StrategyStage,
  OperatorMode,
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
  familyId: FamilyId | null;
  familyKey: string | null;
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

// ─── Family — Identity layer ──────────────────────────────────────────────────

export interface FamilyIdentity {
  familyId: FamilyId;
  familyKey: string;
  primaryCategory: string;
  regime: Regime;
  horizon: string;
  cadence: string;
  strategyProfile: StrategyProfile;
  topicKey: string | null;
  slugPattern: string | null;
  notes: string | null;
  feeTier?: FeeTier | null;
  liveWalletRequirement?: LiveWalletRequirement | null;
  requiresPostOnlyForLive?: boolean | null;
}

// ─── Family — Evidence layer ──────────────────────────────────────────────────

export interface FamilyEvidence {
  familyId: FamilyId;
  evidenceStatus: EvidenceStatus;
  evidenceScore: number;
  promotionState: PromotionState;
  localTradeCount: number;
  localMarketCount: number;
  localRealizedPnlFifo: number;
  openTailCostUsdc: number;
  tailAdjustedPnl: number;
  remoteClosedRealizedPnl: number | null;
  openPositionCount: number | null;
  openDustCount: number | null;
  bothSidedEligible: boolean;
  heavyCampaignEligible: boolean;
  activeWindowEdgeScore: number | null;
  recurrenceScore: number | null;
  recycleScore: number | null;
  liveViabilityScore: number | null;
  toxicityPenalty: number | null;
  lastValidatedAt: string | null; // ISO timestamp
  probeSubstate: string | null;
  repricingExitCount: number;
}

// ─── Family — Rules layer (seven sub-blocks) ──────────────────────────────────

export interface TimeWindow {
  start: string; // "HH:MM" UTC
  end: string; // "HH:MM" UTC
}

export interface UniverseRules {
  enabled: boolean;
  action: Action;
  priorityRank: number;
  sessionMode: SessionMode;
}

export interface EntryRules {
  entryMode: EntryMode;
  minEntryPrice: number;
  maxEntryPrice: number;
  maxInitialNotionalUsdc: number;
  allowHighPriceOneShot: boolean;
  highPriceThreshold: number;
  requireProvenFamilyAbovePrice: number;
  preferredEntryBand: string | null;
  maxProbeCountPerMarket: number | null;
  entryCooldownSeconds: number | null;
  maxNewMarketsPerSession: number | null;
  probeSizeUsdc: number; // size for first buy (probe entry)
  addSizeUsdc: number; // size for subsequent buys (scale-in)
}

export interface ScaleInRules {
  scaleMode: ScaleMode;
  defaultMaxBuysPerLeg: number;
  heavyMaxBuysPerLeg: number;
  allowHeavyCampaigns: boolean;
  requirePositiveRecycleHistoryForScale: boolean;
}

export interface ExitRules {
  exitMode: ExitMode;
  primaryProfitModel: ProfitModel;
  allowRunnerExtension: boolean;
  preferFastRecycle: boolean;
  resolutionHoldingAllowed: boolean;
  resolutionBufferMinutes: number;
  targetRoiBandLow: number | null;
  targetRoiBandHigh: number | null;
  maxUnmovedHoldHours: number | null;
  maxTailHoldHours: number | null;
}

export interface TwoSidedRules {
  allowTwoSided: boolean;
  twoSidedMode: TwoSidedMode;
  minActivityForTwoSided: number | null;
  maxAdditionalEntryPrice?: number | null;
}

export interface ThroughputRules {
  maxConcurrentOrdersPerFamily: number | null;
  maxProbeInFlightPerToken: number | null;
  maxEntrySignalsPerTickPerFamily: number | null;
  fastLaneEnabled?: boolean | null;
  dustLaneEnabled?: boolean | null;
  queueJumpCanaryEnabled?: boolean | null;
}

export interface TailSuppressionRules {
  maxOpenValueUsdc: number;
  maxActiveMarkets: number;
  maxDustPositions: number;
  tailQuarantineThresholdUsdc: number;
  tailQuarantineThresholdRatio: number;
  staleTailPruneEnabled: boolean;
  thresholdCleanupRequired: boolean;
  autoSettleResolvedMarkets: boolean;
}

export interface SessionRules {
  activeWindowsUtc: TimeWindow[];
  reducedWindowsUtc: TimeWindow[];
  weekdayBias: WeekdayBias;
}

export interface FamilyRules {
  familyId: FamilyId;
  universe: UniverseRules;
  entry: EntryRules;
  scaleIn: ScaleInRules;
  exit: ExitRules;
  twoSided: TwoSidedRules;
  throughput?: ThroughputRules;
  tailSuppression: TailSuppressionRules;
  session: SessionRules;
}

// ─── Family — composite config (as loaded from YAML / DB) ────────────────────

export interface FamilyConfig {
  identity: FamilyIdentity;
  evidence: FamilyEvidence;
  rules: FamilyRules;
}

// ─── Family — Runtime State layer ─────────────────────────────────────────────

export interface FamilyState {
  familyId: FamilyId;
  runtimeMode: RuntimeMode;
  openValueUsdc: number;
  openPositionCount: number;
  openDustCount: number;
  activeMarketCount: number;
  currentTailCostUsdc: number;
  tailAdjustedPnlLive: number;
  lastEntryTs: string | null; // ISO timestamp
  lastExitTs: string | null; // ISO timestamp
  quarantineReason: string | null;
  effectiveMode: string | null;
  derivedModeReason: string | null;
  firstNegativeTailAt: string | null;
  updatedAt: string; // ISO timestamp
}

// ─── Signal ───────────────────────────────────────────────────────────────────
//
// sequenceInTick: 0-based counter for signals sharing the same
// familyId + tokenId + side within one scanner tick (F3 resolution).
// Required for deterministic buildClientOrderId deduplication.

export interface Signal {
  signalId: string;
  familyId: FamilyId | null;
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
  familyId: FamilyId | null;
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
  familyId: FamilyId | null;
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
  familyId: FamilyId | null;
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
  familyId: FamilyId | null;
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
  familyId: FamilyId | null;
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
  question: string;
  outcome: string;
  outcomeIndex?: number | null;
  familyId: FamilyId | null;
  familyKey: string | null;
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

export interface FamilyDeployment {
  familyId: FamilyId;
  profile: ProfileId;
  enabled: boolean;
  operatorMode: OperatorMode;
  strategyStage: StrategyStage;
  probeSubstate: string | null;
  deploymentStage: DeploymentStage;
  approvedSnapshotId: number | null;
  approvedScorecardId: ScorecardId | null;
  operatorReason: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationScorecard {
  scorecardId: ScorecardId;
  familyId: FamilyId;
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
  familiesAdded: number;
  familiesUpdated: number;
  familiesSkipped: number;
  familiesUnchanged: number;
  resultJson: string | null;
  importedAt: string;
  importedBy: string | null;
}

export interface FamilyConfigMeta {
  familyId: FamilyId;
  lastImportedAt: string | null;
  lastOperatorEditAt: string | null;
  importChecksum: string | null;
}

export interface FamilyProfileRollup {
  familyId: FamilyId;
  profile: ProfileId;
  openValueUsdc: number;
  openPositions: number;
  activeMarkets: number;
  realizedPnl: number;
  tailCostUsdc: number;
  tailAdjustedPnl: number;
  effectiveMode: string | null;
  lastTradeAt: string | null;
  updatedAt: string;
}

export interface FamilyProfileRuntimeState {
  familyId: FamilyId;
  openValueUsdc: number;
  openPositionCount: number;
  openDustCount: number;
  activeMarketCount: number;
  currentTailCostUsdc: number;
  tailAdjustedPnlLive: number;
  lastEntryTs: string | null;
  lastExitTs: string | null;
  effectiveMode: string | null;
  derivedModeReason: string | null;
  firstNegativeTailAt: string | null;
  updatedAt: string;
}

export interface SettlementRecord {
  settlementId: string;
  conditionId: string;
  positionId: string;
  tokenId: string;
  familyId: string;
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
  familyId: string;
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

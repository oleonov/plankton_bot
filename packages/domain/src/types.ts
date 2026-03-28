import type {
  TokenId,
  FamilyId,
  OrderId,
  FillId,
  PositionId,
  ClientOrderId,
  LotId,
  BotRunId,
} from "./ids.js";
import type {
  Regime,
  StrategyProfile,
  EvidenceStatus,
  PromotionState,
  Action,
  RuntimeMode,
  EntryMode,
  ExitMode,
  ScaleMode,
  SessionMode,
  TwoSidedMode,
  WeekendMode,
  WeekdayBias,
  ProfitModel,
  OrderSide,
  OrderType,
  OrderStatus,
  PositionStatus,
  SignalReason,
  OperatorActionType,
  CommandStatus,
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
  outcome: "YES" | "NO";
  familyId: FamilyId | null;
  familyKey: string | null;
  regime: Regime | null;
  horizon: string | null;
  endDate: string | null; // ISO timestamp
  active: boolean;
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
  timestamp: number; // unix ms
}

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
  allowWeekends: boolean;
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
  weekendMode: WeekendMode;
}

export interface FamilyRules {
  familyId: FamilyId;
  universe: UniverseRules;
  entry: EntryRules;
  scaleIn: ScaleInRules;
  exit: ExitRules;
  twoSided: TwoSidedRules;
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
  familyId: FamilyId;
  tokenId: TokenId;
  side: OrderSide;
  suggestedPrice: number;
  suggestedSize: number; // share quantity
  suggestedSizeUsdc: number; // USDC notional (= suggestedSize × suggestedPrice)
  reason: SignalReason;
  strategyTick: number; // epoch ms of the scanner tick
  sequenceInTick: number; // 0-based within tick for same family+token+side
  generatedAt: string; // ISO timestamp
}

// ─── Risk Decision ────────────────────────────────────────────────────────────

export interface RiskDecision {
  signalId: string;
  familyId: FamilyId;
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
  familyId: FamilyId;
  side: OrderSide;
  orderType: OrderType;
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
  familyId: FamilyId;
  side: OrderSide;
  price: number;
  size: number; // shares executed
  sizeUsdc: number; // notional (= size × price)
  fee: number;
  filledAt: string; // ISO timestamp
}

// ─── Position ─────────────────────────────────────────────────────────────────

export interface Position {
  positionId: PositionId;
  tokenId: TokenId;
  familyId: FamilyId;
  side: OrderSide;
  size: number; // current share quantity
  avgEntryPrice: number;
  costBasisUsdc: number; // total USDC paid to acquire current size
  currentValueUsdc: number | null;
  realizedPnl: number;
  status: PositionStatus;
  openedAt: string; // ISO timestamp
  closedAt: string | null; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

// ─── Inventory Lot (FIFO cost basis tracking) ────────────────────────────────

export interface InventoryLot {
  lotId: LotId;
  positionId: PositionId;
  tokenId: TokenId;
  familyId: FamilyId;
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
  outcome: "YES" | "NO";
  familyId: FamilyId | null;
  familyKey: string | null;
  regime: Regime | null;
  horizon: string | null;
  endDate: string | null;
  active: boolean;
  tickSize: number;
  negRisk: boolean;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  snapshotTs: number; // unix ms when pricing was captured
}

// ─── MarketResolution ────────────────────────────────────────────────────────

export interface MarketResolution {
  conditionId: string;
  resolution: "YES" | "NO" | "unknown";
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

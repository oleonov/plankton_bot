/** API response envelope */
export interface ApiEnvelope<T> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
  ts: string;
}

// ─── Selection Rules ─────────────────────────────────────────────────────────

export type SelectionRuleType =
  | "include_prefix"
  | "exclude_prefix"
  | "include_slug"
  | "exclude_slug";

export interface SelectionRule {
  ruleId: string;
  profileId: string;
  ruleType: SelectionRuleType;
  pattern: string;
  enabled: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PreviewRow {
  conditionId: string;
  slug: string;
  eventSlug: string | null;
  eventMarketCount: number;
  winningRuleId: string | null;
}

export interface PreviewBuckets {
  matchedInclude: PreviewRow[];
  matchedExclude: PreviewRow[];
  step2FallbackInclude: PreviewRow[];
  fallbackExclude: PreviewRow[];
}

export interface MatchResult {
  decision: "include" | "exclude" | "no_match";
  winningRuleId: string | null;
  finalStatus: "INCLUDE" | "EXCLUDE";
  step2Fallback: boolean;
}

export interface EventMetric {
  eventSlug: string;
  realizedPnl: number;
  unrealizedPnl: number;
  volumeUsdc: number;
  positionCount: number;
}

export interface ExecutionTelemetryWindow {
  windowHours: number;
  totalFills: number;
  volumeUsdc: number;
  makerFills: number;
  takerFills: number;
  unknownFills: number;
  makerRatio: number | null;
  takerRatio: number | null;
  explicitFeesUsdc: number;
  feeLeakageRatio: number | null;
  lastFillAt: string | null;
}

/** GET /status */
export interface StatusData {
  runtimeMode: string;
  uptimeSeconds: number;
  paused: boolean;
  lastReconciliationAt: string | null;
  marketDataStale: boolean;
  marketDataLastUpdateAt: string | null;
  openConditionCount: number;
  openOrderCount: number;
  openPositionCount: number;
  ordersPlacedLastMin: number;
  positionsOpenedLastMin: number;
  totalOpenValueUsdc: number;
  totalTailCostUsdc: number;
  initialBalanceUsdc: number | null;
  balanceUsdc: number | null;
  walletBalanceUsdc: number | null;
  totalCurrentValueUsdc: number;
  totalRealizedPnl: number;
  marketDataSource: "live" | "simulation";
  executionMode: "simulation" | "live";
  liveLite?: {
    maxOpenValueUsdc: number;
    maxOrderUsdc: number;
    maxActiveMarkets: number;
    walletMode?: "eoa" | "relayer";
    minOrderUsdc?: number | null;
  };
  reconciliationDriftDetected: boolean;
  marketDataPoll?: { active: boolean; page: number };
  tradingState?: string;
  signalActivity?: {
    signalsProducedLast10m: number;
    signalsApprovedLast10m: number;
    signalsRejectedLast10m: number;
    entrySignalsApprovedLast10m: number;
    exitSignalsApprovedLast10m: number;
    lastEntryApprovedAt: string | null;
    lastSignalRejectedAt: string | null;
    approvalRate: number | null;
    candidatesConsideredLast10m?: number;
    blockedByResolutionBufferLast10m?: number;
    blockedByWindowLast10m?: number;
    gammaFallbackDustSignalsLast10m?: number;
    gammaFallbackDustOrdersLast10m?: number;
    gammaFallbackDustFillsLast10m?: number;
    scanPrimeSkippedByPolicyLast10m?: number;
    candidateBookRefreshAttemptsLast10m?: number;
    candidateBookRefreshTimeoutsLast10m?: number;
    signalsConvertedLast10m?: number;
    marketabilityRejectedLast10mByReason?: Record<string, number>;
    cacheStatusLast10mByStatus?: Record<string, number>;
    exchangeAcceptedLast10m?: number;
    exchangeRejectedLast10mByCode?: Record<string, number>;
    fillsLast10m?: number;
    fillLatencyMsLast10m?: Record<string, number> | null;
    cooldownBypassLast10mByReason?: Record<string, number>;
    hotQuoteRefreshesLast10m?: number;
    hotLaneActionsLast10mByType?: Record<string, number>;
    hotLaneStatesLast10mByState?: Record<string, number>;
    queueJumpAcceptedLast10m?: number;
    queueJumpFillsLast10m?: number;
    topBlockingLayer?: string | null;
  };
  executionQueue?: {
    pendingCount?: number;
    queueDepth?: number;
    activeCount?: number;
    maxConcurrency?: number | null;
    placeCompleted?: number;
    cancelCompleted?: number;
    avgPlaceLatencyMs?: number | null;
    avgCancelLatencyMs?: number | null;
    reservedBuyUsdc?: number;
    freeUsdcForNewOrders?: number | null;
    reservedSellTokenCount?: number;
    cancelReplacePendingCount?: number;
    gatewayRejectsLast10mByCode?: Record<string, number>;
    internalReservationRejectsLast10m?: number;
  } | null;
  executionTelemetry24h?: ExecutionTelemetryWindow;
  infraAlerts?: Array<{
    code: string;
    severity: "warning" | "error";
    source: string;
    message: string;
    details?: Record<string, unknown> | null;
    lastSeenAt: string;
  }>;
}

/** GET /metrics */
export interface MetricsData {
  positions: Record<string, number>;
  orders: Record<string, number>;
  fills: {
    count: number;
    volumeUsdc: number;
    makerCount?: number;
    takerCount?: number;
    unknownCount?: number;
    explicitFeesUsdc?: number;
    feeLeakageRatio?: number | null;
  };
  totalRealizedPnl: number;
}

/** GET /metrics/pnl-series */
export interface PnlDataPoint {
  date: string;
  realizedPnl: number;
}

/** GET /metrics/portfolio-series */
export interface PortfolioDataPoint {
  equityUsdc: number;
  realizedPnlUsdc: number;
  positionValueUsdc: number;
  openValueUsdc: number;
  capturedAt: string;
}

export interface PortfolioSeriesResponse {
  items: PortfolioDataPoint[];
  baseline: number;
  currentEquity: number;
  portfolioPnl: number;
  interval: string;
  historyStart: string | null;
  coverageComplete: boolean;
}

/** GET /metrics/trading-activity item */
export interface TradingActivitySnapshot {
  tradingState: string;
  signalsProduced: number;
  signalsApproved: number;
  signalsRejected: number;
  capturedAt: string;
}

/** GET /positions item */
export interface PositionDTO {
  positionId: string;
  tokenId: string;
  side: string;
  size: number;
  avgEntryPrice: number;
  costBasisUsdc: number;
  currentValueUsdc: number | null;
  realizedPnl: number;
  status: string;
  openedAt: string;
  closedAt: string | null;
  updatedAt: string;
  slug: string | null;
  eventSlug: string | null;
  question: string | null;
  outcome: string | null;
  conditionId: string | null;
  endDate: string | null;
  resolution: string | null;
  resolutionStatus: string | null;
}

/** GET /orders item */
export interface OrderDTO {
  orderId: string;
  clientOrderId: string;
  tokenId: string;
  side: string;
  orderType: string;
  postOnly?: boolean;
  price: number;
  size: number;
  sizeUsdc: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  slug: string | null;
  eventSlug: string | null;
  question: string | null;
  outcome: string | null;
  conditionId: string | null;
  endDate: string | null;
}

/** GET /fills item */
export interface FillDTO {
  fillId: string;
  orderId: string;
  tokenId: string;
  side: string;
  price: number;
  size: number;
  sizeUsdc: number;
  liquidityRole?: "maker" | "taker" | "unknown";
  explicitFeeUsdc?: number;
  fee: number;
  filledAt: string;
  slug: string | null;
  eventSlug: string | null;
  question: string | null;
  outcome: string | null;
  conditionId: string | null;
  endDate: string | null;
}

export interface FamilyListMeta {
  scope: "profile" | "all";
  profile: string | null;
  totalCount: number;
  totalCatalogCount: number;
  nextCursor: string | null;
  hasMore: boolean;
  page?: number;
  pageSize?: number;
  totalPages?: number;
}

/** GET /risk-events item */
export interface RiskEventDTO {
  id: number;
  eventType: string;
  summary: string;
  severity: "critical" | "warning" | "info";
  createdAt: string;
}

/** Paginated response */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  totalCount?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
}

/** GET /families/:id/transitions item */
export interface TransitionDTO {
  id: number;
  entityType: string;
  entityId: string;
  fromState: string;
  toState: string;
  triggerType: string;
  initiator: string;
  reason: string;
  scoresSnapshot: string | null;
  createdAt: string;
}

/** GET /profiles item */
export interface ProfileDTO {
  profile_id: string;
  display_name: string;
  description: string | null;
  paused: number | null;
  last_run_at: string | null;
  open_orders: number | null;
  open_positions: number | null;
  total_exposure_usdc: number | null;
  balance_usdc: number | null;
  last_preflight_status: string | null;
  updated_at: string | null;
}

/** GET /profiles response */
export interface ProfilesResponse {
  profiles: ProfileDTO[];
  runtimeState: {
    current_profile: string | null;
    desired_profile: string | null;
    runtime_status: string;
  } | null;
}

/** GET /profiles/:id response */
export interface ProfileDetailDTO {
  profile: ProfileDTO;
  settings: ProfileSettingsDTO | null;
}

export interface ProfileSettingsDTO {
  profile_id: string;
  initial_balance_usdc: number | null;
  envelope_json: string | null;
  risk_caps_json: string | null;
  wallet_mode?: "eoa" | "relayer" | null;
  min_order_usdc?: number | null;
  relayer_json?: string | null;
  updated_at: string;
}

/** GET /audit item */
export interface AuditEntryDTO {
  id: number;
  entity_type: string;
  entity_id: string;
  from_state: string;
  to_state: string;
  trigger_type: string;
  initiator: string;
  reason: string;
  profile: string | null;
  created_at: string;
}

/** POST /actions/switch-profile response */
export interface SwitchResponse {
  switchId: string;
  status: string;
}

/** GET /control/overview response */
export interface ControlOverviewDTO {
  profiles: ProfileDTO[];
  runtimeState: {
    current_profile: string | null;
    desired_profile: string | null;
    runtime_status: string;
    paused: number | null;
    current_run_id: string | null;
  } | null;
  activeSwitch: Record<string, unknown> | null;
  recentTransitions: AuditEntryDTO[];
  heartbeats: Record<string, unknown>[];
}

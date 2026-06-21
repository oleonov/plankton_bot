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

// ─── Execution Policy (ADR-015) ──────────────────────────────────────────────

export type DeadSideGuardMode = "observe" | "enforce" | "off";
export type PricingMode = "edge" | "bounded-midpoint";
export type PricingSpreadPolicy = "edge" | "skip";
export type PricingOneSidedPolicy = "edge" | "skip";

export interface DeadSideGuardPolicy {
  mode: DeadSideGuardMode;
  askCeiling: number;
  maxTimeToEndMs: number;
}

export interface ExecutionPricingPolicy {
  mode: PricingMode;
  maxEntrySpreadTicks: number;
  maxExitSpreadTicks: number;
  maxImprovementTicks: number;
  minExitPriceSignalRatio: number;
  wideSpreadPolicy: PricingSpreadPolicy;
  oneSidedPolicy: PricingOneSidedPolicy;
}

export interface ExecutionTelemetryPolicy {
  deadSideCanary: boolean;
  pricingShadow: boolean;
}

export interface MarketSelectionPolicy {
  maxMidPrice: number;
  minLiquidity: number;
}

export interface BuyCapacityPolicy {
  enabled: boolean;
  minNewEntryWalletHeadroomUsdc: number;
  minAddWalletHeadroomUsdc: number;
  maxOpenBuyOrders: number;
  maxOpenBuyOrdersPerToken: number;
}

export interface SellCapacityPolicy {
  enabled: boolean;
  maxOpenSellOrders: number;
  maxOpenSellOrdersPerToken: number;
}

export interface OrderCapacityPolicy {
  enabled: boolean;
  maxOpenOrdersTotal: number;
}

export interface OpportunisticTakerPolicy {
  enabled: boolean;
  maxSpreadTicks: number;
  safetyBuffer: number;
  fallbackMinNotionalUsdc: number;
  marketableBuyMinNotionalUsdc: number;
}

export interface RedeemSweepPolicy {
  enabled: boolean;
  intervalMs: number;
  inFlightTtlMs: number;
  maxRetries: number;
  retryBackoffMs: number[];
  postRedeemVerifyDelayMs: number;
}

export interface RaceProtectionPolicy {
  redeemInFlight: {
    enabled: boolean;
  };
}

export interface ExecutionProfilePolicy {
  enabled: boolean;
  maxTokensPerCycle: number;
  qdHandoffThresholdMs: number;
  profileHysteresis: {
    cheapMediumLow: number;
    cheapMediumHigh: number;
    mediumExpensiveLow: number;
    mediumExpensiveHigh: number;
  };
  costCaps: { enabled: boolean };
  scaleIn: { enabled: boolean; useRealFeed: boolean };
  signalFeed: {
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
  };
  profiles: {
    cheap: ExecutionProfileProfilePolicy;
    medium: ExecutionProfileProfilePolicy;
    expensive: ExecutionProfileProfilePolicy;
  };
  sellLadder: { enabled: boolean };
  adoptExistingPositions: { enabled: boolean };
  adoptExistingS1Ladders: { enabled: boolean };
  monitoring: {
    healthCheckIntervalMs: number;
    rollupWindowMs: number;
    maxRollupBuckets: number;
    pendingScaleInWarnAfterMs: number;
    healthRiskEventEveryMs: number;
    anomalyDetection: {
      enabled: boolean;
      cooldownMs: number;
    };
  };
}

export interface ExecutionProfileCostCapProfilePolicy {
  normalCapUsd: number;
  aggressiveCapUsd: number;
  hardCapAtAggressive: boolean;
}

export interface ExecutionProfileProfilePolicy {
  costCaps: ExecutionProfileCostCapProfilePolicy;
  scaleIn: ExecutionProfileScaleInProfilePolicy;
}

export interface ExecutionProfileScaleInProfilePolicy {
  initialProbeSizeUsd: number;
  sizingDecay: readonly number[];
  minTimeBetweenAddsMs: number;
  minAddNotionalUsd: number;
  modes: {
    up: { thresholdPct: number };
    flat: { thresholdPct: number };
    avgDown: {
      enabled: boolean;
      thresholdPct: number;
      requireRecovery: boolean;
      recoveryThreshold: number;
    };
  };
  triggers: {
    activity: { tradeCount3hThreshold: number };
    recovery: { threshold: number; strongThreshold: number; strongActivityRecoveryFloor: number };
    volatility: { range60Threshold: number; std60Threshold: number };
    strongActivity: { tradeCount3hThreshold: number };
  };
}

export interface ExecutionPolicyDTO {
  version: 1;
  entryPriceCeiling: number;
  exitOrderTtlMs: number;
  exitTtlByLiquidity?: {
    enabled: boolean;
    thinMs: number;
    mediumMs: number;
  };
  sellReplaceMinPriceDeltaTicks?: number;
  exitRepriceThresholdPct?: number;
  exitRepriceThresholdTicks?: number;
  exitPricingMode?: "bid-anchored" | "midpoint-anchored" | "edge";
  exitBidAnchorTicks?: number;
  exitMidpointAnchorTicks?: number;
  repriceChain?: {
    enabled: boolean;
    windowMs: number;
    maxChainCount: number;
    dynamicChainCap?: {
      enabled: boolean;
      tradeCountThinThreshold: number;
      tradeCountLiquidThreshold: number;
      capThin: number;
      capMedium: number;
      capLiquid: number;
      capUnknown: number;
    };
  };
  /**
   * Step 0 §P3 — minimum market age (gamma createdAt → first BUY) in seconds.
   * `0` disables the gate (used by simulation). Canonical floor is 2,504 s
   * per spec §1.7 R1 (`06:423`).
   */
  entryMinMarketAgeSeconds: number;
  marketSelection: MarketSelectionPolicy;
  buyCapacity: BuyCapacityPolicy;
  sellCapacity: SellCapacityPolicy;
  orderCapacity: OrderCapacityPolicy;
  deadSideGuard: DeadSideGuardPolicy;
  pricing: ExecutionPricingPolicy;
  opportunisticTaker?: OpportunisticTakerPolicy;
  redeemSweep?: RedeemSweepPolicy;
  raceProtection?: RaceProtectionPolicy;
  executionProfile?: ExecutionProfilePolicy;
  telemetry: ExecutionTelemetryPolicy;
}

export interface ExecutionPolicyResponse {
  policy: ExecutionPolicyDTO;
  version: number;
  issues: string[];
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

export interface PolymarketPortfolioStatus {
  portfolioUsdc: number;
  availableUsdc: number;
  positionValueUsdc: number;
  positionCount: number;
  costBasisUsdc: number;
  source: "polymarket";
  capturedAt: string;
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
  openOrderBreakdown?: {
    total: number;
    buy: {
      open: number;
      cap: number | null;
    };
    sell: {
      open: number;
      cap: number | null;
    };
    profileLadderSell: {
      open: number;
    };
  };
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
  polymarketPortfolio: PolymarketPortfolioStatus | null;
  marketDataSource: "live" | "simulation";
  executionMode: "simulation" | "live";
  liveLite?: {
    maxOpenValueUsdc: number;
    maxOrderUsdc: number;
    maxActiveMarkets: number;
    activeMarketCount?: number;
    activeMarketCapUtilizationPct?: number;
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
    scanPrimeSkippedByPolicyLast10m?: number;
    signalsConvertedLast10m?: number;
    conversionSkippedLast10mByReason?: Record<string, number>;
    cacheStatusLast10mByStatus?: Record<string, number>;
    exchangeAcceptedLast10m?: number;
    exchangeRejectedLast10mByCode?: Record<string, number>;
    exchangeRejectedLast10mByReason?: Record<string, number>;
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
    buyCapacity?: {
      enabled: boolean;
      minNewEntryWalletHeadroomUsdc: number;
      minAddWalletHeadroomUsdc: number;
      maxOpenBuyOrders: number;
      maxOpenBuyOrdersPerToken: number;
      openBuyOrderCount: number;
      newEntryCapacityUsdc: number | null;
      addCapacityUsdc: number | null;
      entriesBlocked: boolean;
      addsBlocked: boolean;
    };
    sellCapacity?: {
      enabled: boolean;
      maxOpenSellOrders: number;
      maxOpenSellOrdersPerToken: number;
      openSellOrderCount: number;
      blocked: boolean;
    };
    orderCapacity?: {
      enabled: boolean;
      maxOpenOrdersTotal: number;
      openOrdersTotal: number;
      blocked: boolean;
    };
    reservedSellTokenCount?: number;
    cancelReplacePendingCount?: number;
    gatewayRejectsLast10mByCode?: Record<string, number>;
    internalReservationRejectsLast10m?: number;
  } | null;
  orderCapacityActivity?: {
    placeCalls?: number;
    rejectedByReason?: Record<string, number>;
    openBuyOrderCountBuckets?: Record<string, number>;
    openSellOrderCountBuckets?: Record<string, number>;
    openOrdersTotalBuckets?: Record<string, number>;
    perTokenOpenBuyOrderCountBuckets?: Record<string, number>;
    perTokenOpenSellOrderCountBuckets?: Record<string, number>;
    windowStartMs?: number;
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

/** GET /dashboard/kpi */
export type DashboardHealthSeverity = "ok" | "warn" | "crit";

export interface DashboardHealthCheck {
  key: "stuck" | "lag" | "restart" | "mode" | "hold_resolution";
  severity: DashboardHealthSeverity;
  label: string;
  value: string;
}

export interface DashboardWinrateBreakdown {
  value: number;
  wins: number;
  losses: number;
  total: number;
  sell_closed_pct: number;
  resolved_closed_pct: number;
}

export interface DashboardWinrateCohort extends DashboardWinrateBreakdown {
  label: string;
}

export interface DashboardKpiData {
  winrate_7d: DashboardWinrateBreakdown & {
    cohort_cutoff: string;
    cohorts: {
      pre_v072: DashboardWinrateCohort;
      post_v072: DashboardWinrateCohort;
    };
  };
  exit_multiple_7d: {
    median: number;
    p90: number;
    count: number;
  };
  fills_24h: {
    total: number;
    maker: number;
    taker: number;
    unknown: number;
    maker_ratio: number;
    volume_usd: number;
    rate_per_position: number;
  };
  open_positions_count: number;
  stuck_positions_count: number;
  health: {
    severity: DashboardHealthSeverity;
    ws_tracked: number;
    ws_total: number;
    lag_p95_ms: number;
    restarts_24h: number;
    oom_24h: number;
    mode: string;
    paused: boolean;
    checks: DashboardHealthCheck[];
  };
}

/** GET /metrics/coverage */
export interface CoverageMetricsData {
  ws_tracked: number;
  universe_active: number;
  markets_total: number;
  markets_active: number;
  coverage_pct: number;
  events_per_sec: number;
  raw_ws_records: number;
  raw_ws_records_per_sec: number;
  parsed_updates: number;
  parsed_updates_per_sec: number;
  emitted_updates: number;
  emitted_updates_per_sec: number;
  noop_updates: number;
  noop_updates_per_sec: number;
  suppressed_trading_noop_count_total: number;
  suppressed_trading_noop_per_sec: number;
  suppressed_trading_noop_by_reason: {
    top_of_book_only: number;
    book_only: number;
    last_trade_only: number;
    tick_size_only: number;
    mixed_non_critical: number;
  };
  hub_filter_checked: number;
  hub_filter_checked_per_sec: number;
  hub_filter_passed: number;
  hub_filter_passed_per_sec: number;
  shard_count: number;
  rotation_cycle_hours: number;
  positions_opened_24h: number;
  plankton_reference_weekly: number;
  discovery_batch_size: number;
  discovery_poll_interval_ms: number;
  max_tracked_tokens: number | null;
  decision_tick_latency_p95_ms: number | null;
  decision_tick_latency_p99_ms: number | null;
  r23_cache_hit_rate: number | null;
  event_loop_lag_max_ms: number | null;
  event_loop_lag_p95_ms: number | null;
  gc_pause_max_ms: number | null;
  stage_ipc_decode_max_ms: number | null;
  stage_ipc_decode_p95_ms: number | null;
  stage_handle_worker_batch_max_ms: number | null;
  stage_handle_worker_batch_p95_ms: number | null;
  stage_hub_dispatch_max_ms: number | null;
  stage_hub_dispatch_p95_ms: number | null;
  stage_coalescing_flush_max_ms: number | null;
  stage_coalescing_flush_p95_ms: number | null;
  stage_latency_summary_max_ms: number | null;
  stage_latency_summary_p95_ms: number | null;
  stage_diagnostics_write_max_ms: number | null;
  stage_diagnostics_write_p95_ms: number | null;
  stage_metrics_flush_total_max_ms: number | null;
  stage_metrics_flush_total_p95_ms: number | null;
  stage_metrics_flush_sqlite_writes_max_ms: number | null;
  stage_metrics_flush_sqlite_writes_p95_ms: number | null;
  stage_metrics_flush_snapshot_serialize_max_ms: number | null;
  stage_metrics_flush_snapshot_serialize_p95_ms: number | null;
  stage_risk_signal_approval_max_ms: number | null;
  stage_risk_signal_approval_p95_ms: number | null;
  stage_signal_to_order_bridge_max_ms: number | null;
  stage_signal_to_order_bridge_p95_ms: number | null;
  stage_worker_non_update_events_max_ms: number | null;
  stage_worker_non_update_events_p95_ms: number | null;
  stage_discovery_poll_publish_max_ms: number | null;
  stage_discovery_poll_publish_p95_ms: number | null;
  stage_signal_path_aggregate_max_ms: number | null;
  stage_signal_path_aggregate_p95_ms: number | null;
  stage_cooldown_registry_sweep_max_ms: number | null;
  stage_cooldown_registry_sweep_p95_ms: number | null;
  signals_suppressed_early_cooldown_total: number;
  signals_suppressed_early_cooldown_by_token: Record<string, number>;
  cooldown_registry_size: number;
  cooldown_signal_dedupe_total: number;
  cooldown_signal_dedupe_early_only: number;
  cooldown_signal_dedupe_late_only: number;
  cooldown_signal_dedupe_early_and_late: number;
  cooldown_signal_dedupe_duplicate_early: number;
  cooldown_signal_dedupe_duplicate_late: number;
  cooldown_price_dedupe_total: number;
  cooldown_price_dedupe_early_only: number;
  cooldown_price_dedupe_late_only: number;
  cooldown_price_dedupe_early_and_late: number;
  cooldown_price_dedupe_duplicate_early: number;
  cooldown_price_dedupe_duplicate_late: number;
  cooldown_price_dedupe_skipped_no_price: number;
  cooldown_signal_unique_signals_total: number;
  cooldown_signal_early_only_total: number;
  cooldown_signal_late_only_total: number;
  cooldown_signal_early_and_late_total: number;
  cooldown_signal_duplicate_early_total: number;
  cooldown_signal_duplicate_late_total: number;
  cooldown_price_unique_price_keys_total: number;
  cooldown_price_early_only_total: number;
  cooldown_price_late_only_total: number;
  cooldown_price_early_and_late_total: number;
  cooldown_price_duplicate_early_total: number;
  cooldown_price_duplicate_late_total: number;
  cooldown_price_skipped_no_price_total: number;
  exit_order_ttl_cancel_total: number;
  exit_order_ttl_cancel_near_resolution_total: number;
  exit_anchor_mode_total: Record<string, number>;
  exit_ttl_resolved_total: Record<string, number>;
  exit_reprice_suppressed_threshold_total: number;
  exit_chain_cap_resolved_total: Record<string, number>;
  http_errors_by_class_1h: Record<string, number>;
  ws_heartbeat: {
    pingSent: number;
    pongReceived: number;
    timeoutFired: number;
    timeoutSuppressedByInbound: number;
    workerEventLoopLagMaxMs: number;
    byShard: Record<
      string,
      {
        pingSent: number;
        pongReceived: number;
        timeoutFired: number;
        timeoutSuppressedByInbound: number;
        lastPingSentAt: number | null;
        lastPongAt: number | null;
        lastInboundMessageAt: number | null;
        workerEventLoopLagMaxMs: number;
      }
    >;
  } | null;
  ws_worker_memory: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
    arrayBuffersMb: number;
    maxRssMb: number;
    byWorker: Record<
      string,
      {
        rssMb: number;
        heapUsedMb: number;
        heapTotalMb: number;
        externalMb: number;
        arrayBuffersMb: number;
        heapLimitMb: number | null;
        capturedAt: number;
      }
    >;
  } | null;
  v4_admit_count_total: number;
  v4_admit_count_by_category: Record<string, number>;
  v4_reject_count_total: number;
  v4_reject_count_by_reason: Record<string, number>;
  v4_admit_rate: number;
  v4_seen_count_by_category: Record<string, number>;
  v4_admit_rate_by_category: Record<string, number>;
  v4_evaluated_total: number;
  captured_at: string | null;
}

/** GET /metrics/r23 */
export interface R23MetricsData {
  current: {
    checked: number;
    fired: number;
    no_history: number;
    no_dip: number;
    cache_hit_rate: number | null;
    cache_hits: number;
    cache_misses: number;
    cache_invocations: number;
    decision_tick_latency_p95_ms: number | null;
    decision_tick_latency_p99_ms: number | null;
    captured_at: string | null;
  };
  hourly: {
    fires: Array<{ hour: string; count: number }>;
    skips: Array<{ hour: string; reason: string; count: number }>;
  };
  orders_24h: number;
  fills_24h: number;
  fill_notional_usdc_24h: number;
  since: string;
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

/** S0–S3 phase derived server-side from leg_states + position status. */
export type PositionPhase = "S0" | "S1" | "S2" | "S3";

/** Last leg-action as recorded by leg_states; null when no fills yet. */
export type PositionLastAction = "BUY" | "SELL" | null;

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
  cumulativeBuyNotional?: number | null;
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
  phase: PositionPhase;
  buyCount: number;
  sellCount: number;
  lastAction: PositionLastAction;
  lastActionAt: string | null;
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
  cancelReason: string | null;
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
  pnlUsd?: number | null;
  pnlPct?: number | null;
  filledAt: string;
  decisionRuleId?: string | null;
  signalId?: string | null;
  slug: string | null;
  eventSlug: string | null;
  question: string | null;
  outcome: string | null;
  conditionId: string | null;
  endDate: string | null;
}

export type PositionCycleStatus =
  | "CLOSED_PROFIT"
  | "CLOSED_LOSS"
  | "OPEN_PROFIT"
  | "OPEN_LOSS"
  | "DUST_OPEN"
  | "HELD_TO_LOSING_RESOLUTION"
  | "UNKNOWN_ACCT";

export type AccountingConfidence = "HIGH" | "MED" | "LOW";

export interface PositionCycleOperationDTO {
  time: string;
  type: "BUY" | "SCALE" | "SELL" | "SETTLE";
  fillId?: string;
  orderId?: string | null;
  price: number | null;
  shares: number;
  usd: number;
  source: string;
  stepPnlUsd: number | null;
}

export interface PositionCycleSourceContributionDTO {
  source: string;
  returnedUsd: number;
  pnlUsd: number | null;
  count: number;
}

export interface PositionCycleDTO {
  id: string;
  positionId: string;
  tokenId: string;
  conditionId: string | null;
  slug: string | null;
  marketTitle: string | null;
  outcome: string | null;
  status: PositionCycleStatus;
  openedAt: string;
  closedAt: string | null;
  lastActionAt: string;
  heldDurationMs: number;
  shares: number;
  buyCount: number;
  sellCount: number;
  entrySources: string[];
  exitSources: string[];
  exitSummary: string;
  flags: string[];
  band: string | null;
  investedUsd: number;
  returnedUsd: number;
  sellReturnedUsd: number;
  settlementReturnedUsd: number;
  remainingMarkUsd: number;
  remainingLiquidationUsd: number;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number;
  netPnlUsd: number | null;
  netPnlPct: number | null;
  accountingConfidence: AccountingConfidence;
  accountingReasons: string[];
  sourceBreakdown: {
    entries: PositionCycleSourceContributionDTO[];
    exits: PositionCycleSourceContributionDTO[];
  };
  operations: PositionCycleOperationDTO[];
}

export interface PositionCyclesSummaryDTO {
  closedRealizedPnlUsd: number;
  closedCycleCount: number;
  openNetPnlUsd: number;
  openMarkUsd: number;
  openLiquidationUsd: number;
  winners: number;
  losers: number;
  dustCount: number;
  dustLiquidationUsd: number;
  accountingWarningCount: number;
}

export interface PositionCyclesResponseDTO {
  summary: PositionCyclesSummaryDTO;
  accountingWarnings: PositionCycleDTO[];
  cycles: PositionCycleDTO[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
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

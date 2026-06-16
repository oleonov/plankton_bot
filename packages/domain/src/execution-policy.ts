/**
 * ADR-015 — DB-backed execution policy parser (shared).
 *
 * Reads `profile_settings.execution_policy_json` into a validated
 * `ExecutionPolicy`. Invalid JSON, invalid enum, and out-of-bound numeric
 * fields all fall back to safe defaults rather than crashing the bridge.
 *
 * Shared across runtime + api so PATCH validation stays single-sourced.
 * Keep this module pure — no runtime deps, no I/O.
 */
import type {
  BuyCapacityPolicy,
  BuyGuardShortLifetimePolicy,
  DeadSideGuardPolicy,
  DepositActivationPolicy,
  ExecutionPolicy,
  ExecutionProfileCostCapProfilePolicy,
  ExecutionProfileAbandonmentBandConfig,
  ExecutionProfileAbandonmentConfig,
  ExecutionProfileFeatureToggle,
  ExecutionProfileHysteresisBounds,
  ExecutionProfileMonitoringConfig,
  ExecutionProfilePolicy,
  ExecutionProfileProfilesPolicy,
  ExecutionProfileScaleInProfilePolicy,
  ExecutionProfileScaleInFeatureToggle,
  ExecutionProfileSellLadderConfig,
  ExecutionProfileSignalFeedConfig,
  ExecutionPricingPolicy,
  ExecutionPolicyTelemetry,
  FeeScheduleConfig,
  FeeSchedulePeriodConfig,
  FeeScheduleScope,
  ExitTtlByLiquidityPolicyConfig,
  DropTriggerPolicy,
  DustAbandonmentPolicyConfig,
  MarketSelectionPolicy,
  OrderCapacityPolicy,
  OrderLifetimePolicy,
  MultiBuyLadderPolicy,
  OpportunisticTakerPolicy,
  ProfitTargetPolicyConfig,
  QdPreResolutionExitPolicy,
  RaceProtectionPolicy,
  R23DipTriggerPolicy,
  RedeemSweepPolicy,
  RepriceChainPolicyConfig,
  RepriceOnOutbidPolicy,
  ExitRepriceOnDownpricePolicy,
  SellCapacityPolicy,
  SellLoopGuardPolicy,
  TakerAtProfitPolicy,
  TrackRHonestPricingPolicy,
  TrackS3MarginAwareSpreadPolicy,
  TrackS3SpreadTierPolicy,
  TrackS1WalkingLadderPolicy,
  TrackS4DustAutoCloseConfig,
  DynamicChainCapPolicyConfig,
  ProfileLadderBand,
  ProfileLadderBandConfig,
} from "./types.js";
import type { AlgoState } from "./algo-engine.js";
import { DEFAULT_MARKET_SELECTION_POLICY } from "./market-selection.js";
import { DEFAULT_PROFIT_TARGET_POLICY } from "./d8-profit-target.js";
import { DEFAULT_DUST_ABANDONMENT_POLICY } from "./dust-abandonment.js";
import { DEFAULT_REPRICE_CHAIN_POLICY } from "./reprice-chain.js";
import { DEFAULT_SELL_LOOP_GUARD_POLICY } from "./sell-loop-guard.js";
import { DEFAULT_SELL_TIMEOUT_MS } from "./sell-sizing.js";
import type { D9LossExitPolicy } from "./d9-loss-exit.js";
import { DEFAULT_TRACK_S1_WALKING_LADDER_POLICY } from "./ladder-construction.js";
import { DEFAULT_TRACK_S3_BASE_CAP, DEFAULT_TRACK_S3_TIERS } from "./track-s3-cap.js";
import { DEFAULT_FEE_SCHEDULE_CONFIG, validateFeeSchedulePeriods } from "./fee-schedule.js";
export { DEFAULT_FEE_SCHEDULE_CONFIG } from "./fee-schedule.js";

export const DEFAULT_DEAD_SIDE_GUARD: DeadSideGuardPolicy = {
  mode: "observe",
  askCeiling: 0.02,
  maxTimeToEndMs: 120_000,
};

export const DEFAULT_PRICING_POLICY: ExecutionPricingPolicy = {
  mode: "edge",
  maxEntrySpreadTicks: 20,
  maxExitSpreadTicks: 40,
  maxImprovementTicks: 10,
  minExitPriceSignalRatio: 0.5,
  wideSpreadPolicy: "edge",
  oneSidedPolicy: "edge",
};

export const DEFAULT_TELEMETRY: ExecutionPolicyTelemetry = {
  deadSideCanary: true,
  pricingShadow: true,
};

export const DEFAULT_BUY_CAPACITY_POLICY: BuyCapacityPolicy = {
  enabled: true,
  minNewEntryWalletHeadroomUsdc: 7,
  minAddWalletHeadroomUsdc: 5,
  maxOpenBuyOrders: 15,
  maxOpenBuyOrdersPerToken: 2,
};

export const DEFAULT_SELL_CAPACITY_POLICY: SellCapacityPolicy = {
  enabled: true,
  maxOpenSellOrders: 10,
  maxOpenSellOrdersPerToken: 2,
};

export const DEFAULT_ORDER_CAPACITY_POLICY: OrderCapacityPolicy = {
  enabled: true,
  maxOpenOrdersTotal: 22,
};

export const DEFAULT_REPRICE_ON_OUTBID_POLICY: RepriceOnOutbidPolicy = {
  enabled: false,
  maxRepriceCount: 5,
};

export const DEFAULT_EXIT_REPRICE_ON_DOWNPRICE_POLICY: ExitRepriceOnDownpricePolicy = {
  enabled: false,
  thresholdTicks: 5,
  maxRepricesPerOrder: 3,
  stuckWarningEnabled: true,
  stuckWarningAgeMs: 4 * 60 * 60_000,
  stuckWarningGapPct: 0.1,
};

export const DEFAULT_DROP_TRIGGER_POLICY: DropTriggerPolicy = {
  enabled: false,
  failOpenOnNoData: true,
  thresholdPct: -0.02,
  lookbackMs: 60 * 60_000,
  historyMaxAgeMs: 10 * 60_000,
};

export const DEFAULT_R23_DIP_TRIGGER_POLICY: R23DipTriggerPolicy = {
  enabled: true,
  // R23: 0.683 = 1 - 0.317 dip threshold from the historical first-BUY
  // entry-signal sample. ADR-033 owns the deployment rationale.
  dropThresholdRatio: 0.683,
  windowMs: 24 * 60 * 60_000,
};

export const DEFAULT_MULTI_BUY_LADDER_POLICY: MultiBuyLadderPolicy = {
  enabled: false,
  maxLadderFillsPerToken: 5,
  ladderGapMs: 60_000,
  perTokenUsdcCap: 25,
  maxPriceDriftTicks: 5,
  minStepFillRate: 0.1,
};

export const DEFAULT_OPPORTUNISTIC_TAKER_POLICY: OpportunisticTakerPolicy = {
  enabled: true,
  maxSpreadTicks: 2,
  safetyBuffer: 1.05,
  fallbackMinNotionalUsdc: 1,
  marketableBuyMinNotionalUsdc: 1,
};

export const DEFAULT_TAKER_AT_PROFIT_POLICY: TakerAtProfitPolicy = {
  enabled: false,
  minGrossExitRatio: 1.03,
  // Starts above the current 2-tick generic taker cap to cover observed 3-4 tick
  // profitable exits, while still rejecting extremely wide/stale books in v1.
  maxSpreadTicks: 6,
  rules: "all-sell",
};

export const DEFAULT_TRACK_R_HONEST_PRICING_POLICY: TrackRHonestPricingPolicy = {
  enabled: false,
  safetyMargin: 0.005,
  requireFullDepth: true,
  universalFallbackRate: 0.05,
  maxSaneThreshold: 1.5,
  exitBookFallback: false,
  exitBookStalenessMs: 30000,
  exitBookFetchTtlMs: 20000,
  takerCapSkip: false,
  allowPartialExit: false,
  partialExitMinFraction: 0.2,
  partialExitMinShares: 1,
  partialExitMaxPerHour: 3,
};

export const DEFAULT_TRACK_S3_MARGIN_AWARE_SPREAD_POLICY: TrackS3MarginAwareSpreadPolicy = {
  enabled: false,
  baseCap: DEFAULT_TRACK_S3_BASE_CAP,
  tiers: DEFAULT_TRACK_S3_TIERS,
};

export const DEFAULT_EXECUTION_PROFILE_SELL_LADDER: ExecutionProfileSellLadderConfig = {
  enabled: false,
  phase: 0,
  decisionRuleId: "PROFILE_LADDER",
  orderTag: "profile_ladder",
  bands: {
    cheap: {
      enabled: false,
      minAvgEntry: null,
      maxAvgEntry: 0.05,
      multipliers: [1.1, 1.25, 1.5, 1.75, 2.35],
      sizingVector: [0.37, 0.26, 0.21, 0.16],
      costCapUsd: 35,
      allowFourthRung: true,
      fourthRungMinCostUsd: 15,
      maxConcurrentRungs: 1,
    },
    medium_low: {
      enabled: false,
      minAvgEntry: 0.05,
      maxAvgEntry: 0.15,
      multipliers: [1.1, 1.3, 1.55, 1.65, 1.85],
      sizingVector: [0.38, 0.24, 0.2, 0.18],
      costCapUsd: 55,
      allowFourthRung: true,
      fourthRungMinCostUsd: 15,
      maxConcurrentRungs: 1,
    },
    medium_high: {
      enabled: false,
      minAvgEntry: 0.15,
      maxAvgEntry: 0.35,
      multipliers: [1, 1.1, 1.25, 1.4, 1.5],
      sizingVector: [0.31, 0.25, 0.23, 0.21],
      costCapUsd: 55,
      allowFourthRung: false,
      fourthRungMinCostUsd: 15,
      maxConcurrentRungs: 1,
    },
    expensive: {
      enabled: false,
      minAvgEntry: 0.35,
      maxAvgEntry: null,
      multipliers: [1, 1.05, 1.12, 1.18, 1.25],
      sizingVector: [0.28, 0.26, 0.24, 0.22],
      costCapUsd: 33,
      allowFourthRung: false,
      fourthRungMinCostUsd: 15,
      maxConcurrentRungs: 1,
    },
  },
  modeAdjustments: {
    up: 0.95,
    flat: 1,
    avg_down: 1.5,
  },
  reprice: {
    majorBboMovePct: 0.05,
    strongBboMovePct: 0.1,
    cooldownMs: 30 * 60_000,
  },
  staleReview: {
    enabled: true,
    staleAfterMs: 24 * 60 * 60_000,
  },
  postFill: {
    reevalCooldownMs: 15 * 60_000,
  },
  adoptExisting: { enabled: false },
};

export const DEFAULT_EXECUTION_PROFILE_ABANDONMENT: ExecutionProfileAbandonmentConfig = {
  enabled: false,
  evaluationIntervalMs: 60_000,
  maxTokensPerCycle: 100,
  hardStaleFallbackMs: 24 * 60 * 60_000,
  bands: {
    cheap: {
      enabled: false,
      probeSizeMaxUsdc: 9,
      maxProbeBuyCount: 4,
      scaleInRequiredWithinMs: 60 * 60_000,
    },
    medium_low: {
      enabled: false,
      probeSizeMaxUsdc: 13.45,
      maxProbeBuyCount: 3,
      scaleInRequiredWithinMs: 45 * 60_000,
    },
    medium_high: {
      enabled: false,
      probeSizeMaxUsdc: 12.83,
      maxProbeBuyCount: 2,
      scaleInRequiredWithinMs: 15 * 60_000,
    },
    expensive: {
      enabled: false,
      probeSizeMaxUsdc: 11.84,
      maxProbeBuyCount: 2,
      scaleInRequiredWithinMs: 10 * 60_000,
    },
  },
};

export const DEFAULT_EXECUTION_PROFILE_POLICY: ExecutionProfilePolicy = {
  enabled: false,
  maxTokensPerCycle: 100,
  qdHandoffThresholdMs: 3_600_000,
  profileHysteresis: {
    cheapMediumLow: 0.045,
    cheapMediumHigh: 0.055,
    mediumExpensiveLow: 0.325,
    mediumExpensiveHigh: 0.375,
  },
  costCaps: { enabled: false },
  scaleIn: { enabled: false, useRealFeed: false },
  signalFeed: {
    enabled: false,
    windowShortMs: 60 * 60_000,
    windowLongMs: 3 * 60 * 60_000,
    hotSampleTargetIntervalMs: 10_000,
    warmBucketMs: 60_000,
    coldArchiveBucketMs: 60 * 60_000,
    retentionDays: 120,
    minSamplesForSnapshot: 30,
    minSamplesForRecovery60: 60,
    minWarmBucketsForTradeCount: 90,
    flushHotToWarmIntervalMs: 60_000,
    flushWarmToColdIntervalMs: 60_000,
    maintenanceIntervalMs: 60 * 60_000,
  },
  abandonment: DEFAULT_EXECUTION_PROFILE_ABANDONMENT,
  profiles: {
    cheap: {
      costCaps: { normalCapUsd: 11, aggressiveCapUsd: 23, hardCapAtAggressive: false },
      scaleIn: {
        initialProbeSizeUsd: 0.6,
        sizingDecay: [1, 0.7, 0.6, 0.5, 0.35],
        minTimeBetweenAddsMs: 48_000,
        minAddNotionalUsd: 0.2,
        modes: {
          up: { thresholdPct: 0.05 },
          flat: { thresholdPct: 0.05 },
          avgDown: {
            enabled: true,
            thresholdPct: 0.05,
            requireRecovery: true,
            recoveryThreshold: 0.05,
          },
        },
        triggers: {
          activity: { tradeCount3hThreshold: 40 },
          recovery: { threshold: 0.08, strongThreshold: 0.1, strongActivityRecoveryFloor: 0.05 },
          volatility: { range60Threshold: 0.1, std60Threshold: 0.02 },
          strongActivity: { tradeCount3hThreshold: 80 },
        },
      },
    },
    medium: {
      costCaps: { normalCapUsd: 30, aggressiveCapUsd: 70, hardCapAtAggressive: false },
      scaleIn: {
        initialProbeSizeUsd: 7.15,
        sizingDecay: [1, 0.7, 0.6, 0.5, 0.35],
        minTimeBetweenAddsMs: 1_656_000,
        minAddNotionalUsd: 0.2,
        modes: {
          up: { thresholdPct: 0.05 },
          flat: { thresholdPct: 0.05 },
          avgDown: {
            enabled: true,
            thresholdPct: 0.05,
            requireRecovery: true,
            recoveryThreshold: 0.05,
          },
        },
        triggers: {
          activity: { tradeCount3hThreshold: 40 },
          recovery: { threshold: 0.08, strongThreshold: 0.1, strongActivityRecoveryFloor: 0.05 },
          volatility: { range60Threshold: 0.1, std60Threshold: 0.02 },
          strongActivity: { tradeCount3hThreshold: 80 },
        },
      },
    },
    expensive: {
      costCaps: { normalCapUsd: 18, aggressiveCapUsd: 33, hardCapAtAggressive: false },
      scaleIn: {
        initialProbeSizeUsd: 8.45,
        sizingDecay: [1, 0.7, 0.6, 0.5, 0.35],
        minTimeBetweenAddsMs: 2_550_000,
        minAddNotionalUsd: 0.2,
        modes: {
          up: { thresholdPct: 0.05 },
          flat: { thresholdPct: 0.05 },
          avgDown: {
            enabled: true,
            thresholdPct: 0.05,
            requireRecovery: true,
            recoveryThreshold: 0.05,
          },
        },
        triggers: {
          activity: { tradeCount3hThreshold: 40 },
          recovery: { threshold: 0.08, strongThreshold: 0.1, strongActivityRecoveryFloor: 0.05 },
          volatility: { range60Threshold: 0.1, std60Threshold: 0.02 },
          strongActivity: { tradeCount3hThreshold: 80 },
        },
      },
    },
  },
  sellLadder: DEFAULT_EXECUTION_PROFILE_SELL_LADDER,
  adoptExistingPositions: { enabled: false },
  adoptExistingS1Ladders: { enabled: false },
  monitoring: {
    healthCheckIntervalMs: 300_000,
    rollupWindowMs: 300_000,
    maxRollupBuckets: 10_000,
    pendingScaleInWarnAfterMs: 600_000,
    healthRiskEventEveryMs: 1_800_000,
    anomalyDetection: {
      enabled: false,
      cooldownMs: 3_600_000,
    },
  },
};

export const DEFAULT_EXIT_TTL_BY_LIQUIDITY_POLICY: ExitTtlByLiquidityPolicyConfig = {
  enabled: true,
  thinMs: 24 * 60 * 60_000,
  mediumMs: 6 * 60 * 60_000,
};

export const DEFAULT_REDEEM_SWEEP_POLICY: RedeemSweepPolicy = {
  enabled: true,
  intervalMs: 10 * 60_000,
  inFlightTtlMs: 15 * 60_000,
  maxRetries: 3,
  retryBackoffMs: [60_000, 300_000, 1_800_000],
  postRedeemVerifyDelayMs: 5 * 60_000,
  circuitBreakerEnabled: true,
  stateFailedQuarantineThreshold: 5,
  stateFailedQuarantineTtlHours: 24,
};

export const DEFAULT_RACE_PROTECTION_POLICY: RaceProtectionPolicy = {
  redeemInFlight: {
    enabled: true,
  },
};

export const DEFAULT_DEPOSIT_ACTIVATION_POLICY: DepositActivationPolicy = {
  enabled: true,
  minAmountUsdcCents: 100,
};

export const DEFAULT_LOSS_EXIT_POLICY: D9LossExitPolicy = {
  enabled: false,
  // minPublicTradeCount24h: 41 derived from R96 Q3 best 2D rule
  // (research_plankton/plankton_loss_exit_boundary_R96_report.md),
  // (profit_ratio <= 1.0) AND (public_trade_count_24h >= 41) gives
  // balanced accuracy 76.62% on n=4,555 CUT vs n=573,192 HOLD.
  // states [S1, S2]: S3 has 0 HOLD samples (terminal), OTHER too few.
  states: ["S1", "S2"],
  minPublicTradeCount24h: 41,
  cohortGuard: {
    enabled: true,
    state: "S2",
    avgBuyMin: 0.02,
    avgBuyMax: 0.4,
    minDaysToResolve: 14,
  },
};

// Sub-Track Q.D ships observe-only: enabled:true records would-fire telemetry
// (no order placed); salvageEnabled:false keeps Q.D Plankton-strict (Mode A).
// Defaults justified in research_plankton/track_q_d_spec_2026-06-12.md §1/§3.3.
export const DEFAULT_PRE_RESOLUTION_EXIT_POLICY: QdPreResolutionExitPolicy = {
  enabled: true,
  ttcThresholdMs: 2 * 60 * 60_000,
  tierCeiling: 0.05,
  bidFloorAbs: 0.01,
  salvageEnabled: false,
  salvageTtcMs: 30 * 60_000,
  salvageFloorRatio: 0.5,
};

export const DEFAULT_ORDER_LIFETIME_POLICY: OrderLifetimePolicy = {
  enabled: true,
  enforcement: "enforce",
  staleResetMs: 24 * 60 * 60_000,
  safetyBufferMs: 60 * 60_000,
  resolutionAggressiveWindowMs: 6 * 60 * 60_000,
  // Deprecated 2026-05-15: kept for DB/profile compatibility.
  // SELL timestamp stop-window removed per R87 evidence; see ADR-028.
  resolutionStopWindowMs: 60 * 60_000,
  resolutionExitTtlCapMs: 10 * 60_000,
  relayerSubmitBudgetPerMinute: 20,
  maxTransitionEventsPerTokenPerDay: 10,
  oscillationTransitionLimitPerDay: 3,
  burst: {
    candidateFirstFillLatencyMs: 30_000,
    confirmSpanMs: 180_000,
    confirmMedianGapMs: 30_000,
    confirmFirstFillLatencyMs: 120_000,
    confirmP75GapMs: 60_000,
    confirmMaxSpanMs: 300_000,
    lowTtlMs: 60_000,
    mediumTtlMs: 30_000,
    highTtlMs: 15_000,
  },
  middle: {
    minMedianGapMs: 60_000,
    maxMedianGapMs: 10 * 60_000,
    maxSpanMs: 60 * 60_000,
    lowTtlMs: 30 * 60_000,
    mediumTtlMs: 60 * 60_000,
    highTtlMs: 2 * 60 * 60_000,
  },
  passive: {
    lowTtlMs: 2 * 60 * 60_000,
    mediumTtlMs: 4 * 60 * 60_000,
    highTtlMs: 6 * 60 * 60_000,
    highConfidenceMinFills: 3,
    highConfidenceMinSpanMs: 6 * 60 * 60_000,
  },
};

/**
 * Step 0 §P3: spec §1.7 R1 (`06:423`) — empirical lower bound 2,504 sec
 * (~42 min) between Gamma `createdAt` and the first BUY across historical
 * Plankton trades. Stricter rounding (e.g. 2,520) is NOT specified in the
 * canonical spec; future tightening lives in a separate ADR.
 *
 * Default value applies to paper / live-lite. The simulation profile gets
 * a per-profile seed of 0 (full bypass) — see `defaultExecutionPolicyJson`
 * in `@krabs/db` (control-profiles.ts).
 */
export const DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS = 2_504;

export const DEFAULT_TRACK_S4_DUST_AUTO_CLOSE_POLICY: TrackS4DustAutoCloseConfig = {
  enabled: false,
  scanIntervalMs: 300_000,
  maxCandidatesPerCycle: 25,
  retryBackoffMs: 24 * 60 * 60_000,
  thresholds: {
    liquidationValueMaxUsdc: 0.5,
    costBasisMaxUsdc: 5,
    lastSellMinAgeMs: 7 * 24 * 60 * 60_000,
  },
  execution: {
    priceOffsetTicks: 1,
    cancelStaleSellOrders: true,
  },
};

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  version: 1,
  entryPriceCeiling: 0.45,
  entryMinMarketAgeSeconds: DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS,
  exitOrderTtlMs: 4 * 60 * 60_000,
  exitTtlByLiquidity: DEFAULT_EXIT_TTL_BY_LIQUIDITY_POLICY,
  sellTimeoutMs: DEFAULT_SELL_TIMEOUT_MS,
  sellReplaceMinPriceDeltaTicks: 2,
  exitRepriceThresholdPct: 0.3,
  exitRepriceThresholdTicks: 10,
  marketSelection: DEFAULT_MARKET_SELECTION_POLICY,
  buyCapacity: DEFAULT_BUY_CAPACITY_POLICY,
  sellCapacity: DEFAULT_SELL_CAPACITY_POLICY,
  orderCapacity: DEFAULT_ORDER_CAPACITY_POLICY,
  deadSideGuard: DEFAULT_DEAD_SIDE_GUARD,
  pricing: DEFAULT_PRICING_POLICY,
  exitPricingMode: "midpoint-anchored",
  exitBidAnchorTicks: 4,
  // Derived from R93 Model A regression
  // (research_plankton/plankton_sell_pricing_decomposition_R93_report.md):
  // fill_price = 0.004868 + 1.000947 × midpoint, n=1,256, R²=0.976.
  // intercept 0.004868 / standard tick_size 0.001 ≈ 5 ticks.
  // Analytical derivation — not an engineering tuning value.
  exitMidpointAnchorTicks: 5,
  opportunisticTaker: DEFAULT_OPPORTUNISTIC_TAKER_POLICY,
  takerAtProfit: DEFAULT_TAKER_AT_PROFIT_POLICY,
  trackR: DEFAULT_TRACK_R_HONEST_PRICING_POLICY,
  trackS3: DEFAULT_TRACK_S3_MARGIN_AWARE_SPREAD_POLICY,
  trackS1: DEFAULT_TRACK_S1_WALKING_LADDER_POLICY,
  trackS4: DEFAULT_TRACK_S4_DUST_AUTO_CLOSE_POLICY,
  feeSchedule: DEFAULT_FEE_SCHEDULE_CONFIG,
  executionProfile: DEFAULT_EXECUTION_PROFILE_POLICY,
  orderLifetime: DEFAULT_ORDER_LIFETIME_POLICY,
  // Defensive infrastructure timing parameter. Exchange balance settlement
  // typically lands in <2s; 5000ms provides a safe margin. Not R-derived —
  // this is exchange timing protection, not decision logic.
  postBuyFillSellCooldownMs: 5_000,
  repriceOnOutbid: DEFAULT_REPRICE_ON_OUTBID_POLICY,
  exitRepriceOnDownprice: DEFAULT_EXIT_REPRICE_ON_DOWNPRICE_POLICY,
  dropTrigger: DEFAULT_DROP_TRIGGER_POLICY,
  r23DipTrigger: DEFAULT_R23_DIP_TRIGGER_POLICY,
  multiBuyLadder: DEFAULT_MULTI_BUY_LADDER_POLICY,
  redeemSweep: DEFAULT_REDEEM_SWEEP_POLICY,
  raceProtection: DEFAULT_RACE_PROTECTION_POLICY,
  telemetry: DEFAULT_TELEMETRY,
  profitTarget: DEFAULT_PROFIT_TARGET_POLICY,
  dustAbandonment: DEFAULT_DUST_ABANDONMENT_POLICY,
  repriceChain: DEFAULT_REPRICE_CHAIN_POLICY,
  sellLoopGuard: DEFAULT_SELL_LOOP_GUARD_POLICY,
  lossExit: DEFAULT_LOSS_EXIT_POLICY,
  preResolutionExit: DEFAULT_PRE_RESOLUTION_EXIT_POLICY,
  depositActivation: DEFAULT_DEPOSIT_ACTIVATION_POLICY,
};

const DEAD_SIDE_MODES = ["off", "observe", "enforce"] as const;
const ORDER_LIFETIME_ENFORCEMENT_MODES = ["observe", "enforce"] as const;
const PRICING_MODES = ["edge", "bounded-midpoint"] as const;
const BINARY_PRICING_POLICIES = ["edge", "skip"] as const;
const EXIT_PRICING_MODES = ["bid-anchored", "midpoint-anchored", "edge"] as const;
const ALGO_STATES = ["OTHER", "S1", "S2", "S3"] as const;

// Bounds chosen to match the Zod schema that previously lived in
// packages/config/src/env.ts so operators can't wedge the runtime via SQL.
const BOUND_ASK_CEILING_MAX = 0.2;
const BOUND_MAX_TIME_TO_END_MIN_MS = 1_000;
const BOUND_MAX_TIME_TO_END_MAX_MS = 15 * 60_000;
const BOUND_SPREAD_TICKS_MIN = 1;
const BOUND_SPREAD_TICKS_MAX = 2000;
const BOUND_IMPROVEMENT_TICKS_MIN = 0;
const BOUND_IMPROVEMENT_TICKS_MAX = 500;
const BOUND_MIN_EXIT_SIGNAL_RATIO_MIN = 0;
const BOUND_MIN_EXIT_SIGNAL_RATIO_MAX = 1;
const BOUND_ENTRY_CEILING_MIN = 0.05;
const BOUND_ENTRY_CEILING_MAX = 0.99;
const BOUND_EXIT_TTL_MIN_MS = 10_000;
const BOUND_EXIT_TTL_MAX_MS = 24 * 60 * 60_000;
const BOUND_SELL_TIMEOUT_MIN_MS = 60_000;
const BOUND_SELL_TIMEOUT_MAX_MS = 24 * 60 * 60_000;
const BOUND_SELL_REPLACE_MIN_PRICE_DELTA_TICKS_MIN = 1;
const BOUND_SELL_REPLACE_MIN_PRICE_DELTA_TICKS_MAX = 20;
const BOUND_ENTRY_MIN_AGE_MIN_S = 0;
// Two days — wide enough to cover any realistic conservative tightening
// without enabling pathological values that would silently disable BUYs forever.
const BOUND_ENTRY_MIN_AGE_MAX_S = 2 * 24 * 60 * 60;
const BOUND_MARKET_SELECTION_MAX_MID_MIN = 0.001;
const BOUND_MARKET_SELECTION_MAX_MID_MAX = 0.99;
const BOUND_MARKET_SELECTION_MIN_LIQUIDITY_MIN = 0;
const BOUND_MARKET_SELECTION_MIN_LIQUIDITY_MAX = 1_000_000;
const BOUND_BUY_GUARD_SHORT_LIFETIME_MIN_HOURS = 1 / 60;
const BOUND_BUY_GUARD_SHORT_LIFETIME_MAX_HOURS = 24;
const BOUND_BUY_CAPACITY_HEADROOM_MIN_USDC = 0;
const BOUND_BUY_CAPACITY_HEADROOM_MAX_USDC = 10_000;
const BOUND_CAPACITY_OPEN_ORDERS_MIN = 0;
const BOUND_CAPACITY_OPEN_ORDERS_MAX = 1_000;
const BOUND_ORDER_LIFETIME_MIN_MS = 1_000;
const BOUND_ORDER_LIFETIME_MAX_MS = 14 * 24 * 60 * 60_000;
const BOUND_ORDER_LIFETIME_COUNT_MAX = 10_000;
const BOUND_POST_BUY_FILL_SELL_COOLDOWN_MIN_MS = 0;
const BOUND_POST_BUY_FILL_SELL_COOLDOWN_MAX_MS = 60_000;
const BOUND_EXIT_REPRICE_THRESHOLD_PCT_MIN = 0.001;
const BOUND_EXIT_REPRICE_THRESHOLD_PCT_MAX = 10;
const BOUND_EXIT_REPRICE_THRESHOLD_TICKS_MIN = 1;
const BOUND_EXIT_REPRICE_THRESHOLD_TICKS_MAX = 10_000;
const BOUND_STUCK_WARNING_GAP_PCT_MIN = 0;
const BOUND_STUCK_WARNING_GAP_PCT_MAX = 1;
const BOUND_DROP_TRIGGER_THRESHOLD_MIN = -1;
const BOUND_DROP_TRIGGER_THRESHOLD_MAX = 0;
const BOUND_R23_DIP_TRIGGER_RATIO_MIN = 0.001;
const BOUND_R23_DIP_TRIGGER_RATIO_MAX = 1;
const BOUND_FILL_RATE_MIN = 0;
const BOUND_FILL_RATE_MAX = 1;
// Parser ceiling only; profile capital/order risk limits still constrain live exposure.
const BOUND_LADDER_USDC_CAP_MAX = 10_000;
const BOUND_TAKER_SAFETY_BUFFER_MIN = 1;
const BOUND_TAKER_SAFETY_BUFFER_MAX = 10;
const BOUND_TAKER_MIN_NOTIONAL_MAX = 1_000;
const BOUND_TAKER_AT_PROFIT_RATIO_MIN = 1;
const BOUND_TAKER_AT_PROFIT_RATIO_MAX = 10;
const BOUND_TRACK_R_SAFETY_MARGIN_MIN = 0;
const BOUND_TRACK_R_SAFETY_MARGIN_MAX = 0.1;
const BOUND_TRACK_R_UNIVERSAL_FALLBACK_MIN = 0.0001;
const BOUND_TRACK_R_UNIVERSAL_FALLBACK_MAX = 0.2;
const BOUND_TRACK_R_MAX_SANE_THRESHOLD_MIN = 1;
const BOUND_TRACK_R_MAX_SANE_THRESHOLD_MAX = 2;
const BOUND_TRACK_R_EXIT_BOOK_STALENESS_MS_MIN = 1_000;
const BOUND_TRACK_R_EXIT_BOOK_STALENESS_MS_MAX = 300_000;
const BOUND_TRACK_R_EXIT_BOOK_FETCH_TTL_MS_MIN = 1_000;
const BOUND_TRACK_R_EXIT_BOOK_FETCH_TTL_MS_MAX = 60_000;
const BOUND_TRACK_R_PARTIAL_MIN_FRACTION_MIN = 0.01;
const BOUND_TRACK_R_PARTIAL_MIN_FRACTION_MAX = 1;
const BOUND_TRACK_R_PARTIAL_MIN_SHARES_MIN = 0;
const BOUND_TRACK_R_PARTIAL_MIN_SHARES_MAX = 100_000;
const BOUND_TRACK_R_PARTIAL_MAX_PER_HOUR_MIN = 1;
const BOUND_TRACK_R_PARTIAL_MAX_PER_HOUR_MAX = 100;
const BOUND_TRACK_S3_MARGIN_MIN = 1;
const BOUND_TRACK_S3_MARGIN_MAX = 20;
const BOUND_TRACK_S3_TIER_COUNT_MAX = 10;
const BOUND_TRACK_S1_NUM_TIERS_MIN = 2;
const BOUND_TRACK_S1_NUM_TIERS_MAX = 8;
const BOUND_TRACK_S1_MARKUP_MIN = 1;
const BOUND_TRACK_S1_MARKUP_MAX = 20;
const BOUND_TRACK_S1_SECONDS_MIN = 60;
const BOUND_TRACK_S1_SECONDS_MAX = 7 * 24 * 60 * 60;
const BOUND_TRACK_S1_OPEN_TOKENS_MAX = 1_000;
const BOUND_TRACK_S1_REPLACEMENTS_MAX = 1_000;
const BOUND_TRACK_S1_ENTRY_MAX = 0.5;
const BOUND_TRACK_S1_RATIO_MIN = 0;
const BOUND_TRACK_S1_RATIO_MAX = 1;
const BOUND_TRACK_S4_SCAN_MIN_MS = 60_000;
const BOUND_TRACK_S4_SCAN_MAX_MS = 3_600_000;
const BOUND_TRACK_S4_CANDIDATES_MIN = 1;
const BOUND_TRACK_S4_CANDIDATES_MAX = 100;
const BOUND_TRACK_S4_RETRY_MIN_MS = 3_600_000;
const BOUND_TRACK_S4_RETRY_MAX_MS = 7 * 24 * 60 * 60_000;
const BOUND_TRACK_S4_THRESHOLD_MIN = 0.000_001;
const BOUND_TRACK_S4_THRESHOLD_MAX = 100_000;
const BOUND_TRACK_S4_LAST_SELL_MIN_MS = 60_000;
const BOUND_TRACK_S4_LAST_SELL_MAX_MS = 30 * 24 * 60 * 60_000;
const BOUND_TRACK_S4_PRICE_OFFSET_TICKS_MIN = 0;
const BOUND_TRACK_S4_PRICE_OFFSET_TICKS_MAX = 10;
const BOUND_FEE_SCHEDULE_TTL_MIN_MS = 1_000;
const BOUND_FEE_SCHEDULE_TTL_MAX_MS = 24 * 60 * 60_000;
const BOUND_FEE_SCHEDULE_REBATE_MIN = 0;
const BOUND_FEE_SCHEDULE_REBATE_MAX = 1;
const BOUND_FEE_SCHEDULE_PERIODS_MAX = 100;
const BOUND_EXECUTION_PROFILE_TOKENS_MIN = 1;
const BOUND_EXECUTION_PROFILE_TOKENS_MAX = 10_000;
const BOUND_EXECUTION_PROFILE_HANDOFF_MIN_MS = 60_000;
const BOUND_EXECUTION_PROFILE_HANDOFF_MAX_MS = 24 * 60 * 60_000;
const BOUND_EXECUTION_PROFILE_PRICE_MIN = 0;
const BOUND_EXECUTION_PROFILE_PRICE_MAX = 1;
const BOUND_EXECUTION_PROFILE_MONITORING_MIN_MS = 1_000;
const BOUND_EXECUTION_PROFILE_MONITORING_MAX_MS = 24 * 60 * 60_000;
const BOUND_EXECUTION_PROFILE_ROLLUP_BUCKETS_MIN = 1;
const BOUND_EXECUTION_PROFILE_ROLLUP_BUCKETS_MAX = 1_000_000;
const BOUND_REDEEM_SWEEP_INTERVAL_MIN_MS = 30_000;
const BOUND_REDEEM_SWEEP_INTERVAL_MAX_MS = 24 * 60 * 60_000;
const BOUND_REDEEM_SWEEP_RETRY_COUNT_MAX = 10;
const BOUND_REDEEM_STATE_FAILED_QUARANTINE_THRESHOLD_MAX = 100;
const BOUND_REDEEM_STATE_FAILED_QUARANTINE_TTL_HOURS_MAX = 24 * 30;
const BOUND_PUBLIC_TRADE_COUNT_MIN = 0;
const BOUND_PUBLIC_TRADE_COUNT_MAX = 1_000_000;
const BOUND_H5_AVG_BUY_MIN = 0;
const BOUND_H5_AVG_BUY_MAX = 1;
const BOUND_H5_DAYS_TO_RESOLVE_MAX = 3650;
// Sub-Track Q.D pre-resolution exit bounds.
const BOUND_QD_TTC_MIN_MS = 60_000;
const BOUND_QD_TTC_MAX_MS = 30 * 24 * 60 * 60_000;
const BOUND_QD_TIER_CEILING_MIN = 0.001;
const BOUND_QD_TIER_CEILING_MAX = 0.5;
const BOUND_QD_BID_FLOOR_MIN = 0;
const BOUND_QD_BID_FLOOR_MAX = 0.5;
const BOUND_QD_SALVAGE_FLOOR_RATIO_MIN = 0;
const BOUND_QD_SALVAGE_FLOOR_RATIO_MAX = 1;
// Loop guard bounds — window/cooldown 1 minute .. 24 hours, threshold 1 .. 10,000.
const BOUND_SELL_LOOP_GUARD_WINDOW_MIN_MS = 60_000;
const BOUND_SELL_LOOP_GUARD_WINDOW_MAX_MS = 24 * 60 * 60_000;

export interface ParseResult {
  policy: ExecutionPolicy;
  issues: string[];
}

export function parseExecutionPolicyJson(jsonString: string | null | undefined): ParseResult {
  const issues: string[] = [];
  if (jsonString == null || jsonString.trim() === "") {
    return { policy: DEFAULT_EXECUTION_POLICY, issues };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(jsonString);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "JSON parse failure";
    issues.push(`executionPolicyJson invalid JSON: ${msg}`);
    return { policy: DEFAULT_EXECUTION_POLICY, issues };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push("executionPolicyJson must be an object");
    return { policy: DEFAULT_EXECUTION_POLICY, issues };
  }
  const obj = raw as Record<string, unknown>;

  const version = numberOr(obj.version, DEFAULT_EXECUTION_POLICY.version, issues, "version");
  const entryPriceCeiling = clampedNumber(
    obj.entryPriceCeiling,
    DEFAULT_EXECUTION_POLICY.entryPriceCeiling,
    BOUND_ENTRY_CEILING_MIN,
    BOUND_ENTRY_CEILING_MAX,
    issues,
    "entryPriceCeiling",
  );
  const exitOrderTtlMs = clampedInt(
    obj.exitOrderTtlMs,
    DEFAULT_EXECUTION_POLICY.exitOrderTtlMs,
    BOUND_EXIT_TTL_MIN_MS,
    BOUND_EXIT_TTL_MAX_MS,
    issues,
    "exitOrderTtlMs",
  );
  const exitTtlByLiquidity = parseExitTtlByLiquidity(obj.exitTtlByLiquidity, issues);
  const sellTimeoutMs = clampedInt(
    obj.sellTimeoutMs,
    DEFAULT_EXECUTION_POLICY.sellTimeoutMs,
    BOUND_SELL_TIMEOUT_MIN_MS,
    BOUND_SELL_TIMEOUT_MAX_MS,
    issues,
    "sellTimeoutMs",
  );
  const sellReplaceMinPriceDeltaTicks = clampedInt(
    obj.sellReplaceMinPriceDeltaTicks,
    DEFAULT_EXECUTION_POLICY.sellReplaceMinPriceDeltaTicks ?? 2,
    BOUND_SELL_REPLACE_MIN_PRICE_DELTA_TICKS_MIN,
    BOUND_SELL_REPLACE_MIN_PRICE_DELTA_TICKS_MAX,
    issues,
    "sellReplaceMinPriceDeltaTicks",
  );
  const exitRepriceThresholdPct = clampedNumber(
    obj.exitRepriceThresholdPct,
    DEFAULT_EXECUTION_POLICY.exitRepriceThresholdPct,
    BOUND_EXIT_REPRICE_THRESHOLD_PCT_MIN,
    BOUND_EXIT_REPRICE_THRESHOLD_PCT_MAX,
    issues,
    "exitRepriceThresholdPct",
  );
  const exitRepriceThresholdTicks = clampedInt(
    obj.exitRepriceThresholdTicks,
    DEFAULT_EXECUTION_POLICY.exitRepriceThresholdTicks,
    BOUND_EXIT_REPRICE_THRESHOLD_TICKS_MIN,
    BOUND_EXIT_REPRICE_THRESHOLD_TICKS_MAX,
    issues,
    "exitRepriceThresholdTicks",
  );
  const entryMinMarketAgeSeconds = clampedInt(
    obj.entryMinMarketAgeSeconds,
    DEFAULT_EXECUTION_POLICY.entryMinMarketAgeSeconds,
    BOUND_ENTRY_MIN_AGE_MIN_S,
    BOUND_ENTRY_MIN_AGE_MAX_S,
    issues,
    "entryMinMarketAgeSeconds",
  );

  const deadSideGuard = parseDeadSideGuard(obj.deadSideGuard, issues);
  const pricing = parsePricing(obj.pricing, issues);
  const exitPricingMode = enumOr(
    obj.exitPricingMode,
    EXIT_PRICING_MODES,
    DEFAULT_EXECUTION_POLICY.exitPricingMode,
    issues,
    "exitPricingMode",
  );
  const exitBidAnchorTicks = clampedInt(
    obj.exitBidAnchorTicks,
    DEFAULT_EXECUTION_POLICY.exitBidAnchorTicks,
    BOUND_SPREAD_TICKS_MIN,
    BOUND_SPREAD_TICKS_MAX,
    issues,
    "exitBidAnchorTicks",
  );
  const exitMidpointAnchorTicks = clampedInt(
    obj.exitMidpointAnchorTicks,
    DEFAULT_EXECUTION_POLICY.exitMidpointAnchorTicks,
    BOUND_SPREAD_TICKS_MIN,
    BOUND_SPREAD_TICKS_MAX,
    issues,
    "exitMidpointAnchorTicks",
  );
  const opportunisticTaker = parseOpportunisticTaker(obj.opportunisticTaker, issues);
  const takerAtProfit = parseTakerAtProfit(obj.takerAtProfit, issues);
  const trackR = parseTrackR(obj.trackR, issues);
  const trackS3 = parseTrackS3(obj.trackS3, issues);
  const trackS1 = parseTrackS1(obj.trackS1, issues);
  const trackS4 = parseTrackS4(obj.trackS4, issues);
  const feeSchedule = parseFeeSchedule(obj.feeSchedule, issues);
  const executionProfile = parseExecutionProfile(obj.executionProfile, issues);
  const telemetry = parseTelemetry(obj.telemetry, issues);
  const marketSelection = parseMarketSelection(obj.marketSelection, issues);
  const buyCapacity = parseBuyCapacity(obj.buyCapacity, issues);
  const sellCapacity = parseSellCapacity(obj.sellCapacity, issues);
  const orderCapacity = parseOrderCapacity(obj.orderCapacity, issues);
  const orderLifetime = parseOrderLifetime(obj.orderLifetime, issues);
  const postBuyFillSellCooldownMs = clampedInt(
    obj.postBuyFillSellCooldownMs,
    DEFAULT_EXECUTION_POLICY.postBuyFillSellCooldownMs,
    BOUND_POST_BUY_FILL_SELL_COOLDOWN_MIN_MS,
    BOUND_POST_BUY_FILL_SELL_COOLDOWN_MAX_MS,
    issues,
    "postBuyFillSellCooldownMs",
  );
  const repriceOnOutbid = parseRepriceOnOutbid(obj.repriceOnOutbid, issues);
  const exitRepriceOnDownprice = parseExitRepriceOnDownprice(obj.exitRepriceOnDownprice, issues);
  const dropTrigger = parseDropTrigger(obj.dropTrigger, issues);
  const r23DipTrigger = parseR23DipTrigger(obj.r23DipTrigger, issues);
  const multiBuyLadder = parseMultiBuyLadder(obj.multiBuyLadder, issues);
  const redeemSweep = parseRedeemSweep(obj.redeemSweep, issues);
  const raceProtection = parseRaceProtection(obj.raceProtection, issues);
  const profitTarget = parseProfitTarget(obj.profitTarget, issues);
  const dustAbandonment = parseDustAbandonment(obj.dustAbandonment, issues);
  const repriceChain = parseRepriceChain(obj.repriceChain, issues);
  const sellLoopGuard = parseSellLoopGuard(obj.sellLoopGuard, issues);
  const lossExit = parseLossExit(obj.lossExit, issues);
  const preResolutionExit = parsePreResolutionExit(obj.preResolutionExit, issues);
  const depositActivation = parseDepositActivation(obj.depositActivation, issues);

  return {
    policy: {
      version,
      entryPriceCeiling,
      entryMinMarketAgeSeconds,
      exitOrderTtlMs,
      exitTtlByLiquidity,
      sellTimeoutMs,
      sellReplaceMinPriceDeltaTicks,
      exitRepriceThresholdPct,
      exitRepriceThresholdTicks,
      marketSelection,
      buyCapacity,
      sellCapacity,
      orderCapacity,
      deadSideGuard,
      pricing,
      exitPricingMode,
      exitBidAnchorTicks,
      exitMidpointAnchorTicks,
      opportunisticTaker,
      takerAtProfit,
      trackR,
      trackS3,
      trackS1,
      trackS4,
      feeSchedule,
      executionProfile,
      orderLifetime,
      postBuyFillSellCooldownMs,
      repriceOnOutbid,
      exitRepriceOnDownprice,
      dropTrigger,
      r23DipTrigger,
      multiBuyLadder,
      redeemSweep,
      raceProtection,
      telemetry,
      profitTarget,
      dustAbandonment,
      repriceChain,
      sellLoopGuard,
      lossExit,
      preResolutionExit,
      depositActivation,
    },
    issues,
  };
}

function parseProfitTarget(raw: unknown, issues: string[]): ProfitTargetPolicyConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("profitTarget must be an object");
    return DEFAULT_PROFIT_TARGET_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_PROFIT_TARGET_POLICY.enabled,
      issues,
      "profitTarget.enabled",
    ),
    holdSecondsMin: clampedInt(
      obj.holdSecondsMin,
      DEFAULT_PROFIT_TARGET_POLICY.holdSecondsMin,
      0,
      // Two days — any longer than this and D8 effectively never fires.
      2 * 24 * 60 * 60,
      issues,
      "profitTarget.holdSecondsMin",
    ),
  };
}

function parseDustAbandonment(raw: unknown, issues: string[]): DustAbandonmentPolicyConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("dustAbandonment must be an object");
    return DEFAULT_DUST_ABANDONMENT_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_DUST_ABANDONMENT_POLICY.enabled,
      issues,
      "dustAbandonment.enabled",
    ),
    maxConsecutiveRejects: clampedInt(
      obj.maxConsecutiveRejects,
      DEFAULT_DUST_ABANDONMENT_POLICY.maxConsecutiveRejects,
      1,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "dustAbandonment.maxConsecutiveRejects",
    ),
    priceRecoveryRatio: clampedNumber(
      obj.priceRecoveryRatio,
      DEFAULT_DUST_ABANDONMENT_POLICY.priceRecoveryRatio,
      1.0001,
      100,
      issues,
      "dustAbandonment.priceRecoveryRatio",
    ),
  };
}

function parseTrackS4(raw: unknown, issues: string[]): TrackS4DustAutoCloseConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("trackS4 must be an object");
    return DEFAULT_TRACK_S4_DUST_AUTO_CLOSE_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  const thresholds = objectOr(obj.thresholds);
  const execution = objectOr(obj.execution);

  if (obj.thresholds !== undefined && thresholds == null) {
    issues.push("trackS4.thresholds must be an object");
  }
  if (obj.execution !== undefined && execution == null) {
    issues.push("trackS4.execution must be an object");
  }

  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_TRACK_S4_DUST_AUTO_CLOSE_POLICY.enabled,
      issues,
      "trackS4.enabled",
    ),
    scanIntervalMs: clampedInt(
      obj.scanIntervalMs,
      DEFAULT_TRACK_S4_DUST_AUTO_CLOSE_POLICY.scanIntervalMs,
      BOUND_TRACK_S4_SCAN_MIN_MS,
      BOUND_TRACK_S4_SCAN_MAX_MS,
      issues,
      "trackS4.scanIntervalMs",
    ),
    maxCandidatesPerCycle: clampedInt(
      obj.maxCandidatesPerCycle,
      DEFAULT_TRACK_S4_DUST_AUTO_CLOSE_POLICY.maxCandidatesPerCycle,
      BOUND_TRACK_S4_CANDIDATES_MIN,
      BOUND_TRACK_S4_CANDIDATES_MAX,
      issues,
      "trackS4.maxCandidatesPerCycle",
    ),
    retryBackoffMs: clampedInt(
      obj.retryBackoffMs,
      DEFAULT_TRACK_S4_DUST_AUTO_CLOSE_POLICY.retryBackoffMs,
      BOUND_TRACK_S4_RETRY_MIN_MS,
      BOUND_TRACK_S4_RETRY_MAX_MS,
      issues,
      "trackS4.retryBackoffMs",
    ),
    thresholds: {
      liquidationValueMaxUsdc: clampedNumber(
        thresholds?.liquidationValueMaxUsdc,
        DEFAULT_TRACK_S4_DUST_AUTO_CLOSE_POLICY.thresholds.liquidationValueMaxUsdc,
        BOUND_TRACK_S4_THRESHOLD_MIN,
        BOUND_TRACK_S4_THRESHOLD_MAX,
        issues,
        "trackS4.thresholds.liquidationValueMaxUsdc",
      ),
      costBasisMaxUsdc: clampedNumber(
        thresholds?.costBasisMaxUsdc,
        DEFAULT_TRACK_S4_DUST_AUTO_CLOSE_POLICY.thresholds.costBasisMaxUsdc,
        BOUND_TRACK_S4_THRESHOLD_MIN,
        BOUND_TRACK_S4_THRESHOLD_MAX,
        issues,
        "trackS4.thresholds.costBasisMaxUsdc",
      ),
      lastSellMinAgeMs: clampedInt(
        thresholds?.lastSellMinAgeMs,
        DEFAULT_TRACK_S4_DUST_AUTO_CLOSE_POLICY.thresholds.lastSellMinAgeMs,
        BOUND_TRACK_S4_LAST_SELL_MIN_MS,
        BOUND_TRACK_S4_LAST_SELL_MAX_MS,
        issues,
        "trackS4.thresholds.lastSellMinAgeMs",
      ),
    },
    execution: {
      priceOffsetTicks: clampedInt(
        execution?.priceOffsetTicks,
        DEFAULT_TRACK_S4_DUST_AUTO_CLOSE_POLICY.execution.priceOffsetTicks,
        BOUND_TRACK_S4_PRICE_OFFSET_TICKS_MIN,
        BOUND_TRACK_S4_PRICE_OFFSET_TICKS_MAX,
        issues,
        "trackS4.execution.priceOffsetTicks",
      ),
      cancelStaleSellOrders: booleanOr(
        execution?.cancelStaleSellOrders,
        DEFAULT_TRACK_S4_DUST_AUTO_CLOSE_POLICY.execution.cancelStaleSellOrders,
        issues,
        "trackS4.execution.cancelStaleSellOrders",
      ),
    },
  };
}

function parseRepriceChain(raw: unknown, issues: string[]): RepriceChainPolicyConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("repriceChain must be an object");
    return DEFAULT_REPRICE_CHAIN_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_REPRICE_CHAIN_POLICY.enabled,
      issues,
      "repriceChain.enabled",
    ),
    windowMs: lifetimeMs(
      obj.windowMs,
      DEFAULT_REPRICE_CHAIN_POLICY.windowMs,
      "repriceChain.windowMs",
      issues,
    ),
    maxChainCount: clampedInt(
      obj.maxChainCount,
      DEFAULT_REPRICE_CHAIN_POLICY.maxChainCount,
      1,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "repriceChain.maxChainCount",
    ),
    dynamicChainCap: parseDynamicChainCap(obj.dynamicChainCap, issues),
  };
}

function parseSellLoopGuard(raw: unknown, issues: string[]): SellLoopGuardPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("sellLoopGuard must be an object");
    return DEFAULT_SELL_LOOP_GUARD_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_SELL_LOOP_GUARD_POLICY.enabled,
      issues,
      "sellLoopGuard.enabled",
    ),
    windowMs: clampedInt(
      obj.windowMs,
      DEFAULT_SELL_LOOP_GUARD_POLICY.windowMs,
      BOUND_SELL_LOOP_GUARD_WINDOW_MIN_MS,
      BOUND_SELL_LOOP_GUARD_WINDOW_MAX_MS,
      issues,
      "sellLoopGuard.windowMs",
    ),
    threshold: clampedInt(
      obj.threshold,
      DEFAULT_SELL_LOOP_GUARD_POLICY.threshold,
      1,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "sellLoopGuard.threshold",
    ),
    cooldownMs: clampedInt(
      obj.cooldownMs,
      DEFAULT_SELL_LOOP_GUARD_POLICY.cooldownMs,
      BOUND_SELL_LOOP_GUARD_WINDOW_MIN_MS,
      BOUND_SELL_LOOP_GUARD_WINDOW_MAX_MS,
      issues,
      "sellLoopGuard.cooldownMs",
    ),
    countPostOnlyCrossPreSubmit: booleanOr(
      obj.countPostOnlyCrossPreSubmit,
      DEFAULT_SELL_LOOP_GUARD_POLICY.countPostOnlyCrossPreSubmit,
      issues,
      "sellLoopGuard.countPostOnlyCrossPreSubmit",
    ),
    countExchangeNoOrderId: booleanOr(
      obj.countExchangeNoOrderId,
      DEFAULT_SELL_LOOP_GUARD_POLICY.countExchangeNoOrderId,
      issues,
      "sellLoopGuard.countExchangeNoOrderId",
    ),
  };
}

function parseDynamicChainCap(raw: unknown, issues: string[]): DynamicChainCapPolicyConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("repriceChain.dynamicChainCap must be an object");
    return DEFAULT_REPRICE_CHAIN_POLICY.dynamicChainCap;
  }
  const obj = raw as Record<string, unknown>;
  const defaults = DEFAULT_REPRICE_CHAIN_POLICY.dynamicChainCap;
  return {
    enabled: booleanOr(
      obj.enabled,
      defaults.enabled,
      issues,
      "repriceChain.dynamicChainCap.enabled",
    ),
    tradeCountThinThreshold: clampedInt(
      obj.tradeCountThinThreshold,
      defaults.tradeCountThinThreshold,
      BOUND_PUBLIC_TRADE_COUNT_MIN,
      BOUND_PUBLIC_TRADE_COUNT_MAX,
      issues,
      "repriceChain.dynamicChainCap.tradeCountThinThreshold",
    ),
    tradeCountLiquidThreshold: clampedInt(
      obj.tradeCountLiquidThreshold,
      defaults.tradeCountLiquidThreshold,
      BOUND_PUBLIC_TRADE_COUNT_MIN,
      BOUND_PUBLIC_TRADE_COUNT_MAX,
      issues,
      "repriceChain.dynamicChainCap.tradeCountLiquidThreshold",
    ),
    capThin: clampedInt(
      obj.capThin,
      defaults.capThin,
      1,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "repriceChain.dynamicChainCap.capThin",
    ),
    capMedium: clampedInt(
      obj.capMedium,
      defaults.capMedium,
      1,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "repriceChain.dynamicChainCap.capMedium",
    ),
    capLiquid: clampedInt(
      obj.capLiquid,
      defaults.capLiquid,
      1,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "repriceChain.dynamicChainCap.capLiquid",
    ),
    capUnknown: clampedInt(
      obj.capUnknown,
      defaults.capUnknown,
      1,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "repriceChain.dynamicChainCap.capUnknown",
    ),
  };
}

function parseExitTtlByLiquidity(raw: unknown, issues: string[]): ExitTtlByLiquidityPolicyConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("exitTtlByLiquidity must be an object");
    return DEFAULT_EXIT_TTL_BY_LIQUIDITY_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  const defaults = DEFAULT_EXIT_TTL_BY_LIQUIDITY_POLICY;
  return {
    enabled: booleanOr(obj.enabled, defaults.enabled, issues, "exitTtlByLiquidity.enabled"),
    thinMs: clampedInt(
      obj.thinMs,
      defaults.thinMs,
      BOUND_EXIT_TTL_MIN_MS,
      BOUND_EXIT_TTL_MAX_MS,
      issues,
      "exitTtlByLiquidity.thinMs",
    ),
    mediumMs: clampedInt(
      obj.mediumMs,
      defaults.mediumMs,
      BOUND_EXIT_TTL_MIN_MS,
      BOUND_EXIT_TTL_MAX_MS,
      issues,
      "exitTtlByLiquidity.mediumMs",
    ),
  };
}

function parseLossExit(raw: unknown, issues: string[]): D9LossExitPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("lossExit must be an object");
    return DEFAULT_LOSS_EXIT_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(obj.enabled, DEFAULT_LOSS_EXIT_POLICY.enabled, issues, "lossExit.enabled"),
    states: algoStateListOr(obj.states, DEFAULT_LOSS_EXIT_POLICY.states, issues, "lossExit.states"),
    minPublicTradeCount24h: clampedInt(
      obj.minPublicTradeCount24h,
      DEFAULT_LOSS_EXIT_POLICY.minPublicTradeCount24h,
      BOUND_PUBLIC_TRADE_COUNT_MIN,
      BOUND_PUBLIC_TRADE_COUNT_MAX,
      issues,
      "lossExit.minPublicTradeCount24h",
    ),
    cohortGuard: parseLossExitCohortGuard(obj.cohortGuard, issues),
  };
}

function parseLossExitCohortGuard(raw: unknown, issues: string[]): D9LossExitPolicy["cohortGuard"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("lossExit.cohortGuard must be an object");
    return DEFAULT_LOSS_EXIT_POLICY.cohortGuard;
  }
  const obj = raw as Record<string, unknown>;
  const avgBuyMin = clampedNumber(
    obj.avgBuyMin,
    DEFAULT_LOSS_EXIT_POLICY.cohortGuard.avgBuyMin,
    BOUND_H5_AVG_BUY_MIN,
    BOUND_H5_AVG_BUY_MAX,
    issues,
    "lossExit.cohortGuard.avgBuyMin",
  );
  const avgBuyMax = clampedNumber(
    obj.avgBuyMax,
    DEFAULT_LOSS_EXIT_POLICY.cohortGuard.avgBuyMax,
    BOUND_H5_AVG_BUY_MIN,
    BOUND_H5_AVG_BUY_MAX,
    issues,
    "lossExit.cohortGuard.avgBuyMax",
  );
  if (avgBuyMin >= avgBuyMax) {
    issues.push("lossExit.cohortGuard.avgBuyMin must be less than avgBuyMax");
    return DEFAULT_LOSS_EXIT_POLICY.cohortGuard;
  }
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_LOSS_EXIT_POLICY.cohortGuard.enabled,
      issues,
      "lossExit.cohortGuard.enabled",
    ),
    state: enumOr(
      obj.state,
      ALGO_STATES,
      DEFAULT_LOSS_EXIT_POLICY.cohortGuard.state,
      issues,
      "lossExit.cohortGuard.state",
    ),
    avgBuyMin,
    avgBuyMax,
    minDaysToResolve: clampedNumber(
      obj.minDaysToResolve,
      DEFAULT_LOSS_EXIT_POLICY.cohortGuard.minDaysToResolve,
      0,
      BOUND_H5_DAYS_TO_RESOLVE_MAX,
      issues,
      "lossExit.cohortGuard.minDaysToResolve",
    ),
  };
}

function parsePreResolutionExit(raw: unknown, issues: string[]): QdPreResolutionExitPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("preResolutionExit must be an object");
    return DEFAULT_PRE_RESOLUTION_EXIT_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_PRE_RESOLUTION_EXIT_POLICY.enabled,
      issues,
      "preResolutionExit.enabled",
    ),
    ttcThresholdMs: clampedInt(
      obj.ttcThresholdMs,
      DEFAULT_PRE_RESOLUTION_EXIT_POLICY.ttcThresholdMs,
      BOUND_QD_TTC_MIN_MS,
      BOUND_QD_TTC_MAX_MS,
      issues,
      "preResolutionExit.ttcThresholdMs",
    ),
    tierCeiling: clampedNumber(
      obj.tierCeiling,
      DEFAULT_PRE_RESOLUTION_EXIT_POLICY.tierCeiling,
      BOUND_QD_TIER_CEILING_MIN,
      BOUND_QD_TIER_CEILING_MAX,
      issues,
      "preResolutionExit.tierCeiling",
    ),
    bidFloorAbs: clampedNumber(
      obj.bidFloorAbs,
      DEFAULT_PRE_RESOLUTION_EXIT_POLICY.bidFloorAbs,
      BOUND_QD_BID_FLOOR_MIN,
      BOUND_QD_BID_FLOOR_MAX,
      issues,
      "preResolutionExit.bidFloorAbs",
    ),
    salvageEnabled: booleanOr(
      obj.salvageEnabled,
      DEFAULT_PRE_RESOLUTION_EXIT_POLICY.salvageEnabled,
      issues,
      "preResolutionExit.salvageEnabled",
    ),
    salvageTtcMs: clampedInt(
      obj.salvageTtcMs,
      DEFAULT_PRE_RESOLUTION_EXIT_POLICY.salvageTtcMs,
      BOUND_QD_TTC_MIN_MS,
      BOUND_QD_TTC_MAX_MS,
      issues,
      "preResolutionExit.salvageTtcMs",
    ),
    salvageFloorRatio: clampedNumber(
      obj.salvageFloorRatio,
      DEFAULT_PRE_RESOLUTION_EXIT_POLICY.salvageFloorRatio,
      BOUND_QD_SALVAGE_FLOOR_RATIO_MIN,
      BOUND_QD_SALVAGE_FLOOR_RATIO_MAX,
      issues,
      "preResolutionExit.salvageFloorRatio",
    ),
  };
}

function parseOpportunisticTaker(raw: unknown, issues: string[]): OpportunisticTakerPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("opportunisticTaker must be an object");
    return DEFAULT_OPPORTUNISTIC_TAKER_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_OPPORTUNISTIC_TAKER_POLICY.enabled,
      issues,
      "opportunisticTaker.enabled",
    ),
    maxSpreadTicks: clampedInt(
      obj.maxSpreadTicks,
      DEFAULT_OPPORTUNISTIC_TAKER_POLICY.maxSpreadTicks,
      0,
      BOUND_SPREAD_TICKS_MAX,
      issues,
      "opportunisticTaker.maxSpreadTicks",
    ),
    safetyBuffer: clampedNumber(
      obj.safetyBuffer,
      DEFAULT_OPPORTUNISTIC_TAKER_POLICY.safetyBuffer,
      BOUND_TAKER_SAFETY_BUFFER_MIN,
      BOUND_TAKER_SAFETY_BUFFER_MAX,
      issues,
      "opportunisticTaker.safetyBuffer",
    ),
    fallbackMinNotionalUsdc: clampedNumber(
      obj.fallbackMinNotionalUsdc,
      DEFAULT_OPPORTUNISTIC_TAKER_POLICY.fallbackMinNotionalUsdc,
      0,
      BOUND_TAKER_MIN_NOTIONAL_MAX,
      issues,
      "opportunisticTaker.fallbackMinNotionalUsdc",
    ),
    marketableBuyMinNotionalUsdc: clampedNumber(
      obj.marketableBuyMinNotionalUsdc,
      DEFAULT_OPPORTUNISTIC_TAKER_POLICY.marketableBuyMinNotionalUsdc,
      0,
      BOUND_TAKER_MIN_NOTIONAL_MAX,
      issues,
      "opportunisticTaker.marketableBuyMinNotionalUsdc",
    ),
  };
}

function parseTakerAtProfit(raw: unknown, issues: string[]): TakerAtProfitPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("takerAtProfit must be an object");
    return DEFAULT_TAKER_AT_PROFIT_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_TAKER_AT_PROFIT_POLICY.enabled,
      issues,
      "takerAtProfit.enabled",
    ),
    minGrossExitRatio: clampedNumber(
      obj.minGrossExitRatio,
      DEFAULT_TAKER_AT_PROFIT_POLICY.minGrossExitRatio,
      BOUND_TAKER_AT_PROFIT_RATIO_MIN,
      BOUND_TAKER_AT_PROFIT_RATIO_MAX,
      issues,
      "takerAtProfit.minGrossExitRatio",
    ),
    maxSpreadTicks: nullableClampedInt(
      obj.maxSpreadTicks,
      DEFAULT_TAKER_AT_PROFIT_POLICY.maxSpreadTicks,
      BOUND_SPREAD_TICKS_MIN,
      BOUND_SPREAD_TICKS_MAX,
      issues,
      "takerAtProfit.maxSpreadTicks",
    ),
    rules: takerAtProfitRulesOr(
      obj.rules,
      DEFAULT_TAKER_AT_PROFIT_POLICY.rules,
      issues,
      "takerAtProfit.rules",
    ),
  };
}

function parseTrackR(raw: unknown, issues: string[]): TrackRHonestPricingPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("trackR must be an object");
    return DEFAULT_TRACK_R_HONEST_PRICING_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_TRACK_R_HONEST_PRICING_POLICY.enabled,
      issues,
      "trackR.enabled",
    ),
    safetyMargin: clampedNumber(
      obj.safetyMargin,
      DEFAULT_TRACK_R_HONEST_PRICING_POLICY.safetyMargin,
      BOUND_TRACK_R_SAFETY_MARGIN_MIN,
      BOUND_TRACK_R_SAFETY_MARGIN_MAX,
      issues,
      "trackR.safetyMargin",
    ),
    requireFullDepth: booleanOr(
      obj.requireFullDepth,
      DEFAULT_TRACK_R_HONEST_PRICING_POLICY.requireFullDepth,
      issues,
      "trackR.requireFullDepth",
    ),
    universalFallbackRate: clampedNumber(
      obj.universalFallbackRate,
      DEFAULT_TRACK_R_HONEST_PRICING_POLICY.universalFallbackRate,
      BOUND_TRACK_R_UNIVERSAL_FALLBACK_MIN,
      BOUND_TRACK_R_UNIVERSAL_FALLBACK_MAX,
      issues,
      "trackR.universalFallbackRate",
    ),
    maxSaneThreshold: clampedNumber(
      obj.maxSaneThreshold,
      DEFAULT_TRACK_R_HONEST_PRICING_POLICY.maxSaneThreshold,
      BOUND_TRACK_R_MAX_SANE_THRESHOLD_MIN,
      BOUND_TRACK_R_MAX_SANE_THRESHOLD_MAX,
      issues,
      "trackR.maxSaneThreshold",
    ),
    exitBookFallback: booleanOr(
      obj.exitBookFallback,
      DEFAULT_TRACK_R_HONEST_PRICING_POLICY.exitBookFallback,
      issues,
      "trackR.exitBookFallback",
    ),
    exitBookStalenessMs: clampedInt(
      obj.exitBookStalenessMs,
      DEFAULT_TRACK_R_HONEST_PRICING_POLICY.exitBookStalenessMs,
      BOUND_TRACK_R_EXIT_BOOK_STALENESS_MS_MIN,
      BOUND_TRACK_R_EXIT_BOOK_STALENESS_MS_MAX,
      issues,
      "trackR.exitBookStalenessMs",
    ),
    exitBookFetchTtlMs: clampedInt(
      obj.exitBookFetchTtlMs,
      DEFAULT_TRACK_R_HONEST_PRICING_POLICY.exitBookFetchTtlMs,
      BOUND_TRACK_R_EXIT_BOOK_FETCH_TTL_MS_MIN,
      BOUND_TRACK_R_EXIT_BOOK_FETCH_TTL_MS_MAX,
      issues,
      "trackR.exitBookFetchTtlMs",
    ),
    takerCapSkip: booleanOr(
      obj.takerCapSkip,
      DEFAULT_TRACK_R_HONEST_PRICING_POLICY.takerCapSkip,
      issues,
      "trackR.takerCapSkip",
    ),
    allowPartialExit: booleanOr(
      obj.allowPartialExit,
      DEFAULT_TRACK_R_HONEST_PRICING_POLICY.allowPartialExit,
      issues,
      "trackR.allowPartialExit",
    ),
    partialExitMinFraction: clampedNumber(
      obj.partialExitMinFraction,
      DEFAULT_TRACK_R_HONEST_PRICING_POLICY.partialExitMinFraction,
      BOUND_TRACK_R_PARTIAL_MIN_FRACTION_MIN,
      BOUND_TRACK_R_PARTIAL_MIN_FRACTION_MAX,
      issues,
      "trackR.partialExitMinFraction",
    ),
    partialExitMinShares: clampedNumber(
      obj.partialExitMinShares,
      DEFAULT_TRACK_R_HONEST_PRICING_POLICY.partialExitMinShares,
      BOUND_TRACK_R_PARTIAL_MIN_SHARES_MIN,
      BOUND_TRACK_R_PARTIAL_MIN_SHARES_MAX,
      issues,
      "trackR.partialExitMinShares",
    ),
    partialExitMaxPerHour: clampedInt(
      obj.partialExitMaxPerHour,
      DEFAULT_TRACK_R_HONEST_PRICING_POLICY.partialExitMaxPerHour,
      BOUND_TRACK_R_PARTIAL_MAX_PER_HOUR_MIN,
      BOUND_TRACK_R_PARTIAL_MAX_PER_HOUR_MAX,
      issues,
      "trackR.partialExitMaxPerHour",
    ),
  };
}

function parseFeeSchedule(raw: unknown, issues: string[]): FeeScheduleConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("feeSchedule must be an object");
    return DEFAULT_FEE_SCHEDULE_CONFIG;
  }
  const obj = raw as Record<string, unknown>;
  const localIssues: string[] = [];
  const periods = parseFeeSchedulePeriods(obj.periods, localIssues);
  const parsed: FeeScheduleConfig = {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_FEE_SCHEDULE_CONFIG.enabled,
      localIssues,
      "feeSchedule.enabled",
    ),
    apiPrimaryEnabled: booleanOr(
      obj.apiPrimaryEnabled,
      DEFAULT_FEE_SCHEDULE_CONFIG.apiPrimaryEnabled,
      localIssues,
      "feeSchedule.apiPrimaryEnabled",
    ),
    scheduleFallbackEnabled: booleanOr(
      obj.scheduleFallbackEnabled,
      DEFAULT_FEE_SCHEDULE_CONFIG.scheduleFallbackEnabled,
      localIssues,
      "feeSchedule.scheduleFallbackEnabled",
    ),
    apiTtlMs: clampedInt(
      obj.apiTtlMs,
      DEFAULT_FEE_SCHEDULE_CONFIG.apiTtlMs,
      BOUND_FEE_SCHEDULE_TTL_MIN_MS,
      BOUND_FEE_SCHEDULE_TTL_MAX_MS,
      localIssues,
      "feeSchedule.apiTtlMs",
    ),
    apiMissTtlMs: clampedInt(
      obj.apiMissTtlMs,
      DEFAULT_FEE_SCHEDULE_CONFIG.apiMissTtlMs,
      BOUND_FEE_SCHEDULE_TTL_MIN_MS,
      BOUND_FEE_SCHEDULE_TTL_MAX_MS,
      localIssues,
      "feeSchedule.apiMissTtlMs",
    ),
    degradedEventCooldownMs: clampedInt(
      obj.degradedEventCooldownMs,
      DEFAULT_FEE_SCHEDULE_CONFIG.degradedEventCooldownMs,
      BOUND_FEE_SCHEDULE_TTL_MIN_MS,
      BOUND_FEE_SCHEDULE_TTL_MAX_MS,
      localIssues,
      "feeSchedule.degradedEventCooldownMs",
    ),
    periods,
  };

  localIssues.push(...validateFeeSchedulePeriods(parsed.periods));
  if (localIssues.length > 0) {
    issues.push(...localIssues);
    return DEFAULT_FEE_SCHEDULE_CONFIG;
  }
  return parsed;
}

function parseFeeSchedulePeriods(raw: unknown, issues: string[]): FeeSchedulePeriodConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push("feeSchedule.periods must be an array");
    return [];
  }
  if (raw.length > BOUND_FEE_SCHEDULE_PERIODS_MAX) {
    issues.push(`feeSchedule.periods length out of range [0, ${BOUND_FEE_SCHEDULE_PERIODS_MAX}]`);
    return [];
  }
  return raw
    .map((period, index) => parseFeeSchedulePeriod(period, index, issues))
    .filter((period): period is FeeSchedulePeriodConfig => period !== null);
}

function parseFeeSchedulePeriod(
  raw: unknown,
  index: number,
  issues: string[],
): FeeSchedulePeriodConfig | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push(`feeSchedule.periods[${index}] must be an object`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const periodId = requiredNonEmptyString(
    obj.periodId,
    issues,
    `feeSchedule.periods[${index}].periodId`,
  );
  const startsAtUtc = requiredNonEmptyString(
    obj.startsAtUtc,
    issues,
    `feeSchedule.periods[${index}].startsAtUtc`,
  );
  const endsAtUtc = nullableStringOr(
    obj.endsAtUtc,
    issues,
    `feeSchedule.periods[${index}].endsAtUtc`,
  );
  const sourceNote = requiredNonEmptyString(
    obj.sourceNote,
    issues,
    `feeSchedule.periods[${index}].sourceNote`,
  );
  const appliesTo = parseFeeScheduleScope(obj.appliesTo, index, issues);
  const makerRebateFraction = clampedNumber(
    obj.makerRebateFraction,
    Number.NaN,
    BOUND_FEE_SCHEDULE_REBATE_MIN,
    BOUND_FEE_SCHEDULE_REBATE_MAX,
    issues,
    `feeSchedule.periods[${index}].makerRebateFraction`,
  );
  const baseRate = nullableClampedNumber(
    obj.baseRate,
    null,
    0,
    BOUND_TRACK_R_UNIVERSAL_FALLBACK_MAX,
    issues,
    `feeSchedule.periods[${index}].baseRate`,
  );
  const exponent = nullableClampedNumber(
    obj.exponent,
    null,
    0,
    10,
    issues,
    `feeSchedule.periods[${index}].exponent`,
  );
  const takerOnly =
    obj.takerOnly === undefined
      ? null
      : booleanOr(obj.takerOnly, false, issues, `feeSchedule.periods[${index}].takerOnly`);
  if (periodId == null || startsAtUtc == null || sourceNote == null || appliesTo == null)
    return null;
  return {
    periodId,
    startsAtUtc,
    endsAtUtc,
    makerRebateFraction,
    ...(baseRate !== null ? { baseRate } : {}),
    ...(exponent !== null ? { exponent } : {}),
    ...(takerOnly !== null ? { takerOnly } : {}),
    appliesTo,
    sourceNote,
  };
}

function parseFeeScheduleScope(
  raw: unknown,
  index: number,
  issues: string[],
): FeeScheduleScope | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push(`feeSchedule.periods[${index}].appliesTo must be an object`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const scope = obj.scope;
  if (scope === "all") return { scope: "all" };
  if (scope !== "category" && scope !== "condition" && scope !== "token") {
    issues.push(`feeSchedule.periods[${index}].appliesTo.scope invalid`);
    return null;
  }
  const value = requiredNonEmptyString(
    obj.value,
    issues,
    `feeSchedule.periods[${index}].appliesTo.value`,
  );
  return value == null ? null : { scope, value };
}

function parseTrackS3(raw: unknown, issues: string[]): TrackS3MarginAwareSpreadPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("trackS3 must be an object");
    return DEFAULT_TRACK_S3_MARGIN_AWARE_SPREAD_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_TRACK_S3_MARGIN_AWARE_SPREAD_POLICY.enabled,
      issues,
      "trackS3.enabled",
    ),
    baseCap: clampedInt(
      obj.baseCap,
      DEFAULT_TRACK_S3_MARGIN_AWARE_SPREAD_POLICY.baseCap,
      BOUND_SPREAD_TICKS_MIN,
      BOUND_SPREAD_TICKS_MAX,
      issues,
      "trackS3.baseCap",
    ),
    tiers: parseTrackS3Tiers(obj.tiers, issues),
  };
}

function parseTrackS3Tiers(raw: unknown, issues: string[]): readonly TrackS3SpreadTierPolicy[] {
  if (raw === undefined) return DEFAULT_TRACK_S3_MARGIN_AWARE_SPREAD_POLICY.tiers;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > BOUND_TRACK_S3_TIER_COUNT_MAX) {
    issues.push(
      `trackS3.tiers must be a non-empty array with <= ${BOUND_TRACK_S3_TIER_COUNT_MAX} items`,
    );
    return DEFAULT_TRACK_S3_MARGIN_AWARE_SPREAD_POLICY.tiers;
  }

  const parsed: TrackS3SpreadTierPolicy[] = [];
  let valid = true;
  raw.forEach((entry, index) => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push(`trackS3.tiers[${index}] must be an object`);
      valid = false;
      return;
    }
    const obj = entry as Record<string, unknown>;
    const minMargin = obj.minMargin;
    const maxSpreadTicks = obj.maxSpreadTicks;
    const label = obj.label;
    if (
      typeof minMargin !== "number" ||
      !Number.isFinite(minMargin) ||
      minMargin < BOUND_TRACK_S3_MARGIN_MIN ||
      minMargin > BOUND_TRACK_S3_MARGIN_MAX
    ) {
      issues.push(
        `trackS3.tiers[${index}].minMargin must be in [${BOUND_TRACK_S3_MARGIN_MIN}, ${BOUND_TRACK_S3_MARGIN_MAX}]`,
      );
      valid = false;
    }
    if (
      typeof maxSpreadTicks !== "number" ||
      !Number.isInteger(maxSpreadTicks) ||
      maxSpreadTicks < BOUND_SPREAD_TICKS_MIN ||
      maxSpreadTicks > BOUND_SPREAD_TICKS_MAX
    ) {
      issues.push(
        `trackS3.tiers[${index}].maxSpreadTicks must be an integer in [${BOUND_SPREAD_TICKS_MIN}, ${BOUND_SPREAD_TICKS_MAX}]`,
      );
      valid = false;
    }
    if (typeof label !== "string" || label.trim().length === 0) {
      issues.push(`trackS3.tiers[${index}].label must be a non-empty string`);
      valid = false;
    }
    if (valid) {
      parsed.push({
        minMargin: minMargin as number,
        maxSpreadTicks: maxSpreadTicks as number,
        label: (label as string).trim(),
      });
    }
  });

  return valid ? parsed : DEFAULT_TRACK_S3_MARGIN_AWARE_SPREAD_POLICY.tiers;
}

function parseExecutionProfile(raw: unknown, issues: string[]): ExecutionProfilePolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("executionProfile must be an object");
    return DEFAULT_EXECUTION_PROFILE_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_EXECUTION_PROFILE_POLICY.enabled,
      issues,
      "executionProfile.enabled",
    ),
    maxTokensPerCycle: clampedInt(
      obj.maxTokensPerCycle,
      DEFAULT_EXECUTION_PROFILE_POLICY.maxTokensPerCycle,
      BOUND_EXECUTION_PROFILE_TOKENS_MIN,
      BOUND_EXECUTION_PROFILE_TOKENS_MAX,
      issues,
      "executionProfile.maxTokensPerCycle",
    ),
    qdHandoffThresholdMs: clampedInt(
      obj.qdHandoffThresholdMs,
      DEFAULT_EXECUTION_PROFILE_POLICY.qdHandoffThresholdMs,
      BOUND_EXECUTION_PROFILE_HANDOFF_MIN_MS,
      BOUND_EXECUTION_PROFILE_HANDOFF_MAX_MS,
      issues,
      "executionProfile.qdHandoffThresholdMs",
    ),
    profileHysteresis: parseExecutionProfileHysteresis(obj.profileHysteresis, issues),
    costCaps: parseExecutionProfileToggle(
      obj.costCaps,
      DEFAULT_EXECUTION_PROFILE_POLICY.costCaps,
      issues,
      "executionProfile.costCaps",
    ),
    scaleIn: parseExecutionProfileScaleInToggle(
      obj.scaleIn,
      DEFAULT_EXECUTION_PROFILE_POLICY.scaleIn,
      issues,
      "executionProfile.scaleIn",
    ),
    signalFeed: parseExecutionProfileSignalFeed(obj.signalFeed, issues),
    abandonment: parseExecutionProfileAbandonment(obj.abandonment, issues),
    profiles: parseExecutionProfileProfiles(obj.profiles, issues),
    sellLadder: parseExecutionProfileSellLadder(obj.sellLadder, issues),
    adoptExistingPositions: parseExecutionProfileToggle(
      obj.adoptExistingPositions,
      DEFAULT_EXECUTION_PROFILE_POLICY.adoptExistingPositions,
      issues,
      "executionProfile.adoptExistingPositions",
    ),
    adoptExistingS1Ladders: parseExecutionProfileToggle(
      obj.adoptExistingS1Ladders,
      DEFAULT_EXECUTION_PROFILE_POLICY.adoptExistingS1Ladders,
      issues,
      "executionProfile.adoptExistingS1Ladders",
    ),
    monitoring: parseExecutionProfileMonitoring(obj.monitoring, issues),
  };
}

function parseExecutionProfileMonitoring(
  raw: unknown,
  issues: string[],
): ExecutionProfileMonitoringConfig {
  const fallback = DEFAULT_EXECUTION_PROFILE_POLICY.monitoring;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("executionProfile.monitoring must be an object");
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  const anomalyDetection = objectOr(obj.anomalyDetection);
  return {
    healthCheckIntervalMs: clampedInt(
      obj.healthCheckIntervalMs,
      fallback.healthCheckIntervalMs,
      BOUND_EXECUTION_PROFILE_MONITORING_MIN_MS,
      BOUND_EXECUTION_PROFILE_MONITORING_MAX_MS,
      issues,
      "executionProfile.monitoring.healthCheckIntervalMs",
    ),
    rollupWindowMs: clampedInt(
      obj.rollupWindowMs,
      fallback.rollupWindowMs,
      BOUND_EXECUTION_PROFILE_MONITORING_MIN_MS,
      BOUND_EXECUTION_PROFILE_MONITORING_MAX_MS,
      issues,
      "executionProfile.monitoring.rollupWindowMs",
    ),
    maxRollupBuckets: clampedInt(
      obj.maxRollupBuckets,
      fallback.maxRollupBuckets,
      BOUND_EXECUTION_PROFILE_ROLLUP_BUCKETS_MIN,
      BOUND_EXECUTION_PROFILE_ROLLUP_BUCKETS_MAX,
      issues,
      "executionProfile.monitoring.maxRollupBuckets",
    ),
    pendingScaleInWarnAfterMs: clampedInt(
      obj.pendingScaleInWarnAfterMs,
      fallback.pendingScaleInWarnAfterMs,
      BOUND_EXECUTION_PROFILE_MONITORING_MIN_MS,
      BOUND_EXECUTION_PROFILE_MONITORING_MAX_MS,
      issues,
      "executionProfile.monitoring.pendingScaleInWarnAfterMs",
    ),
    healthRiskEventEveryMs: clampedInt(
      obj.healthRiskEventEveryMs,
      fallback.healthRiskEventEveryMs,
      BOUND_EXECUTION_PROFILE_MONITORING_MIN_MS,
      BOUND_EXECUTION_PROFILE_MONITORING_MAX_MS,
      issues,
      "executionProfile.monitoring.healthRiskEventEveryMs",
    ),
    anomalyDetection: {
      enabled: booleanOr(
        anomalyDetection?.enabled,
        fallback.anomalyDetection.enabled,
        issues,
        "executionProfile.monitoring.anomalyDetection.enabled",
      ),
      cooldownMs: clampedInt(
        anomalyDetection?.cooldownMs,
        fallback.anomalyDetection.cooldownMs,
        BOUND_EXECUTION_PROFILE_MONITORING_MIN_MS,
        BOUND_EXECUTION_PROFILE_MONITORING_MAX_MS,
        issues,
        "executionProfile.monitoring.anomalyDetection.cooldownMs",
      ),
    },
  };
}

function parseExecutionProfileAbandonment(
  raw: unknown,
  issues: string[],
): ExecutionProfileAbandonmentConfig {
  const fallback = DEFAULT_EXECUTION_PROFILE_POLICY.abandonment;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("executionProfile.abandonment must be an object");
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      fallback.enabled,
      issues,
      "executionProfile.abandonment.enabled",
    ),
    evaluationIntervalMs: clampedInt(
      obj.evaluationIntervalMs,
      fallback.evaluationIntervalMs,
      BOUND_EXECUTION_PROFILE_MONITORING_MIN_MS,
      BOUND_EXECUTION_PROFILE_MONITORING_MAX_MS,
      issues,
      "executionProfile.abandonment.evaluationIntervalMs",
    ),
    maxTokensPerCycle: clampedInt(
      obj.maxTokensPerCycle,
      fallback.maxTokensPerCycle,
      BOUND_EXECUTION_PROFILE_TOKENS_MIN,
      BOUND_EXECUTION_PROFILE_TOKENS_MAX,
      issues,
      "executionProfile.abandonment.maxTokensPerCycle",
    ),
    hardStaleFallbackMs: clampedInt(
      obj.hardStaleFallbackMs,
      fallback.hardStaleFallbackMs,
      BOUND_EXECUTION_PROFILE_MONITORING_MIN_MS,
      BOUND_EXECUTION_PROFILE_MONITORING_MAX_MS,
      issues,
      "executionProfile.abandonment.hardStaleFallbackMs",
    ),
    bands: parseExecutionProfileAbandonmentBands(obj.bands, fallback.bands, issues),
  };
}

function parseExecutionProfileAbandonmentBands(
  raw: unknown,
  fallback: ExecutionProfileAbandonmentConfig["bands"],
  issues: string[],
): ExecutionProfileAbandonmentConfig["bands"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("executionProfile.abandonment.bands must be an object");
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  return {
    cheap: parseExecutionProfileAbandonmentBand(obj.cheap, fallback.cheap, issues, "cheap"),
    medium_low: parseExecutionProfileAbandonmentBand(
      obj.medium_low,
      fallback.medium_low,
      issues,
      "medium_low",
    ),
    medium_high: parseExecutionProfileAbandonmentBand(
      obj.medium_high,
      fallback.medium_high,
      issues,
      "medium_high",
    ),
    expensive: parseExecutionProfileAbandonmentBand(
      obj.expensive,
      fallback.expensive,
      issues,
      "expensive",
    ),
  };
}

function parseExecutionProfileAbandonmentBand(
  raw: unknown,
  fallback: ExecutionProfileAbandonmentBandConfig,
  issues: string[],
  band: ProfileLadderBand,
): ExecutionProfileAbandonmentBandConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined)
      issues.push(`executionProfile.abandonment.bands.${band} must be an object`);
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  const name = `executionProfile.abandonment.bands.${band}`;
  const previousIssueCount = issues.length;
  const parsed: ExecutionProfileAbandonmentBandConfig = {
    enabled: booleanOr(obj.enabled, fallback.enabled, issues, `${name}.enabled`),
    probeSizeMaxUsdc: positiveNumberOr(
      obj.probeSizeMaxUsdc,
      fallback.probeSizeMaxUsdc,
      issues,
      `${name}.probeSizeMaxUsdc`,
    ).value,
    maxProbeBuyCount: clampedInt(
      obj.maxProbeBuyCount,
      fallback.maxProbeBuyCount,
      1,
      100,
      issues,
      `${name}.maxProbeBuyCount`,
    ),
    scaleInRequiredWithinMs: clampedInt(
      obj.scaleInRequiredWithinMs,
      fallback.scaleInRequiredWithinMs,
      BOUND_EXECUTION_PROFILE_MONITORING_MIN_MS,
      BOUND_EXECUTION_PROFILE_MONITORING_MAX_MS,
      issues,
      `${name}.scaleInRequiredWithinMs`,
    ),
  };
  return issues.length === previousIssueCount ? parsed : fallback;
}

function parseExecutionProfileToggle(
  raw: unknown,
  fallback: ExecutionProfileFeatureToggle,
  issues: string[],
  name: string,
): ExecutionProfileFeatureToggle {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push(`${name} must be an object`);
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(obj.enabled, fallback.enabled, issues, `${name}.enabled`),
  };
}

function parseExecutionProfileSellLadder(
  raw: unknown,
  issues: string[],
): ExecutionProfileSellLadderConfig {
  const fallback = DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("executionProfile.sellLadder must be an object");
    return fallback;
  }

  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      fallback.enabled,
      issues,
      "executionProfile.sellLadder.enabled",
    ),
    phase: clampedInt(obj.phase, fallback.phase, 0, 5, issues, "executionProfile.sellLadder.phase"),
    decisionRuleId: nonEmptyStringOr(
      obj.decisionRuleId,
      fallback.decisionRuleId,
      issues,
      "executionProfile.sellLadder.decisionRuleId",
    ),
    orderTag: nonEmptyStringOr(
      obj.orderTag,
      fallback.orderTag,
      issues,
      "executionProfile.sellLadder.orderTag",
    ),
    bands: parseExecutionProfileSellLadderBands(obj.bands, fallback.bands, issues),
    modeAdjustments: parseProfileLadderModeAdjustments(
      obj.modeAdjustments,
      fallback.modeAdjustments,
      issues,
    ),
    reprice: parseProfileLadderReprice(obj.reprice, fallback.reprice, issues),
    staleReview: parseProfileLadderStaleReview(obj.staleReview, fallback.staleReview, issues),
    postFill: parseProfileLadderPostFill(obj.postFill, fallback.postFill, issues),
    adoptExisting: parseExecutionProfileToggle(
      obj.adoptExisting,
      fallback.adoptExisting,
      issues,
      "executionProfile.sellLadder.adoptExisting",
    ),
  };
}

function parseExecutionProfileSellLadderBands(
  raw: unknown,
  fallback: ExecutionProfileSellLadderConfig["bands"],
  issues: string[],
): ExecutionProfileSellLadderConfig["bands"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("executionProfile.sellLadder.bands must be an object");
    return fallback;
  }

  const obj = raw as Record<string, unknown>;
  return {
    cheap: parseProfileLadderBand(obj.cheap, fallback.cheap, issues, "cheap"),
    medium_low: parseProfileLadderBand(obj.medium_low, fallback.medium_low, issues, "medium_low"),
    medium_high: parseProfileLadderBand(
      obj.medium_high,
      fallback.medium_high,
      issues,
      "medium_high",
    ),
    expensive: parseProfileLadderBand(obj.expensive, fallback.expensive, issues, "expensive"),
  };
}

// Hard per-band live-rung ceilings (Plankton falsification pass): cheap/medium_low
// show more laddering over time and may run up to 2 concurrent live rungs after
// telemetry; medium_high/expensive stay strictly sequential. Defaults are 1
// everywhere — these are the *maximum* an operator may configure, not the default.
const BAND_MAX_CONCURRENT_RUNG_CEILING: Record<ProfileLadderBand, number> = {
  cheap: 2,
  medium_low: 2,
  medium_high: 1,
  expensive: 1,
};

function parseProfileLadderBand(
  raw: unknown,
  fallback: ProfileLadderBandConfig,
  issues: string[],
  band: ProfileLadderBand,
): ProfileLadderBandConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined)
      issues.push(`executionProfile.sellLadder.bands.${band} must be an object`);
    return fallback;
  }

  const obj = raw as Record<string, unknown>;
  const name = `executionProfile.sellLadder.bands.${band}`;
  const previousIssueCount = issues.length;
  const multipliers = positiveNumberArrayOr(
    obj.multipliers,
    fallback.multipliers,
    issues,
    `${name}.multipliers`,
  );
  const sizingVector = positiveNumberArrayOr(
    obj.sizingVector,
    fallback.sizingVector,
    issues,
    `${name}.sizingVector`,
  );
  const parsed: ProfileLadderBandConfig = {
    enabled: booleanOr(obj.enabled, fallback.enabled, issues, `${name}.enabled`),
    minAvgEntry: nullableNonNegativeNumberOr(
      obj.minAvgEntry,
      fallback.minAvgEntry,
      issues,
      `${name}.minAvgEntry`,
    ).value,
    maxAvgEntry: nullableNonNegativeNumberOr(
      obj.maxAvgEntry,
      fallback.maxAvgEntry,
      issues,
      `${name}.maxAvgEntry`,
    ).value,
    multipliers: multipliers.value,
    sizingVector: sizingVector.value,
    costCapUsd: positiveNumberOr(obj.costCapUsd, fallback.costCapUsd, issues, `${name}.costCapUsd`)
      .value,
    allowFourthRung: booleanOr(
      obj.allowFourthRung,
      fallback.allowFourthRung,
      issues,
      `${name}.allowFourthRung`,
    ),
    fourthRungMinCostUsd: positiveNumberOr(
      obj.fourthRungMinCostUsd,
      fallback.fourthRungMinCostUsd,
      issues,
      `${name}.fourthRungMinCostUsd`,
    ).value,
    maxConcurrentRungs: clampedInt(
      obj.maxConcurrentRungs,
      fallback.maxConcurrentRungs,
      1,
      BAND_MAX_CONCURRENT_RUNG_CEILING[band],
      issues,
      `${name}.maxConcurrentRungs`,
    ),
  };

  return issues.length === previousIssueCount ? parsed : fallback;
}

function parseProfileLadderModeAdjustments(
  raw: unknown,
  fallback: ExecutionProfileSellLadderConfig["modeAdjustments"],
  issues: string[],
): ExecutionProfileSellLadderConfig["modeAdjustments"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined)
      issues.push("executionProfile.sellLadder.modeAdjustments must be an object");
    return fallback;
  }

  const obj = raw as Record<string, unknown>;
  return {
    up: positiveNumberOr(
      obj.up,
      fallback.up,
      issues,
      "executionProfile.sellLadder.modeAdjustments.up",
    ).value,
    flat: positiveNumberOr(
      obj.flat,
      fallback.flat,
      issues,
      "executionProfile.sellLadder.modeAdjustments.flat",
    ).value,
    avg_down: positiveNumberOr(
      obj.avg_down,
      fallback.avg_down,
      issues,
      "executionProfile.sellLadder.modeAdjustments.avg_down",
    ).value,
  };
}

function parseProfileLadderReprice(
  raw: unknown,
  fallback: ExecutionProfileSellLadderConfig["reprice"],
  issues: string[],
): ExecutionProfileSellLadderConfig["reprice"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("executionProfile.sellLadder.reprice must be an object");
    return fallback;
  }

  const obj = raw as Record<string, unknown>;
  const parsed = {
    majorBboMovePct: positiveNumberOr(
      obj.majorBboMovePct,
      fallback.majorBboMovePct,
      issues,
      "executionProfile.sellLadder.reprice.majorBboMovePct",
    ).value,
    strongBboMovePct: positiveNumberOr(
      obj.strongBboMovePct,
      fallback.strongBboMovePct,
      issues,
      "executionProfile.sellLadder.reprice.strongBboMovePct",
    ).value,
    cooldownMs: nonNegativeNumberOr(
      obj.cooldownMs,
      fallback.cooldownMs,
      issues,
      "executionProfile.sellLadder.reprice.cooldownMs",
    ).value,
  };
  if (parsed.strongBboMovePct < parsed.majorBboMovePct) {
    issues.push("executionProfile.sellLadder.reprice.strongBboMovePct must be >= majorBboMovePct");
    return fallback;
  }
  return parsed;
}

function parseProfileLadderPostFill(
  raw: unknown,
  fallback: ExecutionProfileSellLadderConfig["postFill"],
  issues: string[],
): ExecutionProfileSellLadderConfig["postFill"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("executionProfile.sellLadder.postFill must be an object");
    return fallback;
  }

  const obj = raw as Record<string, unknown>;
  return {
    reevalCooldownMs: nonNegativeNumberOr(
      obj.reevalCooldownMs,
      fallback.reevalCooldownMs,
      issues,
      "executionProfile.sellLadder.postFill.reevalCooldownMs",
    ).value,
  };
}

function parseProfileLadderStaleReview(
  raw: unknown,
  fallback: ExecutionProfileSellLadderConfig["staleReview"],
  issues: string[],
): ExecutionProfileSellLadderConfig["staleReview"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("executionProfile.sellLadder.staleReview must be an object");
    return fallback;
  }

  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      fallback.enabled,
      issues,
      "executionProfile.sellLadder.staleReview.enabled",
    ),
    staleAfterMs: positiveNumberOr(
      obj.staleAfterMs,
      fallback.staleAfterMs,
      issues,
      "executionProfile.sellLadder.staleReview.staleAfterMs",
    ).value,
  };
}

function parseExecutionProfileScaleInToggle(
  raw: unknown,
  fallback: ExecutionProfileScaleInFeatureToggle,
  issues: string[],
  name: string,
): ExecutionProfileScaleInFeatureToggle {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push(`${name} must be an object`);
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(obj.enabled, fallback.enabled, issues, `${name}.enabled`),
    useRealFeed: booleanOr(obj.useRealFeed, fallback.useRealFeed, issues, `${name}.useRealFeed`),
  };
}

function parseExecutionProfileSignalFeed(
  raw: unknown,
  issues: string[],
): ExecutionProfileSignalFeedConfig {
  const fallback = DEFAULT_EXECUTION_PROFILE_POLICY.signalFeed;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("executionProfile.signalFeed must be an object");
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      fallback.enabled,
      issues,
      "executionProfile.signalFeed.enabled",
    ),
    windowShortMs: positiveNumberOr(
      obj.windowShortMs,
      fallback.windowShortMs,
      issues,
      "executionProfile.signalFeed.windowShortMs",
    ).value,
    windowLongMs: positiveNumberOr(
      obj.windowLongMs,
      fallback.windowLongMs,
      issues,
      "executionProfile.signalFeed.windowLongMs",
    ).value,
    hotSampleTargetIntervalMs: positiveNumberOr(
      obj.hotSampleTargetIntervalMs,
      fallback.hotSampleTargetIntervalMs,
      issues,
      "executionProfile.signalFeed.hotSampleTargetIntervalMs",
    ).value,
    warmBucketMs: positiveNumberOr(
      obj.warmBucketMs,
      fallback.warmBucketMs,
      issues,
      "executionProfile.signalFeed.warmBucketMs",
    ).value,
    coldArchiveBucketMs: positiveNumberOr(
      obj.coldArchiveBucketMs,
      fallback.coldArchiveBucketMs,
      issues,
      "executionProfile.signalFeed.coldArchiveBucketMs",
    ).value,
    retentionDays: positiveNumberOr(
      obj.retentionDays,
      fallback.retentionDays,
      issues,
      "executionProfile.signalFeed.retentionDays",
    ).value,
    minSamplesForSnapshot: positiveNumberOr(
      obj.minSamplesForSnapshot,
      fallback.minSamplesForSnapshot,
      issues,
      "executionProfile.signalFeed.minSamplesForSnapshot",
    ).value,
    minSamplesForRecovery60: positiveNumberOr(
      obj.minSamplesForRecovery60,
      fallback.minSamplesForRecovery60,
      issues,
      "executionProfile.signalFeed.minSamplesForRecovery60",
    ).value,
    minWarmBucketsForTradeCount: positiveNumberOr(
      obj.minWarmBucketsForTradeCount,
      fallback.minWarmBucketsForTradeCount,
      issues,
      "executionProfile.signalFeed.minWarmBucketsForTradeCount",
    ).value,
    flushHotToWarmIntervalMs: positiveNumberOr(
      obj.flushHotToWarmIntervalMs,
      fallback.flushHotToWarmIntervalMs,
      issues,
      "executionProfile.signalFeed.flushHotToWarmIntervalMs",
    ).value,
    flushWarmToColdIntervalMs: positiveNumberOr(
      obj.flushWarmToColdIntervalMs,
      fallback.flushWarmToColdIntervalMs,
      issues,
      "executionProfile.signalFeed.flushWarmToColdIntervalMs",
    ).value,
    maintenanceIntervalMs: positiveNumberOr(
      obj.maintenanceIntervalMs,
      fallback.maintenanceIntervalMs,
      issues,
      "executionProfile.signalFeed.maintenanceIntervalMs",
    ).value,
  };
}

function parseExecutionProfileProfiles(
  raw: unknown,
  issues: string[],
): ExecutionProfileProfilesPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("executionProfile.profiles must be an object");
    return DEFAULT_EXECUTION_PROFILE_POLICY.profiles;
  }
  const obj = raw as Record<string, unknown>;
  return {
    cheap: parseExecutionProfileProfile(
      obj.cheap,
      DEFAULT_EXECUTION_PROFILE_POLICY.profiles.cheap,
      issues,
      "executionProfile.profiles.cheap",
    ),
    medium: parseExecutionProfileProfile(
      obj.medium,
      DEFAULT_EXECUTION_PROFILE_POLICY.profiles.medium,
      issues,
      "executionProfile.profiles.medium",
    ),
    expensive: parseExecutionProfileProfile(
      obj.expensive,
      DEFAULT_EXECUTION_PROFILE_POLICY.profiles.expensive,
      issues,
      "executionProfile.profiles.expensive",
    ),
  };
}

function parseExecutionProfileProfile(
  raw: unknown,
  fallback: ExecutionProfileProfilesPolicy["cheap"],
  issues: string[],
  name: string,
): ExecutionProfileProfilesPolicy["cheap"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push(`${name} must be an object`);
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  return {
    costCaps: parseExecutionProfileCostCapProfile(
      obj.costCaps,
      fallback.costCaps,
      issues,
      `${name}.costCaps`,
    ),
    scaleIn: parseExecutionProfileScaleInProfile(
      obj.scaleIn,
      fallback.scaleIn,
      issues,
      `${name}.scaleIn`,
    ),
  };
}

function parseExecutionProfileScaleInProfile(
  raw: unknown,
  fallback: ExecutionProfileScaleInProfilePolicy,
  issues: string[],
  name: string,
): ExecutionProfileScaleInProfilePolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push(`${name} must be an object`);
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  const sizingDecay = scaleInSizingDecayOr(
    obj.sizingDecay,
    fallback.sizingDecay,
    issues,
    `${name}.sizingDecay`,
  );
  if (!sizingDecay.valid) return fallback;
  return {
    initialProbeSizeUsd: positiveNumberOr(
      obj.initialProbeSizeUsd,
      fallback.initialProbeSizeUsd,
      issues,
      `${name}.initialProbeSizeUsd`,
    ).value,
    sizingDecay: sizingDecay.value,
    minTimeBetweenAddsMs: nonNegativeNumberOr(
      obj.minTimeBetweenAddsMs,
      fallback.minTimeBetweenAddsMs,
      issues,
      `${name}.minTimeBetweenAddsMs`,
    ).value,
    minAddNotionalUsd: positiveNumberOr(
      obj.minAddNotionalUsd,
      fallback.minAddNotionalUsd,
      issues,
      `${name}.minAddNotionalUsd`,
    ).value,
    modes: parseScaleInModes(obj.modes, fallback.modes, issues, `${name}.modes`),
    triggers: parseScaleInTriggers(obj.triggers, fallback.triggers, issues, `${name}.triggers`),
  };
}

function parseScaleInModes(
  raw: unknown,
  fallback: ExecutionProfileScaleInProfilePolicy["modes"],
  issues: string[],
  name: string,
): ExecutionProfileScaleInProfilePolicy["modes"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push(`${name} must be an object`);
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  return {
    up: parseScaleInMode(obj.up, fallback.up, issues, `${name}.up`),
    flat: parseScaleInMode(obj.flat, fallback.flat, issues, `${name}.flat`),
    avgDown: parseScaleInAvgDownMode(obj.avgDown, fallback.avgDown, issues, `${name}.avgDown`),
  };
}

function parseScaleInMode(
  raw: unknown,
  fallback: ExecutionProfileScaleInProfilePolicy["modes"]["up"],
  issues: string[],
  name: string,
): ExecutionProfileScaleInProfilePolicy["modes"]["up"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push(`${name} must be an object`);
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  return {
    thresholdPct: nonNegativeNumberOr(
      obj.thresholdPct,
      fallback.thresholdPct,
      issues,
      `${name}.thresholdPct`,
    ).value,
  };
}

function parseScaleInAvgDownMode(
  raw: unknown,
  fallback: ExecutionProfileScaleInProfilePolicy["modes"]["avgDown"],
  issues: string[],
  name: string,
): ExecutionProfileScaleInProfilePolicy["modes"]["avgDown"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push(`${name} must be an object`);
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(obj.enabled, fallback.enabled, issues, `${name}.enabled`),
    thresholdPct: nonNegativeNumberOr(
      obj.thresholdPct,
      fallback.thresholdPct,
      issues,
      `${name}.thresholdPct`,
    ).value,
    requireRecovery: booleanOr(
      obj.requireRecovery,
      fallback.requireRecovery,
      issues,
      `${name}.requireRecovery`,
    ),
    recoveryThreshold: nonNegativeNumberOr(
      obj.recoveryThreshold,
      fallback.recoveryThreshold,
      issues,
      `${name}.recoveryThreshold`,
    ).value,
  };
}

function parseScaleInTriggers(
  raw: unknown,
  fallback: ExecutionProfileScaleInProfilePolicy["triggers"],
  issues: string[],
  name: string,
): ExecutionProfileScaleInProfilePolicy["triggers"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push(`${name} must be an object`);
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  const activity = objectOr(obj.activity);
  const recovery = objectOr(obj.recovery);
  const volatility = objectOr(obj.volatility);
  const strongActivity = objectOr(obj.strongActivity);
  return {
    activity: {
      tradeCount3hThreshold: nonNegativeNumberOr(
        activity?.tradeCount3hThreshold,
        fallback.activity.tradeCount3hThreshold,
        issues,
        `${name}.activity.tradeCount3hThreshold`,
      ).value,
    },
    recovery: {
      threshold: nonNegativeNumberOr(
        recovery?.threshold,
        fallback.recovery.threshold,
        issues,
        `${name}.recovery.threshold`,
      ).value,
      strongThreshold: nonNegativeNumberOr(
        recovery?.strongThreshold,
        fallback.recovery.strongThreshold,
        issues,
        `${name}.recovery.strongThreshold`,
      ).value,
      strongActivityRecoveryFloor: positiveNumberOr(
        recovery?.strongActivityRecoveryFloor,
        fallback.recovery.strongActivityRecoveryFloor,
        issues,
        `${name}.recovery.strongActivityRecoveryFloor`,
      ).value,
    },
    volatility: {
      range60Threshold: nonNegativeNumberOr(
        volatility?.range60Threshold,
        fallback.volatility.range60Threshold,
        issues,
        `${name}.volatility.range60Threshold`,
      ).value,
      std60Threshold: nonNegativeNumberOr(
        volatility?.std60Threshold,
        fallback.volatility.std60Threshold,
        issues,
        `${name}.volatility.std60Threshold`,
      ).value,
    },
    strongActivity: {
      tradeCount3hThreshold: nonNegativeNumberOr(
        strongActivity?.tradeCount3hThreshold,
        fallback.strongActivity.tradeCount3hThreshold,
        issues,
        `${name}.strongActivity.tradeCount3hThreshold`,
      ).value,
    },
  };
}

function parseExecutionProfileCostCapProfile(
  raw: unknown,
  fallback: ExecutionProfileCostCapProfilePolicy,
  issues: string[],
  name: string,
): ExecutionProfileCostCapProfilePolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push(`${name} must be an object`);
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  const normal = positiveNumberOr(
    obj.normalCapUsd,
    fallback.normalCapUsd,
    issues,
    `${name}.normalCapUsd`,
  );
  const aggressive = positiveNumberOr(
    obj.aggressiveCapUsd,
    fallback.aggressiveCapUsd,
    issues,
    `${name}.aggressiveCapUsd`,
  );
  if (!normal.valid || !aggressive.valid || aggressive.value <= normal.value) {
    if (normal.valid && aggressive.valid) {
      issues.push(`${name}.aggressiveCapUsd must be greater than ${name}.normalCapUsd`);
    }
    return fallback;
  }
  return {
    normalCapUsd: normal.value,
    aggressiveCapUsd: aggressive.value,
    hardCapAtAggressive: booleanOr(
      obj.hardCapAtAggressive,
      fallback.hardCapAtAggressive,
      issues,
      `${name}.hardCapAtAggressive`,
    ),
  };
}

function parseExecutionProfileHysteresis(
  raw: unknown,
  issues: string[],
): ExecutionProfileHysteresisBounds {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("executionProfile.profileHysteresis must be an object");
    return DEFAULT_EXECUTION_PROFILE_POLICY.profileHysteresis;
  }
  const obj = raw as Record<string, unknown>;
  const parsed = {
    cheapMediumLow: clampedNumber(
      obj.cheapMediumLow,
      DEFAULT_EXECUTION_PROFILE_POLICY.profileHysteresis.cheapMediumLow,
      BOUND_EXECUTION_PROFILE_PRICE_MIN,
      BOUND_EXECUTION_PROFILE_PRICE_MAX,
      issues,
      "executionProfile.profileHysteresis.cheapMediumLow",
    ),
    cheapMediumHigh: clampedNumber(
      obj.cheapMediumHigh,
      DEFAULT_EXECUTION_PROFILE_POLICY.profileHysteresis.cheapMediumHigh,
      BOUND_EXECUTION_PROFILE_PRICE_MIN,
      BOUND_EXECUTION_PROFILE_PRICE_MAX,
      issues,
      "executionProfile.profileHysteresis.cheapMediumHigh",
    ),
    mediumExpensiveLow: clampedNumber(
      obj.mediumExpensiveLow,
      DEFAULT_EXECUTION_PROFILE_POLICY.profileHysteresis.mediumExpensiveLow,
      BOUND_EXECUTION_PROFILE_PRICE_MIN,
      BOUND_EXECUTION_PROFILE_PRICE_MAX,
      issues,
      "executionProfile.profileHysteresis.mediumExpensiveLow",
    ),
    mediumExpensiveHigh: clampedNumber(
      obj.mediumExpensiveHigh,
      DEFAULT_EXECUTION_PROFILE_POLICY.profileHysteresis.mediumExpensiveHigh,
      BOUND_EXECUTION_PROFILE_PRICE_MIN,
      BOUND_EXECUTION_PROFILE_PRICE_MAX,
      issues,
      "executionProfile.profileHysteresis.mediumExpensiveHigh",
    ),
  };

  if (
    parsed.cheapMediumLow >= parsed.cheapMediumHigh ||
    parsed.mediumExpensiveLow >= parsed.mediumExpensiveHigh ||
    parsed.cheapMediumHigh >= parsed.mediumExpensiveLow
  ) {
    issues.push("executionProfile.profileHysteresis bounds must be ordered");
    return DEFAULT_EXECUTION_PROFILE_POLICY.profileHysteresis;
  }
  return parsed;
}

function parseTrackS1(raw: unknown, issues: string[]): TrackS1WalkingLadderPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("trackS1 must be an object");
    return DEFAULT_TRACK_S1_WALKING_LADDER_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  const markupRaw =
    obj.markupCeilings != null &&
    typeof obj.markupCeilings === "object" &&
    !Array.isArray(obj.markupCeilings)
      ? (obj.markupCeilings as Record<string, unknown>)
      : {};
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.enabled,
      issues,
      "trackS1.enabled",
    ),
    numTiers: clampedInt(
      obj.numTiers,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.numTiers,
      BOUND_TRACK_S1_NUM_TIERS_MIN,
      BOUND_TRACK_S1_NUM_TIERS_MAX,
      issues,
      "trackS1.numTiers",
    ),
    bottomTierMarkup: clampedNumber(
      obj.bottomTierMarkup,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.bottomTierMarkup,
      BOUND_TRACK_S1_MARKUP_MIN,
      BOUND_TRACK_S1_MARKUP_MAX,
      issues,
      "trackS1.bottomTierMarkup",
    ),
    volumeDistribution: normalizedNumberListOr(
      obj.volumeDistribution,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.volumeDistribution,
      issues,
      "trackS1.volumeDistribution",
    ),
    markupCeilings: {
      cheapMax: clampedNumber(
        markupRaw.cheapMax,
        DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.markupCeilings.cheapMax,
        BOUND_TRACK_S1_MARKUP_MIN,
        BOUND_TRACK_S1_MARKUP_MAX,
        issues,
        "trackS1.markupCeilings.cheapMax",
      ),
      midRange: clampedNumber(
        markupRaw.midRange,
        DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.markupCeilings.midRange,
        BOUND_TRACK_S1_MARKUP_MIN,
        BOUND_TRACK_S1_MARKUP_MAX,
        issues,
        "trackS1.markupCeilings.midRange",
      ),
    },
    handoffTimeToResolutionSeconds: clampedInt(
      obj.handoffTimeToResolutionSeconds,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.handoffTimeToResolutionSeconds,
      BOUND_TRACK_S1_SECONDS_MIN,
      BOUND_TRACK_S1_SECONDS_MAX,
      issues,
      "trackS1.handoffTimeToResolutionSeconds",
    ),
    handoffTimeoutSeconds: clampedInt(
      obj.handoffTimeoutSeconds,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.handoffTimeoutSeconds,
      BOUND_TRACK_S1_SECONDS_MIN,
      BOUND_TRACK_S1_SECONDS_MAX,
      issues,
      "trackS1.handoffTimeoutSeconds",
    ),
    phantomOwnershipReleaseSeconds: clampedInt(
      obj.phantomOwnershipReleaseSeconds,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.phantomOwnershipReleaseSeconds,
      BOUND_TRACK_S1_SECONDS_MIN,
      BOUND_TRACK_S1_SECONDS_MAX,
      issues,
      "trackS1.phantomOwnershipReleaseSeconds",
    ),
    maxOpenLadderTokens: clampedInt(
      obj.maxOpenLadderTokens,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.maxOpenLadderTokens,
      0,
      BOUND_TRACK_S1_OPEN_TOKENS_MAX,
      issues,
      "trackS1.maxOpenLadderTokens",
    ),
    s1MaxOrdersPerToken: clampedInt(
      obj.s1MaxOrdersPerToken,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.s1MaxOrdersPerToken,
      1,
      BOUND_CAPACITY_OPEN_ORDERS_MAX,
      issues,
      "trackS1.s1MaxOrdersPerToken",
    ),
    maxLadderReplacementsPerHour: clampedInt(
      obj.maxLadderReplacementsPerHour,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.maxLadderReplacementsPerHour,
      1,
      BOUND_TRACK_S1_REPLACEMENTS_MAX,
      issues,
      "trackS1.maxLadderReplacementsPerHour",
    ),
    cheapLongshotMaxAvgEntry: clampedNumber(
      obj.cheapLongshotMaxAvgEntry,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.cheapLongshotMaxAvgEntry,
      0.001,
      BOUND_TRACK_S1_ENTRY_MAX,
      issues,
      "trackS1.cheapLongshotMaxAvgEntry",
    ),
    thinSpreadTicks: clampedInt(
      obj.thinSpreadTicks,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.thinSpreadTicks,
      BOUND_SPREAD_TICKS_MIN,
      BOUND_SPREAD_TICKS_MAX,
      issues,
      "trackS1.thinSpreadTicks",
    ),
    bestBidDepthRatio: clampedNumber(
      obj.bestBidDepthRatio,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.bestBidDepthRatio,
      BOUND_TRACK_S1_RATIO_MIN,
      BOUND_TRACK_S1_RATIO_MAX,
      issues,
      "trackS1.bestBidDepthRatio",
    ),
    bottomRepriceBidMovePct: clampedNumber(
      obj.bottomRepriceBidMovePct,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.bottomRepriceBidMovePct,
      BOUND_TRACK_S1_RATIO_MIN,
      BOUND_TRACK_S1_RATIO_MAX,
      issues,
      "trackS1.bottomRepriceBidMovePct",
    ),
    minBestBid: clampedNumber(
      obj.minBestBid,
      DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.minBestBid,
      0,
      0.1,
      issues,
      "trackS1.minBestBid",
    ),
  };
}

function parseRepriceOnOutbid(raw: unknown, issues: string[]): RepriceOnOutbidPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("repriceOnOutbid must be an object");
    return DEFAULT_REPRICE_ON_OUTBID_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_REPRICE_ON_OUTBID_POLICY.enabled,
      issues,
      "repriceOnOutbid.enabled",
    ),
    maxRepriceCount: clampedInt(
      obj.maxRepriceCount,
      DEFAULT_REPRICE_ON_OUTBID_POLICY.maxRepriceCount,
      0,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "repriceOnOutbid.maxRepriceCount",
    ),
  };
}

function parseExitRepriceOnDownprice(raw: unknown, issues: string[]): ExitRepriceOnDownpricePolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("exitRepriceOnDownprice must be an object");
    return DEFAULT_EXIT_REPRICE_ON_DOWNPRICE_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_EXIT_REPRICE_ON_DOWNPRICE_POLICY.enabled,
      issues,
      "exitRepriceOnDownprice.enabled",
    ),
    thresholdTicks: clampedInt(
      obj.thresholdTicks,
      DEFAULT_EXIT_REPRICE_ON_DOWNPRICE_POLICY.thresholdTicks,
      0,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "exitRepriceOnDownprice.thresholdTicks",
    ),
    maxRepricesPerOrder: clampedInt(
      obj.maxRepricesPerOrder,
      DEFAULT_EXIT_REPRICE_ON_DOWNPRICE_POLICY.maxRepricesPerOrder,
      0,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "exitRepriceOnDownprice.maxRepricesPerOrder",
    ),
    stuckWarningEnabled: booleanOr(
      obj.stuckWarningEnabled,
      DEFAULT_EXIT_REPRICE_ON_DOWNPRICE_POLICY.stuckWarningEnabled,
      issues,
      "exitRepriceOnDownprice.stuckWarningEnabled",
    ),
    stuckWarningAgeMs: lifetimeMs(
      obj.stuckWarningAgeMs,
      DEFAULT_EXIT_REPRICE_ON_DOWNPRICE_POLICY.stuckWarningAgeMs,
      "exitRepriceOnDownprice.stuckWarningAgeMs",
      issues,
    ),
    stuckWarningGapPct: clampedNumber(
      obj.stuckWarningGapPct,
      DEFAULT_EXIT_REPRICE_ON_DOWNPRICE_POLICY.stuckWarningGapPct,
      BOUND_STUCK_WARNING_GAP_PCT_MIN,
      BOUND_STUCK_WARNING_GAP_PCT_MAX,
      issues,
      "exitRepriceOnDownprice.stuckWarningGapPct",
    ),
  };
}

function parseDropTrigger(raw: unknown, issues: string[]): DropTriggerPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("dropTrigger must be an object");
    return DEFAULT_DROP_TRIGGER_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_DROP_TRIGGER_POLICY.enabled,
      issues,
      "dropTrigger.enabled",
    ),
    failOpenOnNoData: booleanOr(
      obj.failOpenOnNoData,
      DEFAULT_DROP_TRIGGER_POLICY.failOpenOnNoData,
      issues,
      "dropTrigger.failOpenOnNoData",
    ),
    thresholdPct: clampedNumber(
      obj.thresholdPct,
      DEFAULT_DROP_TRIGGER_POLICY.thresholdPct,
      BOUND_DROP_TRIGGER_THRESHOLD_MIN,
      BOUND_DROP_TRIGGER_THRESHOLD_MAX,
      issues,
      "dropTrigger.thresholdPct",
    ),
    lookbackMs: lifetimeMs(
      obj.lookbackMs,
      DEFAULT_DROP_TRIGGER_POLICY.lookbackMs,
      "dropTrigger.lookbackMs",
      issues,
    ),
    historyMaxAgeMs: lifetimeMs(
      obj.historyMaxAgeMs,
      DEFAULT_DROP_TRIGGER_POLICY.historyMaxAgeMs,
      "dropTrigger.historyMaxAgeMs",
      issues,
    ),
  };
}

function parseR23DipTrigger(raw: unknown, issues: string[]): R23DipTriggerPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("r23DipTrigger must be an object");
    return DEFAULT_R23_DIP_TRIGGER_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_R23_DIP_TRIGGER_POLICY.enabled,
      issues,
      "r23DipTrigger.enabled",
    ),
    dropThresholdRatio: clampedNumber(
      obj.dropThresholdRatio,
      DEFAULT_R23_DIP_TRIGGER_POLICY.dropThresholdRatio,
      BOUND_R23_DIP_TRIGGER_RATIO_MIN,
      BOUND_R23_DIP_TRIGGER_RATIO_MAX,
      issues,
      "r23DipTrigger.dropThresholdRatio",
    ),
    windowMs: lifetimeMs(
      obj.windowMs,
      DEFAULT_R23_DIP_TRIGGER_POLICY.windowMs,
      "r23DipTrigger.windowMs",
      issues,
    ),
  };
}

function parseMultiBuyLadder(raw: unknown, issues: string[]): MultiBuyLadderPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("multiBuyLadder must be an object");
    return DEFAULT_MULTI_BUY_LADDER_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_MULTI_BUY_LADDER_POLICY.enabled,
      issues,
      "multiBuyLadder.enabled",
    ),
    maxLadderFillsPerToken: clampedInt(
      obj.maxLadderFillsPerToken,
      DEFAULT_MULTI_BUY_LADDER_POLICY.maxLadderFillsPerToken,
      1,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "multiBuyLadder.maxLadderFillsPerToken",
    ),
    ladderGapMs: lifetimeMs(
      obj.ladderGapMs,
      DEFAULT_MULTI_BUY_LADDER_POLICY.ladderGapMs,
      "multiBuyLadder.ladderGapMs",
      issues,
    ),
    perTokenUsdcCap: clampedNumber(
      obj.perTokenUsdcCap,
      DEFAULT_MULTI_BUY_LADDER_POLICY.perTokenUsdcCap,
      0,
      BOUND_LADDER_USDC_CAP_MAX,
      issues,
      "multiBuyLadder.perTokenUsdcCap",
    ),
    maxPriceDriftTicks: clampedInt(
      obj.maxPriceDriftTicks,
      DEFAULT_MULTI_BUY_LADDER_POLICY.maxPriceDriftTicks,
      0,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "multiBuyLadder.maxPriceDriftTicks",
    ),
    minStepFillRate: clampedNumber(
      obj.minStepFillRate,
      DEFAULT_MULTI_BUY_LADDER_POLICY.minStepFillRate,
      BOUND_FILL_RATE_MIN,
      BOUND_FILL_RATE_MAX,
      issues,
      "multiBuyLadder.minStepFillRate",
    ),
  };
}

function parseRedeemSweep(raw: unknown, issues: string[]): RedeemSweepPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("redeemSweep must be an object");
    return DEFAULT_REDEEM_SWEEP_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_REDEEM_SWEEP_POLICY.enabled,
      issues,
      "redeemSweep.enabled",
    ),
    intervalMs: clampedInt(
      obj.intervalMs,
      DEFAULT_REDEEM_SWEEP_POLICY.intervalMs,
      BOUND_REDEEM_SWEEP_INTERVAL_MIN_MS,
      BOUND_REDEEM_SWEEP_INTERVAL_MAX_MS,
      issues,
      "redeemSweep.intervalMs",
    ),
    inFlightTtlMs: clampedInt(
      obj.inFlightTtlMs,
      DEFAULT_REDEEM_SWEEP_POLICY.inFlightTtlMs,
      BOUND_REDEEM_SWEEP_INTERVAL_MIN_MS,
      BOUND_REDEEM_SWEEP_INTERVAL_MAX_MS,
      issues,
      "redeemSweep.inFlightTtlMs",
    ),
    maxRetries: clampedInt(
      obj.maxRetries,
      DEFAULT_REDEEM_SWEEP_POLICY.maxRetries,
      0,
      BOUND_REDEEM_SWEEP_RETRY_COUNT_MAX,
      issues,
      "redeemSweep.maxRetries",
    ),
    retryBackoffMs: intListOr(
      obj.retryBackoffMs,
      DEFAULT_REDEEM_SWEEP_POLICY.retryBackoffMs,
      BOUND_REDEEM_SWEEP_INTERVAL_MIN_MS,
      BOUND_REDEEM_SWEEP_INTERVAL_MAX_MS,
      issues,
      "redeemSweep.retryBackoffMs",
    ),
    postRedeemVerifyDelayMs: clampedInt(
      obj.postRedeemVerifyDelayMs,
      DEFAULT_REDEEM_SWEEP_POLICY.postRedeemVerifyDelayMs,
      BOUND_REDEEM_SWEEP_INTERVAL_MIN_MS,
      BOUND_REDEEM_SWEEP_INTERVAL_MAX_MS,
      issues,
      "redeemSweep.postRedeemVerifyDelayMs",
    ),
    circuitBreakerEnabled: booleanOr(
      obj.circuitBreakerEnabled,
      DEFAULT_REDEEM_SWEEP_POLICY.circuitBreakerEnabled,
      issues,
      "redeemSweep.circuitBreakerEnabled",
    ),
    stateFailedQuarantineThreshold: clampedInt(
      obj.stateFailedQuarantineThreshold,
      DEFAULT_REDEEM_SWEEP_POLICY.stateFailedQuarantineThreshold,
      1,
      BOUND_REDEEM_STATE_FAILED_QUARANTINE_THRESHOLD_MAX,
      issues,
      "redeemSweep.stateFailedQuarantineThreshold",
    ),
    stateFailedQuarantineTtlHours: clampedInt(
      obj.stateFailedQuarantineTtlHours,
      DEFAULT_REDEEM_SWEEP_POLICY.stateFailedQuarantineTtlHours,
      1,
      BOUND_REDEEM_STATE_FAILED_QUARANTINE_TTL_HOURS_MAX,
      issues,
      "redeemSweep.stateFailedQuarantineTtlHours",
    ),
  };
}

function parseRaceProtection(raw: unknown, issues: string[]): RaceProtectionPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("raceProtection must be an object");
    return DEFAULT_RACE_PROTECTION_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  const redeemRaw = obj.redeemInFlight;
  if (redeemRaw == null || typeof redeemRaw !== "object" || Array.isArray(redeemRaw)) {
    if (redeemRaw !== undefined) issues.push("raceProtection.redeemInFlight must be an object");
    return DEFAULT_RACE_PROTECTION_POLICY;
  }
  const redeem = redeemRaw as Record<string, unknown>;
  return {
    redeemInFlight: {
      enabled: booleanOr(
        redeem.enabled,
        DEFAULT_RACE_PROTECTION_POLICY.redeemInFlight.enabled,
        issues,
        "raceProtection.redeemInFlight.enabled",
      ),
    },
  };
}

function parseBuyCapacity(raw: unknown, issues: string[]): BuyCapacityPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("buyCapacity must be an object");
    return DEFAULT_BUY_CAPACITY_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_BUY_CAPACITY_POLICY.enabled,
      issues,
      "buyCapacity.enabled",
    ),
    minNewEntryWalletHeadroomUsdc: clampedNumber(
      obj.minNewEntryWalletHeadroomUsdc,
      DEFAULT_BUY_CAPACITY_POLICY.minNewEntryWalletHeadroomUsdc,
      BOUND_BUY_CAPACITY_HEADROOM_MIN_USDC,
      BOUND_BUY_CAPACITY_HEADROOM_MAX_USDC,
      issues,
      "buyCapacity.minNewEntryWalletHeadroomUsdc",
    ),
    minAddWalletHeadroomUsdc: clampedNumber(
      obj.minAddWalletHeadroomUsdc,
      DEFAULT_BUY_CAPACITY_POLICY.minAddWalletHeadroomUsdc,
      BOUND_BUY_CAPACITY_HEADROOM_MIN_USDC,
      BOUND_BUY_CAPACITY_HEADROOM_MAX_USDC,
      issues,
      "buyCapacity.minAddWalletHeadroomUsdc",
    ),
    maxOpenBuyOrders: clampedInt(
      obj.maxOpenBuyOrders,
      DEFAULT_BUY_CAPACITY_POLICY.maxOpenBuyOrders,
      BOUND_CAPACITY_OPEN_ORDERS_MIN,
      BOUND_CAPACITY_OPEN_ORDERS_MAX,
      issues,
      "buyCapacity.maxOpenBuyOrders",
    ),
    maxOpenBuyOrdersPerToken: clampedInt(
      obj.maxOpenBuyOrdersPerToken,
      DEFAULT_BUY_CAPACITY_POLICY.maxOpenBuyOrdersPerToken,
      BOUND_CAPACITY_OPEN_ORDERS_MIN,
      BOUND_CAPACITY_OPEN_ORDERS_MAX,
      issues,
      "buyCapacity.maxOpenBuyOrdersPerToken",
    ),
  };
}

function parseSellCapacity(raw: unknown, issues: string[]): SellCapacityPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("sellCapacity must be an object");
    return DEFAULT_SELL_CAPACITY_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_SELL_CAPACITY_POLICY.enabled,
      issues,
      "sellCapacity.enabled",
    ),
    maxOpenSellOrders: clampedInt(
      obj.maxOpenSellOrders,
      DEFAULT_SELL_CAPACITY_POLICY.maxOpenSellOrders,
      BOUND_CAPACITY_OPEN_ORDERS_MIN,
      BOUND_CAPACITY_OPEN_ORDERS_MAX,
      issues,
      "sellCapacity.maxOpenSellOrders",
    ),
    maxOpenSellOrdersPerToken: clampedInt(
      obj.maxOpenSellOrdersPerToken,
      DEFAULT_SELL_CAPACITY_POLICY.maxOpenSellOrdersPerToken,
      BOUND_CAPACITY_OPEN_ORDERS_MIN,
      BOUND_CAPACITY_OPEN_ORDERS_MAX,
      issues,
      "sellCapacity.maxOpenSellOrdersPerToken",
    ),
  };
}

function parseOrderCapacity(raw: unknown, issues: string[]): OrderCapacityPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("orderCapacity must be an object");
    return DEFAULT_ORDER_CAPACITY_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_ORDER_CAPACITY_POLICY.enabled,
      issues,
      "orderCapacity.enabled",
    ),
    maxOpenOrdersTotal: clampedInt(
      obj.maxOpenOrdersTotal,
      DEFAULT_ORDER_CAPACITY_POLICY.maxOpenOrdersTotal,
      BOUND_CAPACITY_OPEN_ORDERS_MIN,
      BOUND_CAPACITY_OPEN_ORDERS_MAX,
      issues,
      "orderCapacity.maxOpenOrdersTotal",
    ),
  };
}

function parseMarketSelection(raw: unknown, issues: string[]): MarketSelectionPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("marketSelection must be an object");
    return DEFAULT_MARKET_SELECTION_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    maxMidPrice: clampedNumber(
      obj.maxMidPrice,
      DEFAULT_MARKET_SELECTION_POLICY.maxMidPrice,
      BOUND_MARKET_SELECTION_MAX_MID_MIN,
      BOUND_MARKET_SELECTION_MAX_MID_MAX,
      issues,
      "marketSelection.maxMidPrice",
    ),
    minLiquidity: clampedNumber(
      obj.minLiquidity,
      DEFAULT_MARKET_SELECTION_POLICY.minLiquidity,
      BOUND_MARKET_SELECTION_MIN_LIQUIDITY_MIN,
      BOUND_MARKET_SELECTION_MIN_LIQUIDITY_MAX,
      issues,
      "marketSelection.minLiquidity",
    ),
    shortLifetime: parseBuyGuardShortLifetime(obj.shortLifetime, issues),
  };
}

function parseBuyGuardShortLifetime(raw: unknown, issues: string[]): BuyGuardShortLifetimePolicy {
  const defaults = DEFAULT_MARKET_SELECTION_POLICY.shortLifetime!;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("marketSelection.shortLifetime must be an object");
    return defaults;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      defaults.enabled,
      issues,
      "marketSelection.shortLifetime.enabled",
    ),
    thresholdHours: clampedNumber(
      obj.thresholdHours,
      defaults.thresholdHours,
      BOUND_BUY_GUARD_SHORT_LIFETIME_MIN_HOURS,
      BOUND_BUY_GUARD_SHORT_LIFETIME_MAX_HOURS,
      issues,
      "marketSelection.shortLifetime.thresholdHours",
    ),
  };
}

function parseDeadSideGuard(raw: unknown, issues: string[]): DeadSideGuardPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("deadSideGuard must be an object");
    return DEFAULT_DEAD_SIDE_GUARD;
  }
  const obj = raw as Record<string, unknown>;
  const mode = enumOr(
    obj.mode,
    DEAD_SIDE_MODES,
    DEFAULT_DEAD_SIDE_GUARD.mode,
    issues,
    "deadSideGuard.mode",
  );
  const askCeiling = clampedNumber(
    obj.askCeiling,
    DEFAULT_DEAD_SIDE_GUARD.askCeiling,
    Number.MIN_VALUE,
    BOUND_ASK_CEILING_MAX,
    issues,
    "deadSideGuard.askCeiling",
  );
  const maxTimeToEndMs = clampedInt(
    obj.maxTimeToEndMs,
    DEFAULT_DEAD_SIDE_GUARD.maxTimeToEndMs,
    BOUND_MAX_TIME_TO_END_MIN_MS,
    BOUND_MAX_TIME_TO_END_MAX_MS,
    issues,
    "deadSideGuard.maxTimeToEndMs",
  );
  return { mode, askCeiling, maxTimeToEndMs };
}

function parsePricing(raw: unknown, issues: string[]): ExecutionPricingPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("pricing must be an object");
    return DEFAULT_PRICING_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    mode: enumOr(obj.mode, PRICING_MODES, DEFAULT_PRICING_POLICY.mode, issues, "pricing.mode"),
    maxEntrySpreadTicks: clampedInt(
      obj.maxEntrySpreadTicks,
      DEFAULT_PRICING_POLICY.maxEntrySpreadTicks,
      BOUND_SPREAD_TICKS_MIN,
      BOUND_SPREAD_TICKS_MAX,
      issues,
      "pricing.maxEntrySpreadTicks",
    ),
    maxExitSpreadTicks: clampedInt(
      obj.maxExitSpreadTicks,
      DEFAULT_PRICING_POLICY.maxExitSpreadTicks,
      BOUND_SPREAD_TICKS_MIN,
      BOUND_SPREAD_TICKS_MAX,
      issues,
      "pricing.maxExitSpreadTicks",
    ),
    maxImprovementTicks: clampedInt(
      obj.maxImprovementTicks,
      DEFAULT_PRICING_POLICY.maxImprovementTicks,
      BOUND_IMPROVEMENT_TICKS_MIN,
      BOUND_IMPROVEMENT_TICKS_MAX,
      issues,
      "pricing.maxImprovementTicks",
    ),
    minExitPriceSignalRatio: clampedNumber(
      obj.minExitPriceSignalRatio,
      DEFAULT_PRICING_POLICY.minExitPriceSignalRatio,
      BOUND_MIN_EXIT_SIGNAL_RATIO_MIN,
      BOUND_MIN_EXIT_SIGNAL_RATIO_MAX,
      issues,
      "pricing.minExitPriceSignalRatio",
    ),
    wideSpreadPolicy: enumOr(
      obj.wideSpreadPolicy,
      BINARY_PRICING_POLICIES,
      DEFAULT_PRICING_POLICY.wideSpreadPolicy,
      issues,
      "pricing.wideSpreadPolicy",
    ),
    oneSidedPolicy: enumOr(
      obj.oneSidedPolicy,
      BINARY_PRICING_POLICIES,
      DEFAULT_PRICING_POLICY.oneSidedPolicy,
      issues,
      "pricing.oneSidedPolicy",
    ),
  };
}

function parseOrderLifetime(raw: unknown, issues: string[]): OrderLifetimePolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("orderLifetime must be an object");
    return DEFAULT_ORDER_LIFETIME_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_ORDER_LIFETIME_POLICY.enabled,
      issues,
      "orderLifetime.enabled",
    ),
    enforcement: enumOr(
      obj.enforcement,
      ORDER_LIFETIME_ENFORCEMENT_MODES,
      DEFAULT_ORDER_LIFETIME_POLICY.enforcement,
      issues,
      "orderLifetime.enforcement",
    ),
    staleResetMs: lifetimeMs(
      obj.staleResetMs,
      DEFAULT_ORDER_LIFETIME_POLICY.staleResetMs,
      "orderLifetime.staleResetMs",
      issues,
    ),
    safetyBufferMs: lifetimeMs(
      obj.safetyBufferMs,
      DEFAULT_ORDER_LIFETIME_POLICY.safetyBufferMs,
      "orderLifetime.safetyBufferMs",
      issues,
    ),
    resolutionAggressiveWindowMs: lifetimeMs(
      obj.resolutionAggressiveWindowMs,
      DEFAULT_ORDER_LIFETIME_POLICY.resolutionAggressiveWindowMs,
      "orderLifetime.resolutionAggressiveWindowMs",
      issues,
    ),
    resolutionStopWindowMs: lifetimeMs(
      obj.resolutionStopWindowMs,
      DEFAULT_ORDER_LIFETIME_POLICY.resolutionStopWindowMs,
      "orderLifetime.resolutionStopWindowMs",
      issues,
    ),
    resolutionExitTtlCapMs: lifetimeMs(
      obj.resolutionExitTtlCapMs,
      DEFAULT_ORDER_LIFETIME_POLICY.resolutionExitTtlCapMs,
      "orderLifetime.resolutionExitTtlCapMs",
      issues,
    ),
    relayerSubmitBudgetPerMinute: clampedInt(
      obj.relayerSubmitBudgetPerMinute,
      DEFAULT_ORDER_LIFETIME_POLICY.relayerSubmitBudgetPerMinute,
      1,
      1_000,
      issues,
      "orderLifetime.relayerSubmitBudgetPerMinute",
    ),
    maxTransitionEventsPerTokenPerDay: clampedInt(
      obj.maxTransitionEventsPerTokenPerDay,
      DEFAULT_ORDER_LIFETIME_POLICY.maxTransitionEventsPerTokenPerDay,
      1,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "orderLifetime.maxTransitionEventsPerTokenPerDay",
    ),
    oscillationTransitionLimitPerDay: clampedInt(
      obj.oscillationTransitionLimitPerDay,
      DEFAULT_ORDER_LIFETIME_POLICY.oscillationTransitionLimitPerDay,
      1,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "orderLifetime.oscillationTransitionLimitPerDay",
    ),
    burst: parseBurstOrderLifetime(obj.burst, issues),
    middle: parseMiddleOrderLifetime(obj.middle, issues),
    passive: parsePassiveOrderLifetime(obj.passive, issues),
  };
}

function parseBurstOrderLifetime(raw: unknown, issues: string[]): OrderLifetimePolicy["burst"] {
  const fallback = DEFAULT_ORDER_LIFETIME_POLICY.burst;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("orderLifetime.burst must be an object");
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  return {
    candidateFirstFillLatencyMs: lifetimeMs(
      obj.candidateFirstFillLatencyMs,
      fallback.candidateFirstFillLatencyMs,
      "orderLifetime.burst.candidateFirstFillLatencyMs",
      issues,
    ),
    confirmSpanMs: lifetimeMs(
      obj.confirmSpanMs,
      fallback.confirmSpanMs,
      "orderLifetime.burst.confirmSpanMs",
      issues,
    ),
    confirmMedianGapMs: lifetimeMs(
      obj.confirmMedianGapMs,
      fallback.confirmMedianGapMs,
      "orderLifetime.burst.confirmMedianGapMs",
      issues,
    ),
    confirmFirstFillLatencyMs: lifetimeMs(
      obj.confirmFirstFillLatencyMs,
      fallback.confirmFirstFillLatencyMs,
      "orderLifetime.burst.confirmFirstFillLatencyMs",
      issues,
    ),
    confirmP75GapMs: lifetimeMs(
      obj.confirmP75GapMs,
      fallback.confirmP75GapMs,
      "orderLifetime.burst.confirmP75GapMs",
      issues,
    ),
    confirmMaxSpanMs: lifetimeMs(
      obj.confirmMaxSpanMs,
      fallback.confirmMaxSpanMs,
      "orderLifetime.burst.confirmMaxSpanMs",
      issues,
    ),
    lowTtlMs: lifetimeMs(obj.lowTtlMs, fallback.lowTtlMs, "orderLifetime.burst.lowTtlMs", issues),
    mediumTtlMs: lifetimeMs(
      obj.mediumTtlMs,
      fallback.mediumTtlMs,
      "orderLifetime.burst.mediumTtlMs",
      issues,
    ),
    highTtlMs: lifetimeMs(
      obj.highTtlMs,
      fallback.highTtlMs,
      "orderLifetime.burst.highTtlMs",
      issues,
    ),
  };
}

function parseMiddleOrderLifetime(raw: unknown, issues: string[]): OrderLifetimePolicy["middle"] {
  const fallback = DEFAULT_ORDER_LIFETIME_POLICY.middle;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("orderLifetime.middle must be an object");
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  return {
    minMedianGapMs: lifetimeMs(
      obj.minMedianGapMs,
      fallback.minMedianGapMs,
      "orderLifetime.middle.minMedianGapMs",
      issues,
    ),
    maxMedianGapMs: lifetimeMs(
      obj.maxMedianGapMs,
      fallback.maxMedianGapMs,
      "orderLifetime.middle.maxMedianGapMs",
      issues,
    ),
    maxSpanMs: lifetimeMs(
      obj.maxSpanMs,
      fallback.maxSpanMs,
      "orderLifetime.middle.maxSpanMs",
      issues,
    ),
    lowTtlMs: lifetimeMs(obj.lowTtlMs, fallback.lowTtlMs, "orderLifetime.middle.lowTtlMs", issues),
    mediumTtlMs: lifetimeMs(
      obj.mediumTtlMs,
      fallback.mediumTtlMs,
      "orderLifetime.middle.mediumTtlMs",
      issues,
    ),
    highTtlMs: lifetimeMs(
      obj.highTtlMs,
      fallback.highTtlMs,
      "orderLifetime.middle.highTtlMs",
      issues,
    ),
  };
}

function parsePassiveOrderLifetime(raw: unknown, issues: string[]): OrderLifetimePolicy["passive"] {
  const fallback = DEFAULT_ORDER_LIFETIME_POLICY.passive;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("orderLifetime.passive must be an object");
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  return {
    lowTtlMs: lifetimeMs(obj.lowTtlMs, fallback.lowTtlMs, "orderLifetime.passive.lowTtlMs", issues),
    mediumTtlMs: lifetimeMs(
      obj.mediumTtlMs,
      fallback.mediumTtlMs,
      "orderLifetime.passive.mediumTtlMs",
      issues,
    ),
    highTtlMs: lifetimeMs(
      obj.highTtlMs,
      fallback.highTtlMs,
      "orderLifetime.passive.highTtlMs",
      issues,
    ),
    highConfidenceMinFills: clampedInt(
      obj.highConfidenceMinFills,
      fallback.highConfidenceMinFills,
      1,
      BOUND_ORDER_LIFETIME_COUNT_MAX,
      issues,
      "orderLifetime.passive.highConfidenceMinFills",
    ),
    highConfidenceMinSpanMs: lifetimeMs(
      obj.highConfidenceMinSpanMs,
      fallback.highConfidenceMinSpanMs,
      "orderLifetime.passive.highConfidenceMinSpanMs",
      issues,
    ),
  };
}

function lifetimeMs(raw: unknown, fallback: number, name: string, issues: string[]): number {
  return clampedInt(
    raw,
    fallback,
    BOUND_ORDER_LIFETIME_MIN_MS,
    BOUND_ORDER_LIFETIME_MAX_MS,
    issues,
    name,
  );
}

function parseTelemetry(raw: unknown, issues: string[]): ExecutionPolicyTelemetry {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("telemetry must be an object");
    return DEFAULT_TELEMETRY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    deadSideCanary: booleanOr(
      obj.deadSideCanary,
      DEFAULT_TELEMETRY.deadSideCanary,
      issues,
      "telemetry.deadSideCanary",
    ),
    pricingShadow: booleanOr(
      obj.pricingShadow,
      DEFAULT_TELEMETRY.pricingShadow,
      issues,
      "telemetry.pricingShadow",
    ),
  };
}

function numberOr(raw: unknown, fallback: number, issues: string[], name: string): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    issues.push(`${name} must be a finite number`);
    return fallback;
  }
  return raw;
}

function nonEmptyStringOr(raw: unknown, fallback: string, issues: string[], name: string): string {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    issues.push(`${name} must be a non-empty string`);
    return fallback;
  }
  return raw;
}

function requiredNonEmptyString(raw: unknown, issues: string[], name: string): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    issues.push(`${name} must be a non-empty string`);
    return null;
  }
  return raw;
}

function nullableStringOr(raw: unknown, issues: string[], name: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    issues.push(`${name} must be null or a non-empty string`);
    return null;
  }
  return raw;
}

function positiveNumberOr(
  raw: unknown,
  fallback: number,
  issues: string[],
  name: string,
): { value: number; valid: boolean } {
  if (raw === undefined) return { value: fallback, valid: true };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    issues.push(`${name} must be a finite number`);
    return { value: fallback, valid: false };
  }
  if (raw <= 0) {
    issues.push(`${name} must be > 0`);
    return { value: fallback, valid: false };
  }
  return { value: raw, valid: true };
}

function nonNegativeNumberOr(
  raw: unknown,
  fallback: number,
  issues: string[],
  name: string,
): { value: number; valid: boolean } {
  if (raw === undefined) return { value: fallback, valid: true };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    issues.push(`${name} must be a finite number`);
    return { value: fallback, valid: false };
  }
  if (raw < 0) {
    issues.push(`${name} must be >= 0`);
    return { value: fallback, valid: false };
  }
  return { value: raw, valid: true };
}

function nullableNonNegativeNumberOr(
  raw: unknown,
  fallback: number | null,
  issues: string[],
  name: string,
): { value: number | null; valid: boolean } {
  if (raw === undefined) return { value: fallback, valid: true };
  if (raw === null) return { value: null, valid: true };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    issues.push(`${name} must be null or a finite number`);
    return { value: fallback, valid: false };
  }
  if (raw < 0) {
    issues.push(`${name} must be >= 0`);
    return { value: fallback, valid: false };
  }
  return { value: raw, valid: true };
}

function positiveNumberArrayOr(
  raw: unknown,
  fallback: readonly number[],
  issues: string[],
  name: string,
): { value: readonly number[]; valid: boolean } {
  if (raw === undefined) return { value: fallback, valid: true };
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)
  ) {
    issues.push(`${name} must be a non-empty array of positive finite numbers`);
    return { value: fallback, valid: false };
  }
  return { value: [...raw], valid: true };
}

function scaleInSizingDecayOr(
  raw: unknown,
  fallback: readonly number[],
  issues: string[],
  name: string,
): { value: readonly number[]; valid: boolean } {
  if (raw === undefined) return { value: fallback, valid: true };
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)
  ) {
    issues.push(`${name} must be a non-empty array of positive finite numbers`);
    return { value: fallback, valid: false };
  }
  return { value: [...raw], valid: true };
}

function objectOr(raw: unknown): Record<string, unknown> | null {
  return raw != null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function clampedNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  issues: string[],
  name: string,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    issues.push(`${name} must be a finite number`);
    return fallback;
  }
  if (raw < min || raw > max) {
    issues.push(`${name}=${raw} out of range [${min}, ${max}]`);
    return fallback;
  }
  return raw;
}

function nullableClampedNumber(
  raw: unknown,
  fallback: number | null,
  min: number,
  max: number,
  issues: string[],
  name: string,
): number | null {
  if (raw === undefined) return fallback;
  if (raw === null) return null;
  return clampedNumber(raw, fallback ?? min, min, max, issues, name);
}

function clampedInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  issues: string[],
  name: string,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    issues.push(`${name} must be a finite integer`);
    return fallback;
  }
  if (raw < min || raw > max) {
    issues.push(`${name}=${raw} out of range [${min}, ${max}]`);
    return fallback;
  }
  return raw;
}

function nullableClampedInt(
  raw: unknown,
  fallback: number | null,
  min: number,
  max: number,
  issues: string[],
  name: string,
): number | null {
  if (raw === undefined) return fallback;
  if (raw === null) return null;
  return clampedInt(raw, fallback ?? min, min, max, issues, name);
}

function enumOr<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
  issues: string[],
  name: string,
): T {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    issues.push(`${name}=${String(raw)} not in [${allowed.join(",")}]`);
    return fallback;
  }
  return raw as T;
}

function booleanOr(raw: unknown, fallback: boolean, issues: string[], name: string): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== "boolean") {
    issues.push(`${name} must be boolean`);
    return fallback;
  }
  return raw;
}

function takerAtProfitRulesOr(
  raw: unknown,
  fallback: TakerAtProfitPolicy["rules"],
  issues: string[],
  name: string,
): TakerAtProfitPolicy["rules"] {
  if (raw === undefined) return fallback;
  if (raw === "all-sell") return "all-sell";
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push(`${name} must be "all-sell" or a non-empty string array`);
    return fallback;
  }
  const rules: string[] = [];
  for (const rule of raw) {
    if (typeof rule !== "string" || rule.trim().length === 0) {
      issues.push(`${name} must contain only non-empty strings`);
      return fallback;
    }
    const trimmed = rule.trim();
    if (!rules.includes(trimmed)) rules.push(trimmed);
  }
  return rules;
}

function algoStateListOr(
  raw: unknown,
  fallback: readonly AlgoState[],
  issues: string[],
  name: string,
): readonly AlgoState[] {
  if (raw === undefined) return fallback;
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push(`${name} must be a non-empty state array`);
    return fallback;
  }
  const states: AlgoState[] = [];
  for (const state of raw) {
    if (typeof state !== "string" || !(ALGO_STATES as readonly string[]).includes(state)) {
      issues.push(`${name} contains invalid state ${String(state)}`);
      return fallback;
    }
    if (!states.includes(state as AlgoState)) states.push(state as AlgoState);
  }
  return states;
}

function intListOr(
  raw: unknown,
  fallback: number[],
  min: number,
  max: number,
  issues: string[],
  name: string,
): number[] {
  if (raw === undefined) return fallback;
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push(`${name} must be a non-empty integer array`);
    return fallback;
  }
  const parsed: number[] = [];
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
      issues.push(`${name} must contain only finite integers`);
      return fallback;
    }
    if (value < min || value > max) {
      issues.push(`${name} contains ${value} outside [${min}, ${max}]`);
      return fallback;
    }
    parsed.push(value);
  }
  return parsed;
}

function normalizedNumberListOr(
  raw: unknown,
  fallback: readonly number[],
  issues: string[],
  name: string,
): number[] {
  if (raw === undefined) return [...fallback];
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push(`${name} must be a non-empty number array`);
    return [...fallback];
  }
  const values: number[] = [];
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      issues.push(`${name} must contain only positive finite numbers`);
      return [...fallback];
    }
    values.push(value);
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return values.map((value) => value / sum);
}

function parseDepositActivation(raw: unknown, issues: string[]): DepositActivationPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("depositActivation must be an object");
    return DEFAULT_DEPOSIT_ACTIVATION_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: booleanOr(
      obj.enabled,
      DEFAULT_DEPOSIT_ACTIVATION_POLICY.enabled,
      issues,
      "depositActivation.enabled",
    ),
    minAmountUsdcCents: clampedInt(
      obj.minAmountUsdcCents,
      DEFAULT_DEPOSIT_ACTIVATION_POLICY.minAmountUsdcCents,
      0,
      1_000_000_00,
      issues,
      "depositActivation.minAmountUsdcCents",
    ),
  };
}

/** Serialize an ExecutionPolicy back to the compact JSON used by the DB. */
export function serializeExecutionPolicy(policy: ExecutionPolicy): string {
  return JSON.stringify(policy);
}

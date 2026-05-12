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
  DeadSideGuardPolicy,
  ExecutionPolicy,
  ExecutionPricingPolicy,
  ExecutionPolicyTelemetry,
  DropTriggerPolicy,
  MarketSelectionPolicy,
  OrderCapacityPolicy,
  OrderLifetimePolicy,
  MultiBuyLadderPolicy,
  OpportunisticTakerPolicy,
  RaceProtectionPolicy,
  RedeemSweepPolicy,
  RepriceOnOutbidPolicy,
  ExitRepriceOnDownpricePolicy,
  SellCapacityPolicy,
} from "./types.js";
import { DEFAULT_MARKET_SELECTION_POLICY } from "./market-selection.js";

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
  sides: ["buy", "sell"],
  safetyBuffer: 1.05,
  fallbackMinNotionalUsdc: 1,
  marketableBuyMinNotionalUsdc: 1,
};

export const DEFAULT_REDEEM_SWEEP_POLICY: RedeemSweepPolicy = {
  enabled: false,
  intervalMs: 4 * 60 * 60_000,
  inFlightTtlMs: 15 * 60_000,
  maxRetries: 3,
  retryBackoffMs: [60_000, 300_000, 1_800_000],
  postRedeemVerifyDelayMs: 5 * 60_000,
  minAgeAfterResolutionSec: 8 * 60 * 60,
};

export const DEFAULT_RACE_PROTECTION_POLICY: RaceProtectionPolicy = {
  redeemInFlight: {
    enabled: true,
  },
};

export const DEFAULT_ORDER_LIFETIME_POLICY: OrderLifetimePolicy = {
  enabled: true,
  enforcement: "enforce",
  staleResetMs: 24 * 60 * 60_000,
  safetyBufferMs: 60 * 60_000,
  resolutionAggressiveWindowMs: 6 * 60 * 60_000,
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

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  version: 1,
  entryPriceCeiling: 0.45,
  entryMinMarketAgeSeconds: DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS,
  exitOrderTtlMs: 300_000,
  marketSelection: DEFAULT_MARKET_SELECTION_POLICY,
  buyCapacity: DEFAULT_BUY_CAPACITY_POLICY,
  sellCapacity: DEFAULT_SELL_CAPACITY_POLICY,
  orderCapacity: DEFAULT_ORDER_CAPACITY_POLICY,
  deadSideGuard: DEFAULT_DEAD_SIDE_GUARD,
  pricing: DEFAULT_PRICING_POLICY,
  exitPricingMode: "bid-anchored",
  exitBidAnchorTicks: 4,
  opportunisticTaker: DEFAULT_OPPORTUNISTIC_TAKER_POLICY,
  orderLifetime: DEFAULT_ORDER_LIFETIME_POLICY,
  repriceOnOutbid: DEFAULT_REPRICE_ON_OUTBID_POLICY,
  exitRepriceOnDownprice: DEFAULT_EXIT_REPRICE_ON_DOWNPRICE_POLICY,
  dropTrigger: DEFAULT_DROP_TRIGGER_POLICY,
  multiBuyLadder: DEFAULT_MULTI_BUY_LADDER_POLICY,
  redeemSweep: DEFAULT_REDEEM_SWEEP_POLICY,
  raceProtection: DEFAULT_RACE_PROTECTION_POLICY,
  telemetry: DEFAULT_TELEMETRY,
};

const DEAD_SIDE_MODES = ["off", "observe", "enforce"] as const;
const ORDER_LIFETIME_ENFORCEMENT_MODES = ["observe", "enforce"] as const;
const PRICING_MODES = ["edge", "bounded-midpoint"] as const;
const BINARY_PRICING_POLICIES = ["edge", "skip"] as const;
const EXIT_PRICING_MODES = ["bid-anchored", "edge"] as const;
const ORDER_SIDES = ["buy", "sell"] as const;

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
const BOUND_EXIT_TTL_MAX_MS = 60 * 60_000;
const BOUND_ENTRY_MIN_AGE_MIN_S = 0;
// Two days — wide enough to cover any realistic conservative tightening
// without enabling pathological values that would silently disable BUYs forever.
const BOUND_ENTRY_MIN_AGE_MAX_S = 2 * 24 * 60 * 60;
const BOUND_MARKET_SELECTION_MAX_MID_MIN = 0.001;
const BOUND_MARKET_SELECTION_MAX_MID_MAX = 0.99;
const BOUND_MARKET_SELECTION_MIN_LIQUIDITY_MIN = 0;
const BOUND_MARKET_SELECTION_MIN_LIQUIDITY_MAX = 1_000_000;
const BOUND_BUY_CAPACITY_HEADROOM_MIN_USDC = 0;
const BOUND_BUY_CAPACITY_HEADROOM_MAX_USDC = 10_000;
const BOUND_CAPACITY_OPEN_ORDERS_MIN = 0;
const BOUND_CAPACITY_OPEN_ORDERS_MAX = 1_000;
const BOUND_ORDER_LIFETIME_MIN_MS = 1_000;
const BOUND_ORDER_LIFETIME_MAX_MS = 14 * 24 * 60 * 60_000;
const BOUND_ORDER_LIFETIME_COUNT_MAX = 10_000;
const BOUND_STUCK_WARNING_GAP_PCT_MIN = 0;
const BOUND_STUCK_WARNING_GAP_PCT_MAX = 1;
const BOUND_DROP_TRIGGER_THRESHOLD_MIN = -1;
const BOUND_DROP_TRIGGER_THRESHOLD_MAX = 0;
const BOUND_FILL_RATE_MIN = 0;
const BOUND_FILL_RATE_MAX = 1;
// Parser ceiling only; profile capital/order risk limits still constrain live exposure.
const BOUND_LADDER_USDC_CAP_MAX = 10_000;
const BOUND_TAKER_SAFETY_BUFFER_MIN = 1;
const BOUND_TAKER_SAFETY_BUFFER_MAX = 10;
const BOUND_TAKER_MIN_NOTIONAL_MAX = 1_000;
const BOUND_REDEEM_SWEEP_INTERVAL_MIN_MS = 30_000;
const BOUND_REDEEM_SWEEP_INTERVAL_MAX_MS = 24 * 60 * 60_000;
const BOUND_REDEEM_SWEEP_RETRY_COUNT_MAX = 10;

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
  const opportunisticTaker = parseOpportunisticTaker(obj.opportunisticTaker, issues);
  const telemetry = parseTelemetry(obj.telemetry, issues);
  const marketSelection = parseMarketSelection(obj.marketSelection, issues);
  const buyCapacity = parseBuyCapacity(obj.buyCapacity, issues);
  const sellCapacity = parseSellCapacity(obj.sellCapacity, issues);
  const orderCapacity = parseOrderCapacity(obj.orderCapacity, issues);
  const orderLifetime = parseOrderLifetime(obj.orderLifetime, issues);
  const repriceOnOutbid = parseRepriceOnOutbid(obj.repriceOnOutbid, issues);
  const exitRepriceOnDownprice = parseExitRepriceOnDownprice(obj.exitRepriceOnDownprice, issues);
  const dropTrigger = parseDropTrigger(obj.dropTrigger, issues);
  const multiBuyLadder = parseMultiBuyLadder(obj.multiBuyLadder, issues);
  const redeemSweep = parseRedeemSweep(obj.redeemSweep, issues);
  const raceProtection = parseRaceProtection(obj.raceProtection, issues);

  return {
    policy: {
      version,
      entryPriceCeiling,
      entryMinMarketAgeSeconds,
      exitOrderTtlMs,
      marketSelection,
      buyCapacity,
      sellCapacity,
      orderCapacity,
      deadSideGuard,
      pricing,
      exitPricingMode,
      exitBidAnchorTicks,
      opportunisticTaker,
      orderLifetime,
      repriceOnOutbid,
      exitRepriceOnDownprice,
      dropTrigger,
      multiBuyLadder,
      redeemSweep,
      raceProtection,
      telemetry,
    },
    issues,
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
    sides: sideListOr(obj.sides, DEFAULT_OPPORTUNISTIC_TAKER_POLICY.sides, issues),
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
    minAgeAfterResolutionSec: clampedInt(
      obj.minAgeAfterResolutionSec,
      DEFAULT_REDEEM_SWEEP_POLICY.minAgeAfterResolutionSec,
      0,
      30 * 24 * 60 * 60,
      issues,
      "redeemSweep.minAgeAfterResolutionSec",
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

function sideListOr(
  raw: unknown,
  fallback: OpportunisticTakerPolicy["sides"],
  issues: string[],
): OpportunisticTakerPolicy["sides"] {
  if (raw === undefined) return fallback;
  if (!Array.isArray(raw)) {
    issues.push("opportunisticTaker.sides must be an array");
    return fallback;
  }
  const sides: OpportunisticTakerPolicy["sides"] = [];
  for (const side of raw) {
    if (typeof side !== "string" || !(ORDER_SIDES as readonly string[]).includes(side)) {
      issues.push(`opportunisticTaker.sides contains invalid side ${String(side)}`);
      return fallback;
    }
    if (!sides.includes(side as "buy" | "sell")) sides.push(side as "buy" | "sell");
  }
  if (sides.length === 0) {
    issues.push("opportunisticTaker.sides must include at least one side");
    return fallback;
  }
  return sides;
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

/** Serialize an ExecutionPolicy back to the compact JSON used by the DB. */
export function serializeExecutionPolicy(policy: ExecutionPolicy): string {
  return JSON.stringify(policy);
}

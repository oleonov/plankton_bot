import type {
  EntryFreshEdgeKind,
  EntryFreshEdgeShadowClass,
  NormalizedMarket,
} from "@krabs/domain";
import type { MidpointWindowStats } from "./market-snapshot-price-history.js";

export interface EntryFreshEdgeWindowPayload {
  windowMs: number;
  midpointMin: number | null;
  midpointMax: number | null;
  midpointPercentile: number | null;
  currentVsPeak: number | null;
  secondsSinceLocalHigh: number | null;
  secondsSinceLocalLow: number | null;
  trendSlope: number | null;
  recoveryFromLow: boolean | null;
  sampleCount: number;
}

export interface EntryFreshEdgePayload {
  tokenId: string;
  conditionId: string;
  slug: string | null;
  question: string | null;
  timestamp: string;
  decisionRuleId: string | null;
  signalReason: string;
  entryKind: EntryFreshEdgeKind;
  current: {
    bid: number | null;
    ask: number | null;
    mid: number | null;
    spread: number | null;
    liquidity: number | null;
    volume24h: number | null;
    volume24hr: number | null;
    publicTradeCount24h: number | null;
  };
  marketAge: {
    seconds: number | null;
    thresholdSeconds: number | null;
    gatePassed: boolean | null;
  };
  windows: {
    "1h": EntryFreshEdgeWindowPayload;
    "6h": EntryFreshEdgeWindowPayload;
    "24h": EntryFreshEdgeWindowPayload;
  };
  shortTrendSlope: number | null;
  recoveryFromLow: boolean | null;
  shadowClassification: EntryFreshEdgeShadowClass;
}

export interface EntryFreshEdgeSignalFields {
  entryFreshEdgeKind: EntryFreshEdgeKind | null;
  entryFreshEdgeShadowClass: EntryFreshEdgeShadowClass | null;
  entryFreshEdgePayloadJson: string | null;
}

export interface EntryFreshEdgeInputs {
  market: NormalizedMarket;
  nowMs: number;
  decisionRuleId: string | null;
  signalReason: string;
  buyCount: number;
  marketAgeSeconds: number | null;
  marketAgeThresholdSeconds: number | null;
  marketAgeGatePassed: boolean | null;
  windowStats: {
    "1h": MidpointWindowStats | null;
    "6h": MidpointWindowStats | null;
    "24h": MidpointWindowStats | null;
  };
}

export const ENTRY_FRESH_EDGE_WINDOW_MS = {
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
} as const;

export function computeEntryFreshEdgeSignalFields(
  inputs: EntryFreshEdgeInputs,
): EntryFreshEdgeSignalFields {
  const payload = computeEntryFreshEdgePayload(inputs);
  return {
    entryFreshEdgeKind: payload.entryKind,
    entryFreshEdgeShadowClass: payload.shadowClassification,
    entryFreshEdgePayloadJson: JSON.stringify(payload),
  };
}

export function computeEntryFreshEdgePayload(inputs: EntryFreshEdgeInputs): EntryFreshEdgePayload {
  const currentMid = currentMidpoint(inputs.market);
  const windows = {
    "1h": computeWindowPayload(
      currentMid,
      inputs.windowStats["1h"],
      ENTRY_FRESH_EDGE_WINDOW_MS["1h"],
      inputs.nowMs,
    ),
    "6h": computeWindowPayload(
      currentMid,
      inputs.windowStats["6h"],
      ENTRY_FRESH_EDGE_WINDOW_MS["6h"],
      inputs.nowMs,
    ),
    "24h": computeWindowPayload(
      currentMid,
      inputs.windowStats["24h"],
      ENTRY_FRESH_EDGE_WINDOW_MS["24h"],
      inputs.nowMs,
    ),
  };
  const shadowClassification = classifyEntryFreshEdge(windows);

  return {
    tokenId: String(inputs.market.tokenId),
    conditionId: String(inputs.market.conditionId),
    slug: inputs.market.slug ?? null,
    question: inputs.market.question ?? null,
    timestamp: new Date(inputs.nowMs).toISOString(),
    decisionRuleId: inputs.decisionRuleId,
    signalReason: inputs.signalReason,
    entryKind: inputs.buyCount === 0 ? "first_entry" : "ladder_or_scale_in",
    current: {
      bid: finitePositive(inputs.market.bestBid),
      ask: finitePositive(inputs.market.bestAsk),
      mid: currentMid,
      spread: finiteNonNegative(inputs.market.spread),
      liquidity: finiteNonNegative(inputs.market.liquidity ?? null),
      volume24h: finiteNonNegative(inputs.market.volume24h ?? null),
      volume24hr: finiteNonNegative(inputs.market.volume24hr ?? null),
      publicTradeCount24h: finiteNonNegative(inputs.market.publicTradeCount24h ?? null),
    },
    marketAge: {
      seconds: finiteNonNegative(inputs.marketAgeSeconds),
      thresholdSeconds: finiteNonNegative(inputs.marketAgeThresholdSeconds),
      gatePassed: inputs.marketAgeGatePassed,
    },
    windows,
    shortTrendSlope: windows["1h"].trendSlope,
    recoveryFromLow: windows["1h"].recoveryFromLow,
    shadowClassification,
  };
}

function computeWindowPayload(
  currentMid: number | null,
  stats: MidpointWindowStats | null,
  windowMs: number,
  nowMs: number,
): EntryFreshEdgeWindowPayload {
  if (!stats || currentMid == null) {
    return emptyWindowPayload(windowMs, stats?.sampleCount ?? 0);
  }

  const range = stats.maxMidpoint - stats.minMidpoint;
  const midpointPercentile =
    range > 0
      ? clamp01((currentMid - stats.minMidpoint) / range)
      : currentMid === stats.minMidpoint
        ? 0.5
        : null;
  const secondsSinceLocalHigh =
    stats.maxAtMs <= nowMs && Number.isFinite(stats.maxAtMs)
      ? (nowMs - stats.maxAtMs) / 1000
      : null;
  const secondsSinceLocalLow =
    stats.minAtMs <= nowMs && Number.isFinite(stats.minAtMs)
      ? (nowMs - stats.minAtMs) / 1000
      : null;
  const trendSlope =
    stats.firstMidpoint > 0
      ? (stats.lastMidpoint - stats.firstMidpoint) / stats.firstMidpoint
      : null;
  const recoveryFromLow =
    midpointPercentile == null || secondsSinceLocalHigh == null || secondsSinceLocalLow == null
      ? null
      : midpointPercentile >= 0.2 && secondsSinceLocalLow <= secondsSinceLocalHigh;

  return {
    windowMs,
    midpointMin: stats.minMidpoint,
    midpointMax: stats.maxMidpoint,
    midpointPercentile,
    currentVsPeak: stats.maxMidpoint > 0 ? currentMid / stats.maxMidpoint : null,
    secondsSinceLocalHigh,
    secondsSinceLocalLow,
    trendSlope,
    recoveryFromLow,
    sampleCount: stats.sampleCount,
  };
}

function emptyWindowPayload(windowMs: number, sampleCount: number): EntryFreshEdgeWindowPayload {
  return {
    windowMs,
    midpointMin: null,
    midpointMax: null,
    midpointPercentile: null,
    currentVsPeak: null,
    secondsSinceLocalHigh: null,
    secondsSinceLocalLow: null,
    trendSlope: null,
    recoveryFromLow: null,
    sampleCount,
  };
}

function classifyEntryFreshEdge(
  windows: EntryFreshEdgePayload["windows"],
): EntryFreshEdgeShadowClass {
  const primary =
    windows["1h"].sampleCount >= 2
      ? windows["1h"]
      : windows["6h"].sampleCount >= 2
        ? windows["6h"]
        : windows["24h"];
  if (primary.sampleCount < 2 || primary.midpointPercentile == null)
    return "RANGE_DATA_UNAVAILABLE";

  if (
    primary.midpointPercentile <= 0.3 &&
    primary.trendSlope != null &&
    primary.trendSlope < -0.02 &&
    primary.recoveryFromLow !== true
  ) {
    return "FALLING_WITHOUT_RECOVERY";
  }
  if (
    primary.recoveryFromLow === true &&
    primary.midpointPercentile <= 0.6 &&
    (primary.trendSlope ?? 0) >= 0
  ) {
    return "PLAUSIBLE_DIP";
  }
  if (
    primary.midpointPercentile >= 0.8 ||
    (primary.currentVsPeak != null && primary.currentVsPeak >= 0.95)
  ) {
    return "AFTER_PUMP_EXPENSIVE";
  }
  return "FRESH_EDGE_UNKNOWN";
}

function currentMidpoint(market: NormalizedMarket): number | null {
  const mid = finitePositive(market.midPrice);
  if (mid != null) return mid;
  const bid = finitePositive(market.bestBid);
  const ask = finitePositive(market.bestAsk);
  if (bid != null && ask != null) return (bid + ask) / 2;
  return finitePositive(market.lastTradePrice ?? null) ?? bid ?? ask;
}

function finitePositive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

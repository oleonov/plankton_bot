import type {
  BookContext,
  ExitDecisionContext,
  LiveBookVerdict,
  Market,
  NormalizedMarket,
  Order,
  Position,
  RepriceContext,
  StaleVerdict,
  StaleSellContext,
  TokenId,
  LegState,
} from "@krabs/domain";

export type TrackCSubtype = "strike" | "non-strike";

interface BookMarketData {
  readonly bestBid?: number | null;
  readonly bestAsk?: number | null;
  readonly snapshotTs?: number | null;
  readonly publicTradeCount24h?: number | null;
}

interface MarketPricingSnapshot extends BookMarketData {
  readonly midPrice?: number | null;
  readonly spread?: number | null;
}

export interface BuildBookContextInput {
  readonly tokenId: TokenId;
  readonly market: BookMarketData | null;
  readonly bidPersistenceS?: number | null;
  readonly bidMovement30m?: number | null;
  readonly publicTradeCount1h?: number | null;
  readonly ts: number;
}

export function buildBookContext(input: BuildBookContextInput): BookContext {
  return {
    assetId: input.tokenId,
    bestBid: finiteOrNull(input.market?.bestBid),
    bestAsk: finiteOrNull(input.market?.bestAsk),
    bidPersistenceS: finiteOrNull(input.bidPersistenceS),
    bidMovement30m: finiteOrNull(input.bidMovement30m),
    publicTradeCount1h: finiteOrNull(input.publicTradeCount1h),
    capturedAt: finiteOrNull(input.market?.snapshotTs),
    ts: input.ts,
  };
}

export interface BuildRepriceContextInput {
  readonly tokenId: TokenId;
  readonly subtype: TrackCSubtype;
  readonly market: MarketPricingSnapshot | null;
  readonly livenessVerdict: LiveBookVerdict["verdict"];
  readonly ts: number;
}

export function buildRepriceContext(input: BuildRepriceContextInput): RepriceContext {
  return {
    assetId: input.tokenId,
    subtype: input.subtype,
    currentSpread: resolveSpread(input.market),
    currentMid: resolveMid(input.market),
    livenessVerdict: input.livenessVerdict,
    capturedAt: finiteOrNull(input.market?.snapshotTs),
    ts: input.ts,
  };
}

export interface BuildStaleSellContextInput {
  readonly order: Pick<Order, "tokenId" | "price" | "createdAt">;
  readonly market: Pick<NormalizedMarket, "bestBid" | "bestAsk"> | null;
  readonly legState: Pick<
    LegState,
    "repriceChainCount24h" | "repriceChainEvents24hJson" | "sellCount"
  > | null;
  readonly position: Pick<Position, "openedAt"> | null;
  readonly livenessVerdict: LiveBookVerdict["verdict"];
  readonly ts: number;
}

export function buildStaleSellContext(input: BuildStaleSellContextInput): StaleSellContext {
  return {
    assetId: input.order.tokenId,
    sellPrice: finiteOrNull(input.order.price),
    currentBid: finiteOrNull(input.market?.bestBid),
    currentAsk: finiteOrNull(input.market?.bestAsk),
    sellPostedAt: parseIsoMs(input.order.createdAt),
    repriceChainCount24h: resolveRepriceChainCount(input.legState),
    sellCount: finiteOrNull(input.legState?.sellCount),
    positionAgeMs: resolveAgeMs(input.position?.openedAt, input.ts),
    livenessVerdict: input.livenessVerdict,
    ts: input.ts,
  };
}

export interface BuildExitDecisionContextInput {
  readonly order: Pick<Order, "tokenId" | "price">;
  readonly market: Pick<Market, "endDate"> | null;
  readonly position: Pick<
    Position,
    "avgEntryPrice" | "costBasisUsdc" | "currentValueUsdc" | "openedAt" | "size"
  > | null;
  readonly livenessVerdict: LiveBookVerdict["verdict"];
  readonly staleVerdict: StaleVerdict;
  readonly subtype: TrackCSubtype;
  readonly exitPnlPct?: number | null;
  readonly floorIntentState?: ExitDecisionContext["floorIntentState"];
  readonly holdResolutionState?: ExitDecisionContext["holdResolutionState"];
  readonly floorCloseRatioThreshold?: number | null;
  readonly ts: number;
}

export function buildExitDecisionContext(
  input: BuildExitDecisionContextInput,
): ExitDecisionContext {
  return {
    tokenId: input.order.tokenId,
    positionPnLRatio: resolvePositionPnlRatio(input.position),
    livenessVerdict: input.livenessVerdict,
    staleVerdict: input.staleVerdict,
    positionAgeMs: resolveAgeMs(input.position?.openedAt, input.ts) ?? Number.NaN,
    ttcResolutionMs: resolveTtcMs(input.market?.endDate, input.ts),
    subtype: input.subtype,
    exitPnlPct: finiteOrNull(input.exitPnlPct) ?? resolveExitPnlPct(input.order, input.position),
    ...(input.floorIntentState ? { floorIntentState: input.floorIntentState } : {}),
    ...(input.holdResolutionState ? { holdResolutionState: input.holdResolutionState } : {}),
    floorCloseRatioThreshold: input.floorCloseRatioThreshold ?? null,
    ts: input.ts,
  };
}

function resolveSpread(market: MarketPricingSnapshot | null): number | null {
  const explicit = finiteOrNull(market?.spread);
  if (explicit != null) return explicit;
  const bid = finiteOrNull(market?.bestBid);
  const ask = finiteOrNull(market?.bestAsk);
  return bid == null || ask == null ? null : ask - bid;
}

function resolveMid(market: MarketPricingSnapshot | null): number | null {
  const explicit = finiteOrNull(market?.midPrice);
  if (explicit != null) return explicit;
  const bid = finiteOrNull(market?.bestBid);
  const ask = finiteOrNull(market?.bestAsk);
  return bid == null || ask == null ? null : (bid + ask) / 2;
}

function resolveRepriceChainCount(
  legState: Pick<
    LegState,
    "repriceChainCount24h" | "repriceChainEvents24hJson" | "sellCount"
  > | null,
): number | null {
  const eventsCount = parseJsonStringArray(legState?.repriceChainEvents24hJson)?.length;
  return eventsCount ?? finiteOrNull(legState?.repriceChainCount24h);
}

function resolvePositionPnlRatio(
  position: Pick<Position, "costBasisUsdc" | "currentValueUsdc"> | null,
): number {
  const costBasis = finiteOrNull(position?.costBasisUsdc);
  const currentValue = finiteOrNull(position?.currentValueUsdc);
  if (costBasis == null || costBasis <= 0 || currentValue == null) return Number.NaN;
  return currentValue / costBasis;
}

function resolveExitPnlPct(
  order: Pick<Order, "price">,
  position: Pick<Position, "avgEntryPrice"> | null,
): number {
  const entry = finiteOrNull(position?.avgEntryPrice);
  const price = finiteOrNull(order.price);
  if (entry == null || entry <= 0 || price == null) return Number.NaN;
  return (price - entry) / entry;
}

function resolveAgeMs(iso: string | null | undefined, ts: number): number | null {
  const parsed = parseIsoMs(iso);
  return parsed == null || !Number.isFinite(ts) ? null : ts - parsed;
}

function resolveTtcMs(iso: string | null | undefined, ts: number): number {
  const parsed = parseIsoMs(iso);
  return parsed == null || !Number.isFinite(ts) ? Number.NaN : parsed - ts;
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonStringArray(raw: string | null | undefined): readonly string[] | null {
  if (raw == null || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.every((value) => typeof value === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

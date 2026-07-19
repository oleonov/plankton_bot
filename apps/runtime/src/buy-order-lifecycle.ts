import {
  GATE_ENTRY_RULE_ID,
  SignalReason,
  type Market,
  type Order,
  type PlaceOrderCommand,
} from "@krabs/domain";

export const BUY_DUPLICATE_DEDUPED_REASON = "buy_duplicate_deduped";
export const BUY_CAP_FULL_TARGETED_REPLACEMENT_REASON = "buy_cap_full_targeted_replacement";

export const HORIZON_TTL_MS: Record<string, number> = {
  "intraday-4h": 45 * 60_000,
  daily: 6 * 60 * 60_000,
  deadline: 24 * 60 * 60_000,
  "ad-hoc": 8 * 60 * 60_000,
};
export const DEFAULT_TTL_MS = 6 * 60 * 60_000;
export const PROBE_LIKE_INTRADAY_TTL_MS = 60_000;
export const PROBE_LIKE_DAILY_TTL_MS = 5 * 60_000;
export const PROBE_LIKE_AD_HOC_TTL_MS = 10 * 60_000;
export const CONFIRM_SCALE_TTL_MS = 3 * 60 * 60_000;
export const SCALE_IN_DEFAULT_TTL_MS = 3 * 60 * 60_000;

// First-entry adaptive TTL — research-derived (research_plankton/gate_ttl_calibration_report_2026-07-18.md).
// Observer market-total fill timing (6.57M trades) gives time-to-fill ≈ C/rate with
// C = 193 min·(trades/hour); rate = tradeCount3h / 3, so TTL_min = 580 / tradeCount3h. Calibrated on
// GATE's cheap-longshot cohort; the same cohort covers R23/FALLBACK/D-rule first entries (the maker
// entry is plankton's edge-carrying sub-strategy, 78% of P&L, P&L-validated).
export const ADAPTIVE_ENTRY_TTL_DIVISOR_MIN = 580;
// Busy-market (41–80 trades/3h) p90 fill ≈ 24m — never cancel a first-entry bid before a realistic fill.
export const ADAPTIVE_ENTRY_TTL_FLOOR_MS = 30 * 60_000;
// p75 fill even on 0-activity markets ≈ 11h — patient enough for the deadest longshot.
export const ADAPTIVE_ENTRY_TTL_CAP_MS = 12 * 60 * 60_000;
// Operational (not from plankton): bound GATE's share of the shared 25-slot buy pool (protect R23).
export const MAX_OPEN_GATE_BUYS = 6;

/**
 * Adaptive TTL (ms) for a first-entry maker bid given the market's trailing-3h public trade count.
 * `clamp(580 / tradeCount3h minutes, floor, cap)`; unknown/dead market (null/≤0) → cap (max patience).
 */
export function adaptiveEntryTtlMs(tradeCount3h: number | null): number {
  if (tradeCount3h == null || tradeCount3h <= 0) return ADAPTIVE_ENTRY_TTL_CAP_MS;
  const rawMs = Math.round(ADAPTIVE_ENTRY_TTL_DIVISOR_MIN / tradeCount3h) * 60_000;
  return Math.min(Math.max(rawMs, ADAPTIVE_ENTRY_TTL_FLOOR_MS), ADAPTIVE_ENTRY_TTL_CAP_MS);
}

const PRICE_EPSILON = 1e-9;
const ADD_BUY_REASONS = new Set<string>([
  SignalReason.ConfirmScale,
  SignalReason.ScaleIn,
  SignalReason.HeavyScale,
]);

interface BuyCandidate {
  readonly tokenId: PlaceOrderCommand["tokenId"];
  readonly price: number;
  readonly decisionRuleId?: string | null;
  readonly signalReason?: string | null;
  readonly reason?: string | null;
  readonly source?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

type BuyOrderCandidate = Pick<
  Order,
  | "orderId"
  | "tokenId"
  | "side"
  | "status"
  | "price"
  | "signalReason"
  | "decisionRuleId"
  | "metadata"
>;

// Long-lived market horizons whose first-entry maker bids use the activity-adaptive TTL.
// Short-horizon crypto (intraday-4h/daily) is deliberately excluded — fast-resolving, and the
// 580/trade formula was calibrated on long-lived longshots only.
const ADAPTIVE_TTL_LONG_LIVED_HORIZONS = new Set<string>(["deadline", "ad-hoc"]);

/**
 * True when the order was placed as an explicit marketable taker (opportunistic-taker path). Read from
 * the persisted `metadata.executionPricingMode` (signal-to-order writes the EFFECTIVE post-override
 * mode, so a makerOverride-converted taker reads "maker" here, not "taker"). Positive-only: only an
 * exact "taker" excludes; any other value or absent metadata is treated as a maker bid.
 */
function isMarketableTakerOrder(order: Pick<Order, "metadata">): boolean {
  const metadata = order.metadata;
  return metadata != null && metadata.executionPricingMode === "taker";
}

/**
 * First-entry maker bids (ProbeEntry) on long-lived markets — GATE and R23/FALLBACK/D-rule dip
 * triggers alike — use the research-calibrated activity-adaptive TTL instead of the 10-min probe
 * floor. Scale-ins (ConfirmScale/ScaleIn/HeavyScale) are excluded (H6 — never average down).
 */
export function usesAdaptiveFirstEntryTtl(
  order: Pick<Order, "signalReason" | "decisionRuleId" | "metadata">,
  market: Pick<Market, "horizon"> | null,
): boolean {
  // (1) First-entry ONLY — precedes everything so a scale-in carrying a GATE rule-id (ENTRY_REASONS
  //     permits any reason/rule combo) can never receive adaptive TTL. H6.
  if (order.signalReason !== SignalReason.ProbeEntry) return false;
  // (2) Passive MAKER bids only — the 580/tradeCount3h formula is calibrated on maker-bid fill timing.
  //     A marketable-taker order (opportunistic-taker path, placed at the ask) is a different
  //     instrument and keeps the short probe leash so it can't sit at a stale high price for up to 12h.
  //     Positive-only exclusion: a maker can never be falsely caught (unlike the reverted postOnly try).
  if (isMarketableTakerOrder(order)) return false;
  // (3) Missing market ROW (findByTokenId null) is NOT "known long-lived": keep the conservative
  //     existing probe TTL (→10min) for EVERY lane INCLUDING GATE, rather than holding a market we
  //     cannot see for up to 12h. This guard PRECEDES the GATE return so missing-row safety is
  //     correct-by-construction. In practice GATE/R23 markets are always present, so live behavior is
  //     unchanged; cap-fallback concerns absent TRADE STATS, not absent market metadata.
  if (market == null) return false;
  // (4) GATE probe with a present row → adaptive regardless of horizon (existing GATE behavior).
  if (order.decisionRuleId === GATE_ENTRY_RULE_ID) return true;
  const horizon = market.horizon ?? null; // present row with null horizon = R23's real case (prod-verified)
  return horizon == null || ADAPTIVE_TTL_LONG_LIVED_HORIZONS.has(horizon);
}

export function resolveEntryBuyOrderTtlMs(
  order: Pick<Order, "signalReason" | "decisionRuleId" | "metadata">,
  market: Pick<Market, "horizon"> | null,
  tradeCount3h?: number | null,
): number {
  // First-entry maker bids (ProbeEntry) — GATE and R23/FALLBACK/D-rule dip triggers alike — use a
  // market-activity-adaptive TTL on long-lived markets, decoupled from the 10-min probe floor they
  // would otherwise inherit. See usesAdaptiveFirstEntryTtl for the exact gating.
  if (usesAdaptiveFirstEntryTtl(order, market)) {
    return adaptiveEntryTtlMs(tradeCount3h ?? null);
  }
  const horizon = market?.horizon ?? null;
  const horizonTtlMs =
    horizon != null ? (HORIZON_TTL_MS[horizon] ?? DEFAULT_TTL_MS) : DEFAULT_TTL_MS;

  if (order.signalReason === SignalReason.ProbeEntry) {
    if (horizon === "intraday-4h") return Math.min(horizonTtlMs, PROBE_LIKE_INTRADAY_TTL_MS);
    if (horizon === "daily") return Math.min(horizonTtlMs, PROBE_LIKE_DAILY_TTL_MS);
    if (horizon === "ad-hoc") return Math.min(horizonTtlMs, PROBE_LIKE_AD_HOC_TTL_MS);
    return Math.min(horizonTtlMs, PROBE_LIKE_AD_HOC_TTL_MS);
  }

  if (order.signalReason === SignalReason.ConfirmScale) {
    return Math.min(horizonTtlMs, CONFIRM_SCALE_TTL_MS);
  }

  if (
    order.signalReason === SignalReason.ScaleIn ||
    order.signalReason === SignalReason.HeavyScale
  ) {
    return Math.min(horizonTtlMs, SCALE_IN_DEFAULT_TTL_MS);
  }

  return horizonTtlMs;
}

export function findNearDuplicateOpenBuy(
  orders: readonly BuyOrderCandidate[],
  candidate: BuyCandidate,
  tickSize: number | null | undefined,
): BuyOrderCandidate | null {
  return (
    orders.find(
      (order) =>
        order.side === "buy" &&
        isOpenOrderStatus(order.status) &&
        order.tokenId === candidate.tokenId &&
        isSameBuyFamily(order, candidate) &&
        isNearPrice(order.price, candidate.price, tickSize),
    ) ?? null
  );
}

export function findDuplicateOpenBuyPair(
  orders: readonly Order[],
): { keep: Order; cancel: Order } | null {
  const openBuys = orders
    .filter((order) => order.side === "buy" && isOpenOrderStatus(order.status))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (let i = 0; i < openBuys.length; i += 1) {
    const first = openBuys[i]!;
    for (let j = i + 1; j < openBuys.length; j += 1) {
      const second = openBuys[j]!;
      if (first.tokenId !== second.tokenId) continue;
      if (!isSameBuyFamily(first, second)) continue;
      if (!isNearPrice(first.price, second.price, null)) continue;
      return { keep: first, cancel: second };
    }
  }
  return null;
}

export function findOldestStaleOpenBuy(
  orders: readonly Order[],
  marketForOrder: (order: Order) => Pick<Market, "horizon"> | null,
  nowMs: number,
  tradeCountForOrder?: (order: Order) => number | null,
): Order | null {
  let oldest: Order | null = null;
  let oldestAgeMs = -1;
  for (const order of orders) {
    if (order.side !== "buy" || !isOpenOrderStatus(order.status)) continue;
    const createdAtMs = Date.parse(order.createdAt);
    if (!Number.isFinite(createdAtMs)) continue;
    const ageMs = nowMs - createdAtMs;
    // Consult the live trade-count accessor for adaptive first-entry orders — tracked tokens get true
    // per-market adaptivity; untracked → null → cap. Non-adaptive TTLs never use it.
    const market = marketForOrder(order);
    const tradeCount3h = usesAdaptiveFirstEntryTtl(order, market)
      ? tradeCountForOrder?.(order)
      : undefined;
    if (ageMs < resolveEntryBuyOrderTtlMs(order, market, tradeCount3h)) continue;
    if (ageMs > oldestAgeMs) {
      oldest = order;
      oldestAgeMs = ageMs;
    }
  }
  return oldest;
}

export function isAddBuyReason(reason: string | null | undefined): boolean {
  return reason != null && ADD_BUY_REASONS.has(reason);
}

function isOpenOrderStatus(status: string): boolean {
  return status === "pending" || status === "open" || status === "partially-filled";
}

function isNearPrice(a: number, b: number, tickSize: number | null | undefined): boolean {
  const tolerance =
    typeof tickSize === "number" && Number.isFinite(tickSize) && tickSize > 0
      ? tickSize + PRICE_EPSILON
      : PRICE_EPSILON;
  return Math.abs(a - b) <= tolerance;
}

function isSameBuyFamily(existing: BuyOrderCandidate, candidate: BuyCandidate): boolean {
  if (normalizeReason(existing.signalReason) !== normalizeReason(candidateReason(candidate))) {
    return false;
  }
  const existingRule = normalizeOptional(existing.decisionRuleId);
  const candidateRule = normalizeOptional(candidate.decisionRuleId);
  if (!existingRule || !candidateRule || existingRule !== candidateRule) return false;

  const existingSource = normalizeOptional(sourceFromMetadata(existing.metadata));
  const candidateSource = normalizeOptional(
    sourceFromMetadata(candidate.metadata) ?? candidate.source ?? null,
  );
  return !existingSource || !candidateSource || existingSource === candidateSource;
}

function candidateReason(candidate: BuyCandidate): string | null | undefined {
  return candidate.signalReason ?? candidate.reason ?? null;
}

function normalizeReason(reason: string | null | undefined): string | null {
  return normalizeOptional(reason);
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function sourceFromMetadata(metadata: Readonly<Record<string, unknown>> | null | undefined) {
  const value = metadata?.source;
  return typeof value === "string" ? value : null;
}

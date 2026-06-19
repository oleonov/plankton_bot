import type {
  AddAgeBucket,
  AddPriceChangeBucket,
  CancelAgeBucket,
  ExitPnlBucket,
  HoldingTimeBucket,
  NotionalBucket,
  PriceLevel,
  PricingRoundLevel,
  SoldBoughtRatioBucket,
} from "@krabs/domain";

const DEFAULT_TICK_SIZE = 0.01;
const PRICE_EPSILON = 1e-9;

export type ExecutablePriceValidationFailureReason =
  | "price-non-finite"
  | "price-below-min-tick"
  | "price-above-max-bound"
  | "price-off-tick-grid";

export type ExecutablePriceValidation =
  | {
      ok: true;
      tickSize: number;
      minPrice: number;
      maxPrice: number;
    }
  | {
      ok: false;
      reason: ExecutablePriceValidationFailureReason;
      tickSize: number;
      minPrice: number;
      maxPrice: number;
    };

export function validateExecutablePrice(
  price: number,
  tickSize: number,
): ExecutablePriceValidation {
  const normalizedTickSize =
    Number.isFinite(tickSize) && tickSize > 0 && tickSize < 1 ? tickSize : DEFAULT_TICK_SIZE;
  const minPrice = normalizedTickSize;
  const maxPrice = 1 - normalizedTickSize;

  if (!Number.isFinite(price)) {
    return {
      ok: false,
      reason: "price-non-finite",
      tickSize: normalizedTickSize,
      minPrice,
      maxPrice,
    };
  }
  if (price < minPrice - PRICE_EPSILON) {
    return {
      ok: false,
      reason: "price-below-min-tick",
      tickSize: normalizedTickSize,
      minPrice,
      maxPrice,
    };
  }
  if (price > maxPrice + PRICE_EPSILON) {
    return {
      ok: false,
      reason: "price-above-max-bound",
      tickSize: normalizedTickSize,
      minPrice,
      maxPrice,
    };
  }

  const snappedPrice = Math.round(price / normalizedTickSize) * normalizedTickSize;
  if (Math.abs(snappedPrice - price) > Math.max(PRICE_EPSILON, normalizedTickSize * 1e-6)) {
    return {
      ok: false,
      reason: "price-off-tick-grid",
      tickSize: normalizedTickSize,
      minPrice,
      maxPrice,
    };
  }

  return { ok: true, tickSize: normalizedTickSize, minPrice, maxPrice };
}

export interface ExecutableTopOfBookInput {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly bids?: readonly PriceLevel[] | null;
  readonly asks?: readonly PriceLevel[] | null;
}

export interface ExecutableTopOfBook {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly bestBidSize: number | null;
  readonly bestAskSize: number | null;
  readonly midPrice: number | null;
  readonly spread: number | null;
}

function firstExecutableLevel(
  levels: readonly PriceLevel[] | null | undefined,
  tickSize: number,
): PriceLevel | null {
  if (!levels || levels.length === 0) return null;
  for (const level of levels) {
    if (validateExecutablePrice(level.price, tickSize).ok) {
      return level;
    }
  }
  return null;
}

function sanitizeExecutableQuote(price: number | null, tickSize: number): number | null {
  if (price == null) return null;
  return validateExecutablePrice(price, tickSize).ok ? price : null;
}

/**
 * Side-aware tick snapping helpers.
 *
 * Built to support bounded price improvement (ADR-014 WIP): the raw candidate
 * (e.g. `midpoint - tickSize` for BUY, `midpoint + tickSize` for SELL) often
 * falls between ticks on fine grids (tickSize = 0.001). Snapping at the helper
 * layer keeps the final price on-grid before it reaches `validateExecutablePrice`.
 *
 * Rounding direction is side-specific for safety:
 *  - BUY → `floorToTick` (we never pay more than intended).
 *  - SELL → `ceilToTick` (we never accept less than intended).
 *
 * The `clampExecutablePrice` helper composes side-aware snap + bound clamp into
 * a single call so callers don't have to remember both parts.
 */
export function normalizeTickSize(tickSize: number): number {
  return Number.isFinite(tickSize) && tickSize > 0 && tickSize < 1 ? tickSize : DEFAULT_TICK_SIZE;
}

function quantize(raw: number, tickSize: number, op: (x: number) => number): number {
  // Kill `0.1 + 0.2 === 0.30000000000000004` residue before applying floor/ceil,
  // otherwise ceil of a value like 300.00000000000006 jumps a full tick.
  const scale = Math.round(1 / tickSize);
  const ticks = raw / tickSize;
  const rounded = Math.round(ticks);
  const cleaned = Math.abs(ticks - rounded) < 1e-9 ? rounded : ticks;
  return Math.round(op(cleaned) * scale * tickSize) / scale;
}

export function floorToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(price)) return price;
  const ts = normalizeTickSize(tickSize);
  return quantize(price, ts, Math.floor);
}

export function ceilToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(price)) return price;
  const ts = normalizeTickSize(tickSize);
  return quantize(price, ts, Math.ceil);
}

export interface PositiveSellFloor {
  readonly entryFloorPrice: number;
  readonly positiveFloorPrice: number;
}

export function resolvePositiveSellFloor(
  avgEntryPrice: number,
  tickSize: number,
): PositiveSellFloor {
  const ts = normalizeTickSize(tickSize);
  const entryFloorPrice = ceilToTick(avgEntryPrice, ts);
  const positiveFloorPrice = ceilToTick(entryFloorPrice + ts, ts);
  return { entryFloorPrice, positiveFloorPrice };
}

export function roundToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(price)) return price;
  const ts = normalizeTickSize(tickSize);
  return quantize(price, ts, Math.round);
}

export type ExecutableSide = "buy" | "sell";

/**
 * Snap + clamp a candidate price into the executable interval for a given side.
 *
 * BUY snaps floor (≤ raw), SELL snaps ceil (≥ raw). Both get clamped into
 * `[tickSize, 1 - tickSize]` — the same bounds `validateExecutablePrice` uses.
 */
export function clampExecutablePrice(
  price: number,
  tickSize: number,
  side: ExecutableSide,
): number {
  if (!Number.isFinite(price)) return price;
  const ts = normalizeTickSize(tickSize);
  const snapped = side === "buy" ? floorToTick(price, ts) : ceilToTick(price, ts);
  const minPrice = ts;
  const maxPrice = 1 - ts;
  if (snapped < minPrice) return minPrice;
  if (snapped > maxPrice) return maxPrice;
  return snapped;
}

/**
 * ADR-014: Bounded-midpoint price improvement.
 *
 * The naive `max(bestBid, midpoint - tickSize)` is unsafe on wide books
 * (bb=0.01 / ba=0.99 → +0.489 delta observed in prod). This helper bounds
 * it in three places:
 *  - Spread cap (`maxSpreadTicks`): if the book is wider than N ticks, fall
 *    back to the edge or skip (caller policy).
 *  - Improvement cap (`maxImprovementTicks`): the final price can be at most
 *    N ticks away from the edge toward the midpoint.
 *  - No-cross clamp: BUY never reaches bestAsk, SELL never reaches bestBid.
 *
 * Diagnostics shape (ADR-014 §D6) is returned on every call so callers can
 * emit it on skip, invalid, or placement paths without recomputing.
 */
export interface BoundedMidpointInput {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly tickSize: number;
  readonly side: ExecutableSide;
  readonly maxSpreadTicks: number;
  readonly maxImprovementTicks: number;
  readonly wideSpreadPolicy: "edge" | "skip";
  readonly oneSidedPolicy: "edge" | "skip";
}

export interface BoundedMidpointDiagnostics {
  readonly side: ExecutableSide;
  readonly tickSize: number;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly midpoint: number | null;
  readonly spread: number | null;
  readonly spreadTicks: number | null;
  readonly edgePrice: number | null;
  readonly rawCandidate: number | null;
  readonly snappedCandidate: number | null;
  readonly finalPrice: number | null;
  readonly improvementTicks: number | null;
  readonly maxSpreadTicks: number;
  readonly maxImprovementTicks: number;
}

export type BoundedMidpointOutcome =
  | { kind: "improved" | "edge"; price: number; diagnostics: BoundedMidpointDiagnostics }
  | {
      kind: "skip";
      reason: "wide-spread" | "one-sided";
      diagnostics: BoundedMidpointDiagnostics;
    }
  | {
      kind: "invalid";
      price: number;
      reason: ExecutablePriceValidationFailureReason;
      diagnostics: BoundedMidpointDiagnostics;
    };

function buildDiagnostics(
  input: BoundedMidpointInput,
  tickSize: number,
  finalPrice: number | null,
  edgePrice: number | null,
  rawCandidate: number | null,
  snappedCandidate: number | null,
): BoundedMidpointDiagnostics {
  const { bestBid, bestAsk, side, maxSpreadTicks, maxImprovementTicks } = input;
  const twoSided = bestBid != null && bestAsk != null;
  const midpoint = twoSided ? (bestBid + bestAsk) / 2 : null;
  const spread = twoSided ? bestAsk - bestBid : null;
  const spreadTicks = spread != null ? spread / tickSize : null;
  const improvementTicks =
    finalPrice != null && edgePrice != null
      ? (side === "buy" ? finalPrice - edgePrice : edgePrice - finalPrice) / tickSize
      : null;
  return {
    side,
    tickSize,
    bestBid,
    bestAsk,
    midpoint,
    spread,
    spreadTicks,
    edgePrice,
    rawCandidate,
    snappedCandidate,
    finalPrice,
    improvementTicks,
    maxSpreadTicks,
    maxImprovementTicks,
  };
}

export function resolveBoundedMidpointPrice(input: BoundedMidpointInput): BoundedMidpointOutcome {
  const tickSize = normalizeTickSize(input.tickSize);
  const { bestBid, bestAsk, side, oneSidedPolicy, wideSpreadPolicy } = input;
  const maxSpreadTicks = Math.max(1, input.maxSpreadTicks);
  const maxImprovementTicks = Math.max(0, input.maxImprovementTicks);

  const edgePrice = side === "buy" ? bestBid : bestAsk;
  const oppositeEdge = side === "buy" ? bestAsk : bestBid;

  // One-sided: the edge side itself must exist; opposite side may be null.
  if (edgePrice == null || !Number.isFinite(edgePrice) || edgePrice <= 0) {
    const diag = buildDiagnostics(
      { ...input, tickSize, maxSpreadTicks, maxImprovementTicks },
      tickSize,
      null,
      edgePrice,
      null,
      null,
    );
    return { kind: "skip", reason: "one-sided", diagnostics: diag };
  }
  if (oppositeEdge == null || !Number.isFinite(oppositeEdge) || oppositeEdge <= 0) {
    if (oneSidedPolicy === "skip") {
      const diag = buildDiagnostics(
        { ...input, tickSize, maxSpreadTicks, maxImprovementTicks },
        tickSize,
        null,
        edgePrice,
        null,
        null,
      );
      return { kind: "skip", reason: "one-sided", diagnostics: diag };
    }
    // Fall back to edge (ADR-006 D1 behaviour).
    const validation = validateExecutablePrice(edgePrice, tickSize);
    const diag = buildDiagnostics(
      { ...input, tickSize, maxSpreadTicks, maxImprovementTicks },
      tickSize,
      edgePrice,
      edgePrice,
      null,
      null,
    );
    if (!validation.ok) {
      return { kind: "invalid", price: edgePrice, reason: validation.reason, diagnostics: diag };
    }
    return { kind: "edge", price: edgePrice, diagnostics: diag };
  }

  const spreadTicks =
    (side === "buy" ? oppositeEdge - edgePrice : edgePrice - oppositeEdge) / tickSize;

  // Spread cap: wide book → fall back to edge or skip.
  if (spreadTicks > maxSpreadTicks + 1e-9) {
    if (wideSpreadPolicy === "skip") {
      const diag = buildDiagnostics(
        { ...input, tickSize, maxSpreadTicks, maxImprovementTicks },
        tickSize,
        null,
        edgePrice,
        null,
        null,
      );
      return { kind: "skip", reason: "wide-spread", diagnostics: diag };
    }
    const validation = validateExecutablePrice(edgePrice, tickSize);
    const diag = buildDiagnostics(
      { ...input, tickSize, maxSpreadTicks, maxImprovementTicks },
      tickSize,
      edgePrice,
      edgePrice,
      null,
      null,
    );
    if (!validation.ok) {
      return { kind: "invalid", price: edgePrice, reason: validation.reason, diagnostics: diag };
    }
    return { kind: "edge", price: edgePrice, diagnostics: diag };
  }

  const midpoint = (edgePrice + oppositeEdge) / 2;
  const raw = side === "buy" ? midpoint - tickSize : midpoint + tickSize;
  const snapped = side === "buy" ? floorToTick(raw, tickSize) : ceilToTick(raw, tickSize);

  // Improve bounded by edge + maxImprovementTicks * tickSize, clamped not to cross.
  const improvementCapPrice =
    side === "buy"
      ? edgePrice + maxImprovementTicks * tickSize
      : edgePrice - maxImprovementTicks * tickSize;
  const noCrossPrice = side === "buy" ? oppositeEdge - tickSize : oppositeEdge + tickSize;

  let finalPrice: number;
  if (side === "buy") {
    const improved = Math.max(edgePrice, snapped);
    const capped = Math.min(improved, improvementCapPrice);
    finalPrice = Math.min(capped, noCrossPrice);
  } else {
    const improved = Math.min(edgePrice, snapped);
    const capped = Math.max(improved, improvementCapPrice);
    finalPrice = Math.max(capped, noCrossPrice);
  }

  // Re-snap after clamps — improvementCapPrice is on-grid by construction, but
  // noCrossPrice composition can push off grid on fp-residue edge cases. A
  // final side-aware snap is cheap and keeps validateExecutablePrice happy.
  finalPrice =
    side === "buy" ? floorToTick(finalPrice, tickSize) : ceilToTick(finalPrice, tickSize);

  const validation = validateExecutablePrice(finalPrice, tickSize);
  const diag = buildDiagnostics(
    { ...input, tickSize, maxSpreadTicks, maxImprovementTicks },
    tickSize,
    finalPrice,
    edgePrice,
    raw,
    snapped,
  );

  if (!validation.ok) {
    return { kind: "invalid", price: finalPrice, reason: validation.reason, diagnostics: diag };
  }

  const improved = Math.abs(finalPrice - edgePrice) >= tickSize - 1e-9;
  return improved
    ? { kind: "improved", price: finalPrice, diagnostics: diag }
    : { kind: "edge", price: finalPrice, diagnostics: diag };
}

/**
 * ADR-023 D-F telemetry. Distance from the order's natural edge in ticks:
 *   BUY  → (selectedPrice - bestBid) / tickSize
 *   SELL → (bestAsk - selectedPrice) / tickSize
 * Positive = improvement toward midpoint, 0 = at edge, negative = below edge
 * (e.g. R29-style sub-bid fill prices). Returns null when the relevant edge
 * or tickSize is missing/invalid so the observation row preserves the gap.
 *
 * Rounded to 4 decimal places (ADR-023 §D-F) so on-grid prices read as exact
 * tick counts and dashboards aren't polluted by `(0.41 - 0.4) / 0.01`-style
 * fp residue.
 */
export function computePricingDeltaTicks(
  side: ExecutableSide,
  selectedPrice: number | null,
  bestBid: number | null,
  bestAsk: number | null,
  tickSize: number,
): number | null {
  if (selectedPrice == null || !Number.isFinite(selectedPrice)) return null;
  if (!Number.isFinite(tickSize) || tickSize <= 0) return null;
  const edge = side === "buy" ? bestBid : bestAsk;
  if (edge == null || !Number.isFinite(edge)) return null;
  const delta = side === "buy" ? selectedPrice - edge : edge - selectedPrice;
  return Math.round((delta / tickSize) * 1e4) / 1e4;
}

/**
 * ADR-023 D-F telemetry. Round-level taxonomy from R29 evidence — buckets
 * are mutually exclusive in precedence order so a price is classified as the
 * most specific tier it qualifies for:
 *   `min_tick`  → exactly tickSize
 *   `0.05x`     → multiple of 0.05
 *   `0.01x`     → multiple of 0.01 (excluding above)
 *   `0.005x`    → multiple of 0.005 (excluding above)
 *   `off-round` → none of the above
 * Returns null when price/tickSize is missing/invalid.
 */
export function classifyRoundLevel(
  price: number | null,
  tickSize: number,
): PricingRoundLevel | null {
  if (price == null || !Number.isFinite(price)) return null;
  if (!Number.isFinite(tickSize) || tickSize <= 0) return null;
  if (Math.abs(price - tickSize) <= PRICE_EPSILON) return "min_tick";
  if (isMultipleOf(price, 0.05)) return "0.05x";
  if (isMultipleOf(price, 0.01)) return "0.01x";
  if (isMultipleOf(price, 0.005)) return "0.005x";
  return "off-round";
}

function isMultipleOf(price: number, base: number): boolean {
  const ratio = price / base;
  return Math.abs(ratio - Math.round(ratio)) <= 1e-6;
}

/**
 * ADR-024 §D-C / §D-D telemetry. Maps a USDC notional onto the canonical
 * §4.6 bucket taxonomy at `06_algorithm_spec.md:454-467`. Buckets are
 * left-inclusive / right-exclusive (`[lower, upper)`) except the
 * unbounded `>$100` tail, which is right-open.
 *
 * Returns null when the notional is null or non-finite. Negative values
 * are also returned as null — the bot never emits negative notionals,
 * but the helper is robust to malformed inputs.
 *
 * Sub-cent values land in `<$0.10` along with any zero-rounded notional
 * (matches §4.1's 1,582 BUY rows that round to $0.00 / sub-cent).
 */
export function classifyNotionalBucket(usdc: number | null): NotionalBucket | null {
  if (usdc == null || !Number.isFinite(usdc) || usdc < 0) return null;
  if (usdc < 0.1) return "<$0.10";
  if (usdc < 0.5) return "$0.10-$0.50";
  if (usdc < 1) return "$0.50-$1";
  if (usdc < 2) return "$1-$2";
  if (usdc < 5) return "$2-$5";
  if (usdc < 10) return "$5-$10";
  if (usdc < 25) return "$10-$25";
  if (usdc < 50) return "$25-$50";
  if (usdc < 100) return "$50-$100";
  return ">$100";
}

/**
 * ADR-025 §D-B telemetry. Maps a cancel-age duration (ms) onto the
 * canonical §12.1 same-price-gap bucket taxonomy. Buckets are
 * left-inclusive / right-exclusive (`[lower, upper)`) except the
 * unbounded `>7d` tail.
 *
 * Bucket boundaries (ms):
 *   <1min     → ageMs < 60_000
 *   1-10min   → 60_000      ≤ ageMs < 600_000
 *   10min-1h  → 600_000     ≤ ageMs < 3_600_000
 *   1-6h      → 3_600_000   ≤ ageMs < 21_600_000
 *   6-24h     → 21_600_000  ≤ ageMs < 86_400_000
 *   1-7d      → 86_400_000  ≤ ageMs < 604_800_000
 *   >7d       → 604_800_000 ≤ ageMs
 *
 * Returns null when ageMs is null, non-finite, or negative — the
 * runtime never cancels with a negative age, but the helper is
 * robust to malformed inputs (e.g. a clock skew between createdAt
 * and Date.now()).
 */
export function classifyCancelAgeBucket(ageMs: number | null): CancelAgeBucket | null {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return null;
  if (ageMs < 60_000) return "<1min";
  if (ageMs < 600_000) return "1-10min";
  if (ageMs < 3_600_000) return "10min-1h";
  if (ageMs < 21_600_000) return "1-6h";
  if (ageMs < 86_400_000) return "6-24h";
  if (ageMs < 604_800_000) return "1-7d";
  return ">7d";
}

/**
 * ADR-026 §D-C telemetry. Maps the duration between a leg's first
 * BUY fill and a subsequent add-BUY signal (ms) onto the canonical
 * §11.1.2 bucket taxonomy. Boundaries are left-inclusive /
 * right-exclusive (`[lower, upper)`) except the unbounded `>7d`
 * tail. Note these boundaries differ from `classifyCancelAgeBucket`
 * (§12.1) — §11.1.2 uses 5/30min steps and a 1-3h / 3-12h split.
 *
 * Returns null when ageMs is null, non-finite, or negative.
 */
export function classifyAddAgeBucket(ageMs: number | null): AddAgeBucket | null {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return null;
  if (ageMs < 60_000) return "<60s";
  if (ageMs < 300_000) return "1-5min";
  if (ageMs < 1_800_000) return "5-30min";
  if (ageMs < 3_600_000) return "30min-1h";
  if (ageMs < 10_800_000) return "1-3h";
  if (ageMs < 43_200_000) return "3-12h";
  if (ageMs < 86_400_000) return "12-24h";
  if (ageMs < 604_800_000) return "1-7d";
  return ">7d";
}

/**
 * ADR-026 §D-C telemetry. Maps a signed fractional price-change
 * (e.g. `-0.5` = `-50%`) onto the canonical §11.1.3 bucket
 * taxonomy. Boundaries are left-inclusive / right-exclusive
 * (`[lower, upper)`) for the interior buckets; the tails (`below
 * -50%`, `above +50%`) are unbounded.
 *
 * Returns null when the input is null or non-finite. Note: §11.1
 * computes price change as `(addPrice - firstTradePrice) /
 * firstTradePrice`, so callers must skip when `firstTradePrice`
 * is zero or non-positive.
 */
export function classifyAddPriceChangeBucket(pct: number | null): AddPriceChangeBucket | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct < -0.5) return "below -50%";
  if (pct < -0.25) return "-50% to -25%";
  if (pct < -0.1) return "-25% to -10%";
  if (pct < 0) return "-10% to 0%";
  if (pct < 0.1) return "0% to +10%";
  if (pct < 0.25) return "+10% to +25%";
  if (pct < 0.5) return "+25% to +50%";
  return "above +50%";
}

/**
 * ADR-027 §D-D telemetry. Maps a signed fractional pnl pct
 * (`(sellPrice - rollingCostBasis) / rollingCostBasis`) onto the
 * canonical §11.2 exit-profit-distribution bucket taxonomy.
 * Boundaries are left-inclusive / right-exclusive (`[lower, upper)`)
 * for the interior buckets; the tails (`<-50%`, `>+100%`) are
 * unbounded.
 *
 * Returns null when the input is null or non-finite. Note: callers
 * must skip when `rollingCostBasis` is zero or non-positive
 * (mirrors `classifyAddPriceChangeBucket` divide-by-zero handling).
 */
export function classifyExitPnlBucket(pct: number | null): ExitPnlBucket | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  // Snap to 1e-9 to keep the documented [lower, upper) boundary contract
  // honest under float arithmetic. Without this, mathematically exact
  // boundary values (e.g. (0.15-0.10)/0.10 == 0.4999999999999999) fall
  // into the lower bucket because of the binary-rounding artifact.
  const snapped = Math.round(pct * 1e9) / 1e9;
  if (snapped < -0.5) return "<-50%";
  if (snapped < -0.1) return "-50% to -10%";
  if (snapped < 0) return "-10% to 0%";
  if (snapped < 0.05) return "0% to +5%";
  if (snapped < 0.1) return "+5% to +10%";
  if (snapped < 0.25) return "+10% to +25%";
  if (snapped < 0.5) return "+25% to +50%";
  if (snapped < 1) return "+50% to +100%";
  return ">+100%";
}

/**
 * ADR-027 §D-D telemetry. Maps a leg holding duration (ms, signed
 * but expected non-negative — clock-skew negatives are returned as
 * null per `classifyAddAgeBucket` convention) onto the canonical
 * §11.2 holding-time-first-BUY-to-first-SELL bucket taxonomy.
 * Boundaries are left-inclusive / right-exclusive (`[lower, upper)`)
 * except the unbounded `>30d` tail.
 *
 * Bucket boundaries (ms):
 *   <1h    → ms < 3_600_000
 *   1-6h   → 3_600_000   ≤ ms < 21_600_000
 *   6-24h  → 21_600_000  ≤ ms < 86_400_000
 *   1-7d   → 86_400_000  ≤ ms < 604_800_000
 *   7-30d  → 604_800_000 ≤ ms < 2_592_000_000
 *   >30d   → 2_592_000_000 ≤ ms
 *
 * Returns null when ms is null, non-finite, or negative.
 */
export function classifyHoldingTimeBucket(ms: number | null): HoldingTimeBucket | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 3_600_000) return "<1h";
  if (ms < 21_600_000) return "1-6h";
  if (ms < 86_400_000) return "6-24h";
  if (ms < 604_800_000) return "1-7d";
  if (ms < 2_592_000_000) return "7-30d";
  return ">30d";
}

/**
 * ADR-027 §D-D telemetry. Maps a sold/bought shares ratio
 * (`cumulative_sell_size / cumulative_buy_size`) onto the canonical
 * §11.2 sold/bought-ratio bucket taxonomy. The `0%` bucket includes
 * `<1%` rounding (spec coarse-rounds zero); the `>=100%` bucket
 * includes `≥99%` rounding (spec coarse-rounds full exit).
 *
 * Bucket boundaries (fraction, e.g. `0.5` = `50%`):
 *   0%      → ratio < 0.01
 *   1-25%   → 0.01 ≤ ratio < 0.25
 *   25-50%  → 0.25 ≤ ratio < 0.50
 *   50-75%  → 0.50 ≤ ratio < 0.75
 *   75-99%  → 0.75 ≤ ratio < 0.99
 *   >=100%  → 0.99 ≤ ratio
 *
 * Returns null when ratio is null, non-finite, or negative.
 * Callers must skip when `cumulative_buy_size <= 0` (divide-by-zero).
 */
export function classifySoldBoughtRatioBucket(ratio: number | null): SoldBoughtRatioBucket | null {
  if (ratio == null || !Number.isFinite(ratio) || ratio < 0) return null;
  // See classifyExitPnlBucket — snap to 1e-9 so values that are
  // mathematically on a boundary (e.g. 50/200 == 0.25) honor the
  // documented [lower, upper) contract under float arithmetic.
  const snapped = Math.round(ratio * 1e9) / 1e9;
  if (snapped < 0.01) return "0%";
  if (snapped < 0.25) return "1-25%";
  if (snapped < 0.5) return "25-50%";
  if (snapped < 0.75) return "50-75%";
  if (snapped < 0.99) return "75-99%";
  return ">=100%";
}

export function deriveExecutableTopOfBook(
  input: ExecutableTopOfBookInput,
  tickSize: number,
): ExecutableTopOfBook {
  const bestBidLevel = input.bids ? firstExecutableLevel(input.bids, tickSize) : null;
  const bestAskLevel = input.asks ? firstExecutableLevel(input.asks, tickSize) : null;
  const normalizedBestBid = bestBidLevel?.price ?? sanitizeExecutableQuote(input.bestBid, tickSize);
  const normalizedBestAsk = bestAskLevel?.price ?? sanitizeExecutableQuote(input.bestAsk, tickSize);
  const midPrice =
    normalizedBestBid !== null && normalizedBestAsk !== null
      ? (normalizedBestBid + normalizedBestAsk) / 2
      : null;
  const spread =
    normalizedBestBid !== null && normalizedBestAsk !== null
      ? normalizedBestAsk - normalizedBestBid
      : null;

  return {
    bestBid: normalizedBestBid,
    bestAsk: normalizedBestAsk,
    bestBidSize: bestBidLevel?.size ?? null,
    bestAskSize: bestAskLevel?.size ?? null,
    midPrice,
    spread,
  };
}

// Policy epsilon: suppress only truly identical SELL prices. The tiny margin
// absorbs JS decimal representation drift while staying far below CLOB tick size.
const SELL_DEDUP_PRICE_EPSILON = 1.000001e-9;

/**
 * Track P F1 — bid-anchored SELL price.
 *
 * Places a SELL at `bestBid + anchorTicks` (rounded to tick), capped at the
 * inside ask so it never crosses the book. Missing/invalid bestAsk falls back
 * to the one-sided `bestBid + anchorTicks` anchor.
 *
 * Relocated from `modules/strategy/signal-to-order.ts` so both the strategy
 * layer (live pricing) and the algo-decision worker (Track Q shadow projection)
 * can reuse the single source of truth without pulling the strategy module's
 * transitive graph into the decision worker bundle.
 */
/**
 * Effective non-crossing SELL ceiling for a resting order.
 *
 * One tick inside the ask (`bestAsk - tick`) when the book has room, the rounded
 * best ask itself for a locked/one-tick book, or `null` for a one-sided book
 * (missing/non-finite ask → no ceiling). Shared by the live bid-anchored pricer
 * and the Track Q shadow projection so both clamp SELLs to the identical bound.
 */
export function resolveSellCeiling(
  bestBid: number,
  bestAsk: number | null,
  tickSize: number,
): number | null {
  if (bestAsk == null || !Number.isFinite(bestAsk)) return null;
  const insideAsk = roundToTick(bestAsk - tickSize, tickSize);
  if (insideAsk > bestBid + SELL_DEDUP_PRICE_EPSILON) return insideAsk;
  return roundToTick(bestAsk, tickSize);
}

export function resolveBidAnchoredSellPrice(
  bestBid: number,
  bestAsk: number | null,
  tickSize: number,
  anchorTicks: number,
): number {
  const rawPrice = roundToTick(bestBid + anchorTicks * tickSize, tickSize);
  const ceiling = resolveSellCeiling(bestBid, bestAsk, tickSize);
  return ceiling == null ? rawPrice : Math.min(rawPrice, ceiling);
}

/**
 * Track P F2 — hard ceiling on any SELL exit target.
 * A Polymarket price is a probability in [0, 1]; resting a SELL above ~0.97
 * can never fill. This alone removes the bulk of the 97.8% cancel rate.
 *
 * Relocated from `modules/strategy/signal-to-order.ts` (re-exported there for
 * backward-compatible imports) so the algo-decision worker can reuse the tier
 * table without importing the strategy module.
 */
export const SELL_PRICE_CEILING = 0.97;

/**
 * Track P F2 — Plankton-aligned SELL markup ceiling by entry tier
 * (research_plankton/plankton_sell_pricing_playbook_2026-06-04.md).
 *
 * Markup is mechanically bounded by entry price: only the cheap (<0.02) tail
 * can fill at large multiples (median 2.5x). Above ~0.10 entry a constant 10x
 * target exceeds 1.0 and never fills. The tiers reproduce the analyst's
 * entry-binned first-markup medians (0.02-0.05 and 0.05-0.15 both 1.36x).
 */
export function planktonAlignedMarkupCap(avgEntry: number): number {
  if (avgEntry < 0.02) return 2.5;
  if (avgEntry < 0.15) return 1.36;
  if (avgEntry < 0.35) return 1.17;
  return 1.1;
}

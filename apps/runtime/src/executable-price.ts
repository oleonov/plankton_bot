import type { PriceLevel, PricingRoundLevel } from "@plankton/domain";

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
  readonly midPrice: number | null;
  readonly spread: number | null;
}

function firstExecutableLevel(
  levels: readonly PriceLevel[] | null | undefined,
  tickSize: number,
): number | null {
  if (!levels || levels.length === 0) return null;
  for (const level of levels) {
    if (validateExecutablePrice(level.price, tickSize).ok) {
      return level.price;
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
function normalizeTickSize(tickSize: number): number {
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

export function deriveExecutableTopOfBook(
  input: ExecutableTopOfBookInput,
  tickSize: number,
): ExecutableTopOfBook {
  const bestBid = input.bids ? firstExecutableLevel(input.bids, tickSize) : null;
  const bestAsk = input.asks ? firstExecutableLevel(input.asks, tickSize) : null;
  const normalizedBestBid = bestBid ?? sanitizeExecutableQuote(input.bestBid, tickSize);
  const normalizedBestAsk = bestAsk ?? sanitizeExecutableQuote(input.bestAsk, tickSize);
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
    midPrice,
    spread,
  };
}

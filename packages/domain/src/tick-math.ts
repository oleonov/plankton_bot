export function roundToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(price)) return price;
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
  const rounded = Math.round(price / tickSize) * tickSize;
  return Number(rounded.toFixed(decimalPlaces(tickSize) + 2));
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  const exponentIndex = text.indexOf("e-");
  if (exponentIndex >= 0) return Number(text.slice(exponentIndex + 2)) || 0;
  const dotIndex = text.indexOf(".");
  return dotIndex >= 0 ? text.length - dotIndex - 1 : 0;
}

const HARVEST_DEFAULT_TICK_SIZE = 0.01;

function normalizeHarvestTickSize(tickSize: number): number {
  return Number.isFinite(tickSize) && tickSize > 0 && tickSize < 1
    ? tickSize
    : HARVEST_DEFAULT_TICK_SIZE;
}

// Mirrors apps/runtime/src/executable-price.ts's `quantize`: kills float
// residue (e.g. 0.1 + 0.2 === 0.30000000000000004) before ceil/floor, else a
// value like 300.00000000000006 jumps a full tick.
function ceilQuantize(raw: number, tickSize: number): number {
  const scale = Math.round(1 / tickSize);
  const ticks = raw / tickSize;
  const rounded = Math.round(ticks);
  const cleaned = Math.abs(ticks - rounded) < 1e-9 ? rounded : ticks;
  return Math.round(Math.ceil(cleaned) * scale * tickSize) / scale;
}

function ceilToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(price)) return price;
  return ceilQuantize(price, normalizeHarvestTickSize(tickSize));
}

/**
 * Maker-entry / bounce-exit profit target: ceil-snapped so the resting SELL
 * never accepts less than `gainPct` above entry. Moved here from
 * apps/runtime/src/modules/algo-decision/maker-entry.ts
 * (docs/plans/2026-07-15-gate-bounce-live-experiment.md, Phase 3) so
 * packages/domain/src/bounce-exit.ts can compute the same target without
 * importing from apps/runtime. The tick-quantize logic is duplicated from
 * executable-price.ts's `ceilToTick` (packages/domain must never depend on
 * apps/runtime) rather than shared — same tradeoff already made for
 * `computeLifespanDays` in bounce-exit.ts.
 */
export function computeHarvestTarget(entryPx: number, gainPct: number, tickSize: number): number {
  return ceilToTick(entryPx * (1 + gainPct), tickSize);
}

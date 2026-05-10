import type { FillRepository, MarketRepository, Order, OrderCancelTelemetry } from "@krabs/domain";
import { classifyCancelAgeBucket } from "../../executable-price.js";

/**
 * ADR-025 §D-B — compute cancel-age telemetry at the moment an order
 * transitions into `cancelled`. Each field is independently nullable
 * so a malformed `createdAt`, an absent fill repo lookup, or a missing
 * market record never blocks the cancel write itself.
 *
 * `nowMs` is injected so callers can pass `Date.now()` consistently
 * with their cancel timestamp (e.g. the same `now` used in the
 * `OrderCancelled` event payload). Tests inject a fixed value.
 */
export function buildCancelTelemetry(args: {
  order: Order;
  nowMs: number;
  fillRepo: FillRepository;
  marketRepo: MarketRepository;
}): OrderCancelTelemetry {
  const { order, nowMs, fillRepo, marketRepo } = args;

  const ageMs = computeAgeMs(order.createdAt, nowMs);
  const fillProgressShares = sumFillShares(fillRepo, order);
  const marketHorizon = lookupMarketHorizon(marketRepo, order);

  return {
    cancelAgeMs: ageMs,
    cancelAgeBucket: classifyCancelAgeBucket(ageMs),
    fillProgressShares,
    marketHorizon,
  };
}

function lookupMarketHorizon(marketRepo: MarketRepository, order: Order): string | null {
  try {
    return marketRepo.findByTokenId(order.tokenId)?.horizon ?? null;
  } catch {
    return null;
  }
}

function computeAgeMs(createdAtIso: string, nowMs: number): number | null {
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) return null;
  const ageMs = nowMs - createdMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  return ageMs;
}

function sumFillShares(fillRepo: FillRepository, order: Order): number | null {
  try {
    const fills = fillRepo.findByOrderId(order.orderId);
    let total = 0;
    for (const fill of fills) {
      if (Number.isFinite(fill.size)) total += fill.size;
    }
    return total;
  } catch {
    return null;
  }
}

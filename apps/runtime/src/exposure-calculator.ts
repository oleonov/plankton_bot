/**
 * Live-lite exposure calculator.
 *
 * Single source of truth for the "open exposure" formula shared by preflight
 * (`profile-preflight.ts`) and runtime steady-state caps (ExecutionModule).
 * If preflight and runtime drift apart on this formula, preflight becomes a
 * one-shot check that can't protect against post-launch cap violations. See
 * ADR-009.
 *
 * Formula: sum(open positions cost_basis) + sum(open buy orders notional).
 * SELL orders reduce exposure, so they are not added here. The helper does
 * not add the candidate BUY's notional — callers pass it explicitly as
 * `additionalNotional` when simulating a would-be-placed order.
 */

import type { OrderRepository, PositionRepository } from "@krabs/domain";
import { findActivePositions } from "./active-positions.js";

export function calculateTotalExposure(
  positionRepo: PositionRepository,
  orderRepo: OrderRepository,
  additionalNotional = 0,
): number {
  const positionCostBasis = findActivePositions(positionRepo).reduce(
    (sum, p) => sum + p.costBasisUsdc,
    0,
  );
  const openBuyNotional = orderRepo.sumOpenBuyNotional();
  return positionCostBasis + openBuyNotional + additionalNotional;
}

/**
 * Token IDs that currently hold an `open` (actively-tradable) position.
 *
 * Dust positions are excluded: they are stuck below `minOrderSize` and cannot
 * place a SELL, so they do not occupy an "active market" slot from the BUY
 * gate's perspective. This keeps the runtime cap in sync with the startup
 * preflight check (`profile-preflight.ts`).
 */
export function countActiveOpenMarkets(positionRepo: PositionRepository): Set<string> {
  return new Set(positionRepo.findOpen().map((p) => String(p.tokenId)));
}

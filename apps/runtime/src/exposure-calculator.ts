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
import { findActivePositionRows } from "./active-positions.js";

export function calculateTotalExposure(
  positionRepo: PositionRepository,
  orderRepo: OrderRepository,
  additionalNotional = 0,
): number {
  // Capital at risk is the sum over EVERY non-closed row: the partial unique index lets one `open`
  // row coexist with dust rows on the same token, and the dust row's cost basis is real money we
  // still hold. Taking one winner per token would under-report exposure and loosen the BUY cap.
  const positionCostBasis = findActivePositionRows(positionRepo).reduce(
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

import type { LegStateRepository, TokenId } from "@plankton/domain";
import type { Logger } from "../../logger.js";

export interface LegStateFillInput {
  tokenId: TokenId;
  side: "buy" | "sell";
  price: number;
  filledAt: string;
}

/**
 * Pure increment of a leg_state row from a single fill. Shared between the
 * live tracker (LegStateTrackerModule.handleFill) and the startup replay
 * path (rebuildLegStatesFromLedger inside runStartupPositionAdoption), so
 * that both produce byte-identical leg_states regardless of whether fills
 * arrive as live events or are replayed from the ledger at boot.
 *
 * Caller owns the `now` timestamp to keep the function deterministic under
 * test. A SELL fill with no pre-existing leg_state is a protocol violation
 * (can't sell what was never bought) — it is logged at WARN and skipped,
 * matching the live tracker's pre-existing behavior.
 */
export function updateLegStateForFill(
  repo: LegStateRepository,
  fill: LegStateFillInput,
  log: Logger,
  now: string,
): void {
  const existing = repo.get(fill.tokenId);

  if (fill.side === "buy") {
    if (!existing) {
      repo.upsert({
        tokenId: fill.tokenId,
        buyCount: 1,
        sellCount: 0,
        lastAction: "BUY",
        firstEntryFillPrice: fill.price,
        firstTradeAt: fill.filledAt,
        lastTradeAt: fill.filledAt,
        updatedAt: now,
      });
      return;
    }
    repo.upsert({
      ...existing,
      buyCount: existing.buyCount + 1,
      lastAction: "BUY",
      lastTradeAt: fill.filledAt,
      updatedAt: now,
    });
    return;
  }

  if (!existing) {
    log.warn(
      { tokenId: String(fill.tokenId) },
      "SELL fill received with no open leg state — skipping",
    );
    return;
  }
  repo.upsert({
    ...existing,
    sellCount: existing.sellCount + 1,
    lastAction: "SELL",
    lastTradeAt: fill.filledAt,
    updatedAt: now,
  });
}

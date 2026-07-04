// Pure helpers for the Phase 3 maker-entry shadow projection.
// STATELESS: no I/O, no side effects. All state transitions and DB writes
// are handled by MakerEntryShadowTracker in algo-decision-module.ts.
//
// Fill rule (conservative):
//   trade_through: bestAsk < buy_px (ask crossed through our level — definitive)
//   touch:         bestBid >= buy_px (bid rose to our level, queue uncertain)
//   touch is recorded separately so the headline can exclude it.
//
// Harvest: (filled) bestBid >= harvest_px
// Mark:    (filled) now >= fill_deadline — mark at current bestBid
// Expire:  (pending) now >= fill_deadline — never filled

import { createHash } from "node:crypto";
import type { MakerEntryPolicy } from "@krabs/domain";
import type { MakerShadowFillKind, MakerShadowOrder, MakerShadowStageUpdate } from "@krabs/domain";
import type { R23DipTriggerResult } from "@krabs/domain";
import type { NormalizedMarket } from "@krabs/domain";
import { evaluateMakerEntry } from "./maker-entry.js";

// ─── Shadow order ID ─────────────────────────────────────────────────────────

/** Deterministic 32-char hex ID unique per (token, tick). */
export function computeShadowOrderId(tokenId: string, postedAt: string): string {
  return createHash("sha256").update(`${tokenId}|${postedAt}`).digest("hex").slice(0, 32);
}

// ─── Universe gate ────────────────────────────────────────────────────────────

/**
 * Returns true when the market meets the maker-entry universe thresholds
 * (makerMinLiquidity, makerMinVol24h). Either missing field is treated as
 * below threshold (conservative — avoid opening shadows on thin data).
 */
export function isMakerUniverse(market: NormalizedMarket, policy: MakerEntryPolicy): boolean {
  const liq = market.liquidity ?? null;
  const vol = market.volume24hr ?? null;
  if (liq === null || vol === null) return false;
  return liq >= policy.makerMinLiquidity && vol >= policy.makerMinVol24h;
}

// ─── Open helper ─────────────────────────────────────────────────────────────

export interface ShadowOpenResult {
  order: MakerShadowOrder;
}

/**
 * Evaluate whether to open a new shadow order. Returns null when the
 * R23 dip trigger did not fire, the book is invalid, the order would
 * cross, or the market is outside the maker universe.
 *
 * The returned MakerShadowOrder has stage='pending' and fill_kind=null.
 */
export function tryOpenShadow(
  tokenId: string,
  conditionId: string,
  r23: R23DipTriggerResult,
  market: NormalizedMarket,
  policy: MakerEntryPolicy,
  nowIso: string,
): MakerShadowOrder | null {
  if (!isMakerUniverse(market, policy)) return null;

  const book = {
    bestBid: market.bestBid ?? 0,
    bestAsk: market.bestAsk ?? 0,
    tickSize: market.tickSize,
  };
  const decision = evaluateMakerEntry(r23, book, {
    improveTicks: policy.bidImproveTicks,
    harvestGainPct: policy.harvestGainPct,
  });
  if (!decision.shouldPost || decision.buyPx === null || decision.harvestPx === null) return null;

  const fillDeadlineMs = Date.parse(nowIso) + policy.fillWaitMs;
  const fillDeadline = new Date(fillDeadlineMs).toISOString();

  return {
    shadowOrderId: computeShadowOrderId(tokenId, nowIso),
    tokenId: tokenId as import("@krabs/domain").TokenId,
    conditionId,
    buyPx: decision.buyPx,
    harvestPx: decision.harvestPx,
    postedAt: nowIso,
    fillDeadline,
    stage: "pending",
    fillKind: null,
    fillPx: null,
    markPx: null,
    netMark: null,
    updatedAt: nowIso,
  };
}

// ─── Advance helper ───────────────────────────────────────────────────────────

export type ShadowAdvanceOutcome =
  | { transition: false }
  | { transition: true; update: MakerShadowStageUpdate };

/**
 * Given an open shadow order and the current market snapshot, compute
 * the next stage transition (if any). Returns `{ transition: false }`
 * when nothing changed this tick.
 *
 * Called per-tick for every pending or filled shadow with book data.
 */
export function advanceShadowOrder(
  shadow: MakerShadowOrder,
  market: NormalizedMarket,
  nowIso: string,
): ShadowAdvanceOutcome {
  const bestBid = market.bestBid;
  const bestAsk = market.bestAsk;

  if (shadow.stage === "pending") {
    return advancePending(shadow, bestBid, bestAsk, nowIso);
  }
  if (shadow.stage === "filled") {
    return advanceFilled(shadow, bestBid, nowIso);
  }
  return { transition: false };
}

function advancePending(
  shadow: MakerShadowOrder,
  bestBid: number | null,
  bestAsk: number | null,
  nowIso: string,
): ShadowAdvanceOutcome {
  // Expire: past fill deadline with no fill
  if (nowIso >= shadow.fillDeadline) {
    return {
      transition: true,
      update: { stage: "expired", updatedAt: nowIso },
    };
  }

  // Trade-through fill: ask strictly below our buy price (ask crossed our bid)
  if (bestAsk !== null && bestAsk < shadow.buyPx) {
    return {
      transition: true,
      update: {
        stage: "filled",
        fillKind: "trade_through" satisfies MakerShadowFillKind,
        fillPx: bestAsk,
        updatedAt: nowIso,
      },
    };
  }

  // Touch fill: bid rose to or above our buy price (queue uncertain)
  if (bestBid !== null && bestBid >= shadow.buyPx) {
    return {
      transition: true,
      update: {
        stage: "filled",
        fillKind: "touch" satisfies MakerShadowFillKind,
        fillPx: bestBid,
        updatedAt: nowIso,
      },
    };
  }

  return { transition: false };
}

function advanceFilled(
  shadow: MakerShadowOrder,
  bestBid: number | null,
  nowIso: string,
): ShadowAdvanceOutcome {
  // Harvest: bid reached harvest target
  if (bestBid !== null && bestBid >= shadow.harvestPx) {
    return {
      transition: true,
      update: {
        stage: "harvested",
        markPx: bestBid,
        netMark: bestBid / shadow.buyPx - 1,
        updatedAt: nowIso,
      },
    };
  }

  // Mark: past fill deadline — record current bid as mark
  if (nowIso >= shadow.fillDeadline) {
    const markPx = bestBid ?? null;
    const netMark = markPx !== null ? markPx / shadow.buyPx - 1 : null;
    return {
      transition: true,
      update: { stage: "marked", markPx, netMark, updatedAt: nowIso },
    };
  }

  return { transition: false };
}

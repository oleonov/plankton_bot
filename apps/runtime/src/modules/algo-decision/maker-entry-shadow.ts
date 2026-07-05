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
// Mark:    (filled) now >= filled_at + holdWindowMs — mark at current bestBid
//          (falls back to fillDeadline when filledAt is NULL, e.g. pre-migration rows)
// Expire:  (pending) now >= fillDeadline — never filled

import { createHash } from "node:crypto";
import type { MakerEntryPolicy, TokenId } from "@krabs/domain";
import type { MakerShadowFillKind, MakerShadowOrder, MakerShadowStageUpdate } from "@krabs/domain";
import type { R23DipTriggerResult } from "@krabs/domain";
import type { NormalizedMarket } from "@krabs/domain";
import { evaluateMakerEntry, computeMakerEntryPrice, computeHarvestTarget } from "./maker-entry.js";

// ─── Shadow order ID ─────────────────────────────────────────────────────────

/** Deterministic 32-char hex ID unique per (token, tick). */
export function computeShadowOrderId(tokenId: string, postedAt: string): string {
  return createHash("sha256").update(`${tokenId}|${postedAt}`).digest("hex").slice(0, 32);
}

// ─── Universe gate ────────────────────────────────────────────────────────────

/**
 * Returns true when the market meets the maker-entry universe thresholds
 * (makerMinLiquidity, makerMinVol24h). Prefers scanner-persisted sig fields
 * (sigLiquidity / sigVol24hr) because CLOB stream updates do not carry Gamma
 * features, so the live liquidity / volume24hr are frequently NULL on the hot
 * decision path. Falls back to the live fields when the sig fields are absent.
 * Either path resolving to null is treated as below threshold (conservative).
 */
export function isMakerUniverse(market: NormalizedMarket, policy: MakerEntryPolicy): boolean {
  const liq = market.sigLiquidity ?? market.liquidity ?? null;
  const vol = market.sigVol24hr ?? market.volume24hr ?? null;
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
 * Level 0: ladderId === shadowOrderId.
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
  const shadowOrderId = computeShadowOrderId(tokenId, nowIso);

  return {
    shadowOrderId,
    tokenId: tokenId as TokenId,
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
    ladderId: shadowOrderId, // level 0: ladderId === shadowOrderId
    levelIndex: 0,
    filledAt: null,
    updatedAt: nowIso,
  };
}

// ─── Scale-in: should open next level ────────────────────────────────────────

export interface ShadowBook {
  bestBid: number;
  bestAsk: number;
  tickSize: number;
}

/**
 * Returns true when a new scale-in level should be opened on the existing ladder.
 *
 * Conditions (all must hold):
 *  1. BBO is finite and non-crossed (bestBid > 0, bestAsk > bestBid).
 *  2. Candidate buyPx is strictly below bestAsk (post-only non-cross assertion).
 *  3. Candidate buyPx is ≥ scaleInStepPct below the last level's entry price.
 *  4. Total level count (open + terminal) is below maxScaleInLevels.
 *
 * Takes all levels (open + terminal) so that expired/marked levels are counted
 * against the cap and the step-down is always measured from the most recent entry.
 */
export function shouldOpenNextLevel(
  ladder: MakerShadowOrder[],
  book: ShadowBook,
  policy: MakerEntryPolicy,
): boolean {
  if (ladder.length === 0) return false;

  // (1) BBO validity — require both values finite so Infinity/NaN don't slip through
  if (
    !Number.isFinite(book.bestBid) ||
    !Number.isFinite(book.bestAsk) ||
    !(book.bestBid > 0 && book.bestAsk > book.bestBid)
  )
    return false;

  // (2) candidate price and cross check
  const buyPx = computeMakerEntryPrice(book.bestBid, book.tickSize, policy.bidImproveTicks);
  if (buyPx >= book.bestAsk) return false;

  // (4) level cap — derive from max(levelIndex)+1 so a gap in the ladder can't
  //     duplicate an existing index or exceed the intended depth.
  const nextLevelIndex = Math.max(...ladder.map((l) => l.levelIndex)) + 1;
  if (nextLevelIndex >= policy.maxScaleInLevels) return false;

  // (3) step-down: candidate must be ≥ scaleInStepPct below the most-recent level's entry
  const lastLevel = ladder.reduce((prev, cur) => (cur.levelIndex > prev.levelIndex ? cur : prev));
  const stepThreshold = lastLevel.buyPx * (1 - policy.scaleInStepPct);
  return buyPx <= stepThreshold;
}

/**
 * Compute and return the next ladder level as a pending MakerShadowOrder.
 * Returns null when shouldOpenNextLevel is false.
 * Called by the tracker in advanceMakerShadows when a step-down is detected.
 */
export function openNextLevelOrder(
  ladderState: { ladderId: string; levels: MakerShadowOrder[] },
  tokenId: string,
  conditionId: string,
  book: ShadowBook,
  policy: MakerEntryPolicy,
  nowIso: string,
): MakerShadowOrder | null {
  if (!shouldOpenNextLevel(ladderState.levels, book, policy)) return null;

  // Derive from max(levelIndex)+1 so a gap in the ladder (e.g. [0,2]) produces
  // index 3, not 2 (which would duplicate the existing level).
  const levelIndex = Math.max(...ladderState.levels.map((l) => l.levelIndex)) + 1;
  // Encode level index in the hash seed so concurrent openings at the same ms stay distinct.
  const shadowOrderId = computeShadowOrderId(tokenId, `${nowIso}:L${levelIndex}`);
  const buyPx = computeMakerEntryPrice(book.bestBid, book.tickSize, policy.bidImproveTicks);
  const harvestPx = computeHarvestTarget(buyPx, policy.harvestGainPct, book.tickSize);
  const fillDeadlineMs = Date.parse(nowIso) + policy.fillWaitMs;

  return {
    shadowOrderId,
    tokenId: tokenId as TokenId,
    conditionId,
    buyPx,
    harvestPx,
    postedAt: nowIso,
    fillDeadline: new Date(fillDeadlineMs).toISOString(),
    stage: "pending",
    fillKind: null,
    fillPx: null,
    markPx: null,
    netMark: null,
    ladderId: ladderState.ladderId,
    levelIndex,
    filledAt: null,
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
 *
 * `holdWindowMs` — post-fill hold window from policy; the mark deadline for
 * a filled level is `filled_at + holdWindowMs`, NOT the original fill_deadline.
 */
export function advanceShadowOrder(
  shadow: MakerShadowOrder,
  market: NormalizedMarket,
  nowIso: string,
  holdWindowMs: number,
): ShadowAdvanceOutcome {
  const bestBid = market.bestBid;
  const bestAsk = market.bestAsk;

  if (shadow.stage === "pending") {
    return advancePending(shadow, bestBid, bestAsk, nowIso);
  }
  if (shadow.stage === "filled") {
    return advanceFilled(shadow, bestBid, nowIso, holdWindowMs);
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
        filledAt: nowIso, // anchor the hold clock to the actual fill time
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
        filledAt: nowIso, // anchor the hold clock to the actual fill time
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
  holdWindowMs: number,
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

  // Mark: past the post-fill hold window.
  // Use filled_at + holdWindowMs; fall back to fillDeadline for pre-migration rows
  // that were backfilled with a proxy filled_at but no hold window semantics.
  const filledAtMs = shadow.filledAt ? Date.parse(shadow.filledAt) : null;
  const markDeadline =
    filledAtMs !== null ? new Date(filledAtMs + holdWindowMs).toISOString() : shadow.fillDeadline;

  if (nowIso >= markDeadline) {
    const markPx = bestBid ?? null;
    const netMark = markPx !== null ? markPx / shadow.buyPx - 1 : null;
    return {
      transition: true,
      update: { stage: "marked", markPx, netMark, updatedAt: nowIso },
    };
  }

  return { transition: false };
}

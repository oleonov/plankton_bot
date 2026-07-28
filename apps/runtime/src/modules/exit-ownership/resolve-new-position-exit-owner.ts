import type { ExecutionPolicy } from "@krabs/domain";

/**
 * Release A Phase 2 — decide a NEW position's sticky `exit_owner` at first fill.
 *
 * Returns "bounce" iff the position would be serviced by the tiered bounce-exit
 * ladder under the CURRENT policy (i.e. it MIRRORS today's bounce-exit routing so
 * the assignment is inert by default), else "profile" (today's complete non-bounce
 * exit stack — ProfileLadder / S1 / D8 / D9 / dust — unchanged).
 *
 * Bounce ⇔ ALL of:
 *  - bounceExit enabled AND mode === "micro_live";
 *  - eligibility: entryLane === "GATE" OR the sellable-flow cutoff is satisfied
 *    (mirrors `isBounceLadderEligiblePosition` in decision-planner.ts:767 for a
 *    fresh position: openedAt AND firstTradeAt both >= sellableFlow.appliesFromMs);
 *  - market in scope: conditionId whitelisted (whitelist ONLY, mirroring the
 *    planner today; the `applyToAllMarkets` broadening lands atomically in Phase 5).
 *
 * KEEP THE ELIGIBILITY CLAUSE IN SYNC with decision-planner.ts:767
 * (`isBounceLadderEligiblePosition`) — divergence would mis-assign ownership.
 */
export function resolveNewPositionExitOwner(
  input: {
    entryLane: "GATE" | "R23" | null;
    conditionId: string;
    openedAt: string;
    firstTradeAt: string;
  },
  policy: ExecutionPolicy | null | undefined,
): "bounce" | "profile" {
  const bounceExit = policy?.bounceExit;
  if (!bounceExit || bounceExit.enabled !== true || bounceExit.mode !== "micro_live") {
    return "profile";
  }
  if (!isFreshPositionBounceEligible(input, policy)) return "profile";
  // Release A Phase 5 — market scope. Owner assignment broadens to ALL markets when
  // `applyToAllMarkets` is set; otherwise it mirrors today's planner
  // (decision-planner.ts:1103) EXACTLY: whitelist membership only. Broadening OWNERSHIP
  // is sufficient because servicing is owner-authoritative (isBounceOwned) — the routing
  // that honors it follows automatically, so ownership never broadens ahead of servicing.
  const inScope =
    bounceExit.applyToAllMarkets === true ||
    bounceExit.whitelistConditionIds.includes(input.conditionId);
  return inScope ? "bounce" : "profile";
}

/**
 * Mirror of decision-planner.ts:767 `isBounceLadderEligiblePosition` for a
 * fresh position (we hold openedAt / firstTradeAt directly rather than a Position).
 */
function isFreshPositionBounceEligible(
  input: { entryLane: "GATE" | "R23" | null; openedAt: string; firstTradeAt: string },
  policy: ExecutionPolicy | null | undefined,
): boolean {
  if (input.entryLane === "GATE") return true;
  const sellableFlow = policy?.sellableFlow;
  if (!sellableFlow?.enabled || sellableFlow.appliesFromMs == null) return false;
  const openedAtMs = Date.parse(input.openedAt);
  const firstTradeAtMs = Date.parse(input.firstTradeAt);
  return (
    Number.isFinite(openedAtMs) &&
    openedAtMs >= sellableFlow.appliesFromMs &&
    Number.isFinite(firstTradeAtMs) &&
    firstTradeAtMs >= sellableFlow.appliesFromMs
  );
}

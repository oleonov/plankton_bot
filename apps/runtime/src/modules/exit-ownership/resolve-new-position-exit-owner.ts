import type { ExecutionPolicy } from "@krabs/domain";

import { isBounceLadderEligible } from "./bounce-eligibility.js";

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
 *  - eligibility: the shared `isBounceLadderEligible` predicate (§2.6) — the SAME
 *    function the planner and the census call, so ownership can no longer drift
 *    from servicing;
 *  - market in scope: conditionId whitelisted (whitelist ONLY, mirroring the
 *    planner today; the `applyToAllMarkets` broadening lands atomically in Phase 5).
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
  if (!isBounceLadderEligible(input, policy?.sellableFlow)) return "profile";
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

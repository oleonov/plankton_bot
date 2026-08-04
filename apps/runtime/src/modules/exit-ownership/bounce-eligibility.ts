import type { SellableFlowPolicy } from "@krabs/domain";

/**
 * Phase 4 bounce-for-all eligibility (docs/plans/2026-07-19-sellable-sizing-bounce-for-all.md):
 * GATE-lane positions are always eligible (unchanged pre-Phase-4 behavior); any other open
 * position becomes eligible only once sellableFlow is enabled AND only from its cutoff forward —
 * positions opened before `appliesFromMs` are pre-flagged and stay on the D8/D9 stack.
 *
 * Release A Phase 6 (§2.6): this was duplicated across decision-planner.ts,
 * algo-decision-module.ts and resolve-new-position-exit-owner.ts. The census is the 4th use site,
 * so the copies were collapsed here rather than a 4th one added: a divergent copy would mis-assign
 * IMMUTABLE ownership, the highest-risk failure mode of the phase.
 *
 * The signature is primitive on purpose — `{entryLane, openedAt, firstTradeAt}` plus the
 * `sellableFlow` policy alone. The census holds manifest rows, not a `Position` or a whole
 * `ExecutionPolicy`, and forcing it to synthesize one would be the fourth copy in another shape.
 */
export function isBounceLadderEligible(
  input: {
    /**
     * `string`, not the `"GATE" | "R23"` union, because only `"GATE"` is distinguished here and
     * `positions.entry_lane` is unconstrained TEXT. The census reads lanes straight out of the
     * ledger, and narrowing them at that call site would mean inventing a lane for any value the
     * union does not name — a fabricated input to an IMMUTABLE ownership decision.
     */
    entryLane: string | null | undefined;
    /**
     * Nullable for the same reason `firstTradeAt` is: §5.4.2's form gate maps a value this codebase
     * may not convert onto `null`, and the census passes the GATED value. The runtime's three call
     * sites always supply a string, so nothing there changes.
     */
    openedAt: string | null;
    firstTradeAt: string | null;
  },
  sellableFlow: SellableFlowPolicy | null | undefined,
): boolean {
  if (input.entryLane === "GATE") return true;
  if (!sellableFlow?.enabled || sellableFlow.appliesFromMs == null) return false;
  // Fail-closed cutoff (Codex audit r1): require BOTH `openedAt` AND the leg's real first-fill
  // time to be valid and >= cutoff. Startup adoption re-stamps `openedAt` to the adoption
  // wall-clock (inventory-handler createNewPosition), so `openedAt` alone can read post-cutoff for
  // a position actually first filled BEFORE the cutoff — checking `firstTradeAt` too keeps the
  // pre-flag positions (the operator's protected set) off bounce-for-all.
  const openedAtMs = input.openedAt != null ? Date.parse(input.openedAt) : NaN;
  const firstTradeAtMs = input.firstTradeAt != null ? Date.parse(input.firstTradeAt) : NaN;
  return (
    Number.isFinite(openedAtMs) &&
    openedAtMs >= sellableFlow.appliesFromMs &&
    Number.isFinite(firstTradeAtMs) &&
    firstTradeAtMs >= sellableFlow.appliesFromMs
  );
}

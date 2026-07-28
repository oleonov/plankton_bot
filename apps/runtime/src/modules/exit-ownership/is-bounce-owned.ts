import type { Position } from "@krabs/domain";

/**
 * Release A Phase 3 — the single owner-authoritative predicate.
 *
 * A position whose sticky `exit_owner` (decided once at its first BUY fill,
 * immutable) is `'bounce'` is serviced EXCLUSIVELY by the tiered bounce-exit
 * ladder. Every owner-authoritative servicing gate reads this instead of the
 * live policy flags, so disabling bounce / shrinking the whitelist / changing
 * the cutoff / restarting with the seeded-off default can never strand an
 * existing owner — it keeps being serviced until it closes.
 *
 * Null/undefined (unknown or pre-migration) → false (today's non-bounce stack).
 */
export function isBounceOwned(position: Position | null | undefined): boolean {
  return position?.exitOwner === "bounce";
}

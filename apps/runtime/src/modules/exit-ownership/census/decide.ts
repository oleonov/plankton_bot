import { parseExecutionPolicyJson, type ExecutionPolicy } from "@krabs/domain";

import { isBounceLadderEligible } from "../bounce-eligibility.js";
import type { CensusManifest, CensusTarget } from "./manifest.js";
import { isCanonicalTimestampForm } from "./timestamp-sql.js";

export type CensusOwner = "bounce" | "profile";

export interface CensusDecision {
  readonly positionId: string;
  readonly tokenId: string;
  readonly owner: CensusOwner;
  /** The AUTHORITATIVE `markets.condition_id` (§2.3) — NOT `positions.condition_id`. */
  readonly marketConditionId: string | null;
  /** Why this verdict, in the operator's words. §5.2(a) requires a reason per row. */
  readonly reason: string;
}

export interface CensusDecisionSet {
  readonly policy: ExecutionPolicy;
  /** Non-empty ⇒ §5.3's Parser gate blocks the run. Never silently adopted. */
  readonly policyIssues: readonly string[];
  readonly decisions: readonly CensusDecision[];
  readonly counts: { readonly bounce: number; readonly profile: number };
}

/**
 * §2.1 — the census decision, computed locally from the frozen manifest.
 *
 * Every conjunct is evaluated through the SAME code the runtime uses: the real
 * `parseExecutionPolicyJson` and the real extracted `isBounceLadderEligible` (§2.6). The point is not
 * convenience — a census that re-implemented either would assign IMMUTABLE ownership from a second
 * definition, which is the exact failure §2.6's extraction exists to prevent.
 *
 * `applyToAllMarkets` is deliberately NOT read (§2.5): it broadens the owner assigned to NEW positions,
 * and letting it into the census would retroactively move existing ones.
 *
 * The verdict here is compared against the manifest's independent SQL projection (§5.1.7) by §5.3's
 * cross-check gate. Nothing in this function is allowed to consult that projection — a decider that
 * looked at the answer it is being checked against would make the check vacuous.
 */
export function decideCensus(manifest: CensusManifest): CensusDecisionSet {
  const { policy, issues } = parseExecutionPolicyJson(manifest.policy.executionPolicyJson);
  const marketConditionByToken = new Map(
    manifest.targetMarkets.map((m) => [m.tokenId, m.marketConditionId]),
  );

  const decisions = manifest.targets.map((target) =>
    decideOne(target, marketConditionByToken.get(target.tokenId) ?? null, policy),
  );

  return {
    policy,
    policyIssues: issues,
    decisions,
    counts: {
      bounce: decisions.filter((d) => d.owner === "bounce").length,
      profile: decisions.filter((d) => d.owner === "profile").length,
    },
  };
}

function decideOne(
  target: CensusTarget,
  marketConditionId: string | null,
  policy: ExecutionPolicy,
): CensusDecision {
  const decision = (owner: CensusOwner, reason: string): CensusDecision => ({
    positionId: target.positionId,
    tokenId: target.tokenId,
    owner,
    marketConditionId,
    reason,
  });

  const { bounceExit, sellableFlow } = policy;
  if (!bounceExit.enabled) return decision("profile", "bounceExit.enabled = false");
  if (bounceExit.mode !== "micro_live") {
    return decision("profile", `bounceExit.mode = ${bounceExit.mode}`);
  }
  // The authoritative condition, per §2.3. An absent one is reported as such and never silently treated
  // as "not whitelisted" — §5.3's `Market condition — authoritative value absent` gate blocks the run on
  // it, and this reason is what tells the operator which row tripped it.
  if (marketConditionId == null || marketConditionId === "") {
    return decision("profile", "authoritative markets.condition_id absent");
  }
  if (!bounceExit.whitelistConditionIds.includes(marketConditionId)) {
    return decision("profile", "condition not in bounceExit.whitelistConditionIds");
  }
  const eligible = isBounceLadderEligible(
    {
      entryLane: target.entryLane,
      openedAt: formGated(target.openedAt),
      firstTradeAt: formGated(target.firstTradeAt),
    },
    sellableFlow,
  );
  if (!eligible) {
    return decision(
      "profile",
      refusedTimestamp(target)
        ? "not bounce-ladder eligible (non-canonical timestamp, §5.4.2)"
        : "not bounce-ladder eligible (lane/sellableFlow cutoff)",
    );
  }
  return decision(
    "bounce",
    target.entryLane === "GATE" ? "GATE lane, whitelisted" : "sellableFlow cutoff met, whitelisted",
  );
}

/**
 * §5.4.2 part 3 — the SQL projection's form gate, applied here BEFORE `Date.parse` ever sees the value.
 *
 * Without it the census verdict depends on the operator's `TZ`: `Date.parse` reads the offset-less and
 * space-separated shapes production really carries as LOCAL time while SQLite reads them as UTC, so the
 * same ledger decides differently on two machines — for an IMMUTABLE owner.
 *
 * The FORM half only, never `isCanonicalTimestamp`. Its calendar half must stay absent on this side:
 * `2026-02-30T10:00:00.000Z` passes the GLOB and fails the calendar, so SQL refuses it while TS parses
 * it, and the disagreement surfaces as a §5.3 cross-check MISMATCH at dry run. Gating it here too would
 * make both sides say `profile`, pass the cross-check, and move the abort to guard #7b under the lock —
 * the one outcome the dry-run/apply split exists to prevent (see `timestamp-sql.ts`).
 */
function formGated(ts: string | null): string | null {
  return isCanonicalTimestampForm(ts) ? ts : null;
}

/**
 * True when the gate refused a value the ledger ACTUALLY carries — as opposed to a legitimately absent
 * `leg_states` row, which is §2.2's branch and not a defect. §5.2(a) wants the operator to be able to
 * tell "past the cutoff" from "this row needs fixing" without re-reading the ledger.
 */
function refusedTimestamp(target: CensusTarget): boolean {
  return (
    formGated(target.openedAt) === null ||
    (target.firstTradeAt !== null && formGated(target.firstTradeAt) === null)
  );
}

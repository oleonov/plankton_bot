import type { CensusDecisionArtifact } from "./decision-artifact.js";
import type { CensusManifest } from "./manifest.js";

/**
 * §9 check (c) — clauses 2–5 of `--verify-owner-map`, the last gate between the mandated restart and live
 * routing.
 *
 * These four are the RELATIONAL clauses: each needs the frozen manifest, the fresh manifest and the decision
 * artifact at once, which is why they cannot live in either loader. Clause 1 (both digests) is the loaders'
 * — see `decision-artifact.ts`.
 *
 * Nothing here throws on the first failure: the operator is mid-window with immutable owners already
 * written, so the report must name EVERY offending `positionId` with expected vs actual in one pass rather
 * than one per re-run.
 */

export type VerifyClause = 2 | 3 | 4 | 5;

export interface VerifyOwnerMapFailure {
  readonly clause: VerifyClause;
  readonly message: string;
}

export interface VerifyOwnerMapReport {
  readonly ok: boolean;
  /** The frozen manifest's target cardinality — read at run time, never hardcoded (§4). */
  readonly targetCount: number;
  readonly failures: readonly VerifyOwnerMapFailure[];
}

export interface VerifyOwnerMapInput {
  readonly frozen: CensusManifest;
  readonly fresh: CensusManifest;
  readonly decision: CensusDecisionArtifact;
}

/** Which §5.1 projection of the fresh manifest a row was found in, and the RAW owner it carries there. */
interface FreshOwnerEntry {
  readonly projection: string;
  readonly exitOwner: string | null;
}

export function verifyOwnerMap(input: VerifyOwnerMapInput): VerifyOwnerMapReport {
  const { frozen, fresh, decision } = input;
  const failures: VerifyOwnerMapFailure[] = [];
  const add = (clause: VerifyClause, message: string): void => {
    failures.push({ clause, message });
  };

  const expectedIds = new Set(frozen.targets.map((t) => t.positionId));
  checkTargetSet(decision, expectedIds, add);

  const freshOwners = buildFreshOwnerMap(fresh, add);
  for (const { positionId, expectedOwner } of decision.owners) {
    const entry = freshOwners.get(positionId);
    if (entry === undefined) {
      add(3, missingPositionMessage(positionId));
      continue;
    }
    // RAW, not effective: no COALESCE, no projection binding. The question is what the ledger holds, not
    // what a remediation would make it hold.
    if (entry.exitOwner !== expectedOwner) {
      add(
        4,
        `${positionId}: expected exit_owner ${expectedOwner}, ledger holds ` +
          `${entry.exitOwner === null ? "NULL" : entry.exitOwner} (in ${entry.projection})`,
      );
    }
  }

  if (fresh.targets.length > 0) {
    add(
      5,
      `the fresh manifest still has ${fresh.targets.length} target(s) — ` +
        `NULL-owner nonclosed positions remain: ${listIds(fresh.targets.map((t) => t.positionId))}`,
    );
  }

  return { ok: failures.length === 0, targetCount: expectedIds.size, failures };
}

/**
 * Clause 2 — set EQUALITY against the frozen manifest's targets, in both directions, plus uniqueness, plus
 * `targetCount` cross-checked against that cardinality rather than against the artifact's own claim about
 * itself. v11 compared `owners.length` to `decision.targetCount`, so an artifact declaring `targetCount: 1`
 * with one correct owner passed while every other position was never looked at.
 */
function checkTargetSet(
  decision: CensusDecisionArtifact,
  expectedIds: ReadonlySet<string>,
  add: (clause: VerifyClause, message: string) => void,
): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const extra: string[] = [];
  for (const { positionId } of decision.owners) {
    if (seen.has(positionId)) duplicates.push(positionId);
    seen.add(positionId);
    if (!expectedIds.has(positionId)) extra.push(positionId);
  }
  const missing = [...expectedIds].filter((id) => !seen.has(id));

  if (duplicates.length > 0) {
    add(2, `the decision artifact repeats ${listIds(duplicates)}`);
  }
  if (extra.length > 0) {
    add(2, `the decision artifact carries ${listIds(extra)}, absent from the frozen target set`);
  }
  if (missing.length > 0) {
    add(2, `the decision artifact is missing ${listIds(missing)} from the frozen target set`);
  }
  if (decision.targetCount !== expectedIds.size) {
    add(
      2,
      `decision.targetCount is ${decision.targetCount} but the frozen manifest has ` +
        `${expectedIds.size} target(s)`,
    );
  }
}

/**
 * The fresh manifest's owner map: the UNION of §5.1.2's all-nonclosed projection and §5.1.9's owned-closed
 * one. Not §5.1.2 alone — resting SELLs keep filling while the bot is paused, and a fill that takes size to
 * zero flips the row to `closed` (`inventory-handler.ts:293-295`). Such a row still carries the immutable
 * owner the census wrote; reading only the nonclosed projection reports that normal exit as a deletion.
 *
 * The two are disjoint by predicate (`status <> 'closed'` vs `status = 'closed'`), so an id in both means
 * the manifest contradicts itself and clause 4 would be reading an arbitrary one of the two.
 */
function buildFreshOwnerMap(
  fresh: CensusManifest,
  add: (clause: VerifyClause, message: string) => void,
): Map<string, FreshOwnerEntry> {
  const map = new Map<string, FreshOwnerEntry>();
  const put = (positionId: string, entry: FreshOwnerEntry): void => {
    const existing = map.get(positionId);
    if (existing !== undefined) {
      add(
        3,
        `${positionId} appears in both ${existing.projection} and ${entry.projection} — ` +
          "the two projections are disjoint by predicate, so this manifest contradicts itself",
      );
      return;
    }
    map.set(positionId, entry);
  };

  for (const row of fresh.nonclosedPositions) {
    put(row.positionId, { projection: "nonclosed_positions", exitOwner: row.exitOwner });
  }
  for (const row of fresh.ownedClosedPositions) {
    put(row.positionId, { projection: "owned_closed_positions", exitOwner: row.exitOwner });
  }
  return map;
}

/**
 * Absence from BOTH projections has two producers, not one, and they are different incidents: the adoption
 * `DELETE` (`startup-position-adoption.ts:775-776`) removed the row, or an `--apply` that aborted left the
 * owner NULL and the position then closed inside the window — closed and NULL is excluded from §5.1.2 for
 * being closed and from §5.1.9 for being unowned. One read-only query separates them.
 */
function missingPositionMessage(positionId: string): string {
  return (
    `${positionId} is absent from BOTH nonclosed_positions and owned_closed_positions. ` +
    `Run: SELECT status, exit_owner FROM positions WHERE position_id = '${positionId}'; ` +
    "— no row means startup adoption DELETEd it; a closed/NULL row means the apply never " +
    "committed for that target."
  );
}

function listIds(ids: readonly string[]): string {
  return ids.join(", ");
}

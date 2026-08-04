import {
  OWNERSHIP_INVARIANT_GUARD_SQL,
  PROJECTED_OWNERS_CREATE_SQL,
  type OwnershipInvariantId,
} from "@krabs/db";

import type { CensusDecision, CensusDecisionSet } from "./decide.js";
import { PRODUCTION_CONTROL_DB_PATH, ownerProjectionSql, realString } from "./export-sql.js";
import type { CensusManifest, CensusTarget } from "./manifest.js";
import { sqlNullableString, sqlString } from "./sql-literal.js";
import { malformedTimestampSql, rolloverTimestampSql } from "./timestamp-sql.js";

/**
 * §5.2 / §5.4 / §5.5 — the three artifacts one dry run emits from one frozen manifest.
 *
 * **All three, or none (v23, review Major 4).** `<manifest>.apply.sql` performs the write;
 * `<manifest>.postverify.sql` is the `0|0|0` comparison §9's step 7 runs after the immutable `COMMIT`;
 * `<manifest>.postverify-detail.sql` prints the rows behind a non-`0|0|0` line. A generator that emitted
 * only the first passed every local test and then failed on the production host at the one step that runs
 * after the writes are already permanent. They encode the same target set, so any path by which they could
 * disagree is a path by which the post-verify stops meaning anything — hence one function, one manifest.
 *
 * The apply script is a TRANSPORT, not a second definition. The invariant predicates arrive verbatim from
 * `OWNERSHIP_INVARIANT_GUARD_SQL` and the owner re-derivation from `ownerProjectionSql`, because the one
 * failure this whole phase exists to prevent is two definitions of ownership disagreeing after the write
 * can no longer be undone.
 *
 * Two properties of the runbook are what make the guards mean anything, and neither lives in this file:
 * the script MUST be run under `sqlite3 -bail` (§5.4.1 A — without it an erroring statement is merely
 * reported and the trailing `COMMIT` persists a partial census), and the ledger MUST be `main` with
 * `control.db` ATTACHed (§5.4 — `BEGIN IMMEDIATE` then locks the ledger first, matching `profiles.ts`).
 */

/** §5.4.1 C — the guard inventory, in emission order. #9 is first: every other guard's set is defined
 * in terms of the status domain it fences. */
export const CENSUS_GUARD_IDS = [
  "9",
  "1b",
  "1",
  "2",
  "3",
  "3b",
  "4",
  "5",
  "6",
  "7",
  "7b",
  "8",
] as const;

export interface CensusArtifacts {
  /** `<manifest>.apply.sql` — the write, under one transaction and twelve guards. */
  readonly applySql: string;
  /** `<manifest>.postverify.sql` — three counts, compared against the literal `0|0|0`. */
  readonly postverifySql: string;
  /** `<manifest>.postverify-detail.sql` — the same three failure modes as rows, for a human mid-incident. */
  readonly postverifyDetailSql: string;
}

/** The one profile the census fences. `profile_settings` is keyed by `profile_id`, not `profile`. */
const LIVE_LITE_PROFILE_ID = "live-lite";

/** §5.1.1's one-way TARGET set — enumerated, and provably equal to `<> 'closed'` only because #9 ran. */
const TARGET_STATUSES = "('open', 'dust')";

/**
 * @param controlDbPath emitted LITERALLY into the `ATTACH` — the shell does not expand variables inside a
 * file `sqlite3` reads. Parameterized only so §7's tests can attach a temp control DB; production gets the
 * default, and §7 test 12 greps the emitted line to prove it equals the `[ -s "$CONTROL" ]` guard's path.
 */
export function generateCensusArtifacts(
  manifest: CensusManifest,
  decision: CensusDecisionSet,
  controlDbPath: string = PRODUCTION_CONTROL_DB_PATH,
): CensusArtifacts {
  const targets = joinTargets(manifest, decision);
  return {
    applySql: buildApplySql(manifest, targets, controlDbPath),
    postverifySql: buildPostverifySql(targets),
    postverifyDetailSql: buildPostverifyDetailSql(targets),
  };
}

/** One manifest target plus the owner this run decided for it — the row shape every artifact emits. */
interface PlannedTarget {
  readonly target: CensusTarget;
  readonly decision: CensusDecision;
}

function joinTargets(manifest: CensusManifest, decision: CensusDecisionSet): PlannedTarget[] {
  const byPositionId = new Map(decision.decisions.map((d) => [d.positionId, d]));
  return manifest.targets.map((target) => {
    const decided = byPositionId.get(target.positionId);
    // Unreachable through `decideCensus` (it maps over the same array), and fatal if it ever were:
    // a target with no owner would be silently dropped from the script and left NULL by a run that
    // reports success. Refusing to emit is the only safe disposition for a one-way write.
    if (decided === undefined) {
      throw new Error(`no census decision for manifest target ${target.positionId}`);
    }
    return { target, decision: decided };
  });
}

// ───────────────────────────── apply ─────────────────────────────

function buildApplySql(
  manifest: CensusManifest,
  targets: readonly PlannedTarget[],
  controlDbPath: string,
): string {
  return [
    applyHeader(controlDbPath),
    tempTables(targets),
    guards(manifest),
    casUpdates(targets),
    guard8(),
    "COMMIT;",
    "",
  ].join("\n\n");
}

function applyHeader(controlDbPath: string): string {
  return `-- Release A Phase 6 — exit-owner census apply (§5.4). ONE-WAY, LIVE-MONEY WRITE.
-- MUST be run as: sqlite3 -bail "$LEDGER" < <this file>
-- Without -bail the CLI reports an error and KEEPS GOING, so a failed guard would be followed by the
-- trailing COMMIT and a partial census would be persisted (§5.4.1 A, measured on 3.37.2).
ATTACH DATABASE ${sqlString(controlDbPath)} AS ctl;
-- One statement, both write locks; \`main\` (= the ledger) is locked first, which is the same order the
-- one shipped dual-lock path takes (profiles.ts:694 → :708). control.db is never written — it is locked
-- purely as the policy fence, so no cross-database atomicity is required or claimed.
BEGIN IMMEDIATE;`;
}

function tempTables(targets: readonly PlannedTarget[]): string {
  return `-- §5.4.1 B — the abort primitive. A guard that inserts 0 violates the CHECK, -bail exits, and the
-- open transaction rolls back. \`RAISE(ABORT,…)\` is trigger-only, and a plain script has no IF.
CREATE TEMP TABLE census_guard(ok INT NOT NULL CHECK(ok = 1));

-- The manifest, as a table, so every guard can be one set-level scalar over it.
CREATE TEMP TABLE manifest_targets(
  position_id         TEXT PRIMARY KEY,
  token_id            TEXT NOT NULL,
  status              TEXT NOT NULL,
  -- §5.1.10 — the RENDERED size, not the number: sqlite 3.37.2 cannot re-read its own float rendering as
  -- the same double (19.6% of values), so guard #3 compares the rendering on both sides instead.
  size                TEXT NOT NULL,
  condition_id        TEXT,
  opened_at           TEXT NOT NULL,
  entry_lane          TEXT,
  market_condition_id TEXT,
  first_trade_at      TEXT,
  owner               TEXT NOT NULL
);
${insertManifestTargets(targets)}

-- §9a.2 — guard #5 reads this. effective_owner(p) falls back to it for a still-NULL exit_owner, so the
-- run's own targets stop counting as unowned while a NULL-owner row the manifest does NOT cover still
-- does. Populated BEFORE guard #5; without it every invariant entry errors and --apply can never commit.
${PROJECTED_OWNERS_CREATE_SQL};
${insertProjectedOwners(targets)}`;
}

function insertManifestTargets(targets: readonly PlannedTarget[]): string {
  const values = targets.map(
    ({ target: t, decision: d }) =>
      `  (${sqlString(t.positionId)}, ${sqlString(t.tokenId)}, ${sqlString(t.status)}, ` +
      `${sqlString(t.size)}, ${sqlString(t.conditionId)}, ${sqlString(t.openedAt)}, ` +
      `${sqlNullableString(t.entryLane)}, ${sqlNullableString(d.marketConditionId)}, ` +
      `${sqlNullableString(t.firstTradeAt)}, ${sqlString(d.owner)})`,
  );
  return `INSERT INTO manifest_targets
  (position_id, token_id, status, size, condition_id, opened_at, entry_lane,
   market_condition_id, first_trade_at, owner)
VALUES
${values.join(",\n")};`;
}

function insertProjectedOwners(targets: readonly PlannedTarget[]): string {
  const values = targets.map(
    ({ decision: d }) => `  (${sqlString(d.positionId)}, ${sqlString(d.owner)})`,
  );
  return `INSERT INTO projected_owners (position_id, owner)
VALUES
${values.join(",\n")};`;
}

function guards(manifest: CensusManifest): string {
  return [
    guard9(),
    guard1b(),
    guard1(manifest),
    guard2(),
    guard3(),
    guard3b(),
    guard4(),
    guard5(),
    guard6(),
    guard7(),
    guard7b(),
  ].join("\n\n");
}

/**
 * Each guard is one `INSERT INTO census_guard(ok)` over a boolean. `<>` is banned throughout: a NULL on
 * either side yields NULL, the row drops out of the `WHERE`, and the mismatch passes SILENTLY — so every
 * comparison is `IS NOT` and every predicate counts the rows that FAIL.
 */
function guard(id: string, title: string, body: string): string {
  return `-- guard #${id} — ${title}\nINSERT INTO census_guard(ok)\n${body};`;
}

function guard9(): string {
  // FIRST, because every other guard's set is defined in terms of it: the target set is the enumerated
  // ('open','dust') while every detector reads <> 'closed', and a fourth status makes the two disagree at
  // the moment of a one-way write. `NOT IN` is sound only because `status` is NOT NULL (ledger.sql:283).
  return guard(
    "9",
    "status domain fence",
    `SELECT COUNT(*) = 0 FROM positions WHERE status NOT IN ('open', 'dust', 'closed')`,
  );
}

function guard1b(): string {
  // Runs BEFORE #1: an equality fence over zero rows is satisfied vacuously, i.e. the run's single most
  // load-bearing precondition silently absent. `profile_settings` is a child of `profiles`, so the row is
  // deletable, and `execution_policy_json` is a nullable TEXT (migration 038).
  return guard(
    "1b",
    "execution policy row exists exactly once, non-NULL",
    `SELECT COUNT(*) = 1 FROM ctl.profile_settings
 WHERE profile_id = ${sqlString(LIVE_LITE_PROFILE_ID)} AND execution_policy_json IS NOT NULL`,
  );
}

function guard1(manifest: CensusManifest): string {
  // The fence is over the TEXT itself, not a digest: the CLI ships no sha256(). With the row present,
  // `IS NOT` already handles a NULL value correctly — only the MISSING row is invisible, and #1b owns it.
  return guard(
    "1",
    "policy fence — live text equals the manifest's, byte for byte",
    `SELECT COUNT(*) = 0 FROM ctl.profile_settings
 WHERE profile_id = ${sqlString(LIVE_LITE_PROFILE_ID)}
   AND execution_policy_json IS NOT ${sqlNullableString(manifest.policy.executionPolicyJson)}`,
  );
}

function guard2(): string {
  // The EXCEPT form is DIRECTIONAL: it catches ARRIVALS only — a NULL-owner row created between export
  // and lock (startup adoption omits the owner resolver, `startup-position-adoption.ts:142`). A DEPARTURE
  // is absent from the left-hand set and is invisible here; #3/#8's manifest-driven LEFT JOIN owns it.
  return guard(
    "2",
    "target-set completeness — no arrival outside the manifest",
    `SELECT NOT EXISTS (
  SELECT position_id FROM positions WHERE exit_owner IS NULL AND status IN ${TARGET_STATUSES}
  EXCEPT
  SELECT position_id FROM manifest_targets
)`,
  );
}

/**
 * The manifest is the authority on what MUST exist, so this walks IT and joins LEFT. An inner join
 * restricts the guard to the SURVIVORS: a target whose position vanished contributes no joined row, the
 * guard passes, and the remaining CASes commit a partial census (measured — §5.4.1's v7 Critical #1).
 *
 * `exit_owner` is deliberately NOT compared here. A target already sitting at its expected owner is an
 * idempotent re-run, which §5.4 requires to be a clean no-op; a target at a DIFFERENT owner is caught by
 * guard #8 after its CAS changes zero rows.
 */
function guard3(): string {
  return guard(
    "3",
    "per-input equality over every routing input",
    `SELECT COUNT(*) = 0 FROM manifest_targets m
  LEFT JOIN positions  p  USING (position_id)
  LEFT JOIN markets    k  ON k.token_id = p.token_id
  LEFT JOIN leg_states ls ON ls.token_id = p.token_id
 WHERE p.position_id     IS NULL
    OR p.token_id        IS NOT m.token_id
    OR p.status          IS NOT m.status
    OR ${realString("p.size")} IS NOT m.size
    OR p.condition_id    IS NOT m.condition_id
    OR p.opened_at       IS NOT m.opened_at
    OR p.entry_lane      IS NOT m.entry_lane
    OR k.condition_id    IS NOT m.market_condition_id
    OR ls.first_trade_at IS NOT m.first_trade_at`,
  );
}

function guard3b(): string {
  // Equality is a DRIFT check and cannot be made into a PRESENCE check: an authoritative condition
  // missing at BOTH times compares equal and #3 passes. `markets` is UPSERTed continuously and both
  // mappers manufacture '' from a missing upstream field (`mappers.ts:248`, `:382`).
  return guard(
    "3b",
    "authoritative market condition present for every target",
    `SELECT COUNT(*) = 0 FROM manifest_targets m
  LEFT JOIN positions p USING (position_id)
  LEFT JOIN markets   k ON k.token_id = p.token_id
 WHERE k.token_id IS NULL OR k.condition_id IS NULL OR k.condition_id = ''`,
  );
}

/**
 * §5.4 step 3 — the order-evidence re-check, in the two halves §5.3 splits it into. Startup adoption can
 * manufacture synthetic order evidence between export and lock, so this is re-asserted rather than trusted
 * from the manifest, and the legacy absent-evidence class of §2.3 is FILTERED rather than exempted:
 * empty/NULL order values contribute nothing, and what remains must corroborate.
 *
 * One guard, two halves — the inventory has a single row #4, so the offending rows are UNIONed.
 */
function guard4(): string {
  return guard(
    "4",
    "order-evidence re-check (populated + absent-evidence halves)",
    `SELECT COUNT(*) = 0 FROM (
  -- (a) a POPULATED positions.condition_id contradicted by its token's populated order evidence
  SELECT m.position_id
    FROM manifest_targets m
    LEFT JOIN positions p USING (position_id)
   WHERE COALESCE(p.condition_id, '') IS NOT ''
     AND EXISTS (SELECT 1 FROM orders o
                  WHERE o.token_id = p.token_id
                    AND COALESCE(o.condition_id, '') IS NOT ''
                    AND o.condition_id IS NOT p.condition_id)
  UNION ALL
  -- (b) the absent-evidence class: the populated evidence must EXIST, be UNAMBIGUOUS, and equal the
  --     authoritative markets.condition_id. A vanished target lands here too (its condition reads NULL)
  --     and is counted, which agrees with #3 rather than substituting for it.
  SELECT position_id FROM (
    SELECT m.position_id AS position_id,
           k.condition_id AS market_condition_id,
           (SELECT COUNT(DISTINCT o.condition_id) FROM orders o
             WHERE o.token_id = p.token_id AND COALESCE(o.condition_id, '') IS NOT '')
             AS populated_evidence_values,
           (SELECT MIN(o.condition_id) FROM orders o
             WHERE o.token_id = p.token_id AND COALESCE(o.condition_id, '') IS NOT '')
             AS evidence
      FROM manifest_targets m
      LEFT JOIN positions p USING (position_id)
      LEFT JOIN markets   k ON k.token_id = p.token_id
     WHERE COALESCE(p.condition_id, '') IS ''
  ) WHERE populated_evidence_values IS NOT 1 OR evidence IS NOT market_condition_id
)`,
  );
}

/**
 * §9a.2 supplies the SQL verbatim — there is no second place an invariant is written, and the six entries
 * are mechanically `SELECT COUNT(*) = 0 AS ok FROM (<the row SQL>)`. All six are emitted, `nullOwners`
 * included: with `projected_owners` populated it agrees with guard #2 (a NULL-owner row the manifest does
 * not cover still counts) rather than substituting for it.
 *
 * Recomputed from CURRENT rows, never trusted from the manifest — §5.6 concedes that fills and
 * reconciliation continue while the runtime is down, so export-time invariants are stale by construction.
 */
function guard5(): string {
  return OWNERSHIP_INVARIANT_GUARD_SQL.map(({ id, sql }) =>
    guard("5", `ownership invariant ${invariantLabel(id)}`, sql),
  ).join("\n\n");
}

function invariantLabel(id: OwnershipInvariantId): string {
  return id === "nullOwners" ? id : `${INVARIANT_NUMBER[id]} (${id})`;
}

const INVARIANT_NUMBER: Record<Exclude<OwnershipInvariantId, "nullOwners">, string> = {
  unboundSells: "I1",
  stalePointerSells: "I2",
  overcommittedTokens: "I3",
  duplicateNonclosedTokens: "I4",
  wrongOwnerSells: "I5",
};

/**
 * §5.4 step 5 — the decision, re-derived from the rows read under the lock, must equal the planned owner.
 * The projection text is `ownerProjectionSql`, the SAME one the export computed `sql_owner_projection`
 * from, bound here to live aliases: a second copy would let the apply commit an owner the dry run's
 * cross-check never saw.
 *
 * The policy is read LIVE rather than from the manifest — that is the whole point of re-deriving. The
 * `CROSS JOIN` would make this vacuous over zero policy rows, which is exactly the shape guard #1b has
 * already refused by the time this runs.
 */
function guard6(): string {
  const derived = ownerProjectionSql({
    policyText: "pol.txt",
    marketConditionId: "k.condition_id",
    entryLane: "p.entry_lane",
    openedAt: "p.opened_at",
    firstTradeAt: "ls.first_trade_at",
  });
  return guard(
    "6",
    "re-derived decision equals the planned owner",
    `SELECT COUNT(*) = 0 FROM (
  SELECT m.owner AS planned_owner,
         ${derived} AS derived_owner
    FROM manifest_targets m
    LEFT JOIN positions  p  USING (position_id)
    LEFT JOIN markets    k  ON k.token_id = p.token_id
    LEFT JOIN leg_states ls ON ls.token_id = p.token_id
    CROSS JOIN (SELECT execution_policy_json AS txt FROM ctl.profile_settings
                 WHERE profile_id = ${sqlString(LIVE_LITE_PROFILE_ID)}) pol
) WHERE derived_owner IS NOT planned_owner`,
  );
}

/**
 * §5.4.2 — the guards range over THE TIMESTAMPS THE CONVERSION IS ACTUALLY APPLIED TO: `opened_at` for
 * every surviving target, and `first_trade_at` only through an INNER JOIN to `leg_states`. A LEFT JOIN
 * here would manufacture a NULL row for a target with no leg state, and §2.2 rules that such a target is
 * valid and still gets an owner — so the sellable-flow branch is never taken, no conversion happens, and
 * there is nothing to gate. That INNER JOIN is the whole of the fix.
 */
const CONVERTED_TIMESTAMPS_SQL = `  SELECT p.opened_at AS ts
    FROM manifest_targets m JOIN positions p USING (position_id)
  UNION ALL
  SELECT ls.first_trade_at AS ts
    FROM manifest_targets m
    JOIN positions  p  USING (position_id)
    JOIN leg_states ls ON ls.token_id = p.token_id`;

function guard7(): string {
  // GLOB proves SHAPE. It is not optional: the pinned `strftime`+`substr` conversion reads bytes 21–23
  // blindly, so an explicit offset would be silently ignored (by 7 200 000 ms for `+02:00`), and an
  // offset-less value would read UTC in SQLite and LOCAL in `Date.parse`. `ts IS NULL` is a fail-closed
  // backstop: `leg_states.first_trade_at` is TEXT NOT NULL today, so it guards a schema-forbidden shape.
  return guard(
    "7",
    "timestamp form gate",
    `SELECT COUNT(*) = 0 FROM (
${CONVERTED_TIMESTAMPS_SQL}
) WHERE ${malformedTimestampSql("ts")}`,
  );
}

function guard7b(): string {
  // GLOB proves shape, never VALIDITY: `2026-01-01T24:01:00.000Z` passes it, converts fine in SQLite and
  // is NaN in JS. The round trip must go THROUGH the computed epoch — the shorter form echoes `24:01`
  // back unchanged and the bad row passes (measured on 3.37.2). `IS NOT` also counts the `12:60` row,
  // where `strftime` yields NULL.
  return guard(
    "7b",
    "timestamp calendar gate",
    `SELECT COUNT(*) = 0 FROM (
${CONVERTED_TIMESTAMPS_SQL}
) WHERE ${rolloverTimestampSql("ts")}`,
  );
}

/**
 * The per-row compare-and-swap. `AND exit_owner IS NULL` alone proves nothing about equivalence — the
 * in-transaction re-derivation above and guard #8 below are what close that; the CAS is what makes each
 * row's write conditional on the state it was decided from.
 *
 * `IS` rather than `=` on every compared column, so a NULL `entry_lane` compares correctly instead of
 * yielding NULL and matching nothing.
 */
function casUpdates(targets: readonly PlannedTarget[]): string {
  const statements = targets.map(
    ({ target: t, decision: d }) => `UPDATE positions SET exit_owner = ${sqlString(d.owner)}
 WHERE position_id = ${sqlString(t.positionId)}
   AND exit_owner IS NULL
   AND status IN ${TARGET_STATUSES}
   AND condition_id IS ${sqlString(t.conditionId)}
   AND opened_at   IS ${sqlString(t.openedAt)}
   AND entry_lane  IS ${sqlNullableString(t.entryLane)};`,
  );
  return `-- §5.4 — the compare-and-swap, one statement per target (${targets.length} rows).\n${statements.join("\n")}`;
}

/**
 * §5.4 "Accounting", as a GUARD rather than a bare `SELECT` (v6). A target that acquired a different
 * non-NULL owner before the lock makes its own CAS change ZERO rows while every other one succeeds; a
 * re-read that is only READ raises no SQLite error, so `-bail` never fires and `COMMIT` persists the rest.
 * Detection has to become a failing statement to be an abort.
 *
 * The cardinality half is deliberately redundant with the `LEFT JOIN` half: forms (i) and (ii) of §5.4.1
 * are directional opposites, and only together do they pin the set. Aggregate counts alone are explicitly
 * insufficient — they mask two rows with swapped owners — so the map is per-`position_id`.
 */
function guard8(): string {
  return guard(
    "8",
    "post-UPDATE owner map + accounting + manifest cardinality",
    `SELECT (SELECT COUNT(*) FROM manifest_targets m LEFT JOIN positions p USING (position_id)
          WHERE p.position_id IS NULL
             OR p.exit_owner IS NOT m.owner
             OR p.status IS NOT m.status) = 0
   AND (SELECT COUNT(*) FROM manifest_targets m JOIN positions p USING (position_id))
     = (SELECT COUNT(*) FROM manifest_targets)`,
  );
}

// ───────────────────────────── post-verify ─────────────────────────────

/**
 * §5.5 — `N` never appears as a literal. The target rows are emitted verbatim from the frozen manifest and
 * every count is taken over them, which is what makes the cardinality half of D7 true by construction
 * rather than by the operator retyping a number.
 *
 * `temp_store=MEMORY` because these run under `-readonly` on the live 31.9 GB ledger: a read-only open
 * must need no scratch file on the host (measured to work on production 3.37.2).
 */
function postverifyPreamble(targets: readonly PlannedTarget[]): string {
  const values = targets.map(
    ({ decision: d }) => `  (${sqlString(d.positionId)}, ${sqlString(d.owner)})`,
  );
  return `PRAGMA temp_store=MEMORY;
CREATE TEMP TABLE manifest_targets(position_id TEXT PRIMARY KEY, owner TEXT NOT NULL);
INSERT INTO manifest_targets (position_id, owner)
VALUES
${values.join(",\n")};`;
}

function buildPostverifySql(targets: readonly PlannedTarget[]): string {
  // The three columns are the three failure modes, in order: a nonclosed row still unowned, a censused
  // row whose owner is not the planned one, and a censused row that VANISHED — the DELETE case
  // (`startup-position-adoption.ts:775`), which the immutability trigger does not cover.
  // `IS NOT`, never `<>`: against a NULL `exit_owner` the row would drop out of the count and column 2
  // would be blind to exactly the rows column 1 exists to catch.
  return `-- Release A Phase 6 — post-verify (§5.5). READ-ONLY: no BEGIN, no write.
-- Run as: sqlite3 -bail -readonly "$LEDGER" < <this file>   → the ONLY accepted output is 0|0|0
${postverifyPreamble(targets)}
.mode list
.separator |
SELECT
  (SELECT COUNT(*) FROM positions WHERE exit_owner IS NULL AND status <> 'closed'),
  (SELECT COUNT(*) FROM manifest_targets t JOIN positions p USING (position_id)
     WHERE p.exit_owner IS NOT t.owner),
  (SELECT COUNT(*) FROM manifest_targets t
     WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.position_id = t.position_id));
`;
}

function buildPostverifyDetailSql(targets: readonly PlannedTarget[]): string {
  // Prints ROWS, so it is never compared — it runs only after the counting query has already failed. The
  // three `klass` values are the three counted columns in the same order, so a `2|0|1` line and the rows
  // below it cannot disagree about which failure mode fired. `.mode line` because a human reads this
  // mid-incident, with immutable writes already committed.
  return `-- Release A Phase 6 — post-verify DIAGNOSIS (§5.5). READ-ONLY: no BEGIN, no write.
-- Run ONLY when the counting query returned something other than 0|0|0.
${postverifyPreamble(targets)}
.mode line
SELECT 'unowned' AS klass, position_id, token_id, status, opened_at
  FROM positions WHERE exit_owner IS NULL AND status <> 'closed';
SELECT 'wrong-owner' AS klass, t.position_id, t.owner AS planned, p.exit_owner AS actual, p.status
  FROM manifest_targets t JOIN positions p USING (position_id) WHERE p.exit_owner IS NOT t.owner;
SELECT 'vanished' AS klass, t.position_id, t.owner AS planned
  FROM manifest_targets t
 WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.position_id = t.position_id);
`;
}

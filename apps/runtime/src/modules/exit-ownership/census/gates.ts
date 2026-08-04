import { createHash } from "node:crypto";

import {
  OWNERSHIP_INVARIANT_ROW_SQL,
  type OwnershipInvariantId,
  type OwnershipInvariantViolations,
} from "@krabs/db";

import type { CensusDecisionSet } from "./decide.js";
import type { CensusManifest } from "./manifest.js";
import {
  CANONICAL_TIMESTAMP_GLOB,
  isCanonicalTimestampCalendar,
  isCanonicalTimestampForm,
} from "./timestamp-sql.js";

export interface CensusGate {
  readonly id: string;
  /** The §5.3 table's row label, so the report and the plan can be read side by side. */
  readonly title: string;
  /** `false` for the two rows §5.3 marks non-blocking — stated, never inferred from `passed`. */
  readonly blocking: boolean;
  readonly passed: boolean;
  /** The rows that made it fail — or, for a measurement row, the rows it counted. */
  readonly offending: ReadonlyArray<Record<string, unknown>>;
  readonly note?: string | undefined;
}

export interface CensusGateReport {
  readonly gates: readonly CensusGate[];
  /** True iff some BLOCKING gate failed. `--apply` is refused while this holds. */
  readonly blocked: boolean;
  readonly invariants: OwnershipInvariantViolations;
  readonly targetCount: number;
  /** §4's byte convention: one `position_id` per line, LF-terminated including the last. */
  readonly targetSetDigest: string;
}

/** The census's own statuses. A fourth one has no defined census semantics (§3's I4 block, guard #9). */
const KNOWN_POSITION_STATUSES = new Set(["open", "dust", "closed"]);

/**
 * §5.3 — every blocking gate, evaluated locally against the frozen manifest, plus the two rows the
 * table marks non-blocking.
 *
 * "Every gate that blocks, blocks the whole run" — so this returns the FULL list either way and the
 * caller renders all of it. A block must be informative, never opaque, and never a per-row skip: §2.3
 * removed skip semantics from this plan entirely.
 *
 * The invariants are neither re-implemented nor re-evaluated here. They were computed BY THE LEDGER
 * ITSELF at export time (§5.1.11), through the same `OWNERSHIP_INVARIANT_ROW_SQL` the two activation
 * gates and the under-lock guards run, with the export's `projected_owners` CTE supplying the owner this
 * run is about to write. Reading the exported rows is what makes the local verdict and the remote one the
 * same computation rather than two that must be argued equal across a float↔text transport.
 */
export function evaluateCensusGates(
  manifest: CensusManifest,
  decision: CensusDecisionSet,
): CensusGateReport {
  const invariants = readInvariants(manifest);
  const targetSetDigest = orderedTargetDigest(manifest);
  const gates = [
    parserGate(decision),
    policyRowGate(manifest),
    policyTextBlankGate(manifest),
    timestampFormGate(manifest),
    timestampCalendarGate(manifest),
    statusDomainGate(manifest),
    crossCheckGate(manifest, decision),
    marketConditionAbsentGate(decision),
    marketConditionContradictionGate(manifest, decision),
    conditionEvidencePopulatedGate(manifest),
    conditionEvidenceAbsentGate(manifest, decision),
    targetSetCompletenessGate(invariants),
    invariantsGate(invariants),
    absentEvidenceMeasurement(manifest),
    snapshotMeasurement(manifest, targetSetDigest),
  ];

  return {
    gates,
    blocked: gates.some((g) => g.blocking && !g.passed),
    invariants,
    targetCount: manifest.targets.length,
    targetSetDigest,
  };
}

/**
 * The owner bound in the export is the SQL projection, not this run's TypeScript decision. The two are
 * not assumed equal — `crossCheckGate` compares them row by row, and every gate blocks the whole run, so
 * a disagreement is refused before these rows can be believed.
 *
 * Counts are derived from the rows here exactly as `readOwnershipInvariantViolations` derives them: never
 * a second query, never a second predicate.
 */
function readInvariants(manifest: CensusManifest): OwnershipInvariantViolations {
  const rows = {} as Record<OwnershipInvariantId, ReadonlyArray<Record<string, unknown>>>;
  const counts = {} as Record<OwnershipInvariantId, number>;
  for (const { id } of OWNERSHIP_INVARIANT_ROW_SQL) {
    rows[id] = manifest.invariants[id];
    counts[id] = rows[id].length;
  }
  return { rows, counts };
}

function gate(
  id: string,
  title: string,
  offending: ReadonlyArray<Record<string, unknown>>,
  note?: string,
): CensusGate {
  return { id, title, blocking: true, passed: offending.length === 0, offending, note };
}

function parserGate(decision: CensusDecisionSet): CensusGate {
  // Any issue blocks: the live provider keeps its last-good in-memory policy when stored JSON is
  // invalid (`execution-policy-provider.ts:83`), so adopting the parser's fallback here could assign
  // owners the runtime would never have chosen — immutably.
  return gate(
    "parser",
    "Parser",
    decision.policyIssues.map((issue) => ({ issue })),
  );
}

function policyRowGate(manifest: CensusManifest): CensusGate {
  const { policyRowCount, executionPolicyJson } = manifest.policy;
  // Two admitting shapes, both fatal: no row at all (an equality fence would pass vacuously over zero
  // rows — guard #1b's reason), and a row whose nullable `execution_policy_json` is NULL. The empty
  // string is deliberately NOT here: §5.3 names it in the trim-empty class, which the blank gate owns.
  const offending: Array<Record<string, unknown>> = [];
  if (policyRowCount !== 1) offending.push({ policy_row_count: policyRowCount });
  else if (executionPolicyJson == null) {
    offending.push({
      policy_row_count: policyRowCount,
      execution_policy_json: executionPolicyJson,
    });
  }
  return gate("policy-row", "Execution policy — row absent", offending);
}

/**
 * §5.1 group 7 — a policy text that is present and non-NULL but holds only whitespace.
 *
 * It has no under-lock twin, and does not need one: `json_valid('   ')` is 0, so the export's owner
 * projection reads `profile` for every target, while `JSON.parse` throws and §2.1 falls back — the two
 * sides can therefore only agree by accident. Guard #1 fences the policy BYTES between export and lock
 * and #1b fences the row's existence, so a blank text cannot appear after this gate has passed.
 *
 * Disjoint from `policyRowGate` by construction: that one owns the absent shapes (no row, NULL text),
 * this one owns the whole present-but-trim-empty class — `'   '` AND `''`, exactly as §5.3 names it.
 * `''` belongs here and not there because the row and the value are both PRESENT: routing it to "row
 * absent" would block the run with a diagnostic that contradicts the ledger. One class, one gate, one
 * remedy.
 */
function policyTextBlankGate(manifest: CensusManifest): CensusGate {
  const text = manifest.policy.executionPolicyJson;
  const offending = text != null && text.trim() === "" ? [{ execution_policy_json: text }] : [];
  return gate("policy-blank", "Execution policy — text blank", offending);
}

/** Every timestamp §5.1.7's projection converts: each target's `opened_at`, and `first_trade_at` when the
 * leg-state row exists. An absent `first_trade_at` is §2.2's legitimate branch, not a malformed value. */
function targetTimestamps(
  manifest: CensusManifest,
): ReadonlyArray<{ positionId: string; column: string; value: string }> {
  return manifest.targets.flatMap((t) => [
    { positionId: t.positionId, column: "opened_at", value: t.openedAt },
    ...(t.firstTradeAt === null
      ? []
      : [{ positionId: t.positionId, column: "first_trade_at", value: t.firstTradeAt }]),
  ]);
}

function timestampRow(t: {
  positionId: string;
  column: string;
  value: string;
}): Record<string, unknown> {
  return { position_id: t.positionId, column: t.column, value: t.value };
}

/**
 * Guard #7's local half. The remote guard aborts under the lock on exactly this predicate; catching it at
 * dry run is what turns a rolled-back apply into a report the operator can act on before taking the lock.
 */
function timestampFormGate(manifest: CensusManifest): CensusGate {
  const offending = targetTimestamps(manifest)
    .filter((t) => !isCanonicalTimestampForm(t.value))
    .map(timestampRow);
  return gate(
    "timestamp-form",
    "Timestamp form",
    offending,
    `the one shape whose SQL and JS readings are provably equal: ${CANONICAL_TIMESTAMP_GLOB}`,
  );
}

/**
 * Guard #7b's local half. Restricted to values that already passed the FORM gate — not to soften it, but
 * because `Date.parse` on a non-canonical shape reads local time, so a calendar verdict on such a value
 * would depend on the operator's `TZ`. Those rows are reported by the form gate, which blocks too.
 */
function timestampCalendarGate(manifest: CensusManifest): CensusGate {
  const offending = targetTimestamps(manifest)
    .filter((t) => isCanonicalTimestampForm(t.value) && !isCanonicalTimestampCalendar(t.value))
    .map(timestampRow);
  return gate(
    "timestamp-calendar",
    "Timestamp calendar",
    offending,
    "a date SQLite would silently roll over (24:01 → next day) or that does not exist",
  );
}

function statusDomainGate(manifest: CensusManifest): CensusGate {
  // The local half of guard #9. Every nonclosed row is exported (§5.1.2), so a status outside the three
  // necessarily shows up here; `owned_closed_positions` is `= 'closed'` by construction.
  const offending = manifest.nonclosedPositions
    .filter((p) => !KNOWN_POSITION_STATUSES.has(p.status))
    .map((p) => ({ position_id: p.positionId, status: p.status }));
  return gate(
    "status-domain",
    "Status domain",
    offending,
    "makes the enumerated target set provably equal to the detectors' status <> 'closed'",
  );
}

function crossCheckGate(manifest: CensusManifest, decision: CensusDecisionSet): CensusGate {
  const sqlOwner = new Map(manifest.sqlOwnerProjection.map((p) => [p.positionId, p.owner]));
  const offending = decision.decisions
    .filter((d) => sqlOwner.get(d.positionId) !== d.owner)
    .map((d) => ({
      position_id: d.positionId,
      ts_owner: d.owner,
      // `undefined` means the SQL projection has no row for this target at all — a shape difference
      // that must fail loudly rather than compare unequal-by-accident with a null owner.
      sql_owner: sqlOwner.get(d.positionId) ?? null,
      reason: d.reason,
    }));
  return gate("cross-check", "Cross-check", offending);
}

function marketConditionAbsentGate(decision: CensusDecisionSet): CensusGate {
  // NULL (no `markets` row for the token) and '' (a mapper manufacturing one from a missing upstream
  // field) are the two admitting shapes; the column itself is TEXT NOT NULL, so there is no third.
  const offending = decision.decisions
    .filter((d) => d.marketConditionId == null || d.marketConditionId === "")
    .map((d) => ({
      position_id: d.positionId,
      token_id: d.tokenId,
      market_condition_id: d.marketConditionId,
    }));
  return gate(
    "market-condition-absent",
    "Market condition — authoritative value absent",
    offending,
  );
}

function marketConditionContradictionGate(
  manifest: CensusManifest,
  decision: CensusDecisionSet,
): CensusGate {
  const marketConditionByPosition = new Map(
    decision.decisions.map((d) => [d.positionId, d.marketConditionId]),
  );
  const offending = manifest.targets
    .filter((t) => {
      const authoritative = marketConditionByPosition.get(t.positionId);
      return (
        isPopulated(t.conditionId) && isPopulated(authoritative) && t.conditionId !== authoritative
      );
    })
    .map((t) => ({
      position_id: t.positionId,
      token_id: t.tokenId,
      position_condition_id: t.conditionId,
      market_condition_id: marketConditionByPosition.get(t.positionId),
    }));
  return gate("market-condition-contradiction", "Market condition — contradiction", offending);
}

function conditionEvidencePopulatedGate(manifest: CensusManifest): CensusGate {
  const evidence = populatedOrderConditionsByToken(manifest);
  const offending = manifest.targets
    .filter((t) => isPopulated(t.conditionId))
    .flatMap((t) => {
      const conflicting = (evidence.get(t.tokenId) ?? []).filter((c) => c !== t.conditionId);
      if (conflicting.length === 0) return [];
      return [
        {
          position_id: t.positionId,
          token_id: t.tokenId,
          position_condition_id: t.conditionId,
          order_condition_ids: conflicting.join(","),
        },
      ];
    });
  return gate("condition-evidence-populated", "Condition evidence — populated position", offending);
}

function conditionEvidenceAbsentGate(
  manifest: CensusManifest,
  decision: CensusDecisionSet,
): CensusGate {
  const evidence = populatedOrderConditionsByToken(manifest);
  const marketConditionByPosition = new Map(
    decision.decisions.map((d) => [d.positionId, d.marketConditionId]),
  );
  // The legacy class of §2.3 is corroborated, not exempted (v6): empty/NULL order values contribute
  // nothing, and what remains must be present, unambiguous, and equal to the authoritative condition.
  const offending = manifest.targets
    .filter((t) => !isPopulated(t.conditionId))
    .flatMap((t) => {
      const values = evidence.get(t.tokenId) ?? [];
      const authoritative = marketConditionByPosition.get(t.positionId) ?? null;
      const fault =
        values.length === 0
          ? "no populated order evidence"
          : values.length > 1
            ? "ambiguous order evidence"
            : values[0] !== authoritative
              ? "order evidence disagrees with markets.condition_id"
              : null;
      if (fault == null) return [];
      return [
        {
          position_id: t.positionId,
          token_id: t.tokenId,
          order_condition_ids: values.join(","),
          market_condition_id: authoritative,
          fault,
        },
      ];
    });
  return gate("condition-evidence-absent", "Condition evidence — absent position", offending);
}

function targetSetCompletenessGate(invariants: OwnershipInvariantViolations): CensusGate {
  // With this run's decision bound as `projectedOwners`, a surviving `nullOwners` row is exactly a
  // nonclosed NULL-owner position the manifest does not cover.
  return gate("target-set-completeness", "Target-set completeness", invariants.rows.nullOwners);
}

function invariantsGate(invariants: OwnershipInvariantViolations): CensusGate {
  const offending = OWNERSHIP_INVARIANT_ROW_SQL.filter(({ id }) => id !== "nullOwners").flatMap(
    ({ id }) => invariants.rows[id].map((row) => ({ invariant: id, ...row })),
  );
  return gate("invariants", "I1–I5", offending);
}

function absentEvidenceMeasurement(manifest: CensusManifest): CensusGate {
  // §5.3 marks this row explicitly non-blocking: an absent `positions.condition_id` is the legacy class
  // of §2.3, counted and named, with the authoritative `markets.condition_id` used instead.
  const rows = manifest.targets
    .filter((t) => !isPopulated(t.conditionId))
    .map((t) => ({ position_id: t.positionId, token_id: t.tokenId, condition_id: t.conditionId }));
  return {
    id: "absent-evidence",
    title: "Market condition — absent evidence",
    blocking: false,
    passed: true,
    offending: rows,
    note: `${rows.length} of ${manifest.targets.length} targets carry no populated positions.condition_id`,
  };
}

function snapshotMeasurement(manifest: CensusManifest, digest: string): CensusGate {
  // §5.3 stopped this row blocking in v14: the target set is a moving quantity, so an equality test
  // against a document constant is a guaranteed false stop. What it prints is the fresh count and the
  // fresh ordered digest — deliberately compared against nothing baked into the plan.
  return {
    id: "snapshot",
    title: "§4 snapshot",
    blocking: false,
    passed: true,
    offending: [],
    note: `fresh target set: ${manifest.targets.length} rows, ordered digest ${digest}`,
  };
}

/** Distinct populated `orders.condition_id` values per token, ordered — empty/NULL filtered out (§2.3). */
function populatedOrderConditionsByToken(manifest: CensusManifest): Map<string, string[]> {
  const byToken = new Map<string, Set<string>>();
  for (const row of manifest.targetOrderConditions) {
    if (!isPopulated(row.conditionId)) continue;
    const set = byToken.get(row.tokenId) ?? new Set<string>();
    set.add(row.conditionId);
    byToken.set(row.tokenId, set);
  }
  return new Map([...byToken].map(([token, set]) => [token, [...set].sort()]));
}

function isPopulated(value: string | null | undefined): value is string {
  return value != null && value !== "";
}

function orderedTargetDigest(manifest: CensusManifest): string {
  const lines = manifest.targets
    .map((t) => t.positionId)
    .sort()
    .map((id) => `${id}\n`)
    .join("");
  return createHash("sha256").update(lines).digest("hex");
}

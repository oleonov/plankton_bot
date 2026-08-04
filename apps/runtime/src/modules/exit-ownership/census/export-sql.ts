import { OWNERSHIP_INVARIANT_ROW_SQL } from "@krabs/db";

import { sqlString } from "./sql-literal.js";
import { gatedEpochMsSql } from "./timestamp-sql.js";

/**
 * §5.1 — the exit-owner census export, as ONE SQL text emitting ONE JSON document.
 *
 * The repo is not on the production server (it runs a Docker image) and the ledger is 31.7 GB, so the
 * exporter cannot be a Node process there and the DB cannot be copied. Everything server-side is
 * `sqlite3` + coreutils, which is why this is a string constant rather than code:
 *
 *   node apps/runtime/dist/scripts/exit-owner-census.js --emit-export-sql > /tmp/export-census.sql
 *   scp /tmp/export-census.sql $HOST:/tmp/export-census.sql
 *   sqlite3 -readonly -noheader "file:$LEDGER?mode=ro" ".read export-census.sql" > "$OUT"
 *   sha256sum "$OUT" > "$OUT.sha256"
 *
 * The bytes `--emit-export-sql` writes ARE this constant, so what §7 test 10 exercises is what runs.
 *
 * Field naming: the envelope is `manifestVersion` / `exportedAt` (the two the plan names as fields of the
 * document); every content column keeps its SQL name, which is how §5.3's gate table refers to them
 * (`market_condition_id`, `market_row_present`, `policy_row_count`, `filled_size`, `first_trade_at`).
 *
 * Four defects this file is shaped to avoid, each one measured rather than assumed:
 *  - `side='SELL'` returns ZERO rows (`OrderSide.Sell = "sell"`, and SQLite compares text
 *    case-sensitively), which would make I1–I3 pass vacuously on a violating ledger;
 *  - `WHERE profile='live-lite'` fails with `no such column: profile` — the column is `profile_id`;
 *  - an `INNER JOIN markets` makes a target with no market row VANISH from the array, leaving §5.3's
 *    absence gate nothing to fire on. Absence is carried as data, never as a missing row;
 *  - a REAL emitted as a JSON number is a DIFFERENT double from the one the arithmetic produced
 *    (`json_object('s', 0.015+0.211)` → `0.226`, one ULP off), and §9a.2 makes the manifest an input of
 *    computation. Hence `realString` under a `CASE` — a bare `printf` renders NULL as `'0.0'`.
 */

/** The production `control.db`, inside the docker named volume `krabs-data`. There is no `/opt/krabs/data`. */
export const PRODUCTION_CONTROL_DB_PATH = "/var/lib/docker/volumes/krabs-data/_data/control.db";

/** The one profile the census reads. `profile_settings` is keyed by `profile_id`, not `profile`. */
const LIVE_LITE_PROFILE_ID = "live-lite";

/** §5.1.1's target predicate — enumerated on purpose; the widened `<> 'closed'` form is §5.1.2's. */
const TARGET_STATUSES = "('open', 'dust')";

/** §5.1.3's "active SELL" — the exclusion set, so an unknown working status stays IN the set. */
const INACTIVE_SELL_STATUSES = "('filled', 'rejected', 'cancelled')";

/**
 * §5.1.10 — a REAL leaves the ledger as the decimal string this renders, and is COMPARED as that string.
 *
 * It is not a round-trip, and on some hosts it cannot be one. sqlite 3.37.2 predates the 3.44 dtoa rewrite
 * and converts through `LONGDOUBLE_TYPE`, which is 80-bit on x86_64 and 64-bit (== `double`) on arm64
 * macOS — so the SAME pinned source renders the same double differently on the two machines, and `%!.17g`
 * is correctly rounded on one and off by up to ~1 ULP on the other. Measured on both, over 200 000
 * realistic sizes stored as binary64, `CAST(printf('%!.17g', v) AS REAL) IS v`:
 *
 *   arm64 macOS (dev)          56 820 / 200 000 differ   (28.4%)
 *   x86_64 (production + CI)        0 / 200 000 differ
 *
 * On arm64, `31897.89` renders as "31897.889999999997" and a ledger `12` renders as "11.999999999999999",
 * which Node reads back as 11.999999999999998 — and `11.999999999999998 IS 12.0` is FALSE, i.e. guard #3
 * reporting drift on a row that never moved. On x86_64 those two render "31897.889999999999" and "12.0"
 * and the bare-numeric transport would have survived. Neither number is a property of the ledger, and a
 * transport whose safety depends on the width of the host's `long double` is not a transport.
 *
 * What the census needs is drift detection, which requires the rendering to be DETERMINISTIC, not
 * accurate. So `size` is compared render-against-render (`generate-sql.ts` guard #3) and is never parsed
 * back into a double by anything that must be exact. The `Number()` the TS-side invariants take is within
 * 1 ULP — far below the 0.01-share granularity by which a fill actually moves a position.
 */
export function realString(expr: string): string {
  return `CASE WHEN ${expr} IS NULL THEN NULL ELSE ${REAL_DISPLAY(expr)} END`;
}

/** THE display renderer. Two dispatch rules below feed it; there is no second rendering of a REAL. */
const REAL_DISPLAY = (expr: string) => `printf('%!.17g', ${expr})`;

/**
 * §5.1.11 — a diagnostic column whose type is not declared. The six invariant row SQLs mix TEXT ids,
 * INTEGER counts and REAL shares, and `columns` names them without typing them (§9a.6 test 8(f) pins the
 * names against `stmt.columns()`, which reports no type on a computed column). So the STORAGE CLASS
 * decides at render time — measured on 3.37.2: `typeof` yields `real`/`integer`/`text`/`null`, and
 * `json_object` then emits `"0.84000000000000003"` / `3` / `null` respectively.
 *
 * A hand-declared REAL-column subset was the alternative and is worse: it would be a second list with
 * nothing pinning it, i.e. exactly the drift `columns` + test 8(f) exist to prevent.
 */
function diagnosticValue(expr: string): string {
  return `CASE WHEN typeof(${expr}) = 'real' THEN ${REAL_DISPLAY(expr)} ELSE ${expr} END`;
}

/**
 * An ordered JSON array of row objects, for SQLite 3.37.2 — `json_group_array(x ORDER BY y)` needs 3.44,
 * so the order comes from an inner subquery instead.
 *
 * BOTH `json()` calls are load-bearing, and both were added after a measured wrong result: a value that
 * crosses a subquery boundary LOSES its JSON subtype, so `json_group_array(j)` embeds each row as a
 * quoted STRING (`["{\"position_id\":…}"]`) and the outer array embeds as a string in turn. `json(...)`
 * re-asserts the subtype at each boundary.
 */
function jsonArray(rowObject: string, from: string, orderBy: string): string {
  return `json((SELECT json_group_array(json(j)) FROM (
      SELECT ${rowObject} AS j
      FROM ${from}
      ORDER BY ${orderBy})))`;
}

/** The SQL expressions the owner projection reads. Every one is an ALIAS, so both call sites bind their
 * own row shape to the same rule. */
export interface OwnerProjectionColumns {
  /** An expression yielding the raw `execution_policy_json` TEXT. */
  readonly policyText: string;
  /** The AUTHORITATIVE `markets.condition_id` (§2.3) — never `positions.condition_id`. */
  readonly marketConditionId: string;
  readonly entryLane: string;
  readonly openedAt: string;
  readonly firstTradeAt: string;
}

/**
 * §5.1.7 — the independent server-side projection of §2.1's rule, computed in SQL from the raw policy
 * text rather than from `parseExecutionPolicyJson`. Independence is the whole point: §5.3's cross-check
 * compares it against the TS verdict, so sharing a parser with the TS side would make the check vacuous.
 *
 * TWO consumers, ONE text: the export's `sql_owner_projection` column and guard #6's under-lock
 * re-derivation (§5.4 step 5). They must agree by construction — a second copy would let the apply
 * commit an owner the dry run's cross-check never saw.
 *
 * `applyToAllMarkets` is deliberately absent (§2.5): it broadens the owner assigned to NEW positions and
 * must not retroactively move existing ones.
 *
 * §5.1 group 7 — the `json_valid` gate is not defensive padding, it is what makes the export EXIST for a
 * malformed policy. Measured on the pinned 3.37.2: an unguarded `json_extract('{', …)` aborts the whole
 * script with `stepping, malformed JSON (1)`, exit 1, so the operator gets NO manifest and no diagnostic
 * naming the policy. Guarded, `'{'`, `'   '`, `''` and NULL all project `'profile'` — measured per row,
 * and the outer `CASE` was verified to SHORT-CIRCUIT, so the `json_each()` in the THEN branch is never
 * stepped for them. `json_valid(NULL)` is `0` on this build, not NULL, so NULL takes the same branch.
 *
 * `'profile'` is the right fallback and not a guess: it is what the TS side independently reaches for
 * these inputs (the parser returns the default policy with `bounceExit.enabled = false`), which keeps
 * §5.3's cross-check meaningful. Blank text is separately REFUSED by the dry run — see `gates.ts` — so
 * this branch decides nothing on a runnable path; it only keeps the export from vanishing.
 */
export function ownerProjectionSql(col: OwnerProjectionColumns): string {
  const policyPath = (leaf: string) => `json_extract(${col.policyText}, '$.${leaf}')`;
  const appliesFrom = policyPath("sellableFlow.appliesFromMs");
  return `CASE WHEN json_valid(${col.policyText}) THEN (CASE
        WHEN COALESCE(${policyPath("bounceExit.enabled")}, 0) = 1
         AND ${policyPath("bounceExit.mode")} = 'micro_live'
         AND EXISTS (
               SELECT 1
               FROM json_each(${policyPath("bounceExit.whitelistConditionIds")}) w
               WHERE w.value = ${col.marketConditionId})
         AND (
               ${col.entryLane} = 'GATE'
               OR (
                    COALESCE(${policyPath("sellableFlow.enabled")}, 0) = 1
                AND ${appliesFrom} IS NOT NULL
                AND (${gatedEpochMsSql(col.openedAt)}) >= ${appliesFrom}
                AND (${gatedEpochMsSql(col.firstTradeAt)}) >= ${appliesFrom}))
        THEN 'bounce' ELSE 'profile' END)
      ELSE 'profile' END`;
}

/**
 * @param controlDbPath absolute path to `control.db` on the machine the export runs on. Parameterized
 * ONLY so §7's tests can run the real constant against a temp control DB; production always gets
 * `CENSUS_EXPORT_SQL`, and `--emit-export-sql` emits that and nothing else.
 */
export function buildCensusExportSql(controlDbPath: string): string {
  const profileId = sqlString(LIVE_LITE_PROFILE_ID);
  return `-- Release A Phase 6 — exit-owner census export (§5.1), manifestVersion 2.
-- READ-ONLY. Invoke with: sqlite3 -readonly -noheader "file:$LEDGER?mode=ro" ".read export-census.sql"
ATTACH DATABASE ${sqlString(`file:${controlDbPath}?mode=ro`)} AS ctl;

WITH
pol AS (
  SELECT
    (SELECT execution_policy_json FROM ctl.profile_settings WHERE profile_id = ${profileId}) AS txt,
    (SELECT COUNT(*) FROM ctl.profile_settings WHERE profile_id = ${profileId}) AS row_count
),
tgt AS (
  SELECT p.position_id, p.token_id, p.condition_id, p.status, p.size, p.entry_lane, p.opened_at,
         ls.first_trade_at
  FROM positions p
  LEFT JOIN leg_states ls ON ls.token_id = p.token_id
  WHERE p.exit_owner IS NULL AND p.status IN ${TARGET_STATUSES}
),
tgt_market AS (
  SELECT t.token_id,
         m.condition_id AS market_condition_id,
         CASE WHEN m.token_id IS NULL THEN 0 ELSE 1 END AS market_row_present
  FROM (SELECT DISTINCT token_id FROM tgt) t
  LEFT JOIN markets m ON m.token_id = t.token_id
),
-- §5.1.11 — the projection OWNERSHIP_INVARIANT_ROW_SQL references BY NAME. Under the two activation
-- gates and under the lock it is a TEMP table; here it must be a CTE, because the export is a
-- sqlite3 -readonly invocation against production and must write nothing at all — not even to a temp
-- database. Verified on the pinned 3.37.2 that the CTE resolves at the depth I5 needs (a correlated
-- subquery, inside a FROM-subquery, inside a scalar subquery) and that removing it fails loudly with
-- "no such table: projected_owners" rather than silently projecting nothing.
projected_owners(position_id, owner) AS (
  SELECT t.position_id,
         ${ownerProjectionSql({
           policyText: "pol.txt",
           marketConditionId: "tm.market_condition_id",
           entryLane: "t.entry_lane",
           openedAt: "t.opened_at",
           firstTradeAt: "t.first_trade_at",
         })}
    FROM tgt t
    LEFT JOIN tgt_market tm ON tm.token_id = t.token_id
    CROSS JOIN pol
)
SELECT json_object(
  'manifestVersion', 2,
  'exportedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'targets', ${jsonArray(
    `json_object(
        'position_id', t.position_id,
        'token_id', t.token_id,
        'condition_id', t.condition_id,
        'status', t.status,
        'size', ${realString("t.size")},
        'entry_lane', t.entry_lane,
        'opened_at', t.opened_at,
        'first_trade_at', t.first_trade_at)`,
    "tgt t",
    "t.position_id",
  )},
  'nonclosed_positions', ${jsonArray(
    `json_object(
        'position_id', p.position_id,
        'token_id', p.token_id,
        'status', p.status,
        'exit_owner', p.exit_owner,
        'size', ${realString("p.size")})`,
    "positions p WHERE p.status <> 'closed'",
    "p.position_id",
  )},
  'active_sell_orders', ${jsonArray(
    `json_object(
        'order_id', o.order_id,
        'token_id', o.token_id,
        'position_id', o.position_id,
        'condition_id', o.condition_id,
        'side', o.side,
        'status', o.status,
        'size', ${realString("o.size")},
        'decision_rule_id', o.decision_rule_id,
        'filled_size', ${realString("COALESCE(f.filled, 0)")})`,
    `orders o
      LEFT JOIN (SELECT order_id, SUM(size) AS filled FROM fills GROUP BY order_id) f
        ON f.order_id = o.order_id
      WHERE o.side = 'sell' AND o.status NOT IN ${INACTIVE_SELL_STATUSES}`,
    "o.order_id",
  )},
  'target_markets', ${jsonArray(
    `json_object(
        'token_id', tm.token_id,
        'market_condition_id', tm.market_condition_id,
        'market_row_present', tm.market_row_present)`,
    "tgt_market tm",
    "tm.token_id",
  )},
  'target_order_conditions', ${jsonArray(
    `json_object(
        'token_id', tc.token_id,
        'condition_id', tc.condition_id)`,
    `(SELECT DISTINCT o.token_id AS token_id, o.condition_id AS condition_id
        FROM orders o
        WHERE o.token_id IN (SELECT token_id FROM tgt)) tc`,
    "tc.token_id, tc.condition_id",
  )},
  'policy', json_object(
    'execution_policy_json', (SELECT txt FROM pol),
    'policy_row_count', (SELECT row_count FROM pol)),
  -- Read out of the CTE rather than re-deriving the projection: the owner §5.3 cross-checks and the
  -- owner the exported invariants were evaluated against are then the SAME rows, not two evaluations
  -- that happen to agree.
  'sql_owner_projection', ${jsonArray(
    `json_object(
        'position_id', po.position_id,
        'owner', po.owner)`,
    "projected_owners po",
    "po.position_id",
  )},
  'owned_closed_positions', ${jsonArray(
    `json_object(
        'position_id', p.position_id,
        'status', p.status,
        'exit_owner', p.exit_owner)`,
    "positions p WHERE p.status = 'closed' AND p.exit_owner IS NOT NULL",
    "p.position_id",
  )},
  'invariants', json_object(
    ${OWNERSHIP_INVARIANT_ROW_SQL.map(invariantGroupEntry).join(",\n    ")})
);
`;
}

/**
 * §5.1.11 content group 9 — the six invariant row-sets, computed by the LIVE ledger's own engine.
 *
 * The whole point of the group is that it is not a second implementation, so this is derived from the
 * shared array the same way `OWNERSHIP_INVARIANT_GUARD_SQL` is: `sql` is embedded VERBATIM (§9a.6 test
 * 8(a) asserts textual containment against the imported constant) and only the row→JSON projection is
 * generated. Ordering repeats the entry's own leading key at the outer level rather than trusting a
 * subquery's `ORDER BY` to survive flattening — §5.1's payload must be byte-deterministic, and for all
 * six entries the leading declared column IS the `ORDER BY` key and is unique per row.
 */
function invariantGroupEntry({
  id,
  sql,
  columns,
}: (typeof OWNERSHIP_INVARIANT_ROW_SQL)[number]): string {
  const rowObject = `json_object(
          ${columns.map((c) => `'${c}', ${diagnosticValue(`r.${c}`)}`).join(",\n          ")})`;
  return `'${id}', ${jsonArray(rowObject, `(${sql}) r`, `r.${columns[0]}`)}`;
}

/** What `--emit-export-sql` writes, verbatim. */
export const CENSUS_EXPORT_SQL = buildCensusExportSql(PRODUCTION_CONTROL_DB_PATH);

import { BOUNCE_EXIT_BACKSTOP_RULE_ID, BOUNCE_EXIT_TARGET_RULE_ID } from "@krabs/domain";
import type Database from "better-sqlite3";

/**
 * Release A Phase 6 §9a — THE one definition of the exit-ownership invariants.
 *
 * Three call sites must assert the SAME predicate, or the census certifies a state one of them
 * still considers broken: the API broadening gate (`apps/api`), the startup assertion
 * (`apps/runtime`), and the census `--apply` gate. `apps/api` cannot import from `apps/runtime`,
 * so the shared definition lives here — the one package all three already depend on.
 *
 * Everything below is derived from `OWNERSHIP_INVARIANT_ROW_SQL`. There is no second place an
 * invariant is written: the boolean form the remote `apply-census.sql` executes is produced by
 * mapping over that array, and the TypeScript "active SELL" predicate and its SQL fragment are
 * both generated from `INACTIVE_SELL_ORDER_STATUSES`.
 */

export type ExitOwner = "bounce" | "profile";

export type OwnershipInvariantId =
  | "nullOwners" // effective-owner form over status <> 'closed'; = the v190 check with no projection
  | "unboundSells" // I1
  | "stalePointerSells" // I2
  | "overcommittedTokens" // I3 — money-risking
  | "duplicateNonclosedTokens" // I4
  | "wrongOwnerSells"; // I5

export interface OwnershipInvariantViolations {
  /** Offending rows per invariant — the DIAGNOSTIC form the dry-run report requires. */
  rows: Readonly<Record<OwnershipInvariantId, ReadonlyArray<Record<string, unknown>>>>;
  /** Counts, DERIVED as `rows[id].length` — never a second query, never a second predicate. */
  counts: Readonly<Record<OwnershipInvariantId, number>>;
}

/**
 * "Active SELL" follows the executor, not a hand-written list: an EXCLUSION set. An unknown
 * status (the schema admits any text — `orders.status` has no CHECK) is therefore ACTIVE, in
 * both forms. Writing the SQL as `IN (…)` instead would diverge on exactly that case.
 */
const INACTIVE_SELL_ORDER_STATUSES = ["filled", "rejected", "cancelled"] as const;

/** Moved here from `decision-planner.ts` so the TS and SQL forms cannot drift (§9a.6 test 4). */
export function isWorkingSellOrderStatus(status: string | null | undefined): boolean {
  return !INACTIVE_SELL_ORDER_STATUSES.some((inactive) => inactive === status);
}

const INACTIVE_SELL_ORDER_STATUS_LIST = INACTIVE_SELL_ORDER_STATUSES.map((s) => `'${s}'`).join(
  ", ",
);

/** The same predicate as `isWorkingSellOrderStatus`, over the alias every order-based row SQL uses. */
const ACTIVE_SELL_SQL = `o.side = 'sell'
   AND o.status NOT IN (${INACTIVE_SELL_ORDER_STATUS_LIST})`;

/**
 * The projection table's NAME and column names are CONTRACT, not an implementation detail: one
 * SQL text names exactly one table, and the remote generator must create the identical shape.
 */
const PROJECTED_OWNERS_COLUMNS = "(position_id TEXT PRIMARY KEY, owner TEXT NOT NULL)";

/** Remote form: `apply-census.sql` runs in a fresh `sqlite3` process, so a bare CREATE is right. */
export const PROJECTED_OWNERS_CREATE_SQL = `CREATE TEMP TABLE projected_owners${PROJECTED_OWNERS_COLUMNS}`;

/**
 * Local form. The API gate's connection comes from a POOL and is reused across requests, and a
 * TEMP table created inside a COMMITTED transaction outlives it for the connection's lifetime —
 * so a bare CREATE would die on the second successful gate call. The DELETE is not
 * belt-and-braces: without it an earlier call's projection survives and the next ledger-only call
 * under-counts, i.e. a NULL-owner row reads as owned — the silent, gate-passing direction.
 */
const PROJECTED_OWNERS_RESET_SQL = `CREATE TEMP TABLE IF NOT EXISTS projected_owners${PROJECTED_OWNERS_COLUMNS};
DELETE FROM projected_owners;`;

/**
 * effective_owner(p) = `p.exit_owner` when non-NULL, else the owner this run projects for `p` (§3).
 * With no projection the temp table is empty and the COALESCE collapses to `p.exit_owner` — which
 * is what makes `nullOwners` byte-for-byte the shipped v190 count at the two activation gates.
 *
 * Operand order is load-bearing, not cosmetic: the ledger owner is IMMUTABLE (§3), so a projection
 * must never outrank one that is already set. Today the census only ever projects for NULL-owner
 * targets, which makes the two orders agree — but the census is not the only future caller, and the
 * projection-first form would silently let one relabel an owned position.
 */
const effectiveOwnerSql = (p: string) =>
  `COALESCE(${p}.exit_owner,
                (SELECT po.owner FROM projected_owners po WHERE po.position_id = ${p}.position_id))`;

/**
 * The rule-id → owner mapping is a BIPARTITION with no third case, transcribed from the live
 * consumer (`execution-module.ts` / `bounce-exit.ts`), not invented: an unknown or legacy rule id
 * is not undecidable, it is `profile`-ruled by construction.
 */
const IMPLIED_OWNER_SQL = `CASE WHEN o.decision_rule_id IN ('${BOUNCE_EXIT_TARGET_RULE_ID}', '${BOUNCE_EXIT_BACKSTOP_RULE_ID}')
              THEN 'bounce' ELSE 'profile' END`;

/**
 * THE one definition of each invariant: a SELECT returning the OFFENDING ROWS with the diagnostic
 * columns the dry-run report must print.
 *
 * Every DETECTOR ranges over `status <> 'closed'` — the executor's set, spelled the executor's way
 * (`findActiveByTokenId`). The enumerated `IN ('open','dust')` convention coincides with it only
 * because production happens to hold three statuses today; `positions.status` has no CHECK. A
 * detector can only refuse in MORE states by widening, never certify a bad one clean. (The
 * census's one-way TARGET set stays enumerated — that asymmetry is deliberate.)
 *
 * Every entry has exactly TWO callers, and both evaluate it against a LIVE ledger — the two activation
 * gates through `readOwnershipInvariantViolations` below, and the census export (§5.1.11), which embeds
 * this same text verbatim into the server-side read-only query and ships only the resulting rows. The
 * census therefore never re-evaluates anything locally: §9a.6 test 8(a) pins the containment, and guard
 * #5 re-runs the export at apply time so a stale manifest cannot certify a changed ledger clean.
 *
 * The consequence for authors: an entry may read ANY ledger column — there is no manifest-carried subset
 * to stay within — but it must remain evaluable under `projected_owners`, the TEMP table the callers bind
 * (see `PROJECTED_OWNERS_CREATE_SQL`), because both of them bind it and neither substitutes a literal.
 */
export const OWNERSHIP_INVARIANT_ROW_SQL: ReadonlyArray<{
  id: OwnershipInvariantId;
  sql: string; // SELECT <diagnostic columns> FROM … WHERE <violation predicate>; NO trailing `;`
  /**
   * `sql`'s result columns, IN ORDER. Data rather than six hand-written serializers because the census
   * export must emit these rows as JSON and SQLite 3.37.2 cannot infer the names — measured:
   * `json_object(r.*)` is `near "*": syntax error` and `json(r)` is `no such column: r`. Two properties
   * follow: a seventh invariant cannot be added without declaring its columns (the type demands it), and
   * the declaration is checkable — §9a.6 test 8(f) prepares each `sql` and asserts
   * `stmt.columns().map((c) => c.name)` equals this list, so a drifted declaration fails in CI instead of
   * silently emitting `null`s into a manifest.
   *
   * The FIRST entry is also the ORDER BY key of `sql`, which is what the export orders its array by.
   */
  columns: readonly string[];
  /**
   * The class of action that clears THIS invariant, for {@link formatOwnershipInvariantRemedy}. It
   * lives here, beside the predicate, because the census writes exactly ONE column —
   * `positions.exit_owner` — so only `nullOwners` is a statement the census can act on, and a single
   * "run the census" remedy is false for the other five in the direction that keeps the bot down:
   * the `--apply` gate refuses to write while any of them is non-zero, so an operator who follows it
   * returns to the same fatal. Declared per entry rather than in a lookup beside it so a seventh
   * invariant cannot be added without one — this array is the only place an invariant is defined.
   *
   * A class of action, never a procedure: the offending rows are the census DRY RUN's job (it is
   * blocked by no invariant), which is why every remedy ends up pointing there.
   */
  remedy: string;
}> = [
  {
    id: "nullOwners",
    columns: ["position_id", "token_id", "status", "exit_owner"],
    // The one class the census CAN write — but not for every row it detects: this predicate is
    // `status <> 'closed'` while the census targets `status IN ('open','dust')`, and `positions.status`
    // carries no CHECK, so a nonclosed row with an out-of-domain status is detected here, excluded from
    // the target set, AND fails the census's own status-domain gate. "Run --apply" would loop forever
    // on it; reconcile-first is valid for the whole invariant.
    remedy:
      "reconcile any nonclosed position whose status is outside open/dust, then run the census --apply",
    sql: `SELECT p.position_id, p.token_id, p.status, p.exit_owner
  FROM positions p
 WHERE p.status <> 'closed'
   AND ${effectiveOwnerSql("p")} IS NULL
 ORDER BY p.position_id`,
  },
  {
    // I1 — an unbound legacy SELL cannot be owner-checked, and the executor's identity rejection
    // never revisits an order that is already resting on the exchange.
    id: "unboundSells",
    columns: ["order_id", "token_id", "status", "size", "decision_rule_id"],
    remedy: "cancel the listed unbound SELL order(s)",
    sql: `SELECT o.order_id, o.token_id, o.status, o.size, o.decision_rule_id
  FROM orders o
 WHERE ${ACTIVE_SELL_SQL}
   AND o.position_id IS NULL
 ORDER BY o.order_id`,
  },
  {
    // I2 — "resolves to a nonclosed position ON THE ORDER'S OWN TOKEN". The token-blind reading is
    // strictly weaker and fails as a SILENT PASS: `orders.position_id` has no foreign key, so a
    // SELL on token A pointing at a nonclosed position of token B satisfies it while the executor
    // already rejects `exit-owner-stale-position`. `position_id IS NOT NULL` keeps this disjoint
    // from I1; `NOT EXISTS` is the (i)-class-safe shape for a predicate about ABSENCE.
    id: "stalePointerSells",
    columns: ["order_id", "token_id", "position_id", "status", "decision_rule_id"],
    remedy: "cancel the listed stale-pointer SELL order(s)",
    sql: `SELECT o.order_id, o.token_id, o.position_id, o.status, o.decision_rule_id
  FROM orders o
 WHERE ${ACTIVE_SELL_SQL}
   AND o.position_id IS NOT NULL
   AND NOT EXISTS (
         SELECT 1
           FROM positions p
          WHERE p.position_id = o.position_id
            AND p.token_id    = o.token_id
            AND p.status     <> 'closed'
       )
 ORDER BY o.order_id`,
  },
  {
    // I3 — per token: Σ remaining active SELL shares ≤ position size. Overcommit means two engines
    // are already selling the same shares, which is why this is the money-risking one. Remaining
    // shares are `size − COALESCE(SUM(fills.size), 0)` floored at 0, never `fill_progress_shares`
    // (cancel-time telemetry). Holdings are SUMmed per token; I4 refuses the ambiguous case anyway.
    id: "overcommittedTokens",
    columns: ["token_id", "remaining_sell_shares", "position_shares"],
    remedy: "cancel or reduce the excess SELL commitment on the listed token(s)",
    sql: `SELECT * FROM (
  SELECT s.token_id AS token_id,
         s.remaining_sell_shares AS remaining_sell_shares,
         COALESCE((SELECT SUM(p.size) FROM positions p
                    WHERE p.token_id = s.token_id AND p.status <> 'closed'), 0) AS position_shares
    FROM (
          SELECT o.token_id AS token_id,
                 SUM(MAX(o.size - COALESCE(f.filled, 0), 0)) AS remaining_sell_shares
            FROM orders o
            LEFT JOIN (SELECT order_id, SUM(size) AS filled FROM fills GROUP BY order_id) f
                   ON f.order_id = o.order_id
           WHERE ${ACTIVE_SELL_SQL}
           GROUP BY o.token_id
         ) s
) WHERE remaining_sell_shares > position_shares
 ORDER BY token_id`,
  },
  {
    // I4 — the token→position lookup must be unambiguous. GROUP BY … HAVING rather than a
    // self-join because the diagnostic is per TOKEN, and a self-join emits one row per unordered
    // pair, double-counting a 3-row token. Genuinely reachable: the UNIQUE index is
    // `UNIQUE(token_id) WHERE status='open'`, so two `dust` rows on one token are permitted.
    id: "duplicateNonclosedTokens",
    columns: ["token_id", "nonclosed_rows", "position_ids"],
    remedy: "reconcile the listed token(s) down to one nonclosed position",
    sql: `SELECT p.token_id, COUNT(*) AS nonclosed_rows, GROUP_CONCAT(p.position_id) AS position_ids
  FROM positions p
 WHERE p.status <> 'closed'
 GROUP BY p.token_id
HAVING COUNT(*) > 1
 ORDER BY p.token_id`,
  },
  {
    // I5 — a resting `bounce` SELL against a `profile`-owned position (or the converse) is exactly
    // the wrong-owner state the canonical hard-stop list names, and I2 never compares the order's
    // rule with the owner. Evaluated over the EFFECTIVE owner for EVERY position carrying an
    // active SELL, not only for the census's targets: on a recovery run the offending position may
    // already be owned, and restricting this to targets would let it through on the second pass.
    id: "wrongOwnerSells",
    columns: [
      "order_id",
      "token_id",
      "position_id",
      "status",
      "decision_rule_id",
      "effective_owner",
      "implied_owner",
    ],
    // Not "reassign the owner": `positions.exit_owner` is immutable (the migration carries the
    // trigger), so the ONLY side that can move is the order.
    remedy: "cancel the listed wrong-owner SELL order(s)",
    sql: `SELECT * FROM (
  SELECT o.order_id AS order_id,
         o.token_id AS token_id,
         o.position_id AS position_id,
         o.status AS status,
         o.decision_rule_id AS decision_rule_id,
         ${effectiveOwnerSql("p")} AS effective_owner,
         ${IMPLIED_OWNER_SQL} AS implied_owner
    FROM orders o
    JOIN positions p ON p.position_id = o.position_id AND p.status <> 'closed'
   WHERE ${ACTIVE_SELL_SQL}
) WHERE effective_owner IS NOT NULL AND effective_owner <> implied_owner
 ORDER BY order_id`,
  },
];

/**
 * The SAME invariants as boolean SQL, for the ONE consumer that cannot call TypeScript: the remote
 * `apply-census.sql` (there is no Node on the server). MECHANICALLY DERIVED — each entry is
 * literally `SELECT COUNT(*) = 0 AS ok FROM (<the row SQL of the same id>)`, so the two forms
 * cannot drift. The local generator embeds this text verbatim; the script is a transport, not a
 * second definition.
 */
export const OWNERSHIP_INVARIANT_GUARD_SQL: ReadonlyArray<{
  id: OwnershipInvariantId;
  sql: string;
}> = OWNERSHIP_INVARIANT_ROW_SQL.map(({ id, sql }) => ({
  id,
  sql: `SELECT COUNT(*) = 0 AS ok FROM (${sql})`,
}));

/**
 * `projectedOwners` supplies the owner a run is ABOUT to write for positions whose `exit_owner` is
 * still NULL. The two activation gates pass nothing (no run is projecting) and therefore get
 * ledger-only semantics; the census passes its manifest's expected-owner map, so its own targets
 * stop counting while a NULL-owner row the manifest does not cover still does.
 *
 * The projection is bound as the TEMP TABLE `projected_owners` so ONE SQL text serves both forms.
 * There is no second SQL variant and no branch inside any predicate.
 */
export function readOwnershipInvariantViolations(
  ledgerDb: Database.Database,
  projectedOwners?: ReadonlyMap<string, ExitOwner>,
): OwnershipInvariantViolations {
  bindProjectedOwners(ledgerDb, projectedOwners);
  const rows = {} as Record<OwnershipInvariantId, ReadonlyArray<Record<string, unknown>>>;
  const counts = {} as Record<OwnershipInvariantId, number>;
  for (const { id, sql } of OWNERSHIP_INVARIANT_ROW_SQL) {
    const offending = ledgerDb.prepare(sql).all() as Array<Record<string, unknown>>;
    rows[id] = offending;
    counts[id] = offending.length;
  }
  return { rows, counts };
}

export function hasOwnershipInvariantViolation(v: OwnershipInvariantViolations): boolean {
  return OWNERSHIP_INVARIANT_ROW_SQL.some(({ id }) => v.counts[id] > 0);
}

/**
 * `id=count` for all six, so a log or an HTTP message names what to remediate, never just "some".
 * Takes the counts rather than the whole record: the consumers that format a breakdown (a fatal
 * log, a 409 body, a long-lived Error) have no use for the offending rows and should not pin them.
 */
export function formatOwnershipInvariantBreakdown(
  counts: Readonly<Record<OwnershipInvariantId, number>>,
): string {
  return OWNERSHIP_INVARIANT_ROW_SQL.map(({ id }) => `${id}=${counts[id]}`).join(", ");
}

/**
 * The remedy for the invariants that are ACTUALLY violated, in declaration order — the counterpart to
 * the breakdown above, which names what is wrong; this names what to do about it.
 *
 * One string per non-zero class, because a single "run the census" is correct for `nullOwners` alone
 * and false for I1–I5 in the direction that keeps the bot down: §5.3's `--apply` gate refuses to write
 * while any of the five is non-zero, so an operator who follows it re-enters the same fatal. See each
 * entry's `remedy` for why that class's action is the one it is.
 *
 * Counts, not rows: the offending rows belong to the census dry run (blocked by no invariant), which
 * is what the trailing sentence points at. Callers format this only under
 * {@link hasOwnershipInvariantViolation} — that is what makes the leading list non-empty.
 */
export function formatOwnershipInvariantRemedy(
  counts: Readonly<Record<OwnershipInvariantId, number>>,
): string {
  const actions = OWNERSHIP_INVARIANT_ROW_SQL.filter(({ id }) => counts[id] > 0).map(
    ({ id, remedy }) => `${id}: ${remedy}`,
  );
  return `${actions.join("; ")} — the census DRY RUN lists the offending rows and is blocked by no invariant`;
}

function bindProjectedOwners(
  db: Database.Database,
  projectedOwners: ReadonlyMap<string, ExitOwner> | undefined,
): void {
  db.exec(PROJECTED_OWNERS_RESET_SQL);
  if (!projectedOwners?.size) return;
  const insert = db.prepare("INSERT INTO projected_owners(position_id, owner) VALUES (?, ?)");
  for (const [positionId, owner] of projectedOwners) insert.run(positionId, owner);
}

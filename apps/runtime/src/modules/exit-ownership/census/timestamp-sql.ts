/**
 * §5.4.2 — the ONE definition of "a timestamp this census may convert", in SQL and in TS.
 *
 * Three separate consumers need the identical form: §5.1.7's server-side owner projection (it must
 * mirror `Date.parse` exactly, or §5.3's cross-check fires on a shape difference rather than on a real
 * disagreement), §5.4.1's guards #7/#7b, and the local report. A second copy of the GLOB or of the
 * conversion is the defect class §2.6 was written for, so there is one copy and it lives here.
 *
 * Why the conversion is `strftime`+`substr` and not `julianday`: the julianday form is off by −1 ms on
 * 92 of 1000 millisecond residues (§5.4.2's measurement on production 3.37.2), and a current target
 * already trips it. `unixepoch()` does not exist on 3.37.2 and bare `strftime('%s', ts)` truncates to
 * whole seconds while `sellableFlow.appliesFromMs` carries a millisecond remainder.
 */

/** Gate 1 of §5.4.2 — the only shape whose SQL and JS readings are provably equal. */
export const CANONICAL_TIMESTAMP_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z";

/** The TS twin of the GLOB (§5.4.2 part 3). `.` is escaped — the GLOB's `.` is already literal. */
export const CANONICAL_TIMESTAMP_RE =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

/** §5.4.2 part 2 — exact on all 1000 ms residues and on pre-1970 values. Valid only after both gates. */
export function epochMsSql(ts: string): string {
  return (
    `CAST(strftime('%s', substr(${ts},1,19)||'Z') AS INTEGER)*1000` +
    ` + CAST(substr(${ts},21,3) AS INTEGER)`
  );
}

/** Gate 1 predicate — TRUE for a timestamp the census must refuse. NULL-safe by construction. */
export function malformedTimestampSql(ts: string): string {
  return `${ts} IS NULL OR ${ts} NOT GLOB '${CANONICAL_TIMESTAMP_GLOB}'`;
}

/**
 * Gate 1b predicate — TRUE when SQLite silently rolled a component over (`24:01` → next day) or when
 * the date does not exist. The round trip must go THROUGH the computed epoch: the shorter form
 * `strftime('%Y-%m-%dT%H:%M:%S', substr(ts,1,19)||'Z')` echoes `24:01` back unchanged (§5.4.2).
 */
export function rolloverTimestampSql(ts: string): string {
  return (
    `strftime('%Y-%m-%dT%H:%M:%S', strftime('%s', substr(${ts},1,19)||'Z'), 'unixepoch')` +
    ` IS NOT substr(${ts},1,19)`
  );
}

/**
 * The epoch, or NULL when either gate refuses — the SQL mirror of `Date.parse(...)` → `NaN`, since every
 * comparison against NULL is NULL and therefore falsy. Both gates are applied here on purpose: gating on
 * shape alone would let `2026-02-30T10:00:00.000Z` agree between SQL and TS, pass §5.3's cross-check, and
 * then abort under the lock at guard #7b — the one outcome the dry-run/apply split exists to prevent.
 */
export function gatedEpochMsSql(ts: string): string {
  return (
    `CASE WHEN (${malformedTimestampSql(ts)}) OR (${rolloverTimestampSql(ts)})` +
    ` THEN NULL ELSE ${epochMsSql(ts)} END`
  );
}

/**
 * TS twin of `malformedTimestampSql` — the SHAPE half alone. Exported separately from the calendar half
 * because guards #7 and #7b are two aborts with two different remedies (re-write the column vs. fix a
 * date that does not exist), and §5.3's local gates must name which one a row would trip. §2.1's decider
 * applies THIS one and deliberately not the calendar half — see `decide.ts:formGated`.
 */
export function isCanonicalTimestampForm(ts: string | null | undefined): ts is string {
  return ts != null && CANONICAL_TIMESTAMP_RE.test(ts);
}

/**
 * TS twin of `rolloverTimestampSql` — the rollover/nonexistent-date class the GLOB cannot see (`24:01`,
 * `2026-02-30`). Valid only on a value that already passed the form gate, which is the order both the SQL
 * and this file apply them in: `Date.parse` on a non-canonical shape reads local time.
 */
export function isCanonicalTimestampCalendar(ts: string): boolean {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === ts;
}

/** TS twin of `gatedEpochMsSql` — used by the report to explain a cross-check mismatch, never by §2.1. */
export function isCanonicalTimestamp(ts: string | null | undefined): boolean {
  return isCanonicalTimestampForm(ts) && isCanonicalTimestampCalendar(ts);
}

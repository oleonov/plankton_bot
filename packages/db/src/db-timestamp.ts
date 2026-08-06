import { parseInstantMs } from "@krabs/domain";

/**
 * Canonical ledger timestamp — ISO-8601 UTC with milliseconds.
 *
 * Every writer of a given timestamp column MUST render it the same way. SQLite's
 * `datetime('now')` produces `YYYY-MM-DD HH:MM:SS`, which sorts BELOW any ISO
 * string of the same calendar day because `' '` (0x20) < `'T'` (0x54). A column
 * written by both paths therefore breaks every `MAX(col)`, `col > ?` and
 * `ORDER BY col` that reads it — the newest row is not the lexical maximum.
 *
 * The upsert paths bind ISO values from the domain objects, so partial `UPDATE`
 * statements must bind this instead of falling back to `datetime('now')`.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * SQL expression that turns any ledger timestamp rendering into a comparable instant.
 *
 * Historical rows predate `nowIso()` and still carry two other renderings, so a reader that
 * must span them cannot compare the raw text:
 *   * SQLite space   `2026-08-05 05:53:26`     — legacy `datetime('now')` partial UPDATEs
 *   * Gamma offset   `2026-08-05 05:53:26+00`  — Polymarket's `closedTime`, normalized at the
 *                                                ingress since, but 302 rows already landed
 *
 * Bare `julianday()` is NOT enough: SQLite's timezone modifier requires `+HH:MM`, so a bare
 * `+00` is malformed and `julianday()` returns NULL for that entire shape — every comparison
 * against it is NULL, and the row is silently dropped rather than mis-ordered. Stripping the
 * malformed offset first is what makes the parse total; the three renderings then compare
 * equal for the same instant, at full millisecond resolution.
 */
export function ledgerInstant(column: string): string {
  return `julianday(replace(${column}, '+00', ''))`;
}

/**
 * Render an instant the way SQLite's `datetime('now')` does — `YYYY-MM-DD HH:MM:SS`, UTC.
 *
 * A few columns are space-format ON PURPOSE, because their only writer is the column DEFAULT:
 * `risk_events.created_at` is 50,000/50,000 space-form on the live ledger, since every INSERT
 * omits the column. A reader that binds an ISO cutoff against one of those columns is wrong in
 * exactly the way a split column is — `' '` (0x20) < `'T'` (0x54), so every row sharing the
 * cutoff's calendar day compares below it regardless of time-of-day.
 *
 * Rendering the BIND in the column's own format is the fix rather than wrapping the column in
 * {@link ledgerInstant}: the wrap would work, but it buries the column in `julianday()` and turns
 * an indexed range seek into a full scan — unaffordable on the tables these cutoffs sweep.
 */
export function toSqliteDateTime(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * TypeScript-side counterpart of `ledgerInstant` — turns any ledger timestamp
 * rendering into epoch ms, for callers that read a row out of SQLite and then
 * compare/subtract in JS instead of in the query itself.
 *
 * The rendering-tolerant parse itself lives in `@krabs/domain` so this and
 * Gamma's `toCanonicalIso` cannot drift apart on a future shape; the only thing
 * added here is the nullable column contract — a NULL `closed_at`/`resolved_at`
 * must yield NaN, not the epoch.
 */
export function parseLedgerInstantMs(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return parseInstantMs(value);
}

/**
 * §5.4 "SQL construction" — the ONE escaper. Every value the census interpolates into a SQL text goes
 * through here; nothing is quoted ad hoc. `entry_lane` / `opened_at` / `condition_id` come out of the
 * ledger, so this is defense in depth rather than paranoia — but the manifest arrives over `ssh` from a
 * server-side redirect, and the script it produces performs a one-way live-money write.
 */

/** SQLite literal quoting: wrap in `'`, double any embedded `'`. */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A nullable TEXT column. `NULL` unquoted — `'NULL'` would compare equal to a literal four-letter row. */
export function sqlNullableString(value: string | null | undefined): string {
  return value == null ? "NULL" : sqlString(value);
}

// There is deliberately no bare-numeric emitter here. §5.1.10's REALs are compared render-against-render
// (`export-sql.ts:realString`), so a size crosses into the apply script as a quoted TEXT literal like every
// other value — which leaves this file with no unquoted interpolation at all.

/**
 * Parse any timestamp rendering the system stores or ingests into epoch ms.
 *
 * Five renderings reach us for the same instant — the ledger's canonical
 * `2026-08-05T05:53:26.789Z`, SQLite's legacy `datetime('now')` space form
 * `2026-08-05 05:53:26`, Gamma's `2026-08-05 05:53:26+00` and its microsecond
 * variant, and an ISO form with no sub-second part — plus bare `2026-08-05`
 * dates and Gamma's occasional non-zero/4-digit offsets (`+0030`, `-05`).
 * `Date.parse` alone is NOT total over them (nor is it safe over them): its
 * legacy fallback parser accepts almost anything, including strings that are
 * not timestamps at all (`Date.parse("0")` — epoch-adjacent, host-timezone
 * dependent) and impossible calendar dates (`Date.parse("2026-02-30 …")`
 * silently rolls over to March 2 instead of rejecting).
 *
 * So parsing here is shape-first: match the value against the exact grammar
 * above, reject anything else outright, then reject an in-grammar value whose
 * calendar/time components don't round-trip through `Date.UTC` (the same
 * rollover `Date.parse` would otherwise hide). Only a value that survives
 * both checks is handed to the underlying date arithmetic.
 */
export function parseInstantMs(value: string): number {
  const match = RENDERING.exec(value);
  if (!match) return Number.NaN;
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, fraction, zone] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hasTime = hourStr !== undefined;
  const hour = hasTime ? Number(hourStr) : 0;
  const minute = hasTime ? Number(minuteStr) : 0;
  const second = hasTime ? Number(secondStr) : 0;
  if (!isValidCalendar(year, month, day, hour, minute, second)) return Number.NaN;
  if (!hasTime) return Date.UTC(year, month - 1, day);

  // A zone-less time is SQLite's `datetime('now')` — pin it to UTC rather than letting the
  // legacy parser read it as local time. A bare two-digit offset (Gamma's `+00`) is malformed
  // for the strict ISO parser a `T` separator selects; padding it to `+HH:00` is what makes it
  // parse instead of returning NaN (4-digit/colon offsets already parse unpadded).
  const offset = zone === undefined ? "Z" : zone.replace(/^([+-]\d{2})$/i, "$1:00");
  const naive = `${yearStr}-${monthStr}-${dayStr}T${hourStr}:${minuteStr}:${secondStr}`;
  if (fraction === undefined) return Date.parse(`${naive}${offset}`);
  if (fraction.length <= 3) return Date.parse(`${naive}.${fraction}${offset}`);

  // Gamma's microsecond rendering (more than 3 fractional digits) rounds to the nearest
  // millisecond — true round-to-nearest, unlike `Date.parse` alone, which truncates. Migration
  // 095's `strftime('%f', …)` is a different algorithm (a Julian-Day double round-trip, not
  // round-half-up): it agrees with this on the only fractional shape live data has
  // (`.075833` -> `.076`), but diverges for fractions that would carry across a second
  // (>= `.9995`, which `strftime` clamps to `.999` instead). No live row falls in that class,
  // and after the Gamma ingress fix no new raw microsecond value is stored, so the two are only
  // ever compared on already-normalized rows.
  return Date.parse(`${naive}${offset}`) + Math.round(Number(`0.${fraction}`) * 1000);
}

const RENDERING =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/**
 * True when the calendar/time components round-trip through `Date.UTC` unchanged.
 *
 * `Date.UTC`/`Date.parse` never reject an out-of-range component — they roll it into the next
 * unit instead (day 30 of February becomes March 2; hour 25 becomes 01:00 the next day). That is
 * the right behavior for arithmetic but the wrong one for validating untrusted input: a rollover
 * silently turns a malformed value into a plausible-looking, wrong instant. Re-reading the
 * constructed instant's UTC fields and comparing them back to the parsed components catches
 * exactly that case, regardless of what offset (if any) is later applied to the same components.
 */
function isValidCalendar(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute &&
    check.getUTCSeconds() === second
  );
}

/**
 * Render any timestamp rendering `parseInstantMs` accepts as canonical ISO-8601 UTC with
 * milliseconds, or `null` for input that isn't a parseable timestamp at all.
 *
 * `unknown`, not `string | undefined`: every caller feeds this a field off an untrusted JSON
 * payload (Gamma market data, ledger reads). Declaring a string and casting at the call site
 * would make a numeric or object field throw inside the caller's per-item loop — one malformed
 * record would abort the whole batch/scan, where a defensive coercion is total.
 */
export function toCanonicalIso(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  const ms = parseInstantMs(raw.trim());
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Start of the UTC second containing `ms` — the resolution exchange fill timestamps carry. */
export function floorToSecondMs(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

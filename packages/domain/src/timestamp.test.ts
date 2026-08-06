import { afterEach, describe, expect, it } from "vitest";
import { parseInstantMs, toCanonicalIso } from "./timestamp.js";

/**
 * One instant, every rendering that reaches us — the ledger's canonical form, SQLite's legacy
 * `datetime('now')`, Gamma's bare `+00` offset and its microsecond variant, and the ISO form
 * with no sub-second part. `packages/db`'s `parseLedgerInstantMs` and `toCanonicalIso` (also
 * defined here) both delegate to `parseInstantMs`, so this table is the single place the set is
 * pinned.
 */
const INSTANT = Date.parse("2026-08-05T05:53:26.000Z");

describe("parseInstantMs", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it.each([
    ["canonical ISO-ms-Z (24 ch)", "2026-08-05T05:53:26.000Z"],
    ["SQLite datetime('now') space (19 ch)", "2026-08-05 05:53:26"],
    ["ISO without milliseconds (20 ch)", "2026-08-05T05:53:26Z"],
    ["Gamma second-precision +00 (22 ch)", "2026-08-05 05:53:26+00"],
  ])("maps %s onto the same instant", (_label, value) => {
    // Under a non-UTC host: `Date.parse` alone reads a zone-less value as LOCAL time, so a
    // regression to it fails here where a UTC test host would let the bug pass by accident.
    process.env.TZ = "Asia/Bangkok";
    expect(parseInstantMs(value)).toBe(INSTANT);
  });

  it("rounds Gamma's microsecond rendering to the nearest millisecond, without shifting the second", () => {
    // Not hypothetical: 2 of the 616 `positions.closed_at` rows on the live ledger carry six
    // fractional digits (`2026-06-29 20:42:28.075833+00`). This rounds to the nearest millisecond
    // (`.076`); migration 095's `strftime('%f', …)` is a different algorithm (a Julian-Day double
    // round-trip) that happens to agree on this exact fractional shape — the only one live data
    // has — though the two are not equivalent in general (see the divergence case below).
    expect(parseInstantMs("2026-06-29 20:42:28.075833+00")).toBe(
      Date.parse("2026-06-29T20:42:28.076Z"),
    );
  });

  it("carries a fraction >= .9995 into the next second, unlike migration 095's strftime", () => {
    // Deliberate, documented divergence: `Math.round` is true round-to-nearest, so a fraction
    // this close to 1 carries into the next second. `strftime('%f', …)` is a Julian-Day double
    // round-trip that clamps at `.999` instead — it would render this same input as `28.999`,
    // never `29.000`. No live row has a fraction in this class (both microsecond rows carry
    // `.075833`), so the two algorithms have never actually disagreed on stored data.
    expect(parseInstantMs("2026-06-29 20:42:28.9995+00")).toBe(
      Date.parse("2026-06-29T20:42:29.000Z"),
    );
  });

  it("resolves a non-zero/4-digit offset instead of assuming every Gamma value is UTC", () => {
    expect(parseInstantMs("2026-06-29 20:42:28+0030")).toBe(Date.parse("2026-06-29T20:12:28.000Z"));
    expect(parseInstantMs("2026-06-29 20:42:28-05")).toBe(Date.parse("2026-06-30T01:42:28.000Z"));
  });

  it("reads a date-only value as UTC midnight, not NaN", () => {
    // The `-05` day component looks exactly like a bare `-HH` offset to the zone regex; padding
    // it would yield `2026-08-05:00` and NaN, where a real instant exists.
    process.env.TZ = "Asia/Bangkok";
    expect(parseInstantMs("2026-08-05")).toBe(Date.parse("2026-08-05T00:00:00.000Z"));
  });

  it("returns NaN for a value it cannot parse, so callers can reject rather than guess", () => {
    expect(parseInstantMs("not-a-timestamp")).toBeNaN();
    expect(parseInstantMs("")).toBeNaN();
  });

  it("returns NaN for a string that merely looks numeric, not a timestamp", () => {
    // `Date.parse("0")` resolves to a host-timezone-dependent instant near the epoch — the
    // legacy fallback parser treats it as a year, not a rejection. It never matches the
    // supported-rendering grammar, so it must be rejected before it ever reaches `Date.parse`.
    expect(parseInstantMs("0")).toBeNaN();
    expect(parseInstantMs("1970")).toBeNaN();
  });

  it("returns NaN for an impossible calendar date instead of silently rolling it over", () => {
    // `Date.parse`/`Date.UTC` roll day 30 of February into March 2 rather than rejecting it —
    // exactly the failure mode that would turn a malformed Gamma field into a plausible-looking
    // wrong resolution deadline.
    expect(parseInstantMs("2026-02-30 12:00:00+00")).toBeNaN();
    expect(parseInstantMs("2026-02-30")).toBeNaN();
  });
});

describe("toCanonicalIso", () => {
  it("keeps an already-canonical ISO value unchanged", () => {
    expect(toCanonicalIso("2026-03-25T16:00:00.000Z")).toBe("2026-03-25T16:00:00.000Z");
  });

  it("pads Gamma's bare two-digit offset instead of dropping it", () => {
    expect(toCanonicalIso("2026-03-25 16:00:00+00")).toBe("2026-03-25T16:00:00.000Z");
    expect(toCanonicalIso("2026-03-25 19:00:00+03")).toBe("2026-03-25T16:00:00.000Z");
  });

  it("pins a zone-less date-time to UTC rather than the host timezone", () => {
    // `Date.parse` reads a zone-less date-time as LOCAL time, so merely stripping
    // the offset would shift the instant by the host's UTC offset (this repo's
    // production host runs UTC+7). The result must not depend on where it runs.
    expect(toCanonicalIso("2026-03-25 16:00:00")).toBe("2026-03-25T16:00:00.000Z");
  });

  it("rounds Gamma's microsecond precision to ms without shifting the instant", () => {
    // Not hypothetical: 2 of the 616 `positions.closed_at` rows on the live ledger carry six
    // fractional digits (`2026-06-29 20:42:28.075833+00`). Migration 095's `strftime` backfill
    // agrees on this exact shape — the only one live data has — though the two algorithms are
    // not equivalent in general (see parseInstantMs's divergence test in this file).
    expect(toCanonicalIso("2026-06-29 20:42:28.075833+00")).toBe("2026-06-29T20:42:28.076Z");
  });

  it("resolves a non-zero offset instead of assuming every Gamma value is UTC", () => {
    expect(toCanonicalIso("2026-06-29 20:42:28+0030")).toBe("2026-06-29T20:12:28.000Z");
    expect(toCanonicalIso("2026-06-29 20:42:28-05")).toBe("2026-06-30T01:42:28.000Z");
  });

  it("leaves a bare date alone — ES already parses it as UTC", () => {
    expect(toCanonicalIso("2026-03-25")).toBe("2026-03-25T00:00:00.000Z");
  });

  it("returns null for absent or unparseable input", () => {
    expect(toCanonicalIso(null)).toBeNull();
    expect(toCanonicalIso(undefined)).toBeNull();
    expect(toCanonicalIso("")).toBeNull();
    expect(toCanonicalIso("not-a-time")).toBeNull();
  });

  it("returns null rather than a rolled-over instant for an impossible calendar date", () => {
    expect(toCanonicalIso("2026-02-30 12:00:00+00")).toBeNull();
  });
});

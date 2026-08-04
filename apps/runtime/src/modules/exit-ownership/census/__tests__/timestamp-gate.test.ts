import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  CANONICAL_TIMESTAMP_RE,
  epochMsSql,
  isCanonicalTimestamp,
  malformedTimestampSql,
  rolloverTimestampSql,
} from "../timestamp-sql.js";
import { AFTER_CUTOFF, cleanSeed, soloTargetSeed, WHITELISTED_CONDITION } from "./fixtures.js";
import {
  CHECK_FAILED,
  expectRolledBack,
  gateById,
  ownerPlan,
  prepareApply,
  probeGuard,
  runCensus,
  type CensusRun,
} from "./pipeline.js";
import { productionSqlite3 } from "./sqlite-cli.js";

/**
 * §7 test 7b — the epoch conversion of §5.4.2 and the two gates that make it safe to pin.
 *
 * Everything here is MEASURED on the pinned 3.37.2 CLI rather than reasoned about. The formula this
 * replaced (`julianday`) was shipped in plan v5 with the claim "verified byte-equal to `Date.parse`" —
 * a claim made from one sample, false on 92 of 1000 millisecond residues and false on a target that
 * exists in production today. So the expected tables below are the plan's measurements, re-taken by the
 * test: if a later editor changes the formula, the numbers move and this file says exactly where.
 */

// ───────────────────────────── measuring the two gates on 3.37.2 ─────────────────────────────

interface Measured {
  readonly ts: string;
  /** guard #7's predicate — `1` ⇒ the census refuses the SHAPE. */
  readonly malformed: string;
  /** guard #7b's predicate — `1` ⇒ SQLite rolled a component over, or the date does not exist. */
  readonly rollover: string;
  /** The pinned conversion, or `"NULL"` — what the guards protect. */
  readonly epoch: string;
}

/** One CLI run for a whole batch: an in-memory DB is enough — none of this reads a table. */
function measure(candidates: readonly string[]): readonly Measured[] {
  const values = candidates.map((ts) => `('${ts.replaceAll("'", "''")}')`).join(",");
  const stdout = execFileSync(productionSqlite3(), ["-noheader", "-bail", ":memory:"], {
    input:
      `WITH t(ts) AS (VALUES ${values})\nSELECT ts, ${malformedTimestampSql("ts")},` +
      ` ${rolloverTimestampSql("ts")}, COALESCE(${epochMsSql("ts")}, 'NULL') FROM t;\n`,
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [ts, malformed, rollover, epoch] = line.split("|");
      return {
        ts: ts ?? "",
        malformed: malformed ?? "",
        rollover: rollover ?? "",
        epoch: epoch ?? "",
      };
    });
}

/** `{ts, malformed}` alone, so the form table reads as the plan's table rather than as noise. */
function formTable(candidates: readonly string[]): ReadonlyArray<Record<string, string>> {
  return measure(candidates).map(({ ts, malformed }) => ({ ts, malformed }));
}

const CANONICAL = "2026-07-19T15:51:16.250Z";
/** The production value v5's formula got wrong — the reason §5.4.2 exists at all. */
const PRODUCTION_VALUE = "2026-06-04T20:12:04.039Z";

// ───────────────────────────── gate 1: the form ─────────────────────────────

describe("§7.7b — the form gate refuses every shape the conversion would misread", () => {
  it("accepts the canonical shape, including pre-1970 and the real production value", () => {
    expect(formTable([CANONICAL, "1969-12-31T23:59:59.750Z", PRODUCTION_VALUE])).toEqual([
      { ts: CANONICAL, malformed: "0" },
      { ts: "1969-12-31T23:59:59.750Z", malformed: "0" },
      { ts: PRODUCTION_VALUE, malformed: "0" },
    ]);
  });

  it("refuses offset-bearing, offset-less, space-separated, over-precise, empty and garbage", () => {
    expect(
      formTable([
        "2026-07-19T15:51:16.250+02:00",
        "2026-07-19T15:51:16.250",
        "2026-07-19 15:51:16.250Z",
        "2026-07-19T15:51:16.250123Z",
        "2026-07-19T15:51:16Z",
        "2026-06-04 20:12:04",
        "2026-07-19T15:51:16.250z",
        "",
        "not-a-timestamp",
      ]),
    ).toEqual([
      { ts: "2026-07-19T15:51:16.250+02:00", malformed: "1" },
      { ts: "2026-07-19T15:51:16.250", malformed: "1" },
      { ts: "2026-07-19 15:51:16.250Z", malformed: "1" },
      { ts: "2026-07-19T15:51:16.250123Z", malformed: "1" },
      // Second precision — what `strftime('%Y-%m-%dT%H:%M:%SZ')` produces, so a real shape to refuse.
      { ts: "2026-07-19T15:51:16Z", malformed: "1" },
      // The production `first_trade_at` shape §5.4.2's apply pair is built from.
      { ts: "2026-06-04 20:12:04", malformed: "1" },
      // GLOB is case-sensitive, and so is the TS regex — asserted together below.
      { ts: "2026-07-19T15:51:16.250z", malformed: "1" },
      { ts: "", malformed: "1" },
      { ts: "not-a-timestamp", malformed: "1" },
    ]);
  });

  it("is why the gate is not optional — the pinned conversion reads bytes 21–23 blindly", () => {
    const [offset, offsetless, space] = measure([
      "2026-07-19T15:51:16.250+02:00",
      "2026-07-19T15:51:16.250",
      "2026-07-19 15:51:16.250Z",
    ]);

    // An explicit offset is SILENTLY IGNORED — by the full two hours, in the direction that would make a
    // pre-cutoff position look post-cutoff.
    expect(Number(offset?.epoch)).toBe(Date.parse(CANONICAL));
    expect(Number(offset?.epoch) - Date.parse("2026-07-19T15:51:16.250+02:00")).toBe(7_200_000);

    // G3, stated TZ-independently so it holds on a UTC runner too: SQLite reads an offset-less datetime
    // as UTC, `Date.parse` reads it as LOCAL, and the census's own verdict would follow the operator's
    // `TZ`. This machine is one where the two differ; the identity below is what makes the claim exact.
    const localOffsetMs = -new Date(CANONICAL).getTimezoneOffset() * 60_000;
    expect(Number(offsetless?.epoch)).toBe(Date.parse(CANONICAL));
    expect(Date.parse("2026-07-19T15:51:16.250")).toBe(Date.parse(CANONICAL) - localOffsetMs);

    // Space-separated: SQLite converts it happily, and it is the shape production really produces.
    expect(Number(space?.epoch)).toBe(Date.parse(CANONICAL));
  });
});

describe("§7.7b — the TS and SQL sides apply the SAME gate", () => {
  const CORPUS = [
    CANONICAL,
    "1969-12-31T23:59:59.750Z",
    PRODUCTION_VALUE,
    "2026-02-28T23:59:59.999Z",
    "2024-02-29T12:00:00.000Z",
    "2026-01-01T24:01:00.000Z",
    "2026-01-01T24:00:00.123Z",
    "2026-02-30T10:00:00.000Z",
    "2026-01-01T12:60:00.000Z",
    "2026-07-19T15:51:16.250+02:00",
    "2026-07-19T15:51:16.250",
    "2026-07-19 15:51:16.250Z",
    "2026-07-19T15:51:16.250123Z",
    "2026-07-19T15:51:16Z",
    "2026-06-04 20:12:04",
    "2026-07-19T15:51:16.250z",
    "",
    "not-a-timestamp",
  ];

  it("the regex accepts exactly what the GLOB accepts", () => {
    // The plan requires the two sides to apply the SAME form gate. Asserting it by RUNNING both over one
    // corpus — rather than by comparing the two constants as text — is what catches a divergence a
    // hand-translated character class would introduce (`.` literal in GLOB, escaped in the regex).
    expect(measure(CORPUS).map((m) => ({ ts: m.ts, accepted: m.malformed === "0" }))).toEqual(
      CORPUS.map((ts) => ({ ts, accepted: CANONICAL_TIMESTAMP_RE.test(ts) })),
    );
  });

  it("isCanonicalTimestamp is the TS twin of BOTH gates together", () => {
    // `Date.parse` + a canonical re-render is how the TS side sees the calendar half: `2026-02-30` parses
    // to a number and renders back as `2026-03-02`, `24:01` parses to NaN. Both are refused, and the
    // agreement below is what lets the report explain a cross-check mismatch in the SQL side's terms.
    expect(
      measure(CORPUS).map((m) => ({ ts: m.ts, ok: m.malformed === "0" && m.rollover === "0" })),
    ).toEqual(CORPUS.map((ts) => ({ ts, ok: isCanonicalTimestamp(ts) })));
  });

  it("refuses NULL on both sides — the fail-closed backstop for a column that is TEXT NOT NULL", () => {
    const stdout = execFileSync(productionSqlite3(), ["-noheader", "-bail", ":memory:"], {
      input: `SELECT ${malformedTimestampSql("NULL")};\n`,
      encoding: "utf8",
    });
    expect(stdout.trim()).toBe("1");
    expect(isCanonicalTimestamp(null)).toBe(false);
    expect(isCanonicalTimestamp(undefined)).toBe(false);
  });
});

// ───────────────────────────── gate 1b: the calendar ─────────────────────────────

describe("§7.7b — the calendar gate, which GLOB alone cannot supply", () => {
  it("counts the four out-of-range shapes that pass the form gate", () => {
    // Each of these is `malformed = 0`: the shape is canonical and only the VALUE is impossible. Two of
    // them convert to a perfectly plausible epoch in SQLite while `Date.parse` says NaN — which is the
    // divergence that would have been written as an immutable owner.
    expect(
      measure([
        "2026-01-01T24:01:00.000Z",
        "2026-01-01T24:00:00.123Z",
        "2026-02-30T10:00:00.000Z",
        "2026-01-01T12:60:00.000Z",
      ]),
    ).toEqual([
      { ts: "2026-01-01T24:01:00.000Z", malformed: "0", rollover: "1", epoch: "1767312060000" },
      { ts: "2026-01-01T24:00:00.123Z", malformed: "0", rollover: "1", epoch: "1767312000123" },
      // Both engines AGREE on this one — it is aborted anyway, because a one-way live-money write on a
      // date that does not exist is not a thing to be clever about.
      { ts: "2026-02-30T10:00:00.000Z", malformed: "0", rollover: "1", epoch: "1772445600000" },
      // `strftime` yields NULL here, which is why the predicate is `IS NOT` and never `<>`.
      { ts: "2026-01-01T12:60:00.000Z", malformed: "0", rollover: "1", epoch: "NULL" },
    ]);
    expect(Date.parse("2026-01-01T24:01:00.000Z")).toBeNaN();
    expect(Date.parse("2026-01-01T24:00:00.123Z")).toBeNaN();
    expect(Date.parse("2026-01-01T12:60:00.000Z")).toBeNaN();
    expect(Date.parse("2026-02-30T10:00:00.000Z")).toBe(1772445600000);
  });

  it("is not over-tight — the leap day and the last millisecond of February pass", () => {
    expect(
      measure(["2026-02-28T23:59:59.999Z", "2024-02-29T12:00:00.000Z", PRODUCTION_VALUE]),
    ).toEqual([
      { ts: "2026-02-28T23:59:59.999Z", malformed: "0", rollover: "0", epoch: "1772323199999" },
      { ts: "2024-02-29T12:00:00.000Z", malformed: "0", rollover: "0", epoch: "1709208000000" },
      { ts: PRODUCTION_VALUE, malformed: "0", rollover: "0", epoch: "1780603924039" },
    ]);
  });

  it("negative control — the naive round trip MISSES 24:01, so it cannot replace the epoch one", () => {
    // The obvious simplification. On 3.37.2 it echoes `2026-01-01T24:01:00` back unchanged, so the row
    // passes and the census converts a value JS reads as NaN. It happens to catch `12:60` (NULL), which
    // is exactly what makes it look sufficient to a later editor. Only the round trip THROUGH the
    // computed epoch normalizes the rollover.
    const naive = (ts: string) =>
      `strftime('%Y-%m-%dT%H:%M:%S', substr(${ts},1,19)||'Z') IS NOT substr(${ts},1,19)`;
    const rows = ["2026-01-01T24:01:00.000Z", "2026-01-01T12:60:00.000Z"]
      .map((ts) => `('${ts}')`)
      .join(",");
    const stdout = execFileSync(productionSqlite3(), ["-noheader", "-bail", ":memory:"], {
      input: `WITH t(ts) AS (VALUES ${rows})\nSELECT ts, ${naive("ts")}, ${rolloverTimestampSql("ts")} FROM t;\n`,
      encoding: "utf8",
    });
    expect(stdout.trim().split("\n")).toEqual([
      "2026-01-01T24:01:00.000Z|0|1",
      "2026-01-01T12:60:00.000Z|1|1",
    ]);
  });
});

// ───────────────────────────── part 2: the conversion itself ─────────────────────────────

describe("§7.7b — the pinned conversion IS Date.parse", () => {
  /** All 1000 millisecond residues of one second, both formulas, in a single CLI run. */
  function residues(): ReadonlyArray<{ ts: string; pinned: number; julianday: number }> {
    const stamps = Array.from(
      { length: 1000 },
      (_, n) => `2026-07-19T15:51:16.${String(n).padStart(3, "0")}Z`,
    );
    const values = stamps.map((ts) => `('${ts}')`).join(",");
    const stdout = execFileSync(productionSqlite3(), ["-noheader", "-bail", ":memory:"], {
      input:
        `WITH t(ts) AS (VALUES ${values})\nSELECT ts, ${epochMsSql("ts")},` +
        ` ${JULIANDAY_MS_SQL} FROM t;\n`,
      encoding: "utf8",
    });
    return stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [ts, pinned, julianday] = line.split("|");
        return { ts: ts ?? "", pinned: Number(pinned), julianday: Number(julianday) };
      });
  }

  /** Plan v5's formula, kept ONLY as the negative control below. Never emitted by anything. */
  const JULIANDAY_MS_SQL = "CAST(ROUND((julianday(ts) - 2440587.5) * 86400000) AS INTEGER)";

  it("agrees with Date.parse on all 1000 millisecond residues of a fixed second", () => {
    const wrong = residues().filter((r) => r.pinned !== Date.parse(r.ts));
    expect(wrong).toEqual([]);
  });

  it("negative control — v5's julianday formula is off by −1 ms on 92 of the same 1000", () => {
    // Recorded as an exact count and its first five offenders, not as "some": the defect is a
    // float-rounding tick, so a formula that drifted would still be "mostly right" and a >0 assertion
    // would not notice a DIFFERENT wrong formula being substituted for this one.
    const wrong = residues().filter((r) => r.julianday !== Date.parse(r.ts));
    expect(wrong.length).toBe(92);
    expect(wrong.slice(0, 5).map((r) => r.ts)).toEqual([
      "2026-07-19T15:51:16.002Z",
      "2026-07-19T15:51:16.005Z",
      "2026-07-19T15:51:16.016Z",
      "2026-07-19T15:51:16.019Z",
      "2026-07-19T15:51:16.022Z",
    ]);
    expect(wrong.every((r) => r.julianday === Date.parse(r.ts) - 1)).toBe(true);
  });

  it("is right on the real production value, where v5's formula is wrong", () => {
    const stdout = execFileSync(productionSqlite3(), ["-noheader", "-bail", ":memory:"], {
      input: `WITH t(ts) AS (VALUES ('${PRODUCTION_VALUE}'))\nSELECT ${epochMsSql("ts")}, ${JULIANDAY_MS_SQL} FROM t;\n`,
      encoding: "utf8",
    });
    // Not a latent class: this timestamp is on a current target (§5.4.2).
    expect(stdout.trim()).toBe("1780603924039|1780603924038");
    expect(Date.parse(PRODUCTION_VALUE)).toBe(1780603924039);
  });

  it("keeps the milliseconds a whole-second conversion would drop", () => {
    // `sellableFlow.appliesFromMs` carries a millisecond remainder, so `strftime('%s', ts)` alone would
    // decide the cutoff comparison on a truncated value. `unixepoch()` — which would be the obvious fix —
    // does not exist on 3.37.2 at all.
    const stdout = execFileSync(productionSqlite3(), ["-noheader", "-bail", ":memory:"], {
      input: `WITH t(ts) AS (VALUES ('${CANONICAL}'))\nSELECT ${epochMsSql("ts")} - CAST(strftime('%s', ts) AS INTEGER)*1000 FROM t;\n`,
      encoding: "utf8",
    });
    expect(stdout.trim()).toBe("250");
  });
});

// ───────────────────────────── part 3: the TS side ─────────────────────────────

/**
 * §5.4.2 part 3 — the census's TS verdict must not depend on the operator's `TZ`.
 *
 * The fixture is space-separated WITH the trailing `Z`, deliberately: `Date.parse` reads that shape as
 * UTC on every machine, so the test discriminates identically on a UTC runner and on this Moscow one. An
 * offset-less fixture would have made the assertion vacuous wherever the offset is zero.
 */
const MALFORMED_AFTER_CUTOFF = "2026-07-21 00:01:00.000Z";

describe("§7.7b — the TS side applies the form gate before Date.parse", () => {
  const SOLO = {
    positionId: "pos-ts",
    tokenId: "tok-ts",
    conditionId: WHITELISTED_CONDITION,
    entryLane: "R23",
  };

  it("positive control — the same fixture with a canonical first_trade_at decides bounce", () => {
    // Without this row the refusal below is indistinguishable from a fixture that was never eligible.
    const run = runCensus(soloTargetSeed(SOLO, { firstTradeAt: "2026-07-21T00:01:00.000Z" }));
    expect(ownerPlan(run.decision)).toEqual({ "pos-ts": "bounce" });
  });

  it("a present-but-unparseable first_trade_at is REFUSED, and the SQL side agrees", () => {
    const run = runCensus(soloTargetSeed(SOLO, { firstTradeAt: MALFORMED_AFTER_CUTOFF }));

    // `Date.parse` accepts this shape — V8's fallback parser is far more tolerant than the census may be,
    // and it is exactly that tolerance the form gate removes.
    expect(Date.parse(MALFORMED_AFTER_CUTOFF)).toBe(Date.parse("2026-07-21T00:01:00.000Z"));
    expect(ownerPlan(run.decision)).toEqual({ "pos-ts": "profile" });
    // Agreement, not a mismatch: the SQL projection converts through the same gate, so both sides fall to
    // `profile`, and what stops the run is the VALUE — the local half of guard #7 — rather than a
    // disagreement that was never about the owner. Before §5.3 grew that local half, the earliest refusal
    // was the remote guard, under the lock.
    expect(gateById(run.gates, "cross-check").passed).toBe(true);
    expect(gateById(run.gates, "timestamp-form").passed).toBe(false);
    expect(run.gates.blocked).toBe(true);
    // §5.2(a): the row must not read as "past the cutoff" when the real cause is a ledger value the
    // census refuses to convert — the operator's next action differs.
    expect(run.decision.decisions[0]?.reason).toBe(
      "not bounce-ladder eligible (non-canonical timestamp, §5.4.2)",
    );
  });

  it("an ABSENT leg_states row takes §2.2's no-leg-state branch and still gets an owner", () => {
    const run = runCensus(soloTargetSeed(SOLO, { firstTradeAt: null }));
    expect(ownerPlan(run.decision)).toEqual({ "pos-ts": "profile" });
    expect(gateById(run.gates, "cross-check").passed).toBe(true);
    expect(run.loaded.manifest.targets[0]?.firstTradeAt).toBeNull();
    // The absent row is §2.2's branch, NOT a refused value — the two must not report as the same thing.
    expect(run.decision.decisions[0]?.reason).toBe(
      "not bounce-ladder eligible (lane/sellableFlow cutoff)",
    );
  });

  it("a GATE-lane target is decided WITHOUT converting either timestamp", () => {
    // §2.1 short-circuits on the lane before the sellable-flow branch, and so does the SQL projection.
    // A TS-side gate that refused the row instead would put the two sides into a false disagreement.
    const run = runCensus(
      soloTargetSeed(
        { ...SOLO, entryLane: "GATE", openedAt: MALFORMED_AFTER_CUTOFF },
        { firstTradeAt: MALFORMED_AFTER_CUTOFF },
      ),
    );
    expect(ownerPlan(run.decision)).toEqual({ "pos-ts": "bounce" });
    expect(gateById(run.gates, "cross-check").passed).toBe(true);
    // The DECISION converts nothing — and the run is blocked anyway, which is not a contradiction: guard
    // #7 converts every target's timestamps under the lock whatever its lane, so a manifest carrying these
    // bytes aborts the apply regardless of how the owner was reached. This is the case that used to pass
    // the dry run clean and surface only after `BEGIN IMMEDIATE` had been taken on the live ledger.
    expect(gateById(run.gates, "timestamp-form").offending).toHaveLength(2);
    expect(run.gates.blocked).toBe(true);
  });
});

// ───────────────────────────── part 3b: the two gates' LOCAL halves ─────────────────────────────

/**
 * §5.3 — guards #7 and #7b each have a local half, evaluated against the frozen manifest at DRY RUN.
 *
 * Without them the earliest refusal of a non-canonical timestamp is under the lock: the operator takes
 * `BEGIN IMMEDIATE` on the live ledger, the guard aborts, and the maintenance window is spent discovering a
 * value the manifest already carried. These gates move that verdict to the dry run and name the offending
 * row; the `--apply` guards stay exactly where they are, as the fence against a ledger that changed since.
 */
describe("§7.7b — the form and calendar gates' LOCAL halves block the dry run", () => {
  const SOLO = {
    positionId: "pos-ts",
    tokenId: "tok-ts",
    conditionId: WHITELISTED_CONDITION,
    entryLane: "R23",
  };

  /** A calendar-invalid value whose SHAPE is canonical — SQLite rolls `24:01` over to the next day. */
  const ROLLOVER = "2026-07-21T24:01:00.000Z";

  /** The gate's rows AND its verdict together, so a gate that reports rows without failing cannot pass. */
  function gateRows(run: CensusRun, id: string): Array<Record<string, unknown>> {
    const gate = gateById(run.gates, id);
    expect(gate.blocking).toBe(true);
    expect(gate.passed).toBe(gate.offending.length === 0);
    return [...gate.offending];
  }

  it("positive control — a clean fixture passes both, and nothing blocks", () => {
    // Without it every assertion below is satisfied by two gates that fail on everything.
    const run = runCensus(cleanSeed());
    expect(gateRows(run, "timestamp-form")).toEqual([]);
    expect(gateRows(run, "timestamp-calendar")).toEqual([]);
    expect(run.gates.blocked).toBe(false);
  });

  it("a non-canonical opened_at fails the FORM gate, naming the row, and blocks the run", () => {
    const run = runCensus(
      soloTargetSeed({ ...SOLO, openedAt: MALFORMED_AFTER_CUTOFF }, { firstTradeAt: AFTER_CUTOFF }),
    );
    expect(gateRows(run, "timestamp-form")).toEqual([
      { position_id: "pos-ts", column: "opened_at", value: MALFORMED_AFTER_CUTOFF },
    ]);
    expect(run.gates.blocked).toBe(true);
  });

  it("a non-canonical first_trade_at fails it too — the leg-state timestamp is inspected as well", () => {
    const run = runCensus(soloTargetSeed(SOLO, { firstTradeAt: MALFORMED_AFTER_CUTOFF }));
    expect(gateRows(run, "timestamp-form")).toEqual([
      { position_id: "pos-ts", column: "first_trade_at", value: MALFORMED_AFTER_CUTOFF },
    ]);
    expect(run.gates.blocked).toBe(true);
  });

  it("both malformed at once produce BOTH rows — the gate reports the set, never the first offender", () => {
    const run = runCensus(
      soloTargetSeed(
        { ...SOLO, openedAt: MALFORMED_AFTER_CUTOFF },
        { firstTradeAt: MALFORMED_AFTER_CUTOFF },
      ),
    );
    expect(gateRows(run, "timestamp-form")).toEqual([
      { position_id: "pos-ts", column: "opened_at", value: MALFORMED_AFTER_CUTOFF },
      { position_id: "pos-ts", column: "first_trade_at", value: MALFORMED_AFTER_CUTOFF },
    ]);
  });

  it("an ABSENT leg-state row contributes NO timestamp — §2.2's branch is not a malformed value", () => {
    // The null branch's negative control: a gate that read `first_trade_at` unconditionally would report a
    // `null` value here and block every legacy target production carries.
    const run = runCensus(soloTargetSeed(SOLO, { firstTradeAt: null }));
    expect(gateRows(run, "timestamp-form")).toEqual([]);
    expect(gateRows(run, "timestamp-calendar")).toEqual([]);
    expect(run.loaded.manifest.targets[0]?.firstTradeAt).toBeNull();
  });

  it("a calendar-invalid opened_at passes the FORM gate and fails the CALENDAR one", () => {
    // The shape is canonical and only the VALUE is impossible, so the two gates are disjoint here.
    // Asserting BOTH verdicts is what distinguishes two gates from one gate reported twice.
    const run = runCensus(
      soloTargetSeed({ ...SOLO, openedAt: ROLLOVER }, { firstTradeAt: AFTER_CUTOFF }),
    );
    expect(gateRows(run, "timestamp-form")).toEqual([]);
    expect(gateRows(run, "timestamp-calendar")).toEqual([
      { position_id: "pos-ts", column: "opened_at", value: ROLLOVER },
    ]);
    expect(run.gates.blocked).toBe(true);
  });

  it("a non-canonical value is reported by the FORM gate ONLY — a calendar verdict would follow TZ", () => {
    // `Date.parse` reads an offset-less shape as LOCAL time, so a calendar verdict on a row the form gate
    // already refuses would differ between operators. The form gate blocks either way; reporting the row
    // twice would only make the report depend on the machine it ran on.
    const run = runCensus(
      soloTargetSeed({ ...SOLO, openedAt: MALFORMED_AFTER_CUTOFF }, { firstTradeAt: AFTER_CUTOFF }),
    );
    expect(gateRows(run, "timestamp-form")).toHaveLength(1);
    expect(gateRows(run, "timestamp-calendar")).toEqual([]);
  });
});

// ───────────────────────────── the --apply pair ─────────────────────────────

/**
 * §5.4.2's absent-row / present-but-malformed pair, against the real schema and the pinned CLI. Either
 * test alone is satisfiable by the wrong implementation: a `LEFT JOIN`-built guard input manufactures a
 * NULL row for the absent case and aborts on a timestamp that does not exist, and "fixing" that by
 * suppressing the guard passes the positive and fails the negative.
 */
describe("§7.7b — --apply: an absent leg-state row COMMITS, a malformed one ABORTS", () => {
  const SOLO = {
    positionId: "pos-leg",
    tokenId: "tok-leg",
    conditionId: WHITELISTED_CONDITION,
    entryLane: "R23",
  };

  it("positive — a target with NO leg_states row commits, with its owner written as planned", () => {
    const applied = prepareApply(soloTargetSeed(SOLO, { firstTradeAt: null }));
    expect(applied.plannedOwners).toEqual({ "pos-leg": "profile" });

    const run = applied.fixture.runApply(applied.applySql);
    expect(run.stderr).toBe("");
    expect(run.ok).toBe(true);
    expect(applied.fixture.ownerMap()).toEqual({ "pos-leg": "profile" });
  });

  it("negative — a leg_states row carrying malformed non-NULL text aborts at guard #7", () => {
    // `'2026-06-04 20:12:04'` — the production value with a space instead of the `T`, i.e. a shape the
    // system demonstrably produces, rather than an invented garbage string.
    const applied = prepareApply(soloTargetSeed(SOLO, { firstTradeAt: "2026-06-04 20:12:04" }));

    expect(probeGuard(applied, { id: "7" })).toBe("0");
    expectRolledBack(applied, CHECK_FAILED);
  });

  it("specificity — guard #7 reads 1 for the absent row, so the abort is the VALUE and not the join", () => {
    // The discriminating half: with the leg-state row gone the guard's INNER JOIN contributes no
    // `first_trade_at` at all, so the only converted timestamp is `opened_at` and the guard passes.
    expect(
      probeGuard(prepareApply(soloTargetSeed(SOLO, { firstTradeAt: null })), { id: "7" }),
    ).toBe("1");
    expect(probeGuard(prepareApply(soloTargetSeed(SOLO)), { id: "7" })).toBe("1");
  });

  it("a malformed opened_at aborts too — the guard covers every target, joined or not", () => {
    const applied = prepareApply(
      soloTargetSeed({ ...SOLO, openedAt: "2026-07-21 00:01:00.000Z" }, { firstTradeAt: null }),
    );
    expect(probeGuard(applied, { id: "7" })).toBe("0");
    expectRolledBack(applied, CHECK_FAILED);
  });

  it("a calendar-invalid opened_at passes the form gate and aborts at #7b instead", () => {
    const applied = prepareApply(
      soloTargetSeed(
        { ...SOLO, openedAt: "2026-07-21T24:01:00.000Z" },
        { firstTradeAt: AFTER_CUTOFF },
      ),
    );
    expect(probeGuard(applied, { id: "7" })).toBe("1");
    expect(probeGuard(applied, { id: "7b" })).toBe("0");
    expectRolledBack(applied, CHECK_FAILED);
  });
});

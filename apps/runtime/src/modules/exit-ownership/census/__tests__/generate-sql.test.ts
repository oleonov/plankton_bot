import { describe, expect, it } from "vitest";

import { realString } from "../export-sql.js";
import {
  AFTER_CUTOFF,
  BEFORE_CUTOFF,
  soloTargetSeed,
  WHITELISTED_CONDITION,
  type CensusFixture,
} from "./fixtures.js";
import { prepareApply } from "./pipeline.js";

/**
 * §7 test 6 — statement generation: the CAS predicate's shape, `IS` (not `=`) on the nullable columns,
 * and the escaping of a value carrying a `'`.
 *
 * Each property is asserted on BOTH axes, because the emitted text is only half the claim: the shape is
 * read out of the script, and then the script is RUN on the pinned 3.37.2 CLI against a real ledger — with
 * a mutation that removes exactly the property under test, to prove the property is what makes the run
 * work rather than something the run would survive without.
 */

/** Every `UPDATE positions …;` the generator emitted, in emission order. */
function casStatements(applySql: string): string[] {
  return [...applySql.matchAll(/^UPDATE positions SET [\s\S]*?;$/gm)].map((m) => m[0]);
}

/** One CAS as its lines, with the generator's column alignment collapsed to single spaces. */
function clauses(statement: string): string[] {
  return statement.split("\n").map((line) => line.trim().replace(/\s+/g, " ").replace(/;$/, ""));
}

describe("§7.6 — the CAS predicate's shape", () => {
  it("emits one statement per target, each conditioned on every §5.4 routing input", () => {
    const { applySql } = prepareApply();

    expect(applySql).toContain(
      "-- §5.4 — the compare-and-swap, one statement per target (3 rows).",
    );
    expect(casStatements(applySql).map(clauses)).toEqual([
      [
        "UPDATE positions SET exit_owner = 'bounce'",
        "WHERE position_id = 'pos-bounce'",
        "AND exit_owner IS NULL",
        "AND status IN ('open', 'dust')",
        `AND condition_id IS '${WHITELISTED_CONDITION}'`,
        `AND opened_at IS '${AFTER_CUTOFF}'`,
        "AND entry_lane IS 'R23'",
      ],
      [
        "UPDATE positions SET exit_owner = 'bounce'",
        "WHERE position_id = 'pos-gate'",
        "AND exit_owner IS NULL",
        "AND status IN ('open', 'dust')",
        // The legacy `''` of §2.3, carried through as itself — never normalized to NULL, which would
        // make the CAS match a row whose condition had since been populated.
        "AND condition_id IS ''",
        `AND opened_at IS '${BEFORE_CUTOFF}'`,
        "AND entry_lane IS 'GATE'",
      ],
      [
        "UPDATE positions SET exit_owner = 'profile'",
        "WHERE position_id = 'pos-profile'",
        "AND exit_owner IS NULL",
        "AND status IN ('open', 'dust')",
        "AND condition_id IS '0xnotwhitelisted'",
        `AND opened_at IS '${AFTER_CUTOFF}'`,
        "AND entry_lane IS 'R23'",
      ],
    ]);
  });

  it("does NOT condition on size — §5.1.10's rendering is guard #3's business, not the CAS's", () => {
    // A REAL cannot be compared as a literal here: the apply script's `12.5` and the ledger's double are
    // the same value only by luck of the rendering (see §5.1.10), so a CAS that compared it would fail
    // to match ~1 target in 5 and silently leave them unowned. Drift on `size` is detected — by guard #3,
    // rendering against rendering — rather than routed around.
    for (const statement of casStatements(prepareApply().applySql)) {
      expect(statement).not.toContain("size");
    }
  });

  it("sits INSIDE the guarded transaction — after guard #7b, before guard #8 and the COMMIT", () => {
    const { applySql } = prepareApply();
    const first = casStatements(applySql)[0] ?? "";

    expect(applySql.indexOf("-- guard #7b")).toBeLessThan(applySql.indexOf(first));
    expect(applySql.indexOf(first)).toBeLessThan(applySql.indexOf("-- guard #8"));
    expect(applySql.indexOf("-- guard #8")).toBeLessThan(applySql.indexOf("\nCOMMIT;"));
  });
});

describe("§7.6 — `IS`, never `=`, on the nullable columns", () => {
  const NULL_LANE_SEED = soloTargetSeed({
    positionId: "pos-null-lane",
    tokenId: "tok-null-lane",
    entryLane: null,
  });

  it("a NULL entry_lane compares with IS, and the target is really written", () => {
    const { fixture, applySql, plannedOwners } = prepareApply(NULL_LANE_SEED);

    expect(clauses(casStatements(applySql)[0] ?? "")).toContain("AND entry_lane IS NULL");
    expect(applySql).not.toMatch(/=\s*NULL/);

    const run = fixture.runApply(applySql);
    expect(run.stderr).toBe("");
    expect(run.ok).toBe(true);
    expect(fixture.ownerMap()).toEqual(plannedOwners);
    expect(plannedOwners).toEqual({ "pos-null-lane": "bounce" });
  });

  it("specificity — rewritten to `= NULL` the CAS matches nothing and the whole run aborts", () => {
    const { fixture, applySql } = prepareApply(NULL_LANE_SEED);
    // `= NULL` yields NULL rather than true, so the UPDATE touches zero rows. SQLite raises nothing for
    // that, which is the entire reason guard #8 exists as a statement: the abort has to come from the
    // accounting, not from the write.
    const run = fixture.runApply(applySql.replace("entry_lane  IS NULL", "entry_lane  = NULL"));

    expect(run.ok).toBe(false);
    expect(run.stderr).toContain("CHECK constraint failed");
    expect(fixture.ownerMap()).toEqual({ "pos-null-lane": null });
  });
});

describe("§7.6 — literal escaping", () => {
  const APOSTROPHE_SEED = soloTargetSeed({
    positionId: "pos-o'brien",
    tokenId: "tok-o'brien",
    entryLane: "R23'X",
  });

  it("a value containing `'` is doubled everywhere it is emitted, and the run commits", () => {
    const { fixture, applySql } = prepareApply(APOSTROPHE_SEED);

    // All three interpolation sites: the manifest temp table, `projected_owners`, and the CAS.
    expect(applySql).toContain("'pos-o''brien'");
    expect(applySql).toContain("'tok-o''brien'");
    expect(applySql).toContain("'R23''X'");
    expect(applySql).not.toContain("'pos-o'brien'");

    const run = fixture.runApply(applySql);
    expect(run.stderr).toBe("");
    expect(run.ok).toBe(true);
    expect(fixture.ownerMap()).toEqual({ "pos-o'brien": "bounce" });
  });

  it("specificity — un-doubling the CAS's escapes makes the script unparseable and writes nothing", () => {
    const { fixture, applySql } = prepareApply(APOSTROPHE_SEED);
    const cas = casStatements(applySql)[0] ?? "";
    const run = fixture.runApply(applySql.replace(cas, cas.replaceAll("''", "'")));

    expect(run.ok).toBe(false);
    expect(run.stderr).toContain("syntax error");
    expect(fixture.ownerMap()).toEqual({ "pos-o'brien": null });
  });
});

/**
 * §5.1.10, as the operator approved it on 2026-07-29: a REAL crosses into the apply script as the decimal
 * string sqlite RENDERED, and guard #3 compares that string against the same rendering taken under the
 * lock. It is never parsed back into a double, by anything.
 *
 * The transport it replaced did parse — the exporter emitted a JSON number and the generator emitted it
 * back as a bare SQL numeric — and whether THAT survives turns out to be a property of the machine rather
 * than of the ledger. `printf('%!.17g')` in 3.37.2 converts through `LONGDOUBLE_TYPE`: 80-bit on x86_64
 * (production and CI), where it is correctly rounded, and 64-bit on arm64 macOS (dev), where 28.4% of a
 * 200 000-size sample read back as a different double — guard #3 aborting runs on rows that never moved.
 * So the tests below measure which of the two hosts they are running on and assert the matching claim. The
 * TRANSPORT does not branch, and that is the whole point of it: it is correct on both.
 */
describe("§7.6 — §5.1.10: sizes travel as renderings, not as numbers", () => {
  const SIZE_SEED = soloTargetSeed({ positionId: "pos-size", tokenId: "tok-size", size: 12 });
  const SIZE_RENDERING = `SELECT ${realString("size")} FROM positions WHERE position_id = 'pos-size';`;

  /**
   * How many of a realistic size sample this build renders into a decimal that reads back as a different
   * double — the leg the bare-numeric transport depended on and §5.1.10 does not take at all.
   */
  function lossyRenderings(fixture: CensusFixture): number {
    return Number(
      fixture.query(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000),
                        v(x) AS (SELECT (i % 4000) + (i % 977) / 977.0 + (i % 89) / 8900.0 FROM n)
         SELECT sum(CAST(printf('%!.17g', x) AS REAL) IS NOT x) FROM v;`,
      ),
    );
  }

  it("the manifest carries the ledger renderer's own output, and the host decides whether that parses", () => {
    const { fixture, loaded } = prepareApply(SIZE_SEED);
    const rendered = loaded.manifest.targets[0]?.size ?? "";

    // Host-independent: the string in the manifest is exactly what the ledger's renderer produced. The
    // export chain adds nothing to it, and there is nothing else it could be compared against.
    expect(rendered).toBe(fixture.query(SIZE_RENDERING));

    const parsedBack = fixture.query(
      `SELECT ${Number(rendered)} IS (SELECT size FROM positions WHERE position_id = 'pos-size');`,
    );
    if (lossyRenderings(fixture) === 0) {
      // x86_64: the 80-bit intermediate rounds correctly, so `12` renders "12.0" and the old numeric
      // transport would have committed. It was replaced anyway — this leg is the host's property, not ours.
      expect(Number(rendered)).toBe(12);
      expect(parsedBack).toBe("1");
    } else {
      // arm64: `12` renders "11.999999999999999", which Node reads back as 11.999999999999998, and
      // `11.999999999999998 IS 12.0` is FALSE — guard #3 aborting a run that had no drift.
      expect(Number(rendered)).not.toBe(12);
      expect(parsedBack).toBe("0");
    }
  });

  it("a size 3.37.2 may render lossily still commits on an unchanged ledger", () => {
    const { fixture, loaded, applySql, plannedOwners } = prepareApply(SIZE_SEED);
    const rendered = fixture.query(SIZE_RENDERING);

    expect(loaded.manifest.targets[0]?.size).toBe(rendered);
    // A quoted TEXT literal, so the temp table holds the rendering and guard #3 compares like with like.
    expect(applySql).toContain(`'${rendered}'`);

    const run = fixture.runApply(applySql);
    expect(run.stderr).toBe("");
    expect(run.ok).toBe(true);
    expect(fixture.ownerMap()).toEqual(plannedOwners);
  });

  it("sensitivity — a size that genuinely moved between export and lock still rolls the run back", () => {
    const { fixture, applySql } = prepareApply(SIZE_SEED);
    // 0.01 shares: the granularity a fill actually moves a position by, and the resolution §5.1.10 claims
    // the rendering keeps. Anything coarser would not test the claim.
    fixture.seed("UPDATE positions SET size = 12.01 WHERE position_id = 'pos-size';");

    const run = fixture.runApply(applySql);
    expect(run.ok).toBe(false);
    expect(run.stderr).toContain("CHECK constraint failed");
    expect(fixture.ownerMap()).toEqual({ "pos-size": null });
  });
});

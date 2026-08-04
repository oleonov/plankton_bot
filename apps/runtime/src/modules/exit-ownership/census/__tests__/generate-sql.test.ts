import { describe, expect, it } from "vitest";

import { AFTER_CUTOFF, BEFORE_CUTOFF, soloTargetSeed, WHITELISTED_CONDITION } from "./fixtures.js";
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
 * lock. The bare-numeric transport it replaced reported drift on 17.4% of measured sizes — on rows that
 * had not moved — so `--apply` could not have committed against production at all.
 */
describe("§7.6 — §5.1.10: sizes travel as renderings, not as numbers", () => {
  const SIZE_SEED = soloTargetSeed({ positionId: "pos-size", tokenId: "tok-size", size: 12 });

  it("the transport this replaced would have reported drift on this very row", () => {
    const { fixture, loaded } = prepareApply(SIZE_SEED);
    const rendered = loaded.manifest.targets[0]?.size ?? "";

    // (1) 3.37.2 renders the ledger's `12` as a decimal that is not 12, and (2) Node reads that text
    // back — correctly — as a DIFFERENT double. (3) The number the old `sqlReal` would then have emitted
    // does not compare equal to the untouched ledger REAL: guard #3 aborting a run that had no drift.
    expect(rendered).toBe("11.999999999999999");
    expect(Number(rendered)).toBe(11.999999999999998);
    expect(
      fixture.query(
        `SELECT ${Number(rendered)} IS (SELECT size FROM positions WHERE position_id = 'pos-size');`,
      ),
    ).toBe("0");
  });

  it("a size 3.37.2 renders lossily still commits on an unchanged ledger", () => {
    const { fixture, loaded, applySql, plannedOwners } = prepareApply(SIZE_SEED);

    expect(loaded.manifest.targets[0]?.size).toBe("11.999999999999999");
    // A quoted TEXT literal, so the temp table holds the rendering and guard #3 compares like with like.
    expect(applySql).toContain("'11.999999999999999'");

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

import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { parseArgs, type CensusMode, type CensusOperand } from "../main.js";
import { runCli } from "./cli.js";

/**
 * §7 tests 17, 19 and 20 — the argv contract, table-driven.
 *
 * The table below is the test's OWN literal transcription of §5.2's matrix, deliberately not an import of
 * `OPERAND_MATRIX`: a test that read the production table would go green on a wrong one. Tests 13/18/19
 * enumerate operands by hand mode by mode and between them cover roughly half the grid — which is the very
 * defect §5.2's matrix fixes — so the cases here are generated from the table instead.
 */

type Disposition = "required" | "optional" | "rejected";

interface Cell {
  readonly mode: CensusMode;
  readonly operand: CensusOperand;
  readonly disposition: Disposition;
}

const CELLS: readonly Cell[] = [
  { mode: "dry-run", operand: "manifest", disposition: "required" },
  { mode: "dry-run", operand: "max-manifest-age-hours", disposition: "optional" },
  { mode: "dry-run", operand: "frozen", disposition: "rejected" },
  { mode: "dry-run", operand: "decision", disposition: "rejected" },
  { mode: "dry-run", operand: "decision-digest", disposition: "rejected" },
  { mode: "apply", operand: "manifest", disposition: "required" },
  { mode: "apply", operand: "max-manifest-age-hours", disposition: "required" },
  { mode: "apply", operand: "frozen", disposition: "rejected" },
  { mode: "apply", operand: "decision", disposition: "rejected" },
  { mode: "apply", operand: "decision-digest", disposition: "rejected" },
  { mode: "verify-owner-map", operand: "manifest", disposition: "required" },
  { mode: "verify-owner-map", operand: "max-manifest-age-hours", disposition: "required" },
  { mode: "verify-owner-map", operand: "frozen", disposition: "required" },
  { mode: "verify-owner-map", operand: "decision", disposition: "required" },
  { mode: "verify-owner-map", operand: "decision-digest", disposition: "required" },
  { mode: "emit-export-sql", operand: "manifest", disposition: "rejected" },
  { mode: "emit-export-sql", operand: "max-manifest-age-hours", disposition: "rejected" },
  { mode: "emit-export-sql", operand: "frozen", disposition: "rejected" },
  { mode: "emit-export-sql", operand: "decision", disposition: "rejected" },
  { mode: "emit-export-sql", operand: "decision-digest", disposition: "rejected" },
];

const MODE_FLAGS: Record<CensusMode, readonly string[]> = {
  "dry-run": [],
  apply: ["--apply"],
  "verify-owner-map": ["--verify-owner-map"],
  "emit-export-sql": ["--emit-export-sql"],
};

/** Every path points INTO `dir` and none of them exists — see `expectNothingOpened`. */
let dir = "";
const operandValue = (operand: CensusOperand, suffix = "a"): string =>
  operand === "max-manifest-age-hours"
    ? suffix === "a"
      ? "24"
      : "48"
    : operand === "decision-digest"
      ? (suffix === "a" ? "0" : "1").repeat(64)
      : join(dir, `${operand}-${suffix}.json`);

/** The argv every cell starts from: the mode flag plus each operand that mode REQUIRES. */
function baseArgv(mode: CensusMode, omit?: CensusOperand): string[] {
  const argv = [...MODE_FLAGS[mode]];
  for (const cell of CELLS) {
    if (cell.mode !== mode || cell.disposition !== "required" || cell.operand === omit) continue;
    argv.push(`--${cell.operand}`, operandValue(cell.operand));
  }
  return argv;
}

/**
 * The proxy for "no database opened and no file read": every operand path names a file that does not exist
 * inside an empty temp dir, so a run that got as far as opening one fails with the loader's `io` rejection
 * ("cannot read the census …"), and a run that materialized a ledger had to read a manifest first. Both are
 * therefore observable without mocking `node:fs`, which the census imports as ESM named bindings.
 */
function expectNothingOpened(stderr: string): void {
  expect(stderr).not.toContain("cannot read");
  expect(readdirSync(dir)).toEqual([]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "krabs-census-argv-"));
});

describe("§7.20 — the mode × operand matrix, all 20 cells", () => {
  it("covers exactly 20 cells (4 modes × 5 operands)", () => {
    expect(CELLS).toHaveLength(20);
    expect(new Set(CELLS.map((c) => `${c.mode}|${c.operand}`)).size).toBe(20);
  });

  const rejected = CELLS.filter((c) => c.disposition === "rejected");
  it.each(rejected)("rejects --$operand in $mode mode", (cell) => {
    const run = runCli([...baseArgv(cell.mode), `--${cell.operand}`, operandValue(cell.operand)]);
    expect(run.code).not.toBe(0);
    // Both names, never a generic usage dump — the operator must learn which of the two to drop.
    expect(run.stderr).toContain(`--${cell.operand}`);
    expect(run.stderr).toContain(cell.mode === "dry-run" ? "dry-run" : `--${cell.mode}`);
    expect(run.stdout).toBe("");
    expectNothingOpened(run.stderr);
  });

  const required = CELLS.filter((c) => c.disposition === "required");
  it.each(required)("requires --$operand in $mode mode", (cell) => {
    const run = runCli(baseArgv(cell.mode, cell.operand));
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`--${cell.operand}`);
    expectNothingOpened(run.stderr);
  });

  // The negative control: without it a `parseArgs` that rejected EVERYTHING would pass all 15 rejected
  // cells and 4 of the 5 others.
  it.each(CELLS.filter((c) => c.disposition !== "rejected"))(
    "accepts a valid --$operand in $mode mode",
    (cell) => {
      const argv = baseArgv(cell.mode);
      if (cell.disposition === "optional")
        argv.push(`--${cell.operand}`, operandValue(cell.operand));
      expect(() => parseArgs(argv)).not.toThrow();
    },
  );

  // The multiplicity row runs over ALL 20 cells, not the 5 accepted ones: the check precedes mode
  // dispatch, so on a `rejected` cell the repeat is what fires, naming both values.
  it.each(CELLS)("rejects --$operand supplied twice in $mode mode", (cell) => {
    const [first, second] = [operandValue(cell.operand, "a"), operandValue(cell.operand, "b")];
    const run = runCli([
      ...baseArgv(cell.mode, cell.operand),
      `--${cell.operand}`,
      first,
      `--${cell.operand}`,
      second,
    ]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`--${cell.operand}`);
    expect(run.stderr).toContain(first);
    expect(run.stderr).toContain(second);
    expectNothingOpened(run.stderr);
  });

  // A value comparison rather than a count would silently re-admit the whole class the moment the two
  // values happen to match, and would leave `--manifest a --manifest a` indistinguishable from
  // `--manifest a` in the diagnostic.
  it.each(CELLS)("rejects --$operand repeated with the IDENTICAL value in $mode mode", (cell) => {
    const value = operandValue(cell.operand);
    const run = runCli([
      ...baseArgv(cell.mode, cell.operand),
      `--${cell.operand}`,
      value,
      `--${cell.operand}`,
      value,
    ]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`--${cell.operand}`);
    expectNothingOpened(run.stderr);
  });

  it("the two verifying cases: the dangerous surviving value is never consumed", () => {
    const stale = runCli([
      "--apply",
      "--manifest",
      join(dir, "fresh.json"),
      "--manifest",
      join(dir, "stale.json"),
      "--max-manifest-age-hours",
      "24",
    ]);
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain("stale.json");
    expectNothingOpened(stale.stderr);

    const widened = runCli([
      "--apply",
      "--manifest",
      join(dir, "fresh.json"),
      "--max-manifest-age-hours",
      "1",
      "--max-manifest-age-hours",
      "9999",
    ]);
    expect(widened.code).not.toBe(0);
    expect(widened.stderr).toContain("9999");
    expectNothingOpened(widened.stderr);
  });
});

describe("§7.17 — action-mode exclusivity is a COUNT over three flags, all 8 subsets", () => {
  const FLAGS = ["--apply", "--verify-owner-map", "--emit-export-sql"] as const;
  const SUBSETS: readonly (readonly string[])[] = [
    [],
    ["--apply"],
    ["--verify-owner-map"],
    ["--emit-export-sql"],
    ["--apply", "--verify-owner-map"],
    ["--apply", "--emit-export-sql"],
    ["--verify-owner-map", "--emit-export-sql"],
    ["--apply", "--verify-owner-map", "--emit-export-sql"],
  ];

  // `.map((s) => [s])` because `it.each` SPREADS a row's array into the callback's arguments — without the
  // extra nesting the callback would receive the flags one per parameter instead of the subset.
  it.each(SUBSETS.filter((s) => s.length > 1).map((s) => [s]))(
    "rejects %j, naming every flag it saw",
    (subset) => {
      const run = runCli([...subset, "--manifest", join(dir, "m.json")]);
      expect(run.code).not.toBe(0);
      for (const flag of subset) expect(run.stderr).toContain(flag);
      // Naming EVERY flag is a property no pairwise formulation satisfies even when its rejection is right.
      for (const flag of FLAGS.filter((f) => !subset.includes(f))) {
        expect(run.stderr).not.toContain(flag);
      }
      expect(run.stdout).toBe("");
      expectNothingOpened(run.stderr);
    },
  );

  it("the empty subset selects the dry run", () => {
    expect(parseArgs(["--manifest", join(dir, "m.json")]).mode).toBe("dry-run");
  });

  it.each(SUBSETS.filter((s) => s.length === 1).map((s) => [s]))(
    "%j selects its own mode",
    (subset) => {
      const mode = (subset[0] ?? "").replace("--", "") as CensusMode;
      expect(parseArgs(baseArgv(mode)).mode).toBe(mode);
    },
  );
});

describe("§7.18 — --max-manifest-age-hours is a positive INTEGER, checked on the operand text", () => {
  // The last row is the magnitude case: it PASSES the positive-integer regex, and `Number` of it is
  // 1e20 — past 2^53 the parsed value is no longer the integer the operator typed, so the staleness
  // bound installed would not be the one the runbook sanctioned.
  it.each(["0", "-1", "1.5", "abc", "", "1e3", " 24", "99999999999999999999"])(
    "rejects %j",
    (raw) => {
      const run = runCli([
        "--apply",
        "--manifest",
        join(dir, "m.json"),
        "--max-manifest-age-hours",
        raw,
      ]);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("--max-manifest-age-hours");
      expectNothingOpened(run.stderr);
    },
  );

  // The negative controls that keep the check from degenerating into "reject everything numeric".
  it.each(["1", "24", "9999"])("accepts %j", (raw) => {
    const parsed = parseArgs([
      "--apply",
      "--manifest",
      join(dir, "m.json"),
      "--max-manifest-age-hours",
      raw,
    ]);
    expect(parsed.mode === "apply" ? parsed.maxAgeHours : null).toBe(Number(raw));
  });
});

describe("argv shapes node's parser rejects", () => {
  it("rejects an unknown option", () => {
    const run = runCli(["--manifest", join(dir, "m.json"), "--bogus"]);
    expect(run.code).not.toBe(0);
    expectNothingOpened(run.stderr);
  });

  it("rejects a positional", () => {
    const run = runCli([join(dir, "m.json")]);
    expect(run.code).not.toBe(0);
    expectNothingOpened(run.stderr);
  });
});

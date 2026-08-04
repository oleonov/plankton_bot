import { readFileSync, readdirSync } from "node:fs";

import { OWNERSHIP_INVARIANT_ROW_SQL, type OwnershipInvariantId } from "@krabs/db";
import { expect } from "vitest";

import { decideCensus, type CensusDecisionSet } from "../decide.js";
import { evaluateCensusGates, type CensusGate, type CensusGateReport } from "../gates.js";
import { PRODUCTION_CONTROL_DB_PATH } from "../export-sql.js";
import { generateCensusArtifacts, type CensusArtifacts } from "../generate-sql.js";
import type { LoadedCensusManifest } from "../manifest.js";
import { runCli, type CliRun } from "./cli.js";
import { cleanSeed, createCensusFixture, rewriteManifest, type CensusFixture } from "./fixtures.js";

/**
 * The one way §7 builds a census run: seed a temp ledger → EXPORT a manifest from it → decide → evaluate.
 *
 * The export step is not ceremony. The dry run has no local ledger (§5), so a test that hands the evaluator
 * a directly-constructed database exercises a path production never takes, and any column §5.1 forgets to
 * carry stays invisible — which is exactly how a missing `size` survived an earlier revision of this plan.
 */

export interface CensusRun {
  readonly fixture: CensusFixture;
  readonly loaded: LoadedCensusManifest;
  readonly decision: CensusDecisionSet;
  readonly gates: CensusGateReport;
}

export function runCensus(
  seed: string,
  options: { readonly policy?: string | null } = {},
): CensusRun {
  const fixture = createCensusFixture(
    options.policy === undefined ? {} : { policy: options.policy },
  );
  fixture.seed(seed);
  return reevaluate(fixture);
}

/**
 * Re-export and re-evaluate the SAME fixture — for the tests that mutate the ledger and look again.
 *
 * `mutateSql` carries the export-side negative controls (§9a.6 test 8(b)/(d)): a manifest the CURRENT
 * exporter cannot emit, produced by editing §5.1's text rather than by hand-writing a document, so the
 * control cannot drift from the projection it is a counter-example to.
 */
export function reevaluate(
  fixture: CensusFixture,
  options: { readonly mutateSql?: (sql: string) => string } = {},
): CensusRun {
  const { loaded } = fixture.exportManifest(options);
  const decision = decideCensus(loaded.manifest);
  return { fixture, loaded, decision, gates: evaluateCensusGates(loaded.manifest, decision) };
}

/**
 * The counts, in FULL. Deriving the id list from the production table rather than transcribing it is the
 * strong direction: a seventh invariant is then automatically required to read `0` on every fixture that
 * does not name it, instead of silently escaping the specificity assertion.
 */
export function expectInvariantCounts(
  actual: Readonly<Record<OwnershipInvariantId, number>>,
  expected: Partial<Record<OwnershipInvariantId, number>>,
): void {
  expect(actual).toEqual(
    Object.fromEntries(OWNERSHIP_INVARIANT_ROW_SQL.map(({ id }) => [id, expected[id] ?? 0])),
  );
}

export function gateById(report: CensusGateReport, id: string): CensusGate {
  const gate = report.gates.find((g) => g.id === id);
  if (gate === undefined) throw new Error(`no gate #${id} in the report`);
  return gate;
}

/** `position_id → owner`, the shape every decision assertion in §7 reads. */
export function ownerPlan(decision: CensusDecisionSet): Record<string, string> {
  return Object.fromEntries(decision.decisions.map((d) => [d.positionId, d.owner]));
}

export interface PreparedApply extends CensusRun, CensusArtifacts {
  readonly plannedOwners: Record<string, string>;
}

/**
 * The same run, carried one step further into the three emitted artifacts — what every apply-side test
 * needs. `fixture.controlPath` is passed so the emitted `ATTACH` points at the temp policy; every other
 * byte is the production text.
 */
export function prepareApply(
  seed: string = cleanSeed(),
  options: { readonly policy?: string | null } = {},
): PreparedApply {
  const run = runCensus(seed, options);
  // A throw, not an expectation: a fixture whose policy the decider cannot read emits artifacts no
  // assertion below it can interpret, which is a broken fixture rather than a failing test.
  if (run.decision.policyIssues.length > 0) {
    throw new Error(`fixture policy is undecidable: ${run.decision.policyIssues.join("; ")}`);
  }
  return {
    ...run,
    ...generateCensusArtifacts(run.loaded.manifest, run.decision, run.fixture.controlPath),
    plannedOwners: ownerPlan(run.decision),
  };
}

/** §5.4.1 B's abort primitive, as the CLI reports it — every guard failure surfaces as this text. */
export const CHECK_FAILED = "CHECK constraint failed";

/**
 * The whole-run property (Codex round-5 finding #1): a failed apply must leave NO `exit_owner` changed
 * ANYWHERE in the ledger, not merely the row the test broke. A test that checked only that row passes
 * even when the other targets committed — which is the defect v5 shipped.
 *
 * The map is compared against the state the fixture was in BEFORE the run rather than against "all
 * NULL": some drift classes are seeded AS an owner (a target that acquired a different one before the
 * lock), and an all-NULL assertion cannot express those without exempting the very row under test.
 *
 * `applySql` is a parameter so the guard-inventory tests can assert the same property over a MUTATED
 * script (one inventory row deleted) without a second copy of the assertion.
 */
export function expectRolledBack(
  applied: PreparedApply,
  expectedStderr: string,
  applySql: string = applied.applySql,
): void {
  const before = applied.fixture.ownerMap();
  const run = applied.fixture.runApply(applySql);
  expect(run.ok).toBe(false);
  expect(run.stderr).toContain(expectedStderr);
  expect(applied.fixture.ownerMap()).toEqual(before);
}

// ───────────────────────────── a censused fixture, end to end ─────────────────────────────

/**
 * The three files `--verify-owner-map` takes, all BUILT BY THE REAL PIPELINE — §5.1's exporter for the
 * frozen manifest and `--apply` itself for the decision artifact. Never hand-written: a hand-built trio
 * cannot drift from the loaders it is supposed to pin, because it was never produced by them.
 */
export interface CensusedTrio {
  readonly fixture: CensusFixture;
  readonly frozenPath: string;
  readonly decisionPath: string;
  readonly decisionDigest: string;
}

const captureLine = (stdout: string, re: RegExp): string => {
  const match = re.exec(stdout);
  if (match?.[1] === undefined) throw new Error(`no match for ${re} in:\n${stdout}`);
  return match[1];
};

/**
 * The CLI takes no `--control-db` operand — §5.2's matrix is closed at five — so it ATTACHes the production
 * path unconditionally. The temp ledger needs the fixture's copy instead. The `toContain` is the point: it
 * pins that the emitted script really does target production's `control.db`, and it makes a substitution
 * that silently matched nothing impossible.
 */
export function retargetControlDb(sql: string, fixture: CensusFixture): string {
  expect(sql).toContain(PRODUCTION_CONTROL_DB_PATH);
  return sql.replaceAll(PRODUCTION_CONTROL_DB_PATH, fixture.controlPath);
}

/** One hour, in ms — the offset the backdated apply below runs at. */
const HOUR_MS = 3_600_000;

/**
 * Seed → export frozen → `--apply` → run the emitted script. Leaves the ledger censused.
 *
 * `commit: false` stops after the artifacts are written, which is the real incident §9 check (c) exists to
 * catch: the operator restarted believing the window was applied when the script never committed.
 *
 * `exportedAt` backdates the frozen manifest, which §7 test 8c needs: its `exportedAt` comes from the
 * ledger's own clock at export, so "a frozen manifest that is a week old at VERIFY time" is unreachable by
 * moving a clock alone. The edit lands BEFORE `--apply` — the decision artifact binds to the manifest
 * BYTES, so backdating afterwards would break that binding instead of aging the manifest — and the apply
 * then runs under the clock those bytes were fresh at, which is the real sequence it stands in for: the
 * window was applied while the manifest was current, and is verified long after.
 */
export function censusedFixture(
  seed: string = cleanSeed(),
  options: { readonly commit?: boolean; readonly exportedAt?: string } = {},
): CensusedTrio {
  const fixture = createCensusFixture();
  fixture.seed(seed);
  const frozenPath = fixture.exportManifest().path;

  const exportedAt = options.exportedAt;
  if (exportedAt !== undefined) {
    rewriteManifest(frozenPath, (document) => void (document.exportedAt = exportedAt));
  }

  const argv = ["--apply", "--manifest", frozenPath, "--max-manifest-age-hours", "24"];
  const apply =
    exportedAt === undefined ? runCli(argv) : runCli(argv, Date.parse(exportedAt) + HOUR_MS);
  expect(apply.stderr).toBe("");
  expect(apply.code).toBe(0);

  if (options.commit !== false) {
    const script = retargetControlDb(readFileSync(`${frozenPath}.apply.sql`, "utf8"), fixture);
    const run = fixture.runApply(script);
    expect(run.stderr).toBe("");
    expect(run.ok).toBe(true);
  }

  return {
    fixture,
    frozenPath,
    decisionPath: captureLine(apply.stdout, /^DECISION=(.+)$/m),
    decisionDigest: captureLine(apply.stdout, /^DECISION_SHA256=([0-9a-f]{64})$/m),
  };
}

export interface VerifyOverrides {
  readonly decisionDigest?: string;
  readonly decision?: string;
  readonly maxAgeHours?: number;
  readonly nowMs?: number;
}

/** A `--verify-owner-map` run against a freshly exported manifest, asserting it wrote nothing. */
export function verifyOwnerMapCli(trio: CensusedTrio, overrides: VerifyOverrides = {}): CliRun {
  const freshPath = trio.fixture.exportManifest().path;
  const before = readdirSync(trio.fixture.dir).sort();
  const argv = [
    "--verify-owner-map",
    "--manifest",
    freshPath,
    "--max-manifest-age-hours",
    String(overrides.maxAgeHours ?? 24),
    "--frozen",
    trio.frozenPath,
    "--decision",
    overrides.decision ?? trio.decisionPath,
    "--decision-digest",
    overrides.decisionDigest ?? trio.decisionDigest,
  ];
  const run = overrides.nowMs === undefined ? runCli(argv) : runCli(argv, overrides.nowMs);
  // The verification is READ-ONLY on both sides: it opens no database and writes no file.
  expect(readdirSync(trio.fixture.dir).sort()).toEqual(before);
  return run;
}

// ───────────────────────────── reading the emitted guard inventory ─────────────────────────────

export interface EmittedGuard {
  readonly id: string;
  readonly title: string;
  /** The `SELECT …;` alone — runnable on its own, which is what the probe below does. */
  readonly body: string;
  /** The whole block including its comment line, for removal. */
  readonly text: string;
}

/** Guard #5 expands to six entries, so a row is addressed by id AND (for #5) its invariant's name. */
export interface GuardRef {
  readonly id: string;
  readonly entry?: string;
}

const GUARD_RE = /^-- guard #(\S+) — ([^\n]*)\nINSERT INTO census_guard\(ok\)\n([\s\S]*?;)$/gm;

export function emittedGuards(applySql: string): EmittedGuard[] {
  return [...applySql.matchAll(GUARD_RE)].map((m) => ({
    id: m[1] ?? "",
    title: m[2] ?? "",
    body: m[3] ?? "",
    text: m[0],
  }));
}

function matches(guard: EmittedGuard, ref: GuardRef): boolean {
  return guard.id === ref.id && (ref.entry === undefined || guard.title.includes(ref.entry));
}

export function findGuard(applySql: string, ref: GuardRef): EmittedGuard {
  const found = emittedGuards(applySql).filter((g) => matches(g, ref));
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one guard #${ref.id} ${ref.entry ?? ""}, found ${found.length}`,
    );
  }
  return found[0] as EmittedGuard;
}

/** The emitted script minus the matching guard blocks — the mutation axis's one primitive. */
export function removeGuards(applySql: string, ref: GuardRef): string {
  return emittedGuards(applySql)
    .filter((g) => matches(g, ref))
    .reduce((sql, g) => sql.replace(g.text, ""), applySql);
}

const CAS_MARKER = "-- §5.4 — the compare-and-swap";

/**
 * ONE guard's own value, read without writing anything: the emitted preamble (`ATTACH`,
 * `BEGIN IMMEDIATE`, the temp tables and their inserts) + that guard's `SELECT` + `ROLLBACK`.
 *
 * Guard #8 alone is a POST-update statement, so its probe replays the CAS block first — its subject is
 * the state the writes leave behind, and probing it before them would read a different question.
 */
export function probeGuard(
  applied: PreparedApply,
  ref: GuardRef,
  applySql: string = applied.applySql,
): string {
  const preamble = applySql.slice(0, applySql.indexOf("-- guard #"));
  const cas =
    ref.id === "8"
      ? applySql.slice(applySql.indexOf(CAS_MARKER), applySql.indexOf("-- guard #8"))
      : "";
  const run = applied.fixture.runApply(
    `${preamble}\n${cas}\n${findGuard(applySql, ref).body}\nROLLBACK;\n`,
  );
  if (!run.ok) throw new Error(`probing guard #${ref.id} failed: ${run.stderr}`);
  return run.stdout.trim();
}

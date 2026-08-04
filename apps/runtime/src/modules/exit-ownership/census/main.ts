import { createHash } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";

import { decideCensus, type CensusDecisionSet } from "./decide.js";
import {
  buildDecisionArtifact,
  DecisionArtifactRejection,
  decisionArtifactPath,
  loadDecisionArtifact,
  serializeDecisionArtifact,
} from "./decision-artifact.js";
import { CENSUS_EXPORT_SQL } from "./export-sql.js";
import { evaluateCensusGates, type CensusGateReport } from "./gates.js";
import { generateCensusArtifacts } from "./generate-sql.js";
import { loadManifest, ManifestRejection, type LoadedCensusManifest } from "./manifest.js";
import { renderCensusReport, renderVerifyReport, type CensusArtifactPaths } from "./report.js";
import { verifyOwnerMap } from "./verify-owner-map.js";

/**
 * §5.2 / §7 — `main(argv, io)`, including argv parsing and the dry-run-default / `--apply` authorization
 * boundary. Both live under `src` deliberately: leaving "did the operator actually pass `--apply`?" in an
 * untyped, untested wrapper is the one security-relevant decision this tool has.
 *
 * The CLI is LOCAL and opens no database. `--apply` does not write to the ledger — it emits the SQL the
 * operator runs on the production host under `sqlite3 -bail`, plus the decision artifact §9's check (c)
 * compares against.
 */

const OK = 0;
const FAILURE_EXIT = 1;
const USAGE_EXIT = 2;

const DEFAULT_MAX_AGE_HOURS = 24;

/** §9 defines the operand as a positive INTEGER; the test is on the operand text, since `Number("1.5")`
 * is finite and positive and would silently install a bound the runbook never sanctioned. */
const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;

/** The bare fact, safe to print before anything has been verified. */
const NO_TARGETS_MESSAGE = "no targets in the manifest";

/**
 * The CLAIM, and it is only true once the gates have passed: an empty target set means "nothing left to
 * assign", not "nothing is wrong". Printing it up front told the operator the census was complete and then
 * handed them a failure report on the next line.
 */
const CENSUS_COMPLETE_MESSAGE = "no targets — the census is already complete";

export interface CensusIo {
  stdout(text: string): void;
  stderr(text: string): void;
  nowMs(): number;
}

export const realIo: CensusIo = {
  stdout: (text) => void process.stdout.write(`${text}\n`),
  stderr: (text) => void process.stderr.write(`${text}\n`),
  nowMs: () => Date.now(),
};

export type CensusMode = "dry-run" | "apply" | "verify-owner-map" | "emit-export-sql";

/** The three action flags. Their names are the mode names, so selection is a lookup rather than a mapping. */
const ACTION_FLAGS = ["apply", "verify-owner-map", "emit-export-sql"] as const;

export const CENSUS_OPERANDS = [
  "manifest",
  "max-manifest-age-hours",
  "frozen",
  "decision",
  "decision-digest",
] as const;

export type CensusOperand = (typeof CENSUS_OPERANDS)[number];
export type OperandDisposition = "required" | "optional" | "rejected";

/**
 * §5.2's mode × operand matrix, all 20 cells, and the rule that generates it: **every mode rejects, non-zero
 * and before opening anything, any operand it does not read.** Silent acceptance is the specific failure
 * this forbids — an operator who passes `--frozen` to `--apply` believes they bound the apply to that file,
 * and an ignored flag lets them keep believing it.
 */
export const OPERAND_MATRIX: Record<
  CensusMode,
  Readonly<Record<CensusOperand, OperandDisposition>>
> = {
  "dry-run": {
    manifest: "required",
    "max-manifest-age-hours": "optional",
    frozen: "rejected",
    decision: "rejected",
    "decision-digest": "rejected",
  },
  apply: {
    manifest: "required",
    "max-manifest-age-hours": "required",
    frozen: "rejected",
    decision: "rejected",
    "decision-digest": "rejected",
  },
  "verify-owner-map": {
    manifest: "required",
    "max-manifest-age-hours": "required",
    frozen: "required",
    decision: "required",
    "decision-digest": "required",
  },
  "emit-export-sql": {
    manifest: "rejected",
    "max-manifest-age-hours": "rejected",
    frozen: "rejected",
    decision: "rejected",
    "decision-digest": "rejected",
  },
};

export interface ManifestReadingInvocation {
  readonly mode: "dry-run" | "apply";
  readonly manifest: string;
  readonly maxAgeHours: number;
}

export interface VerifyInvocation {
  readonly mode: "verify-owner-map";
  readonly manifest: string;
  readonly maxAgeHours: number;
  readonly frozen: string;
  readonly decision: string;
  readonly decisionDigest: string;
}

export type CensusInvocation =
  | ManifestReadingInvocation
  | VerifyInvocation
  | { readonly mode: "emit-export-sql" };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function main(argv: readonly string[], io: CensusIo = realIo): number {
  let invocation: CensusInvocation;
  try {
    invocation = parseArgs(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return USAGE_EXIT;
  }

  try {
    if (invocation.mode === "emit-export-sql") {
      io.stdout(CENSUS_EXPORT_SQL);
      return OK;
    }
    if (invocation.mode === "verify-owner-map") return runVerifyOwnerMap(invocation, io);
    if (invocation.mode === "apply") return runApply(invocation, io);
    return runDryRun(invocation, io);
  } catch (error) {
    io.stderr(failureMessage(error));
    return FAILURE_EXIT;
  }
}

export function parseArgs(argv: readonly string[]): CensusInvocation {
  const { values, tokens } = runNodeParser(argv);
  // BEFORE mode dispatch, so on a `rejected` cell a repeated operand is rejected as a repeat — naming both
  // values — rather than as an operand-mode mismatch that names neither. The two have different fixes.
  rejectRepeatedOperands(tokens);
  const mode = selectMode(values);
  applyMatrix(mode, values);

  if (mode === "emit-export-sql") return { mode };
  const manifest = requireOperand(values, "manifest");
  const maxAgeHours = readMaxAgeHours(values["max-manifest-age-hours"]);
  if (mode !== "verify-owner-map") return { mode, manifest, maxAgeHours };
  return {
    mode,
    manifest,
    maxAgeHours,
    frozen: requireOperand(values, "frozen"),
    decision: requireOperand(values, "decision"),
    decisionDigest: requireOperand(values, "decision-digest"),
  };
}

type ParsedValues = Record<string, string | boolean | undefined>;
type ParsedTokens = ReturnType<typeof parseNodeArgs<typeof PARSE_CONFIG>>["tokens"];

const PARSE_CONFIG = {
  options: {
    apply: { type: "boolean" },
    "verify-owner-map": { type: "boolean" },
    "emit-export-sql": { type: "boolean" },
    manifest: { type: "string" },
    "max-manifest-age-hours": { type: "string" },
    frozen: { type: "string" },
    decision: { type: "string" },
    "decision-digest": { type: "string" },
  },
  strict: true,
  allowPositionals: false,
  tokens: true,
} as const;

function runNodeParser(argv: readonly string[]): { values: ParsedValues; tokens: ParsedTokens } {
  try {
    const parsed = parseNodeArgs({ ...PARSE_CONFIG, args: [...argv] });
    return { values: parsed.values as ParsedValues, tokens: parsed.tokens };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * §5.2 — every scalar operand may appear at most once, in every mode. Node's `parseArgs` keeps the LAST
 * occurrence and reports nothing, so `--manifest fresh.json --manifest stale.json` runs against the file
 * the operator believes they replaced. Precedence was considered and rejected: a one-way write must not
 * proceed under a resolved ambiguity when refusing costs one retyped command.
 *
 * Repeated MODE flags are deliberately NOT covered — a boolean's two occurrences cannot disagree, and a
 * DIFFERENT second mode flag is mode exclusivity, a separate class with a separate diagnostic.
 */
function rejectRepeatedOperands(tokens: ParsedTokens): void {
  for (const operand of CENSUS_OPERANDS) {
    const supplied = tokens.flatMap((token) =>
      token.kind === "option" && token.name === operand ? [token.value ?? ""] : [],
    );
    if (supplied.length < 2) continue;
    throw new UsageError(
      `--${operand} was supplied ${supplied.length} times ` +
        `(${supplied.map((value) => JSON.stringify(value)).join(", ")}) — ` +
        "every operand may appear at most once; drop the one you did not mean",
    );
  }
}

function selectMode(values: ParsedValues): CensusMode {
  const present = ACTION_FLAGS.filter((flag) => values[flag] === true);
  if (present.length > 1) {
    throw new UsageError(
      `the action modes are mutually exclusive, but this argv carries ` +
        `${present.map((flag) => `--${flag}`).join(" ")} — pass exactly one, or none for the dry run`,
    );
  }
  return present[0] ?? "dry-run";
}

function applyMatrix(mode: CensusMode, values: ParsedValues): void {
  const row = OPERAND_MATRIX[mode];
  for (const operand of CENSUS_OPERANDS) {
    const supplied = values[operand] !== undefined;
    if (row[operand] === "rejected" && supplied) {
      throw new UsageError(
        `--${operand} is not read in ${modeLabel(mode)} mode — drop the flag or change the mode`,
      );
    }
    if (row[operand] === "required" && !supplied) {
      throw new UsageError(`--${operand} is required in ${modeLabel(mode)} mode`);
    }
  }
}

function modeLabel(mode: CensusMode): string {
  return mode === "dry-run" ? "dry-run (the default)" : `--${mode}`;
}

function requireOperand(values: ParsedValues, operand: CensusOperand): string {
  const value = values[operand];
  // `applyMatrix` has already rejected an absent required operand; this is the type narrowing, not a check.
  if (typeof value !== "string") throw new UsageError(`--${operand} must carry a value`);
  return value;
}

function readMaxAgeHours(raw: string | boolean | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_AGE_HOURS;
  if (typeof raw !== "string" || !POSITIVE_INTEGER_RE.test(raw)) {
    throw new UsageError(
      `--max-manifest-age-hours must be a positive integer number of hours, got ${JSON.stringify(raw)}`,
    );
  }
  const hours = Number(raw);
  // The regex bounds the SHAPE, not the magnitude. "99999999999999999999" is a positive integer string
  // whose `Number` is 1e20 — past 2^53 the value is no longer the integer the operator typed, so the
  // staleness bound installed is not the one the runbook sanctioned. Same reasoning as the regex itself.
  if (!Number.isSafeInteger(hours)) {
    throw new UsageError(
      `--max-manifest-age-hours is too large to represent exactly, got ${JSON.stringify(raw)}`,
    );
  }
  return hours;
}

function runDryRun(invocation: ManifestReadingInvocation, io: CensusIo): number {
  const loaded = loadTargetManifest(invocation, io);
  // Not an error: the dry run's job is to report the state, and "nothing to do" is a valid answer. Making
  // it non-zero would break the one command the operator runs repeatedly while deciding whether to open
  // the window at all.
  if (loaded.manifest.targets.length === 0) return gateZeroTargets(loaded, io);
  return emitPlan(loaded, invocation.manifest, io, null);
}

/**
 * A zero-target manifest still carries the ledger's own I1–I5 rows (§5.1.11), and §9's post-apply re-checks
 * are exactly this invocation — after a completed census EVERY later dry run takes this branch. Returning
 * OK before the gates ran made EXIT=0 mean "the gate was never reached", not "nothing is violated": a check
 * that cannot fail is not a check. The verdict is therefore printed, not merely implied by the exit code.
 *
 * Still no artifact either way — an apply script over an empty target set would document nothing.
 */
function gateZeroTargets(loaded: LoadedCensusManifest, io: CensusIo): number {
  const decision = decideCensus(loaded.manifest);
  const gates = evaluateCensusGates(loaded.manifest, decision);
  io.stdout(NO_TARGETS_MESSAGE);
  if (gates.blocked) {
    // Not "the ledger is NOT clean": `parser`/`policy-row`/`policy-blank` read the policy out of
    // `control.db`, so a blocked run here does not necessarily accuse the ledger of anything.
    return reportBlocked(
      loaded,
      decision,
      gates,
      io,
      "the zero-target manifest did not pass all blocking gates",
    );
  }
  const blocking = gates.gates.filter((g) => g.blocking).length;
  io.stdout(`${CENSUS_COMPLETE_MESSAGE} (gates clean: ${blocking} blocking gate(s) evaluated)`);
  return OK;
}

function reportBlocked(
  loaded: LoadedCensusManifest,
  decision: CensusDecisionSet,
  gates: CensusGateReport,
  io: CensusIo,
  reason: string,
): number {
  // The report still renders in full and names the offending rows; what a blocked run must NOT do is hand
  // the operator a runnable script, so nothing is written and no statement list is printed.
  io.stdout(renderCensusReport({ loaded, decision, gates, artifacts: null }));
  io.stderr(`a blocking gate failed — ${reason}`);
  return FAILURE_EXIT;
}

function runApply(invocation: ManifestReadingInvocation, io: CensusIo): number {
  const loaded = loadTargetManifest(invocation, io);
  // `cen-apply-zero-targets` — before any artifact is written. There is nothing to apply, so mutating
  // nothing and producing a decision that documents nothing is the strictly worse outcome.
  if (loaded.manifest.targets.length === 0) {
    io.stderr(`--apply refuses an empty target set: ${NO_TARGETS_MESSAGE}`);
    return FAILURE_EXIT;
  }
  return emitPlan(loaded, invocation.manifest, io, writeDecisionArtifact);
}

function loadTargetManifest(
  invocation: ManifestReadingInvocation,
  io: CensusIo,
): LoadedCensusManifest {
  return loadManifest(invocation.manifest, {
    maxAgeHours: invocation.maxAgeHours,
    nowMs: io.nowMs(),
  });
}

/** Runs after the gates pass and BEFORE the apply script is emitted; returns the report's trailing lines. */
type PostPlanHook = (
  loaded: LoadedCensusManifest,
  manifestPath: string,
  decision: CensusDecisionSet,
) => string[];

/**
 * The shared body of the dry run and `--apply`: decide, gate, emit all three artifacts, render the report.
 * The two modes differ in exactly two places — the zero-target disposition above, and this hook.
 */
function emitPlan(
  loaded: LoadedCensusManifest,
  manifestPath: string,
  io: CensusIo,
  hook: PostPlanHook | null,
): number {
  const decision = decideCensus(loaded.manifest);
  const gates = evaluateCensusGates(loaded.manifest, decision);
  if (gates.blocked) {
    return reportBlocked(
      loaded,
      decision,
      gates,
      io,
      "no artifact was written and --apply must not be run",
    );
  }

  const trailer = hook?.(loaded, manifestPath, decision) ?? [];
  const artifacts = generateCensusArtifacts(loaded.manifest, decision);
  const paths = artifactPaths(manifestPath);
  // All three, or none — one call, because §9's step 7 runs the post-verify AFTER the immutable COMMIT.
  writeArtifacts([
    { path: paths.applySql, content: artifacts.applySql },
    { path: paths.postverifySql, content: artifacts.postverifySql },
    { path: paths.postverifyDetailSql, content: artifacts.postverifyDetailSql },
  ]);

  io.stdout(
    renderCensusReport({
      loaded,
      decision,
      gates,
      artifacts: { paths, statementList: artifacts.applySql },
    }),
  );
  for (const line of trailer) io.stdout(line);
  return OK;
}

/**
 * §9 — the decision artifact is written BEFORE the apply script, so a run that cannot persist its decision
 * aborts with nothing emitted. The digest is computed from the bytes re-read from disk, not from the
 * in-memory object: that is what makes it a statement about the file `--verify-owner-map` will open.
 */
const writeDecisionArtifact: PostPlanHook = (loaded, manifestPath, decision) => {
  const path = decisionArtifactPath(manifestPath, loaded.bytesSha256);
  // The name derives from the manifest's OWN digest, so a manifest already carrying it aliases its own
  // output: publishing would displace the manifest, write the decision over it, and delete the backup on
  // success — destroying the frozen input `--verify-owner-map --frozen` needs and only prod can re-export.
  if (resolve(path) === resolve(manifestPath)) {
    throw new Error(
      `refusing to write the decision artifact: ${path} IS the manifest passed as --manifest — rename ` +
        `the manifest so it does not collide with its own decision artifact, then re-run`,
    );
  }
  const artifact = buildDecisionArtifact(loaded.bytesSha256, decision.decisions);
  writeArtifact(path, serializeDecisionArtifact(artifact));
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  return [`DECISION=${path}`, `DECISION_SHA256=${digest}`];
};

/** §5.2's output contract — derived from `--manifest`, never a fixed name, so no run overwrites another's. */
function artifactPaths(manifestPath: string): CensusArtifactPaths {
  return {
    applySql: `${manifestPath}.apply.sql`,
    postverifySql: `${manifestPath}.postverify.sql`,
    postverifyDetailSql: `${manifestPath}.postverify-detail.sql`,
  };
}

interface CensusArtifactWrite {
  path: string;
  content: string;
}

/**
 * The operator never chooses the output directory — it derives from `--manifest` — so a read-only or absent
 * one is reachable with no mistake on their part. Fail closed naming the full path and the errno, and leave
 * no partial file: `<path>.tmp` then `rename`, so a named file is either absent or complete. The remedy is
 * to copy the manifest somewhere writable and re-run, safe because §5.1 content-addresses the manifest.
 *
 * ALL of them, or none — §5.2's output contract, v23 review Major 4. A per-file `.tmp`+`rename` makes every
 * FILE atomic but leaves the SET partial: the apply script lands, the second write hits `ENOSPC`/`EACCES`,
 * and the operator holds a runnable script with no post-verify — discovered at §9's step 7, the one step
 * that runs after the immutable `COMMIT`. So all writes are staged first and only then renamed: every
 * environment failure (unwritable directory, full disk, quota) lands in the staging pass with nothing named
 * yet. The rename pass is the residual window, narrow precisely because staging just proved the directory
 * writable; a failure there unwinds the renames already made, so the caller never returns holding a set.
 *
 * Unwinding a rename means putting BACK what it replaced, not just deleting what it wrote. The three paths
 * derive from `--manifest`, so the `--apply` rerun after a dry run targets the same three names: every
 * destination already exists, `renameSync` silently replaces it, and deleting the replacement would leave a
 * set mixing two runs' files — the partial group staging exists to prevent. So each displaced original is
 * moved aside first (a rename, not a copy: atomic, and free on a 3-file set) and moved back if the pass fails.
 */
function writeArtifacts(entries: readonly CensusArtifactWrite[]): void {
  const tmps = entries.map(({ path }) => `${path}.tmp`);
  refuseOnStaleBackup(entries);
  const displaced: Array<{ path: string; backup: string }> = [];
  const renamed: string[] = [];
  try {
    entries.forEach(({ path, content }, index) =>
      attemptArtifactWrite(path, () => writeFileSync(tmps[index]!, content)),
    );
    entries.forEach(({ path }, index) =>
      attemptArtifactWrite(path, () => {
        // Only a REGULAR file is displaced. Anything else at a final path is not a prior artifact worth
        // preserving — a directory there is an environment fault, and letting the rename fail on it is the
        // diagnosis the operator needs, not a silently relocated directory.
        if (statSync(path, { throwIfNoEntry: false })?.isFile()) {
          const backup = `${path}.bak`;
          renameSync(path, backup);
          displaced.push({ path, backup });
        }
        renameSync(tmps[index]!, path);
        renamed.push(path);
      }),
    );
  } catch (error) {
    const issues = rollbackArtifacts(tmps, renamed, displaced);
    if (issues.length === 0) throw error;
    // A silent half-rollback is worse than the failure itself: the operator reads "cannot write X", fixes
    // X, and never learns a DIFFERENT path was left inconsistent. So the damage is appended, verbatim.
    throw new Error(
      `${errorText(error)} — AND the rollback left the set inconsistent: ${issues.join("; ")}`,
    );
  }
  // The set is published; the originals it replaced are now just clutter next to it.
  for (const { backup } of displaced) bestEffortRemove(backup);
}

/**
 * `${path}.bak` exists only BETWEEN this function's two passes, so finding one on entry means an earlier run
 * died mid-publish — leaving the three finals mixing two generations, the state §5.2 forbids. Refusing is
 * the only honest move: displacing the survivor would overwrite that backup and the success path would then
 * delete it, destroying the sole copy needed to reconstruct the set. It equally protects a `.bak` an
 * operator wrote by hand — a name this code invented, not one it owns.
 *
 * The test is on the directory ENTRY, not on what it resolves to: `existsSync` follows symlinks, so a
 * dangling one would pass and then be silently replaced by the displacement — the one `.bak` it would lose.
 */
function refuseOnStaleBackup(entries: readonly CensusArtifactWrite[]): void {
  const stale = entries
    .map(({ path }) => `${path}.bak`)
    .filter((backup) => lstatSync(backup, { throwIfNoEntry: false }) !== undefined);
  if (stale.length === 0) return;
  throw new Error(
    `refusing to publish: ${stale.join(", ")} left behind by an interrupted run — the artifacts beside ` +
      `it may mix two generations; inspect and remove the backup, then re-run`,
  );
}

/** @returns one entry per path the unwind could NOT leave as it found it, each naming its own remedy. */
function rollbackArtifacts(
  tmps: readonly string[],
  renamed: readonly string[],
  displaced: ReadonlyArray<{ path: string; backup: string }>,
): string[] {
  // Restore FIRST, straight over this run's file: `renameSync` replaces the destination, so the original
  // returns in ONE step. Delete-then-rename would open an instant holding neither generation, and a fault
  // inside it empties a path that was previously fine.
  const issues: string[] = [];
  for (const { path, backup } of displaced) {
    try {
      renameSync(backup, path);
    } catch {
      // Whether the path is empty or holds this run's file depends on where the failure hit, so claiming
      // either would be a guess. Only the backup's location is true in both — and repairs both.
      issues.push(`${path} is absent or holds THIS run's file — recover it from ${backup}`);
    }
  }
  // Every displaced path is now either restored or reported, and its backup is the last readable copy —
  // so neither is removed here. Cleanup is confined to the paths this run brought into existence itself.
  const wasDisplaced = new Set(displaced.map(({ path }) => path));
  // A leftover `.tmp` is debris no one can mistake for the set, so it stays silent. A published final that
  // replaced NOTHING is the opposite: left behind, it is a runnable fragment of a set that was never
  // completed — the very partial group §5.2 forbids — so a cleanup that fails HERE has to be reported.
  for (const path of tmps) bestEffortRemove(path);
  for (const path of renamed) {
    if (wasDisplaced.has(path) || bestEffortRemove(path)) continue;
    issues.push(`${path} holds THIS run's file and replaced nothing — delete it`);
  }
  return issues;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @returns whether the path is gone — never throws, so a failing cleanup cannot REPLACE the diagnosis. */
function bestEffortRemove(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** The single message an unwritable output directory produces: the full path it tried, the errno, the remedy. */
function attemptArtifactWrite(path: string, write: () => void): void {
  try {
    write();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(
      `cannot write ${path} (${code}) — copy the manifest to a writable directory and re-run`,
    );
  }
}

function writeArtifact(path: string, content: string): void {
  writeArtifacts([{ path, content }]);
}

function runVerifyOwnerMap(invocation: VerifyInvocation, io: CensusIo): number {
  const nowMs = io.nowMs();
  // `--frozen` is EXEMPT from the staleness bound (§9, v14 Major 3): the frozen manifest's whole purpose is
  // to be old, it holds the ONLY copy of the expected id set, and re-exporting cannot rebuild it. Applied
  // here, the bound would turn from a safety check into a permanent block on the verification that gates
  // the resume. The FRESH manifest — the one making claims about current ledger state — keeps the bound.
  const frozen = loadManifest(invocation.frozen, { maxAgeHours: null, nowMs });
  const decision = loadDecisionArtifact(invocation.decision, {
    expectedBytesSha256: invocation.decisionDigest,
    expectedManifestDigest: frozen.bytesSha256,
  });
  const fresh = loadManifest(invocation.manifest, { maxAgeHours: invocation.maxAgeHours, nowMs });

  const report = verifyOwnerMap({
    frozen: frozen.manifest,
    fresh: fresh.manifest,
    decision: decision.artifact,
  });
  io.stdout(renderVerifyReport(report));
  return report.ok ? OK : FAILURE_EXIT;
}

function failureMessage(error: unknown): string {
  if (error instanceof ManifestRejection) {
    return `census manifest rejected (${error.kind}): ${error.message}`;
  }
  if (error instanceof DecisionArtifactRejection) {
    return `decision artifact rejected (${error.kind}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

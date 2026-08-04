import type { CensusDecisionSet } from "./decide.js";
import type { CensusGateReport } from "./gates.js";
import type { LoadedCensusManifest } from "./manifest.js";
import type { VerifyOwnerMapReport } from "./verify-owner-map.js";

/**
 * §5.2 — the four things a census run must emit: (a) a per-row plan with the reason for every verdict,
 * (b) the counts summary, (c) the blocking-gate report, (d) the generated statement list.
 *
 * It is a "blocking-gate report", never a "skip report": §2.3 removed per-row skip semantics from this
 * plan, and nothing in the census skips a row — a gate either passes or blocks the whole run.
 *
 * Rendering is separated from `main.ts` so the report is a pure function of the run's three artifacts and
 * can be asserted on directly, without an argv or a filesystem.
 */

export interface CensusArtifactPaths {
  readonly applySql: string;
  readonly postverifySql: string;
  readonly postverifyDetailSql: string;
}

export interface CensusReportInput {
  readonly loaded: LoadedCensusManifest;
  readonly decision: CensusDecisionSet;
  readonly gates: CensusGateReport;
  /**
   * `null` when a blocking gate failed. The report still renders in full — provenance, per-row plan, counts
   * and every gate with its offending rows — but a blocked run must not hand the operator a runnable
   * script, so neither the paths nor the statement list appear.
   */
  readonly artifacts: {
    readonly paths: CensusArtifactPaths;
    readonly statementList: string;
  } | null;
}

export function renderCensusReport(input: CensusReportInput): string {
  const sections = [
    renderProvenance(input.loaded, input.gates),
    renderPlan(input.decision),
    renderCounts(input.decision),
    renderGates(input.gates),
  ];
  if (input.artifacts !== null) {
    sections.push(renderArtifacts(input.artifacts.paths, input.artifacts.statementList));
  }
  return sections.map((lines) => lines.join("\n")).join("\n\n");
}

function renderProvenance(loaded: LoadedCensusManifest, gates: CensusGateReport): string[] {
  return [
    "=== census manifest ===",
    `path                 ${loaded.path}`,
    `exportedAt           ${loaded.manifest.exportedAt}`,
    `bytes sha256         ${loaded.bytesSha256}`,
    `canonical payload    ${loaded.canonicalPayloadSha256}`,
    `targets (N)          ${gates.targetCount}`,
    `target set digest    ${gates.targetSetDigest}`,
  ];
}

function renderPlan(decision: CensusDecisionSet): string[] {
  const rows = decision.decisions.map(
    (d) =>
      `  ${d.positionId}  ${d.owner.padEnd(7)}  token=${d.tokenId}  ` +
      `condition=${d.marketConditionId ?? "<absent>"}  — ${d.reason}`,
  );
  return ["=== per-row plan ===", ...rows];
}

function renderCounts(decision: CensusDecisionSet): string[] {
  const { bounce, profile } = decision.counts;
  return [
    "=== counts ===",
    `  bounce ${bounce}`,
    `  profile ${profile}`,
    `  total ${bounce + profile}`,
  ];
}

function renderGates(report: CensusGateReport): string[] {
  const lines = ["=== blocking-gate report ==="];
  for (const gate of report.gates) {
    const verdict = !gate.blocking ? "info " : gate.passed ? "PASS " : "BLOCK";
    lines.push(`  [${verdict}] #${gate.id} ${gate.title}`);
    if (gate.note !== undefined) lines.push(`           ${gate.note}`);
    for (const row of gate.offending) lines.push(`           ${JSON.stringify(row)}`);
  }
  lines.push(report.blocked ? "  => BLOCKED: --apply is refused" : "  => all blocking gates pass");
  return lines;
}

function renderArtifacts(paths: CensusArtifactPaths, statementList: string): string[] {
  return [
    "=== artifacts ===",
    `  apply             ${paths.applySql}`,
    `  postverify        ${paths.postverifySql}`,
    `  postverify detail ${paths.postverifyDetailSql}`,
    "",
    "=== statement list ===",
    statementList,
  ];
}

/**
 * §9 check (c). Every offending `positionId` is named with expected vs actual in ONE pass — the operator is
 * mid-window with immutable owners already written, so a report that stopped at the first failure would
 * cost a re-run per row.
 */
export function renderVerifyReport(report: VerifyOwnerMapReport): string {
  if (report.ok) {
    return `owner map verified: all ${report.targetCount} censused position(s) hold their expected owner`;
  }
  const lines = [`owner map verification FAILED (${report.failures.length} finding(s)):`];
  for (const failure of report.failures)
    lines.push(`  [clause ${failure.clause}] ${failure.message}`);
  return lines.join("\n");
}

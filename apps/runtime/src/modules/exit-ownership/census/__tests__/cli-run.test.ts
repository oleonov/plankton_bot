import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { decideCensus } from "../decide.js";
import { serializeDecisionArtifact } from "../decision-artifact.js";
import { CENSUS_EXPORT_SQL, PRODUCTION_CONTROL_DB_PATH } from "../export-sql.js";
import { type CensusArtifacts, generateCensusArtifacts } from "../generate-sql.js";
import { ENVELOPE_FIELDS, loadManifest } from "../manifest.js";
import { sqlString } from "../sql-literal.js";
import { runCli } from "./cli.js";
import { cleanSeed, createCensusFixture, writeSidecar } from "./fixtures.js";
import { WRONG_OWNER_SELL } from "./invariant-fixtures.js";

/**
 * §7 tests 15, 19 and 21 — what a run actually emits: the three-file output contract, the zero-target
 * dispositions, `--emit-export-sql`, and the two ways a run refuses (a stale manifest, a blocking gate).
 *
 * Every manifest is produced by §5.1's exporter against a temp ledger, so the paths under test are the ones
 * an operator would really pass.
 */

const HOUR_MS = 3_600_000;

function censusFixture(seed: string = cleanSeed(), options: { policy?: string | null } = {}) {
  const fixture = createCensusFixture(
    options.policy === undefined ? {} : { policy: options.policy },
  );
  fixture.seed(seed);
  return fixture;
}

const listing = (dir: string): string[] => readdirSync(dir).sort();

/** A `'literal'` or a bare `NULL` — the only two shapes `sql-literal.ts` ever interpolates. */
const SQL_LITERAL_RE = /'(?:[^']|'')*'|NULL/g;

/**
 * The `(position_id, owner)` pairs a file's `manifest_targets` seed declares, as a sorted set of literal
 * text. Parsed rather than string-compared, per §7.19 (ii): the apply script seeds TEN columns and both
 * post-verify files seed TWO, so the first column against the last is the only comparison that survives
 * the difference in the statements around the rows.
 */
function manifestTargetPairs(sql: string): string[] {
  const inserts = sql.match(/INSERT INTO manifest_targets\b[\s\S]*?;/g) ?? [];
  expect(inserts).toHaveLength(1);
  const values = (inserts[0] ?? "").split("\nVALUES\n")[1] ?? "";
  expect(values).not.toBe("");

  const pairs: string[] = [];
  for (const row of values.split("\n")) {
    const cells = row.match(SQL_LITERAL_RE);
    if (cells === null) continue;
    const [positionId] = cells;
    const owner = cells[cells.length - 1];
    if (positionId === undefined || owner === undefined) throw new Error(`unparsed row: ${row}`);
    pairs.push(`${positionId}|${owner}`);
  }
  return pairs.sort();
}

/**
 * §5.5's three failure modes, in the counting query's column order. The `klass` literal is what the detail
 * file prints and the predicate is what both files count: pinning the PAIR is what makes it impossible for
 * a `2|0|1` line and the rows printed below it to disagree about which mode fired.
 */
const FAILURE_MODES = [
  { klass: "'unowned'", predicate: "exit_owner IS NULL AND status <> 'closed'" },
  { klass: "'wrong-owner'", predicate: "p.exit_owner IS NOT t.owner" },
  {
    klass: "'vanished'",
    predicate: "NOT EXISTS (SELECT 1 FROM positions p WHERE p.position_id = t.position_id)",
  },
] as const;

/** §7.19 (iv) — every write keyword. Both files are opened `-readonly` on the live 31.9 GB ledger. */
const FORBIDDEN_IN_POSTVERIFY = [
  /\bBEGIN\b/i,
  /\bCOMMIT\b/i,
  /\bROLLBACK\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bALTER\b/i,
  /\bATTACH\b/i,
  /\bREPLACE\b/i,
  /\bVACUUM\b/i,
  /INSERT INTO positions\b/i,
];

/** The two files §9's step 7 opens `-readonly`, labelled so a failure names which one broke. */
const postverifyFiles = (a: CensusArtifacts): readonly (readonly [string, string])[] => [
  ["postverify.sql", a.postverifySql],
  ["postverify-detail.sql", a.postverifyDetailSql],
];

/** The three artifacts of one dry run over a fresh fixture, plus the decision they all encode. */
function artifactsOf(fixture: ReturnType<typeof censusFixture>) {
  const manifest = fixture.exportManifest().loaded.manifest;
  const decision = decideCensus(manifest);
  return { decision, artifacts: generateCensusArtifacts(manifest, decision) };
}

describe("§7.19 — the three-file output contract", () => {
  it("writes all three artifacts NEXT TO --manifest, at whatever path the operator chose", () => {
    const fixture = censusFixture();
    const exported = fixture.exportManifest();

    // A nested, non-default directory with a basename no code could have guessed: a fixed output name would
    // make two concurrent runs overwrite each other, and a CWD-relative one would land wherever the operator
    // happened to stand.
    const nested = join(fixture.dir, "operator-chosen");
    mkdirSync(nested);
    const manifestPath = join(nested, "window-2026-07-29.json");
    copyFileSync(exported.path, manifestPath);
    writeSidecar(manifestPath);

    const run = runCli(["--manifest", manifestPath]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);

    expect(listing(nested)).toEqual([
      "window-2026-07-29.json",
      "window-2026-07-29.json.apply.sql",
      "window-2026-07-29.json.postverify-detail.sql",
      "window-2026-07-29.json.postverify.sql",
      "window-2026-07-29.json.sha256",
    ]);

    // The bytes are the generator's, unmodified — and they carry PRODUCTION's control.db, since the CLI is
    // local and the script it emits is meant to run on the host.
    const expected = generateCensusArtifacts(
      exported.loaded.manifest,
      decideCensus(exported.loaded.manifest),
    );
    expect(readFileSync(`${manifestPath}.apply.sql`, "utf8")).toBe(expected.applySql);
    expect(readFileSync(`${manifestPath}.postverify.sql`, "utf8")).toBe(expected.postverifySql);
    expect(readFileSync(`${manifestPath}.postverify-detail.sql`, "utf8")).toBe(
      expected.postverifyDetailSql,
    );
    expect(expected.applySql).toContain(PRODUCTION_CONTROL_DB_PATH);

    // And the report names each of them, so the operator never has to guess where they landed.
    for (const suffix of [".apply.sql", ".postverify.sql", ".postverify-detail.sql"]) {
      expect(run.stdout).toContain(`${manifestPath}${suffix}`);
    }
    expect(run.stdout).toContain("=== statement list ===");
  });

  /**
   * "All three, or none" (v23 review Major 4) — asserted where it actually breaks, in the MIDDLE of the set.
   * The cases below plant a directory at a path the writer needs, failing ONE chosen write deterministically
   * through the real filesystem; a read-only output directory would fail the FIRST write and prove nothing
   * about the set. Only the unwind cases stub `node:fs`, because the operations they break have no on-disk
   * state that can be arranged in advance. The stakes: §9's step 7 runs the post-verify AFTER the immutable
   * `COMMIT`, so an operator holding `apply.sql` with no `postverify.sql` finds the gap once nothing can
   * still be aborted.
   */
  const artifactSuffixes = [".apply.sql", ".postverify.sql", ".postverify-detail.sql"] as const;

  it("stages every artifact before naming any: a mid-set STAGING failure leaves none", () => {
    const fixture = censusFixture();
    const manifestPath = fixture.exportManifest().path;
    // The second artifact's staging path — so the first stages fine and this one fails with EISDIR.
    mkdirSync(`${manifestPath}.postverify.sql.tmp`);

    const run = runCli(["--manifest", manifestPath]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`${manifestPath}.postverify.sql`);
    expect(run.stderr).toContain("copy the manifest to a writable directory");

    for (const suffix of artifactSuffixes)
      expect(existsSync(`${manifestPath}${suffix}`)).toBe(false);
    // The staging file of the artifact that DID succeed is gone too — no debris survives the failure.
    expect(existsSync(`${manifestPath}.apply.sql.tmp`)).toBe(false);
  });

  it("unwinds the names it already claimed: a LAST-artifact RENAME failure leaves none", () => {
    const fixture = censusFixture();
    const manifestPath = fixture.exportManifest().path;
    // A directory at the THIRD artifact's FINAL path: all three stage cleanly, the first two renames
    // land, and the last fails — the ordering with the most for the writer to unwind.
    mkdirSync(`${manifestPath}.postverify-detail.sql`);

    const run = runCli(["--manifest", manifestPath]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`${manifestPath}.postverify-detail.sql`);

    // Both scripts were momentarily in place and are gone again: the operator is never handed a runnable
    // apply script whose post-verify does not exist.
    expect(existsSync(`${manifestPath}.apply.sql`)).toBe(false);
    expect(existsSync(`${manifestPath}.postverify.sql`)).toBe(false);
    for (const suffix of artifactSuffixes) {
      expect(existsSync(`${manifestPath}${suffix}.tmp`)).toBe(false);
    }
  });

  /**
   * The rerun case the two above cannot reach: on a SECOND run every final path already holds the first
   * run's file, so "unwind the renames" must put those files BACK, not merely delete what this run wrote.
   * Deleting alone would hand the operator an empty directory where three valid artifacts stood — the same
   * §9-step-7 gap as a partial set, arrived at from the other side.
   */
  /** Plants a distinct marker at every final path, and returns what an unwind therefore has to put back. */
  const plantPriorRun = (manifestPath: string) =>
    artifactSuffixes.map((suffix) => {
      const entry = { path: `${manifestPath}${suffix}`, bytes: `-- prior run ${suffix}\n` };
      writeFileSync(entry.path, entry.bytes);
      return entry;
    });

  it("a failed rerun leaves the PREVIOUS run's artifacts byte-for-byte intact", () => {
    const fixture = censusFixture();
    const manifestPath = fixture.exportManifest().path;
    expect(runCli(["--manifest", manifestPath]).code).toBe(0);

    // Marker bytes: a rollback that deleted and re-generated instead of restoring would put the generator's
    // SQL back, which these do not match. The third is dropped — a directory takes that path over below.
    const prior = plantPriorRun(manifestPath).slice(0, 2);

    // A directory at the THIRD artifact's FINAL path breaks its rename after the first two are already
    // displaced AND renamed — the ordering with the most to restore. It has to be the final path rather
    // than the `.bak`: a leftover `.bak` is now refused up front, so it could never reach the rename pass.
    const blocked = `${manifestPath}.postverify-detail.sql`;
    rmSync(blocked);
    mkdirSync(blocked);

    const run = runCli(["--manifest", manifestPath]);
    expect(run.code).not.toBe(0);

    for (const { path, bytes } of prior) expect(readFileSync(path, "utf8")).toBe(bytes);
    // And no debris: neither this run's staging files nor the sidecars it moved the originals into.
    for (const suffix of artifactSuffixes) {
      expect(existsSync(`${manifestPath}${suffix}.tmp`)).toBe(false);
      expect(existsSync(`${manifestPath}${suffix}.bak`)).toBe(false);
    }
  });

  /**
   * A `${path}.bak` is normally invisible — it exists only between the writer's two passes. One found on
   * entry means an earlier run was killed mid-publish, and it holds the ONLY copy of what that run
   * displaced: publishing over it would consume that copy and leave a set silently mixing two generations.
   */
  const staleBackupCases = [
    { suffix: ".apply.sql", plant: (p: string) => writeFileSync(p, "-- displaced\n") },
    { suffix: ".postverify.sql", plant: (p: string) => writeFileSync(p, "-- and this\n") },
    // A dangling symlink is an ENTRY with no target, so `existsSync` reports false for it: a check on what
    // the name RESOLVES to sails past and the displacement then replaces the very `.bak` this refusal
    // promises to keep. On the LAST suffix, so the sweep is also proved not to be first-entry-only.
    { suffix: ".postverify-detail.sql", plant: (p: string) => symlinkSync("./gone", p) },
  ] as const;

  it.each(staleBackupCases)("refuses when a killed run left $suffix.bak, touching nothing", (c) => {
    const fixture = censusFixture();
    const manifestPath = fixture.exportManifest().path;
    expect(runCli(["--manifest", manifestPath]).code).toBe(0);

    const before = artifactSuffixes.map((s) => ({
      path: `${manifestPath}${s}`,
      bytes: readFileSync(`${manifestPath}${s}`, "utf8"),
    }));
    const orphan = `${manifestPath}${c.suffix}.bak`;
    c.plant(orphan);

    const run = runCli(["--manifest", manifestPath]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(orphan);

    // `lstat`, not `stat`: the third case has no target, and it is the ENTRY that had to survive.
    expect(lstatSync(orphan, { throwIfNoEntry: false })).toBeDefined();
    for (const { path, bytes } of before) expect(readFileSync(path, "utf8")).toBe(bytes);
    // Refused BEFORE the staging pass, so not even a `.tmp` was brought into existence.
    for (const s of artifactSuffixes) expect(existsSync(`${manifestPath}${s}.tmp`)).toBe(false);
  });

  /**
   * Faults `node:fs` for ONE run and returns its stderr. The unwind's own failure is reachable only because
   * `main()` runs in-process: no on-disk state makes a `rename` BACK or an `rm` fail, and a spawned CLI
   * could not be mocked. The fault sees the real module, so a case can delegate everything it does not break.
   */
  type FsFault = (actual: typeof import("node:fs")) => Record<string, unknown>;
  async function runWithFsFault(manifestPath: string, fault: FsFault): Promise<string> {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...actual, ...fault(actual) };
    });
    const err: string[] = [];
    try {
      const { main } = await import("../main.js");
      const io = { stdout: () => {}, stderr: (t: string) => void err.push(t), nowMs: Date.now };
      expect(main(["--manifest", manifestPath], io)).not.toBe(0);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
    return err.join("\n");
  }
  const EIO = () => Object.assign(new Error("EIO"), { code: "EIO" });

  /**
   * The one outcome worse than a failed publish: a rollback that ALSO fails, silently — the operator reads
   * "cannot write the third artifact", fixes it, and never learns the others were left holding this run's
   * files. Every `.bak` restore is faulted, so all three priors survive only in their sidecars; the third
   * final, whose tmp→final rename is faulted too, holds NOTHING. One message must cover both states.
   */
  it("names the paths a failed rollback could not put back, and keeps their backups", async () => {
    const fixture = censusFixture();
    const manifestPath = fixture.exportManifest().path;
    expect(runCli(["--manifest", manifestPath]).code).toBe(0);

    const prior = plantPriorRun(manifestPath);

    const stderr = await runWithFsFault(manifestPath, (actual) => ({
      // `to` is the last suffix only for its tmp→final rename — its displacement writes `….sql.bak` — so
      // that path is displaced and then never republished, while `from` catches all three restores.
      renameSync: (from: string, to: string) => {
        if (to.endsWith(".postverify-detail.sql") || from.endsWith(".bak")) throw EIO();
        return actual.renameSync(from, to);
      },
    }));

    // Both halves of the diagnosis survive: the failure that started it, and the paths left inconsistent.
    expect(stderr).toContain(`${manifestPath}.postverify-detail.sql`);
    expect(stderr).toContain("rollback left the set inconsistent");
    for (const { path, bytes } of prior) {
      const remedy = `is absent or holds THIS run's file — recover it from ${path}.bak`;
      expect(stderr).toContain(`${path} ${remedy}`);
      // The recovery file is the whole point of naming it — a cleanup pass must never have eaten it.
      expect(readFileSync(`${path}.bak`, "utf8")).toBe(bytes);
    }
  });

  /**
   * The mirror case, on a FIRST run: nothing was displaced, so the unwind must DELETE what this run
   * published — and that delete can fail too. Swallowed, it leaves `apply.sql` standing with no post-verify
   * beside it: a runnable fragment of a set never completed, the partial group §5.2 forbids.
   */
  it("names a published final the unwind could not delete, and removes the rest of the set", async () => {
    const fixture = censusFixture();
    const manifestPath = fixture.exportManifest().path;
    // A directory at the LAST final breaks its rename while the two before it have replaced nothing.
    mkdirSync(`${manifestPath}.postverify-detail.sql`);
    const orphan = `${manifestPath}.apply.sql`;

    const stderr = await runWithFsFault(manifestPath, (actual) => ({
      // Only the published final, never its `.tmp` — the staging debris is deliberately silent.
      rmSync: (path: string, options: { force?: boolean }) => {
        if (path.endsWith(".apply.sql")) throw EIO();
        return actual.rmSync(path, options);
      },
    }));

    expect(stderr).toContain(`${orphan} holds THIS run's file and replaced nothing — delete it`);
    // Named because it really is still there, and its partner really is gone: the set is not half-published.
    expect(readFileSync(orphan, "utf8")).toContain("manifest_targets");
    expect(existsSync(`${manifestPath}.postverify.sql`)).toBe(false);
  });

  it("the dry run writes no decision artifact; --apply writes one and prints its digest", () => {
    const fixture = censusFixture();
    // Exported ONCE: `exportedAt` is `datetime('now')`, so a second export is a different manifest with a
    // different digest — exactly the confusion the content-addressed artifact name exists to prevent.
    const exported = fixture.exportManifest();
    const manifestPath = exported.path;

    const dry = runCli(["--manifest", manifestPath]);
    expect(dry.code).toBe(0);
    expect(listing(fixture.dir).some((name) => name.startsWith("census-decision-"))).toBe(false);
    expect(dry.stdout).not.toContain("DECISION_SHA256=");

    const apply = runCli(["--apply", "--manifest", manifestPath, "--max-manifest-age-hours", "24"]);
    expect(apply.stderr).toBe("");
    expect(apply.code).toBe(0);

    const decisionPath = /^DECISION=(.+)$/m.exec(apply.stdout)?.[1] ?? "";
    const digest = /^DECISION_SHA256=([0-9a-f]{64})$/m.exec(apply.stdout)?.[1] ?? "";
    const bytes = readFileSync(decisionPath);
    // The printed digest is a statement about the FILE `--verify-owner-map` will open, not about the
    // in-memory object — it is recomputed from the bytes on disk.
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);

    const artifact = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    expect(artifact["manifestDigest"]).toBe(exported.loaded.bytesSha256);
    expect(artifact["targetCount"]).toBe(3);
    // §9 — the artifact sits next to the manifest it was computed from, named after that manifest's digest.
    expect(decisionPath).toBe(
      join(fixture.dir, `census-decision-${String(artifact["manifestDigest"])}.json`),
    );
  });

  /**
   * That name is derived from the manifest's OWN digest, so a manifest already carrying it aliases its own
   * output. Publishing would displace the manifest, write the decision over it, and delete the backup on
   * success — destroying the frozen input `--verify-owner-map --frozen` reads, which only a hand-run export on prod can produce again.
   */
  it("refuses --apply when the manifest already sits at its own decision-artifact path", () => {
    const fixture = censusFixture();
    const exported = fixture.exportManifest();
    const alias = join(fixture.dir, `census-decision-${exported.loaded.bytesSha256}.json`);
    copyFileSync(exported.path, alias);
    writeSidecar(alias);

    const run = runCli(["--apply", "--manifest", alias, "--max-manifest-age-hours", "24"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("IS the manifest passed as --manifest");
    // Refused, not merely reported: the bytes the frozen re-check needs are still the manifest's own.
    expect(readFileSync(alias, "utf8")).toBe(exported.json);
  });

  it("both post-verify files encode the same target set as the apply script (ii, iii)", () => {
    const { decision, artifacts } = artifactsOf(censusFixture());

    // (ii) — the owner map §9's step 7 compares against must be the one the apply script WROTE. Anchored
    // to the decision rather than only cross-file: three identically wrong files agree with each other.
    const planned = decision.decisions
      .map((d) => `${sqlString(d.positionId)}|${sqlString(d.owner)}`)
      .sort();
    expect(planned).toHaveLength(3);
    for (const [name, sql] of postverifyFiles(artifacts)) {
      expect([name, manifestTargetPairs(sql)]).toEqual([name, planned]);
    }
    expect(manifestTargetPairs(artifacts.applySql)).toEqual(planned);

    // (iii) — the counting query's three columns, in order …
    let previous = -1;
    for (const mode of FAILURE_MODES) {
      const at = artifacts.postverifySql.indexOf(mode.predicate);
      expect([mode.klass, at > previous]).toEqual([mode.klass, true]);
      previous = at;
    }
    // … and the detail file's three statements in that SAME order, each carrying its column's predicate.
    const statements = artifacts.postverifyDetailSql
      .split(";\n")
      .filter((s) => s.includes("klass"));
    expect(statements).toHaveLength(FAILURE_MODES.length);
    FAILURE_MODES.forEach((mode, index) => {
      const statement = statements[index] ?? "";
      expect(statement).toContain(`${mode.klass} AS klass`);
      expect(statement).toContain(mode.predicate);
    });
  });

  it("neither post-verify file writes — statically, and under a -readonly 3.37.2 open (iv)", () => {
    const fixture = censusFixture();
    const { artifacts } = artifactsOf(fixture);

    for (const [name, sql] of postverifyFiles(artifacts)) {
      // Comments come off first: both headers say "READ-ONLY: no BEGIN, no write" in prose, so a bare
      // grep for BEGIN would fire on the very line that documents its absence.
      const code = sql.replace(/^\s*--.*$/gm, "");
      for (const write of FORBIDDEN_IN_POSTVERIFY) {
        expect([name, write, write.test(code)]).toEqual([name, write, false]);
      }
      // The two statements that DO write are legal only because the table is TEMP — enumerated, so a
      // permanent `CREATE TABLE` or a second INSERT target cannot slip in under the keyword scan.
      expect([...code.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1])).toEqual([
        "manifest_targets",
      ]);
      expect([...code.matchAll(/CREATE (TEMP TABLE|\w+)/g)].map((m) => m[1])).toEqual([
        "TEMP TABLE",
      ]);

      // The empirical form of the same claim: on the production host these run after the immutable COMMIT,
      // where a write statement is a hard failure — so it must be one here too.
      const run = fixture.runReadOnly(sql);
      expect([name, run.stderr]).toEqual([name, ""]);
      expect(run.ok).toBe(true);
    }
  });
});

describe("§7.21 — zero targets", () => {
  /** An empty ledger: `nonclosedPositions` is empty, so `targets` is too. */
  const emptyFixture = () => censusFixture("");

  it("the dry run exits 0, states the gates were evaluated, and writes nothing", () => {
    const fixture = emptyFixture();
    const manifestPath = fixture.exportManifest().path;
    const before = listing(fixture.dir);

    const run = runCli(["--manifest", manifestPath]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("no targets in the manifest");
    // The verdict is PRINTED, not implied by the exit code: after a completed census every §9 re-check
    // takes this branch, and an EXIT=0 that merely means "the gate was never reached" is not a check.
    // "already complete" is part of the VERDICT line, so it can only be printed once the gates passed.
    expect(run.stdout).toMatch(
      /no targets — the census is already complete \(gates clean: \d+ blocking gate\(s\) evaluated\)/,
    );
    // Reporting "nothing to do" is the dry run's job; emitting an apply script for an empty target set
    // would be degenerate SQL documenting nothing.
    expect(listing(fixture.dir)).toEqual(before);
  });

  /**
   * The negative half, and the reason this branch gates at all: a ledger with NO targets can still be
   * violating. `WRONG_OWNER_SELL` seeds a resting bounce-ruled SELL against a `profile`-owned position —
   * every position already owned, so the target set is empty while I5 fires. Before the fix this exited 0.
   */
  it("the dry run FAILS on a zero-target manifest that violates an invariant", () => {
    const fixture = censusFixture(WRONG_OWNER_SELL);
    const manifestPath = fixture.exportManifest().path;
    const before = listing(fixture.dir);

    const run = runCli(["--manifest", manifestPath]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("the zero-target manifest did not pass all blocking gates");
    expect(run.stdout).toContain("wrongOwnerSells");
    expect(run.stdout).toContain("pos-i5-owned");
    // The claim and the failure must not both be on screen: an operator who sees the completion verdict
    // above a blocking-gate report has been told the census is done by the same run that just refused it.
    // Anchored to a whole LINE, not a bare substring: the report echoes operator-supplied data verbatim
    // (the manifest path, parser and invariant details), so a run out of a directory literally named
    // "already complete" would fail a substring check that the verdict never actually triggered.
    expect(run.stdout).not.toMatch(/^no targets — the census is already complete(?: \(|$)/m);
    expect(listing(fixture.dir)).toEqual(before);
  });

  it("--apply refuses, non-zero, with no artifact and no decision file", () => {
    const fixture = emptyFixture();
    const manifestPath = fixture.exportManifest().path;
    const before = listing(fixture.dir);

    const run = runCli(["--apply", "--manifest", manifestPath, "--max-manifest-age-hours", "24"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("--apply refuses an empty target set");
    expect(listing(fixture.dir)).toEqual(before);
  });

  it("--verify-owner-map rejects a decision artifact declaring targetCount 0", () => {
    const fixture = emptyFixture();
    const manifestPath = fixture.exportManifest().path;
    const frozen = fixture.exportManifest();

    // `--apply` cannot produce this file, so it is hand-written here on purpose: an empty owner map would
    // make check (c) vacuously true, and absence must never read as success.
    const decisionPath = join(fixture.dir, "census-decision-empty.json");
    const text = serializeDecisionArtifact({
      decisionVersion: 1,
      manifestDigest: frozen.loaded.bytesSha256,
      targetCount: 0,
      owners: [],
    });
    writeFileSync(decisionPath, text);

    const run = runCli([
      "--verify-owner-map",
      "--manifest",
      manifestPath,
      "--max-manifest-age-hours",
      "24",
      "--frozen",
      frozen.path,
      "--decision",
      decisionPath,
      "--decision-digest",
      createHash("sha256").update(text).digest("hex"),
    ]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("(empty)");
    expect(run.stderr).toContain("vacuous");
  });
});

describe("§7.15 — --emit-export-sql", () => {
  it("prints the export SQL verbatim and nothing else", () => {
    const run = runCli(["--emit-export-sql"]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(CENSUS_EXPORT_SQL);
    expect(run.stdout).toContain(PRODUCTION_CONTROL_DB_PATH);
  });

  it("what it prints runs on 3.37.2, loads, and digests the same as the local exporter", () => {
    const fixture = censusFixture();
    const emitted = runCli(["--emit-export-sql"]).stdout.replaceAll(
      PRODUCTION_CONTROL_DB_PATH,
      fixture.controlPath,
    );

    // (b) — the emitted text is what the SERVER runs: the pinned 3.37.2 CLI, against a ledger built from the
    // real migrations. The local exporter's own SQL is never executed here.
    const viaCli = fixture.runReadOnly(emitted);
    expect(viaCli.stderr).toBe("");

    const local = fixture.exportManifest();
    const fromEmitted = JSON.parse(viaCli.stdout) as Record<string, unknown>;
    const fromFixture = JSON.parse(local.json) as Record<string, unknown>;
    // The envelope is `strftime('now')`-derived and legitimately differs between the two runs; everything
    // else is a projection of the same ledger and must match exactly. Read from the SAME constant the digest
    // excludes, so a second nondeterministic envelope field cannot make this test contradict the digest.
    const envelope: readonly string[] = ENVELOPE_FIELDS;
    for (const key of Object.keys(fromFixture).filter((k) => !envelope.includes(k))) {
      expect(fromEmitted[key]).toEqual(fromFixture[key]);
    }

    // (b) continued — the manifest the server-shaped path produces must be one the REAL loader accepts,
    // digest, schema, REAL strings and all. Parsing it as JSON above proves nothing about that.
    const emittedPath = join(fixture.dir, "emitted-export.json");
    writeFileSync(emittedPath, viaCli.stdout);
    writeSidecar(emittedPath);
    const loaded = loadManifest(emittedPath, { maxAgeHours: 24, nowMs: Date.now() });

    // (c) — the contract that makes §9's verification meaningful: the two paths agree on the CANONICAL
    // PAYLOAD DIGEST, which is the quantity the runbook compares a server manifest against. The per-key
    // loop above cannot see a group the emitted text added and the local exporter never had; this can.
    expect(loaded.canonicalPayloadSha256).toBe(local.loaded.canonicalPayloadSha256);
  });
});

describe("a run that refuses", () => {
  it("rejects a manifest older than the age bound, naming the kind", () => {
    const fixture = censusFixture();
    const manifestPath = fixture.exportManifest().path;
    const before = listing(fixture.dir);

    const run = runCli(
      ["--manifest", manifestPath, "--max-manifest-age-hours", "1"],
      Date.now() + 2 * HOUR_MS,
    );
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("census manifest rejected (stale)");
    expect(listing(fixture.dir)).toEqual(before);
  });

  it("a blocking gate prints the full report but hands over NO runnable script", () => {
    // No `profile_settings` row at all — `policy-row` blocks, and the parser has nothing to read.
    const fixture = censusFixture(cleanSeed(), { policy: null });
    const manifestPath = fixture.exportManifest().path;
    const before = listing(fixture.dir);

    const run = runCli(["--manifest", manifestPath]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("a blocking gate failed");

    // The report still renders in full — provenance, plan, counts, every gate with its offending rows …
    expect(run.stdout).toContain("=== census manifest ===");
    expect(run.stdout).toContain("=== blocking-gate report ===");
    expect(run.stdout).toContain("[BLOCK] #policy-row");
    expect(run.stdout).toContain("=> BLOCKED: --apply is refused");
    // … but a blocked run must not hand the operator something runnable.
    expect(run.stdout).not.toContain("=== statement list ===");
    expect(run.stdout).not.toContain("=== artifacts ===");
    expect(listing(fixture.dir)).toEqual(before);
  });

  it("--apply on a blocked manifest writes neither the script nor the decision artifact", () => {
    const fixture = censusFixture(cleanSeed(), { policy: null });
    const manifestPath = fixture.exportManifest().path;
    const before = listing(fixture.dir);

    const run = runCli(["--apply", "--manifest", manifestPath, "--max-manifest-age-hours", "24"]);
    expect(run.code).not.toBe(0);
    expect(run.stdout).toContain("=> BLOCKED: --apply is refused");
    expect(run.stdout).not.toContain("DECISION_SHA256=");
    expect(listing(fixture.dir)).toEqual(before);
  });
});

import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ManifestRejectionKind } from "../manifest.js";
import { runCli, type CliRun } from "./cli.js";
import {
  cleanSeed,
  createCensusFixture,
  rewriteManifest,
  writeSidecar,
  type CensusFixture,
} from "./fixtures.js";
import { censusedFixture, verifyOwnerMapCli } from "./pipeline.js";

/**
 * §7 test 8 — the manifest loader is the trust boundary, one test per rejection class.
 *
 * The manifest is the ONLY way production ledger state reaches this code, and every step that carries it —
 * a server-side `sqlite3` redirect, `sha256sum`, `scp` — is unvalidated by construction. So each class is
 * pinned by its own failing statement, and each assertion names the DIAGNOSTIC, not just the exit code: the
 * kinds exist because the operator's remedy differs per class (re-fetch, re-export, fix the path, rebuild
 * the exporter), and a rejection that lands in the wrong class sends them to the wrong remedy.
 *
 * Every fixture here is an EXPORTED manifest, edited afterwards. A hand-written document would pass or fail
 * against a shape this suite invented rather than the one §5.1 emits.
 *
 * **Deviation from the plan's 8a/8b wording.** The plan asks for "before any ledger connection is opened"
 * to be asserted "by passing an unopenable ledger path alongside". That fixture is not constructible: the
 * CLI opens no database at all (§5.2 — `main` is local, and `CENSUS_OPERANDS` is closed at five, none of
 * them a ledger). The reachable equivalent is asserted instead, and it is the same property: the run leaves
 * the fixture directory byte-for-byte as it found it, so nothing — no connection, no artifact, no partial
 * `.tmp` — outlived the rejection. `cli-argv.test.ts` pins the argv half of the same invariant.
 */

const HOUR_MS = 3_600_000;

/**
 * A dry run that must be REFUSED by the loader, with the two properties every refusal shares: the rendered
 * `census manifest rejected (<kind>)` prefix, and an untouched directory. Returning the run leaves each test
 * to assert only what makes ITS class distinct.
 */
function rejectedDryRun(
  fixture: CensusFixture,
  manifestPath: string,
  kind: ManifestRejectionKind,
  options: { readonly nowMs?: number; readonly maxAgeHours?: number } = {},
): CliRun {
  const before = readdirSync(fixture.dir).sort();
  const argv = [
    "--manifest",
    manifestPath,
    "--max-manifest-age-hours",
    String(options.maxAgeHours ?? 24),
  ];
  const run = options.nowMs === undefined ? runCli(argv) : runCli(argv, options.nowMs);

  // Exit 1, not 2: this is a rejected input, not a usage error. The operator's next command differs.
  expect(run.code).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain(`census manifest rejected (${kind}): `);
  expect(readdirSync(fixture.dir).sort()).toEqual(before);
  return run;
}

/** The seeded fixture plus its exported manifest — the starting point of every case below. */
function exported(): { readonly fixture: CensusFixture; readonly path: string } {
  const fixture = createCensusFixture();
  fixture.seed(cleanSeed());
  return { fixture, path: fixture.exportManifest().path };
}

describe("§7.8 — the manifest loader accepts what §5.1 exports", () => {
  it("a freshly exported manifest is read, and the dry run reports on it", () => {
    const { fixture, path } = exported();
    const run = runCli(["--manifest", path, "--max-manifest-age-hours", "24"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    // The positive control has to show the manifest was actually READ, not merely opened: all three
    // seeded targets reached the decision pass.
    expect(run.stdout).toContain("pos-bounce");
    expect(run.stdout).toContain("pos-gate");
    expect(run.stdout).toContain("pos-profile");
    expect(readdirSync(fixture.dir)).toContain(`${path.split("/").pop() ?? ""}.apply.sql`);
  });
});

describe("§7.8a/8b — the I/O class names WHICH of the two files is missing", () => {
  it("an absent --manifest is refused, echoing the path as given", () => {
    const fixture = createCensusFixture();
    // Deliberately non-normalized: "as given" is only assertable against a path the loader could have
    // silently resolved. A message carrying the resolved form would fail this.
    const asGiven = `${fixture.dir}/./absent-manifest.json`;

    const run = rejectedDryRun(fixture, asGiven, "io");
    expect(run.stderr).toContain(`cannot read the census manifest at ${asGiven} (ENOENT)`);
    expect(run.stderr).not.toContain("sidecar");
  });

  it("an absent .sha256 sidecar is refused as the SIDECAR, not as the manifest", () => {
    const { fixture, path } = exported();
    rmSync(`${path}.sha256`);

    const run = rejectedDryRun(fixture, path, "io");
    expect(run.stderr).toContain(`cannot read the census sidecar at ${path}.sha256 (ENOENT)`);
    // The discriminating half: the manifest is present and readable, so a loader that blamed it would
    // send the operator to re-copy the file they already have.
    expect(run.stderr).not.toContain("cannot read the census manifest");
  });
});

describe("§7.8 — the content classes", () => {
  it("json — a CLI error line captured into the payload by the redirect", () => {
    const { fixture, path } = exported();
    // The real shape of this failure: `sqlite3 … > manifest.json` writes the error to stdout and the
    // redirect happily stores it, so the file exists, is digested, and is not JSON.
    writeFileSync(path, "Error: near line 1: no such table: positions\n");
    writeSidecar(path);

    const run = rejectedDryRun(fixture, path, "json");
    expect(run.stderr).toContain(`${path} is not valid JSON`);
    expect(run.stderr).toContain("first bytes: Error: near line 1: no such table: positions");
  });

  it("hash — bytes that changed after the sidecar was written", () => {
    const { fixture, path } = exported();
    const bytes = readFileSync(path, "utf8");
    // A trailing space keeps the document valid JSON and semantically identical, so ONLY the digest can
    // catch it — which is what makes this a test of the digest rather than of the parser.
    writeFileSync(path, `${bytes} `);

    const run = rejectedDryRun(fixture, path, "hash");
    expect(run.stderr).toContain("manifest digest mismatch: sidecar says");
    expect(run.stderr).toContain("the bytes hash to");
  });

  it("hash — a sidecar carrying no digest at all", () => {
    const { fixture, path } = exported();
    writeFileSync(`${path}.sha256`, "sha256sum: manifest.json: No such file or directory\n");

    const run = rejectedDryRun(fixture, path, "hash");
    expect(run.stderr).toContain(`the sidecar ${path}.sha256 carries no sha256 digest`);
    expect(run.stderr).toContain("sha256sum: manifest.json: No such file or directory");
  });

  // Version 1 in particular: that is the shape that shipped BEFORE §5.1.11, and it carries no invariant
  // block at all. Reading it would produce six absent arrays — a clean verdict on an unexamined ledger.
  it("version — an exporter this build does not support", () => {
    const { fixture, path } = exported();
    rewriteManifest(path, (document) => void (document.manifestVersion = 1));

    const run = rejectedDryRun(fixture, path, "version");
    expect(run.stderr).toContain("unsupported manifestVersion 1; this build supports 2");
    // Version is read BEFORE the payload: with the shape assumptions unfounded, a schema diagnostic
    // would name the wrong defect.
    expect(run.stderr).not.toContain("must be a string");
  });

  it("schema — a v2 manifest whose invariant block is absent, not empty", () => {
    const { fixture, path } = exported();
    rewriteManifest(path, (document) => void delete document.invariants);

    const run = rejectedDryRun(fixture, path, "schema");
    expect(run.stderr).toContain("$.invariants must be an object, got undefined");
  });

  it("schema — ONE missing invariant, which must not read as 'no violations' for it", () => {
    const { fixture, path } = exported();
    rewriteManifest(path, (document) => {
      delete (document.invariants as Record<string, unknown>).wrongOwnerSells;
    });

    const run = rejectedDryRun(fixture, path, "schema");
    expect(run.stderr).toContain("$.invariants.wrongOwnerSells must be an array, got undefined");
  });

  it("schema — a row missing a required column, named by its JSON path", () => {
    const { fixture, path } = exported();
    rewriteManifest(path, (document) => {
      delete targetRow(document, "pos-bounce").token_id;
    });

    const run = rejectedDryRun(fixture, path, "schema");
    expect(run.stderr).toMatch(/\$\.targets\[\d+]\.token_id must be a string, got undefined/);
  });

  it("real_string — a decimal string that parses to Infinity (§5.1.10)", () => {
    const { fixture, path } = exported();
    // `1e999` is the case the regex ALONE admits: canonical in shape, `Infinity` in value. A loader that
    // checked only `CANONICAL_DECIMAL_RE` would accept it and hand the size comparison an Infinity.
    rewriteManifest(path, (document) => void (targetRow(document, "pos-bounce").size = "1e999"));

    const run = rejectedDryRun(fixture, path, "real_string");
    expect(run.stderr).toMatch(
      /\$\.targets\[\d+]\.size is not a canonical finite decimal for pos-bounce: "1e999"/,
    );
  });

  it("stale — past the bound the operator passed", () => {
    const { fixture, path } = exported();
    const exportedAt = fixture.exportManifest().loaded.manifest.exportedAt;

    const run = rejectedDryRun(fixture, path, "stale", {
      maxAgeHours: 24,
      nowMs: Date.parse(exportedAt) + 25 * HOUR_MS,
    });
    expect(run.stderr).toContain("is 25.00h old, past the 24h bound — re-export and re-run");
  });
});

/**
 * §7.8c/8d — the staleness bound is a PER-CALL parameter, and the two operands take different values in the
 * same run. The pair is what makes that expressible: 8c is a positive control by necessity (the defect is a
 * FALSE rejection at the worst possible moment — post-apply, with immutable owners already written, and no
 * negative control can see one), and 8d is its twin, so "exempt" cannot decay into "unchecked".
 *
 * They differ in the clock alone. Both run with `--max-manifest-age-hours 1` against the same trio, whose
 * frozen manifest is a week old and whose fresh export is seconds old.
 */
describe("§7.8c/8d — --frozen is exempt from staleness, --manifest is not", () => {
  const weekAgo = (): string => new Date(Date.now() - 7 * 24 * HOUR_MS).toISOString();

  it("8c — a week-old --frozen manifest verifies clean under a 1h bound", () => {
    const run = verifyOwnerMapCli(censusedFixture(cleanSeed(), { exportedAt: weekAgo() }), {
      maxAgeHours: 1,
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("owner map verified");
  });

  it("8d — the same run rejects once the FRESH manifest is past that bound", () => {
    const exportedAt = weekAgo();
    const trio = censusedFixture(cleanSeed(), { exportedAt });

    const run = verifyOwnerMapCli(trio, { maxAgeHours: 1, nowMs: Date.now() + 2 * HOUR_MS });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("census manifest rejected (stale): ");
    expect(run.stderr).toContain("past the 1h bound");

    // The discriminating assertion: the age named is the FRESH export's ~2h, not the frozen manifest's
    // ~170h. A loader that applied the bound to both would reject on `--frozen` first and report that age
    // — the run would still be non-zero, and the exemption would be silently gone.
    expect(run.stderr).not.toContain(exportedAt);
    const named = Number(/is (\d+\.\d\d)h old/.exec(run.stderr)?.[1]);
    expect(named).toBeGreaterThan(1);
    expect(named).toBeLessThan(3);
  });
});

/** The exported `targets` row for a position, as a mutable record — the corruption cases' one accessor. */
function targetRow(document: Record<string, unknown>, positionId: string): Record<string, unknown> {
  const rows = document.targets as Record<string, unknown>[];
  const row = rows.find((candidate) => candidate.position_id === positionId);
  if (row === undefined) throw new Error(`no target ${positionId} in the exported manifest`);
  return row;
}

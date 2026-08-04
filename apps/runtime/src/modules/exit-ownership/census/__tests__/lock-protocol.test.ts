import { createHash } from "node:crypto";
import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { sqlString } from "../sql-literal.js";
import { runCli } from "./cli.js";
import { cleanSeed, createCensusFixture, policyJson, type SqliteRunResult } from "./fixtures.js";
import {
  CHECK_FAILED,
  expectRolledBack,
  prepareApply,
  probeGuard,
  type PreparedApply,
} from "./pipeline.js";
import { productionSqlite3 } from "./sqlite-cli.js";

/**
 * §7 tests 9 and 12(a)–(d) — the properties that live BETWEEN processes: what a dry run is allowed to
 * touch, and how the apply's single `BEGIN IMMEDIATE` behaves against a second writer. Everything here
 * runs on the pinned production CLI 3.37.2, as test 12 requires of (a)/(b) and v22 extended to (d).
 *
 * The concurrent writer is spliced into the emitted script as a `.shell` line immediately before its
 * `COMMIT`, so it provably runs with the transaction open and both write locks held — no sleep, no race,
 * and no second copy of the apply script. Three facts about the pinned binary were measured before these
 * tests were written, and each is asserted here rather than assumed:
 *
 *  - `BEGIN IMMEDIATE` on the ledger with `control.db` ATTACHed takes BOTH write locks — that is the fence;
 *  - `.shell` is available on the pinned build;
 *  - without `-bail` an erroring statement is merely REPORTED and the trailing `COMMIT` still runs, while
 *    the process exit code and stderr are identical either way — so only the ledger's contents tell the
 *    two apart, which is exactly why 12(d) needs a negative control.
 *
 * Two deviations from the plan's wording, recorded rather than papered over:
 *
 *  - 12(b) offers "one side proceeds and the other fails or WAITS cleanly". The waiting branch is
 *    unreachable through a `.shell` splice — the outer process is paused while the inner one runs, so a
 *    waiter would deadlock the test rather than be served. `busy_timeout=0` on the inner writer therefore
 *    pins the FAILS-cleanly branch. Production's writers carry `busy_timeout=30000`
 *    (`connection.ts`), and the census transaction is milliseconds long, so there the same collision
 *    resolves by waiting; what matters for the plan's claim — no mutual stall — is pinned below by the
 *    stronger fact that the loser holds no lock at all when it fails.
 *  - test 9's "read-only-CONNECTION variant" is implemented as a read-only ledger FILE. The dry run opens
 *    no connection to the ledger at all (`materialize.ts` evaluates the manifest in a `:memory:`
 *    database), and a connection that does not exist cannot be opened read-only; mode `0444` is the
 *    strongest available form of the same claim.
 */

const LOCKED = "database is locked";
/** The inner script prints this the instant it owns the ledger lock — its ABSENCE is 12(b)'s evidence. */
const LEDGER_LOCK_TAKEN = "ledger-lock-taken";

const listing = (dir: string): string[] => readdirSync(dir).sort();
const digest = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

// ───────────────────────────── test 9 — the authorization boundary ─────────────────────────────

describe("§7.9 — a dry run is authorized to write nothing but its three artifacts", () => {
  function dryRunFixture() {
    const fixture = createCensusFixture();
    fixture.seed(cleanSeed());
    return { fixture, manifestPath: fixture.exportManifest().path };
  }

  it("leaves the ledger and control.db byte-identical", () => {
    const { fixture, manifestPath } = dryRunFixture();
    // Deliberately NOT in WAL: a write would land in `ledger.db-wal` and the digest of `ledger.db` would
    // be unchanged, which would make this assertion vacuous. In rollback-journal mode a committed write
    // modifies the main file in place, so the digest is the real evidence.
    const before = {
      ledger: digest(fixture.ledgerPath),
      control: digest(fixture.controlPath),
      owners: fixture.ownerMap(),
      files: listing(fixture.dir),
    };

    const run = runCli(["--manifest", manifestPath]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);

    expect({
      ledger: digest(fixture.ledgerPath),
      control: digest(fixture.controlPath),
      owners: fixture.ownerMap(),
    }).toEqual({ ledger: before.ledger, control: before.control, owners: before.owners });

    // The DELTA, not an absolute listing: exactly the three artifacts appeared, and in particular no
    // `-wal`/`-shm`/journal sidecar next to either database — the trace any real write connection leaves.
    const name = basename(manifestPath);
    expect(listing(fixture.dir).filter((f) => !before.files.includes(f))).toEqual([
      `${name}.apply.sql`,
      `${name}.postverify-detail.sql`,
      `${name}.postverify.sql`,
    ]);
  });

  it("still exits 0 with both databases at mode 0444 — any write it attempted would throw", () => {
    const { fixture, manifestPath } = dryRunFixture();
    // Measured on this machine rather than assumed: at 0444 the OPEN still succeeds for both drivers, and
    // the first write is what fails — `better-sqlite3` throws "attempt to write a readonly database" and
    // the 3.37.2 CLI exits non-zero. That is exactly the plan's "would throw on any attempted write", so
    // a future revision that opens the ledger for real fails here the moment it writes.
    const databases = [fixture.ledgerPath, fixture.controlPath];
    for (const path of databases) chmodSync(path, 0o444);

    try {
      const run = runCli(["--manifest", manifestPath]);
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
    } finally {
      // Restored unconditionally: a failing assertion above must not leave the temp dir in a mode the
      // next assertion in this file cannot read.
      for (const path of databases) chmodSync(path, 0o644);
    }
  });
});

// ───────────────────────────── the concurrent-writer harness ─────────────────────────────

/**
 * The apply, with both databases switched to WAL — the journal mode production runs
 * (`connection.ts`), and the one whose lock semantics 12(a)/(b) are about.
 *
 * Switched AFTER the export on purpose: `journal_mode` is persistent, so this changes how the CLI takes
 * its locks without changing a byte the exporter read. Asserted rather than assumed — silently landing in
 * rollback-journal mode would test a different set of lock rules.
 */
function preparedInWal(): PreparedApply {
  const applied = prepareApply();
  applied.fixture.seed("PRAGMA journal_mode=WAL;");
  applied.fixture.seedControl("PRAGMA journal_mode=WAL;");
  expect([
    applied.fixture.query("PRAGMA journal_mode;"),
    applied.fixture.queryControl("PRAGMA journal_mode;"),
  ]).toEqual(["wal", "wal"]);
  return applied;
}

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

interface ConcurrentRun {
  /** The apply itself — the census, which must still commit. */
  readonly outer: SqliteRunResult;
  readonly innerStdout: string;
  readonly innerStderr: string;
}

/**
 * Runs `inner` as a second `sqlite3` process from INSIDE the apply's open transaction, by splicing one
 * `.shell` line before the emitted `COMMIT`. The inner script is fed from a file because a dot-command
 * must fit on a single line and the real inner scripts are multi-line.
 */
function applyWithConcurrentWriter(
  applied: PreparedApply,
  inner: { readonly db: string; readonly sql: string },
): ConcurrentRun {
  const { dir } = applied.fixture;
  const sqlPath = join(dir, "concurrent.sql");
  const outPath = join(dir, "concurrent.out");
  const errPath = join(dir, "concurrent.err");
  writeFileSync(sqlPath, inner.sql);

  // The `; echo "exit=$?"` trailer does double duty: it records the loser's exit status, and it makes the
  // compound command itself exit 0. A non-zero `.shell` status makes the CLI print "System command
  // returns N" onto the OUTER stderr, which would mask the "the census still committed cleanly" assertion.
  const child = [productionSqlite3(), "-bail", inner.db].map(shellQuote).join(" ");
  const line =
    `.shell ${child} < ${shellQuote(sqlPath)} > ${shellQuote(outPath)} 2> ${shellQuote(errPath)}` +
    `; echo "exit=$?" >> ${shellQuote(errPath)}`;

  expect(applied.applySql.split("\nCOMMIT;")).toHaveLength(2);
  const outer = applied.fixture.runApply(
    applied.applySql.replace("\nCOMMIT;", `\n${line}\nCOMMIT;`),
  );

  return {
    outer,
    innerStdout: readFileSync(outPath, "utf8"),
    innerStderr: readFileSync(errPath, "utf8"),
  };
}

/** What every collision below must leave behind: the census committed, the policy untouched. */
function expectCensusWonCleanly(applied: PreparedApply, run: ConcurrentRun): void {
  expect(run.outer.stderr).toBe("");
  expect(run.outer.ok).toBe(true);
  expect(applied.fixture.ownerMap()).toEqual(applied.plannedOwners);

  // control.db is LOCKED but never written by the census, so its one row must be exactly what the
  // manifest carried — neither the census nor the loser may have moved it.
  expect(
    applied.fixture.queryControl(
      "SELECT execution_policy_json FROM profile_settings WHERE profile_id = 'live-lite';",
    ),
  ).toBe(applied.loaded.manifest.policy.executionPolicyJson);

  expect(run.innerStderr).toContain(LOCKED);
  expect(run.innerStderr).toMatch(/exit=[1-9]/);
}

// ───────────────────────────── tests 12(a)–(d) ─────────────────────────────

describe("§7.12(a) — the policy fence holds while the apply transaction is open", () => {
  it("a concurrent control.db policy write cannot commit, and the census does", () => {
    const applied = preparedInWal();
    const run = applyWithConcurrentWriter(applied, {
      db: applied.fixture.controlPath,
      sql: `PRAGMA busy_timeout=0;
UPDATE profile_settings SET execution_policy_json = ${sqlString(policyJson({ enabled: false }))}
 WHERE profile_id = 'live-lite';`,
    });

    // The fence is the point: `BEGIN IMMEDIATE` on the ledger took control.db's write lock too, even
    // though the census never writes there. Without that, a policy edit could land between guard #1's
    // read and the CAS, and the run would commit owners derived from text nobody ever verified.
    expectCensusWonCleanly(applied, run);
  });
});

describe("§7.12(b) — the ledger→control order cannot produce a mutual stall", () => {
  it("takes both locks in ONE statement, ledger first", () => {
    const { applySql } = prepareApply();
    // `IMMEDIATE`, not deferred: a deferred transaction takes the write lock at its first WRITE, i.e.
    // after every read guard, which is precisely the window the fence exists to close.
    expect(applySql.split("BEGIN")).toHaveLength(2);
    expect(applySql).toContain("BEGIN IMMEDIATE;");
    expect(applySql.indexOf("ATTACH DATABASE")).toBeLessThan(applySql.indexOf("BEGIN IMMEDIATE;"));
  });

  it("a broadening writer taking ledger→control fails at its FIRST lock, holding none", () => {
    const applied = preparedInWal();
    const run = applyWithConcurrentWriter(applied, {
      db: applied.fixture.ledgerPath,
      sql: `PRAGMA busy_timeout=0;
ATTACH DATABASE '${applied.fixture.controlPath}' AS ctl;
BEGIN IMMEDIATE;
SELECT '${LEDGER_LOCK_TAKEN}';
UPDATE ctl.profile_settings SET execution_policy_json = 'broadened' WHERE profile_id = 'live-lite';
COMMIT;`,
    });

    expectCensusWonCleanly(applied, run);
    // This is the no-stall proof, and it is stronger than "one side proceeded": the marker would have
    // printed the instant the loser owned the ledger. Its ABSENCE means the loser failed while holding
    // NOTHING, so it cannot be the far side of a cycle no matter which order the census took.
    expect(run.innerStdout).not.toContain(LEDGER_LOCK_TAKEN);
  });
});

describe("§7.12(c) — a policy edit between export and lock is caught before any owner is written", () => {
  /**
   * §5.4's fence is over the policy TEXT, not a digest — the CLI ships no `sha256()` (`generate-sql.ts`,
   * guard #1). The plan's 12(c) says "digest comparison"; the property is the same and the test pins what
   * the code actually does.
   *
   * The edit flips `applyToAllMarkets`, which §2.5 rules the census must IGNORE. That makes it the sharpest
   * possible fixture: the re-derivation (guard #6) still agrees, so the byte-level fence is the ONLY thing
   * standing between an unverified policy and a one-way write.
   */
  function drifted(): PreparedApply {
    const applied = prepareApply();
    applied.fixture.seedControl(
      `UPDATE profile_settings SET execution_policy_json =
         ${sqlString(policyJson({ applyToAllMarkets: false }))} WHERE profile_id = 'live-lite';`,
    );
    return applied;
  }

  it("guard #1 reads 0 while the re-derivation still reads 1 — the fence is the only detector", () => {
    const applied = drifted();

    expect(probeGuard(applied, { id: "1" })).toBe("0");
    expect(probeGuard(applied, { id: "6" })).toBe("1");
  });

  it("rolls the whole run back, with every target still unowned", () => {
    const applied = drifted();

    expectRolledBack(applied, CHECK_FAILED);
    expect(Object.values(applied.fixture.ownerMap()).every((o) => o === null)).toBe(true);
  });
});

describe("§7.12(d) — -bail, and what its absence costs", () => {
  /** Guard #8's class: a target that acquired a DIFFERENT owner, so its own CAS matches zero rows. */
  function drifted(): PreparedApply {
    const applied = prepareApply();
    applied.fixture.seed(
      "UPDATE positions SET exit_owner = 'profile' WHERE position_id = 'pos-bounce';",
    );
    return applied;
  }

  it("the SAME script writes 0 rows with -bail and a PARTIAL census without it", () => {
    const applied = drifted();
    const before = applied.fixture.ownerMap();

    const bailed = applied.fixture.runApply(applied.applySql);
    expect(applied.fixture.ownerMap()).toEqual(before);

    // The same fixture, deliberately: the run above rolled back, so the ledger is byte-for-byte where it
    // started and the ONLY difference between the two runs is the flag.
    const unbailed = applied.fixture.runApply(applied.applySql, { bail: false });
    expect(applied.fixture.ownerMap()).toEqual({
      ...applied.plannedOwners,
      "pos-bounce": "profile",
    });

    // Why the negative control is not optional: the flag is INVISIBLE in the diagnostics. Identical
    // stderr, identical exit status, opposite ledgers — a runbook that lost `-bail` would look the same
    // and commit a partial one-way write.
    expect([unbailed.stderr, unbailed.ok, unbailed.status]).toEqual([
      bailed.stderr,
      bailed.ok,
      bailed.status,
    ]);
    expect(bailed.stderr).toContain(CHECK_FAILED);
  });
});

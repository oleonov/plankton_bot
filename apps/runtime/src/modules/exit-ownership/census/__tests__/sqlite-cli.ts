import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * §7 tests 12 and 15 — "run against the production CLI version **3.37.2**".
 *
 * The requirement is not ceremony. The census script is executed by `sqlite3` on the production host, and
 * the local CLI is 3.51: every feature the plan had to design AROUND exists there. `unixepoch()` and
 * `json_group_array(x ORDER BY y)` both work on 3.51 and both are absent on 3.37.2, so a suite that ran
 * only locally would go green on an exporter that errors on the one machine it will ever run on.
 *
 * Resolution order, most explicit first:
 *   1. `KRABS_SQLITE_3372` — an operator-supplied path, the escape hatch for a machine with no compiler;
 *   2. the repo cache `<repo>/.cache/sqlite/sqlite3-3.37.2` (gitignored — a binary is never committed);
 *   3. build it from the pinned amalgamation, downloading the zip once if the cache lacks it.
 *
 * A missing binary FAILS rather than skips. A skipped test reports as a pass, and the whole reason this
 * pin exists is that "green locally, broken on the host" is the failure mode being designed out.
 */

export const PRODUCTION_SQLITE_VERSION = "3.37.2";

/** Pinned by exact version — the 3.37.2 release zip, which is what production runs. */
const AMALGAMATION_ZIP = "sqlite-amalgamation-3370200.zip";
const AMALGAMATION_URL = `https://www.sqlite.org/2022/${AMALGAMATION_ZIP}`;

const REPO_ROOT = resolve(import.meta.dirname, "../../../../../../..");
const CACHE_DIR = resolve(REPO_ROOT, ".cache/sqlite");
const CACHED_BIN = resolve(CACHE_DIR, `sqlite3-${PRODUCTION_SQLITE_VERSION}`);

let resolved: string | undefined;

/** The pinned 3.37.2 CLI. Built at most once per machine; memoized per process. */
export function productionSqlite3(): string {
  if (resolved !== undefined) return resolved;
  const fromEnv = process.env.KRABS_SQLITE_3372;
  const bin = fromEnv !== undefined && fromEnv !== "" ? fromEnv : buildIfMissing();
  const actual = sqlite3Version(bin);
  if (actual !== PRODUCTION_SQLITE_VERSION) {
    throw new Error(
      `${bin} reports SQLite ${actual}, not the production ${PRODUCTION_SQLITE_VERSION}. ` +
        `Point KRABS_SQLITE_3372 at a ${PRODUCTION_SQLITE_VERSION} build.`,
    );
  }
  resolved = bin;
  return bin;
}

/** The version string alone (`3.37.2`), i.e. `sqlite3 --version`'s first field. */
export function sqlite3Version(bin: string): string {
  return execFileSync(bin, ["--version"], { encoding: "utf8" }).trim().split(" ")[0] ?? "";
}

function buildIfMissing(): string {
  if (existsSync(CACHED_BIN)) return CACHED_BIN;
  mkdirSync(CACHE_DIR, { recursive: true });
  const zip = resolve(CACHE_DIR, AMALGAMATION_ZIP);
  try {
    if (!existsSync(zip)) {
      execFileSync("curl", ["-sSfL", "--max-time", "180", "-o", zip, AMALGAMATION_URL]);
    }
    execFileSync("unzip", ["-oq", zip], { cwd: CACHE_DIR });
    const src = resolve(CACHE_DIR, "sqlite-amalgamation-3370200");
    // -DSQLITE_ENABLE_JSON1: 3.37.2 ships JSON1 built in, but the flag is harmless and documents that the
    // exporter's `json_object`/`json_each` are required rather than incidental.
    execFileSync("cc", [
      "-O1",
      "-DSQLITE_ENABLE_JSON1",
      "-o",
      CACHED_BIN,
      resolve(src, "shell.c"),
      resolve(src, "sqlite3.c"),
      "-lpthread",
      "-ldl",
      "-lm",
    ]);
  } catch (error) {
    throw new Error(
      `could not build the pinned SQLite ${PRODUCTION_SQLITE_VERSION} CLI in ${CACHE_DIR} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Build it manually from ${AMALGAMATION_URL} and set KRABS_SQLITE_3372 to the binary.`,
    );
  }
  return CACHED_BIN;
}

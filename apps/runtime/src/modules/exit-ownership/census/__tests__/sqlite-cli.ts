import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
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

/**
 * Carries a failed build's message from the main process into the workers, which are separate processes
 * that inherit the environment they were forked with. See `prebuildSqlite3`.
 */
const UNAVAILABLE = "KRABS_SQLITE_3372_UNAVAILABLE";

let resolved: { readonly bin: string } | { readonly error: Error } | undefined;

/**
 * The pinned 3.37.2 CLI. Built at most once per machine; memoized per process.
 *
 * The FAILURE is memoized too, not just the success. Without that, a machine with no compiler re-attempts
 * the whole build on every call — 91 times in one test file, each attempt another `curl`/`cc` charged to
 * whichever test is running — instead of failing once, fast, with the same actionable message.
 */
export function productionSqlite3(): string {
  resolved ??= attemptResolve();
  if ("error" in resolved) throw resolved.error;
  return resolved.bin;
}

/**
 * Resolves the CLI once in Vitest's main process, from the census globalSetup, before any worker starts.
 * On failure it records the message in the environment, which the workers inherit, so the verdict crosses
 * the process boundary that the memo above cannot.
 *
 * Without it the memo is per-process and every worker re-attempts the build independently: measured at 13
 * `sqlite3` resolutions for one census run (the setup plus one per test file), each potentially a fresh
 * 180-second `curl` and a full `cc` over the amalgamation. Throwing here instead is worse than either —
 * a globalSetup that throws aborts the ENTIRE run, taking the 3867 non-census tests with it (measured:
 * `Vitest.initializeGlobalSetup` raises before any project's tests start), which is exactly the collateral
 * the census project's own globalSetup exists to avoid.
 */
export function prebuildSqlite3(): void {
  const outcome = attemptResolve();
  resolved ??= outcome;
  if ("error" in outcome) process.env[UNAVAILABLE] = outcome.error.message;
}

function attemptResolve(): { readonly bin: string } | { readonly error: Error } {
  const alreadyFailed = process.env[UNAVAILABLE];
  if (alreadyFailed !== undefined && alreadyFailed !== "") {
    return { error: new Error(alreadyFailed) };
  }
  try {
    const fromEnv = process.env.KRABS_SQLITE_3372;
    const bin = fromEnv !== undefined && fromEnv !== "" ? fromEnv : buildIfMissing();
    const actual = sqlite3Version(bin);
    if (actual !== PRODUCTION_SQLITE_VERSION) {
      throw new Error(
        `${bin} reports SQLite ${actual}, not the production ${PRODUCTION_SQLITE_VERSION}. ` +
          `Point KRABS_SQLITE_3372 at a ${PRODUCTION_SQLITE_VERSION} build.`,
      );
    }
    return { bin };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** The version string alone (`3.37.2`), i.e. `sqlite3 --version`'s first field. */
export function sqlite3Version(bin: string): string {
  return execFileSync(bin, ["--version"], { encoding: "utf8" }).trim().split(" ")[0] ?? "";
}

/**
 * Every intermediate lands in a private temp directory and reaches the cache by `rename`, which is atomic
 * within a filesystem. The globalSetup builds this before any worker starts, but it does not make the
 * build single-threaded on the MACHINE: two developer `vitest` processes, or a CI job sharing the cache,
 * can enter here at the same time. Compiling straight to `CACHED_BIN` let one of them observe a path that
 * exists while the other linker was still writing it. With `rename`, a concurrent reader sees either no
 * file or the whole binary, and losing the race costs only the duplicated work.
 */
function buildIfMissing(): string {
  if (existsSync(CACHED_BIN)) return CACHED_BIN;
  mkdirSync(CACHE_DIR, { recursive: true });
  const work = mkdtempSync(resolve(CACHE_DIR, "build-"));
  try {
    execFileSync("unzip", ["-oq", fetchAmalgamation(work)], { cwd: work });
    const src = resolve(work, "sqlite-amalgamation-3370200");
    const built = resolve(work, "sqlite3");
    // -DSQLITE_ENABLE_JSON1: 3.37.2 ships JSON1 built in, but the flag is harmless and documents that the
    // exporter's `json_object`/`json_each` are required rather than incidental.
    execFileSync("cc", [
      "-O1",
      "-DSQLITE_ENABLE_JSON1",
      "-o",
      built,
      resolve(src, "shell.c"),
      resolve(src, "sqlite3.c"),
      "-lpthread",
      "-ldl",
      "-lm",
    ]);
    renameSync(built, CACHED_BIN);
  } catch (error) {
    throw new Error(
      `could not build the pinned SQLite ${PRODUCTION_SQLITE_VERSION} CLI in ${CACHE_DIR} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Build it manually from ${AMALGAMATION_URL} and set KRABS_SQLITE_3372 to the binary.`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return CACHED_BIN;
}

/** The zip is cached across builds, but downloaded into `work` first: a partial file must never be it. */
function fetchAmalgamation(work: string): string {
  const cached = resolve(CACHE_DIR, AMALGAMATION_ZIP);
  if (existsSync(cached)) return cached;
  const partial = resolve(work, AMALGAMATION_ZIP);
  execFileSync("curl", ["-sSfL", "--max-time", "180", "-o", partial, AMALGAMATION_URL]);
  renameSync(partial, cached);
  return cached;
}

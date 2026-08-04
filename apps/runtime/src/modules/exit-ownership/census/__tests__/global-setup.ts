import { prebuildSqlite3 } from "./sqlite-cli.js";

/**
 * Builds the pinned 3.37.2 CLI once, in the Vitest main process, before any census test file starts.
 * It is the census project's globalSetup, so a run that selects no census file never reaches it — see
 * `apps/runtime/vitest.config.ts` for why that scoping matters.
 *
 * Left to the first test that happens to need it, the build — a download plus `cc` over the 3.37.2
 * amalgamation — runs INSIDE that test's timeout. On a cold CI cache §7.10 took 33 411 ms against the
 * 5 000 ms default and failed on a stopwatch, not on anything it asserts; the same test is 77 ms once
 * the binary exists. Worse, Vitest runs test files in separate worker processes, each with its own memo,
 * so on a cold cache several of them raced to build the same path. (That is now safe on its own —
 * `buildIfMissing` compiles into a temp directory and `rename`s — but doing it once is still the point:
 * concurrent workers would otherwise each pay for a binary only one of them can install.)
 *
 * A failure here is deferred to the tests, not swallowed: `prebuildSqlite3` records it in the environment
 * the workers inherit, so every census fixture raises the same actionable error immediately instead of
 * re-attempting the build per worker. Why deferral rather than a rethrow is in `prebuildSqlite3`.
 */
export default function setup(): void {
  prebuildSqlite3();
}

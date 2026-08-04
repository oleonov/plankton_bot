import { productionSqlite3 } from "./sqlite-cli.js";

/**
 * Builds the pinned 3.37.2 CLI once, in the Vitest main process, before any test file starts.
 *
 * Left to the first test that happens to need it, the build — a download plus `cc` over the 3.37.2
 * amalgamation — runs INSIDE that test's timeout. On a cold CI cache §7.10 took 33 411 ms against the
 * 5 000 ms default and failed on a stopwatch, not on anything it asserts; the same test is 77 ms once
 * the binary exists. Worse, Vitest runs test files in separate worker processes, each with its own
 * memo, so on a cold cache several of them race to `cc -o` the same path and a worker can find the file
 * present while another is still writing it.
 *
 * A failure here is deferred, not ignored: every census fixture calls `productionSqlite3()` itself and
 * raises the same error, with the `KRABS_SQLITE_3372` escape hatch named in it. Throwing here instead
 * would take down every test in the package over a binary only the census suite uses.
 */
export default function setup(): void {
  try {
    productionSqlite3();
  } catch {
    return;
  }
}

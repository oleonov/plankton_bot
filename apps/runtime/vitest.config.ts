import { defaultExclude, defineConfig } from "vitest/config";

/**
 * The census suite is the only thing in this package that needs the pinned SQLite 3.37.2 CLI, and getting
 * it costs a download plus a `cc` over the amalgamation. Building it lazily inside whichever test reached
 * it first charged that work to that test's timeout — on a cold CI cache §7.10 took 33 411 ms against the
 * 5 000 ms default and failed on a stopwatch, versus 77 ms once the binary exists.
 *
 * So it is built once in a `globalSetup`. The census tests get their own project because a project's
 * globalSetup is skipped entirely when the run resolves no files for it: `vitest run <some-other-file>`
 * — and `test:prepush`, which names non-census files — then never pays for a binary it cannot use.
 * A single package-wide globalSetup would charge every targeted run the same build on a cold cache.
 */
const CENSUS_TESTS = "src/modules/exit-ownership/census/__tests__/**/*.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "runtime",
          passWithNoTests: true,
          include: ["src/**/*.test.ts"],
          exclude: [...defaultExclude, CENSUS_TESTS],
        },
      },
      {
        test: {
          name: "census",
          passWithNoTests: true,
          include: [CENSUS_TESTS],
          globalSetup: ["src/modules/exit-ownership/census/__tests__/global-setup.ts"],
        },
      },
    ],
  },
});

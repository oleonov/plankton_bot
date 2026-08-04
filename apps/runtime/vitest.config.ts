import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ["src/**/*.test.ts"],
    // Builds the pinned SQLite 3.37.2 CLI once, before any worker starts. Leaving it to the first
    // census test that needs it charges the build to that test's timeout — see the file for the
    // measurement that made this necessary.
    globalSetup: ["src/modules/exit-ownership/census/__tests__/global-setup.ts"],
  },
});

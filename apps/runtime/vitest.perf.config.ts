import { defineConfig } from "vitest/config";

// Timing benchmarks must not share the CPU with the parallel suite (turbo packages plus
// vitest workers) — contention there inflates measured event-loop p99 and makes the guard flaky.
export default defineConfig({
  test: {
    include: ["src/**/*.perf.test.ts"],
    fileParallelism: false,
  },
});

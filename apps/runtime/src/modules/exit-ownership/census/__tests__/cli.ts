import { main, type CensusIo } from "../main.js";

/**
 * The §7 CLI harness: `main(argv, io)` in-process with both streams captured and the clock injected.
 *
 * `main` is deliberately a pure `(argv, io) => number` and the `src/scripts` wrapper is one statement, so
 * every CLI assertion in this suite runs the real entry point rather than a spawned process — no build step,
 * no `process.exit`, and the staleness bound is testable without touching the system clock.
 */

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCli(argv: readonly string[], nowMs: number = Date.now()): CliRun {
  const out: string[] = [];
  const err: string[] = [];
  const io: CensusIo = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    nowMs: () => nowMs,
  };
  return { code: main(argv, io), stdout: out.join("\n"), stderr: err.join("\n") };
}

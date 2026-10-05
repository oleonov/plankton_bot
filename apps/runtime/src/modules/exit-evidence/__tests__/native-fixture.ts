import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const compiled = (file: string) =>
  pathToFileURL(resolve(`dist/modules/exit-evidence/${file}.js`)).href;

// Turbo test builds dependencies, not this package. Own the compiled fixtures here.
// Shared by native.test.ts and native-overhead.perf.test.ts, each registering it in its
// own beforeAll with the same 65_000 timeout.
export function buildCompiledFixtures(): void {
  execFileSync(process.execPath, [resolve("../../node_modules/typescript/bin/tsc"), "-b"], {
    timeout: 60_000,
    stdio: "pipe",
  });
}

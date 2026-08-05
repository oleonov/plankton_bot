#!/usr/bin/env node

// Every vitest config in this repo sets passWithNoTests: true, so a positional filter matching
// nothing exits 0. A renamed or deleted suite therefore drops out of the pre-push gate silently
// instead of breaking it — which is how six of the seven suites this gate once named went missing
// unnoticed. Assert the files exist before handing them to vitest.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BUILD_PACKAGES = ["@krabs/domain", "@krabs/db"];

const SUITES = [
  { pkg: "@krabs/config", dir: "packages/config", files: ["src/__tests__/env.test.ts"] },
  {
    pkg: "@krabs/db",
    dir: "packages/db",
    files: ["src/__tests__/ledger-migrations.test.ts", "src/__tests__/control-migrations.test.ts"],
  },
  { pkg: "@krabs/api", dir: "apps/api", files: ["src/__tests__/api.test.ts"] },
  {
    pkg: "@krabs/runtime",
    dir: "apps/runtime",
    files: [
      "src/__tests__/supervisor.test.ts",
      "src/__tests__/market-scanner-module.test.ts",
      "src/__tests__/signal-to-order-bridge.test.ts",
    ],
  },
];

const missing = SUITES.flatMap(({ dir, files }) =>
  files.map((file) => join(dir, file)).filter((path) => !existsSync(path)),
);

if (missing.length > 0) {
  console.error("pre-push suite check failed: these suites no longer exist:");
  for (const path of missing) console.error(`  ${path}`);
  console.error("");
  console.error("vitest would accept them and pass. Update SUITES in scripts/prepush-suites.mjs");
  process.exit(1);
}

function run(args) {
  try {
    execFileSync("pnpm", args, { stdio: "inherit" });
  } catch {
    process.exit(1);
  }
}

for (const pkg of BUILD_PACKAGES) run(["--filter", pkg, "build"]);
for (const { pkg, files } of SUITES) run(["--filter", pkg, "exec", "vitest", "run", ...files]);

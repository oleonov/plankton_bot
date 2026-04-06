import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(resolve(rootDir, ".git"))) {
  process.exit(0);
}

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
    cwd: rootDir,
    stdio: "ignore",
  });
} catch {
  process.exit(0);
}

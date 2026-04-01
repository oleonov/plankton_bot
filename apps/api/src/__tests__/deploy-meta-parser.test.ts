import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Tests the python3 deploy-meta.json parser used by deploy.sh.
 * This is the exact same logic that runs on the server during deploy.
 */

function runParser(metaPath: string): { stdout: string; exitCode: number } {
  const script = `
import json, sys
try:
    with open('${metaPath}') as f:
        v = json.load(f).get('deployVersion', 0)
        if not isinstance(v, int) or v < 0:
            sys.exit(1)
        print(v)
except FileNotFoundError:
    print(0)
except Exception:
    sys.exit(1)
`;
  try {
    const stdout = execSync(`python3 -c "${script.replace(/"/g, '\\"')}"`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { status: number; stdout?: string };
    return { stdout: (e.stdout ?? "").trim(), exitCode: e.status ?? 1 };
  }
}

describe("deploy-meta.json parser (python3)", () => {
  let tmpDir: string;

  function metaPath(name: string): string {
    return path.join(tmpDir, name);
  }

  function writeMetaFile(name: string, content: string): string {
    const p = metaPath(name);
    writeFileSync(p, content, "utf-8");
    return p;
  }

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "deploy-meta-test-"));
  });

  afterAll(() => {
    try {
      execSync(`rm -rf "${tmpDir}"`);
    } catch {
      /* ignore */
    }
  });

  it("returns 0 for missing file (first deploy)", () => {
    const result = runParser(metaPath("nonexistent.json"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0");
  });

  it("returns current version from valid file", () => {
    const p = writeMetaFile(
      "valid.json",
      JSON.stringify({ deployVersion: 42, sha: "abc", deployedAt: "2026-04-01T12:00:00Z" }),
    );
    const result = runParser(p);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("42");
  });

  it("exits 1 for truncated/empty file", () => {
    const p = writeMetaFile("empty.json", "");
    const result = runParser(p);
    expect(result.exitCode).toBe(1);
  });

  it("exits 1 for corrupt JSON", () => {
    const p = writeMetaFile("corrupt.json", "{broken json");
    const result = runParser(p);
    expect(result.exitCode).toBe(1);
  });

  it("exits 1 for negative deployVersion", () => {
    const p = writeMetaFile("negative.json", JSON.stringify({ deployVersion: -5 }));
    const result = runParser(p);
    expect(result.exitCode).toBe(1);
  });

  it("exits 1 for non-integer deployVersion", () => {
    const p = writeMetaFile("float.json", JSON.stringify({ deployVersion: 3.5 }));
    const result = runParser(p);
    expect(result.exitCode).toBe(1);
  });

  it("returns 0 when deployVersion key is missing (treated as first deploy)", () => {
    const p = writeMetaFile("nokey.json", JSON.stringify({ sha: "abc" }));
    const result = runParser(p);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0");
  });
});

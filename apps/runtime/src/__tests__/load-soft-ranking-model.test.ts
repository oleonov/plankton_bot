/**
 * loadSoftRankingModel tests (Step 3, audit doc §F1 / §F14).
 *
 * Asserts the disabled-no-op contract: missing artifact → `null` + warn,
 * malformed JSON → `null` + warn, schema-invalid → `null` + warn. Ensures
 * the runtime startup path never throws on a broken artifact.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  loadSoftRankingModel,
  defaultSoftRankingArtifactPath,
} from "../modules/soft-ranking/load-soft-ranking-model.js";
import type { Logger } from "../logger.js";

const silentLogImpl = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child(): Logger {
    return silentLogImpl as unknown as Logger;
  },
};
const silentLog = silentLogImpl as unknown as Logger;

describe("loadSoftRankingModel", () => {
  beforeEach(() => {
    silentLogImpl.warn.mockClear();
    silentLogImpl.error.mockClear();
  });

  it("loads the production artifact (sanity)", () => {
    const model = loadSoftRankingModel(silentLog);
    expect(model).not.toBeNull();
    expect(model?.modelKind).toBe("logistic-numeric-plus-category");
    expect(model?.featureNames.length).toBe(model?.coefficients.length);
  });

  it("returns null with a warn log when the file is missing", () => {
    const result = loadSoftRankingModel(silentLog, {
      artifactPath: "/tmp/this-path-does-not-exist-soft-ranking.json",
    });
    expect(result).toBeNull();
    expect(silentLogImpl.warn).toHaveBeenCalledTimes(1);
  });

  it("returns null with a warn log when the file is invalid JSON", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-soft-ranking-"));
    const file = path.join(dir, "bad.json");
    writeFileSync(file, "{not-json", "utf-8");

    const result = loadSoftRankingModel(silentLog, { artifactPath: file });
    expect(result).toBeNull();
    expect(silentLogImpl.warn).toHaveBeenCalledTimes(1);
  });

  it("returns null with a warn log when the schema is invalid", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-soft-ranking-"));
    const file = path.join(dir, "bad-schema.json");
    writeFileSync(file, JSON.stringify({ modelVersion: "v1" }), "utf-8");

    const result = loadSoftRankingModel(silentLog, { artifactPath: file });
    expect(result).toBeNull();
    expect(silentLogImpl.warn).toHaveBeenCalledTimes(1);
  });

  it("defaultSoftRankingArtifactPath resolves under apps/runtime", () => {
    const p = defaultSoftRankingArtifactPath();
    expect(p).toMatch(/soft-ranking-model\.v1\.json$/);
  });
});

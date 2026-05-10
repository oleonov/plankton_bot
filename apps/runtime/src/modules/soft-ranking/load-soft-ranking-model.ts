/**
 * Soft-ranking model loader (Step 3, audit doc §P3 / §F1).
 *
 * Reads the JSON artifact from disk and validates it via `loadLogisticModel`.
 * Returns `null` (with a single warn log) when the file is missing or fails
 * validation — the runtime startup must NOT fail. The downstream
 * `SoftRankingScoreModule` then enters its disabled-no-op state.
 *
 * Default artifact path resolves to `<runtime>/src/data/soft-ranking-model.v1.json`
 * for `tsx` and `<runtime>/dist/data/soft-ranking-model.v1.json` for the
 * compiled build (the `tsc -b` output mirrors the `src/` layout under
 * `dist/`, and the runtime package's `prebuild` step copies `src/data` to
 * `dist/data` for production).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadLogisticModel, ModelArtifactSchemaError, type LogisticModel } from "@krabs/domain";
import type { Logger } from "../../logger.js";

export interface LoadSoftRankingModelOptions {
  /** Optional override (absolute path). Used by tests; in production the default resolution is correct. */
  artifactPath?: string;
}

export function defaultSoftRankingArtifactPath(): string {
  // import.meta.url points at this file inside `<runtime>/src/modules/soft-ranking/`
  // (dev) or `<runtime>/dist/modules/soft-ranking/` (prod). The artifact lives
  // under `<runtime>/src/data/` (dev) or `<runtime>/dist/data/` (prod). Either way
  // the relative jump is `../../data/soft-ranking-model.v1.json`.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "data", "soft-ranking-model.v1.json");
}

export function loadSoftRankingModel(
  log: Logger,
  options: LoadSoftRankingModelOptions = {},
): LogisticModel | null {
  const artifactPath = options.artifactPath ?? defaultSoftRankingArtifactPath();
  let raw: string;
  try {
    raw = readFileSync(artifactPath, "utf-8");
  } catch (err) {
    log.warn(
      { err, artifactPath },
      "soft-ranking model artifact not readable — soft ranking disabled",
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(
      { err, artifactPath },
      "soft-ranking model artifact is not valid JSON — soft ranking disabled",
    );
    return null;
  }
  try {
    return loadLogisticModel(parsed);
  } catch (err) {
    if (err instanceof ModelArtifactSchemaError) {
      log.warn(
        { err: err.message, artifactPath },
        "soft-ranking model artifact failed schema validation — soft ranking disabled",
      );
      return null;
    }
    log.warn(
      { err, artifactPath },
      "soft-ranking model artifact load threw unexpected error — soft ranking disabled",
    );
    return null;
  }
}

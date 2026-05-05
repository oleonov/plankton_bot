// Soft-ranking logistic regression scorer (Step 3, audit doc §D2 / §P1).
//
// The runtime artifact is a single ordered standardized vector. Inference is:
//
//   score = sigmoid( intercept + Σᵢ coefficients[i] * (xᵢ − mean[i]) / std[i] )
//
// The artifact is shipped at `apps/runtime/src/data/soft-ranking-model.v1.json`
// and produced by `research_plankton/soft_ranking_score_analysis.py`'s
// `write_runtime_artifact()` helper. `featureNames` carries the canonical
// column order: 12 numeric features (per Python `NUMERIC_FEATURES`) followed
// by the 7 heuristic-category one-hots (`category=other`, `category=sports`,
// `category=politics`, `category=weather`, `category=stocks`, `category=crypto`,
// `category=esports`).

import type { HeuristicCategory } from "../category.js";

export interface LogisticModelDecile {
  readonly decile: string;
  readonly n_negative: number;
  readonly n_positive: number;
  readonly positive_pct: number;
}

export interface LogisticModel {
  readonly modelVersion: string;
  readonly modelKind: string;
  readonly trainedAt: string;
  readonly trainingDatasetHash: string;
  readonly trainingDatasetSize: number;
  readonly validationAuc: number;
  readonly intercept: number;
  readonly featureNames: readonly string[];
  readonly coefficients: readonly number[];
  readonly mean: readonly number[];
  readonly std: readonly number[];
  readonly categoryDefault: HeuristicCategory;
  readonly categories: readonly HeuristicCategory[];
  readonly deciles: readonly LogisticModelDecile[];
}

export class ModelArtifactSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelArtifactSchemaError";
  }
}

function fail(reason: string): never {
  throw new ModelArtifactSchemaError(`soft-ranking model artifact: ${reason}`);
}

function asString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`'${key}' must be a non-empty string`);
  }
  return value;
}

function asFiniteNumber(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`'${key}' must be a finite number`);
  }
  return value;
}

function asNumericVector(obj: Record<string, unknown>, key: string): readonly number[] {
  const value = obj[key];
  if (!Array.isArray(value) || value.length === 0) {
    fail(`'${key}' must be a non-empty array`);
  }
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      fail(`'${key}[${i}]' must be a finite number`);
    }
  }
  return value as readonly number[];
}

function asStringVector(obj: Record<string, unknown>, key: string): readonly string[] {
  const value = obj[key];
  if (!Array.isArray(value) || value.length === 0) {
    fail(`'${key}' must be a non-empty array`);
  }
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (typeof v !== "string" || v.length === 0) {
      fail(`'${key}[${i}]' must be a non-empty string`);
    }
  }
  return value as readonly string[];
}

const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  "other",
  "sports",
  "politics",
  "weather",
  "stocks",
  "crypto",
  "esports",
]);

// Whitelist of supported model artifacts. Bumping this list is a deliberate
// runtime change — the feature builder + sigmoid path only support the
// 12-numeric + 7-category logistic regression shape (audit doc §D2).
const SUPPORTED_MODEL_KINDS: ReadonlySet<string> = new Set([
  "logistic-numeric-plus-category",
]);

// Canonical feature-name set (audit doc §P1.3). Must match exactly — both
// the set of names AND the order — so coefficient indices line up with the
// `buildFeatureRow` output. Mismatch at load time is a hard failure: better
// to disable the module than start scoring with a silently wrong artifact.
const EXPECTED_NUMERIC_FEATURES: readonly string[] = [
  "log_liquidity",
  "liquidity_raw",
  "min_tick_001",
  "mid_price",
  "mid_below_010",
  "mid_below_005",
  "horizon_hours",
  "log_horizon",
  "horizon_above_30d",
  "event_size",
  "volume_24h",
  "log_volume",
];

function asCategory(value: unknown, key: string): HeuristicCategory {
  if (typeof value !== "string" || !VALID_CATEGORIES.has(value)) {
    fail(`'${key}' must be one of ${[...VALID_CATEGORIES].join(",")}`);
  }
  return value as HeuristicCategory;
}

export function loadLogisticModel(json: unknown): LogisticModel {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    fail("root must be an object");
  }
  const obj = json as Record<string, unknown>;

  const modelVersion = asString(obj, "modelVersion");
  const modelKind = asString(obj, "modelKind");
  if (!SUPPORTED_MODEL_KINDS.has(modelKind)) {
    fail(
      `'modelKind' '${modelKind}' is not supported by this runtime (expected one of ${[...SUPPORTED_MODEL_KINDS].join(",")})`,
    );
  }
  const trainedAt = asString(obj, "trainedAt");
  const trainingDatasetHash = asString(obj, "trainingDatasetHash");
  const trainingDatasetSize = asFiniteNumber(obj, "trainingDatasetSize");
  const validationAuc = asFiniteNumber(obj, "validationAuc");
  const intercept = asFiniteNumber(obj, "intercept");
  const featureNames = asStringVector(obj, "featureNames");
  const coefficients = asNumericVector(obj, "coefficients");
  const mean = asNumericVector(obj, "mean");
  const std = asNumericVector(obj, "std");

  if (!(featureNames.length === coefficients.length && coefficients.length === mean.length && mean.length === std.length)) {
    fail(
      `vector length mismatch: featureNames=${featureNames.length} coefficients=${coefficients.length} mean=${mean.length} std=${std.length}`,
    );
  }
  for (let i = 0; i < std.length; i++) {
    if (std[i] === 0) {
      fail(`'std[${i}]' is zero — cannot standardize feature '${featureNames[i]}'`);
    }
  }

  const categoryDefault = asCategory(obj.categoryDefault, "categoryDefault");
  const rawCategories = asStringVector(obj, "categories");
  const categories: HeuristicCategory[] = [];
  for (let i = 0; i < rawCategories.length; i++) {
    categories.push(asCategory(rawCategories[i], `categories[${i}]`));
  }

  // Strict feature-name validation (audit doc §P1.3). Verifies BOTH the
  // exact set AND the order: the runtime indexes coefficients by position,
  // so an out-of-order or extra-named artifact would produce silently
  // wrong scores. Numeric block is fixed; category block follows the
  // artifact's `categories` array, each prefixed `category=`.
  const expectedFeatureNames: string[] = [
    ...EXPECTED_NUMERIC_FEATURES,
    ...categories.map((c) => `category=${c}`),
  ];
  if (featureNames.length !== expectedFeatureNames.length) {
    fail(
      `'featureNames' has ${featureNames.length} entries, expected ${expectedFeatureNames.length} (12 numeric + ${categories.length} category one-hots)`,
    );
  }
  for (let i = 0; i < expectedFeatureNames.length; i++) {
    if (featureNames[i] !== expectedFeatureNames[i]) {
      fail(
        `'featureNames[${i}]' is '${featureNames[i]}', expected '${expectedFeatureNames[i]}'`,
      );
    }
  }

  const rawDeciles = obj.deciles;
  if (!Array.isArray(rawDeciles)) {
    fail("'deciles' must be an array");
  }
  const deciles: LogisticModelDecile[] = [];
  for (let i = 0; i < rawDeciles.length; i++) {
    const d = rawDeciles[i];
    if (d === null || typeof d !== "object" || Array.isArray(d)) {
      fail(`'deciles[${i}]' must be an object`);
    }
    const drec = d as Record<string, unknown>;
    deciles.push({
      decile: asString(drec, "decile"),
      n_negative: asFiniteNumber(drec, "n_negative"),
      n_positive: asFiniteNumber(drec, "n_positive"),
      positive_pct: asFiniteNumber(drec, "positive_pct"),
    });
  }

  return {
    modelVersion,
    modelKind,
    trainedAt,
    trainingDatasetHash,
    trainingDatasetSize,
    validationAuc,
    intercept,
    featureNames,
    coefficients,
    mean,
    std,
    categoryDefault,
    categories,
    deciles,
  };
}

function sigmoid(z: number): number {
  // Mirrors the numpy clip in `LogisticModel.predict_proba` (clip −40..40).
  const clipped = z > 40 ? 40 : z < -40 ? -40 : z;
  return 1.0 / (1.0 + Math.exp(-clipped));
}

export function predictScore(model: LogisticModel, featureRow: ReadonlyMap<string, number>): number {
  let z = model.intercept;
  for (let i = 0; i < model.featureNames.length; i++) {
    const name = model.featureNames[i]!;
    const x = featureRow.get(name);
    if (x === undefined) {
      throw new Error(`predictScore: feature '${name}' is missing from input row`);
    }
    if (!Number.isFinite(x)) {
      throw new Error(`predictScore: feature '${name}' is non-finite (${x})`);
    }
    z += model.coefficients[i]! * ((x - model.mean[i]!) / model.std[i]!);
  }
  return sigmoid(z);
}

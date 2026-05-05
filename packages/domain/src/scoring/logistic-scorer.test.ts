import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFeatureRow } from "./feature-builder.js";
import { ModelArtifactSchemaError, loadLogisticModel, predictScore } from "./logistic-scorer.js";

const ARTIFACT_PATH = fileURLToPath(
  new URL("../../../../apps/runtime/src/data/soft-ranking-model.v1.json", import.meta.url),
);
const ARTIFACT_RAW = JSON.parse(readFileSync(ARTIFACT_PATH, "utf-8"));

function buildFixtureRow(args: {
  slug: string;
  eventSlug: string;
  liquidity: number;
  tickSize: number;
  midPrice: number;
  horizonHours: number;
  eventMarketCount: number;
  volume24hr: number;
}): ReadonlyMap<string, number> {
  const snapshotTs = 0;
  const endDateMs = snapshotTs + args.horizonHours * 3_600_000;
  const endDate = new Date(endDateMs).toISOString();
  const row = buildFeatureRow({
    liquidity: args.liquidity,
    midPrice: args.midPrice,
    volume24hr: args.volume24hr,
    endDate,
    tickSize: args.tickSize,
    eventMarketCount: args.eventMarketCount,
    snapshotTs,
    slug: args.slug,
    eventSlug: args.eventSlug,
  });
  if (row === null) throw new Error("buildFeatureRow returned null in fixture");
  return row;
}

describe("loadLogisticModel", () => {
  it("loads the shipped artifact", () => {
    const model = loadLogisticModel(ARTIFACT_RAW);
    expect(model.modelVersion).toBe("v1.0.0-2026-05-05");
    expect(model.modelKind).toBe("logistic-numeric-plus-category");
    expect(model.featureNames.length).toBe(model.coefficients.length);
    expect(model.featureNames.length).toBe(model.mean.length);
    expect(model.featureNames.length).toBe(model.std.length);
    expect(model.featureNames.length).toBe(19); // 12 numeric + 7 category
    expect(model.validationAuc).toBeGreaterThan(0.8);
    expect(model.categories).toEqual([
      "other",
      "sports",
      "politics",
      "weather",
      "stocks",
      "crypto",
      "esports",
    ]);
  });

  it("rejects non-object root", () => {
    expect(() => loadLogisticModel(null)).toThrow(ModelArtifactSchemaError);
    expect(() => loadLogisticModel([])).toThrow(ModelArtifactSchemaError);
    expect(() => loadLogisticModel("foo")).toThrow(ModelArtifactSchemaError);
  });

  it("rejects missing required fields", () => {
    const obj = { ...ARTIFACT_RAW } as Record<string, unknown>;
    delete obj.intercept;
    expect(() => loadLogisticModel(obj)).toThrow(/intercept/);
  });

  it("rejects vector length mismatch", () => {
    const obj = {
      ...ARTIFACT_RAW,
      coefficients: ARTIFACT_RAW.coefficients.slice(0, -1),
    };
    expect(() => loadLogisticModel(obj)).toThrow(/length mismatch/);
  });

  it("rejects non-finite numbers in vectors", () => {
    const coefficients = [...ARTIFACT_RAW.coefficients];
    coefficients[0] = Number.NaN;
    expect(() => loadLogisticModel({ ...ARTIFACT_RAW, coefficients })).toThrow(/finite number/);
  });

  it("rejects zero std (would cause division-by-zero at inference)", () => {
    const std = [...ARTIFACT_RAW.std];
    std[0] = 0;
    expect(() => loadLogisticModel({ ...ARTIFACT_RAW, std })).toThrow(/std/);
  });

  it("rejects unknown category in categories array", () => {
    expect(() =>
      loadLogisticModel({ ...ARTIFACT_RAW, categories: [...ARTIFACT_RAW.categories, "xyz"] }),
    ).toThrow(/categories/);
  });
});

describe("predictScore (parity with Python oracle)", () => {
  const model = loadLogisticModel(ARTIFACT_RAW);

  // Oracle values produced from the patched Python script — same artifact,
  // same `predict_proba` math. Tolerance 1e-6 (audit doc §F2 / §P1.6).
  const cases: Array<{
    name: string;
    fixture: Parameters<typeof buildFixtureRow>[0];
    expected: number;
  }> = [
    {
      name: "crypto",
      fixture: {
        slug: "bitcoin-100k-by-eoy",
        eventSlug: "bitcoin-2025",
        liquidity: 5000,
        tickSize: 0.01,
        midPrice: 0.04,
        horizonHours: 240,
        eventMarketCount: 2,
        volume24hr: 2500,
      },
      expected: 0.5158738509,
    },
    {
      name: "sports",
      fixture: {
        slug: "nba-finals-mvp",
        eventSlug: "nba-finals-2026",
        liquidity: 12000,
        tickSize: 0.001,
        midPrice: 0.015,
        horizonHours: 72,
        eventMarketCount: 10,
        volume24hr: 10000,
      },
      expected: 0.6650192477,
    },
    {
      name: "politics",
      fixture: {
        slug: "us-election-2028",
        eventSlug: "potus-2028",
        liquidity: 8000,
        tickSize: 0.01,
        midPrice: 0.08,
        horizonHours: 720,
        eventMarketCount: 4,
        volume24hr: 4000,
      },
      expected: 0.6072708878,
    },
    {
      name: "weather",
      fixture: {
        slug: "nyc-temperature-january",
        eventSlug: "nyc-weather",
        liquidity: 1500,
        tickSize: 0.01,
        midPrice: 0.03,
        horizonHours: 48,
        eventMarketCount: 24,
        volume24hr: 600,
      },
      expected: 0.0313835883,
    },
    {
      name: "other",
      fixture: {
        slug: "random-thing",
        eventSlug: "random-event",
        liquidity: 100,
        tickSize: 0.01,
        midPrice: 0.02,
        horizonHours: 12,
        eventMarketCount: 1,
        volume24hr: 50,
      },
      expected: 0.1592690632,
    },
  ];

  for (const tc of cases) {
    it(`matches Python oracle for ${tc.name} fixture within 1e-6`, () => {
      const row = buildFixtureRow(tc.fixture);
      const score = predictScore(model, row);
      expect(score).toBeCloseTo(tc.expected, 6);
    });
  }

  it("throws when a required feature is missing from the row", () => {
    const partial = new Map<string, number>();
    expect(() => predictScore(model, partial)).toThrow(/missing/);
  });

  it("throws when a feature is non-finite", () => {
    const row = new Map<string, number>(buildFixtureRow(cases[0]!.fixture));
    row.set("mid_price", Number.NaN);
    expect(() => predictScore(model, row)).toThrow(/non-finite/);
  });
});

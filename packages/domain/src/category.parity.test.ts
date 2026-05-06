import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveCategory, type HeuristicCategory } from "./category.js";

interface ParityRow {
  readonly slug: string;
  readonly eventSlug: string | null;
  readonly expected: HeuristicCategory;
}

interface ParityFixture {
  readonly _generated_by: string;
  readonly _source_function: string;
  readonly _call_shape: string;
  readonly rows: readonly ParityRow[];
}

const FIXTURE_PATH = fileURLToPath(new URL("./__fixtures__/category-parity.json", import.meta.url));
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as ParityFixture;

describe("deriveCategory — TS/Python parity (ADR-020 §D6)", () => {
  it("fixture is non-empty and points at the canonical Python source", () => {
    expect(FIXTURE.rows.length).toBeGreaterThan(0);
    expect(FIXTURE._source_function).toContain("category_from_text");
  });

  // Exhaustive iteration is the parity gate: we run every fixture row
  // through `deriveCategory` and assert the result matches the Python
  // oracle's output. Re-run
  // `research_plankton/scripts/build_category_parity_fixture.py` whenever
  // the Python keyword lists are edited; this test will fail loudly until
  // the TS keyword lists in `category.ts` are brought back in sync.
  for (const row of FIXTURE.rows) {
    const label = `slug=${JSON.stringify(row.slug)} eventSlug=${JSON.stringify(row.eventSlug)} → ${row.expected}`;
    it(label, () => {
      expect(deriveCategory(row.slug, row.eventSlug)).toBe(row.expected);
    });
  }
});

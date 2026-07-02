import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import { SqliteMarketRepository } from "../repositories/market-repository.js";
import { createTokenId } from "@krabs/domain";

function baseMarket(overrides = {}) {
  return {
    tokenId: createTokenId("t-sig-1"),
    conditionId: "0x1",
    slug: "s",
    eventSlug: null,
    question: "Q?",
    outcome: "Yes",
    outcomeIndex: 0,
    regime: null,
    horizon: null,
    endDate: "2026-12-31T00:00:00Z",
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    eventMarketCount: 2,
    selectionStatus: "matched_include" as const,
    selectionWinningRuleId: null,
    gammaCreatedAt: "2026-06-23T00:00:00Z",
    groupItemTitle: null,
    groupItemThreshold: null,
    tags: null,
    createdAt: "2026-06-23T00:00:00Z",
    updatedAt: "2026-06-23T00:00:00Z",
    ...overrides,
  };
}

describe("signature feature persistence", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("round-trips sig_* through saveBatch/findByTokenId", () => {
    // UPSERT_MARKET_SQL also references bootstrap-only columns (tradable,
    // gamma_created_at) that a bare runMigrations() call never adds — use
    // bootstrapDatabase(), matching the convention in market-repository.test.ts.
    tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-test-"));
    const conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
    const repo = new SqliteMarketRepository(conn.db);
    repo.saveBatch([
      baseMarket({
        sigMid: 0.06,
        sigCheapMid: 0.06,
        sigLiquidity: 800,
        sigVol24h: 120,
        sigFeaturesAt: "2026-06-23T01:00:00Z",
      }),
    ]);
    const got = repo.findByTokenId(createTokenId("t-sig-1"))!;
    expect(got.sigCheapMid).toBe(0.06);
    expect(got.sigLiquidity).toBe(800);
    expect(got.sigVol24h).toBe(120);
    expect(got.sigFeaturesAt).toBe("2026-06-23T01:00:00Z");
    conn.close();
  });
});

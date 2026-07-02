import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import { SqliteMarketRepository } from "../repositories/market-repository.js";
import { createTokenId } from "@krabs/domain";

const SIG = {
  minLiquidity: 500,
  minMid: 0.01,
  maxMid: 0.3,
  minRemainingDays: 14,
  minVol24h: 50,
  minTick: 0.001,
  featureTtlMs: 86_400_000,
};

function m(id: string, o = {}) {
  return {
    tokenId: createTokenId(id),
    conditionId: "0x" + id,
    slug: id,
    eventSlug: null,
    question: "Will crypto BTC hit X?",
    outcome: "Yes",
    outcomeIndex: 0,
    regime: null,
    horizon: null,
    endDate: "2027-01-01T00:00:00Z",
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    eventMarketCount: 2,
    selectionStatus: "matched_include" as const,
    selectionWinningRuleId: null,
    gammaCreatedAt: "2026-06-30T00:00:00Z",
    groupItemTitle: null,
    groupItemThreshold: null,
    tags: null,
    sigMid: 0.05,
    sigCheapMid: 0.05,
    sigLiquidity: 800,
    sigVol24h: 120,
    sigFeaturesAt: new Date().toISOString(),
    createdAt: "2026-06-30T00:00:00Z",
    updatedAt: "2026-06-30T00:00:00Z",
    ...o,
  };
}

describe("plankton signature tier", () => {
  // UPSERT_MARKET_SQL references bootstrap-only columns (tradable, gamma_created_at)
  // that a bare runMigrations() call never adds — use bootstrapDatabase(), matching
  // the convention in market-repository.test.ts / the signature-persist test.
  let tmpDir: string;
  let conn: ReturnType<typeof bootstrapDatabase>;
  let repo: SqliteMarketRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-test-"));
    conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
    repo = new SqliteMarketRepository(conn.db);
  });

  afterEach(() => {
    conn.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("admits a signature market even when it would fail V4 (fresh, no snapshot)", () => {
    repo.saveBatch([m("sig1")]); // no market_snapshot row -> V4 would reject (null bid/ask)
    const t = repo.findTrackedForPricingTiered({
      maxTokens: 2000,
      signatureReserve: 300,
      signature: SIG,
    });
    expect(t.planktonSignature.map((x) => String(x.tokenId))).toContain("sig1");
    expect(t.entryCandidates.map((x) => String(x.tokenId))).not.toContain("sig1");
  });

  it("null/stale sig features do NOT match", () => {
    repo.saveBatch([
      m("nullsig", { sigCheapMid: null }),
      m("stale", { sigFeaturesAt: new Date(Date.now() - 90_000_000).toISOString() }),
    ]);
    const t = repo.findTrackedForPricingTiered({
      maxTokens: 2000,
      signatureReserve: 300,
      signature: SIG,
    });
    const sig = t.planktonSignature.map((x) => String(x.tokenId));
    expect(sig).not.toContain("nullsig");
    expect(sig).not.toContain("stale");
  });

  it("respects signatureReserve and reports overflow", () => {
    repo.saveBatch([m("a"), m("b"), m("c")]);
    // maxTokens capped so the reserve fully consumes the live budget — the
    // overflow market truly gets no entryCandidate slot and overflow stays 1.
    const t = repo.findTrackedForPricingTiered({
      maxTokens: 2,
      signatureReserve: 2,
      signature: SIG,
    });
    expect(t.planktonSignature.length).toBe(2);
    expect(t.entryCandidates.length).toBe(0);
    expect(t.signatureOverflow).toBe(1);
  });

  it("counts a signature-overflow market as covered when it wins an entryCandidate slot", () => {
    // "newer" wins the single reserved signature slot; "older" overflows out
    // of the signature tier but still has a fresh market_snapshot (liquidity +
    // volume24h) that lets it clear V4 admission and take a live entryCandidate
    // slot — it must NOT be counted as overflow.
    repo.saveBatch([
      m("older", { gammaCreatedAt: "2026-06-01T00:00:00Z" }),
      m("newer", { gammaCreatedAt: "2026-06-30T00:00:00Z" }),
    ]);
    conn.db
      .prepare(
        `INSERT INTO market_snapshots (token_id, best_bid, best_ask, last_price, volume_24h, liquidity, captured_at)
         VALUES ('older', 0.1, 0.2, 0.15, 120, 800, datetime('now'))`,
      )
      .run();
    const t = repo.findTrackedForPricingTiered({
      maxTokens: 2000,
      signatureReserve: 1,
      signature: SIG,
    });
    expect(t.planktonSignature.map((x) => String(x.tokenId))).toEqual(["newer"]);
    expect(t.entryCandidates.map((x) => String(x.tokenId))).toContain("older");
    expect(t.signatureOverflow).toBe(0);
  });

  it("sorts signature by freshness (gammaCreatedAt DESC)", () => {
    repo.saveBatch([
      m("old", { gammaCreatedAt: "2026-06-01T00:00:00Z" }),
      m("new", { gammaCreatedAt: "2026-06-30T00:00:00Z" }),
    ]);
    const t = repo.findTrackedForPricingTiered({
      maxTokens: 2000,
      signatureReserve: 1,
      signature: SIG,
    });
    expect(String(t.planktonSignature[0]!.tokenId)).toBe("new");
    expect(t.signatureOverflow).toBe(1);
  });

  it("reserveSignature: false (shadow) leaves signature markets in the V4 pool — no placement change vs the live/default call", () => {
    repo.saveBatch([
      m("shadowReject"), // no market_snapshot row -> V4 rejects on its own merit
      m("shadowAdmit", { gammaCreatedAt: "2026-06-29T00:00:00Z" }),
    ]);
    conn.db
      .prepare(
        `INSERT INTO market_snapshots (token_id, best_bid, best_ask, last_price, volume_24h, liquidity, captured_at)
         VALUES ('shadowAdmit', 0.1, 0.2, 0.15, 120, 800, datetime('now'))`,
      )
      .run();

    // Live/default reservation (reserveSignature unset -> true) pulls both
    // signature-matching markets out of the V4 pool entirely, so neither one
    // is independently reachable as an entryCandidate or discoveryOnly market.
    const live = repo.findTrackedForPricingTiered({
      maxTokens: 2000,
      signatureReserve: 300,
      signature: SIG,
    });
    expect(live.planktonSignature.map((x) => String(x.tokenId)).sort()).toEqual([
      "shadowAdmit",
      "shadowReject",
    ]);
    expect(live.entryCandidates.map((x) => String(x.tokenId))).not.toContain("shadowAdmit");
    expect(live.discoveryOnly.map((x) => String(x.tokenId))).not.toContain("shadowReject");

    // Shadow mode: reservation disabled. planktonSignature is still populated
    // as a projection for the coverage metric, but neither market was removed
    // from the V4 pool — each lands wherever V4 puts it on its own merit,
    // exactly as a call without the signature feature would.
    const shadow = repo.findTrackedForPricingTiered({
      maxTokens: 2000,
      signatureReserve: 300,
      signature: SIG,
      reserveSignature: false,
    });
    expect(shadow.planktonSignature.map((x) => String(x.tokenId)).sort()).toEqual([
      "shadowAdmit",
      "shadowReject",
    ]);
    expect(shadow.entryCandidates.map((x) => String(x.tokenId))).toContain("shadowAdmit");
    expect(shadow.discoveryOnly.map((x) => String(x.tokenId))).toContain("shadowReject");
    expect(shadow.entryCandidates.map((x) => String(x.tokenId))).not.toContain("shadowReject");
    expect(shadow.discoveryOnly.map((x) => String(x.tokenId))).not.toContain("shadowAdmit");

    // Both matched markets fit within signatureReserve=300, so the shadow
    // projection of overflow is 0 too — same denominator math as live mode.
    expect(shadow.signatureOverflow).toBe(0);
  });

  it("executionCritical is never displaced by signature reserve", () => {
    repo.saveBatch([m("sig1")]);
    // open position on sig1 -> executionCritical
    conn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, condition_id, side, size, avg_entry_price, cost_basis_usdc, status, opened_at, updated_at)
                VALUES ('p1','sig1','0xsig1','buy',10,0.05,0.5,'open',datetime('now'),datetime('now'))`,
      )
      .run();
    const t = repo.findTrackedForPricingTiered({
      maxTokens: 2000,
      signatureReserve: 300,
      signature: SIG,
    });
    expect(t.executionCritical.map((x) => String(x.tokenId))).toContain("sig1");
    expect(t.planktonSignature.map((x) => String(x.tokenId))).not.toContain("sig1");
  });
});

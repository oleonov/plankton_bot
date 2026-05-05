/**
 * Soft-ranking score module tests (Step 3, audit doc §P3.5).
 *
 * Covers:
 *   - Step2-included batch → updateScoresBatch called with all rows
 *   - non-Step2 markets filtered out
 *   - missing-feature markets skipped
 *   - missing-artifact (model = null) → no-op + healthCheck = "disabled"
 *   - predictScore exception → caught, counter incremented
 *   - debounced recompute hook fires once per flush window
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  type LogisticModel,
  type MarketRepository,
  type MarketScoreUpdate,
  type NormalizedMarket,
  type SelectionStatus,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SoftRankingScoreModule } from "../modules/soft-ranking/soft-ranking-score-module.js";
import { loadLogisticModel } from "@plankton/domain";

// ─── Helpers ──────────────────────────────────────────────────────────────

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

function loadModel(): LogisticModel {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const artifact = path.resolve(here, "..", "data", "soft-ranking-model.v1.json");
  const raw: unknown = JSON.parse(readFileSync(artifact, "utf-8"));
  return loadLogisticModel(raw);
}

const NOW_MS = Date.UTC(2026, 4, 5, 12, 0, 0); // 2026-05-05T12:00:00Z

function makeMarket(
  overrides?: Partial<NormalizedMarket> & { tokenSuffix?: string },
): NormalizedMarket {
  const tokenSuffix = overrides?.tokenSuffix ?? "1";
  return {
    tokenId: createTokenId(`tok-${tokenSuffix}`),
    conditionId: "cond-1",
    slug: "bitcoin-above-100k-on-may-15",
    eventSlug: "bitcoin-monthly",
    eventMarketCount: 1,
    question: "Will BTC go above 100k?",
    outcome: "YES",
    outcomeIndex: 0,
    regime: null,
    horizon: null,
    endDate: new Date(NOW_MS + 7 * 24 * 60 * 60 * 1000).toISOString(),
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    gammaCreatedAt: null,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.45,
    bestAsk: 0.55,
    midPrice: 0.5,
    spread: 0.1,
    volume24h: 500_000,
    volume24hr: 25_000,
    liquidity: 75_000,
    selectionStatus: "matched_include" as SelectionStatus,
    snapshotTs: NOW_MS,
    featuresCapturedTs: NOW_MS,
    ...overrides,
  };
}

function makeRepo(): MarketRepository & {
  __batches: MarketScoreUpdate[][];
} {
  const batches: MarketScoreUpdate[][] = [];
  return {
    save: vi.fn(),
    saveBatch: vi.fn(),
    findByTokenId: vi.fn(),
    findByTokenIds: vi.fn(),
    findByConditionId: vi.fn(),
    findActive: vi.fn(),
    iterateActiveTokenIds: vi.fn(),
    iterateAllTokenIds: vi.fn(),
    findAll: vi.fn(),
    deactivate: vi.fn(),
    deactivateMissing: vi.fn(),
    findTrackedForPricing: vi.fn(),
    findTrackedForPricingTiered: vi.fn(),
    findEventMarketCountBySlug: vi.fn(),
    updateScoresBatch: (updates: Iterable<MarketScoreUpdate>) => {
      batches.push(Array.from(updates));
    },
    __batches: batches,
  } as unknown as MarketRepository & { __batches: MarketScoreUpdate[][] };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("SoftRankingScoreModule", () => {
  let bus: InProcessEventBus;
  let model: LogisticModel;

  beforeEach(() => {
    bus = new InProcessEventBus();
    model = loadModel();
    silentLogImpl.info.mockClear();
    silentLogImpl.warn.mockClear();
    silentLogImpl.error.mockClear();
  });

  it("disabled-state: model=null → no subscription, healthCheck reports disabled", async () => {
    const repo = makeRepo();
    const mod = new SoftRankingScoreModule({
      bus,
      marketRepo: repo,
      log: silentLog,
      model: null,
      now: () => NOW_MS,
    });
    await mod.start();
    expect(silentLogImpl.warn).toHaveBeenCalledTimes(1);

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: NOW_MS,
    });
    expect(repo.__batches.length).toBe(0);

    const h = await mod.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.detail).toMatch(/disabled/);
    await mod.stop();
  });

  it("scores Step2-included markets and writes one batch per event", async () => {
    const repo = makeRepo();
    const mod = new SoftRankingScoreModule({
      bus,
      marketRepo: repo,
      log: silentLog,
      model,
      now: () => NOW_MS,
    });
    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({ tokenSuffix: "a" }),
        makeMarket({ tokenSuffix: "b", selectionStatus: "step2_fallback_include" }),
      ],
      timestamp: NOW_MS,
    });

    expect(repo.__batches.length).toBe(1);
    const batch = repo.__batches[0]!;
    expect(batch.length).toBe(2);
    for (const u of batch) {
      expect(u.score).toBeGreaterThan(0);
      expect(u.score).toBeLessThan(1);
      expect(u.modelVersion).toBe(model.modelVersion);
      expect(u.featuresCapturedAt).toBe(new Date(NOW_MS).toISOString());
      expect(u.scoredAt).toBe(new Date(NOW_MS).toISOString());
    }
    await mod.stop();
  });

  it("filters out non-Step2 markets (skippedNonStep2Included counter increments)", async () => {
    const repo = makeRepo();
    const mod = new SoftRankingScoreModule({
      bus,
      marketRepo: repo,
      log: silentLog,
      model,
      now: () => NOW_MS,
    });
    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({ tokenSuffix: "a" }),
        makeMarket({ tokenSuffix: "b", selectionStatus: "unknown" }),
        makeMarket({ tokenSuffix: "c", selectionStatus: "matched_exclude" }),
        makeMarket({ tokenSuffix: "d", selectionStatus: null }),
      ],
      timestamp: NOW_MS,
    });

    expect(repo.__batches.length).toBe(1);
    expect(repo.__batches[0]!.length).toBe(1);
    const h = await mod.healthCheck();
    expect(h.detail).toMatch(/skippedNonStep2Included=3/);
    await mod.stop();
  });

  it("skips markets with missing required features", async () => {
    const repo = makeRepo();
    const mod = new SoftRankingScoreModule({
      bus,
      marketRepo: repo,
      log: silentLog,
      model,
      now: () => NOW_MS,
    });
    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({ tokenSuffix: "a" }),
        makeMarket({ tokenSuffix: "b", liquidity: null }),
        makeMarket({ tokenSuffix: "c", volume24hr: null }),
        makeMarket({ tokenSuffix: "d", midPrice: null }),
      ],
      timestamp: NOW_MS,
    });

    expect(repo.__batches.length).toBe(1);
    expect(repo.__batches[0]!.length).toBe(1);
    const h = await mod.healthCheck();
    expect(h.detail).toMatch(/missingFeatures=3/);
    await mod.stop();
  });

  it("does not call updateScoresBatch when no markets pass the filter", async () => {
    const repo = makeRepo();
    const mod = new SoftRankingScoreModule({
      bus,
      marketRepo: repo,
      log: silentLog,
      model,
      now: () => NOW_MS,
    });
    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ selectionStatus: "unknown" })],
      timestamp: NOW_MS,
    });

    expect(repo.__batches.length).toBe(0);
    await mod.stop();
  });

  it("debounces the recomputeScoreDistribution hook to once per flushIntervalMs", async () => {
    const repo = makeRepo();
    const recompute = vi.fn().mockResolvedValue(undefined);
    let nowMs = NOW_MS;
    const mod = new SoftRankingScoreModule({
      bus,
      marketRepo: repo,
      log: silentLog,
      model,
      recomputeScoreDistribution: recompute,
      flushIntervalMs: 60_000,
      now: () => nowMs,
    });
    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: nowMs,
    });
    expect(recompute).toHaveBeenCalledTimes(1);

    nowMs += 10_000; // still within debounce window
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: nowMs,
    });
    expect(recompute).toHaveBeenCalledTimes(1);

    nowMs += 60_000; // past debounce window
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: nowMs,
    });
    expect(recompute).toHaveBeenCalledTimes(2);

    await mod.stop();
  });

  it("surfaces the latest snapshot in healthCheck (audit doc §F7)", async () => {
    const repo = makeRepo();
    const recompute = vi.fn().mockReturnValue({
      modelVersion: "v1.0.0",
      scoredMarkets: 12,
      staleMarkets: 3,
      mean: 0.4321,
      capturedAt: new Date(NOW_MS).toISOString(),
    });
    const mod = new SoftRankingScoreModule({
      bus,
      marketRepo: repo,
      log: silentLog,
      model,
      recomputeScoreDistribution: recompute,
      now: () => NOW_MS,
    });
    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: NOW_MS,
    });
    expect(recompute).toHaveBeenCalledTimes(1);

    const h = await mod.healthCheck();
    expect(h.detail).toMatch(/scored=12/);
    expect(h.detail).toMatch(/stale=3/);
    expect(h.detail).toMatch(/mean=0\.4321/);
    await mod.stop();
  });

  it("catches predictScore exceptions and continues processing", async () => {
    // Force a predictScore failure by passing a model whose featureNames
    // include a feature `buildFeatureRow` does not emit. The first market
    // throws; the second uses a valid featureRow.
    // We synthesize this by constructing a model with an unrecognized feature
    // name appended.
    const corruptedModel: LogisticModel = {
      ...model,
      featureNames: [...model.featureNames, "nonexistent_feature"],
      coefficients: [...model.coefficients, 0.1],
      mean: [...model.mean, 0],
      std: [...model.std, 1],
    };
    const repo = makeRepo();
    const mod = new SoftRankingScoreModule({
      bus,
      marketRepo: repo,
      log: silentLog,
      model: corruptedModel,
      now: () => NOW_MS,
    });
    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ tokenSuffix: "a" }), makeMarket({ tokenSuffix: "b" })],
      timestamp: NOW_MS,
    });

    expect(repo.__batches.length).toBe(0);
    const h = await mod.healthCheck();
    expect(h.detail).toMatch(/scoringErrors=2/);
    expect(silentLogImpl.warn).toHaveBeenCalled();
    await mod.stop();
  });
});

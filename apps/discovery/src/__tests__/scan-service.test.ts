import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { bootstrapDatabase, type DbConnection } from "@plankton/db";
import type { MarketDiscoveryGateway, ClobMarket } from "@plankton/domain";
import { ScanService } from "../scan-service.js";

const silentLogger = pino({ level: "silent" });

function makeClobMarket(
  overrides: Partial<ClobMarket> & { slug: string; conditionId: string },
): ClobMarket {
  return {
    tokens: [],
    question: overrides.slug,
    endDate: "",
    active: true,
    negRisk: false,
    tickSize: 0.01,
    ...overrides,
  };
}

function makeGateway(markets: ClobMarket[]): MarketDiscoveryGateway {
  return {
    discoverMarkets: async () => markets,
    forEachMarketPage: async (cb) => {
      if (markets.length > 0) cb(markets);
      return { totalMarkets: markets.length };
    },
    healthCheck: async () => ({ ok: true, latencyMs: 0 }),
  };
}

let conn: DbConnection;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-scan-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ScanService", () => {
  it("returns correct stats for discovered markets", async () => {
    const markets = [
      makeClobMarket({ conditionId: "c1", slug: "bitcoin-above-95000", endDate: "2026-03-28T12:00:00Z" }),
      makeClobMarket({ conditionId: "c2", slug: "bitcoin-above-100000", endDate: "2026-03-28T14:00:00Z" }),
      makeClobMarket({ conditionId: "c3", slug: "ethereum-above-4000" }),
    ];

    const service = new ScanService({
      db: conn.db,
      log: silentLogger,
      gateway: makeGateway(markets),
    });

    const stats = await service.run();

    expect(stats.marketsFound).toBe(3);
    expect(stats.clustersCreated).toBe(2); // bitcoin-above + ethereum-above
    expect(stats.candidatesUpserted).toBe(2);
    expect(stats.matched).toBe(0);
    expect(stats.pruned).toBe(0);
  });

  it("calls onProgress during scan", async () => {
    const markets = [
      makeClobMarket({ conditionId: "c1", slug: "bitcoin-above-95000" }),
    ];
    const onProgress = vi.fn();

    const service = new ScanService({
      db: conn.db,
      log: silentLogger,
      gateway: makeGateway(markets),
      onProgress,
    });

    await service.run();

    // Called after market fetch + after clustering = at least 2
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("handles empty market response with zero stats", async () => {
    const service = new ScanService({
      db: conn.db,
      log: silentLogger,
      gateway: makeGateway([]),
    });

    const stats = await service.run();

    expect(stats.marketsFound).toBe(0);
    expect(stats.clustersCreated).toBe(0);
    expect(stats.candidatesUpserted).toBe(0);
    expect(stats.matched).toBe(0);
    expect(stats.pruned).toBe(0);
  });

  it("preserves firstSeenAt on subsequent scans", async () => {
    const markets = [
      makeClobMarket({ conditionId: "c1", slug: "bitcoin-above-95000" }),
    ];
    const gateway = makeGateway(markets);

    // First scan
    await new ScanService({ db: conn.db, log: silentLogger, gateway }).run();

    // Capture the firstSeenAt from DB
    const row1 = conn.db
      .prepare("SELECT first_seen_at FROM family_candidates LIMIT 1")
      .get() as { first_seen_at: string };

    // Advance clock by 1s so observation timestamps don't collide with unique constraint
    vi.useFakeTimers({ now: Date.now() + 1_000 });
    try {
      await new ScanService({ db: conn.db, log: silentLogger, gateway }).run();
    } finally {
      vi.useRealTimers();
    }

    const row2 = conn.db
      .prepare("SELECT first_seen_at FROM family_candidates LIMIT 1")
      .get() as { first_seen_at: string };

    expect(row2.first_seen_at).toBe(row1.first_seen_at);
  });

  it("handles multi-page discovery correctly", async () => {
    const page1 = [
      makeClobMarket({ conditionId: "c1", slug: "bitcoin-above-95000", endDate: "2026-03-28T12:00:00Z" }),
    ];
    const page2 = [
      makeClobMarket({ conditionId: "c2", slug: "bitcoin-above-100000", endDate: "2026-03-28T14:00:00Z" }),
      makeClobMarket({ conditionId: "c3", slug: "ethereum-above-4000" }),
    ];

    const gateway: MarketDiscoveryGateway = {
      discoverMarkets: async () => [...page1, ...page2],
      forEachMarketPage: async (cb) => {
        cb(page1);
        cb(page2);
        return { totalMarkets: 3 };
      },
      healthCheck: async () => ({ ok: true, latencyMs: 0 }),
    };

    const service = new ScanService({
      db: conn.db,
      log: silentLogger,
      gateway,
    });

    const stats = await service.run();

    expect(stats.marketsFound).toBe(3);
    expect(stats.clustersCreated).toBe(2); // bitcoin-above + ethereum-above
    expect(stats.candidatesUpserted).toBe(2);
  });
});

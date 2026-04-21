import { describe, it, expect, vi } from "vitest";
import type {
  MarketDataGateway,
  ClobMarket,
  OrderBookSnapshot,
  TokenId,
  Market,
} from "@plankton/domain";
import { createTokenId } from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { MarketDataModule } from "../../modules/market-data/market-data-module.js";

// ─── Minimal test helpers ─────────────────────────────────────────────────

function createMockGateway(): MarketDataGateway {
  return {
    getMarkets: vi
      .fn<(onPage?: (page: number) => Promise<void> | void) => Promise<ClobMarket[]>>()
      .mockResolvedValue([]),
    getMarket: vi.fn().mockResolvedValue(null),
    getOrderBook: vi.fn<(tokenId: TokenId) => Promise<OrderBookSnapshot>>().mockResolvedValue({
      tokenId: "tok" as TokenId,
      bids: [],
      asks: [],
      bestBid: 0,
      bestAsk: 0,
      midPrice: 0,
      spread: 0,
      timestamp: Date.now(),
    }),
    getTickSize: vi.fn().mockResolvedValue(0.01),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    getMarketPricing: vi.fn().mockResolvedValue(new Map()),
  };
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

const trackedMarket: Market = {
  tokenId: createTokenId("tok-1"),
  conditionId: "cond-1",
  slug: "test-market",
  eventSlug: null,
  question: "Test?",
  outcome: "YES",
  regime: "threshold",
  horizon: "daily",
  endDate: "2026-12-31",
  active: true,
  tradable: true,
  tickSize: 0.01,
  negRisk: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const mockMarketRepo = {
  findActive: vi.fn().mockReturnValue([trackedMarket]),
  // Phase 4: market-data module uses findTrackedForPricing instead of findActive
  findTrackedForPricing: vi.fn().mockReturnValue([trackedMarket]),
  deactivate: vi.fn(),
  iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
  deactivateMissing: vi.fn().mockReturnValue(0),
  save: vi.fn(),
  saveBatch: vi.fn(),
  findByTokenId: vi.fn().mockReturnValue(null),
  findByTokenIds: vi.fn().mockReturnValue([]),
  findByConditionId: vi.fn().mockReturnValue([]),
  findAll: vi.fn().mockReturnValue([]),
  findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
};

// ─── Scenario ─────────────────────────────────────────────────────────────

describe("Scenario: stale market data detection", () => {
  it("transitions fresh → stale → fresh as polls occur relative to staleThresholdMs", async () => {
    const staleThresholdMs = 50;
    const bus = new InProcessEventBus();
    const mod = new MarketDataModule({
      gateway: createMockGateway(),
      marketRepo: mockMarketRepo as any,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs,
    });

    // 1. Initial poll — establishes freshness
    await mod.poll();

    // 2. Immediately after poll, data should be fresh
    const fresh = await mod.healthCheck();
    expect(fresh.ok).toBe(true);
    expect(fresh.detail).toContain("fresh");

    // 3. Wait past the stale threshold without polling
    await new Promise((r) => setTimeout(r, staleThresholdMs + 50));

    // 4. Health should now report stale
    const stale = await mod.healthCheck();
    expect(stale.ok).toBe(false);
    expect(stale.detail).toContain("stale");

    // 5. Polling again restores freshness
    await mod.poll();

    const recovered = await mod.healthCheck();
    expect(recovered.ok).toBe(true);
    expect(recovered.detail).toContain("fresh");
  });
});

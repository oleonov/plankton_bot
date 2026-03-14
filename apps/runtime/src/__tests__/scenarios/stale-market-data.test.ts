import { describe, it, expect, vi } from "vitest";
import type { MarketDataGateway, ClobMarket, OrderBookSnapshot, TokenId, EventBus } from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { MarketDataModule } from "../../modules/market-data/market-data-module.js";

// ─── Minimal test helpers ─────────────────────────────────────────────────

function createMockGateway(): MarketDataGateway {
  return {
    getMarkets: vi.fn<() => Promise<ClobMarket[]>>().mockResolvedValue([]),
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

// ─── Scenario ─────────────────────────────────────────────────────────────

describe("Scenario: stale market data detection", () => {
  it("transitions fresh → stale → fresh as polls occur relative to staleThresholdMs", async () => {
    const staleThresholdMs = 50;
    const bus = new InProcessEventBus();
    const mod = new MarketDataModule({
      gateway: createMockGateway(),
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

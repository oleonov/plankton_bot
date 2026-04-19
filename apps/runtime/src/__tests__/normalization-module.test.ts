import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTokenId } from "@plankton/domain";
import type { MarketRepository, NormalizedMarket, Market } from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { NormalizationModule } from "../modules/normalization/normalization-module.js";

// ─── Test helpers ────────────────────────────────────────────────────────

function nearEndDate(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function makeNormalizedMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    tokenId: createTokenId("tok-1"),
    conditionId: "cond-1",
    slug: "btc-above-100k-price",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Will BTC go above 100k?",
    outcome: "YES",
    outcomeIndex: 0,
    regime: null,
    horizon: null,
    endDate: nearEndDate(),
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.45,
    bestAsk: 0.55,
    midPrice: 0.5,
    spread: 0.1,
    snapshotTs: Date.now(),
    ...overrides,
  };
}

function createMockMarketRepo(): MarketRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(null),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
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

// ─── Tests ───────────────────────────────────────────────────────────────

describe("NormalizationModule", () => {
  let bus: InProcessEventBus;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let mod: NormalizationModule;

  beforeEach(() => {
    bus = new InProcessEventBus();
    marketRepo = createMockMarketRepo();
    silentLog.info.mockClear();
    silentLog.warn.mockClear();
    silentLog.error.mockClear();
    silentLog.debug.mockClear();
    mod = new NormalizationModule({
      bus,
      marketRepo,
      log: silentLog,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("healthCheck returns not-ok before start", async () => {
    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
  });

  it("healthCheck returns ok after start", async () => {
    await mod.start();
    const h = await mod.healthCheck();
    expect(h.ok).toBe(true);
    await mod.stop();
  });

  it("passes all markets through with null regime and horizon fields", async () => {
    await mod.start();

    const received: NormalizedMarket[][] = [];
    bus.subscribe("NormalizedMarketUpdated", async (p) => {
      received.push([...p.markets]);
    });

    await bus.publish("MarketSnapshotReceived", {
      markets: [makeNormalizedMarket({ slug: "btc-above-100k-price" })],
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0]![0]!.regime).toBeNull();
    expect(received[0]![0]!.horizon).toBeNull();

    await mod.stop();
  });

  it("emits per-batch debug logs and periodic summary info logs", async () => {
    vi.useFakeTimers();
    await mod.start();

    await bus.publish("MarketSnapshotReceived", {
      markets: [makeNormalizedMarket({ slug: "btc-one-price" })],
      timestamp: Date.now(),
    });
    await bus.publish("MarketSnapshotReceived", {
      markets: [makeNormalizedMarket({ tokenId: createTokenId("tok-2"), slug: "btc-two-price" })],
      timestamp: Date.now(),
    });

    expect(silentLog.debug).toHaveBeenCalledWith(
      expect.objectContaining({ total: 1 }),
      "normalization complete",
    );
    expect(silentLog.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ batches: expect.any(Number) }),
      "normalization summary",
    );

    await vi.advanceTimersByTimeAsync(30_001);
    await bus.publish("MarketSnapshotReceived", {
      markets: [makeNormalizedMarket({ tokenId: createTokenId("tok-3"), slug: "btc-three-price" })],
      timestamp: Date.now(),
    });

    expect(silentLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        batches: 3,
        normalizedMarkets: 3,
      }),
      "normalization summary",
    );

    await mod.stop();
  });

  it("persists each market to the market repository", async () => {
    await mod.start();

    await bus.publish("MarketSnapshotReceived", {
      markets: [
        makeNormalizedMarket({ slug: "btc-above-100k-price" }),
        makeNormalizedMarket({
          tokenId: createTokenId("tok-2"),
          slug: "some-other-market",
        }),
      ],
      timestamp: Date.now(),
    });

    expect(marketRepo.save).toHaveBeenCalledTimes(2);

    const firstSave = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(firstSave.slug).toBe("btc-above-100k-price");

    const secondSave = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[1]![0] as Market;
    expect(secondSave.slug).toBe("some-other-market");

    await mod.stop();
  });

  it("unsubscribes on stop — no events processed after stop", async () => {
    await mod.start();
    await mod.stop();

    const received: NormalizedMarket[][] = [];
    bus.subscribe("NormalizedMarketUpdated", async (p) => {
      received.push([...p.markets]);
    });

    await bus.publish("MarketSnapshotReceived", {
      markets: [makeNormalizedMarket()],
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(0);
    expect(marketRepo.save).not.toHaveBeenCalled();
  });

  it("preserves pricing data through normalization", async () => {
    await mod.start();

    const received: NormalizedMarket[][] = [];
    bus.subscribe("NormalizedMarketUpdated", async (p) => {
      received.push([...p.markets]);
    });

    await bus.publish("MarketSnapshotReceived", {
      markets: [
        makeNormalizedMarket({
          bestBid: 0.42,
          bestAsk: 0.58,
          midPrice: 0.5,
          spread: 0.16,
        }),
      ],
      timestamp: Date.now(),
    });

    const m = received[0]![0]!;
    expect(m.bestBid).toBe(0.42);
    expect(m.bestAsk).toBe(0.58);
    expect(m.midPrice).toBe(0.5);
    expect(m.spread).toBe(0.16);

    await mod.stop();
  });

  it("handles empty snapshot gracefully", async () => {
    await mod.start();

    const received: NormalizedMarket[][] = [];
    bus.subscribe("NormalizedMarketUpdated", async (p) => {
      received.push([...p.markets]);
    });

    await bus.publish("MarketSnapshotReceived", {
      markets: [],
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(0);

    await mod.stop();
  });
});

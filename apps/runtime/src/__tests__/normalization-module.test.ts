import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTokenId } from "@krabs/domain";
import type { NormalizedMarket } from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { NormalizationModule } from "../modules/normalization/normalization-module.js";
import { SnapshotWriter } from "../snapshot-writer.js";

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
    gammaCreatedAt: null,
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
  let mod: NormalizationModule;

  beforeEach(() => {
    bus = new InProcessEventBus();
    silentLog.info.mockClear();
    silentLog.warn.mockClear();
    silentLog.error.mockClear();
    silentLog.debug.mockClear();
    mod = new NormalizationModule({
      bus,
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

  it("keeps MarketSnapshotHeartbeat isolated from normalization and decision cascade", async () => {
    const repo = { saveBatch: vi.fn(), prune: vi.fn() };
    const snapshotWriter = new SnapshotWriter(repo, {
      intervalMs: 5 * 60 * 1000,
    });
    const normalized: NormalizedMarket[][] = [];
    const observeMarket = vi.fn();
    let reevaluations = 0;
    let signalCount = 0;
    let placeOrderCount = 0;
    let cancelOrderCount = 0;

    bus.subscribe("MarketSnapshotHeartbeat", async ({ markets, timestamp }) => {
      snapshotWriter.onHeartbeat(markets, timestamp);
    });
    bus.subscribe("NormalizedMarketUpdated", async (p) => {
      normalized.push([...p.markets]);
      for (const market of p.markets) observeMarket(market);
      reevaluations += 1;
    });
    bus.subscribe("SignalProduced", async () => {
      signalCount += 1;
    });
    bus.subscribe("PlaceOrderRequested", async () => {
      placeOrderCount += 1;
    });
    bus.subscribe("CancelOrderRequested", async () => {
      cancelOrderCount += 1;
    });
    await mod.start();

    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [makeNormalizedMarket({ slug: "quiet-active-token" })],
      timestamp: Date.now(),
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(repo.saveBatch).toHaveBeenCalledTimes(1);
    expect(normalized).toHaveLength(0);
    expect(observeMarket).not.toHaveBeenCalled();
    expect(reevaluations).toBe(0);
    expect(signalCount).toBe(0);
    expect(placeOrderCount).toBe(0);
    expect(cancelOrderCount).toBe(0);
    expect(repo.prune).not.toHaveBeenCalled();

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

  it("does not write snapshots back into the market repository", async () => {
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

    expect(silentLog.debug).toHaveBeenCalledWith(
      expect.objectContaining({ total: 2 }),
      "normalization complete",
    );

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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId, createFamilyId } from "@plankton/domain";
import type {
  FamilyRulesProvider,
  FamilyIdentity,
  MarketRepository,
  NormalizedMarket,
  Market,
  Regime,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { NormalizationModule } from "../modules/normalization/normalization-module.js";

// ─── Test helpers ────────────────────────────────────────────────────────

function makeIdentity(overrides?: Partial<FamilyIdentity>): FamilyIdentity {
  return {
    familyId: createFamilyId("fam-btc"),
    familyKey: "btc-price",
    primaryCategory: "crypto",
    regime: "threshold" as Regime,
    horizon: "short",
    cadence: "daily",
    strategyProfile: "scalp" as any,
    topicKey: "btc",
    slugPattern: "btc*price",
    notes: null,
    ...overrides,
  };
}

function makeNormalizedMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    tokenId: createTokenId("tok-1"),
    conditionId: "cond-1",
    slug: "btc-above-100k-price",
    eventSlug: null,
    question: "Will BTC go above 100k?",
    outcome: "YES",
    familyId: null,
    familyKey: null,
    regime: null,
    horizon: null,
    endDate: "2026-12-31",
    active: true,
    tickSize: 0.01,
    negRisk: false,
    bestBid: 0.45,
    bestAsk: 0.55,
    midPrice: 0.5,
    spread: 0.1,
    snapshotTs: Date.now(),
    ...overrides,
  };
}

function createMockRulesProvider(families: FamilyIdentity[]): FamilyRulesProvider {
  return {
    getRule: vi.fn().mockReturnValue(null),
    isEnabled: vi.fn().mockReturnValue(true),
    getAllFamilies: vi.fn().mockReturnValue(families),
    getRulesForRegime: vi.fn().mockReturnValue([]),
  };
}

function createMockMarketRepo(): MarketRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(null),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findByFamily: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
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
  let rulesProvider: ReturnType<typeof createMockRulesProvider>;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let mod: NormalizationModule;

  beforeEach(() => {
    bus = new InProcessEventBus();
    rulesProvider = createMockRulesProvider([makeIdentity()]);
    marketRepo = createMockMarketRepo();
    mod = new NormalizationModule({
      bus,
      rulesProvider,
      marketRepo,
      log: silentLog,
    });
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

  it("classifies market matching a family slug pattern", async () => {
    await mod.start();

    const received: NormalizedMarket[][] = [];
    bus.subscribe("NormalizedMarketUpdated", async (p) => {
      received.push([...p.markets]);
    });

    // Publish a market whose slug matches "btc*price" glob
    await bus.publish("MarketSnapshotReceived", {
      markets: [makeNormalizedMarket({ slug: "btc-above-100k-price" })],
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0]![0]!.familyId).toBe("fam-btc");
    expect(received[0]![0]!.familyKey).toBe("btc-price");
    expect(received[0]![0]!.regime).toBe("threshold");
    expect(received[0]![0]!.horizon).toBe("short");

    await mod.stop();
  });

  it("leaves family fields null for unmatched markets", async () => {
    await mod.start();

    const received: NormalizedMarket[][] = [];
    bus.subscribe("NormalizedMarketUpdated", async (p) => {
      received.push([...p.markets]);
    });

    await bus.publish("MarketSnapshotReceived", {
      markets: [makeNormalizedMarket({ slug: "eth-merge-date" })],
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0]![0]!.familyId).toBeNull();
    expect(received[0]![0]!.familyKey).toBeNull();
    expect(received[0]![0]!.regime).toBeNull();

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

    // First call should have familyId set (matched)
    const firstSave = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(firstSave.familyId).toBe("fam-btc");

    // Second call should have familyId null (unmatched)
    const secondSave = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[1]![0] as Market;
    expect(secondSave.familyId).toBeNull();

    await mod.stop();
  });

  it("handles multiple families with different slug patterns", async () => {
    const ethFamily = makeIdentity({
      familyId: createFamilyId("fam-eth"),
      familyKey: "eth-price",
      slugPattern: "eth*price",
      regime: "price-range" as Regime,
      horizon: "medium",
    });

    rulesProvider = createMockRulesProvider([makeIdentity(), ethFamily]);
    mod = new NormalizationModule({
      bus,
      rulesProvider,
      marketRepo,
      log: silentLog,
    });
    await mod.start();

    const received: NormalizedMarket[][] = [];
    bus.subscribe("NormalizedMarketUpdated", async (p) => {
      received.push([...p.markets]);
    });

    await bus.publish("MarketSnapshotReceived", {
      markets: [
        makeNormalizedMarket({ slug: "btc-above-100k-price" }),
        makeNormalizedMarket({
          tokenId: createTokenId("tok-eth"),
          slug: "eth-above-5k-price",
        }),
      ],
      timestamp: Date.now(),
    });

    expect(received[0]![0]!.familyId).toBe("fam-btc");
    expect(received[0]![1]!.familyId).toBe("fam-eth");
    expect(received[0]![1]!.regime).toBe("price-range");

    await mod.stop();
  });

  it("does not crash on families without slug pattern", async () => {
    rulesProvider = createMockRulesProvider([makeIdentity({ slugPattern: null })]);
    mod = new NormalizationModule({
      bus,
      rulesProvider,
      marketRepo,
      log: silentLog,
    });
    await mod.start();

    const received: NormalizedMarket[][] = [];
    bus.subscribe("NormalizedMarketUpdated", async (p) => {
      received.push([...p.markets]);
    });

    await bus.publish("MarketSnapshotReceived", {
      markets: [makeNormalizedMarket()],
      timestamp: Date.now(),
    });

    // Should publish with null family fields (no pattern to match)
    expect(received[0]![0]!.familyId).toBeNull();

    await mod.stop();
  });

  it("daily family rejects long-dated market endDate", async () => {
    const dailyFamily = makeIdentity({
      horizon: "daily",
      slugPattern: "btc*price",
    });
    rulesProvider = createMockRulesProvider([dailyFamily]);
    mod = new NormalizationModule({
      bus,
      rulesProvider,
      marketRepo,
      log: silentLog,
    });
    await mod.start();

    const received: NormalizedMarket[][] = [];
    bus.subscribe("NormalizedMarketUpdated", async (p) => {
      received.push([...p.markets]);
    });

    await bus.publish("MarketSnapshotReceived", {
      markets: [
        makeNormalizedMarket({
          slug: "btc-above-100k-price",
          endDate: new Date(Date.now() + 270 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      timestamp: Date.now(),
    });

    expect(received[0]![0]!.familyId).toBeNull();

    await mod.stop();
  });

  it("daily family accepts near-term market endDate", async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dailyFamily = makeIdentity({
      horizon: "daily",
      slugPattern: "btc*price",
    });
    rulesProvider = createMockRulesProvider([dailyFamily]);
    mod = new NormalizationModule({
      bus,
      rulesProvider,
      marketRepo,
      log: silentLog,
    });
    await mod.start();

    const received: NormalizedMarket[][] = [];
    bus.subscribe("NormalizedMarketUpdated", async (p) => {
      received.push([...p.markets]);
    });

    await bus.publish("MarketSnapshotReceived", {
      markets: [
        makeNormalizedMarket({
          slug: "btc-above-100k-price",
          endDate: tomorrow.toISOString(),
        }),
      ],
      timestamp: Date.now(),
    });

    expect(received[0]![0]!.familyId).toBe("fam-btc");

    await mod.stop();
  });

  it("treats special characters in slug pattern as literal (glob, not regex)", async () => {
    rulesProvider = createMockRulesProvider([makeIdentity({ slugPattern: "[special]*" })]);
    mod = new NormalizationModule({
      bus,
      rulesProvider,
      marketRepo,
      log: silentLog,
    });

    await mod.start();

    const received: NormalizedMarket[][] = [];
    bus.subscribe("NormalizedMarketUpdated", async (p) => {
      received.push([...p.markets]);
    });

    // Slug starting with literal "[special]" should match
    await bus.publish("MarketSnapshotReceived", {
      markets: [makeNormalizedMarket({ slug: "[special]-market" })],
      timestamp: Date.now(),
    });

    expect(received[0]![0]!.familyId).toBe("fam-btc");

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
});

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXECUTION_PROFILE_POLICY,
  PositionStatus,
  createConditionId,
  createPositionId,
  createTokenId,
  type NormalizedMarket,
  type OhlcBucket,
  type OrderRepository,
  type Position,
  type PositionRepository,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";

import { ExecutionProfileManager } from "../execution-profile-manager.js";
import { SignalFeedManager } from "../signal-feed-manager.js";
import { SignalFeedReader, type SignalFeedTradeStatsProvider } from "../signal-feed-reader.js";
import { InMemoryExecutionProfileStateRepository } from "../state-repository.js";
import type { ExecutionProfilePolicy, ExecutionProfileStateRecord } from "../types.js";
import type { SignalFeedBucketRepository } from "../signal-feed-repository.js";

const tokenId = createTokenId("dark-token");
const conditionId = createConditionId("dark-condition");
const NOW = Date.parse("2026-06-15T00:00:00.000Z");

class RecordingSignalFeedRepository implements SignalFeedBucketRepository {
  readonly upserts: OhlcBucket[] = [];

  upsertBucket(bucket: OhlcBucket): void {
    this.upserts.push(bucket);
  }

  upsertBuckets(buckets: readonly OhlcBucket[]): void {
    this.upserts.push(...buckets);
  }

  selectBucketsForToken(): OhlcBucket[] {
    return [];
  }

  deleteBucketsBefore(): number {
    return 0;
  }
}

type HarvestingGuardOverrides = Omit<
  Partial<ExecutionProfilePolicy["scaleIn"]["harvestingGuard"]>,
  "override"
> & {
  override?: Partial<ExecutionProfilePolicy["scaleIn"]["harvestingGuard"]["override"]>;
};

type ScaleInOverrides = Omit<Partial<ExecutionProfilePolicy["scaleIn"]>, "harvestingGuard"> & {
  harvestingGuard?: HarvestingGuardOverrides;
};

type PolicyOverrides = Omit<Partial<ExecutionProfilePolicy>, "scaleIn"> & {
  scaleIn?: ScaleInOverrides;
};

function policy(overrides: PolicyOverrides = {}): ExecutionProfilePolicy {
  return {
    ...DEFAULT_EXECUTION_PROFILE_POLICY,
    ...overrides,
    signalFeed: {
      ...DEFAULT_EXECUTION_PROFILE_POLICY.signalFeed,
      ...(overrides.signalFeed ?? {}),
    },
    scaleIn: {
      ...DEFAULT_EXECUTION_PROFILE_POLICY.scaleIn,
      ...(overrides.scaleIn ?? {}),
      harvestingGuard: {
        ...DEFAULT_EXECUTION_PROFILE_POLICY.scaleIn.harvestingGuard,
        ...(overrides.scaleIn?.harvestingGuard ?? {}),
        override: {
          ...DEFAULT_EXECUTION_PROFILE_POLICY.scaleIn.harvestingGuard.override,
          ...(overrides.scaleIn?.harvestingGuard?.override ?? {}),
        },
      },
    },
    costCaps: {
      ...DEFAULT_EXECUTION_PROFILE_POLICY.costCaps,
      ...(overrides.costCaps ?? {}),
    },
  };
}

function state(overrides: Partial<ExecutionProfileStateRecord> = {}): ExecutionProfileStateRecord {
  return {
    tokenId,
    conditionId,
    profile: "medium",
    state: "PROBING",
    assumedAt: "2026-06-15T00:00:00.000Z",
    lastAvgEntry: 0.1,
    lastTransitionAt: "2026-06-15T00:00:00.000Z",
    activeLadderId: null,
    handoffStartedAt: null,
    addCount: 0,
    lastBuyAtMs: NOW - 2_000_000,
    initialProbeSizeUsd: 7.15,
    metadata: null,
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("dark-position"),
    tokenId,
    conditionId,
    side: "buy",
    size: 100,
    avgEntryPrice: 0.1,
    costBasisUsdc: 8,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: PositionStatus.Open,
    entryStyle: "probe",
    openedAt: "2026-06-15T00:00:00.000Z",
    closedAt: null,
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}

function market(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId,
    conditionId: String(conditionId),
    slug: "dark-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Dark market?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.1,
    bestAsk: 0.102,
    midPrice: 0.101,
    spread: 0.002,
    lastTradePrice: 0.101,
    liquidity: 100,
    minOrderSize: 1,
    gammaCreatedAt: null,
    snapshotTs: NOW,
    ...overrides,
  };
}

function positionRepo(): PositionRepository {
  const row = position();
  return {
    save: vi.fn(),
    findByTokenId: vi.fn((id) => (id === tokenId ? row : null)),
    findOpen: vi.fn(() => [row]),
    findDust: vi.fn(() => []),
    findAll: vi.fn(() => [row]),
    findOpenByEntryStyle: vi.fn(() => []),
  };
}

function orderRepo(): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn(),
    findOpen: vi.fn(() => []),
    findByTokenId: vi.fn(() => []),
    findRecentByTokenId: vi.fn(() => []),
    findFirstByTokenId: vi.fn(() => null),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn(() => 0),
  } as unknown as OrderRepository;
}

function tradeStatsProvider(): SignalFeedTradeStatsProvider {
  return {
    getTradeStats3h: vi.fn(() => ({
      publicTradeCount3h: 80,
      publicNotional3h: null,
      status: "ok" as const,
      windowStartMs: NOW - 3 * 60 * 60_000,
    })),
  };
}

function createSystem(profilePolicy: ExecutionProfilePolicy): {
  bus: InProcessEventBus;
  feedManager: SignalFeedManager;
  feedRepo: RecordingSignalFeedRepository;
  manager: ExecutionProfileManager;
  signals: unknown[];
} {
  const bus = new InProcessEventBus();
  const feedRepo = new RecordingSignalFeedRepository();
  const feedManager = new SignalFeedManager({
    bus,
    repository: feedRepo,
    config: profilePolicy.signalFeed,
  });
  const reader = new SignalFeedReader({
    hotBuffer: feedManager.getHotBuffer(),
    warmTier: feedManager.getWarmTier(),
    bookSignals: tradeStatsProvider(),
    config: profilePolicy.signalFeed,
  });
  const signals: unknown[] = [];
  bus.subscribe("SignalProduced", async ({ signal }) => {
    signals.push(signal);
  });
  const manager = new ExecutionProfileManager({
    bus,
    stateRepo: new InMemoryExecutionProfileStateRepository([state()]),
    positionRepo: positionRepo(),
    orderRepo: orderRepo(),
    policy: () => profilePolicy,
    signalFeedReader: reader,
    now: () => NOW,
  });
  return { bus, feedManager, feedRepo, manager, signals };
}

async function publishSamples(bus: InProcessEventBus): Promise<void> {
  await bus.publish("NormalizedMarketUpdated", {
    markets: [market()],
    timestamp: NOW,
  });
  await bus.publish("MarketSnapshotHeartbeat", {
    markets: [market()],
    timestamp: NOW,
    reason: "full_lifetime_active_position",
    source: "market-data",
  });
}

describe("Execution profile signal feed dark behavior", () => {
  it("does not subscribe or write when signalFeed is disabled", async () => {
    const system = createSystem(policy({ enabled: false }));

    await system.feedManager.start();
    await system.manager.start();
    await publishSamples(system.bus);
    system.feedManager.flushHotToWarm(NOW + 60_000);
    system.feedManager.flushWarmToCold(NOW + 60_000);

    expect(system.feedManager.getHotSamples(tokenId)).toEqual([]);
    expect(system.feedRepo.upserts).toEqual([]);
    expect(system.signals).toEqual([]);
  });

  it("can populate buffers while scale-in remains on stub feed", async () => {
    const system = createSystem(
      policy({
        enabled: true,
        signalFeed: { ...DEFAULT_EXECUTION_PROFILE_POLICY.signalFeed, enabled: true },
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: false },
      }),
    );

    await system.feedManager.start();
    await system.manager.start();
    await publishSamples(system.bus);

    expect(system.feedManager.getHotSamples(tokenId)).toHaveLength(1);
    expect(system.signals).toEqual([]);
  });

  it("feeds real snapshots into scale-in only when both gates are enabled", async () => {
    const system = createSystem(
      policy({
        enabled: true,
        signalFeed: { ...DEFAULT_EXECUTION_PROFILE_POLICY.signalFeed, enabled: true },
        scaleIn: { enabled: true, useRealFeed: true },
        costCaps: { enabled: false },
      }),
    );

    await system.feedManager.start();
    await system.manager.start();
    await publishSamples(system.bus);

    expect(system.feedManager.getHotSamples(tokenId)).toHaveLength(1);
    expect(system.signals).toHaveLength(1);
    expect(system.signals[0]).toMatchObject({
      side: "buy",
      reason: "scale-in",
      suggestedPrice: 0.102,
    });
  });
});

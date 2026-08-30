import {
  DEFAULT_EXECUTION_PROFILE_POLICY,
  PositionStatus,
  createConditionId,
  createPositionId,
  createTokenId,
  type LadderState,
  type NormalizedMarket,
  type Order,
  type OrderRepository,
  type Position,
  type PositionRepository,
  type ProfileLadderBand,
  type TokenId,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { describe, expect, it, vi } from "vitest";

import {
  ExecutionProfileManager,
  type ExecutionProfileManagerDeps,
} from "../execution-profile-manager.js";
import { ProfileLadderModule } from "../profile-ladder-module.js";
import type { ProfileLadderRepository } from "../profile-ladder-repository.js";
import { InMemoryExecutionProfileStateRepository } from "../state-repository.js";
import type { ExecutionProfilePolicy } from "../types.js";

// Track #44 restart link: existing open positions never replay PositionUpdated at
// startup, so the only path that gives them sell ladders is the two-layer adoption
// chain — ExecutionProfileManager establishes ownership (execution_profile_state)
// first, then ProfileLadderModule reads that ownership to adopt the ladder. This
// suite wires the real manager and the real ladder module together to prove the
// link works on a cold restart (and that ladder adoption strictly depends on it).

const tokenId = createTokenId("restart-adopt-token");
const conditionId = createConditionId("restart-adopt-condition");
const NOW = Date.parse("2026-06-15T00:00:00.000Z");

function policy(
  overrides: {
    adoptExistingPositions?: boolean;
    adoptExistingLadders?: boolean;
  } = {},
): ExecutionProfilePolicy {
  const base = DEFAULT_EXECUTION_PROFILE_POLICY;
  return {
    ...base,
    enabled: true,
    sellLadder: {
      ...base.sellLadder,
      enabled: true,
      adoptExisting: { enabled: overrides.adoptExistingLadders ?? true },
      bands: {
        ...base.sellLadder.bands,
        medium_low: { ...base.sellLadder.bands.medium_low, enabled: true },
      },
    },
    adoptExistingPositions: { enabled: overrides.adoptExistingPositions ?? true },
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("restart-adopt-position"),
    tokenId,
    conditionId,
    side: "buy",
    size: 250,
    avgEntryPrice: 0.1,
    costBasisUsdc: 25,
    currentValueUsdc: 25,
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
    slug: "restart-adopt-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Question?",
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
    bestBid: 0.09,
    bestAsk: 0.11,
    midPrice: 0.1,
    spread: 0.02,
    minOrderSize: 1,
    gammaCreatedAt: null,
    snapshotTs: NOW,
    ...overrides,
  };
}

function makePositionRepo(rows: Position[]): PositionRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn(
      (id) => rows.find((row) => row.tokenId === id && row.status === PositionStatus.Open) ?? null,
    ),
    findOpen: vi.fn(() => rows.filter((row) => row.status === PositionStatus.Open)),
    findDust: vi.fn(() => rows.filter((row) => row.status === PositionStatus.Dust)),
    findAll: vi.fn(() => rows),
    findOpenByEntryStyle: vi.fn(() => []),
    findById: vi.fn(() => null),
    findActiveByTokenId: vi.fn((id) =>
      rows.filter((row) => row.tokenId === id && row.status !== PositionStatus.Closed),
    ),
  } as unknown as PositionRepository;
}

function makeOrderRepo(rows: Order[]): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn(),
    findOpen: vi.fn(() =>
      rows.filter((row) => ["pending", "open", "partially-filled"].includes(row.status)),
    ),
    findByTokenId: vi.fn((id: TokenId) => rows.filter((row) => row.tokenId === id)),
    findRecentByTokenId: vi.fn(() => []),
    findFirstByTokenId: vi.fn(() => null),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn(() => 0),
  } as unknown as OrderRepository;
}

class InMemoryProfileLadderRepository implements ProfileLadderRepository {
  readonly states = new Map<string, LadderState>();

  upsertLadder(state: LadderState): void {
    this.states.set(String(state.tokenId), { ...state, activeRungs: [...state.activeRungs] });
  }

  getLadder(token: TokenId): LadderState | null {
    return this.states.get(String(token)) ?? null;
  }

  findActive(): LadderState[] {
    return [...this.states.values()].filter(
      (state) => state.status !== "closed" && state.status !== "cancelled",
    );
  }

  findByBand(band: ProfileLadderBand): LadderState[] {
    return this.findActive().filter((state) => state.band === band);
  }

  isProfileLadderOwned(token: TokenId): boolean {
    const state = this.states.get(String(token));
    return state != null && state.status !== "closed" && state.status !== "cancelled";
  }

  markClosed(): void {}
  deleteLadder(): void {}

  runInTransaction<T>(fn: () => T): T {
    return fn();
  }
}

function makeManager(
  profilePolicy: ExecutionProfilePolicy,
  deps: Partial<ExecutionProfileManagerDeps>,
) {
  const base: ExecutionProfileManagerDeps = {
    bus: deps.bus ?? new InProcessEventBus(),
    stateRepo: deps.stateRepo ?? new InMemoryExecutionProfileStateRepository(),
    positionRepo: deps.positionRepo ?? makePositionRepo([]),
    orderRepo: deps.orderRepo ?? makeOrderRepo([]),
    policy: () => profilePolicy,
    now: () => NOW,
  };
  return new ExecutionProfileManager(base);
}

function makeLadderModule(
  profilePolicy: ExecutionProfilePolicy,
  args: {
    bus: InProcessEventBus;
    positionRepo: PositionRepository;
    orderRepo: OrderRepository;
    isProfileOwned: (token: TokenId) => boolean;
  },
) {
  const repo = new InMemoryProfileLadderRepository();
  const counters: Array<{ name: string; value?: number; labels?: string }> = [];
  const riskEvents: Array<{ eventType: string; payload: Readonly<Record<string, unknown>> }> = [];
  const module = new ProfileLadderModule({
    bus: args.bus,
    repository: repo,
    policy: () => profilePolicy,
    positionRepo: args.positionRepo,
    orderRepo: args.orderRepo,
    isProfileOwned: args.isProfileOwned,
    runtimeMetrics: {
      writeCounter: (name, value, labels) => {
        counters.push({
          name,
          ...(value === undefined ? {} : { value }),
          ...(labels === undefined ? {} : { labels }),
        });
      },
    },
    riskEvents: { insert: (event) => riskEvents.push(event) },
    now: () => NOW,
  });
  return { repo, counters, riskEvents, module };
}

describe("ProfileLadderModule restart adoption linked to ExecutionProfileManager ownership", () => {
  it("adopts a ladder for a position the manager took ownership of on restart", async () => {
    const profilePolicy = policy();
    const bus = new InProcessEventBus();
    const positionRepo = makePositionRepo([position()]);
    const orderRepo = makeOrderRepo([]);
    const stateRepo = new InMemoryExecutionProfileStateRepository();

    // Layer 1: ownership adoption on cold restart.
    const manager = makeManager(profilePolicy, { bus, positionRepo, orderRepo, stateRepo });
    await manager.start();
    expect(manager.isProfileOwned(tokenId)).toBe(true);

    // Layer 2: ladder adoption, gated on the ownership the manager just established.
    const ladder = makeLadderModule(profilePolicy, {
      bus,
      positionRepo,
      orderRepo,
      isProfileOwned: (token) => manager.isProfileOwned(token),
    });
    await ladder.module.start();
    await bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });
    await ladder.module.adoptExistingLadders();

    expect(ladder.repo.getLadder(tokenId)).toMatchObject({ band: "medium_low", lastMode: "flat" });
    const adopted = ladder.riskEvents.find((event) => event.eventType === "ladder_adopted");
    expect(adopted?.payload).toMatchObject({ source: "adopted", band: "medium_low" });
  });

  it("does not adopt a ladder when manager ownership adoption is disabled", async () => {
    const profilePolicy = policy({ adoptExistingPositions: false });
    const bus = new InProcessEventBus();
    const positionRepo = makePositionRepo([position()]);
    const orderRepo = makeOrderRepo([]);
    const stateRepo = new InMemoryExecutionProfileStateRepository();

    const manager = makeManager(profilePolicy, { bus, positionRepo, orderRepo, stateRepo });
    await manager.start();
    expect(manager.isProfileOwned(tokenId)).toBe(false);

    const ladder = makeLadderModule(profilePolicy, {
      bus,
      positionRepo,
      orderRepo,
      isProfileOwned: (token) => manager.isProfileOwned(token),
    });
    await ladder.module.start();
    await bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });
    await ladder.module.adoptExistingLadders();

    expect(ladder.repo.getLadder(tokenId)).toBeNull();
    const summary = ladder.riskEvents.find((event) => event.eventType === "ladder_adoption_summary")
      ?.payload as Record<string, unknown> | undefined;
    expect(summary).toMatchObject({ adopted_count: 0, skipped_not_profile_owned: 1 });
  });
});

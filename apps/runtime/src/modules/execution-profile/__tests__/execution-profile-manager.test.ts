import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXECUTION_PROFILE_POLICY,
  OrderType,
  PositionStatus,
  createBotRunId,
  createConditionId,
  createOrderId,
  createPositionId,
  createTokenId,
  type ClientOrderId,
  type Order,
  type OrderRepository,
  type Position,
  type PositionRepository,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { S1_LADDER_RULE_ID } from "@krabs/domain";
import { ExecutionProfileManager } from "../execution-profile-manager.js";
import { DEFAULT_PROFILE_HYSTERESIS } from "../profile-resolver.js";
import { InMemoryExecutionProfileStateRepository } from "../state-repository.js";
import type { ExecutionProfilePolicy } from "../types.js";

const tokenId = createTokenId("manager-token");
const conditionId = createConditionId("manager-condition");
const NOW = Date.parse("2026-06-14T00:00:00.000Z");
const DEFAULT_POLICY: ExecutionProfilePolicy = {
  ...DEFAULT_EXECUTION_PROFILE_POLICY,
  enabled: false,
  maxTokensPerCycle: 100,
  qdHandoffThresholdMs: 3_600_000,
  profileHysteresis: DEFAULT_PROFILE_HYSTERESIS,
};

function policy(overrides: Partial<ExecutionProfilePolicy> = {}): ExecutionProfilePolicy {
  return {
    ...DEFAULT_POLICY,
    ...overrides,
    profileHysteresis: {
      ...DEFAULT_POLICY.profileHysteresis,
      ...(overrides.profileHysteresis ?? {}),
    },
    sellLadder: {
      ...DEFAULT_POLICY.sellLadder,
      ...(overrides.sellLadder ?? {}),
    },
    costCaps: {
      ...DEFAULT_POLICY.costCaps,
      ...(overrides.costCaps ?? {}),
    },
    profiles: {
      ...DEFAULT_POLICY.profiles,
      ...(overrides.profiles ?? {}),
    },
    adoptExistingPositions: {
      ...DEFAULT_POLICY.adoptExistingPositions,
      ...(overrides.adoptExistingPositions ?? {}),
    },
    adoptExistingS1Ladders: {
      ...DEFAULT_POLICY.adoptExistingS1Ladders,
      ...(overrides.adoptExistingS1Ladders ?? {}),
    },
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("manager-position"),
    tokenId,
    conditionId,
    side: "buy",
    size: 100,
    avgEntryPrice: 0.12,
    costBasisUsdc: 12,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: PositionStatus.Open,
    entryStyle: "probe",
    openedAt: "2026-06-14T00:00:00.000Z",
    closedAt: null,
    updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    orderId: createOrderId("manager-order"),
    clientOrderId: "manager-client" as ClientOrderId,
    tokenId,
    conditionId,
    side: "sell",
    orderType: OrderType.Gtc,
    postOnly: true,
    price: 0.2,
    size: 10,
    sizeUsdc: 2,
    status: "open",
    exchangeOrderId: "exchange-order",
    signalId: "signal",
    signalReason: "repricing-exit",
    decisionRuleId: S1_LADDER_RULE_ID,
    botRunId: createBotRunId("run"),
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    metadata: { s1: { ladderId: "ladder-1" } },
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
    findDust: vi.fn(() => []),
    findAll: vi.fn(() => rows),
    findOpenByEntryStyle: vi.fn(() => []),
  };
}

function makeOrderRepo(rows: Order[]): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn(),
    findOpen: vi.fn(() =>
      rows.filter((row) => ["pending", "open", "partially-filled"].includes(row.status)),
    ),
    findByTokenId: vi.fn(() => []),
    findRecentByTokenId: vi.fn(() => []),
    findFirstByTokenId: vi.fn(() => null),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn(() => 0),
  } as unknown as OrderRepository;
}

function makeManager(args: {
  profilePolicy: ExecutionProfilePolicy;
  positions?: Position[];
  orders?: Order[];
  repo?: InMemoryExecutionProfileStateRepository;
}): ExecutionProfileManager {
  return new ExecutionProfileManager({
    bus: new InProcessEventBus(),
    stateRepo: args.repo ?? new InMemoryExecutionProfileStateRepository(),
    positionRepo: makePositionRepo(args.positions ?? []),
    orderRepo: makeOrderRepo(args.orders ?? []),
    policy: () => args.profilePolicy,
    now: () => NOW,
  });
}

describe("ExecutionProfileManager", () => {
  it("hydrates existing active state into the ownership cache", async () => {
    const repo = new InMemoryExecutionProfileStateRepository();
    repo.upsertState({
      tokenId,
      conditionId,
      profile: "medium",
      state: "ACCUMULATING",
      assumedAt: "2026-06-14T00:00:00.000Z",
      lastAvgEntry: 0.12,
      lastTransitionAt: "2026-06-14T00:00:00.000Z",
      activeLadderId: null,
      handoffStartedAt: null,
      metadata: null,
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
    });
    const manager = makeManager({ profilePolicy: policy(), repo });

    await manager.start();

    expect(manager.getSnapshot(tokenId)).toMatchObject({
      profile: "medium",
      state: "ACCUMULATING",
    });
    expect(manager.isProfileOwned(tokenId)).toBe(true);
  });

  it("does not adopt generic open positions while sellLadder is disabled", async () => {
    const manager = makeManager({
      profilePolicy: policy({
        enabled: true,
        sellLadder: { enabled: false },
        adoptExistingPositions: { enabled: true },
      }),
      positions: [position()],
    });

    await manager.start();

    expect(manager.getSnapshot(tokenId)).toBeUndefined();
    expect(manager.shouldSuppressLegacySell(tokenId)).toBe(false);
  });

  it("adopts generic open positions only when sellLadder and adoption are both enabled", async () => {
    const manager = makeManager({
      profilePolicy: policy({
        enabled: true,
        sellLadder: { enabled: true },
        adoptExistingPositions: { enabled: true },
      }),
      positions: [position()],
    });

    await manager.start();

    expect(manager.getSnapshot(tokenId)).toMatchObject({ profile: "medium", state: "EXITING" });
    expect(manager.shouldSuppressLegacySell(tokenId)).toBe(true);
  });

  it("adopts active S1_LADDER orders without enabling suppression while sellLadder is disabled", async () => {
    const manager = makeManager({
      profilePolicy: policy({
        enabled: true,
        sellLadder: { enabled: false },
        adoptExistingS1Ladders: { enabled: true },
      }),
      positions: [position({ avgEntryPrice: 0.02 })],
      orders: [order()],
    });

    await manager.start();

    expect(manager.getSnapshot(tokenId)).toMatchObject({
      profile: "cheap",
      state: "EXITING",
      activeLadderId: "ladder-1",
    });
    expect(manager.isProfileOwned(tokenId)).toBe(true);
    expect(manager.shouldSuppressLegacySell(tokenId)).toBe(false);
  });
});

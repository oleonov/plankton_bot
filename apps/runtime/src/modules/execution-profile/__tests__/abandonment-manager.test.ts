import {
  DEFAULT_EXECUTION_PROFILE_POLICY,
  OrderStatus,
  type ClientOrderId,
  createBotRunId,
  createConditionId,
  createOrderId,
  createPositionId,
  createTokenId,
  type ExecutionProfilePolicy,
  type Order,
  type Position,
} from "@krabs/domain";
import { describe, expect, it, vi } from "vitest";

import { AbandonmentManager } from "../abandonment-manager.js";
import { InMemoryExecutionProfileStateRepository } from "../state-repository.js";
import type { ExecutionProfileStateRecord } from "../types.js";

const NOW = 1_800_000_000_000;
const TOKEN = createTokenId("abandon-token");
const TOKEN_2 = createTokenId("abandon-token-2");
const CONDITION = createConditionId("abandon-condition");
const BASE_ISO = "2026-06-15T00:00:00.000Z";

describe("AbandonmentManager", () => {
  it("transitions a qualified probing position to ABANDONED_DORMANT", () => {
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    const stateRepo = new InMemoryExecutionProfileStateRepository([
      state({ metadata: { firstBuyAtMs: NOW - 2_700_000 } }),
    ]);
    const manager = managerWith({ stateRepo, metrics, riskEvents, policy: policy({ enabled: true }) });

    expect(manager.runOnce(NOW)).toBe(1);
    expect(stateRepo.getState(TOKEN)?.state).toBe("ABANDONED_DORMANT");
    expect(metrics.counters).toContainEqual({
      name: "position_abandoned_evaluation",
      value: 1,
      labels: '{"band":"medium_low","reason":"qualified","result":"abandoned"}',
    });
    expect(metrics.counters).toContainEqual({
      name: "position_abandoned_dormant_per_band",
      value: 1,
      labels: '{"band":"medium_low"}',
    });
    expect(riskEvents.inserts).toContainEqual({
      eventType: "position_abandoned_dormant",
      payload: expect.objectContaining({
        tokenId: String(TOKEN),
        band: "medium_low",
        costBasisUsdc: 13.45,
        buyCount: 3,
        ageMs: 2_700_000,
        reason: "qualified",
      }),
    });
  });

  it("does not schedule or evaluate when abandonment is dark disabled", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    const stateRepo = new InMemoryExecutionProfileStateRepository([
      state({ metadata: { firstBuyAtMs: NOW - 2_700_000 } }),
    ]);
    const manager = managerWith({ stateRepo, metrics, riskEvents, policy: DEFAULT_EXECUTION_PROFILE_POLICY });

    manager.start();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(manager.runOnce(NOW)).toBe(0);
    expect(stateRepo.getState(TOKEN)?.state).toBe("PROBING");
    expect(metrics.counters).toHaveLength(0);
    expect(riskEvents.inserts).toHaveLength(0);
    setIntervalSpy.mockRestore();
  });

  it("keeps positions when the resolved band is disabled", () => {
    const stateRepo = new InMemoryExecutionProfileStateRepository([
      state({ metadata: { firstBuyAtMs: NOW - 2_700_000 } }),
    ]);
    const manager = managerWith({
      stateRepo,
      policy: policy({ enabled: true, mediumLowEnabled: false }),
    });

    expect(manager.runOnce(NOW)).toBe(0);
    expect(stateRepo.getState(TOKEN)?.state).toBe("PROBING");
  });

  it("fails closed when firstBuyAtMs is missing", () => {
    const metrics = makeMetrics();
    const stateRepo = new InMemoryExecutionProfileStateRepository([state({ metadata: null })]);
    const manager = managerWith({ stateRepo, metrics, policy: policy({ enabled: true }) });

    expect(manager.runOnce(NOW)).toBe(0);
    expect(stateRepo.getState(TOKEN)?.state).toBe("PROBING");
    expect(metrics.counters).toContainEqual({
      name: "position_abandoned_evaluation",
      value: 1,
      labels: '{"band":"medium_low","reason":"first_buy_missing","result":"kept"}',
    });
  });

  it("blocks abandonment while an active sell order exists", () => {
    const stateRepo = new InMemoryExecutionProfileStateRepository([
      state({ metadata: { firstBuyAtMs: NOW - 2_700_000 } }),
    ]);
    const manager = managerWith({
      stateRepo,
      orders: [order({ side: "sell", status: OrderStatus.Open })],
      policy: policy({ enabled: true }),
    });

    expect(manager.runOnce(NOW)).toBe(0);
    expect(stateRepo.getState(TOKEN)?.state).toBe("PROBING");
  });

  it("sorts by lastTransitionAt and honors maxTokensPerCycle", () => {
    const stateRepo = new InMemoryExecutionProfileStateRepository([
      state({
        tokenId: TOKEN,
        lastTransitionAt: "2026-06-15T00:05:00.000Z",
        metadata: { firstBuyAtMs: NOW - 2_700_000 },
      }),
      state({
        tokenId: TOKEN_2,
        lastTransitionAt: "2026-06-15T00:00:00.000Z",
        metadata: { firstBuyAtMs: NOW - 2_700_000 },
      }),
    ]);
    const manager = managerWith({
      stateRepo,
      positions: [position({ tokenId: TOKEN }), position({ tokenId: TOKEN_2 })],
      policy: policy({ enabled: true, maxTokensPerCycle: 1 }),
    });

    expect(manager.runOnce(NOW)).toBe(1);
    expect(stateRepo.getState(TOKEN)?.state).toBe("PROBING");
    expect(stateRepo.getState(TOKEN_2)?.state).toBe("ABANDONED_DORMANT");
  });
});

function managerWith(overrides: {
  stateRepo?: InMemoryExecutionProfileStateRepository;
  positions?: readonly Position[];
  orders?: readonly Order[];
  policy?: ExecutionProfilePolicy;
  metrics?: ReturnType<typeof makeMetrics>;
  riskEvents?: ReturnType<typeof makeRiskEvents>;
}) {
  const positions = overrides.positions ?? [position()];
  const orders = overrides.orders ?? [];
  return new AbandonmentManager({
    stateRepo: overrides.stateRepo ?? new InMemoryExecutionProfileStateRepository(),
    positionRepo: {
      findByTokenId: vi.fn((tokenId) => positions.find((row) => row.tokenId === tokenId) ?? null),
    },
    orderRepo: {
      findByTokenId: vi.fn((tokenId) => orders.filter((row) => row.tokenId === tokenId)),
    },
    policy: () => overrides.policy ?? policy({ enabled: true }),
    metrics: overrides.metrics,
    riskEvents: overrides.riskEvents,
    now: () => NOW,
  });
}

function makeMetrics() {
  return {
    counters: [] as Array<{ name: string; value: number | undefined; labels: string | undefined }>,
    writeCounter(name: string, value?: number, labels?: string): void {
      this.counters.push({ name, value, labels });
    },
  };
}

function makeRiskEvents() {
  return {
    inserts: [] as Array<{ eventType: string; payload: Record<string, unknown> }>,
    insert(event: { eventType: string; payload: Record<string, unknown> }): void {
      this.inserts.push(event);
    },
  };
}

function policy(options: {
  enabled: boolean;
  mediumLowEnabled?: boolean;
  maxTokensPerCycle?: number;
}): ExecutionProfilePolicy {
  const abandonment = DEFAULT_EXECUTION_PROFILE_POLICY.abandonment;
  return {
    ...DEFAULT_EXECUTION_PROFILE_POLICY,
    abandonment: {
      ...abandonment,
      enabled: options.enabled,
      maxTokensPerCycle: options.maxTokensPerCycle ?? abandonment.maxTokensPerCycle,
      bands: {
        ...abandonment.bands,
        medium_low: {
          ...abandonment.bands.medium_low,
          enabled: options.mediumLowEnabled ?? true,
        },
      },
    },
  };
}

function state(
  overrides: Partial<ExecutionProfileStateRecord> = {},
): ExecutionProfileStateRecord {
  return {
    tokenId: TOKEN,
    conditionId: CONDITION,
    profile: "medium",
    state: "PROBING",
    assumedAt: BASE_ISO,
    lastAvgEntry: 0.1,
    lastTransitionAt: BASE_ISO,
    activeLadderId: null,
    handoffStartedAt: null,
    addCount: 3,
    lastBuyAtMs: NOW - 2_700_000,
    initialProbeSizeUsd: 13.45,
    metadata: null,
    createdAt: BASE_ISO,
    updatedAt: BASE_ISO,
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId(`position-${overrides.tokenId ?? TOKEN}`),
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "buy",
    size: 100,
    avgEntryPrice: 0.1,
    costBasisUsdc: 13.45,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: "open",
    entryStyle: "probe",
    openedAt: BASE_ISO,
    closedAt: null,
    updatedAt: BASE_ISO,
    ...overrides,
  };
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    orderId: createOrderId("abandon-order"),
    clientOrderId: "abandon-client-order" as ClientOrderId,
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "sell",
    orderType: "limit",
    price: 0.12,
    size: 10,
    sizeUsdc: 1.2,
    status: OrderStatus.Open,
    exchangeOrderId: null,
    signalId: null,
    signalReason: null,
    botRunId: createBotRunId("abandon-run"),
    createdAt: BASE_ISO,
    updatedAt: BASE_ISO,
    ...overrides,
  };
}

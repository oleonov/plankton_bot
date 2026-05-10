import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  createBotRunId,
  createConditionId,
  createFillId,
  createOrderId,
  createTokenId,
} from "@plankton/domain";
import type { ClientOrderId } from "@plankton/domain";
import type { AlgoTokenModeState, Fill, Order } from "@plankton/domain";
import { classifyOrderLifetimeMode } from "../order-lifetime-classifier.js";
import { advanceOrderLifetimeTtlStage } from "../order-lifetime-classifier.js";
import { resolveExitOrderLifetime } from "../order-lifetime-ttl.js";
import { OrderLifetimeModule, shouldHoldForBurstRateLimit } from "../order-lifetime-module.js";

const policy = DEFAULT_EXECUTION_POLICY.orderLifetime;
const tokenId = createTokenId("token-1");
const conditionId = createConditionId("condition-1");
const baseMs = Date.parse("2026-05-08T00:00:00.000Z");

describe("order lifetime classifier", () => {
  it("defaults sparse/no-latency existing positions to confirmed PASSIVE", () => {
    const result = classify([], [0]);
    expect(result.state.mode).toBe("PASSIVE");
    expect(result.state.modeStatus).toBe("confirmed");
    expect(result.state.modeConfidence).toBe("low");
  });

  it("marks a single fast fill as a low-confidence BURST candidate", () => {
    const result = classify([0], [20_000]);
    expect(result.state.mode).toBe("BURST");
    expect(result.state.modeStatus).toBe("candidate");
    expect(result.state.modeConfidence).toBe("low");
    expect(result.state.firstFillLatencyMs).toBe(20_000);
  });

  it("does not keep a BURST candidate when the second fill is five minutes later", () => {
    const candidate = classify([0], [20_000]).state;
    const result = classify([0], [20_000, 320_000], candidate);
    expect(result.state.mode).toBe("MIDDLE");
    expect(result.state.modeStatus).toBe("confirmed");
    expect(result.state.medianGapMs).toBe(300_000);
  });

  it("confirms high-confidence BURST on five consistent sub-30s gaps", () => {
    const result = classify([0], [10_000, 30_000, 50_000, 70_000, 90_000]);
    expect(result.state.mode).toBe("BURST");
    expect(result.state.modeStatus).toBe("confirmed");
    expect(result.state.modeConfidence).toBe("high");
  });

  it("classifies long-span slow gaps as high-confidence PASSIVE", () => {
    const result = classify([0], [0, 4 * 60 * 60_000, 8 * 60 * 60_000]);
    expect(result.state.mode).toBe("PASSIVE");
    expect(result.state.modeConfidence).toBe("high");
    expect(result.state.spanMs).toBe(8 * 60 * 60_000);
  });

  it("moves confirmed BURST to MIDDLE only on strong slow evidence", () => {
    const previous = {
      ...state("BURST", "high", "confirmed"),
      modeSince: new Date(baseMs).toISOString(),
    };
    const result = classify([0], [0, 2 * 60_000, 4 * 60_000, 6 * 60_000, 8 * 60_000], previous);
    expect(result.state.mode).toBe("MIDDLE");
    expect(result.transitionReason).toBe("burst_to_middle_strong_slow_evidence");
  });

  it("resets any mode to PASSIVE after 24h without fills", () => {
    const previous = {
      ...state("BURST", "high", "confirmed"),
      lastFillAt: new Date(baseMs - 25 * 60 * 60_000).toISOString(),
    };
    const result = classify(
      [-26 * 60 * 60_000],
      [-26 * 60 * 60_000, -26 * 60 * 60_000 + 20_000],
      previous,
    );
    expect(result.state.mode).toBe("PASSIVE");
    expect(result.transitionReason).toBe("no_fills_24h_reset");
  });

  it("progresses confidence by fill count and mode consistency", () => {
    expect(classify([0], [10_000, 30_000]).state.modeConfidence).toBe("low");
    expect(classify([0], [10_000, 30_000, 50_000]).state.modeConfidence).toBe("medium");
    expect(classify([0], [10_000, 30_000, 50_000, 70_000, 90_000]).state.modeConfidence).toBe(
      "high",
    );
  });

  it("keeps percentile boundaries stable for short fill-gap arrays", () => {
    const result = classify([0], [10_000, 20_000, 40_000]);
    expect(result.state.medianGapMs).toBe(10_000);
    expect(result.state.p75GapMs).toBe(20_000);
  });
});

describe("order lifetime TTL resolver", () => {
  it("caps PASSIVE TTL to 10 minutes inside the 6h resolution window", () => {
    const decision = resolveExitOrderLifetime({
      order: orderAt(0),
      market: { endDate: new Date(baseMs + 5 * 60 * 60_000).toISOString() },
      modeState: state("PASSIVE", "high", "confirmed"),
      policy,
      flatTtlMs: 300_000,
      nowMs: baseMs,
    });
    expect(decision.modeTtlMs).toBe(policy.passive.highTtlMs);
    expect(decision.effectiveTtlMs).toBe(policy.resolutionExitTtlCapMs);
    expect(decision.resolutionCapApplied).toBe(true);
  });

  it("leaves BURST TTL unchanged when resolution cap is longer than mode TTL", () => {
    const decision = resolveExitOrderLifetime({
      order: orderAt(0),
      market: { endDate: new Date(baseMs + 5 * 60 * 60_000).toISOString() },
      modeState: state("BURST", "low", "candidate"),
      policy,
      flatTtlMs: 300_000,
      nowMs: baseMs,
    });
    expect(decision.modeTtlMs).toBe(policy.burst.lowTtlMs);
    expect(decision.effectiveTtlMs).toBe(policy.burst.lowTtlMs);
    expect(decision.resolutionCapApplied).toBe(false);
  });

  it("stops exit orders inside the final resolution hour", () => {
    const decision = resolveExitOrderLifetime({
      order: orderAt(0),
      market: { endDate: new Date(baseMs + 30 * 60_000).toISOString() },
      modeState: state("PASSIVE", "low", "confirmed"),
      policy,
      flatTtlMs: 300_000,
      nowMs: baseMs,
    });
    expect(decision.wouldCancelUnderMode).toBe(true);
    expect(decision.cancelReason).toBe("resolution_stop_window");
  });

  it("never returns a TTL beyond end_date minus safety buffer", () => {
    const decision = resolveExitOrderLifetime({
      order: orderAt(0),
      market: { endDate: new Date(baseMs + 9 * 60 * 60_000).toISOString() },
      modeState: state("PASSIVE", "high", "confirmed"),
      policy,
      flatTtlMs: 300_000,
      nowMs: baseMs,
    });
    expect(decision.effectiveTtlMs).toBeLessThanOrEqual(9 * 60 * 60_000 - policy.safetyBufferMs);
  });

  it("keeps normal TTL cancellation reason when end_date safety cap is not binding", () => {
    const decision = resolveExitOrderLifetime({
      order: orderAt(-policy.burst.lowTtlMs - 1),
      market: { endDate: new Date(baseMs + 7 * 60 * 60_000).toISOString() },
      modeState: state("BURST", "low", "candidate"),
      policy,
      flatTtlMs: 300_000,
      nowMs: baseMs,
    });
    expect(decision.resolutionCapApplied).toBe(false);
    expect(decision.wouldCancelUnderMode).toBe(true);
    expect(decision.cancelReason).toBe("ttl_exceeded");
  });

  it("uses each mode confidence TTL before resolution caps", () => {
    expect(ttlFor("BURST", "low")).toBe(policy.burst.lowTtlMs);
    expect(ttlFor("BURST", "medium")).toBe(policy.burst.mediumTtlMs);
    expect(ttlFor("BURST", "high")).toBe(policy.burst.highTtlMs);
    expect(ttlFor("MIDDLE", "low")).toBe(policy.middle.lowTtlMs);
    expect(ttlFor("MIDDLE", "medium")).toBe(policy.middle.mediumTtlMs);
    expect(ttlFor("MIDDLE", "high")).toBe(policy.middle.highTtlMs);
    expect(ttlFor("PASSIVE", "low")).toBe(policy.passive.lowTtlMs);
    expect(ttlFor("PASSIVE", "medium")).toBe(policy.passive.mediumTtlMs);
    expect(ttlFor("PASSIVE", "high")).toBe(policy.passive.highTtlMs);
  });

  it("uses the PASSIVE stage-2 TTL as the six-hour upper retry band", () => {
    const decision = resolveExitOrderLifetime({
      order: orderAt(0),
      market: null,
      modeState: { ...state("PASSIVE", "low", "confirmed"), ttlStage: 2 },
      policy,
      flatTtlMs: 300_000,
      nowMs: baseMs,
    });

    expect(policy.passive.lowTtlMs).toBe(2 * 60 * 60_000);
    expect(policy.passive.mediumTtlMs).toBe(4 * 60 * 60_000);
    expect(policy.passive.highTtlMs).toBe(6 * 60 * 60_000);
    expect(decision.modeTtlMs).toBe(6 * 60 * 60_000);
  });

  it("defaults missing mode state to PASSIVE low TTL while enforcement is enabled", () => {
    const decision = resolveExitOrderLifetime({
      order: orderAt(0),
      market: null,
      modeState: null,
      policy,
      flatTtlMs: 300_000,
      nowMs: baseMs,
    });
    expect(decision.mode).toBe("PASSIVE");
    expect(decision.confidence).toBe("low");
    expect(decision.effectiveTtlMs).toBe(policy.passive.lowTtlMs);
  });

  it("uses flat TTL when order lifetime is disabled", () => {
    const disabled = { ...policy, enabled: false };
    const decision = resolveExitOrderLifetime({
      order: orderAt(-400_000),
      market: null,
      modeState: state("PASSIVE", "high", "confirmed"),
      policy: disabled,
      flatTtlMs: 300_000,
      nowMs: baseMs,
    });
    expect(decision.effectiveTtlMs).toBe(300_000);
    expect(decision.wouldCancelUnderMode).toBe(false);
    expect(decision.cancelReason).toBeNull();
  });
});

describe("order lifetime relayer cap", () => {
  it("holds BURST replacements when the relayer submit budget is exhausted", () => {
    const decision = {
      ...resolveExitOrderLifetime({
        order: orderAt(-policy.burst.lowTtlMs - 1),
        market: null,
        modeState: state("BURST", "low", "candidate"),
        policy,
        flatTtlMs: 300_000,
        nowMs: baseMs,
      }),
      wouldCancelUnderMode: true,
    };
    const recentSubmits = Array.from(
      { length: policy.relayerSubmitBudgetPerMinute },
      (_, index) => baseMs - index * 1_000,
    );
    expect(shouldHoldForBurstRateLimit(decision, policy, recentSubmits, baseMs)).toBe(true);
  });

  it("does not rate-limit non-BURST TTL decisions", () => {
    const decision = resolveExitOrderLifetime({
      order: orderAt(-policy.passive.lowTtlMs - 1),
      market: null,
      modeState: state("PASSIVE", "low", "confirmed"),
      policy,
      flatTtlMs: 300_000,
      nowMs: baseMs,
    });
    const recentSubmits = Array.from(
      { length: policy.relayerSubmitBudgetPerMinute },
      (_, index) => baseMs - index * 1_000,
    );
    expect(shouldHoldForBurstRateLimit(decision, policy, recentSubmits, baseMs)).toBe(false);
  });
});

describe("order lifetime TTL stage advancement", () => {
  it.each([
    ["PASSIVE", 0, 1],
    ["PASSIVE", 1, 2],
    ["PASSIVE", 2, 2],
    ["MIDDLE", 0, 1],
    ["MIDDLE", 1, 2],
    ["BURST", 0, 0],
    ["BURST", 2, 0],
  ] as const)("advances %s stage %s to %s", (mode, currentStage, expectedStage) => {
    const next = advanceOrderLifetimeTtlStage(
      {
        ...state(mode, "low", mode === "BURST" ? "candidate" : "confirmed"),
        ttlStage: currentStage,
      },
      policy,
      baseMs + 1_000,
    );
    expect(next.ttlStage).toBe(expectedStage);
  });
});

describe("order lifetime persistence guards", () => {
  it("updates lastOrderAt on OrderPlaced without loading full fill/order history", async () => {
    const bus = fakeBus();
    const savedStates: AlgoTokenModeState[] = [];
    let current = state("PASSIVE", "low", "confirmed");
    const mod = new OrderLifetimeModule({
      bus: bus as never,
      fillRepo: {
        findByTokenId: () => {
          throw new Error("full fill scan should not run on OrderPlaced");
        },
      } as never,
      orderRepo: {
        findByTokenId: () => {
          throw new Error("full order scan should not run on OrderPlaced");
        },
        findOpen: () => [],
        findRecentBySignalReasons: () => [],
      } as never,
      marketRepo: fakeMarketRepo(),
      positionRepo: fakePositionRepo(),
      modeStateRepo: {
        get: () => current,
        upsert: (next) => {
          current = next;
          savedStates.push(next);
        },
        delete: () => {},
        findAll: () => [],
      },
      riskEventRepo: fakeRiskEventRepo(),
      runtimeMetrics: fakeMetrics(),
      policy: () => policy,
      log: fakeLogger(),
    });

    await mod.start();
    await bus.publish("OrderPlaced", {
      tokenId,
      conditionId,
      signalReason: "repricing-exit",
      timestamp: baseMs + 12_345,
    } as never);
    await mod.stop();

    const savedState = savedStates.at(-1);
    expect(savedState?.lastOrderAt).toBe(new Date(baseMs + 12_345).toISOString());
    expect(savedState?.orderCountWindow).toBe(1);
  });

  it("hydrates recent exit submits on startup for BURST placement limiting", async () => {
    const bus = fakeBus();
    const budget = policy.relayerSubmitBudgetPerMinute;
    const recentExitOrders = Array.from({ length: budget }, (_, index) => orderAt(-index * 1_000));
    const mod = new OrderLifetimeModule({
      bus: bus as never,
      fillRepo: fakeFillRepo(),
      orderRepo: {
        findByTokenId: () => [],
        findOpen: () => [],
        findRecentBySignalReasons: () => recentExitOrders,
      } as never,
      marketRepo: fakeMarketRepo(),
      positionRepo: fakePositionRepo(),
      modeStateRepo: {
        get: () => state("BURST", "high", "confirmed"),
        upsert: () => {},
        delete: () => {},
        findAll: () => [],
      },
      riskEventRepo: fakeRiskEventRepo(),
      runtimeMetrics: fakeMetrics(),
      policy: () => policy,
      log: fakeLogger(),
    });

    await mod.start();
    const decision = mod.canPlaceExitOrder(tokenId, baseMs);
    await mod.stop();

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("order-lifetime-burst-rate-limit");
  });

  it("resets persisted mode to PASSIVE when a position closes", async () => {
    const bus = fakeBus();
    const savedStates: AlgoTokenModeState[] = [];
    let current = state("BURST", "high", "confirmed");
    const mod = new OrderLifetimeModule({
      bus: bus as never,
      fillRepo: fakeFillRepo(),
      orderRepo: fakeOrderRepo(),
      marketRepo: fakeMarketRepo(),
      positionRepo: fakePositionRepo(),
      modeStateRepo: {
        get: () => current,
        upsert: (next) => {
          current = next;
          savedStates.push(next);
        },
        delete: () => {},
        findAll: () => [],
      },
      riskEventRepo: fakeRiskEventRepo(),
      runtimeMetrics: fakeMetrics(),
      policy: () => policy,
      log: fakeLogger(),
    });

    await mod.start();
    await bus.publish("PositionUpdated", {
      position: { tokenId, status: "closed" },
      timestamp: baseMs,
    } as never);
    await mod.stop();

    const savedState = savedStates.at(-1);
    expect(savedState?.mode).toBe("PASSIVE");
    expect(savedState?.resetReason).toBe("position_closed");
  });

  it("resets persisted mode to PASSIVE when a market resolves", async () => {
    const bus = fakeBus();
    const savedStates: AlgoTokenModeState[] = [];
    let current = state("MIDDLE", "medium", "confirmed");
    const mod = new OrderLifetimeModule({
      bus: bus as never,
      fillRepo: fakeFillRepo(),
      orderRepo: fakeOrderRepo(),
      marketRepo: fakeMarketRepo(),
      positionRepo: fakePositionRepo(),
      modeStateRepo: {
        get: () => current,
        upsert: (next) => {
          current = next;
          savedStates.push(next);
        },
        delete: () => {},
        findAll: () => [],
      },
      riskEventRepo: fakeRiskEventRepo(),
      runtimeMetrics: fakeMetrics(),
      policy: () => policy,
      log: fakeLogger(),
    });

    await mod.start();
    await bus.publish("MarketResolved", {
      tokenIds: [tokenId],
      timestamp: baseMs,
    } as never);
    await mod.stop();

    const savedState = savedStates.at(-1);
    expect(savedState?.mode).toBe("PASSIVE");
    expect(savedState?.resetReason).toBe("market_resolved");
  });

  it("logs one risk event when non-BURST transition logging is suppressed", async () => {
    const bus = fakeBus();
    const riskEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    let current: AlgoTokenModeState = {
      ...state("MIDDLE", "medium", "confirmed"),
      transitionCountDay: policy.maxTransitionEventsPerTokenPerDay,
      transitionDay: new Date(baseMs).toISOString().slice(0, 10),
    };
    const mod = new OrderLifetimeModule({
      bus: bus as never,
      fillRepo: fakeFillRepo(),
      orderRepo: fakeOrderRepo(),
      marketRepo: fakeMarketRepo(),
      positionRepo: fakePositionRepo(),
      modeStateRepo: {
        get: () => current,
        upsert: (next) => {
          current = next;
        },
        delete: () => {},
        findAll: () => [],
      },
      riskEventRepo: {
        insert: (event) => riskEvents.push(event),
        countSince: () => 0,
      },
      runtimeMetrics: fakeMetrics(),
      policy: () => policy,
      log: fakeLogger(),
    });

    await mod.start();
    await bus.publish("FillReceived", {
      tokenId,
      conditionId,
      timestamp: baseMs,
    } as never);
    await mod.stop();

    expect(riskEvents.map((event) => event.eventType)).toContain(
      "order_lifetime_transition_storm_suppressed",
    );
  });

  it("falls back to PASSIVE and logs a risk event for a corrupted mode row", () => {
    const riskEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    const savedStates: AlgoTokenModeState[] = [];
    const corrupted = {
      ...state("BURST", "high", "confirmed"),
      mode: "FAST",
    } as unknown as AlgoTokenModeState;
    const mod = new OrderLifetimeModule({
      bus: fakeBus() as never,
      fillRepo: fakeFillRepo(),
      orderRepo: fakeOrderRepo(),
      marketRepo: fakeMarketRepo(),
      positionRepo: fakePositionRepo(),
      modeStateRepo: {
        get: () => corrupted,
        upsert: (next) => {
          savedStates.push(next);
        },
        delete: () => {},
        findAll: () => [],
      },
      riskEventRepo: {
        insert: (event) => riskEvents.push(event),
        countSince: () => 0,
      },
      runtimeMetrics: fakeMetrics(),
      policy: () => policy,
      log: fakeLogger(),
    });

    mod.resolveExitOrder(orderAt(0), null, 300_000, baseMs);

    expect(
      riskEvents.some((event) => event.eventType === "order_lifetime_corrupt_mode_state"),
    ).toBe(true);
    const savedState = savedStates.at(-1);
    expect(savedState?.mode).toBe("PASSIVE");
    expect(savedState?.resetReason).toBe("corrupt_mode_state");
  });
});

function ttlFor(
  mode: AlgoTokenModeState["mode"],
  confidence: AlgoTokenModeState["modeConfidence"],
): number {
  return resolveExitOrderLifetime({
    order: orderAt(0),
    market: null,
    modeState: state(mode, confidence, "confirmed"),
    policy,
    flatTtlMs: 300_000,
    nowMs: baseMs,
  }).effectiveTtlMs;
}

function classify(
  orderOffsetsMs: number[],
  fillOffsetsMs: number[],
  previous?: AlgoTokenModeState,
) {
  return classifyOrderLifetimeMode({
    tokenId,
    conditionId,
    outcomeIndex: 0,
    fills: fillOffsetsMs.map(fillAt),
    orders: orderOffsetsMs.map(orderAt),
    market: { active: true, endDate: null },
    previous: previous ?? null,
    policy,
    nowMs: baseMs + 60 * 60_000,
  });
}

function fillAt(offsetMs: number): Fill {
  return {
    fillId: createFillId(`fill-${offsetMs}`),
    orderId: createOrderId(`order-${offsetMs}`),
    tokenId,
    conditionId,
    side: "buy",
    price: 0.1,
    size: 1,
    sizeUsdc: 0.1,
    liquidityRole: "maker",
    fee: 0,
    feeRateBps: 0,
    filledAt: new Date(baseMs + offsetMs).toISOString(),
  };
}

function orderAt(offsetMs: number): Order {
  return {
    orderId: createOrderId(`order-${offsetMs}`),
    clientOrderId: `client-${offsetMs}` as ClientOrderId,
    tokenId,
    conditionId,
    side: "sell",
    orderType: "GTC",
    postOnly: true,
    price: 0.1,
    size: 1,
    sizeUsdc: 0.1,
    status: "open",
    exchangeOrderId: null,
    signalId: null,
    signalReason: "repricing-exit",
    botRunId: createBotRunId("run-1"),
    createdAt: new Date(baseMs + offsetMs).toISOString(),
    updatedAt: new Date(baseMs + offsetMs).toISOString(),
  };
}

function state(
  mode: AlgoTokenModeState["mode"],
  confidence: AlgoTokenModeState["modeConfidence"],
  status: AlgoTokenModeState["modeStatus"],
): AlgoTokenModeState {
  const now = new Date(baseMs).toISOString();
  return {
    tokenId,
    conditionId,
    outcomeIndex: 0,
    mode,
    modeConfidence: confidence,
    modeStatus: status,
    modeSince: now,
    modeAssessedAt: now,
    ttlStage: 0,
    lastFillAt: now,
    lastOrderAt: now,
    lastStaleCancelAt: null,
    fillCountWindow: 0,
    orderCountWindow: 0,
    firstFillLatencyMs: null,
    medianGapMs: null,
    p75GapMs: null,
    spanMs: null,
    lastFillTimestampsJson: null,
    transitionCountDay: 0,
    transitionDay: now.slice(0, 10),
    resetReason: null,
    updatedAt: now,
  };
}

function fakeBus(): {
  publish: (type: string, event: unknown) => Promise<void>;
  subscribe: (type: string, handler: (event: unknown) => Promise<void> | void) => () => void;
  drain: () => Promise<void>;
} {
  const handlers = new Map<string, Array<(event: unknown) => Promise<void> | void>>();
  return {
    publish: async (type: string, event: unknown) => {
      for (const handler of handlers.get(type) ?? []) await handler(event);
    },
    subscribe: (type: string, handler: (event: unknown) => Promise<void> | void) => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return () => {
        handlers.set(
          type,
          (handlers.get(type) ?? []).filter((candidate) => candidate !== handler),
        );
      };
    },
    drain: async () => {},
  };
}

function fakeFillRepo() {
  return {
    findByTokenId: () => [],
  } as never;
}

function fakeOrderRepo() {
  return {
    findByTokenId: () => [],
    findOpen: () => [],
  } as never;
}

function fakeMarketRepo() {
  return {
    findByTokenId: () => ({ conditionId, outcomeIndex: 0, active: true, endDate: null }),
  } as never;
}

function fakePositionRepo() {
  return { findOpen: () => [] } as never;
}

function fakeRiskEventRepo() {
  return {
    insert: () => {},
    countSince: () => 0,
  } as never;
}

function fakeMetrics() {
  return { writeLatest: () => {}, writeEvent: () => {} } as never;
}

function fakeLogger() {
  const logger = {
    child: () => logger,
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  return logger as never;
}

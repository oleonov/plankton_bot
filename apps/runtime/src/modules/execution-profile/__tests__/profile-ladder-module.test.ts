import {
  DEFAULT_EXECUTION_PROFILE_POLICY,
  LiquidityRole,
  PositionStatus,
  createConditionId,
  createFillId,
  createPositionId,
  createOrderId,
  createTokenId,
  type ClientOrderId,
  type LadderState,
  type NormalizedMarket,
  type PlaceOrderCommand,
  type Position,
  type RuntimeEventMap,
  type TokenId,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { describe, expect, it } from "vitest";

import { ProfileLadderModule } from "../profile-ladder-module.js";
import type { ProfileLadderRepository } from "../profile-ladder-repository.js";
import type { ExecutionProfilePolicy } from "../types.js";

const tokenId = createTokenId("profile-ladder-token");
const conditionId = createConditionId("profile-ladder-condition");
const NOW = Date.parse("2026-06-15T00:00:00.000Z");

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

  findByBand(band: LadderState["band"]): LadderState[] {
    return this.findActive().filter((state) => state.band === band);
  }

  isProfileLadderOwned(token: TokenId): boolean {
    const state = this.states.get(String(token));
    return state != null && state.status !== "closed" && state.status !== "cancelled";
  }

  markClosed(token: TokenId, reason: string, closedAtMs = NOW): void {
    const state = this.states.get(String(token));
    if (state == null) return;
    this.states.set(String(token), {
      ...state,
      status: "closed",
      closedAtMs,
      updatedAtMs: closedAtMs,
      metadataJson: JSON.stringify({ ...JSON.parse(state.metadataJson), closeReason: reason }),
    });
  }

  deleteLadder(token: TokenId): void {
    const state = this.states.get(String(token));
    if (state == null) return;
    this.states.set(String(token), {
      ...state,
      status: "cancelled",
      closedAtMs: NOW,
      updatedAtMs: NOW,
      metadataJson: JSON.stringify({
        ...JSON.parse(state.metadataJson),
        closeReason: "delete_ladder",
      }),
    });
  }

  runInTransaction<T>(fn: () => T): T {
    return fn();
  }
}

function policy(
  overrides: Partial<ExecutionProfilePolicy["sellLadder"]> = {},
): ExecutionProfilePolicy {
  const sellLadder = {
    ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder,
    enabled: true,
    bands: {
      ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands,
      medium_low: {
        ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.medium_low,
        enabled: true,
      },
    },
    ...overrides,
  };
  return {
    ...DEFAULT_EXECUTION_PROFILE_POLICY,
    enabled: true,
    sellLadder,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("profile-ladder-position"),
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
    slug: "profile-ladder-market",
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

function ladderState(overrides: Partial<LadderState> = {}): LadderState {
  return {
    tokenId,
    conditionId,
    ladderId: "profile_ladder_existing",
    band: "medium_low",
    phase: 1,
    status: "active",
    activeRungs: [
      {
        rungIndex: 0,
        price: 0.11,
        sizeShares: 100,
        notionalUsd: 11,
        multiplier: 1.1,
        sizingFraction: 1,
        lifecycle: "placed",
        orderId: String(createOrderId("profile-ladder-order")),
        filledSizeShares: 0,
      },
    ],
    filledRungs: [],
    lastAvgEntry: 0.1,
    lastCostBasisUsdc: 25,
    lastMode: "flat",
    lastBboReferenceJson: JSON.stringify({ bestBid: 0.09, bestAsk: 0.11 }),
    lastRebuildAtMs: NOW,
    lastFillAtMs: null,
    staleCheckedAtMs: null,
    qdHandoffAtMs: null,
    closedAtMs: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    metadataJson: "{}",
    ...overrides,
  };
}

function fill(
  overrides: Partial<RuntimeEventMap["FillReceived"]> = {},
): RuntimeEventMap["FillReceived"] {
  return {
    fillId: createFillId("profile-ladder-fill"),
    orderId: createOrderId("profile-ladder-order"),
    clientOrderId: "profile-ladder-client-order" as ClientOrderId,
    tokenId,
    conditionId,
    side: "sell",
    price: 0.11,
    size: 25,
    sizeUsdc: 2.75,
    liquidityRole: LiquidityRole.Maker,
    fee: 0,
    feeRateBps: 0,
    signalReason: "profile-ladder-exit",
    timestamp: NOW + 1_000,
    ...overrides,
  };
}

function setup(
  profilePolicy = policy(),
  overrides: {
    modeReader?: { getMode: (token: TokenId) => "up" | "flat" | "avg_down" | null };
  } = {},
) {
  const bus = new InProcessEventBus();
  const repo = new InMemoryProfileLadderRepository();
  const counters: Array<{ name: string; value?: number; labels?: string }> = [];
  const riskEvents: Array<{ eventType: string; payload: Readonly<Record<string, unknown>> }> = [];
  const orders: PlaceOrderCommand[] = [];
  const cancels: string[] = [];
  bus.subscribe("PlaceOrderRequested", async ({ command }) => {
    orders.push(command);
  });
  bus.subscribe("CancelOrderRequested", async ({ command }) => {
    cancels.push(String(command.orderId));
  });
  const module = new ProfileLadderModule({
    bus,
    repository: repo,
    policy: () => profilePolicy,
    ...overrides,
    runtimeMetrics: {
      writeCounter: (name, value, labels) => {
        counters.push({
          name,
          ...(value === undefined ? {} : { value }),
          ...(labels === undefined ? {} : { labels }),
        });
      },
    },
    riskEvents: {
      insert: (event) => riskEvents.push(event),
    },
    now: () => NOW,
  });
  return { bus, repo, counters, riskEvents, orders, cancels, module };
}

describe("ProfileLadderModule", () => {
  it("start is a no-op when sell ladder is disabled", async () => {
    const ctx = setup({ ...policy(), sellLadder: { ...policy().sellLadder, enabled: false } });
    await ctx.module.start();

    await ctx.bus.publish("PositionUpdated", {
      position: position({ status: PositionStatus.Closed }),
    });

    expect(ctx.repo.states.size).toBe(0);
    expect(ctx.orders).toHaveLength(0);
    expect(ctx.counters).toHaveLength(0);
  });

  it("does not place or persist ladders when all bands are disabled", async () => {
    const ctx = setup(
      policy({
        enabled: true,
        bands: DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands,
      }),
    );

    await ctx.module.placeLadder(position({ avgEntryPrice: 0.1 }), market());

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.states.size).toBe(0);
    expect(ctx.counters).toHaveLength(0);
    expect(ctx.riskEvents).toHaveLength(0);
  });

  it("places ladders only for the activated medium_low band", async () => {
    const ctx = setup();
    const mediumLowToken = createTokenId("profile-ladder-medium-low");
    const mediumHighToken = createTokenId("profile-ladder-medium-high");

    await ctx.module.placeLadder(
      position({ tokenId: mediumLowToken, avgEntryPrice: 0.1 }),
      market({ tokenId: mediumLowToken }),
    );
    await ctx.module.placeLadder(
      position({ tokenId: mediumHighToken, avgEntryPrice: 0.2 }),
      market({ tokenId: mediumHighToken }),
    );

    expect(ctx.orders).toHaveLength(4);
    expect(ctx.repo.getLadder(mediumLowToken)?.band).toBe("medium_low");
    expect(ctx.repo.getLadder(mediumHighToken)).toBeNull();
    expect(ctx.orders.every((order) => order.metadata?.source === "profile_ladder")).toBe(true);
  });

  it("respects multiple activated bands while keeping inactive bands dark", async () => {
    const ctx = setup(
      policy({
        bands: {
          ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands,
          medium_low: {
            ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.medium_low,
            enabled: true,
          },
          medium_high: {
            ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.medium_high,
            enabled: true,
          },
        },
      }),
    );
    const mediumLowToken = createTokenId("profile-ladder-medium-low-multi");
    const mediumHighToken = createTokenId("profile-ladder-medium-high-multi");
    const cheapToken = createTokenId("profile-ladder-cheap-disabled");

    await ctx.module.placeLadder(
      position({ tokenId: mediumLowToken, avgEntryPrice: 0.1 }),
      market({ tokenId: mediumLowToken }),
    );
    await ctx.module.placeLadder(
      position({ tokenId: mediumHighToken, avgEntryPrice: 0.2 }),
      market({ tokenId: mediumHighToken }),
    );
    await ctx.module.placeLadder(
      position({ tokenId: cheapToken, avgEntryPrice: 0.04 }),
      market({ tokenId: cheapToken }),
    );

    expect(ctx.repo.getLadder(mediumLowToken)?.band).toBe("medium_low");
    expect(ctx.repo.getLadder(mediumHighToken)?.band).toBe("medium_high");
    expect(ctx.repo.getLadder(cheapToken)).toBeNull();
    expect(ctx.orders).toHaveLength(7);
    expect(ctx.counters.filter((counter) => counter.name === "profile_ladder_placed")).toHaveLength(
      2,
    );
  });

  it("subscribes to lifecycle events when enabled and cancels on close", async () => {
    const ctx = setup();
    ctx.repo.upsertLadder(ladderState());

    await ctx.module.start();
    await ctx.bus.publish("PositionUpdated", {
      position: position({ status: PositionStatus.Closed }),
    });

    expect(ctx.repo.getLadder(tokenId)).toMatchObject({
      status: "cancelled",
      closedAtMs: NOW,
    });
    expect(ctx.cancels).toEqual(["profile-ladder-order"]);
  });

  it("places a ladder from PositionUpdated when the band is active and market is cached", async () => {
    const ctx = setup();
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market()],
      timestamp: NOW,
    });
    await ctx.bus.publish("PositionUpdated", {
      position: position(),
    });

    expect(ctx.orders).toHaveLength(4);
    expect(ctx.repo.getLadder(tokenId)?.band).toBe("medium_low");
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_placed",
      value: 1,
      labels: '{"band":"medium_low"}',
    });
  });

  it("rebuilds after a scale-in BUY fill when PositionUpdated carries the new basis", async () => {
    const ctx = setup();
    ctx.repo.upsertLadder(ladderState());
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market()],
      timestamp: NOW,
    });
    await ctx.bus.publish("FillReceived", fill({ side: "buy", price: 0.12, size: 50 }));
    await ctx.bus.publish("PositionUpdated", {
      position: position({
        avgEntryPrice: 0.104,
        costBasisUsdc: 31,
        size: 300,
      }),
    });

    expect(ctx.orders).toHaveLength(4);
    expect(ctx.repo.getLadder(tokenId)).toMatchObject({
      lastAvgEntry: 0.104,
      lastCostBasisUsdc: 31,
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_rebuilt",
      value: 1,
      labels: '{"band":"medium_low","reason":"scale_in"}',
    });
  });

  it("rebuilds on BBO move and respects the 30-minute cooldown", async () => {
    const ctx = setup();
    ctx.repo.upsertLadder(ladderState());
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.08, bestAsk: 0.1, midPrice: 0.09 })],
      timestamp: NOW,
    });
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.07, bestAsk: 0.09, midPrice: 0.08 })],
      timestamp: NOW + 1_000,
    });

    expect(ctx.orders).toHaveLength(4);
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_rebuilt",
      value: 1,
      labels: '{"band":"medium_low","reason":"bbo_strong"}',
    });
  });

  it("places ladder orders with calibrated rung count and metadata", async () => {
    const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });

    await ctx.module.placeLadder(position(), market());

    expect(ctx.orders).toHaveLength(4);
    expect(ctx.orders.map((order) => order.price)).toEqual([0.11, 0.13, 0.155, 0.165]);
    expect(ctx.orders.map((order) => order.size)).toEqual([95, 60, 50, 45]);
    expect(ctx.orders[0]).toMatchObject({
      source: "strategy",
      side: "sell",
      orderType: "GTC",
      postOnly: true,
      decisionRuleId: "PROFILE_LADDER",
      metadata: { source: "profile_ladder" },
    });
    expect(ctx.repo.getLadder(tokenId)).toMatchObject({
      band: "medium_low",
      status: "active",
      activeRungs: expect.arrayContaining([expect.objectContaining({ lifecycle: "planned" })]),
    });
  });

  it("passes UP mode from the mode reader into LadderBuilder", async () => {
    const ctx = setup(policy(), { modeReader: { getMode: () => "up" } });

    await ctx.module.placeLadder(position(), market());

    expect(ctx.orders.map((order) => order.price)).toEqual([0.105, 0.124, 0.148, 0.157]);
    expect(ctx.repo.getLadder(tokenId)?.lastMode).toBe("up");
  });

  it("passes AVG_DOWN mode from the mode reader into LadderBuilder", async () => {
    const ctx = setup(policy(), { modeReader: { getMode: () => "avg_down" } });

    await ctx.module.placeLadder(position(), market());

    expect(ctx.orders.map((order) => order.price)).toEqual([0.165, 0.195, 0.233, 0.248]);
    expect(ctx.repo.getLadder(tokenId)?.lastMode).toBe("avg_down");
  });

  it("falls back to flat and counts missing mode when the mode reader has no state", async () => {
    const ctx = setup(policy(), { modeReader: { getMode: () => null } });

    await ctx.module.placeLadder(position(), market());

    expect(ctx.orders.map((order) => order.price)).toEqual([0.11, 0.13, 0.155, 0.165]);
    expect(ctx.repo.getLadder(tokenId)?.lastMode).toBe("flat");
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_mode_missing",
      value: 1,
    });
  });

  it("backfills rung orderId from OrderPlaced for profile-ladder commands", async () => {
    const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
    await ctx.module.start();
    await ctx.module.placeLadder(position(), market());

    await ctx.bus.publish("OrderPlaced", {
      commandId: ctx.orders[0]!.commandId,
      clientOrderId: ctx.orders[0]!.clientOrderId,
      orderId: createOrderId("profile-ladder-backfilled-order"),
      tokenId,
      conditionId,
      side: "sell",
      price: ctx.orders[0]!.price,
      size: ctx.orders[0]!.size,
      orderType: "GTC",
      signalReason: "profile-ladder-exit",
      timestamp: NOW + 1_000,
    });

    expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]?.orderId).toBe(
      "profile-ladder-backfilled-order",
    );
  });

  it("updates rung fill state after OrderPlaced backfills the exchange orderId", async () => {
    const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
    const orderId = createOrderId("profile-ladder-filled-order");
    await ctx.module.start();
    await ctx.module.placeLadder(position(), market());
    await ctx.bus.publish("OrderPlaced", {
      commandId: ctx.orders[0]!.commandId,
      clientOrderId: ctx.orders[0]!.clientOrderId,
      orderId,
      tokenId,
      conditionId,
      side: "sell",
      price: ctx.orders[0]!.price,
      size: ctx.orders[0]!.size,
      orderType: "GTC",
      signalReason: "profile-ladder-exit",
      timestamp: NOW + 1_000,
    });

    await ctx.bus.publish("FillReceived", fill({ orderId, size: 25 }));

    expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
      orderId: "profile-ladder-filled-order",
      filledSizeShares: 25,
      lifecycle: "partially_filled",
    });
  });

  it("ignores FillReceived for non-ladder orders", async () => {
    const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
    await ctx.module.start();
    await ctx.module.placeLadder(position(), market());

    await ctx.bus.publish(
      "FillReceived",
      fill({ orderId: createOrderId("not-profile-ladder-order"), size: 25 }),
    );

    expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
      orderId: null,
      filledSizeShares: 0,
      lifecycle: "planned",
    });
  });

  it("rebuilds unconditionally for scale-in and cooldown-gates BBO rebuilds", async () => {
    const ctx = setup();

    await ctx.module.rebuildLadder(position(), market(), "scale_in");
    await ctx.module.rebuildLadder(position(), market(), "bbo_major");
    await ctx.module.rebuildLadder(position(), market(), "bbo_major");

    expect(ctx.orders).toHaveLength(8);
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_rebuilt",
      value: 1,
      labels: '{"band":"medium_low","reason":"scale_in"}',
    });
  });

  it("holds residual partial fills without rebuilding", async () => {
    const ctx = setup();
    ctx.repo.upsertLadder(ladderState());

    await ctx.module.start();
    await ctx.bus.publish("FillReceived", fill({ size: 25 }));

    expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
      lifecycle: "partially_filled",
      filledSizeShares: 25,
    });
    expect(ctx.orders).toHaveLength(0);
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_partial_fill_held",
      value: 1,
      labels: '{"band":"medium_low"}',
    });
  });
});

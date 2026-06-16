import {
  DEFAULT_EXECUTION_PROFILE_POLICY,
  LiquidityRole,
  OrderStatus,
  PositionStatus,
  createBotRunId,
  createConditionId,
  createFillId,
  createPositionId,
  createOrderId,
  createTokenId,
  type ClientOrderId,
  type LadderState,
  type NormalizedMarket,
  type Order,
  type PlaceOrderCommand,
  type Position,
  type RuntimeEventMap,
  type TokenId,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { describe, expect, it, vi } from "vitest";

import {
  ADOPTION_RETRY_MS,
  MAX_ADOPTION_ATTEMPTS,
  ProfileLadderModule,
} from "../profile-ladder-module.js";
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

function openSellOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: createOrderId("legacy-sell-order"),
    clientOrderId: "legacy-sell-client" as ClientOrderId,
    tokenId,
    conditionId,
    side: "sell",
    orderType: "GTC",
    price: 0.2,
    size: 50,
    sizeUsdc: 10,
    status: OrderStatus.Open,
    exchangeOrderId: null,
    signalId: null,
    signalReason: "track-s1-ladder",
    botRunId: createBotRunId("test-run"),
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}

function setup(
  profilePolicy = policy(),
  overrides: {
    modeReader?: { getMode: (token: TokenId) => "up" | "flat" | "avg_down" | null };
    isDormant?: (token: TokenId) => boolean;
    positionRepo?: { findOpen: () => Position[] };
    orderRepo?: { findByTokenId: (token: TokenId) => Order[] };
    isProfileOwned?: (token: TokenId) => boolean;
    onPolicyReload?: (handler: () => void) => () => void;
  } = {},
) {
  const bus = new InProcessEventBus();
  const repo = new InMemoryProfileLadderRepository();
  const counters: Array<{ name: string; value?: number; labels?: string }> = [];
  const riskEvents: Array<{ eventType: string; payload: Readonly<Record<string, unknown>> }> = [];
  const orders: PlaceOrderCommand[] = [];
  const cancels: string[] = [];
  // Policy is read through a mutable holder so tests can simulate a live policy
  // reload (e.g. adoptExisting hot-enabled) between calls.
  const policyRef = { current: profilePolicy };
  bus.subscribe("PlaceOrderRequested", async ({ command }) => {
    orders.push(command);
  });
  bus.subscribe("CancelOrderRequested", async ({ command }) => {
    cancels.push(String(command.orderId));
  });
  const module = new ProfileLadderModule({
    bus,
    repository: repo,
    policy: () => policyRef.current,
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
  const setPolicy = (next: ExecutionProfilePolicy) => {
    policyRef.current = next;
  };
  return { bus, repo, counters, riskEvents, orders, cancels, module, setPolicy };
}

// Captures the policy-reload handler the module registers so a test can fire a
// simulated reload on demand, mirroring ExecutionPolicyProvider.onReload.
function makeReloadHarness() {
  let handler: (() => void) | null = null;
  const onPolicyReload = (next: () => void) => {
    handler = next;
    return () => {
      handler = null;
    };
  };
  const fireReload = () => handler?.();
  return { onPolicyReload, fireReload };
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

  it("skips dormant position rebuilds without cancelling existing ladder", async () => {
    const ctx = setup(policy(), { isDormant: () => true });
    ctx.repo.upsertLadder(ladderState());
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market()],
      timestamp: NOW,
    });
    await ctx.bus.publish("PositionUpdated", {
      position: position({ costBasisUsdc: 35 }),
    });

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.cancels).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)).toMatchObject({
      status: "active",
      lastCostBasisUsdc: 25,
    });
    expect(ctx.counters).toContainEqual({
      name: "ladder_rebuild_skipped_dormant",
      value: 1,
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

  it("subscribes after a hot-enable even when it started while disabled", async () => {
    const mutablePolicy = {
      ...policy(),
      sellLadder: { ...policy().sellLadder, enabled: false },
    };
    const ctx = setup(mutablePolicy);

    await ctx.module.start();
    (mutablePolicy.sellLadder as { enabled: boolean }).enabled = true;
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });
    await ctx.bus.publish("PositionUpdated", { position: position() });

    expect(ctx.orders).toHaveLength(4);
    expect(ctx.repo.getLadder(tokenId)?.band).toBe("medium_low");
  });

  it("does not double-subscribe when start is called repeatedly while enabled", async () => {
    const ctx = setup();

    await ctx.module.start();
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });
    await ctx.bus.publish("PositionUpdated", { position: position() });

    expect(ctx.orders).toHaveLength(4);
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

describe("ProfileLadderModule.adoptExistingLadders", () => {
  function adoptionPolicy(overrides: Partial<ExecutionProfilePolicy["sellLadder"]> = {}) {
    return policy({ adoptExisting: { enabled: true }, ...overrides });
  }

  async function warmAndAdopt(ctx: ReturnType<typeof setup>): Promise<void> {
    await ctx.module.start();
    await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });
    await ctx.module.adoptExistingLadders();
  }

  function summaryOf(ctx: ReturnType<typeof setup>): Record<string, unknown> | undefined {
    return ctx.riskEvents.find((event) => event.eventType === "ladder_adoption_summary")?.payload as
      | Record<string, unknown>
      | undefined;
  }

  it("does not adopt when the sell ladder is disabled", async () => {
    const ctx = setup(
      {
        ...policy(),
        sellLadder: { ...policy().sellLadder, enabled: false, adoptExisting: { enabled: true } },
      },
      { positionRepo: { findOpen: () => [position()] }, isProfileOwned: () => true },
    );

    await ctx.module.adoptExistingLadders();

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.states.size).toBe(0);
    expect(summaryOf(ctx)).toBeUndefined();
  });

  it("does not adopt when adoptExisting is disabled", async () => {
    const ctx = setup(policy(), {
      positionRepo: { findOpen: () => [position()] },
      isProfileOwned: () => true,
    });

    await warmAndAdopt(ctx);

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.states.size).toBe(0);
    expect(summaryOf(ctx)).toBeUndefined();
  });

  it("skips adoption for positions that are not profile-owned", async () => {
    const ctx = setup(adoptionPolicy(), {
      positionRepo: { findOpen: () => [position()] },
      isProfileOwned: () => false,
    });

    await warmAndAdopt(ctx);

    expect(ctx.orders).toHaveLength(0);
    expect(summaryOf(ctx)).toMatchObject({
      eligible_count: 0,
      adopted_count: 0,
      skipped_not_profile_owned: 1,
    });
  });

  it("skips adoption when no market snapshot is cached", async () => {
    const ctx = setup(adoptionPolicy(), {
      positionRepo: { findOpen: () => [position()] },
      isProfileOwned: () => true,
    });

    await ctx.module.start();
    await ctx.module.adoptExistingLadders();

    expect(ctx.orders).toHaveLength(0);
    expect(summaryOf(ctx)).toMatchObject({
      eligible_count: 0,
      adopted_count: 0,
      skipped_missing_market: 1,
    });
  });

  it("skips adoption when a ladder already exists for the token", async () => {
    const ctx = setup(adoptionPolicy(), {
      positionRepo: { findOpen: () => [position()] },
      isProfileOwned: () => true,
    });
    ctx.repo.upsertLadder(ladderState());

    await warmAndAdopt(ctx);

    expect(ctx.orders).toHaveLength(0);
    expect(summaryOf(ctx)).toMatchObject({
      eligible_count: 0,
      adopted_count: 0,
      skipped_existing_ladder: 1,
    });
  });

  it("skips adoption when an open SELL order already exists", async () => {
    const ctx = setup(adoptionPolicy(), {
      positionRepo: { findOpen: () => [position()] },
      orderRepo: { findByTokenId: () => [openSellOrder()] },
      isProfileOwned: () => true,
    });

    await warmAndAdopt(ctx);

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.states.size).toBe(0);
    expect(summaryOf(ctx)).toMatchObject({
      eligible_count: 0,
      adopted_count: 0,
      skipped_existing_sell_order: 1,
    });
  });

  it("does not treat a filled or cancelled SELL order as a blocking open order", async () => {
    const ctx = setup(adoptionPolicy(), {
      positionRepo: { findOpen: () => [position()] },
      orderRepo: { findByTokenId: () => [openSellOrder({ status: OrderStatus.Cancelled })] },
      isProfileOwned: () => true,
    });

    await warmAndAdopt(ctx);

    expect(ctx.orders).toHaveLength(4);
    expect(summaryOf(ctx)).toMatchObject({ adopted_count: 1, skipped_existing_sell_order: 0 });
  });

  it("skips adoption when the resolved band is disabled", async () => {
    const ctx = setup(adoptionPolicy(), {
      positionRepo: { findOpen: () => [position({ avgEntryPrice: 0.2 })] },
      isProfileOwned: () => true,
    });

    await warmAndAdopt(ctx);

    expect(ctx.orders).toHaveLength(0);
    expect(summaryOf(ctx)).toMatchObject({
      eligible_count: 0,
      adopted_count: 0,
      skipped_band_disabled: 1,
    });
  });

  it("adopts an eligible profile-owned position using flat mode", async () => {
    const ctx = setup(adoptionPolicy(), {
      positionRepo: { findOpen: () => [position()] },
      orderRepo: { findByTokenId: () => [] },
      isProfileOwned: () => true,
    });

    await warmAndAdopt(ctx);

    expect(ctx.orders).toHaveLength(4);
    expect(ctx.repo.getLadder(tokenId)).toMatchObject({ band: "medium_low", lastMode: "flat" });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_adopted",
      value: 1,
      labels: '{"band":"medium_low"}',
    });
    expect(summaryOf(ctx)).toMatchObject({
      eligible_count: 1,
      adopted_count: 1,
      estimated_order_count: 4,
      skipped_existing_ladder: 0,
      skipped_missing_market: 0,
      skipped_not_profile_owned: 0,
      skipped_band_disabled: 0,
      skipped_existing_sell_order: 0,
    });
    const adopted = ctx.riskEvents.find((event) => event.eventType === "ladder_adopted");
    expect(adopted?.payload).toMatchObject({ band: "medium_low", source: "adopted" });
  });

  it("is idempotent across repeated adoption runs", async () => {
    const ctx = setup(adoptionPolicy(), {
      positionRepo: { findOpen: () => [position()] },
      isProfileOwned: () => true,
    });

    await warmAndAdopt(ctx);
    await ctx.module.adoptExistingLadders();

    expect(ctx.orders).toHaveLength(4);
    expect(
      ctx.riskEvents.filter((event) => event.eventType === "ladder_adoption_summary"),
    ).toHaveLength(1);
    expect(ctx.counters.filter((counter) => counter.name === "profile_ladder_adopted")).toHaveLength(
      1,
    );
  });

  it("counts and skips dormant positions during adoption", async () => {
    const ctx = setup(adoptionPolicy(), {
      positionRepo: { findOpen: () => [position()] },
      isProfileOwned: () => true,
      isDormant: () => true,
    });

    await warmAndAdopt(ctx);

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)).toBeNull();
    expect(summaryOf(ctx)).toMatchObject({
      eligible_count: 0,
      adopted_count: 0,
      skipped_dormant: 1,
    });
  });

  describe("hot-enable via policy reload", () => {
    it("runs adoption when adoptExisting is hot-enabled after start", async () => {
      vi.useFakeTimers();
      try {
        const reload = makeReloadHarness();
        const ctx = setup(policy(), {
          positionRepo: { findOpen: () => [position()] },
          isProfileOwned: () => true,
          onPolicyReload: reload.onPolicyReload,
        });

        await ctx.module.start();
        await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });

        // adoptExisting was off at start, so no adoption is scheduled yet.
        await vi.advanceTimersByTimeAsync(ADOPTION_RETRY_MS + 1);
        expect(summaryOf(ctx)).toBeUndefined();

        // Operator flips adoptExisting on; the live reload must schedule a pass.
        ctx.setPolicy(adoptionPolicy());
        reload.fireReload();
        await vi.advanceTimersByTimeAsync(ADOPTION_RETRY_MS + 1);

        expect(ctx.repo.getLadder(tokenId)).toMatchObject({ band: "medium_low", lastMode: "flat" });
        expect(ctx.orders).toHaveLength(4);
        expect(summaryOf(ctx)).toMatchObject({ adopted_count: 1, eligible_count: 1 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not schedule a duplicate adoption on an unrelated policy reload", async () => {
      vi.useFakeTimers();
      try {
        const reload = makeReloadHarness();
        const ctx = setup(adoptionPolicy(), {
          positionRepo: { findOpen: () => [position()] },
          isProfileOwned: () => true,
          onPolicyReload: reload.onPolicyReload,
        });

        await ctx.module.start();
        await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });

        // A reload that leaves adoptExisting unchanged must not queue a second pass.
        reload.fireReload();
        await vi.advanceTimersByTimeAsync(ADOPTION_RETRY_MS + 1);

        expect(ctx.orders).toHaveLength(4);
        expect(
          ctx.riskEvents.filter((event) => event.eventType === "ladder_adoption_summary"),
        ).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("bounded retry on missing market/BBO", () => {
    it("does not adopt or latch done when the market is missing, and retries", async () => {
      vi.useFakeTimers();
      try {
        const ctx = setup(adoptionPolicy(), {
          positionRepo: { findOpen: () => [position()] },
          isProfileOwned: () => true,
        });

        await ctx.module.start();
        await ctx.module.adoptExistingLadders();

        expect(ctx.repo.getLadder(tokenId)).toBeNull();
        expect(summaryOf(ctx)).toMatchObject({
          attempt: 1,
          skipped_missing_market: 1,
          retryable_skip_count: 1,
          adopted_count: 0,
        });

        // No market provided: the retry runs but still finds nothing.
        await vi.advanceTimersByTimeAsync(ADOPTION_RETRY_MS + 1);
        const summaries = ctx.riskEvents.filter(
          (event) => event.eventType === "ladder_adoption_summary",
        );
        expect(summaries).toHaveLength(2);
        expect(summaries[1]?.payload).toMatchObject({ attempt: 2, skipped_missing_market: 1 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("adopts on retry once the market becomes available", async () => {
      vi.useFakeTimers();
      try {
        const ctx = setup(adoptionPolicy(), {
          positionRepo: { findOpen: () => [position()] },
          isProfileOwned: () => true,
        });

        await ctx.module.start();
        await ctx.module.adoptExistingLadders();
        expect(ctx.repo.getLadder(tokenId)).toBeNull();

        await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });
        await vi.advanceTimersByTimeAsync(ADOPTION_RETRY_MS + 1);

        expect(ctx.repo.getLadder(tokenId)).toMatchObject({ band: "medium_low" });
        expect(ctx.orders).toHaveLength(4);
        const summaries = ctx.riskEvents.filter(
          (event) => event.eventType === "ladder_adoption_summary",
        );
        expect(summaries.at(-1)?.payload).toMatchObject({ attempt: 2, adopted_count: 1 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops retrying after the maximum number of attempts and latches done", async () => {
      vi.useFakeTimers();
      try {
        const ctx = setup(adoptionPolicy(), {
          positionRepo: { findOpen: () => [position()] },
          isProfileOwned: () => true,
        });

        await ctx.module.start();
        await ctx.module.adoptExistingLadders();
        for (let i = 0; i < MAX_ADOPTION_ATTEMPTS + 2; i++) {
          await vi.advanceTimersByTimeAsync(ADOPTION_RETRY_MS + 1);
        }

        const summaries = ctx.riskEvents.filter(
          (event) => event.eventType === "ladder_adoption_summary",
        );
        expect(summaries).toHaveLength(MAX_ADOPTION_ATTEMPTS);
        expect(summaries.at(-1)?.payload).toMatchObject({ attempt: MAX_ADOPTION_ATTEMPTS });

        // Latched done: a further explicit call is a no-op.
        await ctx.module.adoptExistingLadders();
        expect(
          ctx.riskEvents.filter((event) => event.eventType === "ladder_adoption_summary"),
        ).toHaveLength(MAX_ADOPTION_ATTEMPTS);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

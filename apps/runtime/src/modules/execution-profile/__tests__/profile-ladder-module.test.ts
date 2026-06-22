import {
  DEFAULT_EXECUTION_PROFILE_POLICY,
  ExchangeErrorCode,
  LiquidityRole,
  OrderStatus,
  PositionStatus,
  createBotRunId,
  createCommandId,
  createConditionId,
  createFillId,
  createPositionId,
  createOrderId,
  createTokenId,
  type ClientOrderId,
  type LadderRung,
  type LadderState,
  type NormalizedMarket,
  type Order,
  type OrderBookSnapshot,
  type PlaceOrderCommand,
  type Position,
  type RuntimeEventMap,
  type TokenId,
} from "@krabs/domain";
import { buildClientOrderId } from "@krabs/domain/node";
import { InProcessEventBus } from "@krabs/event-bus";
import { describe, expect, it, vi } from "vitest";

import {
  ADOPTION_RETRY_MS,
  MAX_ADOPTION_ATTEMPTS,
  PLANNED_RUNG_RETRY_MS,
  ProfileLadderModule,
  type ProfileLadderBookCache,
  type ProfileLadderModeCandidate,
  type ProfileLadderModeReaderConfig,
} from "../profile-ladder-module.js";
import type { ProfileLadderRepository } from "../profile-ladder-repository.js";
import type { ExecutionProfilePolicy, ProfileState } from "../types.js";

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

function mediumHighPolicy(): ExecutionProfilePolicy {
  return policy({
    bands: {
      ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands,
      medium_high: {
        ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.medium_high,
        enabled: true,
      },
    },
  });
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
    bookSource: "clob",
    gammaCreatedAt: null,
    snapshotTs: NOW,
    ...overrides,
  };
}

function orderBook(overrides: Partial<OrderBookSnapshot> = {}): OrderBookSnapshot {
  return {
    tokenId,
    bids: [{ price: 0.09, size: 100 }],
    asks: [{ price: 0.11, size: 100 }],
    bestBid: 0.09,
    bestAsk: 0.11,
    midPrice: 0.1,
    spread: 0.02,
    minOrderSize: 5,
    timestamp: NOW,
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

function rung(overrides: Partial<LadderRung> = {}): LadderRung {
  return {
    rungIndex: 0,
    price: 0.11,
    sizeShares: 95,
    notionalUsd: 10.45,
    multiplier: 1.1,
    sizingFraction: 0.38,
    lifecycle: "planned",
    orderId: null,
    filledSizeShares: 0,
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

function orderPlaced(
  command: PlaceOrderCommand,
  orderId = createOrderId("profile-ladder-backfilled-order"),
): RuntimeEventMap["OrderPlaced"] {
  return {
    commandId: command.commandId,
    clientOrderId: command.clientOrderId,
    orderId,
    tokenId: command.tokenId,
    conditionId: command.conditionId,
    side: command.side,
    price: command.price,
    size: command.size,
    orderType: command.orderType,
    signalReason: command.signalReason,
    timestamp: NOW + 1_000,
  };
}

function orderRejected(command: PlaceOrderCommand): RuntimeEventMap["OrderRejected"] {
  return {
    commandId: command.commandId,
    clientOrderId: command.clientOrderId,
    tokenId: command.tokenId,
    conditionId: command.conditionId,
    reason: "test-reject",
    errorCode: ExchangeErrorCode.LivePolicyBlocked,
    signalReason: command.signalReason,
    side: command.side,
    signalId: command.signalId ?? null,
    decisionRuleId: command.decisionRuleId ?? null,
    signalTimestamp: command.signalTimestamp ?? null,
    timestamp: NOW + 1_000,
  };
}

function orderSkipped(command: PlaceOrderCommand): RuntimeEventMap["OrderSkipped"] {
  return {
    commandId: command.commandId,
    clientOrderId: command.clientOrderId,
    tokenId: command.tokenId,
    conditionId: command.conditionId,
    reasonCode: "test-skip",
    side: command.side,
    price: command.price,
    size: command.size,
    signalReason: command.signalReason,
    signalId: command.signalId ?? null,
    decisionRuleId: command.decisionRuleId ?? null,
    signalTimestamp: command.signalTimestamp ?? null,
    details: {},
    timestamp: NOW + 1_000,
  };
}

function legacyPlaceOrder(): PlaceOrderCommand {
  return {
    type: "PlaceOrderCommand",
    commandId: createCommandId("legacy-pending-sell"),
    clientOrderId: "legacy-pending-client" as ClientOrderId,
    source: "strategy",
    tokenId,
    conditionId,
    side: "sell",
    size: 10,
    price: 0.12,
    postOnly: true,
    orderType: "GTC",
    tickSize: 0.001,
    negRisk: false,
    sequenceInTick: 0,
    signalReason: "track-s1-ladder",
    signalId: "legacy-sell",
    decisionRuleId: "LEGACY_SELL",
    signalTimestamp: new Date(NOW).toISOString(),
    metadata: { source: "s1" },
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

function stalePlannedNoLivePosition(overrides: Partial<Position> = {}): Position {
  return position({
    avgEntryPrice: 0.259945,
    costBasisUsdc: 1.541004,
    size: 5.9282,
    ...overrides,
  });
}

function stalePlannedNoLiveMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return market({
    tickSize: 0.01,
    bestBid: 0.24,
    bestAsk: 0.26,
    midPrice: 0.25,
    minOrderSize: 1,
    ...overrides,
  });
}

function stalePlannedNoLiveState(overrides: Partial<LadderState> = {}): LadderState {
  return ladderState({
    band: "medium_high",
    activeRungs: [
      rung({
        rungIndex: 0,
        price: 0.26,
        sizeShares: 5.9282,
        notionalUsd: 1.54,
        lifecycle: "planned",
        orderId: null,
      }),
    ],
    lastAvgEntry: 0.259945,
    lastCostBasisUsdc: 1.541004,
    lastMode: "flat",
    lastBboReferenceJson: JSON.stringify({ bestBid: 0.24, bestAsk: 0.26 }),
    ...overrides,
  });
}

function setup(
  profilePolicy = policy(),
  overrides: {
    modeReader?: { getMode: (token: TokenId) => "up" | "flat" | "avg_down" | null };
    modeCandidateReader?: {
      getCandidate: (
        token: TokenId,
        config: ProfileLadderModeReaderConfig,
      ) => ProfileLadderModeCandidate | null;
    };
    isDormant?: (token: TokenId) => boolean;
    positionRepo?: { findOpen: () => Position[] };
    orderRepo?: { findByTokenId: (token: TokenId) => Order[] };
    isProfileOwned?: (token: TokenId) => boolean;
    profileStateReader?: { getProfileState: (token: TokenId) => ProfileState | null };
    onPolicyReload?: (handler: () => void) => () => void;
    bookCache?: ProfileLadderBookCache;
    now?: () => number;
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
    now: overrides.now ?? (() => NOW),
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

function darkModeReaderConfig(
  overrides: Partial<ProfileLadderModeReaderConfig> = {},
): ProfileLadderModeReaderConfig {
  return {
    enabled: true,
    darkCompareOnly: true,
    source: "algo_token_mode_state",
    mapping: {
      PASSIVE: "flat",
      MIDDLE: "flat",
      BURST: "up",
    },
    missingBehavior: "local",
    ...overrides,
  };
}

function darkComparePolicy(
  overrides: Partial<ProfileLadderModeReaderConfig> = {},
): ExecutionProfilePolicy {
  return policy({
    modeReader: darkModeReaderConfig(overrides),
  } as Partial<ExecutionProfilePolicy["sellLadder"]>);
}

function modeCandidate(
  overrides: Partial<ProfileLadderModeCandidate> = {},
): ProfileLadderModeCandidate {
  return {
    source: "algo_token_mode_state",
    sourceMode: "PASSIVE",
    mappedMode: "flat",
    modeStatus: "confirmed",
    modeConfidence: "low",
    ...overrides,
  };
}

function counterLabels(
  counters: Array<{ name: string; value?: number; labels?: string }>,
  name: string,
): Array<Record<string, string>> {
  return counters
    .filter((counter) => counter.name === name)
    .map((counter) => JSON.parse(counter.labels ?? "{}") as Record<string, string>);
}

function postRefillPolicy(
  overrides: Partial<ExecutionProfilePolicy["sellLadder"]["postRefillFollowThrough"]> = {},
): ExecutionProfilePolicy {
  return policy({
    postRefillFollowThrough: {
      ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.postRefillFollowThrough,
      ...overrides,
    },
  });
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

    expect(ctx.orders).toHaveLength(1);
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
    // Two enabled bands, each capped at one live rung → two live orders total.
    expect(ctx.orders).toHaveLength(2);
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

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.repo.getLadder(tokenId)?.band).toBe("medium_low");
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_placed",
      value: 1,
      labels: '{"band":"medium_low"}',
    });
  });

  it("rebuilds after a scale-in BUY fill when PositionUpdated carries the new basis", async () => {
    const ctx = setup();
    const seeded = ladderState();
    const preservedOrderId = seeded.activeRungs[0]!.orderId;
    ctx.repo.upsertLadder(seeded);
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

    // The new basis shifts every planned price, so the old 0.11 rung no longer
    // matches any new rung. It must be kept (deferred replacement), never
    // orphaned, so its live slot blocks any duplicate placement.
    expect(ctx.orders).toHaveLength(0);
    const rebuilt = ctx.repo.getLadder(tokenId);
    expect(rebuilt?.activeRungs.find((r) => r.orderId === preservedOrderId)).toMatchObject({
      price: 0.11,
      lifecycle: "placed",
    });
    expect(rebuilt).toMatchObject({
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
    const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
    const seeded = ladderState();
    const preservedOrderId = seeded.activeRungs[0]!.orderId;
    ctx.repo.upsertLadder(seeded);
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.08, bestAsk: 0.1, midPrice: 0.09 })],
      timestamp: NOW,
    });
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.07, bestAsk: 0.09, midPrice: 0.08 })],
      timestamp: NOW + 1_000,
    });

    // The same-basis rebuild preserves the live rung instead of orphaning it, so
    // no new order is placed and the existing exchange orderId survives.
    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
      orderId: preservedOrderId,
      lifecycle: "placed",
    });
    // Exactly one rebuild fires; the second BBO move is cooldown-gated.
    expect(
      ctx.counters.filter((counter) => counter.name === "profile_ladder_rebuilt"),
    ).toHaveLength(1);
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_rebuilt",
      value: 1,
      labels: '{"band":"medium_low","reason":"bbo_strong"}',
    });
  });

  it("places ladder orders with calibrated rung count and metadata", async () => {
    const bookCache = {
      getFreshOrRefresh: vi.fn(),
    };
    const ctx = setup(policy(), { modeReader: { getMode: () => "flat" }, bookCache });

    await ctx.module.placeLadder(position(), market());

    expect(bookCache.getFreshOrRefresh).not.toHaveBeenCalled();
    // Cap=1: only the lowest-price rung is submitted live...
    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]).toMatchObject({
      price: 0.11,
      size: 95,
      source: "strategy",
      side: "sell",
      orderType: "GTC",
      postOnly: true,
      decisionRuleId: "PROFILE_LADDER",
      metadata: {
        source: "profile_ladder",
        marketData: {
          bookSource: "clob",
          minOrderSize: 1,
          effectiveMinOrderSize: 1,
          tickSize: 0.001,
          cacheStatus: "base-market",
        },
        cacheStatus: "base-market",
      },
    });
    // ...while the full calibrated vector is persisted for later recompute.
    const state = ctx.repo.getLadder(tokenId);
    expect(state).toMatchObject({ band: "medium_low", status: "active" });
    expect(state?.activeRungs.map((rung) => rung.price)).toEqual([0.11, 0.13, 0.155, 0.165]);
    expect(state?.activeRungs.map((rung) => rung.sizeShares)).toEqual([95, 60, 50, 45]);
    expect(state?.activeRungs.every((rung) => rung.lifecycle === "planned")).toBe(true);
  });

  it("does not publish a live rung when market min order size is unknown", async () => {
    const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });

    await ctx.module.placeLadder(position(), market({ minOrderSize: null }));

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
      lifecycle: "planned",
      orderId: null,
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_skipped_unknown_min_order_size",
      value: 1,
      labels: '{"band":"medium_low"}',
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_placed_live_rungs",
      value: 0,
      labels: '{"band":"medium_low"}',
    });
  });

  it("hydrates missing min order size from the shared candidate book cache", async () => {
    const bookCache = {
      getFreshOrRefresh: vi.fn(async () => ({
        entry: {
          tokenId: String(tokenId),
          snapshotTs: NOW,
          cachedAtMs: NOW,
          sourcePolledAtMs: NOW,
          bookSource: "clob" as const,
          sourceKind: "rest" as const,
          book: orderBook({ minOrderSize: 5 }),
        },
        status: "refreshed" as const,
      })),
    };
    const ctx = setup(policy(), { modeReader: { getMode: () => "flat" }, bookCache });

    await ctx.module.placeLadder(position(), market({ minOrderSize: null }));

    expect(bookCache.getFreshOrRefresh).toHaveBeenCalledWith(String(tokenId), NOW);
    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.metadata).toMatchObject({
      cacheStatus: "refreshed",
      marketData: {
        bookSource: "clob",
        minOrderSize: 5,
        effectiveMinOrderSize: 5,
        tickSize: 0.001,
        cacheStatus: "refreshed",
      },
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_min_order_size_hydrated_from_book_cache",
      value: 1,
      labels: '{"band":"medium_low","source":"refreshed"}',
    });
  });

  it("keeps rung planned when candidate book cache misses min order size", async () => {
    const bookCache = {
      getFreshOrRefresh: vi.fn(async () => ({
        entry: null,
        status: "cache-miss" as const,
      })),
    };
    const ctx = setup(policy(), { modeReader: { getMode: () => "flat" }, bookCache });

    await ctx.module.placeLadder(position(), market({ minOrderSize: null }));

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
      lifecycle: "planned",
      orderId: null,
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_min_order_size_hydration_miss",
      value: 1,
      labels: '{"band":"medium_low"}',
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_skipped_unknown_min_order_size",
      value: 1,
      labels: '{"band":"medium_low"}',
    });
  });

  it("recovers an existing planned-only ladder when a later market update has min order size", async () => {
    const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ minOrderSize: null })],
      timestamp: NOW,
    });
    await ctx.bus.publish("PositionUpdated", { position: position() });

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
      lifecycle: "planned",
      orderId: null,
    });

    // Simulates a deploy/restart after prod already persisted planned-only
    // ladders: retry cooldown is in-memory only, but ladder state is durable.
    await ctx.module.stop();
    await ctx.module.start();
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ minOrderSize: 5 })],
      timestamp: NOW + 1_000,
    });

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.metadata).toMatchObject({
      marketData: {
        bookSource: "clob",
        minOrderSize: 5,
        effectiveMinOrderSize: 5,
        tickSize: 0.001,
      },
    });
  });

  it("recovers an existing planned-only ladder from candidate book cache min order size", async () => {
    let nowMs = NOW;
    const bookCache = {
      getFreshOrRefresh: vi.fn(async () => ({
        entry: {
          tokenId: String(tokenId),
          snapshotTs: nowMs,
          cachedAtMs: nowMs,
          sourcePolledAtMs: nowMs,
          bookSource: "clob" as const,
          sourceKind: "rest" as const,
          book: orderBook({ minOrderSize: 5, timestamp: nowMs }),
        },
        status: "refreshed" as const,
      })),
    };
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      bookCache,
      now: () => nowMs,
    });
    await ctx.module.start();

    ctx.repo.upsertLadder(
      ladderState({
        activeRungs: [rung({ lifecycle: "planned", orderId: null })],
      }),
    );
    nowMs = NOW + PLANNED_RUNG_RETRY_MS + 1;
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ minOrderSize: null })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.metadata).toMatchObject({
      cacheStatus: "refreshed",
      marketData: {
        minOrderSize: 5,
        effectiveMinOrderSize: 5,
      },
    });
  });

  it("periodically retries a planned-only ladder after an unknown-min miss without a new market update", async () => {
    vi.useFakeTimers();
    try {
      let nowMs = NOW;
      const bookCache = {
        getFreshOrRefresh: vi
          .fn()
          .mockResolvedValueOnce({
            entry: null,
            status: "cache-miss" as const,
          })
          .mockResolvedValue({
            entry: {
              tokenId: String(tokenId),
              snapshotTs: nowMs,
              cachedAtMs: nowMs,
              sourcePolledAtMs: nowMs,
              bookSource: "clob" as const,
              sourceKind: "rest" as const,
              book: orderBook({ minOrderSize: 5, timestamp: nowMs }),
            },
            status: "refreshed" as const,
          }),
      };
      const ctx = setup(policy(), {
        modeReader: { getMode: () => "flat" },
        bookCache,
        now: () => nowMs,
      });
      ctx.repo.upsertLadder(
        ladderState({
          activeRungs: [rung({ lifecycle: "planned", orderId: null })],
        }),
      );
      await ctx.module.start();

      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market({ minOrderSize: null })],
        timestamp: nowMs,
      });

      expect(ctx.orders).toHaveLength(0);
      expect(bookCache.getFreshOrRefresh).toHaveBeenCalledTimes(1);

      nowMs = NOW + PLANNED_RUNG_RETRY_MS + 1;
      await vi.advanceTimersByTimeAsync(PLANNED_RUNG_RETRY_MS + 1);

      expect(bookCache.getFreshOrRefresh).toHaveBeenCalledTimes(2);
      expect(ctx.orders).toHaveLength(1);
      expect(ctx.orders[0]?.metadata).toMatchObject({
        cacheStatus: "refreshed",
        marketData: {
          minOrderSize: 5,
          effectiveMinOrderSize: 5,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds a stale planned-only ladder with no live profile-ladder order", async () => {
    const openPosition = position({
      avgEntryPrice: 0.259945,
      costBasisUsdc: 1.541004,
      size: 5.9282,
    });
    const ctx = setup(mediumHighPolicy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [openPosition] },
      orderRepo: { findByTokenId: () => [] },
    });
    const staleState = ladderState({
      band: "medium_high",
      activeRungs: [
        rung({
          rungIndex: 0,
          price: 0.26,
          sizeShares: 5.9282,
          notionalUsd: 1.54,
          lifecycle: "planned",
          orderId: null,
        }),
        rung({
          rungIndex: 1,
          price: 0.23,
          sizeShares: 10.7,
          notionalUsd: 2.46,
          lifecycle: "partially_filled",
          orderId: String(createOrderId("stale-partial-profile-ladder-order")),
          filledSizeShares: 10.7,
        }),
      ],
      lastAvgEntry: 0.259945,
      lastCostBasisUsdc: 1.541004,
      lastMode: "flat",
    });
    ctx.repo.upsertLadder(staleState);
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [
        market({
          tickSize: 0.01,
          bestBid: 0.24,
          bestAsk: 0.26,
          midPrice: 0.25,
          minOrderSize: 1,
        }),
      ],
      timestamp: NOW,
    });

    expect(ctx.orders).toHaveLength(1);
    const staleClientOrderId = buildClientOrderId({
      signalId: `profile_ladder_${String(tokenId)}_${staleState.ladderId}_0`,
      tokenId,
      side: "sell",
    });
    expect(ctx.orders[0]?.clientOrderId).not.toBe(staleClientOrderId);
    expect(ctx.orders[0]).toMatchObject({
      price: 0.27,
      size: 5.9282,
      decisionRuleId: "PROFILE_LADDER",
      signalReason: "profile-ladder-exit",
    });
    expect(ctx.repo.getLadder(tokenId)?.ladderId).toContain("planned_no_live_recovery");
    expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
      price: 0.27,
      lifecycle: "planned",
      orderId: null,
      floored: true,
    });
    expect(ctx.repo.getLadder(tokenId)?.activeRungs).toHaveLength(1);
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_planned_no_live_recovered",
      value: 1,
      labels: '{"band":"medium_high"}',
    });
  });

  it("does not rebuild a planned ladder while a profile-ladder SELL is still open", async () => {
    const openPosition = stalePlannedNoLivePosition();
    const openProfileOrder = openSellOrder({
      decisionRuleId: "PROFILE_LADDER",
      signalReason: "profile-ladder-exit",
      metadata: { source: "profile_ladder" },
      status: OrderStatus.Open,
    });
    const ctx = setup(mediumHighPolicy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [openPosition] },
      orderRepo: { findByTokenId: () => [openProfileOrder] },
    });
    ctx.repo.upsertLadder(stalePlannedNoLiveState());
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [stalePlannedNoLiveMarket()],
      timestamp: NOW,
    });

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
      price: 0.26,
      lifecycle: "planned",
    });
  });

  it("does not recover a planned-only ladder while a non-profile SELL is open", async () => {
    const ctx = setup(mediumHighPolicy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [stalePlannedNoLivePosition()] },
      orderRepo: { findByTokenId: () => [openSellOrder({ signalReason: "repricing-exit" })] },
    });
    ctx.repo.upsertLadder(stalePlannedNoLiveState());
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [stalePlannedNoLiveMarket()],
      timestamp: NOW,
    });

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)).toMatchObject({
      ladderId: "profile_ladder_existing",
      activeRungs: [{ price: 0.26, lifecycle: "planned" }],
    });
    expect(
      ctx.counters.some((counter) => counter.name === "profile_ladder_planned_no_live_recovered"),
    ).toBe(false);
  });

  it("does not recover a planned-only ladder from an invalid BBO", async () => {
    const ctx = setup(mediumHighPolicy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [stalePlannedNoLivePosition()] },
      orderRepo: { findByTokenId: () => [] },
    });
    ctx.repo.upsertLadder(stalePlannedNoLiveState());
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [stalePlannedNoLiveMarket({ bestBid: 0.26, bestAsk: 0.24 })],
      timestamp: NOW,
    });

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)).toMatchObject({
      ladderId: "profile_ladder_existing",
      activeRungs: [{ price: 0.26, lifecycle: "planned" }],
    });
    expect(
      ctx.counters.some((counter) => counter.name === "profile_ladder_planned_no_live_recovered"),
    ).toBe(false);
  });

  it("does not recover a planned-only ladder when rebuild cannot satisfy min order size", async () => {
    const ctx = setup(mediumHighPolicy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [stalePlannedNoLivePosition()] },
      orderRepo: { findByTokenId: () => [] },
    });
    ctx.repo.upsertLadder(stalePlannedNoLiveState());
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [stalePlannedNoLiveMarket({ minOrderSize: 10 })],
      timestamp: NOW,
    });

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)).toMatchObject({
      ladderId: "profile_ladder_existing",
      activeRungs: [{ price: 0.26, lifecycle: "planned" }],
    });
    expect(
      ctx.counters.some((counter) => counter.name === "profile_ladder_planned_no_live_recovered"),
    ).toBe(false);
  });

  it("cooldown-gates planned-only recovery after a safe skip", async () => {
    let nowMs = NOW;
    const ctx = setup(mediumHighPolicy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [stalePlannedNoLivePosition()] },
      orderRepo: { findByTokenId: () => [] },
      now: () => nowMs,
    });
    ctx.repo.upsertLadder(
      stalePlannedNoLiveState({
        lastBboReferenceJson: JSON.stringify({ bestBid: 0.1, bestAsk: 0.12 }),
      }),
    );
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [stalePlannedNoLiveMarket({ bestBid: 0.26, bestAsk: 0.24 })],
      timestamp: nowMs,
    });
    expect(ctx.orders).toHaveLength(0);

    nowMs = NOW + PLANNED_RUNG_RETRY_MS - 1;
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [stalePlannedNoLiveMarket()],
      timestamp: nowMs,
    });
    expect(ctx.orders).toHaveLength(0);

    nowMs = NOW + PLANNED_RUNG_RETRY_MS + 1;
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [stalePlannedNoLiveMarket()],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]).toMatchObject({
      price: 0.27,
      decisionRuleId: "PROFILE_LADDER",
      signalReason: "profile-ladder-exit",
    });
  });

  it("clears the planned-rung recovery timer on stop", async () => {
    vi.useFakeTimers();
    try {
      let nowMs = NOW;
      const bookCache = {
        getFreshOrRefresh: vi
          .fn()
          .mockResolvedValueOnce({
            entry: null,
            status: "cache-miss" as const,
          })
          .mockResolvedValue({
            entry: {
              tokenId: String(tokenId),
              snapshotTs: nowMs,
              cachedAtMs: nowMs,
              sourcePolledAtMs: nowMs,
              bookSource: "clob" as const,
              sourceKind: "rest" as const,
              book: orderBook({ minOrderSize: 5, timestamp: nowMs }),
            },
            status: "refreshed" as const,
          }),
      };
      const ctx = setup(policy(), {
        modeReader: { getMode: () => "flat" },
        bookCache,
        now: () => nowMs,
      });
      ctx.repo.upsertLadder(
        ladderState({
          activeRungs: [rung({ lifecycle: "planned", orderId: null })],
        }),
      );
      await ctx.module.start();

      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market({ minOrderSize: null })],
        timestamp: nowMs,
      });
      await ctx.module.stop();

      nowMs = NOW + PLANNED_RUNG_RETRY_MS + 1;
      await vi.advanceTimersByTimeAsync(PLANNED_RUNG_RETRY_MS + 1);

      expect(bookCache.getFreshOrRefresh).toHaveBeenCalledTimes(1);
      expect(ctx.orders).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rate-limits unknown-min planned rung retries without restart", async () => {
    let nowMs = NOW;
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      now: () => nowMs,
    });
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ minOrderSize: null })],
      timestamp: nowMs,
    });
    await ctx.bus.publish("PositionUpdated", { position: position() });

    expect(ctx.orders).toHaveLength(0);
    expect(
      ctx.counters.filter(
        (counter) => counter.name === "profile_ladder_skipped_unknown_min_order_size",
      ),
    ).toHaveLength(1);

    nowMs = NOW + PLANNED_RUNG_RETRY_MS - 1;
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ minOrderSize: 5 })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(0);

    nowMs = NOW + PLANNED_RUNG_RETRY_MS + 1;
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ minOrderSize: 5 })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.metadata).toMatchObject({
      marketData: {
        minOrderSize: 5,
        effectiveMinOrderSize: 5,
      },
    });
  });

  it("does not call the book cache again inside the unknown-min retry cooldown", async () => {
    let nowMs = NOW;
    const bookCache = {
      getFreshOrRefresh: vi.fn(async () => ({
        entry: null,
        status: "cache-miss" as const,
      })),
    };
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      bookCache,
      now: () => nowMs,
    });
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ minOrderSize: null })],
      timestamp: nowMs,
    });
    await ctx.bus.publish("PositionUpdated", { position: position() });

    expect(bookCache.getFreshOrRefresh).toHaveBeenCalledTimes(1);

    nowMs = NOW + PLANNED_RUNG_RETRY_MS - 1;
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ minOrderSize: null })],
      timestamp: nowMs,
    });

    expect(bookCache.getFreshOrRefresh).toHaveBeenCalledTimes(1);
    expect(ctx.orders).toHaveLength(0);
  });

  it("rate-limits crossing-only planned rung retries", async () => {
    let nowMs = NOW;
    const ctx = setup(policy(), { now: () => nowMs });
    ctx.repo.upsertLadder(
      ladderState({
        activeRungs: [rung({ price: 0.09, sizeShares: 60 })],
      }),
    );
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.09, bestAsk: 0.11, minOrderSize: 5 })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(0);
    expect(
      ctx.counters.filter(
        (counter) => counter.name === "profile_ladder_skipped_crossing_post_only",
      ),
    ).toHaveLength(1);

    nowMs = NOW + PLANNED_RUNG_RETRY_MS - 1;
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.09, bestAsk: 0.11, minOrderSize: 5 })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(0);
    expect(
      ctx.counters.filter(
        (counter) => counter.name === "profile_ladder_skipped_crossing_post_only",
      ),
    ).toHaveLength(1);

    nowMs = NOW + PLANNED_RUNG_RETRY_MS + 1;
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.09, bestAsk: 0.11, minOrderSize: 5 })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(0);
    expect(
      ctx.counters.filter(
        (counter) => counter.name === "profile_ladder_skipped_crossing_post_only",
      ),
    ).toHaveLength(2);
  });

  it("cooldown-gates planned rung retry after duplicate clientOrderId skip", async () => {
    let nowMs = NOW;
    const ctx = setup(policy(), { modeReader: { getMode: () => "flat" }, now: () => nowMs });
    ctx.repo.upsertLadder(
      ladderState({
        activeRungs: [rung({ price: 0.12, sizeShares: 60 })],
      }),
    );
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.09, bestAsk: 0.11, minOrderSize: 5 })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(1);
    const first = ctx.orders[0]!;
    await ctx.bus.publish("OrderSkipped", {
      ...orderSkipped(first),
      reasonCode: "duplicate_client_order_id_pre_submit",
    });

    nowMs = NOW + PLANNED_RUNG_RETRY_MS - 1;
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.09, bestAsk: 0.11, minOrderSize: 5 })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(1);

    nowMs = NOW + PLANNED_RUNG_RETRY_MS + 1;
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.09, bestAsk: 0.11, minOrderSize: 5 })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(2);
    expect(ctx.orders[1]?.clientOrderId).toBe(first.clientOrderId);
  });

  it("does not retry a planned rung while cap is occupied by a live rung", async () => {
    const bookCache = {
      getFreshOrRefresh: vi.fn(async () => ({
        entry: {
          tokenId: String(tokenId),
          snapshotTs: NOW,
          cachedAtMs: NOW,
          sourcePolledAtMs: NOW,
          bookSource: "clob" as const,
          sourceKind: "rest" as const,
          book: orderBook({ minOrderSize: 5 }),
        },
        status: "refreshed" as const,
      })),
    };
    const ctx = setup(policy(), { modeReader: { getMode: () => "flat" }, bookCache });
    ctx.repo.upsertLadder(
      ladderState({
        activeRungs: [
          rung({
            rungIndex: 0,
            lifecycle: "placed",
            orderId: String(createOrderId("profile-ladder-live-rung")),
          }),
          rung({ rungIndex: 1, price: 0.13, sizeShares: 60 }),
        ],
      }),
    );
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ minOrderSize: 5 })],
      timestamp: NOW,
    });

    expect(ctx.orders).toHaveLength(0);
    expect(bookCache.getFreshOrRefresh).not.toHaveBeenCalled();
  });

  it("does not emit modeReader dark-compare telemetry when disabled", async () => {
    const ctx = setup(policy(), {
      modeCandidateReader: { getCandidate: () => modeCandidate({ mappedMode: "up" }) },
    });

    await ctx.module.placeLadder(position(), market());

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.price).toBe(0.105);
    expect(ctx.repo.getLadder(tokenId)?.lastMode).toBe("up");
    expect(
      ctx.counters.some((counter) => counter.name.startsWith("profile_ladder_mode_reader_")),
    ).toBe(false);
  });

  it("emits modeReader dark-compare telemetry without changing local UP placement", async () => {
    const ctx = setup(darkComparePolicy(), {
      modeCandidateReader: {
        getCandidate: () => modeCandidate({ sourceMode: "PASSIVE", mappedMode: "flat" }),
      },
    });

    await ctx.module.placeLadder(
      position(),
      market({ bestBid: 0.09, bestAsk: 0.2, midPrice: 0.145 }),
    );

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.price).toBe(0.105);
    expect(ctx.repo.getLadder(tokenId)?.lastMode).toBe("up");
    expect(counterLabels(ctx.counters, "profile_ladder_mode_reader_delta")).toContainEqual({
      source: "algo_token_mode_state",
      sourceMode: "PASSIVE",
      mappedCandidate: "flat",
      localMode: "up",
      modeStatus: "confirmed",
      modeConfidence: "low",
    });
    expect(
      counterLabels(ctx.counters, "profile_ladder_mode_reader_price_delta_bucket")[0],
    ).toMatchObject({
      band: "medium_low",
      localMode: "up",
      mappedCandidate: "flat",
    });
  });

  it("keeps local UP placement when the modeReader candidate is missing", async () => {
    const ctx = setup(darkComparePolicy(), {
      modeCandidateReader: { getCandidate: () => null },
    });

    await ctx.module.placeLadder(
      position(),
      market({ bestBid: 0.09, bestAsk: 0.2, midPrice: 0.145 }),
    );

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.price).toBe(0.105);
    expect(ctx.repo.getLadder(tokenId)?.lastMode).toBe("up");
    expect(counterLabels(ctx.counters, "profile_ladder_mode_reader_coverage")).toContainEqual({
      source: "algo_token_mode_state",
      result: "missing",
      sourceMode: "null",
      modeStatus: "missing",
      modeConfidence: "missing",
    });
  });

  it("keeps placement unchanged when modeReader dark compare throws", async () => {
    const ctx = setup(darkComparePolicy(), {
      modeCandidateReader: {
        getCandidate: () => {
          throw new Error("candidate reader unavailable");
        },
      },
    });

    await ctx.module.placeLadder(position(), market());

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.price).toBe(0.105);
    expect(ctx.repo.getLadder(tokenId)).toMatchObject({ band: "medium_low", lastMode: "up" });
    expect(counterLabels(ctx.counters, "profile_ladder_mode_reader_error")).toContainEqual({
      reason: "exception",
    });
  });

  it("keeps local AVG_DOWN placement when the modeReader candidate is missing", async () => {
    const ctx = setup(darkComparePolicy(), {
      modeCandidateReader: { getCandidate: () => null },
    });

    await ctx.module.placeLadder(
      position(),
      market({ bestBid: 0.04, bestAsk: 0.05, midPrice: 0.045 }),
    );

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.price).toBe(0.165);
    expect(ctx.repo.getLadder(tokenId)?.lastMode).toBe("avg_down");
    expect(counterLabels(ctx.counters, "profile_ladder_mode_reader_missing")).toContainEqual({
      source: "algo_token_mode_state",
      reason: "not_found",
      modeStatus: "missing",
      modeConfidence: "missing",
    });
  });

  it("emits bounded modeReader labels for MIDDLE and BURST candidates", async () => {
    const ctx = setup(darkComparePolicy(), {
      modeCandidateReader: {
        getCandidate: () =>
          modeCandidate({
            sourceMode: "BURST",
            mappedMode: "up",
            modeStatus: "candidate",
            modeConfidence: "high",
          }),
      },
    });

    await ctx.module.placeLadder(position(), market());

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.price).toBe(0.105);
    expect(ctx.repo.getLadder(tokenId)?.lastMode).toBe("up");
    expect(counterLabels(ctx.counters, "profile_ladder_mode_reader_coverage")).toContainEqual({
      source: "algo_token_mode_state",
      result: "mapped",
      sourceMode: "BURST",
      modeStatus: "candidate",
      modeConfidence: "high",
    });
    expect(counterLabels(ctx.counters, "profile_ladder_mode_reader_status")).toContainEqual({
      modeStatus: "candidate",
    });
    expect(counterLabels(ctx.counters, "profile_ladder_mode_reader_confidence")).toContainEqual({
      modeConfidence: "high",
    });
    expect(JSON.stringify(ctx.counters)).not.toContain(String(tokenId));
    expect(JSON.stringify(ctx.counters)).not.toContain(String(conditionId));
  });

  it("maps MIDDLE modeReader candidates to flat telemetry without behavior changes", async () => {
    const ctx = setup(darkComparePolicy(), {
      modeCandidateReader: {
        getCandidate: () => modeCandidate({ sourceMode: "MIDDLE", mappedMode: "flat" }),
      },
    });

    await ctx.module.placeLadder(
      position(),
      market({ bestBid: 0.09, bestAsk: 0.2, midPrice: 0.145 }),
    );

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.price).toBe(0.105);
    expect(ctx.repo.getLadder(tokenId)?.lastMode).toBe("up");
    expect(counterLabels(ctx.counters, "profile_ladder_mode_reader_delta")).toContainEqual({
      source: "algo_token_mode_state",
      sourceMode: "MIDDLE",
      mappedCandidate: "flat",
      localMode: "up",
      modeStatus: "confirmed",
      modeConfidence: "low",
    });
  });

  it("passes UP mode from the mode reader into LadderBuilder", async () => {
    const ctx = setup(policy(), { modeReader: { getMode: () => "up" } });

    await ctx.module.placeLadder(position(), market());

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.price).toBe(0.105);
    expect(ctx.repo.getLadder(tokenId)?.activeRungs.map((rung) => rung.price)).toEqual([
      0.105, 0.124, 0.148, 0.157,
    ]);
    expect(ctx.repo.getLadder(tokenId)?.lastMode).toBe("up");
  });

  it("passes AVG_DOWN mode from the mode reader into LadderBuilder", async () => {
    const ctx = setup(policy(), { modeReader: { getMode: () => "avg_down" } });

    await ctx.module.placeLadder(position(), market());

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.price).toBe(0.165);
    expect(ctx.repo.getLadder(tokenId)?.activeRungs.map((rung) => rung.price)).toEqual([
      0.165, 0.195, 0.233, 0.248,
    ]);
    expect(ctx.repo.getLadder(tokenId)?.lastMode).toBe("avg_down");
  });

  it("falls back to flat and counts missing mode when the mode reader has no state", async () => {
    const ctx = setup(policy(), { modeReader: { getMode: () => null } });

    await ctx.module.placeLadder(position(), market());

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.price).toBe(0.11);
    expect(ctx.repo.getLadder(tokenId)?.activeRungs.map((rung) => rung.price)).toEqual([
      0.11, 0.13, 0.155, 0.165,
    ]);
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

    // First rebuild submits the single capped rung. The deterministic
    // ladderId is stable across same-basis rebuilds, so its still-pending rung0
    // occupies the only live slot and the second rebuild re-submits nothing;
    // the third is cooldown-gated. One live order total.
    expect(ctx.orders).toHaveLength(1);
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_rebuilt",
      value: 1,
      labels: '{"band":"medium_low","reason":"scale_in"}',
    });
  });

  describe("rebuild preserves live rung ownership (Plankton no-orphan)", () => {
    it("preserves the placed rung orderId across a BBO rebuild", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
      const seeded = ladderState();
      const preservedOrderId = seeded.activeRungs[0]!.orderId;
      ctx.repo.upsertLadder(seeded);

      await ctx.module.rebuildLadder(position(), market(), "bbo_strong");

      const rebuilt = ctx.repo.getLadder(tokenId);
      // Same-basis rebuild keeps rung0 at 0.11, so the live order is carried over
      // wholesale rather than re-planned with a null orderId.
      expect(rebuilt?.activeRungs[0]).toMatchObject({
        price: 0.11,
        orderId: preservedOrderId,
        lifecycle: "placed",
      });
      // Clean preservation: the planned tail follows, with no orphaned stale rung.
      expect(rebuilt?.activeRungs.map((r) => r.price)).toEqual([0.11, 0.13, 0.155, 0.165]);
    });

    it("does not place a duplicate rung across a BBO rebuild when cap=1", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
      ctx.repo.upsertLadder(ladderState());

      await ctx.module.rebuildLadder(position(), market(), "bbo_strong");

      // The preserved live rung already occupies the single slot, so the rebuild
      // must not publish another PlaceOrderRequested.
      expect(ctx.orders).toHaveLength(0);
    });

    it("matches a fill against the preserved orderId after a BBO rebuild", async () => {
      vi.useFakeTimers();
      try {
        const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
        const seeded = ladderState();
        const preservedOrderId = seeded.activeRungs[0]!.orderId;
        ctx.repo.upsertLadder(seeded);
        await ctx.module.start();

        await ctx.module.rebuildLadder(position(), market(), "bbo_strong");
        await ctx.bus.publish("FillReceived", fill({ size: 25 }));

        const filled = ctx.repo
          .getLadder(tokenId)
          ?.activeRungs.find((r) => r.orderId === preservedOrderId);
        expect(filled).toMatchObject({ filledSizeShares: 25, lifecycle: "partially_filled" });
        // The fill was classified (recordPostFill ran), proving the match succeeded.
        expect(ctx.counters).toContainEqual({
          name: "profile_ladder_fill_position",
          value: 1,
          labels: '{"position":"bottom","fillType":"partial","band":"medium_low"}',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels the preserved orderId when the ladder is cancelled after a BBO rebuild", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
      const seeded = ladderState();
      const preservedOrderId = seeded.activeRungs[0]!.orderId;
      ctx.repo.upsertLadder(seeded);

      await ctx.module.rebuildLadder(position(), market(), "bbo_strong");
      await ctx.module.cancelLadder(tokenId, "operator");

      expect(ctx.cancels).toContain(preservedOrderId);
    });

    it("preserves the placed rung across a compatible scale-in rebuild", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
      const seeded = ladderState();
      const preservedOrderId = seeded.activeRungs[0]!.orderId;
      ctx.repo.upsertLadder(seeded);

      // A scale-in that adds size at the same avg entry leaves every planned price
      // unchanged, so the live rung is still valid and must be preserved.
      await ctx.module.rebuildLadder(
        position({ costBasisUsdc: 50, size: 500 }),
        market(),
        "scale_in",
      );

      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        price: 0.11,
        orderId: preservedOrderId,
        lifecycle: "placed",
      });
      expect(ctx.orders).toHaveLength(0);
    });

    it("does not orphan an invalidated live rung on an incompatible scale-in rebuild", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
      const seeded = ladderState();
      const preservedOrderId = seeded.activeRungs[0]!.orderId;
      ctx.repo.upsertLadder(seeded);

      // A scale-in that shifts the avg entry moves every planned price, so the old
      // 0.11 rung matches nothing. It must be kept until it fills or is cancelled
      // — never silently dropped while the live order can still rest.
      await ctx.module.rebuildLadder(position({ avgEntryPrice: 0.12 }), market(), "scale_in");

      const survivor = ctx.repo
        .getLadder(tokenId)
        ?.activeRungs.find((r) => r.orderId === preservedOrderId);
      expect(survivor).toMatchObject({ price: 0.11, lifecycle: "placed" });
      // The old live order still occupies the single slot: no new rung goes live.
      expect(ctx.orders).toHaveLength(0);
    });
  });

  describe("post-refill stale live rung dry-run follow-through", () => {
    function staleLowerPriorityState(overrides: Partial<LadderState> = {}): LadderState {
      return ladderState({
        activeRungs: [
          rung({
            rungIndex: 0,
            price: 0.104,
            sizeShares: 40,
            notionalUsd: 4.16,
            multiplier: 1.3,
            sizingFraction: 0.24,
            lifecycle: "placed",
            orderId: String(createOrderId("stale-lower-priority-live")),
          }),
        ],
        lastAvgEntry: 0.1,
        lastCostBasisUsdc: 25,
        ...overrides,
      });
    }

    async function rebuildWithPostRefillContext(
      ctx: ReturnType<typeof setup>,
      overrides: Partial<Position> = {},
    ): Promise<void> {
      await ctx.module.rebuildLadder(
        position({
          avgEntryPrice: 0.08,
          costBasisUsdc: 20,
          size: 250,
          ...overrides,
        }),
        market({
          bestBid: 0.07,
          bestAsk: 0.09,
          midPrice: 0.08,
          minOrderSize: 1,
        }),
        "scale_in",
      );
    }

    it("detects lower-priority price match without cancel/place side effects", async () => {
      const ctx = setup(postRefillPolicy(), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
      });
      ctx.repo.upsertLadder(staleLowerPriorityState());

      await rebuildWithPostRefillContext(ctx);

      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(0);
      expect(counterLabels(ctx.counters, "profile_ladder_stale_live_rung_detected_total")).toEqual([
        {
          action: "dry_run",
          band: "medium_low",
          coverageBucket: "lt25",
          mode: "flat",
          priceDistanceBucket: "ge25pct",
          reason: "intended_active_blocked",
          state: "unknown",
        },
      ]);
      expect(ctx.riskEvents).toContainEqual(
        expect.objectContaining({
          eventType: "profile_ladder_stale_live_rung_detected",
          payload: expect.objectContaining({
            action: "dry_run",
            liveCoverageRatio: 0.16,
            liveRungIndex: 1,
            intendedRungIndex: 0,
            oldLivePrice: 0.104,
            selectedPlannedPrice: 0.088,
          }),
        }),
      );
      const state = ctx.repo.getLadder(tokenId)!;
      expect(state.activeRungs.some((activeRung) => activeRung.price === 0.104)).toBe(true);
      expect(state.activeRungs.some((activeRung) => activeRung.price === 0.088)).toBe(true);
    });

    it.each(["ACCUMULATING", "HARVESTING"] as const)(
      "emits the real profile state in stale-rung telemetry for %s",
      async (profileState) => {
        const ctx = setup(postRefillPolicy(), {
          modeReader: { getMode: () => "flat" },
          isProfileOwned: () => true,
          profileStateReader: { getProfileState: () => profileState },
        });
        ctx.repo.upsertLadder(staleLowerPriorityState());

        await rebuildWithPostRefillContext(ctx);

        expect(
          counterLabels(ctx.counters, "profile_ladder_stale_live_rung_detected_total"),
        ).toEqual([
          expect.objectContaining({
            state: profileState,
          }),
        ]);
        expect(
          ctx.riskEvents.find(
            (event) => event.eventType === "profile_ladder_stale_live_rung_detected",
          )?.payload,
        ).toMatchObject({
          profileState,
        });
      },
    );

    it("falls back to unknown profile state when the reader fails without side effects", async () => {
      const ctx = setup(postRefillPolicy(), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
        profileStateReader: {
          getProfileState: () => {
            throw new Error("profile state unavailable");
          },
        },
      });
      ctx.repo.upsertLadder(staleLowerPriorityState());

      await rebuildWithPostRefillContext(ctx);

      expect(counterLabels(ctx.counters, "profile_ladder_stale_live_rung_detected_total")).toEqual([
        expect.objectContaining({
          state: "unknown",
        }),
      ]);
      expect(
        ctx.riskEvents.find(
          (event) => event.eventType === "profile_ladder_stale_live_rung_detected",
        )?.payload,
      ).toMatchObject({
        profileState: "unknown",
      });
      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(0);
    });

    it("dedupes stale-rung detection risk events while counting every occurrence", async () => {
      let now = NOW;
      const ctx = setup(postRefillPolicy(), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
        now: () => now,
      });
      ctx.repo.upsertLadder(staleLowerPriorityState());

      await rebuildWithPostRefillContext(ctx);
      await rebuildWithPostRefillContext(ctx);

      expect(
        counterLabels(ctx.counters, "profile_ladder_stale_live_rung_detected_total"),
      ).toHaveLength(2);
      expect(
        ctx.riskEvents.filter(
          (event) => event.eventType === "profile_ladder_stale_live_rung_detected",
        ),
      ).toHaveLength(1);

      now += 5 * 60_000 + 1;
      await rebuildWithPostRefillContext(ctx);

      expect(
        counterLabels(ctx.counters, "profile_ladder_stale_live_rung_detected_total"),
      ).toHaveLength(3);
      expect(
        ctx.riskEvents.filter(
          (event) => event.eventType === "profile_ladder_stale_live_rung_detected",
        ),
      ).toHaveLength(2);
    });

    it("does not dedupe detections with a different live order or selected price", async () => {
      const ctx = setup(postRefillPolicy(), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
      });
      ctx.repo.upsertLadder(staleLowerPriorityState());

      await rebuildWithPostRefillContext(ctx);
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.2,
              sizeShares: 40,
              notionalUsd: 8,
              lifecycle: "placed",
              orderId: String(createOrderId("different-stale-live")),
            }),
          ],
        }),
      );
      await rebuildWithPostRefillContext(ctx, {
        avgEntryPrice: 0.09,
        costBasisUsdc: 22.5,
        size: 250,
      });

      expect(
        ctx.riskEvents.filter(
          (event) => event.eventType === "profile_ladder_stale_live_rung_detected",
        ),
      ).toHaveLength(2);
    });

    it("detects an appended stale live rung when the old price is no longer in the plan", async () => {
      const ctx = setup(postRefillPolicy(), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.2,
              sizeShares: 40,
              notionalUsd: 8,
              lifecycle: "placed",
              orderId: String(createOrderId("stale-appended-live")),
            }),
          ],
        }),
      );

      await rebuildWithPostRefillContext(ctx);

      const detected = ctx.riskEvents.find(
        (event) => event.eventType === "profile_ladder_stale_live_rung_detected",
      );
      expect(detected?.payload).toMatchObject({
        liveRungIndex: 4,
        intendedRungIndex: 0,
        oldLivePrice: 0.2,
        selectedPlannedPrice: 0.088,
      });
      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(0);
    });

    it("does not detect when live coverage is healthy", async () => {
      const ctx = setup(postRefillPolicy(), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.104,
              sizeShares: 175,
              notionalUsd: 18.2,
              lifecycle: "placed",
              orderId: String(createOrderId("healthy-coverage-live")),
            }),
          ],
        }),
      );

      await rebuildWithPostRefillContext(ctx);

      expect(
        counterLabels(ctx.counters, "profile_ladder_post_refill_live_coverage_bucket"),
      ).toEqual([
        expect.objectContaining({
          action: "observe",
          coverageBucket: "50_75",
          reason: "evaluated",
        }),
      ]);
      expect(ctx.counters.some((counter) => counter.name.includes("stale_live_rung"))).toBe(false);
      expect(ctx.riskEvents.some((event) => event.eventType.includes("stale_live_rung"))).toBe(
        false,
      );
      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(0);
    });

    it("does not detect when the live rung is already the intended active rung", async () => {
      const ctx = setup(postRefillPolicy(), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.088,
              sizeShares: 40,
              notionalUsd: 3.52,
              lifecycle: "placed",
              orderId: String(createOrderId("intended-active-live")),
            }),
          ],
        }),
      );

      await rebuildWithPostRefillContext(ctx);

      expect(ctx.counters.some((counter) => counter.name.includes("stale_live_rung"))).toBe(false);
      expect(ctx.riskEvents.some((event) => event.eventType.includes("stale_live_rung"))).toBe(
        false,
      );
      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(0);
    });

    it("does not detect when post-refill follow-through is disabled", async () => {
      const ctx = setup(postRefillPolicy({ enabled: false }), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
      });
      ctx.repo.upsertLadder(staleLowerPriorityState());

      await rebuildWithPostRefillContext(ctx);

      expect(ctx.counters.some((counter) => counter.name.includes("stale_live_rung"))).toBe(false);
      expect(ctx.riskEvents.some((event) => event.eventType.includes("stale_live_rung"))).toBe(
        false,
      );
    });

    it("keeps PR1 side-effect-free even when replacementEnabled is configured true", async () => {
      const ctx = setup(postRefillPolicy({ dryRun: false, replacementEnabled: true }), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
      });
      ctx.repo.upsertLadder(staleLowerPriorityState());

      await rebuildWithPostRefillContext(ctx);

      expect(
        counterLabels(ctx.counters, "profile_ladder_post_refill_live_coverage_bucket"),
      ).toEqual([
        expect.objectContaining({
          action: "dry_run",
          coverageBucket: "lt25",
          reason: "intended_active_blocked",
        }),
      ]);
      expect(
        counterLabels(ctx.counters, "profile_ladder_stale_live_rung_detected_total"),
      ).toHaveLength(1);
      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(0);
    });

    it("does not detect for non-profile-owned positions", async () => {
      const ctx = setup(postRefillPolicy(), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => false,
      });
      ctx.repo.upsertLadder(staleLowerPriorityState());

      await rebuildWithPostRefillContext(ctx);

      expect(ctx.counters.some((counter) => counter.name.includes("stale_live_rung"))).toBe(false);
      expect(ctx.riskEvents.some((event) => event.eventType.includes("stale_live_rung"))).toBe(
        false,
      );
    });

    it("chooses the highest-index stale live rung deterministically in dry-run", async () => {
      const ctx = setup(postRefillPolicy(), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.104,
              sizeShares: 20,
              notionalUsd: 2.08,
              lifecycle: "placed",
              orderId: String(createOrderId("stale-index-one-live")),
            }),
            rung({
              rungIndex: 1,
              price: 0.124,
              sizeShares: 20,
              notionalUsd: 2.48,
              lifecycle: "placed",
              orderId: String(createOrderId("stale-index-two-live")),
            }),
          ],
        }),
      );

      await rebuildWithPostRefillContext(ctx);

      expect(
        ctx.riskEvents.find(
          (event) => event.eventType === "profile_ladder_stale_live_rung_detected",
        )?.payload,
      ).toMatchObject({
        liveRungIndex: 2,
        oldLivePrice: 0.124,
        selectedPlannedPrice: 0.088,
      });
      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(0);
    });
  });

  describe("pending in-flight rung rebuild safety", () => {
    async function placePendingRung(ctx: ReturnType<typeof setup>): Promise<PlaceOrderCommand> {
      await ctx.module.start();
      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });
      await ctx.bus.publish("PositionUpdated", { position: position() });
      expect(ctx.orders).toHaveLength(1);
      return ctx.orders[0]!;
    }

    it("defers an incompatible rebuild while an old-ladder rung is still pending", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
      const pending = await placePendingRung(ctx);
      const originalState = ctx.repo.getLadder(tokenId)!;

      await ctx.module.rebuildLadder(position({ avgEntryPrice: 0.12 }), market(), "scale_in");

      expect(ctx.orders).toEqual([pending]);
      expect(ctx.repo.getLadder(tokenId)?.ladderId).toBe(originalState.ladderId);
      expect(ctx.counters).toContainEqual({
        name: "profile_ladder_rebuild_deferred_due_pending_order",
        value: 1,
        labels: '{"band":"medium_low"}',
      });
    });

    it("backfills OrderPlaced for an old pending rung after a deferred rebuild", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
      const pending = await placePendingRung(ctx);
      const exchangeOrderId = createOrderId("old-pending-profile-ladder-order");

      await ctx.module.rebuildLadder(position({ avgEntryPrice: 0.12 }), market(), "scale_in");
      await ctx.bus.publish("OrderPlaced", orderPlaced(pending, exchangeOrderId));

      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        orderId: String(exchangeOrderId),
        lifecycle: "placed",
      });
    });

    it("keeps cap=1 and rate-limits telemetry while the pending rung blocks rebuilds", async () => {
      let nowMs = NOW;
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" }, now: () => nowMs });
      await placePendingRung(ctx);

      await ctx.module.rebuildLadder(position({ avgEntryPrice: 0.12 }), market(), "scale_in");
      await ctx.module.rebuildLadder(
        position({ avgEntryPrice: 0.13 }),
        market(),
        "profile_reclass",
      );

      expect(ctx.orders).toHaveLength(1);
      expect(
        ctx.counters.filter(
          (counter) => counter.name === "profile_ladder_rebuild_deferred_due_pending_order",
        ),
      ).toHaveLength(1);

      nowMs = NOW + PLANNED_RUNG_RETRY_MS + 1;
      await ctx.module.rebuildLadder(position({ avgEntryPrice: 0.14 }), market(), "scale_in");

      expect(ctx.orders).toHaveLength(1);
      expect(
        ctx.counters.filter(
          (counter) => counter.name === "profile_ladder_rebuild_deferred_due_pending_order",
        ),
      ).toHaveLength(2);
    });

    it("continues normal rebuild placement once a pending rung is rejected", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
      const pending = await placePendingRung(ctx);

      await ctx.bus.publish("OrderRejected", orderRejected(pending));
      await ctx.module.rebuildLadder(position({ avgEntryPrice: 0.12 }), market(), "scale_in");

      expect(ctx.orders).toHaveLength(2);
      expect(ctx.orders[1]).toMatchObject({ price: 0.132, side: "sell" });
    });

    it("continues normal rebuild placement once a pending rung is skipped", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
      const pending = await placePendingRung(ctx);

      await ctx.bus.publish("OrderSkipped", orderSkipped(pending));
      await ctx.module.rebuildLadder(position({ avgEntryPrice: 0.12 }), market(), "scale_in");

      expect(ctx.orders).toHaveLength(2);
      expect(ctx.orders[1]).toMatchObject({ price: 0.132, side: "sell" });
    });

    it("does not count non-profile legacy pending orders as profile-ladder occupancy", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
      await ctx.module.start();
      await ctx.bus.publish("PlaceOrderRequested", {
        command: legacyPlaceOrder(),
        timestamp: NOW,
      });

      await ctx.module.placeLadder(position(), market());

      expect(ctx.orders).toHaveLength(2);
      expect(ctx.orders[0]?.metadata?.source).toBe("s1");
      expect(ctx.orders[1]?.metadata?.source).toBe("profile_ladder");
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

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.repo.getLadder(tokenId)?.band).toBe("medium_low");
  });

  it("does not double-subscribe when start is called repeatedly while enabled", async () => {
    const ctx = setup();

    await ctx.module.start();
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });
    await ctx.bus.publish("PositionUpdated", { position: position() });

    expect(ctx.orders).toHaveLength(1);
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

  it("places only one live rung under the default cap while storing the full planned vector", async () => {
    const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });

    await ctx.module.placeLadder(position(), market());

    // Builder still computes the full 4-rung vector for later recompute...
    const state = ctx.repo.getLadder(tokenId);
    expect(state?.activeRungs).toHaveLength(4);
    // ...but only the first (lowest-price) live rung is actually submitted.
    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]).toMatchObject({ price: 0.11, size: 95, side: "sell" });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_planned_rungs",
      value: 4,
      labels: '{"band":"medium_low"}',
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_placed_live_rungs",
      value: 1,
      labels: '{"band":"medium_low"}',
    });
  });

  it("places two live rungs only when the band is configured for a cap of 2", async () => {
    const ctx = setup(
      policy({
        bands: {
          ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands,
          medium_low: {
            ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.medium_low,
            enabled: true,
            maxConcurrentRungs: 2,
          },
        },
      }),
      { modeReader: { getMode: () => "flat" } },
    );

    await ctx.module.placeLadder(position(), market());

    expect(ctx.orders).toHaveLength(2);
    expect(ctx.orders.map((order) => order.price)).toEqual([0.11, 0.13]);
    expect(ctx.repo.getLadder(tokenId)?.activeRungs).toHaveLength(4);
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_placed_live_rungs",
      value: 2,
      labels: '{"band":"medium_low"}',
    });
  });

  it("never places more live rungs than the available planned rungs", async () => {
    // costBasis < 5 → builder yields a single rung; a cap of 2 still places one.
    const ctx = setup(
      policy({
        bands: {
          ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands,
          medium_low: {
            ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.medium_low,
            enabled: true,
            maxConcurrentRungs: 2,
          },
        },
      }),
      { modeReader: { getMode: () => "flat" } },
    );

    await ctx.module.placeLadder(position({ costBasisUsdc: 4, size: 40 }), market());

    expect(ctx.repo.getLadder(tokenId)?.activeRungs).toHaveLength(1);
    expect(ctx.orders).toHaveLength(1);
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_placed_live_rungs",
      value: 1,
      labels: '{"band":"medium_low"}',
    });
  });

  describe("post-fill REST and cooldown-gated reevaluation (Plankton)", () => {
    async function placeAndBackfill(ctx: ReturnType<typeof setup>): Promise<void> {
      await ctx.module.start();
      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });
      await ctx.bus.publish("PositionUpdated", { position: position() });
      // Backfill the single live rung's exchange orderId so the fill can match it.
      await ctx.bus.publish("OrderPlaced", {
        commandId: ctx.orders[0]!.commandId,
        clientOrderId: ctx.orders[0]!.clientOrderId,
        orderId: createOrderId("profile-ladder-bottom-rung"),
        tokenId,
        conditionId,
        side: "sell",
        price: ctx.orders[0]!.price,
        size: ctx.orders[0]!.size,
        orderType: "GTC",
        signalReason: "profile-ladder-exit",
        timestamp: NOW + 1_000,
      });
    }

    it("rests after a full bottom-rung SELL fill, then places the next rung only once the cooldown elapses", async () => {
      vi.useFakeTimers();
      try {
        const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
        await placeAndBackfill(ctx);
        expect(ctx.orders).toHaveLength(1);

        await ctx.bus.publish(
          "FillReceived",
          fill({ orderId: createOrderId("profile-ladder-bottom-rung"), size: 95 }),
        );

        // A full fill RESTS: no immediate next-rung placement, only telemetry.
        expect(ctx.orders).toHaveLength(1);
        expect(ctx.counters).toContainEqual({
          name: "profile_ladder_fill_position",
          value: 1,
          labels: '{"position":"bottom","fillType":"full","band":"medium_low"}',
        });
        expect(ctx.counters).toContainEqual({
          name: "profile_ladder_post_fill_delay_ms",
          value: 900_000,
          labels: '{"band":"medium_low"}',
        });

        // The next planned rung appears only after the rest cooldown elapses.
        await vi.advanceTimersByTimeAsync(900_000 + 1);

        expect(ctx.orders).toHaveLength(2);
        expect(ctx.orders[1]).toMatchObject({ price: 0.13, size: 60, side: "sell" });
        expect(ctx.counters).toContainEqual({
          name: "profile_ladder_post_fill_action",
          value: 1,
          labels: '{"action":"place_next","band":"medium_low"}',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("rests on a partial SELL fill and never duplicates the live rung at reevaluation", async () => {
      vi.useFakeTimers();
      try {
        const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
        await placeAndBackfill(ctx);

        await ctx.bus.publish(
          "FillReceived",
          fill({ orderId: createOrderId("profile-ladder-bottom-rung"), size: 50 }),
        );

        expect(ctx.orders).toHaveLength(1);
        expect(ctx.counters).toContainEqual({
          name: "profile_ladder_fill_position",
          value: 1,
          labels: '{"position":"bottom","fillType":"partial","band":"medium_low"}',
        });

        // The partially filled rung still occupies the single live slot, so the
        // cooldown reevaluation rests instead of placing a duplicate rung.
        await vi.advanceTimersByTimeAsync(900_000 + 1);

        expect(ctx.orders).toHaveLength(1);
        expect(ctx.counters).toContainEqual({
          name: "profile_ladder_post_fill_action",
          value: 1,
          labels: '{"action":"rest","band":"medium_low"}',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not chase up after a top-rung fill once the cooldown elapses", async () => {
      vi.useFakeTimers();
      try {
        const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
        const topOrderId = createOrderId("profile-ladder-top-rung");
        ctx.repo.upsertLadder(
          ladderState({
            activeRungs: [
              rung({
                rungIndex: 0,
                price: 0.11,
                sizeShares: 95,
                lifecycle: "filled",
                orderId: "r0",
                filledSizeShares: 95,
              }),
              rung({
                rungIndex: 1,
                price: 0.13,
                sizeShares: 60,
                lifecycle: "filled",
                orderId: "r1",
                filledSizeShares: 60,
              }),
              rung({
                rungIndex: 2,
                price: 0.155,
                sizeShares: 50,
                lifecycle: "filled",
                orderId: "r2",
                filledSizeShares: 50,
              }),
              rung({
                rungIndex: 3,
                price: 0.165,
                sizeShares: 45,
                lifecycle: "placed",
                orderId: String(topOrderId),
                filledSizeShares: 0,
              }),
            ],
          }),
        );

        await ctx.module.start();
        await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });
        await ctx.bus.publish("FillReceived", fill({ orderId: topOrderId, size: 45 }));

        expect(ctx.orders).toHaveLength(0);
        expect(ctx.counters).toContainEqual({
          name: "profile_ladder_fill_position",
          value: 1,
          labels: '{"position":"top","fillType":"full","band":"medium_low"}',
        });

        // No planned rungs remain above the top: the reevaluation rests, never
        // chasing the price up with a new taker-like rung.
        await vi.advanceTimersByTimeAsync(900_000 + 1);

        expect(ctx.orders).toHaveLength(0);
        expect(ctx.counters).toContainEqual({
          name: "profile_ladder_post_fill_action",
          value: 1,
          labels: '{"action":"rest","band":"medium_low"}',
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("post-only crossing guard (Plankton no-taker-sell)", () => {
    it("skips a crossing rung and rests the live slot above the bid", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });

      // bestBid 0.115 sits at/above the lowest planned rung (0.11): a post-only
      // SELL there would cross and execute as a taker, so it must be skipped.
      // The next planned rung (0.13) rests above the bid as a maker instead.
      await ctx.module.placeLadder(position(), market({ bestBid: 0.115, bestAsk: 0.13 }));

      expect(ctx.orders).toHaveLength(1);
      expect(ctx.orders[0]).toMatchObject({ price: 0.13, side: "sell" });
      expect(ctx.orders.some((order) => order.price <= 0.115)).toBe(false);
      expect(ctx.counters).toContainEqual({
        name: "profile_ladder_skipped_crossing_post_only",
        value: 1,
        labels: '{"band":"medium_low"}',
      });
    });

    it("rests entirely when every planned rung would cross the bid", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });

      // bestBid 0.2 is above every planned rung (0.11..0.165): no rung can rest
      // as a maker, so nothing is submitted — no taker sell is ever produced.
      await ctx.module.placeLadder(position(), market({ bestBid: 0.2, bestAsk: 0.21 }));

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.counters).toContainEqual({
        name: "profile_ladder_placed_live_rungs",
        value: 0,
        labels: '{"band":"medium_low"}',
      });
    });
  });

  describe("ExecutionModule compatibility (no profile-ladder special-casing)", () => {
    function clientOrderIdFor(ladderId: string, rungIndex: number) {
      return buildClientOrderId({
        signalId: `profile_ladder_${String(tokenId)}_${ladderId}_${rungIndex}`,
        tokenId,
        side: "sell",
      });
    }

    it("submits each live rung with a distinct, deterministic clientOrderId and never self-cancels", async () => {
      const ctx = setup(
        policy({
          bands: {
            ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands,
            medium_low: {
              ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.medium_low,
              enabled: true,
              maxConcurrentRungs: 2,
            },
          },
        }),
        { modeReader: { getMode: () => "flat" } },
      );

      await ctx.module.placeLadder(position(), market());

      const ladderId = ctx.repo.getLadder(tokenId)!.ladderId;
      expect(ctx.orders).toHaveLength(2);
      // Deterministic per (ladderId, rungIndex): the exchange dedupes a replay
      // of the same rung, so no ExecutionModule-side ladder logic is required.
      expect(ctx.orders[0]?.clientOrderId).toBe(clientOrderIdFor(ladderId, 0));
      expect(ctx.orders[1]?.clientOrderId).toBe(clientOrderIdFor(ladderId, 1));
      // Distinct per rung so two live rungs never collide on the exchange.
      expect(ctx.orders[0]?.clientOrderId).not.toBe(ctx.orders[1]?.clientOrderId);
      // Placement never cancels a sibling rung — the ladder rests, it does not churn.
      expect(ctx.cancels).toHaveLength(0);
    });

    it("places the post-fill next rung with its own clientOrderId without cancelling the filled rung", async () => {
      vi.useFakeTimers();
      try {
        const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
        await ctx.module.start();
        await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });
        await ctx.bus.publish("PositionUpdated", { position: position() });
        await ctx.bus.publish("OrderPlaced", {
          commandId: ctx.orders[0]!.commandId,
          clientOrderId: ctx.orders[0]!.clientOrderId,
          orderId: createOrderId("profile-ladder-bottom-rung"),
          tokenId,
          conditionId,
          side: "sell",
          price: ctx.orders[0]!.price,
          size: ctx.orders[0]!.size,
          orderType: "GTC",
          signalReason: "profile-ladder-exit",
          timestamp: NOW + 1_000,
        });
        await ctx.bus.publish(
          "FillReceived",
          fill({ orderId: createOrderId("profile-ladder-bottom-rung"), size: 95 }),
        );

        await vi.advanceTimersByTimeAsync(900_000 + 1);

        const ladderId = ctx.repo.getLadder(tokenId)!.ladderId;
        expect(ctx.orders).toHaveLength(2);
        expect(ctx.orders[0]?.clientOrderId).toBe(clientOrderIdFor(ladderId, 0));
        expect(ctx.orders[1]?.clientOrderId).toBe(clientOrderIdFor(ladderId, 1));
        // The just-filled rung is never cancelled to make room for the next one.
        expect(ctx.cancels).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
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
    return ctx.riskEvents.find((event) => event.eventType === "ladder_adoption_summary")
      ?.payload as Record<string, unknown> | undefined;
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

  it("keeps adoption flat when modeReader dark compare maps BURST to up", async () => {
    const ctx = setup(
      adoptionPolicy({
        modeReader: darkModeReaderConfig(),
      } as Partial<ExecutionProfilePolicy["sellLadder"]>),
      {
        positionRepo: { findOpen: () => [position()] },
        orderRepo: { findByTokenId: () => [] },
        isProfileOwned: () => true,
        modeCandidateReader: {
          getCandidate: () =>
            modeCandidate({
              sourceMode: "BURST",
              mappedMode: "up",
              modeStatus: "confirmed",
              modeConfidence: "high",
            }),
        },
      },
    );

    await warmAndAdopt(ctx);

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.price).toBe(0.11);
    expect(ctx.repo.getLadder(tokenId)?.lastMode).toBe("flat");
    expect(counterLabels(ctx.counters, "profile_ladder_mode_reader_delta")).toContainEqual({
      source: "algo_token_mode_state",
      sourceMode: "BURST",
      mappedCandidate: "up",
      localMode: "flat",
      modeStatus: "confirmed",
      modeConfidence: "high",
    });
  });

  it("recovers a profile-owned position skipped for missing market on a later market update", async () => {
    vi.useFakeTimers();
    try {
      const ctx = setup(adoptionPolicy(), {
        positionRepo: { findOpen: () => [position()] },
        orderRepo: { findByTokenId: () => [] },
        isProfileOwned: () => true,
      });

      await ctx.module.start();
      await ctx.module.adoptExistingLadders();
      for (let i = 1; i < MAX_ADOPTION_ATTEMPTS; i += 1) {
        await vi.advanceTimersByTimeAsync(ADOPTION_RETRY_MS + 1);
      }

      expect(ctx.repo.getLadder(tokenId)).toBeNull();
      expect(ctx.orders).toHaveLength(0);
      expect(
        ctx.riskEvents.filter((event) => event.eventType === "ladder_adoption_summary"),
      ).toHaveLength(MAX_ADOPTION_ATTEMPTS);

      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market()],
        timestamp: NOW + 1_000,
      });

      expect(ctx.repo.getLadder(tokenId)).toMatchObject({ band: "medium_low", lastMode: "flat" });
      expect(ctx.orders).toHaveLength(1);
      expect(ctx.counters).toContainEqual({
        name: "profile_ladder_adopted",
        value: 1,
        labels: '{"band":"medium_low"}',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not recover a missing ladder while an existing non-profile SELL order is open", async () => {
    vi.useFakeTimers();
    try {
      let hasBlockingSell = true;
      const ctx = setup(adoptionPolicy(), {
        positionRepo: { findOpen: () => [position()] },
        orderRepo: { findByTokenId: () => (hasBlockingSell ? [openSellOrder()] : []) },
        isProfileOwned: () => true,
      });

      await ctx.module.start();
      await ctx.module.adoptExistingLadders();
      for (let i = 1; i < MAX_ADOPTION_ATTEMPTS; i += 1) {
        await vi.advanceTimersByTimeAsync(ADOPTION_RETRY_MS + 1);
      }

      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market()],
        timestamp: NOW + 1_000,
      });

      expect(ctx.repo.getLadder(tokenId)).toBeNull();
      expect(ctx.orders).toHaveLength(0);

      hasBlockingSell = false;
      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market()],
        timestamp: NOW + 2_000,
      });

      expect(ctx.repo.getLadder(tokenId)).toBeNull();
      expect(ctx.orders).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not recover a missing ladder from an invalid BBO and cooldown-gates immediate retry", async () => {
    vi.useFakeTimers();
    try {
      const ctx = setup(adoptionPolicy(), {
        positionRepo: { findOpen: () => [position()] },
        orderRepo: { findByTokenId: () => [] },
        isProfileOwned: () => true,
      });

      await ctx.module.start();
      await ctx.module.adoptExistingLadders();
      for (let i = 1; i < MAX_ADOPTION_ATTEMPTS; i += 1) {
        await vi.advanceTimersByTimeAsync(ADOPTION_RETRY_MS + 1);
      }

      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market({ bestBid: 0.12, bestAsk: 0.11 })],
        timestamp: NOW + 1_000,
      });

      expect(ctx.repo.getLadder(tokenId)).toBeNull();
      expect(ctx.orders).toHaveLength(0);

      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market()],
        timestamp: NOW + 2_000,
      });

      expect(ctx.repo.getLadder(tokenId)).toBeNull();
      expect(ctx.orders).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
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

    expect(ctx.orders).toHaveLength(1);
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

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.repo.getLadder(tokenId)).toMatchObject({ band: "medium_low", lastMode: "flat" });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_adopted",
      value: 1,
      labels: '{"band":"medium_low"}',
    });
    expect(summaryOf(ctx)).toMatchObject({
      eligible_count: 1,
      adopted_count: 1,
      estimated_order_count: 1,
      skipped_existing_ladder: 0,
      skipped_missing_market: 0,
      skipped_not_profile_owned: 0,
      skipped_band_disabled: 0,
      skipped_existing_sell_order: 0,
    });
    const adopted = ctx.riskEvents.find((event) => event.eventType === "ladder_adopted");
    expect(adopted?.payload).toMatchObject({ band: "medium_low", source: "adopted" });
  });

  it("records the planned versus live rung counts in the adoption summary", async () => {
    const ctx = setup(adoptionPolicy(), {
      positionRepo: { findOpen: () => [position()] },
      isProfileOwned: () => true,
    });

    await warmAndAdopt(ctx);

    // The full medium_low ladder plans four rungs; under the default cap only
    // one goes live, so the summary contrasts the planned target with reality.
    expect(summaryOf(ctx)).toMatchObject({
      adopted_count: 1,
      planned_rung_count: 4,
      estimated_order_count: 1,
    });
  });

  it("records unknown min order size skips in the adoption summary", async () => {
    const ctx = setup(adoptionPolicy(), {
      positionRepo: { findOpen: () => [position()] },
      isProfileOwned: () => true,
    });

    await ctx.module.start();
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ minOrderSize: null })],
      timestamp: NOW,
    });
    await ctx.module.adoptExistingLadders();

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
      lifecycle: "planned",
      orderId: null,
    });
    expect(summaryOf(ctx)).toMatchObject({
      adopted_count: 1,
      planned_rung_count: 4,
      estimated_order_count: 0,
      placed_live_rung_count: 0,
      skipped_unknown_min_order_size: 1,
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_skipped_unknown_min_order_size",
      value: 1,
      labels: '{"band":"medium_low"}',
    });
  });

  it("is idempotent across repeated adoption runs", async () => {
    const ctx = setup(adoptionPolicy(), {
      positionRepo: { findOpen: () => [position()] },
      isProfileOwned: () => true,
    });

    await warmAndAdopt(ctx);
    await ctx.module.adoptExistingLadders();

    expect(ctx.orders).toHaveLength(1);
    expect(
      ctx.riskEvents.filter((event) => event.eventType === "ladder_adoption_summary"),
    ).toHaveLength(1);
    expect(
      ctx.counters.filter((counter) => counter.name === "profile_ladder_adopted"),
    ).toHaveLength(1);
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
        expect(ctx.orders).toHaveLength(1);
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

        expect(ctx.orders).toHaveLength(1);
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
        expect(ctx.orders).toHaveLength(1);
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

  describe("positive floor telemetry (GAP-2)", () => {
    it("emits profile_ladder_rung_price_floored when the floor changes a rung price", async () => {
      const ctx = setup(mediumHighPolicy(), { modeReader: { getMode: () => "up" } });

      await ctx.module.placeLadder(
        position({ avgEntryPrice: 0.2, costBasisUsdc: 25, size: 250 }),
        market({ tickSize: 0.01 }),
      );

      expect(counterLabels(ctx.counters, "profile_ladder_rung_price_floored")).toContainEqual({
        band: "medium_high",
        mode: "up",
        rungIndex: "0",
      });
    });

    it("does not emit profile_ladder_rung_price_floored when no rung is below the floor", async () => {
      const ctx = setup(mediumHighPolicy(), { modeReader: { getMode: () => "avg_down" } });

      await ctx.module.placeLadder(
        position({ avgEntryPrice: 0.2, costBasisUsdc: 25, size: 250 }),
        market({ tickSize: 0.01 }),
      );

      expect(counterLabels(ctx.counters, "profile_ladder_rung_price_floored")).toHaveLength(0);
    });
  });
});

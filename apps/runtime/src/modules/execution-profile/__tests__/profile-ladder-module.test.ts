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
  type ExecutionProfileSellLadderConfig,
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
  MAX_RECOVERY_ZERO_PLACED_RECOVERIES,
  PLANNED_RUNG_RETRY_MS,
  ProfileLadderModule,
  evaluatePostRefillLiveRung,
  type ProfileLadderBookCache,
  type ProfileLadderModeCandidate,
  type ProfileLadderModeReaderConfig,
  type ProfileLadderPositionReader,
} from "../profile-ladder-module.js";
import type { ProfileLadderRepository } from "../profile-ladder-repository.js";
import type { ExecutionProfilePolicy, ProfileState } from "../types.js";

const tokenId = createTokenId("profile-ladder-token");
const conditionId = createConditionId("profile-ladder-condition");
const NOW = Date.parse("2026-06-15T00:00:00.000Z");
const SHADOW_PLANKTON_POLICY = {
  enabled: true,
  writeRiskEvents: true,
  variants: ["p25", "median", "cheap_tail"],
  liveBehaviorEnabled: false,
  riskEventDedupeMs: 600_000,
  bands: {
    lt_0_005: {
      p25: 1.5,
      median: 2.33,
      p75: 4.5,
      observedMedianFirstFraction: 0.7,
      sampleSize: 1166,
    },
    gte_0_005_lt_0_01: {
      p25: 1.2,
      median: 1.47,
      p75: 2,
      observedMedianFirstFraction: 1,
      sampleSize: 531,
    },
    gte_0_01_lt_0_02: {
      p25: 1.14,
      median: 1.36,
      p75: 1.73,
      observedMedianFirstFraction: 1,
      sampleSize: 1455,
    },
    gte_0_02_lt_0_05: {
      p25: 1.1,
      median: 1.23,
      p75: 1.46,
      observedMedianFirstFraction: 1,
      sampleSize: 3918,
    },
    gte_0_05_lt_0_10: {
      p25: 1.1,
      median: 1.19,
      p75: 1.43,
      observedMedianFirstFraction: 1,
      sampleSize: 2390,
    },
    gte_0_10: {
      p25: 1.06,
      median: 1.13,
      p75: 1.25,
      observedMedianFirstFraction: 1,
      sampleSize: 11531,
    },
  },
} satisfies ExecutionProfileSellLadderConfig["shadowPlanktonPolicy"];

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
    shadowPlanktonPolicy: {
      ...SHADOW_PLANKTON_POLICY,
      enabled: false,
    },
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
    positionRepo?: Partial<ProfileLadderPositionReader>;
    orderRepo?: {
      findByTokenId: (token: TokenId) => Order[];
      findByClientOrderId?: (clientOrderId: string) => Order | null;
    };
    isProfileOwned?: (token: TokenId) => boolean;
    profileStateReader?: { getProfileState: (token: TokenId) => ProfileState | null };
    onPolicyReload?: (handler: () => void) => () => void;
    bookCache?: ProfileLadderBookCache;
    runtimeMode?: "simulation" | "paper" | "live-lite";
    makerEntryPolicy?: () => { harvestGainPct: number };
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
  const suppliedPositionRepo = overrides.positionRepo;
  const normalizedPositionRepo: ProfileLadderPositionReader | undefined =
    suppliedPositionRepo == null
      ? undefined
      : {
          findOpen: suppliedPositionRepo.findOpen ?? (() => []),
          findDust: suppliedPositionRepo.findDust ?? (() => []),
          findActiveByTokenId:
            suppliedPositionRepo.findActiveByTokenId ??
            ((id) =>
              [
                ...(suppliedPositionRepo.findOpen?.() ?? []),
                ...(suppliedPositionRepo.findDust?.() ?? []),
              ].filter((candidate) => candidate.tokenId === id)),
        };
  bus.subscribe("PlaceOrderRequested", async ({ command }) => {
    orders.push(command);
  });
  bus.subscribe("CancelOrderRequested", async ({ command }) => {
    cancels.push(String(command.orderId));
  });
  const {
    isDormant: _removedDormantGate,
    positionRepo: _positionRepo,
    ...moduleOverrides
  } = overrides;
  const module = new ProfileLadderModule({
    bus,
    repository: repo,
    policy: () => policyRef.current,
    ...moduleOverrides,
    ...(normalizedPositionRepo == null ? {} : { positionRepo: normalizedPositionRepo }),
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
  sellLadderOverrides: Partial<ExecutionProfilePolicy["sellLadder"]> = {},
): ExecutionProfilePolicy {
  return policy({
    ...sellLadderOverrides,
    postRefillFollowThrough: {
      ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.postRefillFollowThrough,
      ...overrides,
    },
  });
}

function cheapPostRefillPolicy(
  overrides: Partial<ExecutionProfilePolicy["sellLadder"]["postRefillFollowThrough"]> = {},
): ExecutionProfilePolicy {
  return postRefillPolicy(overrides, {
    bands: {
      ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands,
      cheap: {
        ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.cheap,
        enabled: true,
      },
      medium_low: {
        ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.medium_low,
        enabled: true,
      },
    },
  });
}

describe("ProfileLadderModule", () => {
  it("bounds its market cache across tracked removal and restart", async () => {
    const ctx = setup();
    const retainedTokenId = createTokenId("profile-ladder-retained-token");
    const cache = (ctx.module as any).marketByToken as Map<string, NormalizedMarket>;
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market(), market({ tokenId: retainedTokenId })],
      timestamp: NOW,
    });
    await ctx.bus.publish("TrackedMarketsChanged", {
      addedTokenIds: [],
      removedTokenIds: [tokenId],
      activeTokenIds: [retainedTokenId],
      timestamp: NOW,
    });

    expect.soft([...cache.keys()]).toEqual([String(retainedTokenId)]);
    await ctx.module.stop();
    expect.soft(cache.size).toBe(0);
    await ctx.module.start();
    expect.soft(cache.size).toBe(0);

    const refreshed = market();
    await ctx.bus.publish("NormalizedMarketUpdated", { markets: [refreshed], timestamp: NOW });
    expect(cache.get(String(tokenId))).toBe(refreshed);
    await ctx.module.stop();
  });

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

  it("emits Plankton shadow telemetry without changing live ladder placement", async () => {
    const shadowPolicy = policy({
      shadowPlanktonPolicy: {
        ...SHADOW_PLANKTON_POLICY,
        enabled: true,
        writeRiskEvents: true,
        variants: ["p25", "median", "cheap_tail"],
      },
    });
    const liveOnly = setup();
    const shadow = setup(shadowPolicy, {
      profileStateReader: { getProfileState: () => "HARVESTING" },
    });

    await liveOnly.module.placeLadder(position({ avgEntryPrice: 0.1 }), market());
    await shadow.module.placeLadder(position({ avgEntryPrice: 0.1 }), market());

    expect(shadow.orders).toHaveLength(liveOnly.orders.length);
    expect(shadow.cancels).toHaveLength(0);
    expect(shadow.orders[0]).toMatchObject({
      side: liveOnly.orders[0]?.side,
      price: liveOnly.orders[0]?.price,
      size: liveOnly.orders[0]?.size,
      metadata: liveOnly.orders[0]?.metadata,
    });
    expect(shadow.repo.getLadder(tokenId)?.activeRungs).toEqual(
      liveOnly.repo.getLadder(tokenId)?.activeRungs,
    );
    expect(
      counterLabels(shadow.counters, "profile_ladder_shadow_candidate_evaluated_total"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variant: "p25",
          band: "gte_0_10",
          mode: "up",
          state: "harvesting",
        }),
      ]),
    );
    expect(
      shadow.riskEvents.some(
        (event) => event.eventType === "profile_ladder_shadow_candidate_sampled",
      ),
    ).toBe(true);
    expect(JSON.stringify(shadow.counters)).not.toContain(String(tokenId));
    expect(JSON.stringify(shadow.counters)).not.toContain(String(conditionId));
    expect(JSON.stringify(shadow.counters)).not.toContain("clientOrderId");
  });

  it("keeps Plankton shadow disabled silent", async () => {
    const ctx = setup();

    await ctx.module.placeLadder(position({ avgEntryPrice: 0.1 }), market());

    expect(ctx.counters.some((counter) => counter.name.startsWith("profile_ladder_shadow_"))).toBe(
      false,
    );
    expect(ctx.riskEvents.some((event) => event.eventType.includes("shadow_candidate"))).toBe(
      false,
    );
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

  it("places SELL coverage from an ask-only book without synthesizing a bid", async () => {
    const ctx = setup();

    await ctx.module.placeLadder(position(), market({ bestBid: null, bestAsk: 0.11 }));

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]).toMatchObject({ side: "sell", postOnly: true });
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

  it("keeps SELL coverage active for a dormant position", async () => {
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
      lastCostBasisUsdc: 35,
    });
    expect(ctx.counters.some((counter) => counter.name === "ladder_rebuild_skipped_dormant")).toBe(
      false,
    );
  });

  it("rebuilds on BBO move and respects the 30-minute cooldown", async () => {
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [position()] },
    });
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

  // Phase 6: patient reprice — maker-tagged positions only reprice on bbo_strong (≥10%)
  it("skips bbo_major reprice for maker-tagged position (patient reprice)", async () => {
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [position({ entryStyle: "maker" })] },
    });
    ctx.repo.upsertLadder(ladderState());
    await ctx.module.start();

    // 7.78% bid move: above majorBboMovePct (5%) but below strongBboMovePct (10%) → bbo_major
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.097, bestAsk: 0.117, midPrice: 0.107 })],
      timestamp: NOW,
    });

    // No rebuild counter for maker + bbo_major
    expect(ctx.counters.filter((c) => c.name === "profile_ladder_rebuilt")).toHaveLength(0);
    // BBO reference is NOT updated — the sell rests undisturbed
    expect(ctx.repo.getLadder(tokenId)?.lastBboReferenceJson).toBe(
      JSON.stringify({ bestBid: 0.09, bestAsk: 0.11 }),
    );
  });

  it("allows bbo_strong reprice for maker-tagged position (patient reprice)", async () => {
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [position({ entryStyle: "maker" })] },
    });
    ctx.repo.upsertLadder(ladderState());
    await ctx.module.start();

    // 11.1% bid move: above strongBboMovePct (10%) → bbo_strong; maker should rebuild
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.08, bestAsk: 0.1, midPrice: 0.09 })],
      timestamp: NOW,
    });

    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_rebuilt",
      value: 1,
      labels: '{"band":"medium_low","reason":"bbo_strong"}',
    });
  });

  it("probe position still reprices on bbo_major (non-maker cadence unchanged)", async () => {
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [position({ entryStyle: "probe" })] },
    });
    ctx.repo.upsertLadder(ladderState());
    await ctx.module.start();

    // Same 7.78% move: non-maker (probe) position MUST rebuild
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.097, bestAsk: 0.117, midPrice: 0.107 })],
      timestamp: NOW,
    });

    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_rebuilt",
      value: 1,
      labels: '{"band":"medium_low","reason":"bbo_major"}',
    });
    // BBO reference IS updated for non-maker
    expect(ctx.repo.getLadder(tokenId)?.lastBboReferenceJson).toBe(
      JSON.stringify({ bestBid: 0.097, bestAsk: 0.117 }),
    );
  });

  it("closes a stale active live-rung ladder without a position before a BBO rebuild", async () => {
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [] },
      orderRepo: { findByTokenId: () => [] },
    });
    ctx.repo.upsertLadder(ladderState());
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.07, bestAsk: 0.09, midPrice: 0.08 })],
      timestamp: NOW,
    });

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.cancels).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)).toMatchObject({
      status: "closed",
      closedAtMs: NOW,
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_stale_no_position_closed",
      value: 1,
      labels: '{"band":"medium_low","source":"bbo_rebuild","reason":"no_open_sell"}',
    });
  });

  it("fails closed when a no-position BBO rebuild sees an open SELL", async () => {
    let nowMs = NOW;
    const openProfileOrder = openSellOrder({
      orderId: createOrderId("profile-ladder-order"),
      decisionRuleId: "PROFILE_LADDER",
      signalReason: "profile-ladder-exit",
      metadata: { source: "profile_ladder" },
      status: OrderStatus.Open,
    });
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [] },
      orderRepo: { findByTokenId: () => [openProfileOrder] },
      now: () => nowMs,
    });
    ctx.repo.upsertLadder(ladderState());
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.07, bestAsk: 0.09, midPrice: 0.08 })],
      timestamp: nowMs,
    });
    nowMs = NOW + PLANNED_RUNG_RETRY_MS - 1;
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.06, bestAsk: 0.08, midPrice: 0.07 })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.cancels).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)).toMatchObject({
      status: "active",
      activeRungs: [{ orderId: "profile-ladder-order", lifecycle: "placed" }],
    });
    expect(
      ctx.counters.filter((counter) => counter.name === "profile_ladder_stale_no_position_skipped"),
    ).toEqual([
      {
        name: "profile_ladder_stale_no_position_skipped",
        value: 1,
        labels: '{"band":"medium_low","source":"bbo_rebuild","reason":"open_sell_exists"}',
      },
    ]);
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

  it("places a live rung via the live-lite fallback when market min order size is unknown", async () => {
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      runtimeMode: "live-lite",
    });

    await ctx.module.placeLadder(position(), market({ minOrderSize: null }));

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]).toMatchObject({
      price: 0.11,
      size: 95,
      side: "sell",
      postOnly: true,
      metadata: {
        marketData: {
          minOrderSize: 1,
          effectiveMinOrderSize: 1,
          minOrderSource: "fallback",
        },
      },
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_min_order_size_hydration_miss",
      value: 1,
      labels: '{"band":"medium_low","reason":"cache_refresh_failed"}',
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_min_order_fallback_total",
      value: 1,
      labels: '{"band":"medium_low","result":"fallback_used"}',
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_placed_live_rungs",
      value: 1,
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

  it("keeps rung planned and fails closed in non-live-lite when min order size is unknown", async () => {
    const bookCache = {
      getFreshOrRefresh: vi.fn(async () => ({
        entry: null,
        status: "cache-miss" as const,
      })),
    };
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      bookCache,
      runtimeMode: "paper",
    });

    await ctx.module.placeLadder(position(), market({ minOrderSize: null }));

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
      lifecycle: "planned",
      orderId: null,
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_min_order_size_hydration_miss",
      value: 1,
      labels: '{"band":"medium_low","reason":"cache_refresh_failed"}',
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_min_order_fallback_total",
      value: 1,
      labels: '{"band":"medium_low","result":"fallback_unavailable"}',
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_skipped_unknown_min_order_size",
      value: 1,
      labels: '{"band":"medium_low"}',
    });
  });

  it("places a live rung via fallback when the book cache returns a book without min order size", async () => {
    const bookCache = {
      getFreshOrRefresh: vi.fn(async () => ({
        entry: {
          tokenId: String(tokenId),
          snapshotTs: NOW,
          cachedAtMs: NOW,
          sourcePolledAtMs: NOW,
          bookSource: "clob" as const,
          sourceKind: "rest" as const,
          book: orderBook({ minOrderSize: 0 }),
        },
        status: "refreshed" as const,
      })),
    };
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      bookCache,
      runtimeMode: "live-lite",
    });

    await ctx.module.placeLadder(position(), market({ minOrderSize: null }));

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.metadata).toMatchObject({
      marketData: {
        minOrderSize: 1,
        effectiveMinOrderSize: 1,
        minOrderSource: "fallback",
      },
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_min_order_size_hydration_miss",
      value: 1,
      labels: '{"band":"medium_low","reason":"no_market_min_order"}',
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_min_order_fallback_total",
      value: 1,
      labels: '{"band":"medium_low","result":"fallback_used"}',
    });
  });

  it("places five low-price shares even when their notional is below the live-lite fallback size", async () => {
    let nowMs = NOW;
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [position()] },
      runtimeMode: "live-lite",
      now: () => nowMs,
    });
    await ctx.module.start();
    ctx.repo.upsertLadder(
      ladderState({
        activeRungs: [
          rung({
            lifecycle: "planned",
            orderId: null,
            price: 0.04,
            sizeShares: 5,
            notionalUsd: 0.2,
          }),
        ],
      }),
    );
    nowMs = NOW + PLANNED_RUNG_RETRY_MS + 1;

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.03, bestAsk: 0.05, midPrice: 0.04, minOrderSize: null })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]).toMatchObject({ price: 0.04, size: 5 });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_min_order_fallback_total",
      value: 1,
      labels: '{"band":"medium_low","result":"fallback_used"}',
    });
  });

  it("skips a crossing planned rung before consulting the live-lite fallback", async () => {
    let nowMs = NOW;
    const ctx = setup(policy(), {
      positionRepo: { findOpen: () => [position()] },
      runtimeMode: "live-lite",
      now: () => nowMs,
    });
    await ctx.module.start();
    ctx.repo.upsertLadder(
      ladderState({
        activeRungs: [rung({ lifecycle: "planned", orderId: null, price: 0.09, sizeShares: 60 })],
      }),
    );
    nowMs = NOW + PLANNED_RUNG_RETRY_MS + 1;

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.09, bestAsk: 0.11, minOrderSize: null })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(0);
    expect(
      ctx.counters.filter(
        (counter) => counter.name === "profile_ladder_skipped_crossing_post_only",
      ),
    ).toHaveLength(1);
    expect(counterLabels(ctx.counters, "profile_ladder_min_order_fallback_total")).toHaveLength(0);
    expect(
      counterLabels(ctx.counters, "profile_ladder_min_order_size_hydration_miss"),
    ).toHaveLength(0);
  });

  it("places at most one live rung under cap=1 even when the fallback clears multiple rungs", async () => {
    let nowMs = NOW;
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [position()] },
      runtimeMode: "live-lite",
      now: () => nowMs,
    });
    await ctx.module.start();
    ctx.repo.upsertLadder(
      ladderState({
        activeRungs: [
          rung({
            rungIndex: 0,
            lifecycle: "planned",
            orderId: null,
            price: 0.11,
            sizeShares: 95,
            notionalUsd: 10.45,
          }),
          rung({
            rungIndex: 1,
            lifecycle: "planned",
            orderId: null,
            price: 0.13,
            sizeShares: 60,
            notionalUsd: 7.8,
          }),
        ],
      }),
    );
    nowMs = NOW + PLANNED_RUNG_RETRY_MS + 1;

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ minOrderSize: null })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.price).toBe(0.11);
    expect(
      counterLabels(ctx.counters, "profile_ladder_min_order_fallback_total").filter(
        (labels) => labels.result === "fallback_used",
      ),
    ).toHaveLength(1);
  });

  it("recovers a planned-only ladder via fallback and places exactly once", async () => {
    let nowMs = NOW;
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [position()] },
      runtimeMode: "live-lite",
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
    // A second market update inside the retry cooldown / occupied cap must not
    // place a duplicate live rung.
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ minOrderSize: null })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.metadata).toMatchObject({
      marketData: { minOrderSize: 1, effectiveMinOrderSize: 1, minOrderSource: "fallback" },
    });
    expect(
      counterLabels(ctx.counters, "profile_ladder_min_order_fallback_total").filter(
        (labels) => labels.result === "fallback_used",
      ),
    ).toHaveLength(1);
  });

  it("emits only bounded closed-enum labels for the min-order fallback metrics", async () => {
    let nowMs = NOW;
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [position()] },
      runtimeMode: "live-lite",
      now: () => nowMs,
    });
    await ctx.module.start();
    ctx.repo.upsertLadder(
      ladderState({
        activeRungs: [
          rung({
            lifecycle: "planned",
            orderId: null,
            price: 0.2,
            sizeShares: 2.5,
            notionalUsd: 0.5,
          }),
        ],
      }),
    );
    nowMs = NOW + PLANNED_RUNG_RETRY_MS + 1;

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ minOrderSize: null })],
      timestamp: nowMs,
    });

    const hydrationLabels = counterLabels(
      ctx.counters,
      "profile_ladder_min_order_size_hydration_miss",
    );
    const fallbackLabels = counterLabels(ctx.counters, "profile_ladder_min_order_fallback_total");
    expect(hydrationLabels.length).toBeGreaterThan(0);
    expect(fallbackLabels.length).toBeGreaterThan(0);
    for (const labels of hydrationLabels) {
      expect(Object.keys(labels).sort()).toEqual(["band", "reason"]);
      expect(["cache_refresh_failed", "no_market_min_order"]).toContain(labels.reason);
    }
    for (const labels of fallbackLabels) {
      expect(Object.keys(labels).sort()).toEqual(["band", "result"]);
      expect(["fallback_unavailable", "below_fallback_min_order", "fallback_used"]).toContain(
        labels.result,
      );
    }
  });

  it("recovers an existing planned-only ladder when a later market update has min order size", async () => {
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [position()] },
    });
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
      positionRepo: { findOpen: () => [position()] },
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
        positionRepo: { findOpen: () => [position()] },
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

  it("serializes concurrent persisted recovery and releases its fence after failure", async () => {
    vi.useFakeTimers();
    try {
      let reject!: (reason: Error) => void;
      const deferred = new Promise<
        Awaited<ReturnType<ProfileLadderBookCache["getFreshOrRefresh"]>>
      >((_resolve, rejectPromise) => (reject = rejectPromise));
      const bookCache = { getFreshOrRefresh: vi.fn(() => deferred) };
      const livePosition = position({ size: 95, costBasisUsdc: 9.5 });
      const ctx = setup(policy(), {
        bookCache,
        positionRepo: { findOpen: () => [livePosition] },
      });
      ctx.repo.upsertLadder(
        ladderState({
          lastCostBasisUsdc: livePosition.costBasisUsdc,
          activeRungs: [rung({ terminalRetryKey: "persisted-terminal" })],
        }),
      );
      await ctx.module.start();

      const update = ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market({ minOrderSize: null })],
        timestamp: NOW,
      });
      await Promise.resolve();
      const positionUpdate = ctx.bus.publish("PositionUpdated", { position: livePosition });
      vi.advanceTimersByTime(PLANNED_RUNG_RETRY_MS);
      await Promise.resolve();

      expect(bookCache.getFreshOrRefresh).toHaveBeenCalledTimes(1);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      reject(new Error("book refresh failed"));
      await Promise.all([update, positionUpdate]);
      consoleError.mockRestore();
      bookCache.getFreshOrRefresh.mockResolvedValue({
        entry: {
          bookSource: "clob",
          sourceKind: "rest",
          book: orderBook(),
        },
        status: "refreshed",
      });
      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market({ minOrderSize: null })],
        timestamp: NOW + 1,
      });

      expect(ctx.orders).toHaveLength(1);
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

  describe("stale terminal PL SELL clientOrderId recovery (no permanent duplicate block)", () => {
    function deadRejectedProfileLadderSell(overrides: Partial<Order> = {}): Order {
      return openSellOrder({
        orderId: createOrderId("dead-rejected-profile-ladder-order"),
        status: OrderStatus.Rejected,
        exchangeOrderId: null,
        fillProgressShares: null,
        decisionRuleId: "PROFILE_LADDER",
        signalReason: "profile-ladder-exit",
        exchangeErrorMessage: "exchange returned no order id",
        metadata: { source: "profile_ladder" },
        ...overrides,
      });
    }

    // The first distinct clientOrderId the module probes resolves to `order`
    // (the stale row from a prior attempt); every later candidate is free. This
    // mirrors prod: only the base recovery clientOrderId has a rejected row.
    function blockFirstClientOrderId(order: Order): {
      findByTokenId: () => Order[];
      findByClientOrderId: (clientOrderId: string) => Order | null;
      blockedId: () => string | null;
    } {
      let blocked: string | null = null;
      return {
        findByTokenId: () => [],
        findByClientOrderId: (clientOrderId: string) => {
          if (blocked === null) blocked = clientOrderId;
          return clientOrderId === blocked ? order : null;
        },
        blockedId: () => blocked,
      };
    }

    function recoveryContext(reader: {
      findByTokenId: () => Order[];
      findByClientOrderId: (clientOrderId: string) => Order | null;
    }) {
      const openPosition = position({
        avgEntryPrice: 0.259945,
        costBasisUsdc: 1.541004,
        size: 5.9282,
      });
      const ctx = setup(mediumHighPolicy(), {
        modeReader: { getMode: () => "flat" },
        positionRepo: { findOpen: () => [openPosition] },
        orderRepo: reader,
      });
      ctx.repo.upsertLadder(
        ladderState({
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
        }),
      );
      return ctx;
    }

    async function fireRecovery(ctx: Awaited<ReturnType<typeof recoveryContext>>) {
      await ctx.module.start();
      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [
          market({ tickSize: 0.01, bestBid: 0.24, bestAsk: 0.26, midPrice: 0.25, minOrderSize: 1 }),
        ],
        timestamp: NOW,
      });
    }

    async function freeRecoveryCommand(): Promise<PlaceOrderCommand> {
      const ctx = recoveryContext({ findByTokenId: () => [], findByClientOrderId: () => null });
      await fireRecovery(ctx);
      return ctx.orders[0]!;
    }

    function legacyCancelledCandidate(command: PlaceOrderCommand, overrides: Partial<Order> = {}) {
      const exchangeOrderId = "legacy-cancelled-exchange-id";
      const profileLadder = {
        ...(command.metadata?.profileLadder as Readonly<Record<string, unknown>>),
      };
      delete profileLadder.attemptFilledBaseShares;
      delete profileLadder.attemptSubmittedShares;
      return openSellOrder({
        orderId: createOrderId(exchangeOrderId),
        clientOrderId: command.clientOrderId,
        tokenId: command.tokenId,
        conditionId: command.conditionId,
        positionId: null,
        price: command.price,
        size: command.size,
        sizeUsdc: command.price * command.size,
        status: OrderStatus.Cancelled,
        cancelReason: "operator",
        fillProgressShares: 0,
        exchangeOrderId,
        signalId: command.signalId ?? null,
        signalReason: command.signalReason,
        decisionRuleId: "PROFILE_LADDER",
        metadata: { source: "profile_ladder", profileLadder },
        ...overrides,
      });
    }

    function retryCommand(command: PlaceOrderCommand, attempt: number): PlaceOrderCommand {
      const signalId = attempt === 0 ? command.signalId! : `${command.signalId!}_retry${attempt}`;
      return {
        ...command,
        signalId,
        clientOrderId: buildClientOrderId({ signalId, tokenId, side: "sell" }),
      };
    }

    it("places a fresh PL SELL when the base identity is a known legacy no-order-id rejection", async () => {
      const reader = blockFirstClientOrderId(deadRejectedProfileLadderSell());
      const ctx = recoveryContext(reader);

      await fireRecovery(ctx);

      // Exactly one new PL SELL is published — the token un-sticks.
      expect(ctx.orders).toHaveLength(1);
      const published = ctx.orders[0]!;

      // Ladder identity is NOT churned: the retry lives only in the
      // signalId/clientOrderId, never the ladderId (occupancy/PR2/shadow keys).
      const recoveredLadderId = ctx.repo.getLadder(tokenId)?.ladderId ?? "";
      expect(recoveredLadderId).toContain("planned_no_live_recovery");
      expect(recoveredLadderId).not.toContain("retry");

      // The distinct clientOrderId comes from a retry-suffixed signalId.
      expect(String(published.signalId)).toContain("planned_no_live_recovery");
      expect(String(published.signalId)).toMatch(/_retry1$/);
      expect(published.clientOrderId).toBe(
        buildClientOrderId({ signalId: String(published.signalId), tokenId, side: "sell" }),
      );

      // The blocked (base) clientOrderId is never reused.
      expect(published.clientOrderId).not.toBe(reader.blockedId());
    });

    it.each([
      { name: "open", order: () => openSellOrder({ status: OrderStatus.Open }) },
      { name: "cancelled", order: () => openSellOrder({ status: OrderStatus.Cancelled }) },
      { name: "filled", order: () => openSellOrder({ status: OrderStatus.Filled }) },
      {
        name: "partially-filled",
        order: () => openSellOrder({ status: OrderStatus.PartiallyFilled }),
      },
      {
        name: "rejected-with-exchange-id",
        order: () =>
          deadRejectedProfileLadderSell({ exchangeOrderId: String(createOrderId("rested")) }),
      },
      {
        name: "rejected-with-fills",
        order: () => deadRejectedProfileLadderSell({ fillProgressShares: 3 }),
      },
      {
        name: "ambiguous-rejected",
        order: () =>
          deadRejectedProfileLadderSell({
            fillProgressShares: 0,
            exchangeErrorMessage: null,
          }),
      },
    ])(
      "does not reuse or retry a clientOrderId whose existing row is $name — no duplicate live SELL",
      async ({ order }) => {
        const blocking = order();
        const ctx = recoveryContext({
          findByTokenId: () => [],
          findByClientOrderId: () => blocking,
        });

        await fireRecovery(ctx);

        expect(ctx.orders).toHaveLength(0);
        expect(
          ctx.counters.some(
            (counter) => counter.name === "profile_ladder_clientorderid_retry_used",
          ),
        ).toBe(false);
      },
    );

    it("gives up after a bounded number of retries when every candidate clientOrderId is a terminal-dead rejected row", async () => {
      const ctx = recoveryContext({
        findByTokenId: () => [],
        findByClientOrderId: () => deadRejectedProfileLadderSell(),
      });

      await fireRecovery(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(
        ctx.counters.some(
          (counter) =>
            counter.name === "profile_ladder_clientorderid_retry_blocked" &&
            counter.labels?.includes("exhausted"),
        ),
      ).toBe(true);
    });

    it("selects legacy retry4 once base through retry3 are known no-order-id rejections", async () => {
      let probes = 0;
      const ctx = recoveryContext({
        findByTokenId: () => [],
        findByClientOrderId: () => (probes++ < 4 ? deadRejectedProfileLadderSell() : null),
      });

      await fireRecovery(ctx);

      expect(ctx.orders).toHaveLength(1);
      expect(String(ctx.orders[0]?.signalId)).toMatch(/_retry4$/);
    });

    it("steps over the exact base cancellation and three legacy no-ID rejects, then binds retry4 after restart", async () => {
      const base = await freeRecoveryCommand();
      let tokenOrders: Order[] = [];
      const knownByClientId = new Map(
        [0, 1, 2, 3].map((attempt) => {
          const candidate = retryCommand(base, attempt);
          const existing =
            attempt === 0
              ? legacyCancelledCandidate(candidate)
              : deadRejectedProfileLadderSell({
                  clientOrderId: candidate.clientOrderId,
                  signalId: candidate.signalId ?? null,
                });
          return [String(candidate.clientOrderId), existing] as const;
        }),
      );
      const ctx = recoveryContext({
        findByTokenId: () => tokenOrders,
        findByClientOrderId: (id) =>
          tokenOrders.find((order) => String(order.clientOrderId) === id) ??
          knownByClientId.get(id) ??
          null,
      });

      await fireRecovery(ctx);

      expect(ctx.orders).toHaveLength(1);
      expect(String(ctx.orders[0]?.signalId)).toMatch(/_retry4$/);
      const accepted = ctx.orders[0]!;
      const acceptedExchangeId = "accepted-retry4-exchange-id";
      tokenOrders = [
        openSellOrder({
          orderId: createOrderId(acceptedExchangeId),
          clientOrderId: accepted.clientOrderId,
          tokenId: accepted.tokenId,
          conditionId: accepted.conditionId,
          positionId: accepted.positionId ?? null,
          price: accepted.price,
          size: accepted.size,
          sizeUsdc: accepted.price * accepted.size,
          status: OrderStatus.Open,
          fillProgressShares: 0,
          exchangeOrderId: acceptedExchangeId,
          signalId: accepted.signalId ?? null,
          signalReason: accepted.signalReason,
          decisionRuleId: "PROFILE_LADDER",
          metadata: accepted.metadata ?? null,
        }),
      ];
      await ctx.module.stop();
      await ctx.module.start();
      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [stalePlannedNoLiveMarket()],
        timestamp: NOW + 1,
      });

      expect(ctx.orders).toHaveLength(1);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]?.orderId).toBe(acceptedExchangeId);
    });

    it("does not skip an accepted cancellation found in a retry lane", async () => {
      const base = await freeRecoveryCommand();
      const baseCandidate = retryCommand(base, 0);
      const retry1 = retryCommand(base, 1);
      const known = new Map<string, Order>([
        [String(baseCandidate.clientOrderId), deadRejectedProfileLadderSell()],
        [String(retry1.clientOrderId), legacyCancelledCandidate(retry1)],
      ]);
      const ctx = recoveryContext({
        findByTokenId: () => [],
        findByClientOrderId: (id) => known.get(id) ?? null,
      });

      await fireRecovery(ctx);

      expect(ctx.orders).toHaveLength(0);
    });

    it.each([
      [
        "order/exchange identity",
        (order: Order) => ({ ...order, orderId: createOrderId("other") }),
      ],
      ["signal identity", (order: Order) => ({ ...order, signalId: "other" })],
      ["signal reason", (order: Order) => ({ ...order, signalReason: "other" })],
      ["decision identity", (order: Order) => ({ ...order, decisionRuleId: "OTHER" })],
      ["operator reason", (order: Order) => ({ ...order, cancelReason: "expired" })],
      [
        "position identity",
        (order: Order) => ({ ...order, positionId: createPositionId("other-position") }),
      ],
      ["price", (order: Order) => ({ ...order, price: order.price + 0.01 })],
      ["full size", (order: Order) => ({ ...order, size: order.size - 1 })],
      ["zero fill", (order: Order) => ({ ...order, fillProgressShares: 0.1 })],
      ["known fill", (order: Order) => ({ ...order, fillProgressShares: null })],
      ["nonnegative fill", (order: Order) => ({ ...order, fillProgressShares: -1 })],
      ["finite fill", (order: Order) => ({ ...order, fillProgressShares: NaN })],
      [
        "ladder metadata",
        (order: Order) => ({
          ...order,
          metadata: {
            ...order.metadata,
            profileLadder: { ...(order.metadata?.profileLadder as object), rungIndex: 1 },
          },
        }),
      ],
      [
        "absent attempt metadata",
        (order: Order) => ({
          ...order,
          metadata: {
            ...order.metadata,
            profileLadder: {
              ...(order.metadata?.profileLadder as object),
              attemptFilledBaseShares: 0,
            },
          },
        }),
      ],
    ])("keeps a legacy cancelled candidate blocking when %s mismatches", async (_name, mutate) => {
      const base = await freeRecoveryCommand();
      const ctx = recoveryContext(blockFirstClientOrderId(mutate(legacyCancelledCandidate(base))));

      await fireRecovery(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.counters).toContainEqual({
        name: "profile_ladder_clientorderid_retry_blocked",
        value: 1,
        labels: '{"band":"medium_high","reason":"live_or_filled"}',
      });
    });

    it.each([OrderStatus.Cancelled, OrderStatus.Rejected])(
      "does not retry past a terminal %s PL SELL with unknown fill progress",
      async (status) => {
        const reader = blockFirstClientOrderId(
          deadRejectedProfileLadderSell({
            status,
            fillProgressShares: null,
            ...(status === OrderStatus.Rejected ? { exchangeErrorMessage: null } : {}),
          }),
        );
        const ctx = recoveryContext(reader);

        await fireRecovery(ctx);

        expect(ctx.orders).toHaveLength(0);
        expect(ctx.counters).toContainEqual({
          name: "profile_ladder_clientorderid_retry_blocked",
          value: 1,
          labels: '{"band":"medium_high","reason":"live_or_filled"}',
        });
      },
    );

    it("does not retry-skip a terminal cancelled NON-ProfileLadder SELL row (PL gate keeps it blocking)", async () => {
      const ctx = recoveryContext({
        findByTokenId: () => [],
        findByClientOrderId: () => openSellOrder({ status: OrderStatus.Cancelled }),
      });

      await fireRecovery(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.counters).toContainEqual({
        name: "profile_ladder_clientorderid_retry_blocked",
        value: 1,
        labels: '{"band":"medium_high","reason":"live_or_filled"}',
      });
    });
  });

  describe("exact legacy cancelled-rung recovery", () => {
    const recoveryLadderId = "profile_ladder_cancelled_prod_planned_no_live_recovery";
    const recoverySignalId = `profile_ladder_${String(tokenId)}_${recoveryLadderId}_0`;

    function cancelledRecoveryOrder(overrides: Partial<Order> = {}): Order {
      const exchangeOrderId = "legacy-cancelled-prod-exchange";
      return openSellOrder({
        orderId: createOrderId(exchangeOrderId),
        clientOrderId: buildClientOrderId({ signalId: recoverySignalId, tokenId, side: "sell" }),
        positionId: null,
        price: 0.116,
        size: 28.99,
        sizeUsdc: 3.36284,
        status: OrderStatus.Cancelled,
        cancelReason: "operator",
        fillProgressShares: 0,
        exchangeOrderId,
        signalId: recoverySignalId,
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: {
          source: "profile_ladder",
          profileLadder: { ladderId: recoveryLadderId, rungIndex: 0 },
        },
        ...overrides,
      });
    }

    function cancelledRecoveryContext(
      options: {
        state?: LadderState;
        candidate?: Order;
        extraOrders?: Order[];
        positions?: Position[];
      } = {},
    ) {
      const openPosition = position({ size: 28.99, avgEntryPrice: 0.07, costBasisUsdc: 2.03 });
      const candidate = options.candidate ?? cancelledRecoveryOrder();
      const tokenOrders = [candidate, ...(options.extraOrders ?? [])];
      const positions = options.positions ?? [openPosition];
      const ctx = setup(policy(), {
        runtimeMode: "live-lite",
        isProfileOwned: () => true,
        profileStateReader: { getProfileState: () => "EXITING" },
        positionRepo: {
          findOpen: () => positions,
          findActiveByTokenId: () => positions,
        },
        orderRepo: {
          findByTokenId: () => tokenOrders,
          findByClientOrderId: (id) =>
            tokenOrders.find((order) => String(order.clientOrderId) === id) ?? null,
        },
      });
      ctx.repo.upsertLadder(
        options.state ??
          ladderState({
            ladderId: "profile_ladder_cancelled_prod",
            activeRungs: [
              rung({
                price: 0.116,
                sizeShares: 28.99,
                notionalUsd: 3.36284,
                sizingFraction: 1,
                lifecycle: "cancelled",
                orderId: null,
                filledSizeShares: 0,
              }),
            ],
            lastAvgEntry: 0.07,
            lastCostBasisUsdc: 2.03,
          }),
      );
      return ctx;
    }

    async function fireCancelledRecovery(
      ctx: ReturnType<typeof cancelledRecoveryContext>,
      overrides: Partial<NormalizedMarket> = {},
    ) {
      await ctx.module.start();
      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [
          market({
            bestBid: null,
            bestAsk: 0.001,
            midPrice: null,
            spread: null,
            minOrderSize: 0,
            ...overrides,
          }),
        ],
        timestamp: NOW,
      });
    }

    it("rearms the exact prod-shape cancellation once and binds its fresh terminal retry", async () => {
      const ctx = cancelledRecoveryContext();

      await fireCancelledRecovery(ctx);

      expect(ctx.orders).toHaveLength(1);
      expect(ctx.orders[0]).toMatchObject({
        side: "sell",
        price: 0.116,
        size: 28.99,
        postOnly: true,
        orderType: "GTC",
      });
      expect(ctx.orders[0]?.signalId).toContain(
        "_planned_no_live_recovery_0_terminal_retry_legacy-cancelled-prod-exchange",
      );
      expect(ctx.repo.getLadder(tokenId)).toMatchObject({
        ladderId: recoveryLadderId,
        activeRungs: [
          {
            lifecycle: "planned",
            orderId: null,
            terminalRetryKey: "legacy-cancelled-prod-exchange",
            attemptFilledBaseShares: 0,
            attemptSubmittedShares: 28.99,
            preExchangeRetryCount: 0,
          },
        ],
      });

      await fireCancelledRecovery(ctx);
      expect(ctx.orders).toHaveLength(1);
      await ctx.bus.publish("OrderPlaced", orderPlaced(ctx.orders[0]!));
      await fireCancelledRecovery(ctx);
      expect(ctx.orders).toHaveLength(1);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "placed",
        orderId: "profile-ladder-backfilled-order",
      });
    });

    it("fails closed unless the exact legacy order, state, basis, and market are unchanged", async () => {
      const cases = [
        cancelledRecoveryContext({
          state: ladderState({
            ladderId: "profile_ladder_cancelled_prod",
            activeRungs: [
              rung({
                lifecycle: "cancelled",
                price: 0.116,
                sizeShares: 28.99,
                terminalRetryKey: "x",
              }),
            ],
          }),
        }),
        cancelledRecoveryContext({
          extraOrders: [
            cancelledRecoveryOrder({
              orderId: createOrderId("second"),
              exchangeOrderId: "second",
            }),
          ],
        }),
        cancelledRecoveryContext({
          extraOrders: [openSellOrder({ status: OrderStatus.Open, exchangeOrderId: "other" })],
        }),
        cancelledRecoveryContext({
          state: ladderState({
            ladderId: "profile_ladder_cancelled_prod",
            activeRungs: [
              rung({ lifecycle: "cancelled", price: 0.116, sizeShares: 28.99 }),
              rung({ rungIndex: 1, lifecycle: "cancelled", orderId: null }),
            ],
          }),
        }),
        cancelledRecoveryContext({
          state: ladderState({ conditionId: createConditionId("other-condition") }),
        }),
        cancelledRecoveryContext({
          candidate: cancelledRecoveryOrder({
            positionId: createPositionId("profile-ladder-position"),
          }),
        }),
        cancelledRecoveryContext({
          positions: [position({ size: 28.99, avgEntryPrice: 0.071, costBasisUsdc: 2.03 })],
        }),
        cancelledRecoveryContext({
          positions: [position({ size: 28.99, avgEntryPrice: 0.07, costBasisUsdc: 2.04 })],
        }),
      ];
      for (const ctx of cases) {
        await fireCancelledRecovery(ctx);
        expect(ctx.orders).toHaveLength(0);
      }

      for (const bbo of [
        { bestBid: null, bestAsk: null },
        { bestBid: 0.001, bestAsk: null },
        { bestBid: 0.001, bestAsk: 0.001 },
      ]) {
        const invalidBbo = cancelledRecoveryContext();
        await fireCancelledRecovery(invalidBbo, bbo);
        expect(invalidBbo.orders).toHaveLength(0);
      }

      const smallPosition = position({ size: 4, avgEntryPrice: 0.07, costBasisUsdc: 0.28 });
      const subMin = cancelledRecoveryContext({ positions: [smallPosition] });
      await fireCancelledRecovery(subMin);
      expect(subMin.orders).toHaveLength(0);

      const inFlightScaleIn = cancelledRecoveryContext();
      await inFlightScaleIn.module.start();
      await inFlightScaleIn.bus.publish("FillReceived", fill({ side: "buy" }));
      await fireCancelledRecovery(inFlightScaleIn);
      expect(inFlightScaleIn.orders).toHaveLength(0);
    });
  });

  describe("exact planned-no-live recovery binder", () => {
    const recoveryLadderId = "profile_ladder_existing_planned_no_live_recovery";
    const recoverySignalId = `profile_ladder_${String(tokenId)}_${recoveryLadderId}_0`;

    function exactRecoveryOrder(currentPosition: Position, overrides: Partial<Order> = {}): Order {
      const exchangeOrderId = "exact-recovery-exchange-order";
      return openSellOrder({
        orderId: createOrderId("exact-recovery-prepared-hash"),
        exchangeOrderId,
        clientOrderId: buildClientOrderId({ signalId: recoverySignalId, tokenId, side: "sell" }),
        tokenId: currentPosition.tokenId,
        conditionId: currentPosition.conditionId,
        positionId: currentPosition.positionId,
        price: 0.27,
        size: 5.9282,
        sizeUsdc: 1.600614,
        status: OrderStatus.Open,
        fillProgressShares: 0,
        signalId: recoverySignalId,
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: {
          source: "profile_ladder",
          profileLadder: {
            ladderId: recoveryLadderId,
            rungIndex: 0,
            attemptFilledBaseShares: 0,
            attemptSubmittedShares: 5.9282,
          },
        },
        ...overrides,
      });
    }

    function exactRecoveryContext(
      currentPosition: Position,
      orders: Order[],
      stateOverrides: Partial<LadderState> = {},
    ) {
      const ctx = setup(mediumHighPolicy(), {
        modeReader: { getMode: () => "flat" },
        positionRepo: { findOpen: () => [currentPosition] },
        orderRepo: { findByTokenId: () => orders, findByClientOrderId: () => null },
      });
      ctx.repo.upsertLadder(
        stalePlannedNoLiveState({
          activeRungs: [
            rung({
              price: 0.26,
              sizeShares: 5.9282,
              notionalUsd: 1.54,
              attemptFilledBaseShares: 0,
              attemptSubmittedShares: 5.9282,
              preExchangeRetryCount: 0,
            }),
          ],
          ...stateOverrides,
        }),
      );
      return ctx;
    }

    async function fireExactRecovery(ctx: ReturnType<typeof exactRecoveryContext>) {
      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [stalePlannedNoLiveMarket({ bestBid: null, bestAsk: null, midPrice: null })],
        timestamp: NOW,
      });
    }

    const prodRequestedShares = 69.690125;
    const prodAcceptedShares = 69.6901;

    function prodShapeContext(
      orderOverrides: Partial<Order> = {},
      rungOverrides: Partial<LadderRung> = {},
    ) {
      const currentPosition = stalePlannedNoLivePosition({ size: prodRequestedShares });
      const order = exactRecoveryOrder(currentPosition, {
        size: prodAcceptedShares,
        sizeUsdc: prodAcceptedShares * 0.27,
        fillProgressShares: null,
        metadata: {
          source: "profile_ladder",
          profileLadder: {
            ladderId: recoveryLadderId,
            rungIndex: 0,
            attemptFilledBaseShares: 0,
            attemptSubmittedShares: prodRequestedShares,
          },
        },
        ...orderOverrides,
      });
      const ctx = exactRecoveryContext(currentPosition, [order], {
        activeRungs: [
          rung({
            price: 0.26,
            sizeShares: prodRequestedShares,
            notionalUsd: 18.12,
            attemptFilledBaseShares: 0,
            attemptSubmittedShares: prodRequestedShares,
            preExchangeRetryCount: 1,
            ...rungOverrides,
          }),
        ],
      });
      return { ctx, order };
    }

    it("binds the clamped prod OPEN under its original pre-retry identity and follows exchange-id fills", async () => {
      const { ctx, order } = prodShapeContext();
      await ctx.module.start();

      await fireExactRecovery(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        orderId: order.exchangeOrderId,
        lifecycle: "placed",
        sizeShares: prodRequestedShares,
        filledSizeShares: 0,
      });
      await ctx.module.stop();
      await ctx.module.start();
      await fireExactRecovery(ctx);
      expect(ctx.orders).toHaveLength(0);

      await ctx.bus.publish(
        "FillReceived",
        fill({
          orderId: createOrderId(order.exchangeOrderId!),
          clientOrderId: order.clientOrderId,
          size: prodAcceptedShares,
        }),
      );
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "partially_filled",
        filledSizeShares: prodAcceptedShares,
      });
    });

    it.each([
      ["terminal lineage", {}, { terminalRetryKey: "terminal-proof" }],
      [
        "arbitrary pre-retry identity",
        {
          size: prodRequestedShares,
          fillProgressShares: 0,
          signalId: `${recoverySignalId}_pre_retry1`,
          clientOrderId: buildClientOrderId({
            signalId: `${recoverySignalId}_pre_retry1`,
            tokenId,
            side: "sell",
          }),
        },
        {},
      ],
      ["clamp above tolerance", { size: prodRequestedShares - 0.0002 }, {}],
      ["upward size", { size: prodRequestedShares + 0.000001 }, {}],
      ["partial with unknown fill", { status: OrderStatus.PartiallyFilled }, {}],
    ])("keeps prod-shape %s blocked", async (_name, orderOverrides, rungOverrides) => {
      const { ctx } = prodShapeContext(orderOverrides, rungOverrides);
      await ctx.module.start();

      await fireExactRecovery(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "planned",
        orderId: null,
      });
    });

    it("binds the exact exchange-backed orphan before BBO/retry gates and survives restart/fill", async () => {
      const currentPosition = stalePlannedNoLivePosition({ size: 5.92825 });
      const order = exactRecoveryOrder(currentPosition);
      const ctx = exactRecoveryContext(currentPosition, [order]);
      await ctx.module.start();

      await fireExactRecovery(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)).toMatchObject({
        ladderId: recoveryLadderId,
        activeRungs: [
          {
            orderId: order.exchangeOrderId,
            lifecycle: "placed",
            price: 0.27,
            filledSizeShares: 0,
          },
        ],
      });
      const bound = ctx.repo.getLadder(tokenId)?.activeRungs[0];
      expect(bound?.terminalRetryKey).toBeUndefined();
      expect(bound?.attemptFilledBaseShares).toBeUndefined();
      expect(bound?.attemptSubmittedShares).toBeUndefined();
      expect(bound?.preExchangeRetryCount).toBeUndefined();

      await ctx.module.stop();
      await ctx.module.start();
      await fireExactRecovery(ctx);
      expect(ctx.orders).toHaveLength(0);

      await ctx.bus.publish(
        "FillReceived",
        fill({
          orderId: createOrderId(order.exchangeOrderId!),
          clientOrderId: order.clientOrderId,
          price: order.price,
          size: order.size,
          sizeUsdc: order.sizeUsdc,
        }),
      );
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "filled",
        filledSizeShares: 5.9282,
      });
    });

    it("binds a partially-filled orphan only when remaining coverage equals current inventory", async () => {
      const currentPosition = stalePlannedNoLivePosition({ size: 3.9282 });
      const order = exactRecoveryOrder(currentPosition, {
        status: OrderStatus.PartiallyFilled,
        fillProgressShares: 2,
      });
      const ctx = exactRecoveryContext(currentPosition, [order]);
      await ctx.module.start();

      await fireExactRecovery(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        orderId: order.exchangeOrderId,
        lifecycle: "partially_filled",
        price: 0.27,
        filledSizeShares: 2,
      });
      await ctx.module.cancelLadder(tokenId, "operator");
      expect(ctx.cancels).toEqual([order.exchangeOrderId]);
    });

    it.each([
      ["non-full coverage", (order: Order) => order, { size: 5.92 }],
      [
        "wrong ladder metadata",
        (order: Order) => ({
          ...order,
          metadata: {
            ...order.metadata,
            profileLadder: { ...(order.metadata?.profileLadder as object), ladderId: "wrong" },
          },
        }),
        {},
      ],
      [
        "wrong position identity",
        (order: Order) => ({ ...order, positionId: createPositionId("wrong-position") }),
        {},
      ],
      [
        "same-price wrong signal",
        (order: Order) => ({ ...order, price: 0.26, signalId: "wrong-signal" }),
        {},
      ],
      [
        "same-price wrong client",
        (order: Order) => ({
          ...order,
          price: 0.26,
          clientOrderId: "wrong-client" as ClientOrderId,
        }),
        {},
      ],
      [
        "same-price wrong reason",
        (order: Order) => ({ ...order, price: 0.26, signalReason: "wrong-reason" }),
        {},
      ],
      [
        "missing fill arithmetic",
        (order: Order) => {
          const { fillProgressShares: _fillProgressShares, ...withoutProgress } = order;
          return withoutProgress;
        },
        {},
      ],
    ])("fails closed for %s", async (_name, mutate, positionOverrides) => {
      const currentPosition = stalePlannedNoLivePosition(positionOverrides);
      const ctx = exactRecoveryContext(currentPosition, [
        mutate(exactRecoveryOrder(currentPosition)),
      ]);
      await ctx.module.start();

      await fireExactRecovery(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "planned",
        orderId: null,
      });
    });

    it("fails closed when more than one live SELL makes the orphan evidence ambiguous", async () => {
      const currentPosition = stalePlannedNoLivePosition();
      const first = exactRecoveryOrder(currentPosition);
      const second = exactRecoveryOrder(currentPosition, {
        orderId: createOrderId("second-exact-order"),
        exchangeOrderId: "second-exact-order",
      });
      const ctx = exactRecoveryContext(currentPosition, [first, second]);
      await ctx.module.start();

      await fireExactRecovery(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "planned",
        orderId: null,
      });
    });

    it("fails closed when an exact orphan coexists with an active non-PL SELL", async () => {
      const currentPosition = stalePlannedNoLivePosition();
      const ctx = exactRecoveryContext(currentPosition, [
        exactRecoveryOrder(currentPosition),
        openSellOrder({
          orderId: createOrderId("legacy-active-sell"),
          exchangeOrderId: "legacy-active-sell",
          decisionRuleId: "LEGACY_SELL",
          metadata: { source: "s1" },
        }),
      ]);
      await ctx.module.start();

      await fireExactRecovery(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "planned",
        orderId: null,
      });
    });

    it.each([OrderStatus.Pending, OrderStatus.Open])(
      "fails closed when an exact OPEN has a distinct-lineage %s PL SELL",
      async (status) => {
        const currentPosition = stalePlannedNoLivePosition();
        const open = exactRecoveryOrder(currentPosition);
        const distinct = exactRecoveryOrder(currentPosition, {
          orderId: createOrderId("distinct-prepared-hash"),
          exchangeOrderId: status === OrderStatus.Pending ? null : "distinct-exchange-order",
          clientOrderId: "distinct-client" as ClientOrderId,
          signalId: "distinct-signal",
          status,
          metadata: {
            source: "profile_ladder",
            profileLadder: { ladderId: "profile_ladder_existing", rungIndex: 0 },
          },
        });
        const ctx = exactRecoveryContext(currentPosition, [open, distinct]);
        await ctx.module.start();

        await fireExactRecovery(ctx);

        expect(ctx.orders).toHaveLength(0);
        expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
          lifecycle: "planned",
          orderId: null,
        });
      },
    );
  });

  describe("planned-no-live recovery adopts an existing open PL SELL (re-link, no churn)", () => {
    // Mirrors the prod orphan: the persisted state keeps the BASE ladderId with a
    // planned/orderId-null rung, while a real PL SELL still rests on the exchange
    // under a recovery-suffixed ladderId (its OrderPlaced backfill was lost on a
    // restart). Recovery must re-link that order, not churn forever.
    function restingProfileLadderSell(overrides: Partial<Order> = {}): Order {
      return openSellOrder({
        orderId: createOrderId("recovery-suffixed-resting-sell"),
        price: 0.26,
        status: OrderStatus.Open,
        decisionRuleId: "PROFILE_LADDER",
        signalReason: "profile-ladder-exit",
        metadata: {
          source: "profile_ladder",
          ladderId: "profile_ladder_existing_planned_no_live_recovery",
        },
        ...overrides,
      });
    }

    function orphanContext(orders: Order[], stateOverrides: Partial<LadderState> = {}) {
      const openPosition = position({
        avgEntryPrice: 0.259945,
        costBasisUsdc: 1.541004,
        size: 5.9282,
      });
      const ctx = setup(mediumHighPolicy(), {
        modeReader: { getMode: () => "flat" },
        positionRepo: { findOpen: () => [openPosition] },
        orderRepo: { findByTokenId: () => orders, findByClientOrderId: () => null },
      });
      ctx.repo.upsertLadder(
        ladderState({
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
          // Align the reference with the recovery market BBO so no BBO rebuild
          // fires: the second recovery pass is a true no-op that isolates
          // adoption stability (the resting order stays tracked at its rung).
          lastBboReferenceJson: JSON.stringify({ bestBid: 0.24, bestAsk: 0.26 }),
          ...stateOverrides,
        }),
      );
      return ctx;
    }

    async function fireRecoveryPass(ctx: ReturnType<typeof orphanContext>) {
      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [
          market({ tickSize: 0.01, bestBid: 0.24, bestAsk: 0.26, midPrice: 0.25, minOrderSize: 1 }),
        ],
        timestamp: NOW,
      });
    }

    it("re-links the resting PL SELL into the matching planned rung instead of churning", async () => {
      const resting = restingProfileLadderSell();
      const ctx = orphanContext([resting]);
      await ctx.module.start();

      await fireRecoveryPass(ctx);

      // No new order placed — the existing resting SELL is adopted.
      expect(ctx.orders).toHaveLength(0);
      const adopted = ctx.repo.getLadder(tokenId);
      expect(adopted?.activeRungs[0]).toMatchObject({
        orderId: String(resting.orderId),
        lifecycle: "placed",
        price: 0.26,
        rungIndex: 0,
      });
      // Base ladder identity is preserved (no suffix churn on the persisted row).
      expect(adopted?.ladderId).toBe("profile_ladder_existing");
      // No recovery rebuild / retry_blocked churn.
      expect(ctx.counters.some((c) => c.name === "profile_ladder_planned_no_live_recovered")).toBe(
        false,
      );
      expect(
        ctx.counters.some((c) => c.name === "profile_ladder_clientorderid_retry_blocked"),
      ).toBe(false);
      expect(ctx.counters).toContainEqual({
        name: "profile_ladder_recovery_order_adopted",
        value: 1,
        labels: '{"band":"medium_high"}',
      });
    });

    it("does not place or churn again on the next recovery pass after adoption", async () => {
      const resting = restingProfileLadderSell();
      const ctx = orphanContext([resting]);
      await ctx.module.start();

      await fireRecoveryPass(ctx);
      ctx.orders.length = 0;
      ctx.counters.length = 0;
      await fireRecoveryPass(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]?.orderId).toBe(String(resting.orderId));
      expect(ctx.counters.some((c) => c.name === "profile_ladder_recovery_order_adopted")).toBe(
        false,
      );
    });

    it("marks the rung partially_filled when the adopted order is partially filled", async () => {
      const resting = restingProfileLadderSell({ status: OrderStatus.PartiallyFilled });
      const ctx = orphanContext([resting]);
      await ctx.module.start();

      await fireRecoveryPass(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        orderId: String(resting.orderId),
        lifecycle: "partially_filled",
      });
    });

    it("seeds filledSizeShares from a partially-filled order's fillProgressShares", async () => {
      const resting = restingProfileLadderSell({
        status: OrderStatus.PartiallyFilled,
        fillProgressShares: 3,
      });
      const ctx = orphanContext([resting]);
      await ctx.module.start();

      await fireRecoveryPass(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "partially_filled",
        filledSizeShares: 3,
      });
    });

    it("clamps the seeded filledSizeShares to the rung size", async () => {
      const resting = restingProfileLadderSell({
        status: OrderStatus.PartiallyFilled,
        fillProgressShares: 100,
      });
      const ctx = orphanContext([resting]);
      await ctx.module.start();

      await fireRecoveryPass(ctx);

      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]?.filledSizeShares).toBe(5.9282);
    });

    it.each([
      { name: "null", fillProgressShares: null },
      { name: "zero", fillProgressShares: 0 },
      { name: "negative", fillProgressShares: -1 },
    ])(
      "keeps filledSizeShares unchanged when partial fill progress is $name",
      async ({ fillProgressShares }) => {
        const resting = restingProfileLadderSell({
          status: OrderStatus.PartiallyFilled,
          fillProgressShares,
        });
        const ctx = orphanContext([resting]);
        await ctx.module.start();

        await fireRecoveryPass(ctx);

        expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
          lifecycle: "partially_filled",
          filledSizeShares: 0,
        });
      },
    );

    it("fails closed when two open PL SELLs match the same planned rung price", async () => {
      const a = restingProfileLadderSell({ orderId: createOrderId("resting-a") });
      const b = restingProfileLadderSell({ orderId: createOrderId("resting-b") });
      const ctx = orphanContext([a, b]);
      await ctx.module.start();

      await fireRecoveryPass(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "planned",
        orderId: null,
      });
      expect(ctx.counters.some((c) => c.name === "profile_ladder_recovery_order_adopted")).toBe(
        false,
      );
    });

    it("fails closed when one open PL SELL matches two planned rungs at the same price", async () => {
      const resting = restingProfileLadderSell();
      const ctx = orphanContext([resting], {
        activeRungs: [
          rung({ rungIndex: 0, price: 0.26, lifecycle: "planned", orderId: null }),
          rung({ rungIndex: 1, price: 0.26, lifecycle: "planned", orderId: null }),
        ],
      });
      await ctx.module.start();

      await fireRecoveryPass(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs.every((r) => r.lifecycle === "planned")).toBe(
        true,
      );
      expect(ctx.counters.some((c) => c.name === "profile_ladder_recovery_order_adopted")).toBe(
        false,
      );
    });

    it("does not adopt a non-ProfileLadder open SELL at the rung price", async () => {
      const legacy = openSellOrder({ price: 0.26, status: OrderStatus.Open });
      const ctx = orphanContext([legacy]);
      await ctx.module.start();

      await fireRecoveryPass(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "planned",
        orderId: null,
      });
      expect(ctx.counters.some((c) => c.name === "profile_ladder_recovery_order_adopted")).toBe(
        false,
      );
    });

    it("fails closed when no open PL SELL price matches a planned rung (price drift)", async () => {
      const drifted = restingProfileLadderSell({ price: 0.31 });
      const ctx = orphanContext([drifted]);
      await ctx.module.start();

      await fireRecoveryPass(ctx);

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "planned",
        orderId: null,
      });
      expect(ctx.counters.some((c) => c.name === "profile_ladder_recovery_order_adopted")).toBe(
        false,
      );
    });
  });

  describe("stale live-rung orderId reconciliation", () => {
    const staleOrderId = createOrderId("stale-profile-ladder-order");

    function focusShapeState(overrides: Partial<LadderState> = {}): LadderState {
      return ladderState({
        band: "medium_low",
        activeRungs: [
          rung({
            rungIndex: 0,
            price: 0.099,
            sizeShares: 108.275484,
            notionalUsd: 10.72,
            lifecycle: "planned",
            orderId: null,
          }),
          rung({
            rungIndex: 1,
            price: 0.117,
            sizeShares: 68.384516,
            notionalUsd: 8,
            lifecycle: "planned",
            orderId: null,
          }),
          rung({
            rungIndex: 2,
            price: 0.063,
            sizeShares: 108.275484,
            notionalUsd: 6.82,
            lifecycle: "placed",
            orderId: String(staleOrderId),
          }),
        ],
        lastAvgEntry: 0.09,
        lastCostBasisUsdc: 18.72,
        lastMode: "flat",
        lastBboReferenceJson: JSON.stringify({ bestBid: 0.08, bestAsk: 0.1 }),
        ...overrides,
      });
    }

    function staleProfileLadderOrder(overrides: Partial<Order> = {}): Order {
      return openSellOrder({
        orderId: staleOrderId,
        exchangeOrderId: "stale-profile-ladder-exchange-order",
        price: 0.063,
        size: 108.275484,
        sizeUsdc: 6.82,
        fillProgressShares: 0,
        status: OrderStatus.Cancelled,
        decisionRuleId: "PROFILE_LADDER",
        signalReason: "profile-ladder-exit",
        metadata: { source: "profile_ladder", ladderId: "profile_ladder_existing" },
        ...overrides,
      });
    }

    function staleContext(
      orders: readonly Order[],
      overrides: {
        findByClientOrderId?: (clientOrderId: string) => Order | null;
        openPosition?: Position;
      } = {},
    ) {
      const openPosition =
        overrides.openPosition ??
        position({ avgEntryPrice: 0.09, costBasisUsdc: 18.72, size: 176.66 });
      return setup(policy(), {
        modeReader: { getMode: () => "flat" },
        positionRepo: { findOpen: () => [openPosition] },
        orderRepo: {
          findByTokenId: () => [...orders],
          findByClientOrderId: overrides.findByClientOrderId ?? (() => null),
        },
      });
    }

    it("does not let a cancelled stale PL order occupy the only live slot on rebuild", async () => {
      const ctx = staleContext([staleProfileLadderOrder()]);
      ctx.repo.upsertLadder(focusShapeState());

      await ctx.module.placeLadder(
        position({ avgEntryPrice: 0.09, costBasisUsdc: 18.72, size: 176.66 }),
        market({ bestBid: 0.08, bestAsk: 0.1, midPrice: 0.09, minOrderSize: 1 }),
      );

      expect(ctx.orders).toHaveLength(1);
      expect(ctx.orders[0]?.side).toBe("sell");
      expect(ctx.orders[0]?.price).toBeGreaterThan(0.08);
      expect(
        ctx.orders.some((order) => String(order.commandId).includes(String(staleOrderId))),
      ).toBe(false);
      expect(ctx.counters).toContainEqual({
        name: "profile_ladder_stale_live_rung_reconciled",
        value: 1,
        labels: '{"band":"medium_low","reason":"terminal_no_fill"}',
      });
    });

    it("keeps the focus stale-tail shape fail-closed when BBO is invalid", async () => {
      const ctx = staleContext([staleProfileLadderOrder()]);
      ctx.repo.upsertLadder(focusShapeState());
      await ctx.module.start();

      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market({ bestBid: null, bestAsk: null, midPrice: null, minOrderSize: 1 })],
        timestamp: NOW,
      });

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[2]).toMatchObject({
        lifecycle: "planned",
        orderId: null,
        filledSizeShares: 0,
        terminalRetryKey: "stale-profile-ladder-exchange-order",
      });
      expect(ctx.counters).toContainEqual({
        name: "profile_ladder_stale_live_rung_reconciled",
        value: 1,
        labels: '{"band":"medium_low","reason":"terminal_no_fill"}',
      });

      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market({ bestBid: 0.08, bestAsk: 0.1, midPrice: 0.09, minOrderSize: 1 })],
        timestamp: NOW + 1,
      });
      expect(ctx.orders).toHaveLength(0);
    });

    it("fails closed when a live rung's local order row is missing", async () => {
      const ctx = staleContext([]);
      ctx.repo.upsertLadder(focusShapeState());

      await ctx.module.placeLadder(
        position({ avgEntryPrice: 0.09, costBasisUsdc: 18.72, size: 176.66 }),
        market({ bestBid: 0.08, bestAsk: 0.1, midPrice: 0.09, minOrderSize: 1 }),
      );

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.counters).toContainEqual({
        name: "profile_ladder_terminal_rearm_blocked",
        value: 1,
        labels: '{"band":"medium_low","reason":"missing_order"}',
      });
    });

    it("preserves known partial fill progress while freeing the stale live slot", async () => {
      const ctx = staleContext([
        staleProfileLadderOrder({
          status: OrderStatus.Cancelled,
          fillProgressShares: 25,
        }),
      ]);
      ctx.repo.upsertLadder(
        focusShapeState({
          activeRungs: [
            ...focusShapeState().activeRungs.slice(0, 2),
            rung({
              rungIndex: 2,
              price: 0.063,
              sizeShares: 108.275484,
              notionalUsd: 6.82,
              lifecycle: "partially_filled",
              orderId: String(staleOrderId),
              filledSizeShares: 10,
            }),
          ],
        }),
      );
      await ctx.module.start();

      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market({ bestBid: null, bestAsk: null, midPrice: null, minOrderSize: 1 })],
        timestamp: NOW,
      });

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[2]).toMatchObject({
        lifecycle: "planned",
        orderId: null,
        filledSizeShares: 25,
        terminalRetryKey: "stale-profile-ladder-exchange-order",
      });
      expect(ctx.counters).toContainEqual({
        name: "profile_ladder_stale_live_rung_reconciled",
        value: 1,
        labels: '{"band":"medium_low","reason":"terminal_with_fill"}',
      });
    });

    it("does not oversell when a stale rung is already filled", async () => {
      const ctx = staleContext([
        staleProfileLadderOrder({
          status: OrderStatus.Filled,
          fillProgressShares: 108.275484,
        }),
      ]);
      ctx.repo.upsertLadder(focusShapeState());
      await ctx.module.start();

      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market({ bestBid: null, bestAsk: null, midPrice: null, minOrderSize: 1 })],
        timestamp: NOW,
      });

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[2]).toMatchObject({
        lifecycle: "filled",
        orderId: null,
        filledSizeShares: 108.275484,
      });
    });

    it("keeps duplicate client-order protection for terminal rows that took fills", async () => {
      const blocking = staleProfileLadderOrder({
        status: OrderStatus.Rejected,
        exchangeOrderId: String(createOrderId("exchange-touched-order")),
        fillProgressShares: 12,
      });
      const ctx = staleContext([blocking], { findByClientOrderId: () => blocking });
      ctx.repo.upsertLadder(focusShapeState());

      await ctx.module.placeLadder(
        position({ avgEntryPrice: 0.09, costBasisUsdc: 18.72, size: 176.66 }),
        market({ bestBid: 0.08, bestAsk: 0.1, midPrice: 0.09, minOrderSize: 1 }),
      );

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.counters).toContainEqual({
        name: "profile_ladder_clientorderid_retry_blocked",
        value: 1,
        labels: '{"band":"medium_low","reason":"live_or_filled"}',
      });
    });
  });

  describe("bounded recovery abandonment (narrowed to the churning candidate)", () => {
    // Reproduces prod token 243384: a terminal cancelled order burned the
    // deterministic base clientOrderId, so every recovery rebuild resolves to a
    // blocked placement (placedLiveRungs == 0) and would churn forever. After K
    // consecutive zero-placed rebuilds the *current* planned/no-live candidate is
    // abandoned (its recovery pass is skipped) — but the token is NOT made dormant,
    // so BBO/position rebuilds and a changed candidate still recover exit coverage.
    function plannedNoLiveLadder(overrides: Partial<LadderState> = {}): LadderState {
      return ladderState({
        band: "medium_high",
        // Match the recovery-pass BBO so an interim non-candidate pass never fires a
        // spurious BBO rebuild while we exercise the abandonment reset paths.
        lastBboReferenceJson: JSON.stringify({ bestBid: 0.24, bestAsk: 0.26 }),
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
        ...overrides,
      });
    }

    function abandonmentHarness(findClientOrder: () => Order | null) {
      const clock = { ms: NOW };
      // findOpen reads a mutable ref so a PositionUpdated can move the basis (and
      // hence the canonical ladder id) mid-test, modelling a real scale-in.
      const positionRef = {
        current: position({
          avgEntryPrice: 0.259945,
          costBasisUsdc: 1.541004,
          size: 5.9282,
        }),
      };
      const ctx = setup(mediumHighPolicy(), {
        modeReader: { getMode: () => "flat" },
        positionRepo: { findOpen: () => [positionRef.current] },
        orderRepo: { findByTokenId: () => [], findByClientOrderId: () => findClientOrder() },
        now: () => clock.ms,
      });
      ctx.repo.upsertLadder(plannedNoLiveLadder());
      return { ctx, clock, positionRef };
    }

    // Fire one recovery pass, then advance the clock past the per-rebuild cooldown
    // so the next pass is free to rebuild again (each rebuild arms a fresh cooldown).
    // The non-crossing, known-min default drives the clientOrderId-blocked path;
    // overrides let a test inject a transient zero-placement cause (crossing BBO or
    // unknown min order size) on a single pass.
    async function fireRecoveryPassWith(
      ctx: ReturnType<typeof abandonmentHarness>["ctx"],
      clock: { ms: number },
      marketOverrides: Partial<NormalizedMarket> = {},
    ): Promise<void> {
      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [
          market({
            tickSize: 0.01,
            bestBid: 0.24,
            bestAsk: 0.26,
            midPrice: 0.25,
            minOrderSize: 1,
            ...marketOverrides,
          }),
        ],
        timestamp: NOW,
      });
      clock.ms += PLANNED_RUNG_RETRY_MS + 1;
    }

    async function fireRecoveryPass(
      ctx: ReturnType<typeof abandonmentHarness>["ctx"],
      clock: { ms: number },
    ): Promise<void> {
      await fireRecoveryPassWith(ctx, clock);
    }

    // Move the open position so the next rebuild derives a fresh canonical ladder id.
    async function movePosition(
      ctx: ReturnType<typeof abandonmentHarness>["ctx"],
      positionRef: ReturnType<typeof abandonmentHarness>["positionRef"],
      overrides: Partial<Position>,
    ): Promise<void> {
      positionRef.current = position({
        avgEntryPrice: 0.259945,
        costBasisUsdc: 1.541004,
        size: 5.9282,
        ...overrides,
      });
      await ctx.bus.publish("PositionUpdated", { position: positionRef.current });
    }

    function abandonedLabels(
      ctx: ReturnType<typeof abandonmentHarness>["ctx"],
    ): Array<Record<string, string>> {
      return counterLabels(ctx.counters, "profile_ladder_recovery_abandoned");
    }

    function skippedAbandonedLabels(
      ctx: ReturnType<typeof abandonmentHarness>["ctx"],
    ): Array<Record<string, string>> {
      return counterLabels(ctx.counters, "ladder_recovery_skipped_abandoned");
    }

    const cancelled = () => openSellOrder({ status: OrderStatus.Cancelled });

    async function abandonOnce(
      ctx: ReturnType<typeof abandonmentHarness>["ctx"],
      clock: { ms: number },
    ): Promise<void> {
      for (let pass = 0; pass < MAX_RECOVERY_ZERO_PLACED_RECOVERIES; pass += 1) {
        await fireRecoveryPass(ctx, clock);
      }
    }

    it("abandons the churning candidate after K zero-placed rebuilds and suppresses it without going token-wide dormant", async () => {
      const { ctx, clock } = abandonmentHarness(cancelled);
      await ctx.module.start();

      await abandonOnce(ctx, clock);

      // Every rebuild was blocked at clientOrderId: no live SELL ever placed.
      expect(ctx.orders).toHaveLength(0);
      // The bounded abandoned metric is written exactly once, at the K-th rebuild.
      expect(abandonedLabels(ctx)).toEqual([
        { band: "medium_high", reason: "client_order_id_blocked_zero_placed" },
      ]);

      // The next identical pass is suppressed by the *candidate-scoped* bucket — not
      // by token-wide dormancy — and the abandoned metric stays at exactly one.
      const recoveredBefore = counterLabels(
        ctx.counters,
        "profile_ladder_planned_no_live_recovered",
      ).length;
      await fireRecoveryPass(ctx, clock);

      expect(ctx.orders).toHaveLength(0);
      expect(abandonedLabels(ctx)).toHaveLength(1);
      expect(counterLabels(ctx.counters, "profile_ladder_planned_no_live_recovered")).toHaveLength(
        recoveredBefore,
      );
      expect(skippedAbandonedLabels(ctx)).toEqual([{ band: "medium_high" }]);
      expect(ctx.counters.some((c) => c.name === "ladder_rebuild_skipped_dormant")).toBe(false);
    });

    it("runs no buildAndPlace for the abandoned candidate: suppressed passes are pure telemetry", async () => {
      const { ctx, clock } = abandonmentHarness(cancelled);
      await ctx.module.start();

      await abandonOnce(ctx, clock);
      // Clear the pre-abandonment telemetry so the suppressed passes are isolated.
      ctx.counters.length = 0;

      for (let pass = 0; pass < 3; pass += 1) {
        await fireRecoveryPass(ctx, clock);
      }

      // No rebuild ran: no planned-rungs / recovered / placed-live telemetry, no orders.
      expect(ctx.orders).toHaveLength(0);
      expect(ctx.counters.some((c) => c.name === "profile_ladder_planned_no_live_recovered")).toBe(
        false,
      );
      expect(ctx.counters.some((c) => c.name === "profile_ladder_planned_rungs")).toBe(false);
      expect(ctx.counters.some((c) => c.name === "profile_ladder_placed_live_rungs")).toBe(false);
      // The candidate-scoped skip bucket is the only thing that fires on a suppressed pass.
      expect(ctx.counters.every((c) => c.name === "ladder_recovery_skipped_abandoned")).toBe(true);
      expect(skippedAbandonedLabels(ctx)).toHaveLength(3);
    });

    it("moves an exchanged pre-submit failure onto persisted bounded retry", async () => {
      let blocked = true;
      const { ctx, clock } = abandonmentHarness(() => (blocked ? cancelled() : null));
      await ctx.module.start();

      // K-1 blocked zero-placed rebuilds: one short of the abandonment threshold.
      for (let pass = 0; pass < MAX_RECOVERY_ZERO_PLACED_RECOVERIES - 1; pass += 1) {
        await fireRecoveryPass(ctx, clock);
      }
      expect(ctx.orders).toHaveLength(0);
      expect(abandonedLabels(ctx)).toHaveLength(0);

      // A rebuild now places a live rung; the consecutive streak resets to zero.
      blocked = false;
      await fireRecoveryPass(ctx, clock);
      expect(ctx.orders).toHaveLength(1);
      // A pre-exchange rejection is now persisted and takes precedence over the
      // legacy in-memory abandonment tracker.
      await ctx.bus.publish("OrderRejected", orderRejected(ctx.orders[0]!));
      blocked = true;

      // Another K-1 blocked rebuilds must NOT abandon: the streak restarted at zero.
      for (let pass = 0; pass < MAX_RECOVERY_ZERO_PLACED_RECOVERIES - 1; pass += 1) {
        await fireRecoveryPass(ctx, clock);
      }
      expect(abandonedLabels(ctx)).toHaveLength(0);

      // The durable retry cannot be abandoned by the legacy zero-placement path.
      await fireRecoveryPass(ctx, clock);
      expect(abandonedLabels(ctx)).toEqual([]);
      expect(ctx.orders.some((order) => String(order.signalId).endsWith("_pre_retry1"))).toBe(true);
    });

    it("reopens recovery after abandonment once the planned/null rung disappears", async () => {
      const { ctx, clock } = abandonmentHarness(cancelled);
      await ctx.module.start();

      await abandonOnce(ctx, clock);
      expect(abandonedLabels(ctx)).toHaveLength(1);

      // The rung goes live (placed/non-null): the ladder is no longer a recovery
      // candidate, so the abandonment for that candidate is cleared.
      ctx.repo.upsertLadder(
        plannedNoLiveLadder({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.26,
              sizeShares: 5.9282,
              notionalUsd: 1.54,
              lifecycle: "placed",
              orderId: String(createOrderId("live-rung")),
            }),
          ],
        }),
      );
      await fireRecoveryPass(ctx, clock);

      // A fresh planned/null candidate (same signature) must start a brand-new streak,
      // proving the token was never left token-wide dormant.
      ctx.repo.upsertLadder(plannedNoLiveLadder());
      for (let pass = 0; pass < MAX_RECOVERY_ZERO_PLACED_RECOVERIES - 1; pass += 1) {
        await fireRecoveryPass(ctx, clock);
      }
      expect(abandonedLabels(ctx)).toHaveLength(1);

      await fireRecoveryPass(ctx, clock);
      expect(abandonedLabels(ctx)).toHaveLength(2);
    });

    it("clears the candidate abandonment as soon as a live rung/orderId appears", async () => {
      const { ctx, clock } = abandonmentHarness(cancelled);
      await ctx.module.start();

      await abandonOnce(ctx, clock);
      expect(abandonedLabels(ctx)).toHaveLength(1);

      // A live rung now exists (placed + orderId): the candidate is no longer a
      // planned/no-live recovery target, so no candidate-scoped suppression fires.
      ctx.repo.upsertLadder(
        plannedNoLiveLadder({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.26,
              sizeShares: 5.9282,
              notionalUsd: 1.54,
              lifecycle: "placed",
              orderId: String(createOrderId("live-rung")),
            }),
          ],
        }),
      );
      await fireRecoveryPass(ctx, clock);
      expect(skippedAbandonedLabels(ctx)).toHaveLength(0);
      expect(ctx.counters.some((c) => c.name === "ladder_rebuild_skipped_dormant")).toBe(false);

      // And the abandonment is fully cleared: a fresh planned/null candidate needs a
      // brand-new full K streak before it is abandoned again (a second episode).
      ctx.repo.upsertLadder(plannedNoLiveLadder());
      for (let pass = 0; pass < MAX_RECOVERY_ZERO_PLACED_RECOVERIES - 1; pass += 1) {
        await fireRecoveryPass(ctx, clock);
      }
      expect(abandonedLabels(ctx)).toHaveLength(1);
      await fireRecoveryPass(ctx, clock);
      expect(abandonedLabels(ctx)).toHaveLength(2);
    });

    it("gives a position-moved candidate (new ladder id) a fresh streak instead of token-wide blocking", async () => {
      const { ctx, clock, positionRef } = abandonmentHarness(cancelled);
      await ctx.module.start();

      await abandonOnce(ctx, clock);
      expect(abandonedLabels(ctx)).toHaveLength(1);

      // A scale-in moves the average entry: the canonical ladder id changes, so this
      // is a *different* recovery candidate that must not inherit the abandonment.
      await movePosition(ctx, positionRef, { avgEntryPrice: 0.28, costBasisUsdc: 1.68 });

      // K-1 blocked rebuilds of the new candidate must NOT abandon yet.
      for (let pass = 0; pass < MAX_RECOVERY_ZERO_PLACED_RECOVERIES - 1; pass += 1) {
        await fireRecoveryPass(ctx, clock);
      }
      expect(abandonedLabels(ctx)).toHaveLength(1);

      // Only after a full fresh K consecutive zero-placed rebuilds of the new
      // candidate does it abandon — a second, independently counted episode.
      await fireRecoveryPass(ctx, clock);
      expect(abandonedLabels(ctx)).toEqual([
        { band: "medium_high", reason: "client_order_id_blocked_zero_placed" },
        { band: "medium_high", reason: "client_order_id_blocked_zero_placed" },
      ]);
    });

    it("does not block a position-update rebuild as dormant after a candidate is abandoned", async () => {
      const { ctx, clock, positionRef } = abandonmentHarness(cancelled);
      await ctx.module.start();

      await abandonOnce(ctx, clock);
      expect(abandonedLabels(ctx)).toHaveLength(1);
      ctx.counters.length = 0;

      // A scale-in arrives while the prior candidate is abandoned. Exit coverage must
      // still rebuild: the token was never made dormant.
      await movePosition(ctx, positionRef, { avgEntryPrice: 0.28, costBasisUsdc: 1.68 });

      expect(ctx.counters.some((c) => c.name === "ladder_rebuild_skipped_dormant")).toBe(false);
      expect(ctx.counters.some((c) => c.name === "profile_ladder_planned_rungs")).toBe(true);
    });

    it("never places or cancels an order through the abandon branch", async () => {
      const { ctx, clock } = abandonmentHarness(cancelled);
      await ctx.module.start();

      for (let pass = 0; pass < MAX_RECOVERY_ZERO_PLACED_RECOVERIES + 3; pass += 1) {
        await fireRecoveryPass(ctx, clock);
      }

      // The abandon path is pure telemetry: no PlaceOrderRequested, no CancelOrderRequested.
      expect(abandonedLabels(ctx)).toEqual([
        { band: "medium_high", reason: "client_order_id_blocked_zero_placed" },
      ]);
      expect(ctx.orders).toHaveLength(0);
      expect(ctx.cancels).toHaveLength(0);
    });

    // ---- cause-aware abandonment: only deterministic clientOrderId-blocked ----
    // zero-placements may abandon a candidate. Transient zero-placement causes
    // (post-only crossing, unknown/below min order size) must NOT advance the
    // streak; they reset it so recovery resumes the instant the condition clears.

    it("does not abandon a candidate that keeps crossing post-only, and places once the BBO is non-crossing", async () => {
      // Never clientOrderId-blocked: the only zero-placement cause here is the
      // post-only crossing guard (the recomputed 0.26 SELL rung sits at/below the
      // best bid), which is transient — a later BBO move can lift it off the bid.
      const { ctx, clock } = abandonmentHarness(() => null);
      await ctx.module.start();

      // K+ consecutive crossing passes (bestBid 0.30 >= the 0.26 rung price).
      for (let pass = 0; pass < MAX_RECOVERY_ZERO_PLACED_RECOVERIES + 2; pass += 1) {
        await fireRecoveryPassWith(ctx, clock, { bestBid: 0.3, bestAsk: 0.31, midPrice: 0.305 });
      }
      expect(ctx.orders).toHaveLength(0);
      // Crossing is transient: the candidate is never abandoned.
      expect(abandonedLabels(ctx)).toHaveLength(0);
      expect(ctx.counters.some((c) => c.name === "profile_ladder_skipped_crossing_post_only")).toBe(
        true,
      );

      // The BBO drops back below the rung price: the same candidate now places.
      await fireRecoveryPassWith(ctx, clock, { bestBid: 0.24, bestAsk: 0.26, midPrice: 0.25 });
      expect(ctx.orders).toHaveLength(1);
      expect(abandonedLabels(ctx)).toHaveLength(0);
    });

    it("does not abandon a candidate blocked on unknown min order size, and places once it is hydrated", async () => {
      // Never clientOrderId-blocked: the zero-placement cause is unknown min order
      // size (base market omits it, no book cache, fallback unavailable off
      // live-lite). That is transient — a later market snapshot can carry it.
      const { ctx, clock } = abandonmentHarness(() => null);
      await ctx.module.start();

      for (let pass = 0; pass < MAX_RECOVERY_ZERO_PLACED_RECOVERIES + 2; pass += 1) {
        await fireRecoveryPassWith(ctx, clock, { minOrderSize: null });
      }
      expect(ctx.orders).toHaveLength(0);
      expect(abandonedLabels(ctx)).toHaveLength(0);
      expect(
        ctx.counters.some((c) => c.name === "profile_ladder_skipped_unknown_min_order_size"),
      ).toBe(true);

      // A snapshot now carries the min order size: the same candidate places.
      await fireRecoveryPassWith(ctx, clock, { minOrderSize: 1 });
      expect(ctx.orders).toHaveLength(1);
      expect(abandonedLabels(ctx)).toHaveLength(0);
    });

    it("does not abandon a candidate whose rung is below the min order size, and places once the size grows valid", async () => {
      // A position too small to clear the min order size yields a rejected
      // plan (no placement, no abandon-streak increment). Regression guard: a
      // below-min condition must never latch off exit coverage, and recovery must
      // resume the moment the position size grows enough to clear the floor.
      const { ctx, clock, positionRef } = abandonmentHarness(() => null);
      await ctx.module.start();

      // 0.999 shares < the 1-share min order size → plan rejected.
      positionRef.current = position({
        avgEntryPrice: 0.259945,
        costBasisUsdc: 0.259685,
        size: 0.999,
      });
      for (let pass = 0; pass < MAX_RECOVERY_ZERO_PLACED_RECOVERIES + 2; pass += 1) {
        await fireRecoveryPass(ctx, clock);
      }
      expect(ctx.orders).toHaveLength(0);
      expect(abandonedLabels(ctx)).toHaveLength(0);

      // Size grows so the single rung clears the floor: the candidate places.
      positionRef.current = position({
        avgEntryPrice: 0.259945,
        costBasisUsdc: 1.541004,
        size: 5.9282,
      });
      await fireRecoveryPass(ctx, clock);
      expect(ctx.orders).toHaveLength(1);
      expect(abandonedLabels(ctx)).toHaveLength(0);
    });

    it("resets a clientOrderId-blocked streak when a transient zero-placement intervenes", async () => {
      // K-1 deterministic clientOrderId-blocked rebuilds bring the streak one short
      // of the cap. A single transient pass (unknown min order size) then resets it,
      // so a further K-1 blocked rebuilds must not abandon — only a fresh full K does.
      const { ctx, clock } = abandonmentHarness(cancelled);
      await ctx.module.start();

      for (let pass = 0; pass < MAX_RECOVERY_ZERO_PLACED_RECOVERIES - 1; pass += 1) {
        await fireRecoveryPass(ctx, clock);
      }
      expect(abandonedLabels(ctx)).toHaveLength(0);

      // Transient pass: the crossing/unknown-min cause resets the consecutive streak.
      await fireRecoveryPassWith(ctx, clock, { minOrderSize: null });
      expect(abandonedLabels(ctx)).toHaveLength(0);

      // Another K-1 blocked rebuilds: still below the cap because the streak reset.
      for (let pass = 0; pass < MAX_RECOVERY_ZERO_PLACED_RECOVERIES - 1; pass += 1) {
        await fireRecoveryPass(ctx, clock);
      }
      expect(abandonedLabels(ctx)).toHaveLength(0);

      // Only a full fresh K consecutive clientOrderId-blocked rebuilds abandons.
      await fireRecoveryPass(ctx, clock);
      expect(abandonedLabels(ctx)).toEqual([
        { band: "medium_high", reason: "client_order_id_blocked_zero_placed" },
      ]);
    });
  });

  it("closes a stale active planned ladder when the position is already closed", async () => {
    const ctx = setup(mediumHighPolicy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [] },
      orderRepo: { findByTokenId: () => [] },
    });
    ctx.repo.upsertLadder(stalePlannedNoLiveState());
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [stalePlannedNoLiveMarket()],
      timestamp: NOW,
    });

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.cancels).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)).toMatchObject({
      status: "closed",
      closedAtMs: NOW,
    });
    expect(JSON.parse(ctx.repo.getLadder(tokenId)?.metadataJson ?? "{}")).toMatchObject({
      closeReason: "stale_no_open_position",
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_stale_no_position_closed",
      value: 1,
      labels: '{"band":"medium_high","source":"planned_no_live_recovery","reason":"no_open_sell"}',
    });
    expect(ctx.riskEvents).toContainEqual({
      eventType: "profile_ladder_stale_no_position_closed",
      payload: expect.objectContaining({
        tokenId: String(tokenId),
        conditionId: String(conditionId),
        ladderId: "profile_ladder_existing",
        band: "medium_high",
        source: "planned_no_live_recovery",
        reason: "no_open_sell",
      }),
    });
  });

  it("does not advance a stale active ladder with no position while a SELL is open", async () => {
    const openProfileOrder = openSellOrder({
      decisionRuleId: "PROFILE_LADDER",
      signalReason: "profile-ladder-exit",
      metadata: { source: "profile_ladder" },
      status: OrderStatus.Open,
    });
    const ctx = setup(mediumHighPolicy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [] },
      orderRepo: { findByTokenId: () => [openProfileOrder] },
    });
    ctx.repo.upsertLadder(stalePlannedNoLiveState());
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [stalePlannedNoLiveMarket()],
      timestamp: NOW,
    });

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.getLadder(tokenId)).toMatchObject({
      status: "active",
      activeRungs: [{ price: 0.26, lifecycle: "planned" }],
    });
    expect(ctx.counters).toContainEqual({
      name: "profile_ladder_stale_no_position_skipped",
      value: 1,
      labels:
        '{"band":"medium_high","source":"planned_no_live_recovery","reason":"open_sell_exists"}',
    });
  });

  it("reopens the stored ladder for a returned dust residual", async () => {
    let openPositions: Position[] = [];
    const ctx = setup(mediumHighPolicy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => openPositions },
      orderRepo: { findByTokenId: () => [] },
    });
    ctx.repo.upsertLadder(stalePlannedNoLiveState());
    await ctx.module.start();

    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [stalePlannedNoLiveMarket()],
      timestamp: NOW,
    });
    expect(ctx.repo.getLadder(tokenId)?.status).toBe("closed");

    openPositions = [
      stalePlannedNoLivePosition({
        status: PositionStatus.Dust,
        size: 8,
        costBasisUsdc: 2.07956,
      }),
    ];
    await ctx.bus.publish("PositionUpdated", { position: openPositions[0]! });

    const reopened = ctx.repo.getLadder(tokenId);
    expect(ctx.orders).toHaveLength(1);
    expect(reopened).toMatchObject({
      status: "active",
      ladderId: "profile_ladder_existing",
      activeRungs: [{ price: 0.26 }],
    });
    expect(JSON.parse(reopened?.metadataJson ?? "{}")).toMatchObject({
      closeReason: "stale_no_open_position",
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
        positionRepo: { findOpen: () => [position()] },
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
      positionRepo: { findOpen: () => [position()] },
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
    const ctx = setup(policy(), {
      positionRepo: { findOpen: () => [position()] },
      now: () => nowMs,
    });
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
    const ctx = setup(policy(), {
      modeReader: { getMode: () => "flat" },
      positionRepo: { findOpen: () => [position()] },
      now: () => nowMs,
    });
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

    nowMs = NOW + PLANNED_RUNG_RETRY_MS + 1_001;
    await ctx.bus.publish("NormalizedMarketUpdated", {
      markets: [market({ bestBid: 0.09, bestAsk: 0.11, minOrderSize: 5 })],
      timestamp: nowMs,
    });

    expect(ctx.orders).toHaveLength(2);
    expect(ctx.orders[1]?.clientOrderId).not.toBe(first.clientOrderId);
    expect(String(ctx.orders[1]?.signalId)).toMatch(/_pre_retry1$/);
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

  // Phase 2: second call site (dark-compare candidate) must also receive entryStyle + harvestGainPct.
  // Force local mode=flat (via modeReader) and candidate mode=flat so non-maker rungs 1–3 are
  // identical in both plans. Only rung 0 is controlled by entryStyle+harvestGainPct:
  //   WITH fix: candidate rung0 = ceilToTick(0.1 * 1.20, 0.001) = 0.12  → delta≡0
  //   WITHOUT fix: candidate rung0 = ceilToTick(0.1 * 1.1, 0.001) = 0.11 → delta≈-8% (different bucket)
  it("dark-compare candidate plan uses maker entryStyle + config harvestGainPct at second call site", async () => {
    const ctx = setup(darkComparePolicy(), {
      modeReader: { getMode: () => "flat" },
      modeCandidateReader: {
        getCandidate: () => modeCandidate({ sourceMode: "PASSIVE", mappedMode: "flat" }),
      },
      makerEntryPolicy: () => ({ harvestGainPct: 0.2 }),
    });

    await ctx.module.placeLadder(
      position({ entryStyle: "maker" }),
      market({ bestBid: 0.09, bestAsk: 0.2, midPrice: 0.145 }),
    );

    // Placed order is rung 0 of the local plan: 0.1 * 1.20 (maker, flat mode)
    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]?.price).toBe(0.12);
    // Both plans are flat+maker → all rungs identical → zero delta
    const deltaBuckets = counterLabels(
      ctx.counters,
      "profile_ladder_mode_reader_price_delta_bucket",
    );
    expect(deltaBuckets[0]).toMatchObject({ deltaBucket: "minus_2_to_plus_2pct" });
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

    function healthyCoverageStalePriceState(oldOrderId: string): LadderState {
      return staleLowerPriorityState({
        band: "cheap",
        activeRungs: [
          rung({
            price: 0.03,
            sizeShares: 100,
            notionalUsd: 3,
            lifecycle: "placed",
            orderId: oldOrderId,
          }),
        ],
        lastAvgEntry: 0.02,
        lastCostBasisUsdc: 1.6,
      });
    }

    function healthyCoverageScaledPosition(overrides: Partial<Position> = {}): Position {
      return position({
        avgEntryPrice: 0.0245,
        costBasisUsdc: 2.45,
        size: 100,
        ...overrides,
      });
    }

    function healthyCoverageMarket(): NormalizedMarket {
      return market({ bestBid: 0.02, bestAsk: 0.04, midPrice: 0.03 });
    }

    async function rebuildWithPostRefillContext(
      ctx: ReturnType<typeof setup>,
      overrides: Partial<Position> = {},
      marketOverrides: Partial<NormalizedMarket> = {},
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
          ...marketOverrides,
        }),
        "scale_in",
      );
    }

    it("authorizes healthy-coverage replacement from the causal nested scale-in basis increase", async () => {
      const oldOrderId = createOrderId("healthy-scale-in-stale-price");
      const scaledPosition = healthyCoverageScaledPosition();
      const ctx = setup(cheapPostRefillPolicy({ dryRun: false, replacementEnabled: true }), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
        orderRepo: {
          findByTokenId: () => [
            openSellOrder({
              orderId: oldOrderId,
              exchangeOrderId: String(oldOrderId),
              signalReason: "profile-ladder-exit",
              decisionRuleId: "PROFILE_LADDER",
              metadata: { source: "profile_ladder" },
              price: 0.03,
              size: 100,
              sizeUsdc: 3,
            }),
          ],
        },
      });
      ctx.repo.upsertLadder(healthyCoverageStalePriceState(String(oldOrderId)));
      ctx.bus.subscribe("FillReceived", async (event) => {
        if (event.side !== "buy") return;
        await ctx.bus.publish("PositionUpdated", { position: scaledPosition });
      });
      await ctx.module.start();
      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [healthyCoverageMarket()],
        timestamp: NOW,
      });

      await ctx.bus.publish("FillReceived", fill({ side: "buy", price: 0.03, size: 20 }));

      expect(ctx.orders).toHaveLength(1);
      expect(ctx.orders[0]).toMatchObject({
        side: "sell",
        price: 0.027,
        metadata: {
          profileLadderReplacement: {
            oldOrderId: String(oldOrderId),
            oldLiveSellPrice: 0.03,
            selectedPlannedPrice: 0.027,
            liveCoverageRatio: 1,
          },
        },
      });
      expect(
        ctx.riskEvents.find(
          (event) => event.eventType === "profile_ladder_stale_live_rung_detected",
        )?.payload,
      ).toMatchObject({ trigger: "scale_in_stale_price" });
      expect(counterLabels(ctx.counters, "profile_ladder_replacement_trigger_total")).toEqual([
        expect.objectContaining({ trigger: "scale_in_stale_price" }),
      ]);
    });

    it.each([
      ["unchanged", 1.6],
      ["decreased", 1.5],
    ])(
      "does not let the BUY-fill hint bypass healthy coverage when cost basis is %s",
      async (_label, costBasisUsdc) => {
        const oldOrderId = createOrderId(`healthy-no-bypass-${costBasisUsdc}`);
        const ctx = setup(cheapPostRefillPolicy(), {
          modeReader: { getMode: () => "flat" },
          isProfileOwned: () => true,
        });
        ctx.repo.upsertLadder(healthyCoverageStalePriceState(String(oldOrderId)));
        await ctx.module.start();
        await ctx.bus.publish("NormalizedMarketUpdated", {
          markets: [healthyCoverageMarket()],
          timestamp: NOW,
        });
        await ctx.bus.publish("FillReceived", fill({ side: "buy", price: 0.03, size: 20 }));

        await ctx.bus.publish("PositionUpdated", {
          position: healthyCoverageScaledPosition({ costBasisUsdc }),
        });

        expect(ctx.orders).toHaveLength(0);
        expect(ctx.counters).toContainEqual({
          name: "profile_ladder_rebuilt",
          value: 1,
          labels: '{"band":"cheap","reason":"scale_in"}',
        });
        expect(
          ctx.riskEvents.some(
            (event) => event.eventType === "profile_ladder_stale_live_rung_detected",
          ),
        ).toBe(false);
      },
    );

    it.each(["profile_reclass", "bbo_major", "bbo_strong"] as const)(
      "does not bypass healthy coverage for a %s rebuild",
      async (reason) => {
        const oldOrderId = createOrderId(`healthy-no-bypass-${reason}`);
        const ctx = setup(cheapPostRefillPolicy(), {
          modeReader: { getMode: () => "flat" },
          isProfileOwned: () => true,
        });
        ctx.repo.upsertLadder(healthyCoverageStalePriceState(String(oldOrderId)));

        await ctx.module.rebuildLadder(
          healthyCoverageScaledPosition(),
          healthyCoverageMarket(),
          reason,
        );

        expect(ctx.orders).toHaveLength(0);
        expect(
          ctx.riskEvents.some(
            (event) => event.eventType === "profile_ladder_stale_live_rung_detected",
          ),
        ).toBe(false);
      },
    );

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
            trigger: "low_coverage",
            liveCoverageRatio: 0.16,
            liveRungIndex: 1,
            intendedRungIndex: 0,
            oldLivePrice: 0.104,
            selectedPlannedPrice: 0.088,
          }),
        }),
      );
      expect(counterLabels(ctx.counters, "profile_ladder_replacement_trigger_total")).toEqual([
        expect.objectContaining({ trigger: "low_coverage" }),
      ]);
      const state = ctx.repo.getLadder(tokenId)!;
      expect(state.activeRungs.some((activeRung) => activeRung.price === 0.104)).toBe(true);
      expect(state.activeRungs.some((activeRung) => activeRung.price === 0.088)).toBe(true);
    });

    it("detects the same stale live rung when market min order size is unknown", async () => {
      // PR2 detection resolves the intended planned rung via the shared
      // min-order fallback helper. With market.minOrderSize null the helper
      // resolves the same floor as the previous `?? 1`, so detection is byte
      // identical to the known-min case above and no order is placed (placement
      // still fails closed without allowFallback).
      const ctx = setup(postRefillPolicy(), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
      });
      ctx.repo.upsertLadder(staleLowerPriorityState());

      await rebuildWithPostRefillContext(ctx, {}, { minOrderSize: null });

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
            intendedRungIndex: 0,
            oldLivePrice: 0.104,
            selectedPlannedPrice: 0.088,
          }),
        }),
      );
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

    it.each([
      {
        name: "Iran 0.111 to 0.077",
        livePrice: 0.111,
        avgEntryPrice: 0.07,
        expectedPlannedPrice: 0.077,
        bestBid: 0.04,
        bestAsk: 0.05,
      },
      {
        name: "Iran deeper 0.111 to 0.052",
        livePrice: 0.111,
        avgEntryPrice: 0.047,
        costBasisUsdc: 20,
        enableCheap: true,
        expectedPlannedPrice: 0.052,
        bestBid: 0.04,
        bestAsk: 0.05,
      },
      {
        name: "Netherlands 0.101 to 0.034",
        livePrice: 0.101,
        avgEntryPrice: 0.0304,
        costBasisUsdc: 20,
        enableCheap: true,
        expectedPlannedPrice: 0.034,
        bestBid: 0.006,
        bestAsk: 0.029,
      },
    ])("detects Plankton-calibrated replacement candidate: $name", async (fixture) => {
      const ctx = setup(fixture.enableCheap ? cheapPostRefillPolicy() : postRefillPolicy(), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: fixture.livePrice,
              sizeShares: 40,
              notionalUsd: fixture.livePrice * 40,
              lifecycle: "placed",
              orderId: String(createOrderId(`plankton-gate-${fixture.name}`)),
            }),
          ],
        }),
      );

      await rebuildWithPostRefillContext(
        ctx,
        {
          avgEntryPrice: fixture.avgEntryPrice,
          costBasisUsdc: fixture.costBasisUsdc ?? fixture.avgEntryPrice * 250,
          size: 250,
        },
        {
          bestBid: fixture.bestBid,
          bestAsk: fixture.bestAsk,
          midPrice: (fixture.bestBid + fixture.bestAsk) / 2,
        },
      );

      expect(
        ctx.riskEvents.find(
          (event) => event.eventType === "profile_ladder_stale_live_rung_detected",
        )?.payload,
      ).toMatchObject({
        oldLivePrice: fixture.livePrice,
        selectedPlannedPrice: fixture.expectedPlannedPrice,
      });
      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(0);
    });

    it("filters Alan-style replacement that would move the live sell higher", async () => {
      const ctx = setup(postRefillPolicy(), {
        modeReader: { getMode: () => "avg_down" },
        isProfileOwned: () => true,
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.14,
              sizeShares: 7.5,
              notionalUsd: 1.05,
              lifecycle: "placed",
              orderId: String(createOrderId("alan-live")),
            }),
          ],
        }),
      );

      await rebuildWithPostRefillContext(
        ctx,
        { avgEntryPrice: 0.12, costBasisUsdc: 3.7224, size: 31.02 },
        { bestBid: 0.003, bestAsk: 0.028, midPrice: 0.0155 },
      );

      expect(ctx.counters.some((counter) => counter.name.includes("stale_live_rung"))).toBe(false);
      expect(ctx.riskEvents.some((event) => event.eventType.includes("stale_live_rung"))).toBe(
        false,
      );
      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(0);
    });

    it("filters micro-reprice improvements below the configured 5 percent gate", async () => {
      const ctx = setup(postRefillPolicy(), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.1,
              sizeShares: 40,
              notionalUsd: 4,
              lifecycle: "placed",
              orderId: String(createOrderId("micro-reprice-live")),
            }),
          ],
        }),
      );

      await rebuildWithPostRefillContext(
        ctx,
        { avgEntryPrice: 0.087, costBasisUsdc: 21.75, size: 250 },
        { bestBid: 0.05, bestAsk: 0.09, midPrice: 0.07 },
      );

      expect(ctx.counters.some((counter) => counter.name.includes("stale_live_rung"))).toBe(false);
      expect(ctx.riskEvents.some((event) => event.eventType.includes("stale_live_rung"))).toBe(
        false,
      );
      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(0);
    });

    it("detects at the exact 5 percent replacement price improvement boundary", async () => {
      const ctx = setup(postRefillPolicy(), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.1,
              sizeShares: 40,
              notionalUsd: 4,
              lifecycle: "placed",
              orderId: String(createOrderId("boundary-live")),
            }),
          ],
        }),
      );

      await rebuildWithPostRefillContext(
        ctx,
        { avgEntryPrice: 0.086, costBasisUsdc: 21.5, size: 250 },
        { bestBid: 0.05, bestAsk: 0.09, midPrice: 0.07 },
      );

      expect(
        ctx.riskEvents.find(
          (event) => event.eventType === "profile_ladder_stale_live_rung_detected",
        )?.payload,
      ).toMatchObject({
        oldLivePrice: 0.1,
        selectedPlannedPrice: 0.095,
      });
      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(0);
    });

    it("does not accept a replacement candidate below the positive sell floor", () => {
      const evaluation = evaluatePostRefillLiveRung({
        state: staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.15,
              sizeShares: 40,
              notionalUsd: 6,
              lifecycle: "planned",
              orderId: null,
            }),
            rung({
              rungIndex: 1,
              price: 0.3,
              sizeShares: 40,
              notionalUsd: 12,
              lifecycle: "placed",
              orderId: String(createOrderId("sub-floor-live")),
            }),
          ],
        }),
        position: position({ avgEntryPrice: 0.149, costBasisUsdc: 37.25, size: 250 }),
        market: market({ bestBid: 0.05, bestAsk: 0.2, midPrice: 0.125, tickSize: 0.01 }),
        config: postRefillPolicy().sellLadder.postRefillFollowThrough,
      });

      expect(evaluation?.decision).toBeNull();
    });

    it("accepts a replacement candidate at or above the positive sell floor", () => {
      const evaluation = evaluatePostRefillLiveRung({
        state: staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.16,
              sizeShares: 40,
              notionalUsd: 6.4,
              lifecycle: "planned",
              orderId: null,
            }),
            rung({
              rungIndex: 1,
              price: 0.3,
              sizeShares: 40,
              notionalUsd: 12,
              lifecycle: "placed",
              orderId: String(createOrderId("valid-floor-live")),
            }),
          ],
        }),
        position: position({ avgEntryPrice: 0.149, costBasisUsdc: 37.25, size: 250 }),
        market: market({ bestBid: 0.05, bestAsk: 0.2, midPrice: 0.125, tickSize: 0.01 }),
        config: postRefillPolicy().sellLadder.postRefillFollowThrough,
      });

      expect(evaluation?.decision).toMatchObject({
        positiveFloorPrice: 0.16,
        liveRung: expect.objectContaining({ price: 0.3 }),
        intendedRung: expect.objectContaining({ price: 0.16 }),
      });
    });

    it("uses tick-rounded positive floor at the replacement decision point", () => {
      const evaluation = evaluatePostRefillLiveRung({
        state: staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.2,
              sizeShares: 40,
              notionalUsd: 8,
              lifecycle: "planned",
              orderId: null,
            }),
            rung({
              rungIndex: 1,
              price: 0.3,
              sizeShares: 40,
              notionalUsd: 12,
              lifecycle: "placed",
              orderId: String(createOrderId("tick-rounded-floor-live")),
            }),
          ],
        }),
        position: position({ avgEntryPrice: 0.197, costBasisUsdc: 49.25, size: 250 }),
        market: market({ bestBid: 0.05, bestAsk: 0.22, midPrice: 0.135, tickSize: 0.01 }),
        config: postRefillPolicy().sellLadder.postRefillFollowThrough,
      });

      expect(evaluation?.decision).toBeNull();
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
      const ctx = setup(postRefillPolicy({ dryRun: true, replacementEnabled: true }), {
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

    it("publishes a ProfileLadder replacement request with old-order metadata when live PR2 is enabled", async () => {
      const oldOrderId = createOrderId("stale-lower-priority-live");
      const ctx = setup(postRefillPolicy({ dryRun: false, replacementEnabled: true }), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
        profileStateReader: { getProfileState: () => "HARVESTING" },
        orderRepo: {
          findByTokenId: () => [
            openSellOrder({
              orderId: oldOrderId,
              exchangeOrderId: String(oldOrderId),
              signalReason: "profile-ladder-exit",
              decisionRuleId: "PROFILE_LADDER",
              metadata: { source: "profile_ladder" },
              price: 0.104,
              size: 40,
              sizeUsdc: 4.16,
              status: OrderStatus.Open,
            }),
          ],
        },
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.104,
              sizeShares: 40,
              notionalUsd: 4.16,
              lifecycle: "placed",
              orderId: String(oldOrderId),
            }),
          ],
        }),
      );

      await rebuildWithPostRefillContext(ctx);

      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(1);
      expect(ctx.orders[0]).toMatchObject({
        side: "sell",
        price: 0.088,
        signalReason: "profile-ladder-exit",
        metadata: {
          profileLadderReplacement: {
            kind: "post_refill_follow_through",
            oldOrderId: String(oldOrderId),
            oldLiveSellPrice: 0.104,
            selectedPlannedPrice: 0.088,
            selectedPlannedRungIndex: 0,
            positiveFloorPrice: 0.081,
            liveCoverageRatio: 0.16,
            minReplacementPriceImprovementRatio: 0.05,
          },
        },
      });
      const pending = [
        ...(
          ctx.module as unknown as {
            pendingRungByClientOrderId: Map<string, Record<string, unknown>>;
          }
        ).pendingRungByClientOrderId.values(),
      ][0]!;
      expect(pending).toMatchObject({
        kind: "post_refill_replacement",
        oldOrderId: String(oldOrderId),
        createdAtMs: NOW,
        deadlineAtMs: NOW + 60_000,
      });
      expect(
        counterLabels(ctx.counters, "profile_ladder_replacement_place_requested_total"),
      ).toEqual([
        expect.objectContaining({
          action: "request",
          band: "medium_low",
          mode: "flat",
          reason: "intended_active_blocked",
          state: "HARVESTING",
        }),
      ]);
    });

    it("keeps PR2 replacement clientOrderId deterministic (no retry probe) even when a terminal-dead rejected row exists for it", async () => {
      const oldOrderId = createOrderId("stale-lower-priority-live");
      const ctx = setup(postRefillPolicy({ dryRun: false, replacementEnabled: true }), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
        profileStateReader: { getProfileState: () => "HARVESTING" },
        orderRepo: {
          findByTokenId: () => [
            openSellOrder({
              orderId: oldOrderId,
              exchangeOrderId: String(oldOrderId),
              signalReason: "profile-ladder-exit",
              decisionRuleId: "PROFILE_LADDER",
              metadata: { source: "profile_ladder" },
              price: 0.104,
              size: 40,
              sizeUsdc: 4.16,
              status: OrderStatus.Open,
            }),
          ],
          // A terminal-dead rejected row for *every* clientOrderId would make the
          // standard retry probe bump to a `_retry` suffix. PR2 must NOT probe.
          findByClientOrderId: () =>
            openSellOrder({
              orderId: createOrderId("dead-rejected-pr2"),
              status: OrderStatus.Rejected,
              exchangeOrderId: null,
              decisionRuleId: "PROFILE_LADDER",
              metadata: { source: "profile_ladder" },
            }),
        },
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.104,
              sizeShares: 40,
              notionalUsd: 4.16,
              lifecycle: "placed",
              orderId: String(oldOrderId),
            }),
          ],
        }),
      );

      await rebuildWithPostRefillContext(ctx);

      expect(ctx.orders).toHaveLength(1);
      const published = ctx.orders[0]!;
      // PR2 keeps its deterministic, non-suffixed clientOrderId/signalId.
      expect(String(published.signalId)).not.toContain("retry");
      expect(published.clientOrderId).toBe(
        buildClientOrderId({ signalId: String(published.signalId), tokenId, side: "sell" }),
      );
      expect(
        ctx.counters.some((counter) => counter.name === "profile_ladder_clientorderid_retry_used"),
      ).toBe(false);
    });

    it("keeps PR2 fail-closed in live-lite when min order size is unknown (no fallback leak)", async () => {
      const oldOrderId = createOrderId("stale-lower-priority-live");
      const ctx = setup(postRefillPolicy({ dryRun: false, replacementEnabled: true }), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
        runtimeMode: "live-lite",
        profileStateReader: { getProfileState: () => "HARVESTING" },
        orderRepo: {
          findByTokenId: () => [
            openSellOrder({
              orderId: oldOrderId,
              exchangeOrderId: String(oldOrderId),
              signalReason: "profile-ladder-exit",
              decisionRuleId: "PROFILE_LADDER",
              metadata: { source: "profile_ladder" },
              price: 0.104,
              size: 40,
              sizeUsdc: 4.16,
              status: OrderStatus.Open,
            }),
          ],
        },
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.104,
              sizeShares: 40,
              notionalUsd: 4.16,
              lifecycle: "placed",
              orderId: String(oldOrderId),
            }),
          ],
        }),
      );

      await rebuildWithPostRefillContext(ctx, {}, { minOrderSize: null });

      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(0);
      expect(counterLabels(ctx.counters, "profile_ladder_replacement_place_skipped_total")).toEqual(
        [
          expect.objectContaining({
            action: "skip",
            band: "medium_low",
            mode: "flat",
            reason: "unknown_min_order",
            state: "HARVESTING",
          }),
        ],
      );
      expect(counterLabels(ctx.counters, "profile_ladder_min_order_fallback_total")).toHaveLength(
        0,
      );
    });

    it("fails closed before publish when a non-ProfileLadder live SELL creates ambiguity", async () => {
      const oldOrderId = createOrderId("stale-live-with-legacy-sell");
      const ctx = setup(postRefillPolicy({ dryRun: false, replacementEnabled: true }), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
        orderRepo: {
          findByTokenId: () => [
            openSellOrder({
              orderId: oldOrderId,
              exchangeOrderId: String(oldOrderId),
              signalReason: "profile-ladder-exit",
              decisionRuleId: "PROFILE_LADDER",
              metadata: { source: "profile_ladder" },
              price: 0.104,
              status: OrderStatus.Open,
            }),
            openSellOrder({
              orderId: createOrderId("legacy-live-sell"),
              exchangeOrderId: "legacy-live-sell",
              signalReason: "track-s1-ladder",
              decisionRuleId: "LEGACY_SELL",
              metadata: { source: "s1" },
              price: 0.15,
              status: OrderStatus.Open,
            }),
          ],
        },
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.104,
              sizeShares: 40,
              notionalUsd: 4.16,
              lifecycle: "placed",
              orderId: String(oldOrderId),
            }),
          ],
        }),
      );

      await rebuildWithPostRefillContext(ctx);

      expect(ctx.cancels).toHaveLength(0);
      expect(ctx.orders).toHaveLength(0);
      expect(counterLabels(ctx.counters, "profile_ladder_replacement_place_skipped_total")).toEqual(
        [
          expect.objectContaining({
            action: "skip",
            reason: "sell-replace-duplicate-live-sell",
          }),
        ],
      );
    });

    it.each(["sell-replace-pending", "sell-replace-lock-retry"])(
      "keeps pending replacement on nonterminal %s deferral",
      async (reason) => {
        const oldOrderId = createOrderId("deferred-replacement-live");
        const ctx = setup(postRefillPolicy({ dryRun: false, replacementEnabled: true }), {
          modeReader: { getMode: () => "flat" },
          isProfileOwned: () => true,
          orderRepo: {
            findByTokenId: () => [
              openSellOrder({
                orderId: oldOrderId,
                exchangeOrderId: String(oldOrderId),
                signalReason: "profile-ladder-exit",
                decisionRuleId: "PROFILE_LADDER",
                metadata: { source: "profile_ladder" },
                price: 0.104,
                status: OrderStatus.Open,
              }),
            ],
          },
        });
        ctx.repo.upsertLadder(
          staleLowerPriorityState({
            activeRungs: [
              rung({
                rungIndex: 0,
                price: 0.104,
                sizeShares: 40,
                notionalUsd: 4.16,
                lifecycle: "placed",
                orderId: String(oldOrderId),
              }),
            ],
          }),
        );
        await rebuildWithPostRefillContext(ctx);
        const command = ctx.orders[0]!;

        await ctx.bus.publish("OrderRejected", {
          ...orderRejected(command),
          reason,
        });

        expect(
          (
            ctx.module as unknown as {
              pendingRungByClientOrderId: Map<string, unknown>;
            }
          ).pendingRungByClientOrderId.size,
        ).toBe(1);
        await rebuildWithPostRefillContext(ctx);
        expect(ctx.orders).toHaveLength(1);
      },
    );

    it("clears pending replacement on terminal rejection and starts cooldown", async () => {
      const oldOrderId = createOrderId("terminal-replacement-live");
      const ctx = setup(postRefillPolicy({ dryRun: false, replacementEnabled: true }), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
        orderRepo: {
          findByTokenId: () => [
            openSellOrder({
              orderId: oldOrderId,
              exchangeOrderId: String(oldOrderId),
              signalReason: "profile-ladder-exit",
              decisionRuleId: "PROFILE_LADDER",
              metadata: { source: "profile_ladder" },
              price: 0.104,
              status: OrderStatus.Open,
            }),
          ],
        },
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.104,
              sizeShares: 40,
              notionalUsd: 4.16,
              lifecycle: "placed",
              orderId: String(oldOrderId),
            }),
          ],
        }),
      );
      await ctx.module.start();
      await rebuildWithPostRefillContext(ctx);
      const command = ctx.orders[0]!;

      await ctx.bus.publish("OrderRejected", {
        ...orderRejected(command),
        reason: "sell-replace-chain-cap",
      });
      await rebuildWithPostRefillContext(ctx);

      expect(
        (
          ctx.module as unknown as {
            pendingRungByClientOrderId: Map<string, unknown>;
          }
        ).pendingRungByClientOrderId.size,
      ).toBe(0);
      expect(ctx.orders).toHaveLength(1);
      expect(counterLabels(ctx.counters, "profile_ladder_replacement_failed_total")).toEqual([
        expect.objectContaining({ action: "fail", reason: "sell-replace-chain-cap" }),
      ]);
    });

    it("marks replacement rung placed and clears old live rung on final OrderPlaced", async () => {
      const oldOrderId = createOrderId("final-replacement-live");
      const ctx = setup(postRefillPolicy({ dryRun: false, replacementEnabled: true }), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
        orderRepo: {
          findByTokenId: () => [
            openSellOrder({
              orderId: oldOrderId,
              exchangeOrderId: String(oldOrderId),
              signalReason: "profile-ladder-exit",
              decisionRuleId: "PROFILE_LADDER",
              metadata: { source: "profile_ladder" },
              price: 0.104,
              status: OrderStatus.Open,
            }),
          ],
        },
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.104,
              sizeShares: 40,
              notionalUsd: 4.16,
              lifecycle: "placed",
              orderId: String(oldOrderId),
            }),
          ],
        }),
      );
      await ctx.module.start();
      await rebuildWithPostRefillContext(ctx);
      const command = ctx.orders[0]!;

      await ctx.bus.publish("OrderPlaced", orderPlaced(command, createOrderId("replacement-new")));

      const state = ctx.repo.getLadder(tokenId)!;
      expect(state.activeRungs.find((entry) => entry.orderId === String(oldOrderId))).toBeFalsy();
      expect(state.activeRungs.find((entry) => entry.orderId === "replacement-new")).toMatchObject({
        rungIndex: 0,
        lifecycle: "placed",
      });
      expect(
        (
          ctx.module as unknown as {
            pendingRungByClientOrderId: Map<string, unknown>;
          }
        ).pendingRungByClientOrderId.size,
      ).toBe(0);
    });

    it("times out orphaned pending replacement without placing another order", async () => {
      vi.useFakeTimers();
      try {
        let nowMs = NOW;
        const oldOrderId = createOrderId("timeout-replacement-live");
        const ctx = setup(postRefillPolicy({ dryRun: false, replacementEnabled: true }), {
          modeReader: { getMode: () => "flat" },
          isProfileOwned: () => true,
          now: () => nowMs,
          orderRepo: {
            findByTokenId: () => [
              openSellOrder({
                orderId: oldOrderId,
                exchangeOrderId: String(oldOrderId),
                signalReason: "profile-ladder-exit",
                decisionRuleId: "PROFILE_LADDER",
                metadata: { source: "profile_ladder" },
                price: 0.104,
                status: OrderStatus.Open,
              }),
            ],
          },
        });
        ctx.repo.upsertLadder(
          staleLowerPriorityState({
            activeRungs: [
              rung({
                rungIndex: 0,
                price: 0.104,
                sizeShares: 40,
                notionalUsd: 4.16,
                lifecycle: "placed",
                orderId: String(oldOrderId),
              }),
            ],
          }),
        );
        await ctx.module.start();
        await rebuildWithPostRefillContext(ctx);
        expect(ctx.orders).toHaveLength(1);

        nowMs = NOW + 60_001;
        await vi.advanceTimersByTimeAsync(PLANNED_RUNG_RETRY_MS + 1);

        expect(
          (
            ctx.module as unknown as {
              pendingRungByClientOrderId: Map<string, unknown>;
            }
          ).pendingRungByClientOrderId.size,
        ).toBe(0);
        expect(ctx.orders).toHaveLength(1);
        expect(counterLabels(ctx.counters, "profile_ladder_replacement_failed_total")).toEqual([
          expect.objectContaining({ action: "fail", reason: "cancel_ack_timeout" }),
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores late OrderPlaced after pending replacement timeout", async () => {
      vi.useFakeTimers();
      try {
        let nowMs = NOW;
        const oldOrderId = createOrderId("late-after-timeout-live");
        const ctx = setup(postRefillPolicy({ dryRun: false, replacementEnabled: true }), {
          modeReader: { getMode: () => "flat" },
          isProfileOwned: () => true,
          now: () => nowMs,
          orderRepo: {
            findByTokenId: () => [
              openSellOrder({
                orderId: oldOrderId,
                exchangeOrderId: String(oldOrderId),
                signalReason: "profile-ladder-exit",
                decisionRuleId: "PROFILE_LADDER",
                metadata: { source: "profile_ladder" },
                price: 0.104,
                status: OrderStatus.Open,
              }),
            ],
          },
        });
        ctx.repo.upsertLadder(
          staleLowerPriorityState({
            activeRungs: [
              rung({
                rungIndex: 0,
                price: 0.104,
                sizeShares: 40,
                notionalUsd: 4.16,
                lifecycle: "placed",
                orderId: String(oldOrderId),
              }),
            ],
          }),
        );
        await ctx.module.start();
        await rebuildWithPostRefillContext(ctx);
        const command = ctx.orders[0]!;

        nowMs = NOW + 60_001;
        await vi.advanceTimersByTimeAsync(PLANNED_RUNG_RETRY_MS + 1);
        await ctx.bus.publish("OrderPlaced", orderPlaced(command, createOrderId("late-new-order")));

        const state = ctx.repo.getLadder(tokenId)!;
        expect(
          state.activeRungs.find((entry) => entry.orderId === String(oldOrderId)),
        ).toMatchObject({
          lifecycle: "placed",
        });
        expect(state.activeRungs.find((entry) => entry.orderId === "late-new-order")).toBeFalsy();
        expect(ctx.orders).toHaveLength(1);
        expect(
          (
            ctx.module as unknown as {
              pendingRungByClientOrderId: Map<string, unknown>;
            }
          ).pendingRungByClientOrderId.size,
        ).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("aborts pending replacement when the old live order fills before final outcome", async () => {
      const oldOrderId = createOrderId("fill-abort-replacement-live");
      const ctx = setup(postRefillPolicy({ dryRun: false, replacementEnabled: true }), {
        modeReader: { getMode: () => "flat" },
        isProfileOwned: () => true,
        orderRepo: {
          findByTokenId: () => [
            openSellOrder({
              orderId: oldOrderId,
              exchangeOrderId: String(oldOrderId),
              signalReason: "profile-ladder-exit",
              decisionRuleId: "PROFILE_LADDER",
              metadata: { source: "profile_ladder" },
              price: 0.104,
              status: OrderStatus.Open,
            }),
          ],
        },
      });
      ctx.repo.upsertLadder(
        staleLowerPriorityState({
          activeRungs: [
            rung({
              rungIndex: 0,
              price: 0.104,
              sizeShares: 40,
              notionalUsd: 4.16,
              lifecycle: "placed",
              orderId: String(oldOrderId),
            }),
          ],
        }),
      );
      await ctx.module.start();
      await rebuildWithPostRefillContext(ctx);

      await ctx.bus.publish("FillReceived", fill({ orderId: oldOrderId, size: 10 }));
      await rebuildWithPostRefillContext(ctx);

      expect(
        (
          ctx.module as unknown as {
            pendingRungByClientOrderId: Map<string, unknown>;
          }
        ).pendingRungByClientOrderId.size,
      ).toBe(0);
      expect(ctx.orders).toHaveLength(1);
      expect(
        ctx.repo.getLadder(tokenId)?.activeRungs.find((entry) => entry.orderId === oldOrderId),
      ).toMatchObject({
        lifecycle: "partially_filled",
        filledSizeShares: 10,
      });
      expect(counterLabels(ctx.counters, "profile_ladder_replacement_failed_total")).toEqual([
        expect.objectContaining({ action: "fail", reason: "old_order_filled" }),
      ]);
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

    it("preserves the pending rung target after a pre-exchange rejection", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
      const pending = await placePendingRung(ctx);

      await ctx.bus.publish("OrderRejected", orderRejected(pending));
      await ctx.module.rebuildLadder(position({ avgEntryPrice: 0.12 }), market(), "scale_in");

      expect(ctx.orders).toHaveLength(1);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        price: pending.price,
        preExchangeRetryCount: 1,
      });
    });

    it("preserves the pending rung target after a pre-exchange skip", async () => {
      const ctx = setup(policy(), { modeReader: { getMode: () => "flat" } });
      const pending = await placePendingRung(ctx);

      await ctx.bus.publish("OrderSkipped", orderSkipped(pending));
      await ctx.module.rebuildLadder(position({ avgEntryPrice: 0.12 }), market(), "scale_in");

      expect(ctx.orders).toHaveLength(1);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        price: pending.price,
        preExchangeRetryCount: 1,
      });
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
        const ctx = setup(policy(), {
          modeReader: { getMode: () => "flat" },
          positionRepo: { findOpen: () => [position()] },
        });
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

    it("does not place a post-fill next rung after the position is closed", async () => {
      vi.useFakeTimers();
      try {
        let openPositions = [position()];
        const ctx = setup(policy(), {
          modeReader: { getMode: () => "flat" },
          positionRepo: { findOpen: () => openPositions },
          orderRepo: { findByTokenId: () => [] },
        });
        await placeAndBackfill(ctx);

        await ctx.bus.publish(
          "FillReceived",
          fill({ orderId: createOrderId("profile-ladder-bottom-rung"), size: 95 }),
        );
        openPositions = [];

        await vi.advanceTimersByTimeAsync(900_000 + 1);

        expect(ctx.orders).toHaveLength(1);
        expect(ctx.cancels).toHaveLength(0);
        expect(ctx.repo.getLadder(tokenId)).toMatchObject({
          status: "closed",
          closedAtMs: NOW,
        });
        expect(ctx.counters).toContainEqual({
          name: "profile_ladder_stale_no_position_closed",
          value: 1,
          labels: '{"band":"medium_low","source":"post_fill_reeval","reason":"no_open_sell"}',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("rests on a partial SELL fill and never duplicates the live rung at reevaluation", async () => {
      vi.useFakeTimers();
      try {
        const ctx = setup(policy(), {
          modeReader: { getMode: () => "flat" },
          positionRepo: { findOpen: () => [position()] },
        });
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
        const ctx = setup(policy(), {
          modeReader: { getMode: () => "flat" },
          positionRepo: { findOpen: () => [position()] },
        });
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
        const ctx = setup(policy(), {
          modeReader: { getMode: () => "flat" },
          positionRepo: { findOpen: () => [position()] },
        });
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

  it("adopts dormant positions for SELL coverage", async () => {
    const ctx = setup(adoptionPolicy(), {
      positionRepo: { findOpen: () => [position()] },
      isProfileOwned: () => true,
      isDormant: () => true,
    });

    await warmAndAdopt(ctx);

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.repo.getLadder(tokenId)).not.toBeNull();
    expect(summaryOf(ctx)).toMatchObject({
      eligible_count: 1,
      adopted_count: 1,
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

  describe("Stage B1 durable terminal recovery", () => {
    function positionReader(rows: Position[]) {
      return {
        findOpen: () => rows.filter((row) => row.status === PositionStatus.Open),
        findDust: () => rows.filter((row) => row.status === PositionStatus.Dust),
        findActiveByTokenId: (id: TokenId) =>
          rows.filter((row) => row.tokenId === id && row.status !== PositionStatus.Closed),
      };
    }

    function terminalOrder(overrides: Partial<Order> = {}): Order {
      return openSellOrder({
        orderId: createOrderId("stage-b-terminal-order"),
        exchangeOrderId: "stage-b-exchange-order",
        status: OrderStatus.Cancelled,
        fillProgressShares: 3,
        price: 0.11,
        size: 8,
        sizeUsdc: 0.88,
        decisionRuleId: "PROFILE_LADDER",
        signalReason: "profile-ladder-exit",
        metadata: { source: "profile_ladder" },
        ...overrides,
      });
    }

    function persistedRecoveryState(overrides: Partial<LadderRung> = {}): LadderState {
      return ladderState({
        activeRungs: [
          rung({
            sizeShares: 10,
            filledSizeShares: 2,
            terminalRetryKey: "prior-terminal",
            attemptFilledBaseShares: 2,
            attemptSubmittedShares: 8,
            ...overrides,
          }),
        ],
      });
    }

    function persistedAttemptOrder(state: LadderState, overrides: Partial<Order> = {}): Order {
      const attempt = state.activeRungs[0]!;
      const signalId = `profile_ladder_${String(tokenId)}_${state.ladderId}_0_terminal_retry_${attempt.terminalRetryKey}`;
      return terminalOrder({
        orderId: createOrderId("accepted-retry-order"),
        exchangeOrderId: "accepted-retry-exchange",
        clientOrderId: buildClientOrderId({ signalId, tokenId, side: "sell" }),
        signalId,
        status: OrderStatus.Open,
        fillProgressShares: null,
        size: attempt.attemptSubmittedShares!,
        metadata: {
          source: "profile_ladder",
          profileLadder: {
            ladderId: state.ladderId,
            rungIndex: 0,
            attemptFilledBaseShares: attempt.attemptFilledBaseShares,
            attemptSubmittedShares: attempt.attemptSubmittedShares,
          },
        },
        ...overrides,
      });
    }

    function tradingDisabledRejectedOrder(
      command: PlaceOrderCommand,
      overrides: Partial<Order> = {},
    ): Order {
      const preparedHash = "0xprofile-trading-disabled";
      return openSellOrder({
        orderId: createOrderId(preparedHash),
        exchangeOrderId: preparedHash,
        clientOrderId: command.clientOrderId,
        tokenId: command.tokenId,
        conditionId: command.conditionId,
        side: "sell",
        price: command.price,
        size: command.size,
        sizeUsdc: command.price * command.size,
        status: OrderStatus.Rejected,
        fillProgressShares: 0,
        signalId: command.signalId ?? null,
        signalReason: command.signalReason ?? null,
        decisionRuleId: "PROFILE_LADDER",
        exchangeErrorMessage: "trading is disabled",
        exchangeErrorPayload: JSON.stringify({
          responseBody: { status: 503, error: "trading is disabled" },
        }),
        exchangeRejectionReason: "rejection_trading_disabled",
        ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
        ...overrides,
      });
    }

    function tradingDisabledRejectedEvent(
      command: PlaceOrderCommand,
      synthetic: boolean,
    ): RuntimeEventMap["OrderRejected"] {
      return {
        ...orderRejected(command),
        reason: "trading is disabled",
        errorCode: ExchangeErrorCode.Unknown,
        exchangeErrorMessage: "trading is disabled",
        exchangeErrorDetails: {
          responseBody: { status: 503, error: "trading is disabled" },
          ...(synthetic ? { synthetic: "trading-disabled-cooldown", retryAt: NOW + 300_000 } : {}),
        },
      };
    }

    it("deduplicates the same adoption position across open and dust scans", async () => {
      const candidate = position();
      const ctx = setup(adoptionPolicy(), {
        positionRepo: {
          findOpen: () => [candidate],
          findDust: () => [candidate],
          findActiveByTokenId: () => [candidate],
        },
        orderRepo: { findByTokenId: () => [] },
        isProfileOwned: () => true,
      });
      await ctx.module.start();
      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });
      await ctx.module.adoptExistingLadders();

      expect(ctx.orders).toHaveLength(1);
      expect(
        ctx.riskEvents.find((event) => event.eventType === "ladder_adoption_summary")?.payload,
      ).toMatchObject({ eligible_count: 1, adopted_count: 1 });
    });

    it("re-arms an exchange-backed partial terminal attempt for only the cumulative residual", async () => {
      let nowMs = NOW;
      const livePosition = position({ size: 10, costBasisUsdc: 1 });
      let terminal = terminalOrder();
      const ctx = setup(policy(), {
        positionRepo: positionReader([livePosition]) as any,
        orderRepo: {
          findByTokenId: () => [terminal],
          findByClientOrderId: () => null,
        },
        profileStateReader: { getProfileState: () => "ABANDONED_DORMANT" },
        now: () => nowMs,
      });
      ctx.repo.upsertLadder(
        ladderState({
          activeRungs: [
            rung({
              sizeShares: 10,
              notionalUsd: 1.1,
              lifecycle: "partially_filled",
              orderId: String(terminal.orderId),
              filledSizeShares: 2,
              ...({ attemptFilledBaseShares: 2, attemptSubmittedShares: 8 } as any),
            }),
          ],
        }),
      );
      await ctx.module.start();

      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: nowMs });

      expect(ctx.orders).toHaveLength(1);
      expect(ctx.orders[0]).toMatchObject({ price: 0.11, size: 5 });
      expect(ctx.orders[0]?.metadata).toMatchObject({
        profileLadder: {
          attemptFilledBaseShares: 5,
          attemptSubmittedShares: 5,
        },
      });
      const firstClientOrderId = ctx.orders[0]!.clientOrderId;
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        price: 0.11,
        sizeShares: 10,
        filledSizeShares: 5,
        lifecycle: "planned",
        orderId: null,
        terminalRetryKey: "stage-b-exchange-order",
        attemptFilledBaseShares: 5,
        attemptSubmittedShares: 5,
      });

      await ctx.module.stop();
      nowMs += PLANNED_RUNG_RETRY_MS + 1;
      await ctx.module.start();
      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: nowMs });

      expect(ctx.orders).toHaveLength(2);
      expect(ctx.orders[1]).toMatchObject({ size: 5, clientOrderId: firstClientOrderId });

      const filledOrderId = createOrderId("stage-b-filled-retry-order");
      await ctx.bus.publish("OrderPlaced", orderPlaced(ctx.orders[1]!, filledOrderId));
      terminal = terminalOrder({
        orderId: filledOrderId,
        exchangeOrderId: "stage-b-filled-retry-exchange",
        status: OrderStatus.Filled,
        fillProgressShares: null,
        size: 5,
      });
      nowMs += PLANNED_RUNG_RETRY_MS + 1;
      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: nowMs });
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "filled",
        orderId: null,
        filledSizeShares: 10,
      });
    });

    it("keeps a live rung occupied when its local order row is missing", async () => {
      const livePosition = position({ size: 10, costBasisUsdc: 1 });
      const ctx = setup(policy(), {
        positionRepo: positionReader([livePosition]) as any,
        orderRepo: { findByTokenId: () => [], findByClientOrderId: () => null },
      });
      ctx.repo.upsertLadder(
        ladderState({
          activeRungs: [
            rung({
              sizeShares: 10,
              lifecycle: "placed",
              orderId: "missing-local-order",
            }),
          ],
        }),
      );
      await ctx.module.start();

      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "placed",
        orderId: "missing-local-order",
      });
      expect(counterLabels(ctx.counters, "profile_ladder_terminal_rearm_blocked")).toContainEqual({
        band: "medium_low",
        reason: "missing_order",
      });
    });

    it("adopts an accepted retry after restart and ignores its duplicate pre-submit skip", async () => {
      const livePosition = position({ size: 10, costBasisUsdc: 1 });
      const state = persistedRecoveryState();
      let exchangeOrders = [persistedAttemptOrder(state)];
      const acceptedSignalId = exchangeOrders[0]!.signalId;
      const ctx = setup(policy(), {
        positionRepo: positionReader([livePosition]),
        orderRepo: {
          findByTokenId: () => exchangeOrders,
          findByClientOrderId: (id) =>
            exchangeOrders.find((order) => String(order.clientOrderId) === id) ?? null,
        },
      });
      ctx.repo.upsertLadder(state);
      await ctx.module.start();

      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "placed",
        orderId: "accepted-retry-order",
        attemptFilledBaseShares: 2,
        attemptSubmittedShares: 8,
      });

      exchangeOrders = [
        { ...exchangeOrders[0]!, status: OrderStatus.Cancelled, fillProgressShares: 3 },
      ];
      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW + 1 });

      expect(ctx.orders).toHaveLength(1);
      expect(ctx.orders[0]).toMatchObject({ size: 5 });
      expect(ctx.orders[0]?.signalId).not.toBe(acceptedSignalId);

      const retry = ctx.orders[0]!;
      exchangeOrders = [
        persistedAttemptOrder(ctx.repo.getLadder(tokenId)!, {
          orderId: createOrderId("accepted-residual-order"),
          exchangeOrderId: "accepted-residual-exchange",
          status: OrderStatus.Cancelled,
          fillProgressShares: 1,
        }),
      ];
      expect(exchangeOrders[0]?.clientOrderId).toBe(retry.clientOrderId);
      await ctx.bus.publish("OrderSkipped", {
        ...orderSkipped(retry),
        reasonCode: "duplicate_client_order_id_pre_submit",
      });

      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "planned",
        orderId: null,
        filledSizeShares: 6,
        terminalRetryKey: "accepted-residual-exchange",
        attemptFilledBaseShares: 6,
        attemptSubmittedShares: 0,
        preExchangeRetryCount: 0,
      });
    });

    it("consumes a cancelled accepted retry that became terminal before restart", async () => {
      const state = persistedRecoveryState();
      const terminal = persistedAttemptOrder(state, {
        status: OrderStatus.Cancelled,
        fillProgressShares: 3,
      });
      const ctx = setup(policy(), {
        positionRepo: positionReader([position({ size: 10, costBasisUsdc: 1 })]),
        orderRepo: { findByTokenId: () => [terminal] },
      });
      ctx.repo.upsertLadder(state);
      await ctx.module.start();

      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });

      expect(ctx.orders).toHaveLength(1);
      expect(ctx.orders[0]).toMatchObject({ size: 5 });
      expect(ctx.orders[0]?.clientOrderId).not.toBe(terminal.clientOrderId);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        filledSizeShares: 5,
        terminalRetryKey: "accepted-retry-exchange",
        attemptFilledBaseShares: 5,
        attemptSubmittedShares: 5,
        preExchangeRetryCount: 0,
      });
    });

    it("consumes a filled accepted retry with null progress before restart", async () => {
      const state = persistedRecoveryState();
      const filled = persistedAttemptOrder(state, { status: OrderStatus.Filled });
      const ctx = setup(policy(), {
        positionRepo: positionReader([position({ size: 10, costBasisUsdc: 1 })]),
        orderRepo: { findByTokenId: () => [filled] },
      });
      ctx.repo.upsertLadder(state);
      await ctx.module.start();

      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "filled",
        orderId: null,
        filledSizeShares: 10,
      });
    });

    it("fails closed when persisted attempt evidence has the wrong deterministic client id", async () => {
      const state = persistedRecoveryState();
      const spoof = persistedAttemptOrder(state, {
        clientOrderId: "wrong-client-order-id" as ClientOrderId,
      });
      const ctx = setup(policy(), {
        positionRepo: positionReader([position({ size: 10, costBasisUsdc: 1 })]),
        orderRepo: { findByTokenId: () => [spoof] },
      });
      ctx.repo.upsertLadder(state);
      await ctx.module.start();

      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });

      expect(ctx.orders).toHaveLength(0);
      const preserved = ctx.repo.getLadder(tokenId)?.activeRungs[0];
      expect(preserved).toMatchObject({
        lifecycle: "planned",
        orderId: null,
      });
      expect(preserved?.preExchangeRetryCount).toBeUndefined();
    });

    it("keeps an exact exchange-less rejection on bounded pre-exchange retry", async () => {
      const state = persistedRecoveryState();
      const rejected = persistedAttemptOrder(state, {
        exchangeOrderId: null,
        status: OrderStatus.Rejected,
        fillProgressShares: 0,
      });
      const ctx = setup(policy(), {
        positionRepo: positionReader([position({ size: 10, costBasisUsdc: 1 })]),
        orderRepo: { findByTokenId: () => [rejected] },
      });
      ctx.repo.upsertLadder(state);
      await ctx.module.start();

      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });

      expect(ctx.orders).toHaveLength(0);
      expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
        lifecycle: "planned",
        orderId: null,
        preExchangeRetryCount: 1,
        attemptSubmittedShares: 0,
      });
    });

    it.each([
      { name: "actual", synthetic: false, restart: false },
      { name: "synthetic", synthetic: true, restart: true },
    ])(
      "moves an exact $name trading-disabled rejection onto durable terminal retry",
      async ({ synthetic, restart }) => {
        const livePosition = position({ size: 10, costBasisUsdc: 1 });
        let saved: Order | null = null;
        const ctx = setup(policy(), {
          positionRepo: positionReader([livePosition]),
          orderRepo: {
            findByTokenId: () => (saved == null ? [] : [saved]),
            findByClientOrderId: (id) =>
              saved != null && String(saved.clientOrderId) === id ? saved : null,
          },
        });
        await ctx.module.start();
        await ctx.module.placeLadder(livePosition, market());
        const command = ctx.orders[0]!;
        saved = tradingDisabledRejectedOrder(command);

        await ctx.bus.publish("OrderRejected", tradingDisabledRejectedEvent(command, synthetic));

        const rearmed = ctx.repo.getLadder(tokenId)?.activeRungs[0];
        expect(rearmed).toMatchObject({
          lifecycle: "planned",
          orderId: null,
          terminalRetryKey: "0xprofile-trading-disabled",
          attemptFilledBaseShares: 0,
          attemptSubmittedShares: 0,
        });
        expect(rearmed?.preExchangeRetryCount).toBeUndefined();

        if (restart) {
          await ctx.module.stop();
          await ctx.module.start();
        }
        await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: NOW });

        expect(ctx.orders).toHaveLength(2);
        expect(String(ctx.orders[1]?.signalId)).toContain(
          "_terminal_retry_0xprofile-trading-disabled",
        );
        expect(String(ctx.orders[1]?.signalId)).not.toContain("_pre_retry");
      },
    );

    it("keeps a trading-disabled event on the fail-closed lane when exact saved proof mismatches", async () => {
      const livePosition = position({ size: 10, costBasisUsdc: 1 });
      let saved: Order | null = null;
      const ctx = setup(policy(), {
        positionRepo: positionReader([livePosition]),
        orderRepo: {
          findByTokenId: () => (saved == null ? [] : [saved]),
          findByClientOrderId: () => saved,
        },
      });
      await ctx.module.start();
      await ctx.module.placeLadder(livePosition, market());
      const command = ctx.orders[0]!;
      saved = tradingDisabledRejectedOrder(command, { price: command.price + 0.01 });

      await ctx.bus.publish("OrderRejected", tradingDisabledRejectedEvent(command, false));

      const preserved = ctx.repo.getLadder(tokenId)?.activeRungs[0];
      expect(preserved).toMatchObject({
        lifecycle: "planned",
        orderId: null,
        preExchangeRetryCount: 1,
      });
      expect(preserved?.terminalRetryKey).toBeUndefined();
    });

    it("persists and bounds pre-exchange retries across OrderRejected and OrderSkipped", async () => {
      let nowMs = NOW;
      const livePosition = position({ size: 10, costBasisUsdc: 1 });
      const ctx = setup(policy(), {
        positionRepo: positionReader([livePosition]) as any,
        orderRepo: { findByTokenId: () => [], findByClientOrderId: () => null },
        now: () => nowMs,
      });
      ctx.repo.upsertLadder(
        ladderState({ activeRungs: [rung({ sizeShares: 10, notionalUsd: 1.1 })] }),
      );
      await ctx.module.start();

      for (let failure = 0; failure <= 3; failure += 1) {
        await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: nowMs });
        const command = ctx.orders.at(-1)!;
        expect(String(command.signalId)).toMatch(
          failure === 0 ? /_0$/ : new RegExp(`_pre_retry${failure}$`),
        );
        await ctx.bus.publish(
          failure === 1 ? "OrderSkipped" : "OrderRejected",
          failure === 1
            ? { ...orderSkipped(command), timestamp: nowMs }
            : { ...orderRejected(command), timestamp: nowMs },
        );
        expect(ctx.repo.getLadder(tokenId)?.activeRungs[0]).toMatchObject({
          preExchangeRetryCount: failure + 1,
          lifecycle: "planned",
          orderId: null,
        });
        nowMs += PLANNED_RUNG_RETRY_MS + 1;
      }

      await ctx.bus.publish("NormalizedMarketUpdated", { markets: [market()], timestamp: nowMs });

      expect(ctx.orders).toHaveLength(4);
      expect(counterLabels(ctx.counters, "profile_ladder_pre_exchange_retry_exhausted")).toEqual([
        { band: "medium_low" },
      ]);
    });

    it("services dormant dust, but fails closed for ambiguous and QD-owned positions", async () => {
      const dust = position({ status: PositionStatus.Dust, size: 10, costBasisUsdc: 1 });
      const recoverable = ladderState({
        activeRungs: [
          rung({
            sizeShares: 10,
            notionalUsd: 1.1,
            ...({ terminalRetryKey: "prior-terminal", attemptFilledBaseShares: 0 } as any),
          }),
        ],
      });
      const dormant = setup(policy(), {
        positionRepo: positionReader([dust]) as any,
        orderRepo: { findByTokenId: () => [], findByClientOrderId: () => null },
        isDormant: () => true,
        profileStateReader: { getProfileState: () => "ABANDONED_DORMANT" },
      });
      dormant.repo.upsertLadder(recoverable);
      await dormant.module.start();
      await dormant.bus.publish("NormalizedMarketUpdated", {
        markets: [market()],
        timestamp: NOW,
      });
      expect(dormant.orders).toHaveLength(1);

      for (const [name, rows, profileState] of [
        ["ambiguous", [dust, position({ positionId: createPositionId("duplicate-active") })], null],
        ["qd", [dust], "QD_HANDOFF"],
        ["closed", [dust], "CLOSED"],
      ] as const) {
        const blocked = setup(policy(), {
          positionRepo: positionReader([...rows]) as any,
          orderRepo: { findByTokenId: () => [], findByClientOrderId: () => null },
          profileStateReader: { getProfileState: () => profileState as ProfileState | null },
        });
        blocked.repo.upsertLadder(recoverable);
        await blocked.module.start();
        await blocked.bus.publish("NormalizedMarketUpdated", {
          markets: [market()],
          timestamp: NOW,
        });
        expect(blocked.orders, name).toHaveLength(0);
      }
    });

    it("reopens only stale-no-position dust and suppresses a stable sub-min residual", async () => {
      const dust = position({ status: PositionStatus.Dust, size: 2, costBasisUsdc: 0.2 });
      const ctx = setup(policy(), {
        positionRepo: positionReader([dust]) as any,
        orderRepo: { findByTokenId: () => [], findByClientOrderId: () => null },
        isProfileOwned: () => true,
        profileStateReader: { getProfileState: () => "ABANDONED_DORMANT" },
      });
      ctx.repo.upsertLadder(
        ladderState({
          status: "closed",
          closedAtMs: NOW - 1,
          metadataJson: JSON.stringify({ closeReason: "stale_no_open_position" }),
          activeRungs: [
            rung({
              price: 0.11,
              sizeShares: 5,
              notionalUsd: 0.55,
              filledSizeShares: 3,
              ...({ terminalRetryKey: "legacy-terminal" } as any),
            }),
          ],
        }),
      );
      await ctx.module.start();

      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market({ minOrderSize: 5 })],
        timestamp: NOW,
      });
      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market({ minOrderSize: 5 })],
        timestamp: NOW + 1,
      });

      expect(ctx.repo.getLadder(tokenId)).toMatchObject({
        status: "active",
        closedAtMs: null,
        activeRungs: [{ price: 0.11, sizeShares: 5, filledSizeShares: 3 }],
      });
      expect(ctx.orders).toHaveLength(0);
      expect(counterLabels(ctx.counters, "profile_ladder_residual_below_min_order")).toEqual([
        { band: "medium_low" },
      ]);

      await ctx.bus.publish("NormalizedMarketUpdated", {
        markets: [market({ minOrderSize: 1 })],
        timestamp: NOW + 2,
      });
      expect(ctx.orders).toHaveLength(1);
      expect(ctx.orders[0]).toMatchObject({ price: 0.11, size: 2 });
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

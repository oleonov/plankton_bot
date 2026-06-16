import {
  DEFAULT_EXECUTION_POLICY,
  PositionStatus,
  createConditionId,
  createPositionId,
  createTokenId,
  type PlaceOrderCommand,
  type TokenId,
  type TrackS4DustAutoCloseConfig,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { describe, expect, it, vi } from "vitest";

import type { DustAutoCloseRepository, DustAutoCloseState } from "../dust-auto-close-repository.js";
import { DustAutoCloseModule, type DustAutoCloseCandidate } from "../dust-auto-close-module.js";

const NOW = 1_800_000_000_000;
const tokenId = createTokenId("s4-module-token");
const conditionId = createConditionId("s4-module-condition");

class FakeDustAutoCloseRepository implements DustAutoCloseRepository {
  states = new Map<string, DustAutoCloseState>();
  attempted: Array<{ tokenId: TokenId; reason: string; nowMs: number; nextRetryAtMs: number }> = [];
  nonCloseable: Array<{
    tokenId: TokenId;
    reason: string;
    nowMs: number;
    nextRetryAtMs: number;
  }> = [];
  successful: TokenId[] = [];

  getState(token: TokenId): DustAutoCloseState | null {
    return this.states.get(String(token)) ?? null;
  }

  getNextRetryAt(token: TokenId): number | null {
    return this.states.get(String(token))?.nextRetryAtMs ?? null;
  }

  markAttempted(token: TokenId, reason: string, nowMs: number, nextRetryAtMs: number): void {
    this.attempted.push({ tokenId: token, reason, nowMs, nextRetryAtMs });
    this.states.set(String(token), state({ tokenId: token, nextRetryAtMs }));
  }

  markNonCloseable(token: TokenId, reason: string, nowMs: number, nextRetryAtMs: number): void {
    this.nonCloseable.push({ tokenId: token, reason, nowMs, nextRetryAtMs });
    this.states.set(
      String(token),
      state({ tokenId: token, status: "non_closeable", nextRetryAtMs }),
    );
  }

  markSuccessful(token: TokenId): void {
    this.successful.push(token);
    this.states.delete(String(token));
  }
}

function state(overrides: Partial<DustAutoCloseState> = {}): DustAutoCloseState {
  return {
    tokenId,
    status: "attempted",
    lastAttemptAtMs: NOW,
    lastAttemptReason: "qualified",
    nextRetryAtMs: NOW + 24 * 60 * 60_000,
    consecutiveAttempts: 1,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides,
  };
}

function candidate(overrides: Partial<DustAutoCloseCandidate> = {}): DustAutoCloseCandidate {
  return {
    tokenId,
    conditionId,
    status: "open",
    liquidationValueUsdc: 0.49,
    costBasisUsdc: 5,
    sellCountTotal: 1,
    lastSellAgeMs: 7 * 24 * 60 * 60_000,
    size: 12,
    minOrderSize: 5,
    marketTradable: true,
    bestBid: 0.024,
    tickSize: 0.001,
    minValidPrice: 0.001,
    negRisk: false,
    ...overrides,
  };
}

function policy(overrides: Partial<TrackS4DustAutoCloseConfig> = {}): TrackS4DustAutoCloseConfig {
  return {
    ...DEFAULT_EXECUTION_POLICY.trackS4,
    enabled: true,
    ...overrides,
  };
}

function setup(
  options: {
    policy?: TrackS4DustAutoCloseConfig;
    candidates?: readonly DustAutoCloseCandidate[];
    redeemInFlight?: boolean;
    profileOwned?: boolean;
    repo?: FakeDustAutoCloseRepository;
  } = {},
) {
  const bus = new InProcessEventBus();
  const repo = options.repo ?? new FakeDustAutoCloseRepository();
  const orders: PlaceOrderCommand[] = [];
  const counters: Array<{ name: string; value?: number; labels?: string }> = [];
  const riskEvents: Array<{ eventType: string; payload: Readonly<Record<string, unknown>> }> = [];
  const listCandidates = vi.fn().mockResolvedValue(options.candidates ?? [candidate()]);

  bus.subscribe("PlaceOrderRequested", async ({ command }) => {
    orders.push(command);
  });
  const module = new DustAutoCloseModule({
    bus,
    repository: repo,
    policy: () => options.policy ?? policy(),
    candidateProvider: { listCandidates },
    redeemInFlightGuard: () => options.redeemInFlight ?? false,
    isProfileOwned: () => options.profileOwned ?? false,
    runtimeMetrics: {
      writeCounter: (name, value, labels) =>
        counters.push({
          name,
          ...(value === undefined ? {} : { value }),
          ...(labels === undefined ? {} : { labels }),
        }),
    },
    riskEvents: {
      insert: (event) => riskEvents.push(event),
    },
    now: () => NOW,
  });
  return { module, repo, orders, counters, riskEvents, listCandidates, bus };
}

function labelOf(counter: { labels?: string }): Record<string, unknown> | null {
  return counter.labels == null ? null : (JSON.parse(counter.labels) as Record<string, unknown>);
}

describe("DustAutoCloseModule", () => {
  it("does not scan when disabled", async () => {
    const ctx = setup({ policy: policy({ enabled: false }) });

    await ctx.module.start();
    await ctx.module.runOnce();

    expect(ctx.listCandidates).not.toHaveBeenCalled();
    expect(ctx.orders).toHaveLength(0);
    expect(ctx.counters).toHaveLength(0);
  });

  it("skips redeem-in-flight candidates before placement", async () => {
    const ctx = setup({ redeemInFlight: true });

    await ctx.module.runOnce();

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.attempted).toHaveLength(0);
    expect(ctx.counters).toContainEqual({
      name: "dust_auto_close_skipped",
      value: 1,
      labels: JSON.stringify({ reason: "redeem_in_flight" }),
    });
  });

  it("skips profile-owned candidates before placement", async () => {
    const ctx = setup({ profileOwned: true });

    await ctx.module.runOnce();

    expect(ctx.orders).toHaveLength(0);
    expect(labelOf(ctx.counters[0]!)).toEqual({ reason: "profile_owned" });
  });

  it("honors next_retry_at_ms before reattempting", async () => {
    const repo = new FakeDustAutoCloseRepository();
    repo.states.set(String(tokenId), state({ nextRetryAtMs: NOW + 1 }));
    const ctx = setup({ repo });

    await ctx.module.runOnce();

    expect(ctx.orders).toHaveLength(0);
    expect(ctx.repo.attempted).toHaveLength(0);
    expect(labelOf(ctx.counters[0]!)).toEqual({ reason: "retry_backoff" });
  });

  it("marks first non-closeable candidate with a 24h retry", async () => {
    const ctx = setup({ candidates: [candidate({ minOrderSize: 20 })] });

    await ctx.module.runOnce();

    expect(ctx.repo.nonCloseable).toEqual([
      {
        tokenId,
        reason: "below_min_order_size",
        nowMs: NOW,
        nextRetryAtMs: NOW + 24 * 60 * 60_000,
      },
    ]);
    expect(ctx.counters).toContainEqual({
      name: "dust_auto_close_non_closeable",
      value: 1,
      labels: JSON.stringify({ reason: "below_min_order_size" }),
    });
  });

  it("publishes a tagged SELL order and records an attempt for closeable candidates", async () => {
    const ctx = setup();

    await ctx.module.runOnce();

    expect(ctx.orders).toHaveLength(1);
    expect(ctx.orders[0]).toMatchObject({
      type: "PlaceOrderCommand",
      source: "strategy",
      tokenId,
      conditionId,
      side: "sell",
      size: 12,
      price: 0.023,
      postOnly: false,
      orderType: "GTC",
      tickSize: 0.001,
      negRisk: false,
      signalReason: "dust-auto-close",
      metadata: { source: "track_s4_dust_auto_close" },
    });
    expect(ctx.repo.attempted).toEqual([
      {
        tokenId,
        reason: "qualified",
        nowMs: NOW,
        nextRetryAtMs: NOW + 24 * 60 * 60_000,
      },
    ]);
    expect(ctx.riskEvents).toHaveLength(1);
    expect(ctx.riskEvents[0]).toMatchObject({
      eventType: "dust_position_auto_closed",
      payload: { tokenId: String(tokenId), conditionId: String(conditionId), price: 0.023 },
    });
  });

  it("deletes retry state when a tracked position closes", async () => {
    const repo = new FakeDustAutoCloseRepository();
    repo.states.set(String(tokenId), state());
    const ctx = setup({ repo });

    ctx.module.recordSuccessfulClose(tokenId);

    expect(ctx.repo.successful).toEqual([tokenId]);
    expect(ctx.repo.getState(tokenId)).toBeNull();
    expect(ctx.counters).toContainEqual({
      name: "dust_auto_close_succeeded",
      value: 1,
      labels: undefined,
    });
  });

  it("subscribes to position close only while enabled", async () => {
    const repo = new FakeDustAutoCloseRepository();
    repo.states.set(String(tokenId), state());
    const ctx = setup({ repo });

    await ctx.module.start();
    await ctx.bus.publish("PositionUpdated", {
      position: {
        positionId: createPositionId("s4-position"),
        tokenId,
        conditionId,
        side: "buy",
        size: 0,
        avgEntryPrice: 0.1,
        costBasisUsdc: 0,
        currentValueUsdc: 0,
        realizedPnl: 0,
        status: PositionStatus.Closed,
        entryStyle: "probe",
        openedAt: new Date(NOW - 10_000).toISOString(),
        closedAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      },
    });

    expect(ctx.repo.getState(tokenId)).toBeNull();
    await ctx.module.stop();
  });
});

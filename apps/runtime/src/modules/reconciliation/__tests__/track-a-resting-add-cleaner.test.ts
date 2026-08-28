import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SignalReason,
  createBotRunId,
  createConditionId,
  createOrderId,
  createTokenId,
  type ClientOrderId,
  type LegState,
  type Order,
  type RuntimeEventMap,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  CANCEL_BACKOFF_MS,
  cleanStaleEntryOrders,
  type StaleOrderCleanerDeps,
} from "../stale-order-cleaner.js";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const MIN = 60_000;
const TOKEN = createTokenId("tok-track-a-resting-add");
const CONDITION = createConditionId("cond-track-a-resting-add");
type LegOverrides = { sellCount?: number; firstTradeAt?: string };

describe("Track A resting-add cancellation", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    [SignalReason.ConfirmScale, "open", 104 * MIN],
    [SignalReason.ScaleIn, "partially-filled", 60 * MIN],
    [SignalReason.HeavyScale, "open", 60 * MIN],
  ] as const)(
    "cancels residual %s BUY at the 60m leg boundary (%s)",
    async (signalReason, status, legAgeMs) => {
      const order = makeOrder({ signalReason, status, createdAt: iso(NOW - legAgeMs + MIN) });
      const env = makeEnv({ orders: [order], leg: makeLeg(NOW - legAgeMs) });

      const result = await env.run();
      await env.bus.drain();

      expect(result.trackARestingAddCancelRequested).toBe(1);
      expect(env.cancelled[0]!.command.orderId).toBe(order.orderId);
      expect(env.cancelled[0]!.command.reason).toBe("track_a_resting_add_expired");
      expect(env.metrics.writeCounter).toHaveBeenCalledWith(
        "track_a_resting_add_cancel_requested_total",
        1,
        expect.stringContaining(`"signalReason":"${signalReason}"`),
      );
    },
  );

  it.each([
    ["disabled", { enforce: false }],
    ["younger than 60m", { firstBuyMs: NOW - 60 * MIN + 1 }],
    ["SELL already seen", { sellCount: 1 }],
    ["missing leg", { leg: null }],
    ["malformed leg time", { firstTradeAt: "bad-time" }],
    ["malformed order time", { createdAt: "bad-time" }],
    ["order predates leg", { createdAt: iso(NOW - 61 * MIN) }],
    ["probe", { signalReason: SignalReason.ProbeEntry }],
    ["operator", { signalReason: SignalReason.Operator }],
    ["SELL order", { side: "sell" }],
    ["pending BUY", { status: "pending" }],
  ] as const)("does not cancel %s", async (_label, override) => {
    const firstBuyMs = "firstBuyMs" in override ? override.firstBuyMs : NOW - 60 * MIN;
    const leg = "leg" in override ? override.leg : makeLeg(firstBuyMs, override as LegOverrides);
    const order = makeOrder(override as Partial<Order>);
    const env = makeEnv({
      orders: [order],
      leg,
      enforce: "enforce" in override ? override.enforce : true,
    });

    const result = await env.run();
    await env.bus.drain();

    expect(result.trackARestingAddCancelRequested).toBe(0);
    expect(env.cancelled.map((event) => event.command.reason)).not.toContain(
      "track_a_resting_add_expired",
    );
  });

  it("takes priority over the generic 3h scale-in TTL", async () => {
    const order = makeOrder({ createdAt: iso(NOW - 4 * 60 * MIN) });
    const env = makeEnv({ orders: [order], leg: makeLeg(NOW - 5 * 60 * MIN) });

    const result = await env.run();

    expect(result.trackARestingAddCancelRequested).toBe(1);
    expect(result.staleTtlCancelled).toBe(0);
    expect(env.cancelled[0]!.command.reason).toBe("track_a_resting_add_expired");
  });

  it("reads the hot policy once per pass and retries a startup-dropped request after backoff", async () => {
    const order = makeOrder();
    let enforce = false;
    const policy = vi.fn(() => ({ enforce }));
    const env = makeEnv({ orders: [order], leg: makeLeg(NOW - 104 * MIN), policy });

    expect((await env.run()).trackARestingAddCancelRequested).toBe(0);
    enforce = true;
    expect((await env.run()).trackARestingAddCancelRequested).toBe(1);
    expect((await env.run()).trackARestingAddCancelRequested).toBe(0);

    vi.setSystemTime(NOW + CANCEL_BACKOFF_MS);
    expect((await env.run()).trackARestingAddCancelRequested).toBe(1);
    expect(policy).toHaveBeenCalledTimes(4);
    expect(env.cancelled).toHaveLength(2);
  });

  it("snapshots one leg once per token per pass", async () => {
    const orders = [
      makeOrder(),
      makeOrder({ orderId: createOrderId("ord-track-a-resting-add-2") }),
    ];
    const env = makeEnv({ orders, leg: makeLeg(NOW - 104 * MIN) });

    expect((await env.run()).trackARestingAddCancelRequested).toBe(2);
    expect(env.getLegState).toHaveBeenCalledOnce();
  });

  it("evicts the retry fence after the order leaves the working set", async () => {
    const order = makeOrder();
    const orders = [order];
    const env = makeEnv({ orders, leg: makeLeg(NOW - 104 * MIN) });

    await env.run();
    orders.length = 0;
    await env.run();

    expect(env.backoff.has(String(order.orderId))).toBe(false);
  });
});

function makeEnv(input: {
  orders: Order[];
  leg: LegState | null;
  enforce?: boolean;
  policy?: () => { enforce: boolean };
}) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const bus = new InProcessEventBus();
  const cancelled: RuntimeEventMap["CancelOrderRequested"][] = [];
  bus.subscribe("CancelOrderRequested", async (event) => void cancelled.push(event));
  const metrics = { writeCounter: vi.fn() };
  const backoff = new Map<string, number>();
  const getLegState = vi.fn(() => input.leg);
  const deps = {
    orderRepo: { findOpen: () => [...input.orders] },
    marketRepo: { findByTokenId: () => null },
    bus,
    log: silentLog,
    metrics,
    trackAAddThrottle: {
      policy: input.policy ?? (() => ({ enforce: input.enforce ?? true })),
      legStateRepo: { get: getLegState },
    },
  } as unknown as StaleOrderCleanerDeps;
  return {
    bus,
    cancelled,
    metrics,
    backoff,
    getLegState,
    run: () => cleanStaleEntryOrders(deps, backoff),
  };
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: createOrderId("ord-track-a-resting-add"),
    clientOrderId: "client-track-a-resting-add" as ClientOrderId,
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "buy",
    orderType: "GTC",
    price: 0.11,
    size: 10,
    sizeUsdc: 1.1,
    status: "open",
    exchangeOrderId: "exchange-track-a-resting-add",
    signalId: "signal-track-a-resting-add",
    signalReason: SignalReason.ConfirmScale,
    botRunId: createBotRunId("run-track-a-resting-add"),
    createdAt: iso(NOW - 103 * MIN),
    updatedAt: iso(NOW),
    ...overrides,
  };
}

function makeLeg(
  firstBuyMs: number,
  overrides: { sellCount?: number; firstTradeAt?: string } = {},
) {
  const firstTradeAt = overrides.firstTradeAt ?? iso(firstBuyMs);
  return {
    tokenId: TOKEN,
    buyCount: 1,
    sellCount: overrides.sellCount ?? 0,
    lastAction: "BUY" as const,
    firstTradePrice: 0.12,
    firstTradeAt,
    lastTradeAt: firstTradeAt,
    updatedAt: firstTradeAt,
  };
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => silentLog,
} as never;

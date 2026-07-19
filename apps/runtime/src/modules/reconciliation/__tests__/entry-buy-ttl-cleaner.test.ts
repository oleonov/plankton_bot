import { describe, expect, it, vi } from "vitest";
import {
  SignalReason,
  createBotRunId,
  createConditionId,
  createOrderId,
  createTokenId,
  type ClientOrderId,
  type EventBus,
  type Market,
  type MarketRepository,
  type Order,
  type OrderRepository,
  type RuntimeEventMap,
  type TokenId,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { cleanStaleEntryOrders } from "../stale-order-cleaner.js";
import type { Logger } from "../../../logger.js";

// 2026-07-19 first-entry-adaptive-ttl plan: R23/FALLBACK/D-rule first-entry BUYs on long-lived
// markets now share GATE's activity-adaptive TTL (12h cap here — the cleaner never threads
// tradeCount3h, see stale-order-cleaner.ts `resolveOrderTtlMs`) instead of dying at the old 10-min
// probe floor. Short-horizon probes and scale-ins are unaffected.
const NOW = Date.parse("2026-07-19T12:00:00.000Z");
const MIN = 60_000;
const H = 60 * MIN;
const FAR_FUTURE_END_DATE = "2027-01-01T00:00:00.000Z";

const CONDITION = createConditionId("cond-entry-ttl-cleaner");
const TOKEN_R23 = createTokenId("tok-entry-ttl-r23-first-entry");
const TOKEN_SHORT = createTokenId("tok-entry-ttl-short-horizon-probe");
const TOKEN_SCALE = createTokenId("tok-entry-ttl-scale-in");

describe("stale-order-cleaner — first-entry adaptive TTL (2026-07-19-first-entry-adaptive-ttl)", () => {
  it("does NOT cancel an 11-min-old R23 first-entry BUY on a long-lived (null-horizon) market", async () => {
    const order = makeBuyOrder({
      tokenId: TOKEN_R23,
      signalReason: SignalReason.ProbeEntry,
      decisionRuleId: "R23_DIP_TRIGGER",
      createdAt: new Date(NOW - 11 * MIN).toISOString(),
    });
    const env = makeEnv({
      orders: [order],
      markets: new Map([[String(TOKEN_R23), makeMarket({ tokenId: TOKEN_R23, horizon: null })]]),
    });

    const result = await env.run();
    await env.bus.drain();

    expect(result.staleTtlCancelled).toBe(0);
    expect(env.cancelled).toHaveLength(0);
  });

  it("still cancels a short-horizon probe past its 1-min intraday-4h TTL", async () => {
    const order = makeBuyOrder({
      tokenId: TOKEN_SHORT,
      signalReason: SignalReason.ProbeEntry,
      decisionRuleId: "R23_DIP_TRIGGER",
      createdAt: new Date(NOW - 5 * MIN).toISOString(),
    });
    const env = makeEnv({
      orders: [order],
      markets: new Map([
        [String(TOKEN_SHORT), makeMarket({ tokenId: TOKEN_SHORT, horizon: "intraday-4h" })],
      ]),
    });

    const result = await env.run();
    await env.bus.drain();

    expect(result.staleTtlCancelled).toBe(1);
    expect(env.cancelled).toHaveLength(1);
    expect(env.cancelled[0]?.command.orderId).toBe(order.orderId);
    expect(env.cancelled[0]?.command.reason).toBe("stale_entry_ttl");
  });

  it("still cancels a scale-in (ConfirmScale) aged past its 3h TTL on a deadline-horizon market", async () => {
    const order = makeBuyOrder({
      tokenId: TOKEN_SCALE,
      signalReason: SignalReason.ConfirmScale,
      decisionRuleId: "R23_DIP_TRIGGER",
      createdAt: new Date(NOW - 4 * H).toISOString(),
    });
    const env = makeEnv({
      orders: [order],
      markets: new Map([
        [String(TOKEN_SCALE), makeMarket({ tokenId: TOKEN_SCALE, horizon: "deadline" })],
      ]),
    });

    const result = await env.run();
    await env.bus.drain();

    expect(result.staleTtlCancelled).toBe(1);
    expect(env.cancelled).toHaveLength(1);
    expect(env.cancelled[0]?.command.orderId).toBe(order.orderId);
    expect(env.cancelled[0]?.command.reason).toBe("stale_entry_ttl");
  });
});

function makeEnv(input: { orders: readonly Order[]; markets: ReadonlyMap<string, Market> }) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));

  const bus = new InProcessEventBus();
  const cancelled: RuntimeEventMap["CancelOrderRequested"][] = [];
  bus.subscribe("CancelOrderRequested", async (event) => {
    cancelled.push(event);
  });

  const orderRepo = makeOrderRepo(input.orders);
  const marketRepo = makeMarketRepo(input.markets);
  const backoffMap = new Map<string, number>();

  return {
    bus,
    cancelled,
    run: () =>
      cleanStaleEntryOrders(
        {
          orderRepo,
          marketRepo,
          bus: bus as EventBus,
          log: silentLog,
          // entryRepriceOnOutbid / exitRepriceOnDownprice / trackCExit intentionally left undefined
          // so only the TTL branch runs (per plan scope for this test).
        },
        backoffMap,
      ),
  };
}

function makeOrderRepo(orders: readonly Order[]): OrderRepository {
  return {
    findOpen: () => [...orders],
  } as unknown as OrderRepository;
}

function makeMarketRepo(marketsByTokenId: ReadonlyMap<string, Market>): MarketRepository {
  return {
    findByTokenId: (tokenId: TokenId) => marketsByTokenId.get(String(tokenId)) ?? null,
  } as unknown as MarketRepository;
}

function makeBuyOrder(overrides: Partial<Order> & Pick<Order, "tokenId">): Order {
  const suffix = String(overrides.tokenId);
  return {
    orderId: createOrderId(`ord-${suffix}`),
    clientOrderId: `client-${suffix}` as ClientOrderId,
    conditionId: CONDITION,
    side: "buy",
    orderType: "GTC",
    price: 0.1,
    size: 10,
    sizeUsdc: 1,
    status: "open",
    exchangeOrderId: `ex-${suffix}`,
    signalId: `sig-${suffix}`,
    signalReason: SignalReason.ProbeEntry,
    decisionRuleId: null,
    botRunId: createBotRunId("run-entry-ttl-cleaner"),
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

function makeMarket(overrides: Partial<Market> & Pick<Market, "tokenId">): Market {
  const suffix = String(overrides.tokenId);
  return {
    conditionId: String(CONDITION),
    slug: `entry-ttl-cleaner-market-${suffix}`,
    eventSlug: "entry-ttl-cleaner-event",
    question: "Will the entry-ttl-cleaner test market resolve?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: FAR_FUTURE_END_DATE,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    eventMarketCount: 1,
    tags: null,
    gammaCreatedAt: null,
    createdAt: new Date(NOW - 2 * 24 * H).toISOString(),
    updatedAt: new Date(NOW - H).toISOString(),
    ...overrides,
  };
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as unknown as Logger;

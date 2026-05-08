import { describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  createBotRunId,
  createCommandId,
  createConditionId,
  createOrderId,
  createTokenId,
  type Order,
  type OrderPriceCooldown,
  type OrderPriceCooldownRepository,
  type OrderId,
  type OrderRepository,
  type Position,
} from "@plankton/domain";
import {
  priceToX10000,
  SAME_PRICE_COOLDOWN_REASON,
  SamePriceCooldownModule,
} from "../same-price-cooldown-module.js";

const TOKEN = createTokenId("token-1");
const CONDITION = createConditionId("condition-1");
const NOW = Date.parse("2026-05-08T00:00:00.000Z");

describe("SamePriceCooldownModule", () => {
  it("escalates BUY stale cancels as 30m, 1h, then 24h", async () => {
    const fixture = buildFixture(order({ side: "buy", price: 0.49 }));
    await fixture.module.start();

    await fixture.cancel("stale_entry_ttl", NOW);
    expect(fixture.repo.get(TOKEN, "buy", 4900)).toMatchObject({
      staleCancelCount: 1,
      cooldownUntilTsUtc: NOW + 30 * 60_000,
    });
    expect(fixture.module.canPlaceOrder(args("buy", 0.49, NOW + 1))).toMatchObject({
      allowed: false,
      reason: SAME_PRICE_COOLDOWN_REASON,
    });

    await fixture.cancel("stale_entry_ttl", NOW + 30 * 60_000);
    expect(fixture.repo.get(TOKEN, "buy", 4900)).toMatchObject({
      staleCancelCount: 2,
      cooldownUntilTsUtc: NOW + 90 * 60_000,
    });

    await fixture.cancel("stale_entry_ttl", NOW + 90 * 60_000);
    expect(fixture.repo.get(TOKEN, "buy", 4900)).toMatchObject({
      staleCancelCount: 3,
      cooldownUntilTsUtc: NOW + 90 * 60_000 + 24 * 60 * 60_000,
    });
    expect(
      fixture.module.canPlaceOrder(args("buy", 0.49, NOW + 90 * 60_000 + 24 * 60 * 60_000)),
    ).toMatchObject({ allowed: true });
  });

  it("escalates SELL stale cancels as 1h, 6h, then 24h", async () => {
    const fixture = buildFixture(order({ side: "sell", price: 0.82 }));
    await fixture.module.start();

    await fixture.cancel("stale_exit_ttl", NOW);
    expect(fixture.repo.get(TOKEN, "sell", 8200)?.cooldownUntilTsUtc).toBe(NOW + 60 * 60_000);

    await fixture.cancel("stale_exit_ttl", NOW + 60 * 60_000);
    expect(fixture.repo.get(TOKEN, "sell", 8200)).toMatchObject({
      staleCancelCount: 2,
      cooldownUntilTsUtc: NOW + 7 * 60 * 60_000,
    });

    await fixture.cancel("stale_exit_ttl", NOW + 7 * 60 * 60_000);
    expect(fixture.repo.get(TOKEN, "sell", 8200)).toMatchObject({
      staleCancelCount: 3,
      cooldownUntilTsUtc: NOW + 7 * 60 * 60_000 + 24 * 60 * 60_000,
    });
  });

  it("keeps different prices independent", async () => {
    const first = order({ side: "buy", price: 0.49, orderId: createOrderId("order-1") });
    const second = order({ side: "buy", price: 0.5, orderId: createOrderId("order-2") });
    const fixture = buildFixture(first, second);
    await fixture.module.start();

    await fixture.cancel("stale_entry_ttl", NOW, first.orderId);
    await fixture.cancel("stale_entry_ttl", NOW, second.orderId);
    await fixture.cancel("stale_entry_ttl", NOW + 1, second.orderId);

    expect(fixture.repo.get(TOKEN, "buy", priceToX10000(0.49))?.staleCancelCount).toBe(1);
    expect(fixture.repo.get(TOKEN, "buy", priceToX10000(0.5))?.staleCancelCount).toBe(2);
  });

  it("ignores non-retryable stale cancels, side mismatches, missing orders, and partial fills", async () => {
    const fixture = buildFixture(order({ side: "buy", price: 0.49 }));
    await fixture.module.start();

    await fixture.cancel("stale_entry_enddate", NOW);
    await fixture.cancel("stale_exit_ttl", NOW + 1);
    await fixture.cancel("stale_entry_ttl", NOW + 2, createOrderId("missing-order"));
    expect(fixture.repo.findAll()).toEqual([]);
    expect(fixture.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "missing-order", reason: "stale_entry_ttl" }),
      "stale cancel cooldown skipped — order not found",
    );

    const partial = order({
      side: "buy",
      price: 0.49,
      orderId: createOrderId("partial-order"),
      fillProgressShares: 3,
    });
    const partialFixture = buildFixture(partial);
    await partialFixture.module.start();
    await partialFixture.cancel("stale_entry_ttl", NOW, partial.orderId);
    expect(partialFixture.repo.findAll()).toEqual([]);
  });

  it("allows placement after an expired cooldown while preserving stale metadata", async () => {
    const fixture = buildFixture(order({ side: "buy", price: 0.49 }));
    fixture.repo.upsert({
      tokenId: TOKEN,
      side: "buy",
      priceX10000: priceToX10000(0.49),
      staleCancelCount: 3,
      cooldownUntilTsUtc: NOW - 1,
      lastEventTsUtc: NOW - 24 * 60 * 60_000,
    });

    expect(fixture.module.canPlaceOrder(args("buy", 0.49, NOW))).toMatchObject({
      allowed: true,
      staleCancelCount: 3,
      cooldownUntilTsUtc: NOW - 1,
    });
  });

  it("resets exact cooldown on fill and all token cooldowns on position close or market resolution", async () => {
    const buy = order({ side: "buy", price: 0.49, orderId: createOrderId("buy-1") });
    const sell = order({ side: "sell", price: 0.82, orderId: createOrderId("sell-1") });
    const fixture = buildFixture(buy, sell);
    await fixture.module.start();

    await fixture.cancel("stale_entry_ttl", NOW, buy.orderId);
    await fixture.cancel("stale_exit_ttl", NOW, sell.orderId);
    await fixture.bus.publish("FillReceived", {
      fillId: "fill-1" as never,
      orderId: buy.orderId,
      clientOrderId: buy.clientOrderId,
      tokenId: TOKEN,
      conditionId: CONDITION,
      side: "buy",
      price: 0.49,
      size: 1,
      sizeUsdc: 0.49,
      liquidityRole: "maker",
      fee: 0,
      feeRateBps: 0,
      signalReason: buy.signalReason,
      timestamp: NOW + 1,
    });
    expect(fixture.repo.get(TOKEN, "buy", 4900)).toBeNull();
    expect(fixture.repo.get(TOKEN, "sell", 8200)).not.toBeNull();

    await fixture.bus.publish("PositionUpdated", {
      position: position({ status: "open", size: 0 }),
    });
    expect(fixture.repo.findAll()).toEqual([]);

    await fixture.cancel("stale_exit_ttl", NOW + 2, sell.orderId);
    await fixture.bus.publish("MarketResolved", {
      conditionId: String(CONDITION),
      tokenIds: [TOKEN],
      resolution: "unknown",
      resolvedAt: new Date(NOW + 3).toISOString(),
      source: "test",
      timestamp: NOW + 3,
    });
    expect(fixture.repo.findAll()).toEqual([]);
  });
});

function buildFixture(...orders: Order[]) {
  const bus = new InProcessEventBus();
  const repo = cooldownRepository();
  const orderRepo = orderRepository(orders);
  const log = logger();
  const module = new SamePriceCooldownModule({
    bus,
    orderRepo,
    cooldownRepo: repo,
    log: log as never,
  });

  return {
    bus,
    log,
    repo,
    module,
    cancel: (reason: string, timestamp: number, id = orders[0]!.orderId) =>
      bus.publish("OrderCancelled", {
        commandId: createCommandId("cmd-1"),
        orderId: id,
        tokenId: TOKEN,
        conditionId: CONDITION,
        reason,
        signalReason: orderRepo.findById(id)?.signalReason ?? null,
        timestamp,
      }),
  };
}

function args(side: "buy" | "sell", price: number, nowMs: number) {
  return { tokenId: TOKEN, side, price, nowMs };
}

function order(overrides: Partial<Order> = {}): Order {
  const side = overrides.side ?? "buy";
  return {
    orderId: createOrderId("order-1"),
    clientOrderId: "client-1" as never,
    tokenId: TOKEN,
    conditionId: CONDITION,
    side,
    orderType: "GTC",
    postOnly: true,
    price: 0.49,
    size: 10,
    sizeUsdc: 4.9,
    status: "cancelled",
    exchangeOrderId: null,
    signalId: null,
    signalReason: side === "buy" ? "probe-entry" : "repricing-exit",
    botRunId: createBotRunId("bot-run-1"),
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: "position-1" as never,
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "buy",
    size: 0,
    avgEntryPrice: 0.49,
    costBasisUsdc: 4.9,
    currentValueUsdc: 0,
    realizedPnl: 0,
    status: "closed",
    entryStyle: "probe",
    openedAt: new Date(NOW).toISOString(),
    closedAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function orderRepository(orders: Order[]): OrderRepository {
  const byId = new Map<OrderId, Order>(orders.map((order) => [order.orderId, order]));
  return {
    save: vi.fn(),
    findById: vi.fn((id: OrderId) => byId.get(id) ?? null),
    findByClientOrderId: vi.fn(),
    findByExchangeOrderId: vi.fn(),
    findOpen: vi.fn(() => []),
    findByTokenId: vi.fn(() => orders),
    sumOpenBuyNotional: vi.fn(() => 0),
    updateStatus: vi.fn(),
  };
}

function cooldownRepository(): OrderPriceCooldownRepository {
  const rows = new Map<string, OrderPriceCooldown>();
  const key = (tokenId: unknown, side: string, priceX10000: number) =>
    `${String(tokenId)}|${side}|${priceX10000}`;
  return {
    get: vi.fn((tokenId, side, priceX10000) => rows.get(key(tokenId, side, priceX10000)) ?? null),
    upsert: vi.fn((cooldown) => {
      rows.set(key(cooldown.tokenId, cooldown.side, cooldown.priceX10000), cooldown);
    }),
    delete: vi.fn((tokenId, side, priceX10000) => {
      rows.delete(key(tokenId, side, priceX10000));
    }),
    deleteByTokenId: vi.fn((tokenId) => {
      let deleted = 0;
      for (const rowKey of [...rows.keys()]) {
        if (rowKey.startsWith(`${String(tokenId)}|`)) {
          rows.delete(rowKey);
          deleted++;
        }
      }
      return deleted;
    }),
    findAll: vi.fn(() => [...rows.values()]),
  };
}

function logger() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    trace: vi.fn(),
    level: "info",
    silent: vi.fn(),
  };
  log.child.mockReturnValue(log);
  return log;
}

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteOrderRepository } from "../repositories/order-repository.js";
import { createOrderId, createTokenId, createConditionId, createBotRunId } from "@plankton/domain";
import type { Order, ClientOrderId } from "@plankton/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteOrderRepository;

function makeOrder(overrides?: Partial<Order>): Order {
  const now = new Date().toISOString();
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "cloid-1" as ClientOrderId,
    tokenId: createTokenId("tok-1"),
    conditionId: createConditionId("cond-1"),
    side: "buy",
    orderType: "GTC",
    price: 0.55,
    size: 100,
    sizeUsdc: 55,
    status: "pending",
    exchangeOrderId: null,
    signalId: null,
    signalReason: null,
    botRunId: createBotRunId("run-1"),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteOrderRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteOrderRepository", () => {
  it("save + findById round-trip", () => {
    const order = makeOrder();
    repo.save(order);

    const found = repo.findById(createOrderId("ord-1"));
    expect(found).not.toBeNull();
    expect(found!.orderId).toBe("ord-1");
    expect(found!.clientOrderId).toBe("cloid-1");
    expect(found!.tokenId).toBe("tok-1");
    expect(found!.side).toBe("buy");
    expect(found!.orderType).toBe("GTC");
    expect(found!.postOnly).toBe(false);
    expect(found!.price).toBe(0.55);
    expect(found!.size).toBe(100);
    expect(found!.sizeUsdc).toBe(55);
    expect(found!.status).toBe("pending");
    expect(found!.exchangeOrderId).toBeNull();
    expect(found!.signalId).toBeNull();
    expect(found!.botRunId).toBe("run-1");
  });

  it("round-trips signal and exchange reject telemetry", () => {
    repo.save(
      makeOrder({
        status: "rejected",
        signalId: "sig-1",
        decisionRuleId: "D5",
        signalTimestamp: "2026-04-26T00:00:00.000Z",
        exchangeErrorCode: "INSUFFICIENT_BALANCE",
        exchangeErrorMessage: "not enough balance",
        exchangeErrorPayload: JSON.stringify({ status: 400, responseBody: { error: "bad" } }),
      }),
    );

    const found = repo.findById(createOrderId("ord-1"));
    expect(found).toMatchObject({
      status: "rejected",
      signalId: "sig-1",
      decisionRuleId: "D5",
      signalTimestamp: "2026-04-26T00:00:00.000Z",
      exchangeErrorCode: "INSUFFICIENT_BALANCE",
      exchangeErrorMessage: "not enough balance",
    });
    expect(JSON.parse(found!.exchangeErrorPayload!)).toMatchObject({
      status: 400,
      responseBody: { error: "bad" },
    });
  });

  it("findByClientOrderId works", () => {
    repo.save(makeOrder());

    const found = repo.findByClientOrderId("cloid-1");
    expect(found).not.toBeNull();
    expect(found!.orderId).toBe("ord-1");

    const notFound = repo.findByClientOrderId("nonexistent");
    expect(notFound).toBeNull();
  });

  it("findOpen returns pending, open, and partially-filled orders", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("o1"),
        clientOrderId: "c1" as ClientOrderId,
        status: "pending",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o2"),
        clientOrderId: "c2" as ClientOrderId,
        status: "open",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o3"),
        clientOrderId: "c3" as ClientOrderId,
        status: "filled",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o4"),
        clientOrderId: "c4" as ClientOrderId,
        status: "cancelled",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o5"),
        clientOrderId: "c5" as ClientOrderId,
        status: "rejected",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o6"),
        clientOrderId: "c6" as ClientOrderId,
        status: "partially-filled",
      }),
    );

    const open = repo.findOpen();
    expect(open).toHaveLength(3);

    const statuses = open.map((o) => o.status).sort();
    expect(statuses).toEqual(["open", "partially-filled", "pending"]);
  });

  it("findByTokenId returns orders for token", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("o1"),
        clientOrderId: "c1" as ClientOrderId,
        tokenId: createTokenId("tok-A"),
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o2"),
        clientOrderId: "c2" as ClientOrderId,
        tokenId: createTokenId("tok-A"),
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o3"),
        clientOrderId: "c3" as ClientOrderId,
        tokenId: createTokenId("tok-B"),
      }),
    );

    const tokA = repo.findByTokenId(createTokenId("tok-A"));
    expect(tokA).toHaveLength(2);

    const tokB = repo.findByTokenId(createTokenId("tok-B"));
    expect(tokB).toHaveLength(1);
  });

  it("findRecentByTokenId and findFirstByTokenId return bounded token order windows", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("o-old"),
        clientOrderId: "c-old" as ClientOrderId,
        tokenId: createTokenId("tok-A"),
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o-new"),
        clientOrderId: "c-new" as ClientOrderId,
        tokenId: createTokenId("tok-A"),
        createdAt: "2026-01-03T00:00:00Z",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o-mid"),
        clientOrderId: "c-mid" as ClientOrderId,
        tokenId: createTokenId("tok-A"),
        createdAt: "2026-01-02T00:00:00Z",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o-other"),
        clientOrderId: "c-other" as ClientOrderId,
        tokenId: createTokenId("tok-B"),
        createdAt: "2026-01-04T00:00:00Z",
      }),
    );

    expect(
      repo.findRecentByTokenId(createTokenId("tok-A"), 2).map((order) => order.orderId),
    ).toEqual(["o-new", "o-mid"]);
    expect(repo.findFirstByTokenId(createTokenId("tok-A"))?.orderId).toBe("o-old");
  });

  it("findRecentBySignalReasons returns bounded exit orders since a timestamp", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("o-old"),
        clientOrderId: "c-old" as ClientOrderId,
        signalReason: "repricing-exit",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o-entry"),
        clientOrderId: "c-entry" as ClientOrderId,
        signalReason: "probe-entry",
        createdAt: "2026-01-03T00:00:00Z",
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o-exit"),
        clientOrderId: "c-exit" as ClientOrderId,
        signalReason: "repricing-exit",
        createdAt: "2026-01-04T00:00:00Z",
      }),
    );

    const recent = repo.findRecentBySignalReasons(["repricing-exit"], "2026-01-02T00:00:00Z", 10);
    expect(recent.map((order) => order.orderId)).toEqual(["o-exit"]);
  });

  it("updateStatus changes status", () => {
    repo.save(makeOrder());

    repo.updateStatus(createOrderId("ord-1"), "filled");

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.status).toBe("filled");
  });

  it("updateStatus sets exchangeOrderId", () => {
    repo.save(makeOrder());

    repo.updateStatus(createOrderId("ord-1"), "open", "exch-123");

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.status).toBe("open");
    expect(found!.exchangeOrderId).toBe("exch-123");
  });

  it("updateStatus records cancellation reason", () => {
    repo.save(makeOrder());

    repo.updateStatus(createOrderId("ord-1"), "cancelled", undefined, "stale_entry_ttl");

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.status).toBe("cancelled");
    expect(found!.cancelReason).toBe("stale_entry_ttl");
  });

  it("updateStatus persists cancel telemetry payload", () => {
    repo.save(makeOrder());

    repo.updateStatus(createOrderId("ord-1"), "cancelled", undefined, "stale_entry_ttl", {
      cancelAgeMs: 1234,
      cancelAgeBucket: "<1min",
      fillProgressShares: 5,
      marketHorizon: "short",
    });

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.cancelAgeMs).toBe(1234);
    expect(found!.cancelAgeBucket).toBe("<1min");
    expect(found!.fillProgressShares).toBe(5);
    expect(found!.marketHorizon).toBe("short");
  });

  it("save round-trips telemetry fields", () => {
    repo.save(
      makeOrder({
        cancelAgeMs: 9_000,
        cancelAgeBucket: "1-10min",
        fillProgressShares: 3.5,
        marketHorizon: "medium",
      }),
    );

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.cancelAgeMs).toBe(9_000);
    expect(found!.cancelAgeBucket).toBe("1-10min");
    expect(found!.fillProgressShares).toBe(3.5);
    expect(found!.marketHorizon).toBe("medium");
  });

  it("persists and retrieves signalReason", () => {
    repo.save(makeOrder({ signalReason: "repricing-exit" }));

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.signalReason).toBe("repricing-exit");
  });

  it("persists and retrieves postOnly", () => {
    repo.save(makeOrder({ postOnly: true }));

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.postOnly).toBe(true);
  });

  it("signalReason defaults to null", () => {
    repo.save(makeOrder());

    const found = repo.findById(createOrderId("ord-1"));
    expect(found!.signalReason).toBeNull();
  });

  it("findByExchangeOrderId returns order when exchange_order_id matches", () => {
    repo.save(makeOrder());
    repo.updateStatus(createOrderId("ord-1"), "open", "exch-abc");

    const found = repo.findByExchangeOrderId("exch-abc");
    expect(found).not.toBeNull();
    expect(found!.orderId).toBe("ord-1");
    expect(found!.exchangeOrderId).toBe("exch-abc");
  });

  it("findByExchangeOrderId returns null when not found", () => {
    const result = repo.findByExchangeOrderId("nonexistent-exchange-id");
    expect(result).toBeNull();
  });

  it("findById returns null for unknown id", () => {
    expect(repo.findById(createOrderId("nonexistent"))).toBeNull();
  });

  // ─── sumOpenBuyNotional ────────────────────────────────────────────

  it("sumOpenBuyNotional returns 0 when no orders exist", () => {
    expect(repo.sumOpenBuyNotional()).toBe(0);
  });

  it("sumOpenBuyNotional sums only open buy orders", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("o1"),
        clientOrderId: "c1" as ClientOrderId,
        side: "buy",
        status: "pending",
        sizeUsdc: 10,
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o2"),
        clientOrderId: "c2" as ClientOrderId,
        side: "buy",
        status: "open",
        sizeUsdc: 20,
      }),
    );
    repo.save(
      makeOrder({
        orderId: createOrderId("o3"),
        clientOrderId: "c3" as ClientOrderId,
        side: "buy",
        status: "partially-filled",
        sizeUsdc: 15,
      }),
    );

    expect(repo.sumOpenBuyNotional()).toBe(45);
  });

  it("sumOpenBuyNotional excludes sell orders and non-open statuses", () => {
    repo.save(
      makeOrder({
        orderId: createOrderId("o1"),
        clientOrderId: "c1" as ClientOrderId,
        side: "buy",
        status: "open",
        sizeUsdc: 10,
      }),
    );
    // sell order — should be excluded
    repo.save(
      makeOrder({
        orderId: createOrderId("o2"),
        clientOrderId: "c2" as ClientOrderId,
        side: "sell",
        status: "open",
        sizeUsdc: 50,
      }),
    );
    // filled buy — should be excluded
    repo.save(
      makeOrder({
        orderId: createOrderId("o3"),
        clientOrderId: "c3" as ClientOrderId,
        side: "buy",
        status: "filled",
        sizeUsdc: 100,
      }),
    );
    // cancelled buy — should be excluded
    repo.save(
      makeOrder({
        orderId: createOrderId("o4"),
        clientOrderId: "c4" as ClientOrderId,
        side: "buy",
        status: "cancelled",
        sizeUsdc: 200,
      }),
    );

    expect(repo.sumOpenBuyNotional()).toBe(10);
  });
});

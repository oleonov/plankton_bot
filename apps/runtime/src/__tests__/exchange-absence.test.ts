import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapLedgerDb, SqliteOrderRepository } from "@krabs/db";
import { createConditionId, createOrderId, createTokenId } from "@krabs/domain";
import type { ClientOrderId, Order, OrderRepository } from "@krabs/domain";
import {
  clearExchangeAbsence,
  exchangeAbsenceCloseAtMs,
  EXCHANGE_ABSENCE_OBSERVE_MS,
  EXCHANGE_ABSENCE_QUIET_MS,
  isExchangeAbsenceDue,
  markExchangeAbsent,
  readExchangeAbsence,
} from "../modules/reconciliation/exchange-absence.js";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: createOrderId("zombie"),
    clientOrderId: "zombie-client" as ClientOrderId,
    exchangeOrderId: "zombie-exchange",
    tokenId: createTokenId("tok"),
    conditionId: createConditionId("cond"),
    side: "sell",
    orderType: "GTC",
    price: 0.4,
    size: 10,
    sizeUsdc: 4,
    status: "partially-filled",
    signalId: null,
    signalReason: null,
    botRunId: "run" as never,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...overrides,
  };
}

const withMarker = (firstNullAtMs: number, overrides: Partial<Order> = {}) =>
  makeOrder({ ...overrides, metadata: { exchangeAbsenceV1: { firstNullAt: iso(firstNullAtMs) } } });
const fillAt = (ms: number) => ({ filledAt: iso(ms) });

describe("readExchangeAbsence", () => {
  it("reads a valid marker and treats absent or malformed values as no marker", () => {
    expect(readExchangeAbsence(withMarker(T0))).toEqual({ firstNullAtMs: T0 });
    expect(readExchangeAbsence(makeOrder())).toBeNull();
    for (const bad of [null, "2026-09-01", 5, { firstNullAt: "not a date" }, { firstNullAt: 7 }]) {
      expect(readExchangeAbsence(makeOrder({ metadata: { exchangeAbsenceV1: bad } }))).toBeNull();
    }
  });
});

describe("exchangeAbsenceCloseAtMs", () => {
  it("is governed by the 24h observation when the last activity is older than 7 days", () => {
    const marker = T0 + 10 * DAY;
    expect(exchangeAbsenceCloseAtMs(withMarker(marker), [fillAt(T0 + DAY)])).toBe(
      marker + EXCHANGE_ABSENCE_OBSERVE_MS,
    );
  });

  it("is governed by 7 days of quiet when the last fill is recent", () => {
    const lastFill = T0 + 5 * DAY;
    expect(exchangeAbsenceCloseAtMs(withMarker(T0 + 6 * DAY), [fillAt(lastFill)])).toBe(
      lastFill + EXCHANGE_ABSENCE_QUIET_MS,
    );
    expect(exchangeAbsenceCloseAtMs(withMarker(T0 + DAY), [])).toBe(T0 + EXCHANGE_ABSENCE_QUIET_MS);
  });

  it("returns null without a marker or when a fill landed after the marker started", () => {
    expect(exchangeAbsenceCloseAtMs(makeOrder(), [])).toBeNull();
    expect(exchangeAbsenceCloseAtMs(withMarker(T0 + DAY), [fillAt(T0 + DAY)])).toBeNull();
  });

  it("is due only once both windows have elapsed", () => {
    const order = withMarker(T0 + 10 * DAY);
    const closeAt = T0 + 11 * DAY;
    expect(isExchangeAbsenceDue(order, [], closeAt - 1)).toBe(false);
    expect(isExchangeAbsenceDue(order, [], closeAt)).toBe(true);
    expect(isExchangeAbsenceDue(makeOrder(), [], closeAt)).toBe(false);
  });
});

describe("marker persistence", () => {
  let conn: ReturnType<typeof bootstrapLedgerDb>;
  let orders: SqliteOrderRepository;
  const read = () => orders.findById(createOrderId("zombie"))!;

  beforeEach(() => {
    conn = bootstrapLedgerDb(":memory:");
    orders = new SqliteOrderRepository(conn.db);
    orders.save(makeOrder({ metadata: { bounceRung: { rungIndex: 1 } } }));
  });
  afterEach(() => conn.close());

  it("starts once, keeps the first observation, and preserves other metadata", () => {
    markExchangeAbsent(orders, read().orderId, T0, log);
    markExchangeAbsent(orders, read().orderId, T0 + DAY, log);
    expect(read().metadata).toEqual({
      bounceRung: { rungIndex: 1 },
      exchangeAbsenceV1: { firstNullAt: iso(T0) },
    });
  });

  it("overwrites a malformed marker", () => {
    orders.updateMetadata(read().orderId, { exchangeAbsenceV1: { firstNullAt: "junk" } });
    markExchangeAbsent(orders, read().orderId, T0, log);
    expect(readExchangeAbsence(read())).toEqual({ firstNullAtMs: T0 });
  });

  it("clears only the marker and is a no-op without one", () => {
    markExchangeAbsent(orders, read().orderId, T0, log);
    clearExchangeAbsence(orders, read().orderId, log);
    expect(read().metadata).toEqual({ bounceRung: { rungIndex: 1 } });
    const cas = vi.spyOn(orders, "updateMetadataIfUnchanged");
    clearExchangeAbsence(orders, read().orderId, log);
    expect(cas).not.toHaveBeenCalled();
  });

  it("survives a fresh repository over the same database (restart)", () => {
    markExchangeAbsent(orders, read().orderId, T0, log);
    const reopened = new SqliteOrderRepository(conn.db);
    expect(readExchangeAbsence(reopened.findById(createOrderId("zombie"))!)).toEqual({
      firstNullAtMs: T0,
    });
  });
});

describe("marker CAS retry", () => {
  function racingRepo(misses: number) {
    let row = makeOrder();
    const cas = vi.fn((_id, expected, metadata) => {
      if (cas.mock.calls.length <= misses || expected !== (row.metadata ?? null)) return null;
      row = { ...row, metadata };
      return row;
    });
    const repo = {
      findById: () => row,
      updateMetadataIfUnchanged: cas,
    } as unknown as OrderRepository;
    return { repo, cas, row: () => row };
  }

  it("retries once after losing a race", () => {
    const f = racingRepo(1);
    markExchangeAbsent(f.repo, f.row().orderId, T0, log);
    expect(f.cas).toHaveBeenCalledTimes(2);
    expect(readExchangeAbsence(f.row())).toEqual({ firstNullAtMs: T0 });
  });

  it("gives up after two lost races and leaves the order unmarked", () => {
    const f = racingRepo(2);
    markExchangeAbsent(f.repo, f.row().orderId, T0, log);
    expect(f.cas).toHaveBeenCalledTimes(2);
    expect(readExchangeAbsence(f.row())).toBeNull();
    expect(log.debug).toHaveBeenCalledWith(
      { orderId: f.row().orderId },
      expect.stringContaining("lost CAS"),
    );
  });
});

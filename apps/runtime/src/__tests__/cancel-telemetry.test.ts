import { describe, it, expect, vi } from "vitest";
import {
  createConditionId,
  createOrderId,
  createTokenId,
  type ClientOrderId,
  type FillRepository,
  type MarketRepository,
  type Order,
} from "@plankton/domain";
import { buildCancelTelemetry } from "../modules/reconciliation/cancel-telemetry.js";

const TOK = createTokenId("tok-yes");
const COND = createConditionId("cond-1");

function makeOrder(overrides?: Partial<Order>): Order {
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "plk_x" as ClientOrderId,
    tokenId: TOK,
    conditionId: COND,
    side: "buy",
    orderType: "GTC",
    price: 0.5,
    size: 10,
    sizeUsdc: 5,
    status: "open",
    exchangeOrderId: null,
    signalId: null,
    signalReason: null,
    botRunId: "run-1" as any,
    createdAt: new Date(Date.now() - 5_000).toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFillRepo(fills: Array<{ size: number }> = []): FillRepository {
  return {
    save: vi.fn(),
    exists: vi.fn().mockReturnValue(false),
    findByOrderId: vi.fn().mockReturnValue(fills),
    findByTokenId: vi.fn().mockReturnValue([]),
    findRecent: vi.fn().mockReturnValue([]),
    findUnreconciled: vi.fn().mockReturnValue([]),
    markReconciled: vi.fn(),
    getLatestTimestamp: vi.fn().mockReturnValue(null),
  } as unknown as FillRepository;
}

function makeMarketRepo(horizon: string | null): MarketRepository {
  return {
    findByTokenId: vi.fn().mockReturnValue(horizon ? { horizon } : null),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
    save: vi.fn(),
    saveBatch: vi.fn(),
    iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    deactivateMissing: vi.fn().mockReturnValue(0),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
    updateScoresBatch: vi.fn(),
  } as unknown as MarketRepository;
}

describe("buildCancelTelemetry", () => {
  it("computes age, bucket, and zero fills for a fresh order", () => {
    const now = Date.now();
    const order = makeOrder({ createdAt: new Date(now - 5_000).toISOString() });
    const t = buildCancelTelemetry({
      order,
      nowMs: now,
      fillRepo: makeFillRepo(),
      marketRepo: makeMarketRepo(null),
    });
    expect(t.cancelAgeMs).toBe(5_000);
    expect(t.cancelAgeBucket).toBe("<1min");
    expect(t.fillProgressShares).toBe(0);
    expect(t.marketHorizon).toBeNull();
  });

  it("returns null age when createdAt is malformed", () => {
    const order = makeOrder({ createdAt: "not-a-date" });
    const t = buildCancelTelemetry({
      order,
      nowMs: Date.now(),
      fillRepo: makeFillRepo(),
      marketRepo: makeMarketRepo(null),
    });
    expect(t.cancelAgeMs).toBeNull();
    expect(t.cancelAgeBucket).toBeNull();
  });

  it("sums finite fill sizes and skips non-finite", () => {
    const order = makeOrder();
    const t = buildCancelTelemetry({
      order,
      nowMs: Date.now(),
      fillRepo: makeFillRepo([{ size: 4 }, { size: 6 }, { size: NaN }]),
      marketRepo: makeMarketRepo(null),
    });
    expect(t.fillProgressShares).toBe(10);
  });

  it("returns null fill progress when fillRepo throws", () => {
    const order = makeOrder();
    const fillRepo = {
      ...makeFillRepo(),
      findByOrderId: vi.fn().mockImplementation(() => {
        throw new Error("boom");
      }),
    } as unknown as FillRepository;
    const t = buildCancelTelemetry({
      order,
      nowMs: Date.now(),
      fillRepo,
      marketRepo: makeMarketRepo(null),
    });
    expect(t.fillProgressShares).toBeNull();
  });

  it("returns null market horizon when marketRepo throws", () => {
    const order = makeOrder();
    const marketRepo = {
      ...makeMarketRepo(null),
      findByTokenId: vi.fn().mockImplementation(() => {
        throw new Error("db down");
      }),
    } as unknown as MarketRepository;
    const t = buildCancelTelemetry({
      order,
      nowMs: Date.now(),
      fillRepo: makeFillRepo(),
      marketRepo,
    });
    expect(t.marketHorizon).toBeNull();
  });

  it("captures market horizon when present", () => {
    const order = makeOrder();
    const t = buildCancelTelemetry({
      order,
      nowMs: Date.now(),
      fillRepo: makeFillRepo(),
      marketRepo: makeMarketRepo("short"),
    });
    expect(t.marketHorizon).toBe("short");
  });

  it("returns null age when createdAt is in the future", () => {
    const now = Date.now();
    const order = makeOrder({ createdAt: new Date(now + 60_000).toISOString() });
    const t = buildCancelTelemetry({
      order,
      nowMs: now,
      fillRepo: makeFillRepo(),
      marketRepo: makeMarketRepo(null),
    });
    expect(t.cancelAgeMs).toBeNull();
    expect(t.cancelAgeBucket).toBeNull();
  });
});

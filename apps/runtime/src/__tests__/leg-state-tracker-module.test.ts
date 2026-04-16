import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createFamilyId,
  createFillId,
  createOrderId,
  createPositionId,
  createConditionId,
  OrderSide,
} from "@plankton/domain";
import type { LegStateRepository, TokenId, ClientOrderId, LegState } from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { LegStateTrackerModule } from "../modules/leg-state/leg-state-tracker-module.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const TOK = createTokenId("tok-abc");
const FAM = createFamilyId("fam-1");
const POS = createPositionId("pos-1");
const FILL_ID = createFillId("fill-1");
const ORDER_ID = createOrderId("order-1");
const CLIENT_ORDER_ID = "client-order-1" as ClientOrderId;
const TIMESTAMP = new Date("2026-01-15T10:00:00Z").getTime();

// ─── Mock factories ──────────────────────────────────────────────────────────

function createMockLegStateRepo(): LegStateRepository {
  return {
    get: vi.fn().mockReturnValue(null),
    upsert: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
  } as unknown as LegStateRepository;
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

// ─── Event payload helpers ───────────────────────────────────────────────────

function makeFillPayload(
  side: (typeof OrderSide)[keyof typeof OrderSide],
  overrides?: Partial<{
    tokenId: TokenId;
    price: number;
    timestamp: number;
  }>,
) {
  return {
    fillId: FILL_ID,
    orderId: ORDER_ID,
    clientOrderId: CLIENT_ORDER_ID,
    tokenId: overrides?.tokenId ?? TOK,
    conditionId: createConditionId("cond-1"),
    side,
    price: overrides?.price ?? 0.45,
    size: 100,
    sizeUsdc: 45,
    liquidityRole: "maker" as const,
    fee: 0.01,
    feeRateBps: 2,
    familyId: FAM,
    signalReason: null,
    timestamp: overrides?.timestamp ?? TIMESTAMP,
  };
}

function makeSettledPayload(overrides?: Partial<{ tokenId: TokenId }>) {
  return {
    positionId: POS,
    tokenId: overrides?.tokenId ?? TOK,
    familyId: FAM,
    resolution: "YES",
    settlementPrice: 1.0,
    realizedPnl: 55,
    size: 100,
    avgEntryPrice: 0.45,
    timestamp: TIMESTAMP,
  };
}

function makePositionUpdatedPayload(size: number, overrides?: Partial<{ tokenId: TokenId }>) {
  return {
    position: {
      positionId: POS,
      tokenId: overrides?.tokenId ?? TOK,
      conditionId: createConditionId("cond-1"),
      familyId: FAM,
      side: "buy" as const,
      size,
      avgEntryPrice: 0.45,
      costBasisUsdc: size * 0.45,
      currentValueUsdc: size > 0 ? size * 0.45 : null,
      realizedPnl: 0,
      status: size === 0 ? ("closed" as const) : ("open" as const),
      entryStyle: "probe" as const,
      openedAt: "2026-01-15T10:00:00.000Z",
      closedAt: size === 0 ? "2026-01-15T11:00:00.000Z" : null,
      updatedAt: "2026-01-15T11:00:00.000Z",
    },
  };
}

function makeLegState(overrides?: Partial<LegState>): LegState {
  return {
    tokenId: TOK,
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    firstTradePrice: 0.45,
    firstTradeAt: "2026-01-15T10:00:00.000Z",
    lastTradeAt: "2026-01-15T10:00:00.000Z",
    updatedAt: "2026-01-15T10:00:00.000Z",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("LegStateTrackerModule", () => {
  let bus: InProcessEventBus;
  let legStateRepo: ReturnType<typeof createMockLegStateRepo>;
  let mod: LegStateTrackerModule;

  beforeEach(() => {
    vi.clearAllMocks();
    bus = new InProcessEventBus();
    legStateRepo = createMockLegStateRepo();
    mod = new LegStateTrackerModule({ bus, legStateRepo, log: log as any });
  });

  // ─── BUY fill — new leg state ────────────────────────────────────────────

  it("BUY fill with no existing state creates new leg state with buyCount=1", async () => {
    await mod.start();
    await bus.publish("FillReceived", makeFillPayload(OrderSide.Buy, { price: 0.45 }));

    expect(legStateRepo.upsert).toHaveBeenCalledOnce();
    const upserted = (legStateRepo.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as LegState;
    expect(upserted.tokenId).toBe(TOK);
    expect(upserted.buyCount).toBe(1);
    expect(upserted.sellCount).toBe(0);
    expect(upserted.lastAction).toBe("BUY");
    expect(upserted.firstTradePrice).toBe(0.45);
    expect(upserted.firstTradeAt).toBe(new Date(TIMESTAMP).toISOString());
    expect(upserted.lastTradeAt).toBe(new Date(TIMESTAMP).toISOString());
  });

  // ─── BUY fill — increment existing buyCount ───────────────────────────────

  it("second BUY fill increments buyCount on existing leg state", async () => {
    const existing = makeLegState({ buyCount: 1 });
    (legStateRepo.get as ReturnType<typeof vi.fn>).mockReturnValue(existing);

    await mod.start();
    await bus.publish("FillReceived", makeFillPayload(OrderSide.Buy));

    expect(legStateRepo.upsert).toHaveBeenCalledOnce();
    const upserted = (legStateRepo.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as LegState;
    expect(upserted.buyCount).toBe(2);
    expect(upserted.sellCount).toBe(0);
    expect(upserted.lastAction).toBe("BUY");
    expect(upserted.firstTradePrice).toBe(existing.firstTradePrice);
    expect(upserted.firstTradeAt).toBe(existing.firstTradeAt);
  });

  // ─── SELL fill — increments sellCount ────────────────────────────────────

  it("SELL fill with existing state increments sellCount and sets lastAction=SELL", async () => {
    const existing = makeLegState({ buyCount: 1, sellCount: 0, lastAction: "BUY" });
    (legStateRepo.get as ReturnType<typeof vi.fn>).mockReturnValue(existing);

    await mod.start();
    await bus.publish("FillReceived", makeFillPayload(OrderSide.Sell));

    expect(legStateRepo.upsert).toHaveBeenCalledOnce();
    const upserted = (legStateRepo.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as LegState;
    expect(upserted.sellCount).toBe(1);
    expect(upserted.buyCount).toBe(1);
    expect(upserted.lastAction).toBe("SELL");
  });

  // ─── SELL fill — no existing state → warn, no upsert ─────────────────────

  it("SELL fill with no existing state logs warn and does not call upsert", async () => {
    (legStateRepo.get as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await mod.start();
    await bus.publish("FillReceived", makeFillPayload(OrderSide.Sell));

    expect(legStateRepo.upsert).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  // ─── PositionSettled — deletes leg state ─────────────────────────────────

  it("PositionSettled event deletes leg state for the settled tokenId", async () => {
    await mod.start();
    await bus.publish("PositionSettled", makeSettledPayload());

    expect(legStateRepo.delete).toHaveBeenCalledOnce();
    expect(legStateRepo.delete).toHaveBeenCalledWith(TOK);
  });

  // ─── PositionUpdated — size=0 deletes leg state ──────────────────────────

  it("PositionUpdated with size=0 deletes leg state", async () => {
    await mod.start();
    await bus.publish("PositionUpdated", makePositionUpdatedPayload(0));

    expect(legStateRepo.delete).toHaveBeenCalledOnce();
    expect(legStateRepo.delete).toHaveBeenCalledWith(TOK);
  });

  it("PositionUpdated with size>0 does not delete leg state", async () => {
    await mod.start();
    await bus.publish("PositionUpdated", makePositionUpdatedPayload(100));

    expect(legStateRepo.delete).not.toHaveBeenCalled();
  });

  // ─── start() / stop() subscription lifecycle ─────────────────────────────

  it("after stop(), FillReceived events are not handled", async () => {
    await mod.start();
    await mod.stop();

    await bus.publish("FillReceived", makeFillPayload(OrderSide.Buy));

    expect(legStateRepo.upsert).not.toHaveBeenCalled();
  });

  it("after stop(), PositionSettled events are not handled", async () => {
    await mod.start();
    await mod.stop();

    await bus.publish("PositionSettled", makeSettledPayload());

    expect(legStateRepo.delete).not.toHaveBeenCalled();
  });

  it("after stop(), PositionUpdated events are not handled", async () => {
    await mod.start();
    await mod.stop();

    await bus.publish("PositionUpdated", makePositionUpdatedPayload(0));

    expect(legStateRepo.delete).not.toHaveBeenCalled();
  });

  it("start() subscribes so events are handled", async () => {
    await mod.start();
    await bus.publish("FillReceived", makeFillPayload(OrderSide.Buy));

    expect(legStateRepo.upsert).toHaveBeenCalledOnce();
  });

  // ─── healthCheck ──────────────────────────────────────────────────────────

  it("healthCheck() returns { ok: true }", async () => {
    const result = await mod.healthCheck();
    expect(result).toEqual({ ok: true });
  });
});

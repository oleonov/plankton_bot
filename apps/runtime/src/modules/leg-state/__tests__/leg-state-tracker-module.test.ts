import { describe, it, expect, vi, beforeEach } from "vitest";
import { LegStateTrackerModule } from "../leg-state-tracker-module.js";
import type { LegStateRepository, LegState, RuntimeEventMap } from "@plankton/domain";
import { createTokenId, createOrderId, deriveState } from "@plankton/domain";
import type { Logger } from "../../../logger.js";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

type BusHandler = (payload: any) => Promise<void>;

function createMockBus() {
  const handlers = new Map<string, BusHandler[]>();

  const subscribe = vi.fn((event: string, handler: BusHandler) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event)!.push(handler);
    return () => {
      const list = handlers.get(event) ?? [];
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
    };
  });

  const publish = vi.fn(async (event: string, payload: unknown) => {
    const list = handlers.get(event) ?? [];
    for (const h of list) await h(payload);
  });

  return { subscribe, publish, drain: vi.fn(async () => {}) };
}

function createMockLegStateRepo(): LegStateRepository {
  const store = new Map<string, LegState>();
  return {
    get: vi.fn((tokenId) => store.get(tokenId) ?? null),
    upsert: vi.fn((state: LegState) => store.set(state.tokenId, state)),
    delete: vi.fn((tokenId) => {
      store.delete(tokenId);
    }),
    getAll: vi.fn(() => [...store.values()]),
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => makeLogger(),
  } as unknown as Logger;
}

const TOK = createTokenId("tok-btc-yes");
const TOK2 = createTokenId("tok-eth-yes");

function makeFillPayload(
  overrides: Partial<RuntimeEventMap["FillReceived"]> = {},
): RuntimeEventMap["FillReceived"] {
  return {
    fillId: "fill-1" as any,
    orderId: createOrderId("ord-1"),
    clientOrderId: "coid-1" as any,
    tokenId: TOK,
    conditionId: "cond-1" as any,
    side: "buy",
    price: 0.03,
    size: 10,
    sizeUsdc: 0.3,
    liquidityRole: "maker",
    fee: 0,
    feeRateBps: 0,
    signalReason: null,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("LegStateTrackerModule", () => {
  let bus: ReturnType<typeof createMockBus>;
  let repo: LegStateRepository;
  let mod: LegStateTrackerModule;
  let log: Logger;

  beforeEach(() => {
    bus = createMockBus();
    repo = createMockLegStateRepo();
    log = makeLogger();
    mod = new LegStateTrackerModule({
      bus: bus as any,
      legStateRepo: repo,
      log,
    });
  });

  // ─── FillReceived: BUY ────────────────────────────────────────────────

  it("creates fresh leg state on first BUY fill", async () => {
    await mod.start();
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.03 }));

    const state = repo.get(TOK);
    expect(state).not.toBeNull();
    expect(state!.buyCount).toBe(1);
    expect(state!.sellCount).toBe(0);
    expect(state!.lastAction).toBe("BUY");
    expect(state!.firstTradePrice).toBe(0.03);
  });

  it("increments buyCount on subsequent BUY fills", async () => {
    await mod.start();
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.03 }));
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.04 }));
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.02 }));

    const state = repo.get(TOK);
    expect(state!.buyCount).toBe(3);
    expect(state!.sellCount).toBe(0);
    expect(state!.lastAction).toBe("BUY");
    expect(state!.firstTradePrice).toBe(0.03);
  });

  // ─── FillReceived: SELL ───────────────────────────────────────────────

  it("increments sellCount and flips lastAction on SELL after BUYs", async () => {
    await mod.start();
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.03 }));
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.04 }));
    await bus.publish("FillReceived", makeFillPayload({ side: "sell", price: 0.25 }));

    const state = repo.get(TOK);
    expect(state!.buyCount).toBe(2);
    expect(state!.sellCount).toBe(1);
    expect(state!.lastAction).toBe("SELL");
  });

  it("warns and skips SELL fill with no existing leg state", async () => {
    await mod.start();
    await bus.publish("FillReceived", makeFillPayload({ side: "sell", price: 0.25 }));

    expect(repo.get(TOK)).toBeNull();
  });

  // ─── Multiple tokens ──────────────────────────────────────────────────

  it("tracks multiple tokens independently", async () => {
    await mod.start();
    await bus.publish("FillReceived", makeFillPayload({ tokenId: TOK, side: "buy", price: 0.03 }));
    await bus.publish("FillReceived", makeFillPayload({ tokenId: TOK2, side: "buy", price: 0.1 }));
    await bus.publish("FillReceived", makeFillPayload({ tokenId: TOK, side: "buy", price: 0.04 }));

    expect(repo.get(TOK)!.buyCount).toBe(2);
    expect(repo.get(TOK2)!.buyCount).toBe(1);
    expect(repo.get(TOK2)!.firstTradePrice).toBe(0.1);
  });

  // ─── PositionUpdated → delete on close ────────────────────────────────

  it("deletes leg state when position size reaches 0", async () => {
    await mod.start();
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.03 }));
    expect(repo.get(TOK)).not.toBeNull();

    await bus.publish("PositionUpdated", {
      position: { tokenId: TOK, size: 0, status: "closed" } as any,
    });

    expect(repo.get(TOK)).toBeNull();
  });

  it("does not delete leg state for open positions with size > 0", async () => {
    await mod.start();
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.03 }));

    await bus.publish("PositionUpdated", {
      position: { tokenId: TOK, size: 10, status: "open" } as any,
    });

    expect(repo.get(TOK)).not.toBeNull();
  });

  // ─── PositionSettled → delete ─────────────────────────────────────────

  it("deletes leg state on PositionSettled", async () => {
    await mod.start();
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.03 }));
    expect(repo.get(TOK)).not.toBeNull();

    await bus.publish("PositionSettled", {
      positionId: "pos-1" as any,
      tokenId: TOK,
      familyId: null,
      resolution: "YES",
      settlementPrice: 1.0,
      realizedPnl: 5.0,
      size: 10,
      timestamp: Date.now(),
    });

    expect(repo.get(TOK)).toBeNull();
  });

  // ─── Fresh cycle after delete ─────────────────────────────────────────

  it("starts fresh cycle after leg deletion", async () => {
    await mod.start();
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.03 }));
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.04 }));
    await bus.publish("FillReceived", makeFillPayload({ side: "sell", price: 0.25 }));
    expect(repo.get(TOK)!.buyCount).toBe(2);

    await bus.publish("PositionUpdated", {
      position: { tokenId: TOK, size: 0, status: "closed" } as any,
    });
    expect(repo.get(TOK)).toBeNull();

    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.01 }));
    const state = repo.get(TOK);
    expect(state!.buyCount).toBe(1);
    expect(state!.sellCount).toBe(0);
    expect(state!.firstTradePrice).toBe(0.01);
  });

  // ─── Lifecycle ────────────────────────────────────────────────────────

  it("does not process events after stop", async () => {
    await mod.start();
    await mod.stop();

    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.03 }));
    expect(repo.get(TOK)).toBeNull();
  });

  it("healthCheck returns ok", async () => {
    const health = await mod.healthCheck();
    expect(health.ok).toBe(true);
  });

  // ─── Batch C: Full-cycle state transition (BUY → BUY → SELL → BUY) ──────────

  it("back-transitions through S1→S2→S3→S2 across BUY/SELL/BUY sequence", async () => {
    await mod.start();

    // 1st BUY: S1
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.03 }));
    expect(deriveState(repo.get(TOK))).toBe("S1");

    // 2nd BUY: S2
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.04 }));
    expect(deriveState(repo.get(TOK))).toBe("S2");

    // SELL: S3
    await bus.publish("FillReceived", makeFillPayload({ side: "sell", price: 0.25 }));
    expect(deriveState(repo.get(TOK))).toBe("S3");

    // BUY after SELL: back-transitions to S2 (buyCount=3 >= 2, lastAction=BUY)
    await bus.publish("FillReceived", makeFillPayload({ side: "buy", price: 0.05 }));
    expect(deriveState(repo.get(TOK))).toBe("S2");
  });
});

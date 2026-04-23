import { describe, it, expect, vi, beforeEach } from "vitest";
import { InProcessEventBus } from "../event-bus.js";
import type { Signal, Position, NormalizedMarket } from "@plankton/domain";
import { createTokenId, createPositionId, createConditionId } from "@plankton/domain";

function makeSignal(overrides?: Partial<Signal>): Signal {
  return {
    signalId: "sig-1",
    tokenId: createTokenId("tok-1"),
    conditionId: createConditionId("cond-1"),
    side: "buy",
    suggestedPrice: 0.55,
    suggestedSize: 100,
    suggestedSizeUsdc: 55,
    reason: "probe-entry",
    strategyTick: Date.now(),
    sequenceInTick: 0,
    decisionRuleId: null,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMarket(): NormalizedMarket {
  return {
    tokenId: createTokenId("tok-1"),
    conditionId: "cond-1",
    slug: "test",
    eventSlug: null,
    question: "test?",
    outcome: "YES",
    regime: "threshold" as any,
    horizon: "daily",
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.54,
    bestAsk: 0.56,
    midPrice: 0.55,
    spread: 0.02,
    snapshotTs: Date.now(),
    eventMarketCount: 1,
  } as NormalizedMarket;
}

function makePosition(overrides?: Partial<Position>): Position {
  return {
    positionId: createPositionId("pos-1"),
    tokenId: createTokenId("tok-1"),
    conditionId: createConditionId("cond-1"),
    side: "buy",
    size: 100,
    avgEntryPrice: 0.55,
    costBasisUsdc: 55,
    currentValueUsdc: 60,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: new Date().toISOString(),
    closedAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("InProcessEventBus", () => {
  let bus: InProcessEventBus;

  beforeEach(() => {
    bus = new InProcessEventBus();
  });

  it("delivers payload to subscriber", async () => {
    const signal = makeSignal();
    const received: Signal[] = [];

    bus.subscribe("SignalProduced", async (p) => {
      received.push(p.signal);
    });
    await bus.publish("SignalProduced", { signal, market: makeMarket() });

    expect(received).toEqual([signal]);
  });

  it("delivers to multiple subscribers", async () => {
    const position = makePosition();
    const calls: number[] = [];

    bus.subscribe("PositionUpdated", async () => {
      calls.push(1);
    });
    bus.subscribe("PositionUpdated", async () => {
      calls.push(2);
    });
    await bus.publish("PositionUpdated", { position });

    expect(calls).toHaveLength(2);
    expect(calls).toContain(1);
    expect(calls).toContain(2);
  });

  it("resolves without error when no subscribers exist", async () => {
    await expect(
      bus.publish("SignalProduced", { signal: makeSignal(), market: makeMarket() }),
    ).resolves.toBeUndefined();
  });

  it("stops calling handler after unsubscribe", async () => {
    const calls: number[] = [];
    const unsub = bus.subscribe("PositionUpdated", async () => {
      calls.push(1);
    });

    await bus.publish("PositionUpdated", { position: makePosition() });
    expect(calls).toHaveLength(1);

    unsub();
    await bus.publish("PositionUpdated", { position: makePosition() });
    expect(calls).toHaveLength(1);
  });

  it("allows idempotent unsubscribe", () => {
    const unsub = bus.subscribe("SignalProduced", async () => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it("isolates handler errors — other handlers still run", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: number[] = [];

    bus.subscribe("SignalProduced", async () => {
      throw new Error("boom");
    });
    bus.subscribe("SignalProduced", async () => {
      calls.push(1);
    });

    await expect(
      bus.publish("SignalProduced", { signal: makeSignal(), market: makeMarket() }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([1]);
    spy.mockRestore();
  });

  it("logs handler errors to stderr", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("handler-fail");

    bus.subscribe("SignalProduced", async () => {
      throw err;
    });
    await bus.publish("SignalProduced", { signal: makeSignal(), market: makeMarket() });

    expect(spy).toHaveBeenCalledWith(err);
    spy.mockRestore();
  });

  it("drain resolves immediately with no inflight handlers", async () => {
    await expect(bus.drain()).resolves.toBeUndefined();
  });

  it("drain waits for slow handlers", async () => {
    let resolved = false;
    bus.subscribe("PositionUpdated", async () => {
      await new Promise((r) => setTimeout(r, 50));
      resolved = true;
    });

    const publishPromise = bus.publish("PositionUpdated", {
      position: makePosition(),
    });

    // Publish is awaited inline, but drain should also work for
    // any residual tracking.
    await publishPromise;
    await bus.drain();
    expect(resolved).toBe(true);
  });

  it("drain with timeout resolves after timeout even if handler is slow", async () => {
    bus.subscribe("SignalProduced", async () => {
      await new Promise((r) => setTimeout(r, 5000));
    });

    // Fire-and-forget publish so handler is inflight
    void bus.publish("SignalProduced", { signal: makeSignal(), market: makeMarket() });

    const start = Date.now();
    await bus.drain(50);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });

  it("enforces type safety on payloads", () => {
    // @ts-expect-error - wrong payload shape for SignalProduced
    void bus.publish("SignalProduced", { wrong: true });

    // @ts-expect-error - wrong event name
    void bus.publish("NonExistentEvent", {});
  });
});

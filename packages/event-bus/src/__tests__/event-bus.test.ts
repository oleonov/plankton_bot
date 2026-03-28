import { describe, it, expect, vi, beforeEach } from "vitest";
import { InProcessEventBus } from "../event-bus.js";
import type { Signal, Position, FamilyState } from "@plankton/domain";
import { createTokenId, createFamilyId, createPositionId } from "@plankton/domain";

function makeSignal(overrides?: Partial<Signal>): Signal {
  return {
    signalId: "sig-1",
    familyId: createFamilyId("fam-1"),
    tokenId: createTokenId("tok-1"),
    side: "buy",
    suggestedPrice: 0.55,
    suggestedSize: 100,
    suggestedSizeUsdc: 55,
    reason: "probe-entry",
    strategyTick: Date.now(),
    sequenceInTick: 0,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePosition(overrides?: Partial<Position>): Position {
  return {
    positionId: createPositionId("pos-1"),
    tokenId: createTokenId("tok-1"),
    familyId: createFamilyId("fam-1"),
    side: "buy",
    size: 100,
    avgEntryPrice: 0.55,
    costBasisUsdc: 55,
    currentValueUsdc: 60,
    realizedPnl: 0,
    status: "open",
    openedAt: new Date().toISOString(),
    closedAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFamilyState(overrides?: Partial<FamilyState>): FamilyState {
  return {
    familyId: createFamilyId("fam-1"),
    runtimeMode: "active",
    openValueUsdc: 100,
    openPositionCount: 1,
    openDustCount: 0,
    activeMarketCount: 2,
    currentTailCostUsdc: 5,
    tailAdjustedPnlLive: 10,
    lastEntryTs: null,
    lastExitTs: null,
    quarantineReason: null,
    effectiveMode: null,
    derivedModeReason: null,
    firstNegativeTailAt: null,
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
    await bus.publish("SignalProduced", { signal });

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
    await expect(bus.publish("SignalProduced", { signal: makeSignal() })).resolves.toBeUndefined();
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

    await expect(bus.publish("SignalProduced", { signal: makeSignal() })).resolves.toBeUndefined();

    expect(calls).toEqual([1]);
    spy.mockRestore();
  });

  it("logs handler errors to stderr", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("handler-fail");

    bus.subscribe("SignalProduced", async () => {
      throw err;
    });
    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(spy).toHaveBeenCalledWith(err);
    spy.mockRestore();
  });

  it("drain resolves immediately with no inflight handlers", async () => {
    await expect(bus.drain()).resolves.toBeUndefined();
  });

  it("drain waits for slow handlers", async () => {
    let resolved = false;
    bus.subscribe("FamilyExposureChanged", async () => {
      await new Promise((r) => setTimeout(r, 50));
      resolved = true;
    });

    const publishPromise = bus.publish("FamilyExposureChanged", {
      familyId: createFamilyId("fam-1"),
      totalExposureUsdc: 100,
      openPositionCount: 1,
      familyState: makeFamilyState(),
      timestamp: Date.now(),
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
    void bus.publish("SignalProduced", { signal: makeSignal() });

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

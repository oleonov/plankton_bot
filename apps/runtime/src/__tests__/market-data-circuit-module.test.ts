/**
 * Tests for MarketDataModule's handling of circuit breaker lifecycle events (Task 4).
 * Verifies that shard_circuit_open routes token IDs to pendingGapTokenIds and
 * that stream_circuit_open/closed toggles streamDegradedMode.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { MarketPricingLifecycleEvent } from "@krabs/domain";
import { MarketDataModule } from "../modules/market-data/market-data-module.js";

describe("MarketDataModule — circuit breaker lifecycle events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function buildModule() {
    const lifecycleHandlerRef: {
      fn: ((events: readonly MarketPricingLifecycleEvent[]) => Promise<void>) | null;
    } = { fn: null };

    const fakeGateway = {
      createMarketPricingStream: (handlers: {
        onLifecycleEvents?: (events: readonly MarketPricingLifecycleEvent[]) => Promise<void>;
        onUpdates: () => void;
        onError: () => void;
        onGapDetected: () => void;
      }) => {
        lifecycleHandlerRef.fn = handlers.onLifecycleEvents ?? null;
        return { setTokenIds: () => {}, close: () => {} };
      },
      getMarketPricing: async () => new Map(),
    };

    const fakeBus = { publish: async () => {}, subscribe: () => () => {} };
    const fakeMarketRepo = {
      findTrackedForPricing: () => [],
      findTrackedForPricingTiered: () => ({
        executionCritical: [],
        entryCandidates: [],
        discoveryOnly: [],
      }),
    };
    const fakeLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: function () {
        return this;
      },
    };

    const module = new MarketDataModule({
      gateway: fakeGateway as never,
      marketRepo: fakeMarketRepo as never,
      bus: fakeBus as never,
      log: fakeLogger as never,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
    });

    return { module, lifecycleHandlerRef };
  }

  it("shard_circuit_open: streamDegradedMode stays false; stream_circuit_open sets it true", async () => {
    const { module, lifecycleHandlerRef } = buildModule();
    await module.start();

    expect(module.streamDegradedMode).toBe(false);

    // Simulate shard_circuit_open — only routes tokens to gap set, not degraded mode.
    await lifecycleHandlerRef.fn?.([
      {
        type: "shard_circuit_open",
        shardId: 0,
        tokenIds: ["tok-1", "tok-2"],
        reopenAtMs: Date.now() + 120_000,
      },
    ]);
    expect(module.streamDegradedMode).toBe(false);

    // Simulate stream_circuit_open — sets degraded mode.
    await lifecycleHandlerRef.fn?.([
      {
        type: "stream_circuit_open",
        reopenAtMs: Date.now() + 120_000,
        reason: "quorum",
      },
    ]);
    expect(module.streamDegradedMode).toBe(true);

    // Simulate stream_circuit_closed — restores normal mode.
    await lifecycleHandlerRef.fn?.([{ type: "stream_circuit_closed" }]);
    expect(module.streamDegradedMode).toBe(false);

    await module.stop();
  });

  it("shard_circuit_closed does not change streamDegradedMode", async () => {
    const { module, lifecycleHandlerRef } = buildModule();
    await module.start();

    await lifecycleHandlerRef.fn?.([
      { type: "shard_circuit_closed", shardId: 0, tokenIds: ["tok-x"] },
    ]);
    expect(module.streamDegradedMode).toBe(false);

    await module.stop();
  });
});

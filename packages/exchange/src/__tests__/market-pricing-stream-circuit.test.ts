/**
 * Tests for Task 4: per-shard exponential backoff, per-shard circuit breaker,
 * and stream-level quorum guard with AND semantic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeReconnectDelayMs } from "../live/reconnect-backoff.js";
import { LiveMarketPricingStream } from "../live/market-pricing-stream.js";
import type { MarketPricingLifecycleEvent } from "@krabs/domain";
import type { MarketDataWebSocketLike } from "../live/market-data-stream-shared.js";

// ─── Fake WebSocket ───────────────────────────────────────────────────────

class FakeSocket implements MarketDataWebSocketLike {
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  closeCalled = false;
  /** If true, will call its own onclose immediately after onopen is set. */
  autoClose = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalled = true;
    this.onclose?.({});
  }

  emitOpen(): void {
    this.onopen?.({});
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

interface StreamOpts {
  shardBreakerReconnectsPerMin?: number;
  shardBreakerOpenMs?: number;
  shardBreakerOpenMaxMs?: number;
  circuitShardOpenPercent?: number;
  circuitOpenShardFloor?: number;
  circuitOpenMs?: number;
  streamStableMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxSubscriptionsPerConnection?: number;
}

function makeStream(
  createWebSocket: (url: string) => MarketDataWebSocketLike,
  opts: StreamOpts = {},
  lifecycleEvents?: MarketPricingLifecycleEvent[],
) {
  const stream = new LiveMarketPricingStream({
    createWebSocket,
    handlers: {
      onUpdates: async () => {},
      onLifecycleEvents: async (events) => {
        if (lifecycleEvents) {
          lifecycleEvents.push(...events);
        }
      },
      onError: async () => {},
      onGapDetected: async () => {},
    },
    maxSubscriptionsPerConnection: opts.maxSubscriptionsPerConnection ?? 10,
    shardBreakerReconnectsPerMin: opts.shardBreakerReconnectsPerMin ?? 3,
    shardBreakerOpenMs: opts.shardBreakerOpenMs ?? 1_000,
    shardBreakerOpenMaxMs: opts.shardBreakerOpenMaxMs ?? 8_000,
    circuitShardOpenPercent: opts.circuitShardOpenPercent ?? 50,
    circuitOpenShardFloor: opts.circuitOpenShardFloor ?? 3,
    circuitOpenMs: opts.circuitOpenMs ?? 1_000,
    streamStableMs: opts.streamStableMs ?? 500,
    reconnectBaseMs: opts.reconnectBaseMs ?? 100,
    reconnectMaxMs: opts.reconnectMaxMs ?? 1_000,
    queueMax: 256,
    lagWarnMs: 2_000,
  });
  return stream;
}

/**
 * Creates a socket factory where the first `flappingCount` sockets immediately
 * fire their own `onclose` handler as soon as `onclose` is set on them.
 * This simulates a shard socket that is immediately rejected at the TCP level.
 * Sockets after `flappingCount` are stable (don't self-close).
 * Also tracks all created sockets for assertions.
 */
function makeShardFlapper(flappingCount: number): {
  factory: () => FakeSocket;
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  return {
    factory: () => {
      const s = new FakeSocket();
      const idx = sockets.length;
      sockets.push(s);
      if (idx < flappingCount) {
        // Override onclose setter: fire immediately when set (simulates instant disconnect).
        let _onclose: ((e?: unknown) => void) | null = null;
        Object.defineProperty(s, "onclose", {
          get: () => _onclose,
          set: (fn: ((e?: unknown) => void) | null) => {
            _onclose = fn;
            // Fire close synchronously when handler is registered.
            if (fn) setTimeout(() => fn({}), 0);
          },
          configurable: true,
        });
      }
      return s;
    },
    sockets,
  };
}

// ─── 1. computeReconnectDelayMs table ────────────────────────────────────

describe("computeReconnectDelayMs", () => {
  it("no-jitter: matches min(base * 2^attempts, max) for attempts 0..10", () => {
    const base = 100;
    const max = 10_000;
    for (let attempts = 0; attempts <= 10; attempts++) {
      const expected = Math.min(base * Math.pow(2, attempts), max);
      expect(computeReconnectDelayMs(attempts, { baseMs: base, maxMs: max, jitter: "none" })).toBe(
        expected,
      );
    }
  });

  it("no-jitter: caps at max", () => {
    expect(computeReconnectDelayMs(100, { baseMs: 1_000, maxMs: 30_000, jitter: "none" })).toBe(
      30_000,
    );
  });

  it("full jitter: always in [0, cap]", () => {
    for (let attempts = 0; attempts <= 10; attempts++) {
      const cap = Math.min(1_000 * Math.pow(2, attempts), 30_000);
      const delay = computeReconnectDelayMs(attempts, {
        baseMs: 1_000,
        maxMs: 30_000,
        jitter: "full",
      });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(cap);
    }
  });

  it("full jitter bounded: never exceeds maxMs regardless of attempts", () => {
    for (let i = 0; i < 20; i++) {
      const delay = computeReconnectDelayMs(50, { baseMs: 100, maxMs: 5_000, jitter: "full" });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(5_000);
    }
  });
});

// ─── 2. Per-shard breaker opens only for that shard ──────────────────────

describe("per-shard circuit breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens breaker for a single flapping shard; other shards unaffected; stream breaker stays closed", async () => {
    // shardCount = 2: shard0 = tokens 0-4, shard1 = tokens 5-9.
    // shard0 flaps; shard1 stays open. floor=3 prevents stream-level breaker.
    const threshold = 3;
    // flapper: first `threshold` sockets for shard0 close immediately; the rest are stable.
    const flapper0 = makeShardFlapper(threshold);
    const shard1Sockets: FakeSocket[] = Array.from({ length: 5 }, () => new FakeSocket());

    // We'll interleave shard0 and shard1 sockets based on which shard is requested.
    // Since shards are created in order (shard0 first, shard1 second) and then
    // reconnects for shard0 use the flapper, we track separately:
    const shard1Socket = shard1Sockets[0]!;
    const allSockets: FakeSocket[] = [];
    const factory = (): FakeSocket => {
      // First 2 calls: initial shard0 + shard1 sockets.
      // Subsequent calls: reconnects for shard0 (flapper).
      if (allSockets.length === 0) {
        const s = flapper0.factory();
        allSockets.push(s);
        return s;
      }
      if (allSockets.length === 1) {
        allSockets.push(shard1Socket);
        return shard1Socket;
      }
      // Further reconnects are for shard0 (flapper).
      const s = flapper0.factory();
      allSockets.push(s);
      return s;
    };

    const lifecycleEvents: MarketPricingLifecycleEvent[] = [];
    const stream = makeStream(
      factory,
      {
        maxSubscriptionsPerConnection: 5,
        shardBreakerReconnectsPerMin: threshold,
        circuitOpenShardFloor: 3, // floor unreachable with 2 shards
        circuitShardOpenPercent: 50,
        reconnectBaseMs: 0,
        reconnectMaxMs: 0,
      },
      lifecycleEvents,
    );

    stream.setTokenIds([
      ...Array.from({ length: 5 }, (_, i) => `t${i}`),
      ...Array.from({ length: 5 }, (_, i) => `t${5 + i}`),
    ]);

    // Shard1 stays open.
    shard1Socket.emitOpen();

    // Advance timers to process all the flapping close->reconnect->close cycles.
    // Each close fires setTimeout(fn, 0) and reconnect is also setTimeout(fn, 0).
    await vi.advanceTimersByTimeAsync(200);

    const shardOpenEvents = lifecycleEvents.filter((e) => e.type === "shard_circuit_open");
    expect(shardOpenEvents.length).toBeGreaterThanOrEqual(1);
    const firstOpen = shardOpenEvents[0];
    if (firstOpen?.type === "shard_circuit_open") {
      expect(firstOpen.shardId).toBe(0);
    }

    // stream_circuit_open must NOT have fired (floor=3 not met with 2 shards).
    const streamOpen = lifecycleEvents.filter((e) => e.type === "stream_circuit_open");
    expect(streamOpen).toHaveLength(0);

    stream.close();
  });

  it("per-shard half-open: stable reconnect within streamStableMs → shard_circuit_closed", async () => {
    const threshold = 3;
    const flapper = makeShardFlapper(threshold);
    // After flappingCount sockets, a stable socket is returned.
    const stableSocket = new FakeSocket();
    let socketIdx = 0;
    const factory = () => {
      if (socketIdx < threshold) {
        socketIdx++;
        return flapper.factory();
      }
      return stableSocket;
    };

    const lifecycleEvents: MarketPricingLifecycleEvent[] = [];
    const stream = makeStream(
      factory,
      {
        maxSubscriptionsPerConnection: 50,
        shardBreakerReconnectsPerMin: threshold,
        shardBreakerOpenMs: 100,
        shardBreakerOpenMaxMs: 1_000,
        streamStableMs: 100,
        circuitOpenShardFloor: 3,
        reconnectBaseMs: 0,
        reconnectMaxMs: 0,
      },
      lifecycleEvents,
    );

    stream.setTokenIds(["a", "b", "c"]);

    // Advance to process flapping (immediately-closing sockets).
    await vi.advanceTimersByTimeAsync(50);

    expect(lifecycleEvents.filter((e) => e.type === "shard_circuit_open")).toHaveLength(1);

    // Advance past breaker open window (100ms) to trigger half-open.
    await vi.advanceTimersByTimeAsync(150);

    // The stable socket was created; open it.
    stableSocket.emitOpen();

    // Advance past streamStableMs (100ms) to confirm recovery.
    await vi.advanceTimersByTimeAsync(150);

    const closedEvents = lifecycleEvents.filter((e) => e.type === "shard_circuit_closed");
    expect(closedEvents).toHaveLength(1);

    stream.close();
  });

  it("unstable half-open: early close → reopens with doubled window", async () => {
    const threshold = 3;
    const flapper = makeShardFlapper(threshold);
    // After flapper sockets: an unstable half-open socket (will also close immediately).
    const halfOpenFlapper = makeShardFlapper(1);
    let socketIdx = 0;
    const factory = () => {
      if (socketIdx < threshold) {
        socketIdx++;
        return flapper.factory();
      }
      socketIdx++;
      return halfOpenFlapper.factory();
    };

    const lifecycleEvents: MarketPricingLifecycleEvent[] = [];
    const stream = makeStream(
      factory,
      {
        maxSubscriptionsPerConnection: 50,
        shardBreakerReconnectsPerMin: threshold,
        shardBreakerOpenMs: 100,
        shardBreakerOpenMaxMs: 1_600,
        streamStableMs: 200,
        circuitOpenShardFloor: 3,
        reconnectBaseMs: 0,
        reconnectMaxMs: 0,
      },
      lifecycleEvents,
    );

    stream.setTokenIds(["x", "y", "z"]);

    // Advance to trigger initial flapping + breaker open.
    await vi.advanceTimersByTimeAsync(50);

    const openEvents1 = lifecycleEvents.filter(
      (e): e is Extract<MarketPricingLifecycleEvent, { type: "shard_circuit_open" }> =>
        e.type === "shard_circuit_open",
    );
    expect(openEvents1).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const firstOpen = openEvents1[0]!;

    // Advance past first open window (100ms) → half-open attempt.
    // The half-open socket also closes immediately (halfOpenFlapper).
    await vi.advanceTimersByTimeAsync(150);

    // A second shard_circuit_open should fire with doubled window.
    const openEvents2 = lifecycleEvents.filter(
      (e): e is Extract<MarketPricingLifecycleEvent, { type: "shard_circuit_open" }> =>
        e.type === "shard_circuit_open",
    );
    expect(openEvents2.length).toBeGreaterThanOrEqual(2);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const secondOpen = openEvents2[1]!;
    // Doubled window: original 100ms → 200ms → reopenAtMs is further out.
    expect(secondOpen.reopenAtMs).toBeGreaterThan(firstOpen.reopenAtMs);

    stream.close();
  });
});

// ─── 3. AND semantic matrix ───────────────────────────────────────────────

describe("stream-level circuit breaker — AND semantic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Helper: builds a stream with `shardCount` shards where the first `shardsToOpen`
   * shards have flapping sockets (immediate close) causing shard breakers to open.
   * Remaining shards get stable sockets.
   * Returns collected lifecycle events after advancing timers.
   */
  async function openNShards(
    shardCount: number,
    shardsToOpen: number,
    streamOpts: {
      circuitOpenShardFloor: number;
      circuitShardOpenPercent: number;
    },
  ): Promise<MarketPricingLifecycleEvent[]> {
    const threshold = 3;
    const tokensPerShard = 3;
    const totalTokens = shardCount * tokensPerShard;
    const lifecycleEvents: MarketPricingLifecycleEvent[] = [];

    // Per-shard queues: flapping shards have many immediately-closing sockets,
    // stable shards have a single stable socket repeated infinitely.
    const shardQueues: Array<() => FakeSocket> = [];
    for (let i = 0; i < shardCount; i++) {
      if (i < shardsToOpen) {
        // Enough flapping sockets for threshold reconnects per shard.
        const flapCount = threshold + 5; // extra for reconnect attempts
        const flapper = makeShardFlapper(flapCount);
        shardQueues.push(() => flapper.factory());
      } else {
        const stable = new FakeSocket();
        // Open it immediately after creation.
        let firstCall = true;
        shardQueues.push(() => {
          if (firstCall) {
            firstCall = false;
            setTimeout(() => stable.emitOpen(), 0);
          }
          return stable;
        });
      }
    }

    // The stream creates sockets in round-robin shard order on first sync.
    // Subsequent creates (reconnects) are for the shard that needs them.
    // Since stable shards never reconnect, all reconnects go to flapping shards.
    // We track which shard is expected next using a simple state machine:
    // first shardCount calls = initial creates in order 0..shardCount-1.
    // Subsequent calls = reconnects for flapping shards in round-robin.
    let totalCreated = 0;
    const reconnectRobin = Array.from({ length: shardsToOpen }, (_, i) => i);
    let reconnectRobinIdx = 0;

    const factory = (): FakeSocket => {
      if (totalCreated < shardCount) {
        const shardId = totalCreated++;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return shardQueues[shardId]!();
      }
      // Reconnect — goes to flapping shards round-robin.
      if (reconnectRobin.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const shardId = reconnectRobin[reconnectRobinIdx % reconnectRobin.length]!;
        reconnectRobinIdx++;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return shardQueues[shardId]!();
      }
      return new FakeSocket();
    };

    const stream = makeStream(
      factory,
      {
        maxSubscriptionsPerConnection: tokensPerShard,
        shardBreakerReconnectsPerMin: threshold,
        shardBreakerOpenMs: 50,
        shardBreakerOpenMaxMs: 400,
        circuitOpenShardFloor: streamOpts.circuitOpenShardFloor,
        circuitShardOpenPercent: streamOpts.circuitShardOpenPercent,
        circuitOpenMs: 500,
        streamStableMs: 100,
        reconnectBaseMs: 0,
        reconnectMaxMs: 0,
      },
      lifecycleEvents,
    );

    const allTokens = Array.from({ length: totalTokens }, (_, i) => `t${i}`);
    stream.setTokenIds(allTokens);

    // Advance time to let all immediate closes + reconnects + breaker opens settle.
    await vi.advanceTimersByTimeAsync(300);

    stream.close();
    return lifecycleEvents;
  }

  it("floor gate: shardCount=4, floor=3, percent=50, open 2 → stream breaker STAYS CLOSED", async () => {
    const events = await openNShards(4, 2, {
      circuitOpenShardFloor: 3,
      circuitShardOpenPercent: 50,
    });
    const streamOpen = events.filter((e) => e.type === "stream_circuit_open");
    expect(streamOpen).toHaveLength(0);
  });

  it("quorum reached: shardCount=4, floor=3, percent=50, open 3 → stream breaker OPENS", async () => {
    const events = await openNShards(4, 3, {
      circuitOpenShardFloor: 3,
      circuitShardOpenPercent: 50,
    });
    const streamOpen = events.filter((e) => e.type === "stream_circuit_open");
    expect(streamOpen.length).toBeGreaterThanOrEqual(1);
  });

  it("percent gate: shardCount=4, floor=1, percent=75, open 2 → stream breaker STAYS CLOSED (50% < 75%)", async () => {
    const events = await openNShards(4, 2, {
      circuitOpenShardFloor: 1,
      circuitShardOpenPercent: 75,
    });
    const streamOpen = events.filter((e) => e.type === "stream_circuit_open");
    expect(streamOpen).toHaveLength(0);
  });

  it("small deployment default: shardCount=2, floor=3, percent=50, open both → stream breaker STAYS CLOSED", async () => {
    const events = await openNShards(2, 2, {
      circuitOpenShardFloor: 3,
      circuitShardOpenPercent: 50,
    });
    // Both shards' per-shard breakers opened but stream-level stays closed.
    const shardOpen = events.filter((e) => e.type === "shard_circuit_open");
    expect(shardOpen.length).toBeGreaterThanOrEqual(2);
    const streamOpen = events.filter((e) => e.type === "stream_circuit_open");
    expect(streamOpen).toHaveLength(0);
  });

  it("small deployment opt-in: shardCount=1, floor=1, percent=50, open 1 → stream breaker OPENS", async () => {
    const events = await openNShards(1, 1, {
      circuitOpenShardFloor: 1,
      circuitShardOpenPercent: 50,
    });
    const streamOpen = events.filter((e) => e.type === "stream_circuit_open");
    expect(streamOpen.length).toBeGreaterThanOrEqual(1);
  });
});

// Note: MarketDataModule lifecycle handler tests live in
// apps/runtime/src/__tests__/market-data-circuit-module.test.ts
// (not here, because that module is outside this package's rootDir).

// ─── 5. Stream breaker closes after streamStableMs once quorum falls ─────

describe("stream-level breaker recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stream_circuit_closed emitted after streamStableMs once recovery shard stays stable", async () => {
    const threshold = 3;
    // The initial shard flaps `threshold` times → shard breaker opens → stream breaker opens (floor=1).
    // Then a stable socket is used for the half-open → stable timer → stream_circuit_closed.
    const flapper = makeShardFlapper(threshold);
    const stableSocket = new FakeSocket();
    let socketIdx = 0;
    const factory = () => {
      if (socketIdx < threshold) {
        socketIdx++;
        return flapper.factory();
      }
      return stableSocket;
    };

    const lifecycleEvents: MarketPricingLifecycleEvent[] = [];
    const stream = makeStream(
      factory,
      {
        maxSubscriptionsPerConnection: 50,
        shardBreakerReconnectsPerMin: threshold,
        shardBreakerOpenMs: 100, // shard breaker open window
        shardBreakerOpenMaxMs: 800,
        circuitOpenShardFloor: 1,
        circuitShardOpenPercent: 50,
        circuitOpenMs: 100, // stream-level circuit open window
        streamStableMs: 100,
        reconnectBaseMs: 0,
        reconnectMaxMs: 0,
      },
      lifecycleEvents,
    );

    stream.setTokenIds(["a", "b", "c", "d", "e"]);

    // Advance to let flapping sockets fire their immediate closes.
    await vi.advanceTimersByTimeAsync(50);

    // After threshold closes, shard breaker opens → stream breaker opens (floor=1, 100%≥50%).
    const streamOpenEvents = lifecycleEvents.filter((e) => e.type === "stream_circuit_open");
    expect(streamOpenEvents.length).toBeGreaterThanOrEqual(1);

    // Advance past circuitOpenMs (100ms) so the stream-level half-open probe fires.
    await vi.advanceTimersByTimeAsync(200);

    // The stable socket was created for the probe. Open it.
    stableSocket.emitOpen();

    // Advance past streamStableMs (100ms) so the stable timer fires.
    await vi.advanceTimersByTimeAsync(200);

    const closedEvents = lifecycleEvents.filter((e) => e.type === "stream_circuit_closed");
    expect(closedEvents).toHaveLength(1);

    stream.close();
  });
});

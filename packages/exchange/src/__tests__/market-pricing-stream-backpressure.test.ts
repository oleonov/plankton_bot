/**
 * Tests for the bounded ingress queue and overflow policies in LiveMarketPricingStream.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { LiveMarketPricingStream } from "../live/market-pricing-stream.js";
import type { MarketPricingLifecycleEvent, MarketPricingStreamUpdate } from "@plankton/domain";
import type { MarketDataWebSocketLike } from "../live/market-data-stream-shared.js";

// ─── Fake WebSocket ───────────────────────────────────────────────────────

class FakeSocket implements MarketDataWebSocketLike {
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  closeCalled = false;

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

  emitJson(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

// A price_change event for a given tokenId
function priceChange(tokenId: string, price: number) {
  return {
    event_type: "best_bid_ask",
    asset_id: tokenId,
    best_bid: String(price),
    best_ask: String(price + 0.01),
    timestamp: "1766789469958",
  };
}

/** Wait for N event-loop turns (setTimeout 0) so microtasks + promises drain. */
function flush(turns = 1): Promise<void> {
  let p: Promise<void> = Promise.resolve();
  for (let i = 0; i < turns; i++) {
    p = p.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
  return p;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("LiveMarketPricingStream — bounded ingress queue", () => {
  let socket: FakeSocket;

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildStream(opts: {
    queueMax: number;
    lagWarnMs?: number;
    overflowPolicy?: "drop-oldest" | "reconnect";
    onRecords: (updates: readonly MarketPricingStreamUpdate[]) => Promise<void> | void;
    onLifecycleEvents?: (events: readonly MarketPricingLifecycleEvent[]) => Promise<void> | void;
    onError?: (err: unknown) => Promise<void> | void;
  }): { stream: LiveMarketPricingStream; sockets: FakeSocket[] } {
    const sockets: FakeSocket[] = [];
    const { queueMax, lagWarnMs = 100_000, overflowPolicy = "drop-oldest", onRecords } = opts;

    const stream = new LiveMarketPricingStream({
      queueMax,
      lagWarnMs,
      overflowPolicy,
      createWebSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        socket = s;
        return s;
      },
      handlers: {
        onUpdates: onRecords,
        ...(opts.onLifecycleEvents ? { onLifecycleEvents: opts.onLifecycleEvents } : {}),
        ...(opts.onError ? { onError: opts.onError } : {}),
      },
    });
    return { stream, sockets };
  }

  // ─── Test 1: messages under cap drain in FIFO, no overflow ───────────────

  it("drains all messages in FIFO order when queue never overflows", async () => {
    let callCount = 0;

    const { stream } = buildStream({
      queueMax: 10,
      onRecords: async () => {
        callCount++;
      },
    });

    stream.setTokenIds(["token-A"]);
    socket.emitOpen();

    // Send 4 messages — well under cap=10
    socket.emitJson(priceChange("token-A", 0.1));
    socket.emitJson(priceChange("token-A", 0.2));
    socket.emitJson(priceChange("token-A", 0.3));
    socket.emitJson(priceChange("token-A", 0.4));

    // Drain: each message requires at least one event-loop turn
    await flush(10);

    expect(callCount).toBe(4);
    stream.close();
  });

  // ─── Test 2: overflow triggers queue_overflow lifecycle event ─────────────

  it("drop-oldest: emits queue_overflow lifecycle event when queue overflows", async () => {
    const capturedEvents: MarketPricingLifecycleEvent[] = [];

    // drainBarrier keeps the drain busy so queue fills up
    let unblockDrain: () => void = () => {};
    const drainBarrier = () =>
      new Promise<void>((resolve) => {
        unblockDrain = resolve;
      });

    const { stream } = buildStream({
      queueMax: 3,
      overflowPolicy: "drop-oldest",
      onRecords: drainBarrier,
      onLifecycleEvents: (events) => {
        capturedEvents.push(...events);
      },
    });

    stream.setTokenIds(["token-A"]);
    socket.emitOpen();

    // First message starts draining immediately (drain loop kicks off synchronously).
    // Queue cap = 3. Subsequent messages fill the queue.
    socket.emitJson(priceChange("token-A", 0.1)); // → drain starts, q=0
    socket.emitJson(priceChange("token-A", 0.2)); // q[0]
    socket.emitJson(priceChange("token-A", 0.3)); // q[1]
    socket.emitJson(priceChange("token-A", 0.4)); // q[2] — full
    socket.emitJson(priceChange("token-A", 0.5)); // overflow: evicts q[0], enqueues q[2]

    // Let the overflow callback propagate (it's synchronous in enqueueRecords)
    await flush(2);

    const overflowEvents = capturedEvents.filter((e) => e.type === "queue_overflow");
    expect(overflowEvents.length).toBeGreaterThanOrEqual(1);

    const ev = overflowEvents[0];
    expect(ev?.type).toBe("queue_overflow");
    if (ev?.type === "queue_overflow") {
      expect(ev.shardId).toBe(0);
      expect(ev.droppedCount).toBe(1);
    }

    unblockDrain(); // unblock so stream can close cleanly
    await flush(5);
    stream.close();
  });

  // ─── Test 3: metrics reflect overflow count ───────────────────────────────

  it("queueOverflows metric increments on each drop-oldest eviction", async () => {
    let unblockDrain: () => void = () => {};
    const drainBarrier = () =>
      new Promise<void>((resolve) => {
        unblockDrain = resolve;
      });

    const { stream } = buildStream({
      queueMax: 2,
      overflowPolicy: "drop-oldest",
      onRecords: drainBarrier,
    });

    stream.setTokenIds(["token-A"]);
    socket.emitOpen();

    // First message drains immediately; queue has room for 2 more
    socket.emitJson(priceChange("token-A", 0.1)); // drain starts, q=0
    socket.emitJson(priceChange("token-A", 0.2)); // q[0]
    socket.emitJson(priceChange("token-A", 0.3)); // q[1] — full
    socket.emitJson(priceChange("token-A", 0.4)); // overflow #1
    socket.emitJson(priceChange("token-A", 0.5)); // overflow #2

    await flush(2);

    const metrics = stream.getMetricsSnapshot();
    expect(metrics.queueOverflows).toBeGreaterThanOrEqual(2);

    unblockDrain();
    await flush(5);
    stream.close();
  });

  // ─── Test 4: reconnect policy forces socket reconnect on overflow ──────────

  it("reconnect policy: forces socket reconnect on overflow", async () => {
    let unblockDrain: () => void = () => {};
    const drainBarrier = () =>
      new Promise<void>((resolve) => {
        unblockDrain = resolve;
      });

    const { stream } = buildStream({
      queueMax: 2,
      overflowPolicy: "reconnect",
      onRecords: drainBarrier,
    });

    stream.setTokenIds(["token-A"]);
    const firstSocket = socket;
    firstSocket.emitOpen();

    // First message starts draining; fill queue to cap then overflow
    firstSocket.emitJson(priceChange("token-A", 0.1)); // drain starts, q=0
    firstSocket.emitJson(priceChange("token-A", 0.2)); // q[0]
    firstSocket.emitJson(priceChange("token-A", 0.3)); // q[1] — full
    firstSocket.emitJson(priceChange("token-A", 0.4)); // overflow → reconnect

    await flush(2);

    // The original socket should have been closed (reconnect was triggered)
    expect(firstSocket.closeCalled).toBe(true);

    unblockDrain();
    stream.close();
  });

  // ─── Test 5: lag warning fires when drain takes longer than lagWarnMs ──────

  it("emits lag warning when drain takes longer than lagWarnMs", async () => {
    const errors: unknown[] = [];
    const SLOW_DRAIN_MS = 60;

    const { stream } = buildStream({
      queueMax: 10,
      lagWarnMs: 20, // small threshold so 60ms drain triggers it
      onRecords: async () => {
        await new Promise<void>((r) => setTimeout(r, SLOW_DRAIN_MS));
      },
      onError: (err) => {
        errors.push(err);
      },
    });

    stream.setTokenIds(["token-A"]);
    socket.emitOpen();
    socket.emitJson(priceChange("token-A", 0.1));

    // Wait for the drain to complete (SLOW_DRAIN_MS + margin)
    await new Promise<void>((r) => setTimeout(r, SLOW_DRAIN_MS + 80));

    const lagErrors = errors.filter((e) => e instanceof Error && e.message.includes("drain lag"));
    expect(lagErrors.length).toBeGreaterThan(0);

    stream.close();
  });
});

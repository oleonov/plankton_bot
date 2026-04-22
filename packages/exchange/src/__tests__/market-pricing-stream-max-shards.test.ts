/**
 * Regression tests: the per-shard subscription ceiling is derived at the
 * gateway wiring level as `min(500, ceil(maxTokens / maxShards))`. The stream
 * itself treats `maxSubscriptionsPerConnection` as the authoritative chunk
 * size and enforces the hard 500/shard ceiling (Polymarket's per-socket
 * limit) so a misconfigured env cannot put "5k tokens on one socket".
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { LiveMarketPricingStream } from "../live/market-pricing-stream.js";
import { deriveMaxSubscriptionsPerConnection } from "../live/market-data-gateway.js";
import type { MarketDataWebSocketLike } from "../live/market-data-stream-shared.js";

class FakeSocket implements MarketDataWebSocketLike {
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.({});
  }
  emitOpen(): void {
    this.onopen?.({});
  }
}

afterEach(() => {
  vi.useRealTimers();
});

function buildStreamWithChunk(chunkSize: number): {
  stream: LiveMarketPricingStream;
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  const stream = new LiveMarketPricingStream({
    createWebSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    handlers: {
      onUpdates: async () => {},
      onError: async () => {},
    },
    maxSubscriptionsPerConnection: chunkSize,
    queueMax: 256,
    lagWarnMs: 2_000,
  });
  return { stream, sockets };
}

describe("deriveMaxSubscriptionsPerConnection — gateway wiring semantic", () => {
  it("returns ceil(maxTokens / maxShards) when below the 500 ceiling", () => {
    expect(deriveMaxSubscriptionsPerConnection(1000, 2)).toBe(500);
    expect(deriveMaxSubscriptionsPerConnection(800, 2)).toBe(400);
    expect(deriveMaxSubscriptionsPerConnection(250, 5)).toBe(50);
  });

  it("clamps DOWN to the 500 hard ceiling — misconfig cannot put 5k on one socket", () => {
    expect(deriveMaxSubscriptionsPerConnection(5000, 1)).toBe(500);
    expect(deriveMaxSubscriptionsPerConnection(1500, 2)).toBe(500);
    expect(deriveMaxSubscriptionsPerConnection(10_000, 2)).toBe(500);
  });

  it("returns undefined when either knob is missing or non-positive (stream falls back to default)", () => {
    expect(deriveMaxSubscriptionsPerConnection(undefined, 2)).toBeUndefined();
    expect(deriveMaxSubscriptionsPerConnection(1000, undefined)).toBeUndefined();
    expect(deriveMaxSubscriptionsPerConnection(0, 2)).toBeUndefined();
    expect(deriveMaxSubscriptionsPerConnection(1000, 0)).toBeUndefined();
  });
});

describe("LiveMarketPricingStream — hard 500/shard ceiling", () => {
  it("clamps oversize maxSubscriptionsPerConnection down to 500 — defensive guard inside the stream", () => {
    const { stream, sockets } = buildStreamWithChunk(5000);
    const tokens = Array.from({ length: 1500 }, (_, i) => `t${i}`);
    stream.setTokenIds(tokens);
    // Even though deps asked for 5000/shard, stream clamps to 500 → ceil(1500/500) = 3 shards.
    expect(sockets).toHaveLength(3);
    stream.close();
  });

  it("shards tokens at the configured chunk size when it is under the ceiling", () => {
    const { stream, sockets } = buildStreamWithChunk(400);
    const tokens = Array.from({ length: 800 }, (_, i) => `t${i}`);
    stream.setTokenIds(tokens);
    // 800 / 400 = 2 shards.
    expect(sockets).toHaveLength(2);
    stream.close();
  });

  it("zero tokens → no shards", () => {
    const { stream, sockets } = buildStreamWithChunk(500);
    stream.setTokenIds([]);
    expect(sockets).toHaveLength(0);
    stream.close();
  });
});

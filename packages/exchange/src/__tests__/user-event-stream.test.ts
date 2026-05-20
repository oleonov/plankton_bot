import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveUserEventStream } from "../live/user-event-stream.js";

class FakeUserSocket {
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.({});
  }

  emitOpen(): void {
    this.onopen?.({});
  }

  emitJson(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  emitRaw(data: unknown): void {
    this.onmessage?.({ data });
  }
}

async function flushAsyncHandlers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("LiveUserEventStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends auth payload on open", () => {
    const sockets: FakeUserSocket[] = [];
    const stream = new LiveUserEventStream({
      auth: { apiKey: "key", secret: "secret", passphrase: "pass" },
      traderAddress: "0xours",
      createWebSocket: () => {
        const socket = new FakeUserSocket();
        sockets.push(socket);
        return socket;
      },
      handlers: {
        onTradeEvents: vi.fn(),
        onOrderEvents: vi.fn(),
      },
    });
    stream.setConditionIds(["cond-1"]);

    expect(sockets).toHaveLength(1);
    sockets[0]!.emitOpen();

    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      auth: { apiKey: "key", secret: "secret", passphrase: "pass" },
      initial_dump: true,
      markets: ["cond-1"],
      operation: "subscribe",
      type: "user",
    });
    expect(sockets[0]!.sent).toHaveLength(1);
  });

  it("routes trade and order events to handlers", async () => {
    const sockets: FakeUserSocket[] = [];
    const onTradeEvents = vi.fn();
    const onOrderEvents = vi.fn();

    const stream = new LiveUserEventStream({
      auth: { apiKey: "key", secret: "secret", passphrase: "pass" },
      traderAddress: "0xours",
      createWebSocket: () => {
        const socket = new FakeUserSocket();
        sockets.push(socket);
        return socket;
      },
      handlers: {
        onTradeEvents,
        onOrderEvents,
      },
    });
    stream.setConditionIds(["cond-1"]);

    sockets[0]!.emitOpen();
    sockets[0]!.emitJson({
      event_type: "trade",
      id: "trade-1",
      taker_order_id: "ord-1",
      asset_id: "tok-1",
      side: "BUY",
      size: "10",
      price: "0.57",
      fee_rate_bps: "0",
      status: "MATCHED",
      timestamp: "1672290701",
      maker_address: "0xours",
      trader_side: "TAKER",
    });
    sockets[0]!.emitJson({
      event_type: "order",
      id: "ord-1",
      client_order_id: "cloid-1",
      asset_id: "tok-1",
      side: "SELL",
      original_size: "10",
      size_matched: "4",
      type: "UPDATE",
      status: "LIVE",
      timestamp: "1672290687",
    });

    await flushAsyncHandlers();

    expect(onTradeEvents).toHaveBeenCalledTimes(1);
    expect(onOrderEvents).toHaveBeenCalledTimes(1);
  });

  it("sends heartbeat and detects missing pong", async () => {
    const sockets: FakeUserSocket[] = [];
    const onGapDetected = vi.fn();
    const onError = vi.fn();

    const stream = new LiveUserEventStream({
      auth: { apiKey: "key", secret: "secret", passphrase: "pass" },
      traderAddress: "0xours",
      createWebSocket: () => {
        const socket = new FakeUserSocket();
        sockets.push(socket);
        return socket;
      },
      handlers: {
        onTradeEvents: vi.fn(),
        onOrderEvents: vi.fn(),
        onGapDetected,
        onError,
      },
    });
    stream.setConditionIds(["cond-1"]);

    sockets[0]!.emitOpen();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets[0]!.sent.at(-1)).toBe("PING");

    await vi.advanceTimersByTimeAsync(15_001);
    expect(onGapDetected).toHaveBeenCalledWith(expect.objectContaining({ reason: "pong-timeout" }));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "USER_WS_PONG_TIMEOUT", conditionCount: 1 }),
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts PONG heartbeat responses", async () => {
    const sockets: FakeUserSocket[] = [];
    const onGapDetected = vi.fn();
    const onError = vi.fn();

    const stream = new LiveUserEventStream({
      auth: { apiKey: "key", secret: "secret", passphrase: "pass" },
      traderAddress: "0xours",
      createWebSocket: () => {
        const socket = new FakeUserSocket();
        sockets.push(socket);
        return socket;
      },
      handlers: {
        onTradeEvents: vi.fn(),
        onOrderEvents: vi.fn(),
        onGapDetected,
        onError,
      },
    });
    stream.setConditionIds(["cond-1"]);

    sockets[0]!.emitOpen();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets[0]!.sent.at(-1)).toBe("PING");
    sockets[0]!.emitRaw("PONG");
    await vi.advanceTimersByTimeAsync(15_001);

    expect(onGapDetected).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });

  it("treats malformed payloads as gaps without crashing the stream", async () => {
    const sockets: FakeUserSocket[] = [];
    const onGapDetected = vi.fn();
    const onError = vi.fn();
    const onTradeEvents = vi.fn();

    const stream = new LiveUserEventStream({
      auth: { apiKey: "key", secret: "secret", passphrase: "pass" },
      traderAddress: "0xours",
      createWebSocket: () => {
        const socket = new FakeUserSocket();
        sockets.push(socket);
        return socket;
      },
      handlers: {
        onTradeEvents,
        onOrderEvents: vi.fn(),
        onGapDetected,
        onError,
      },
    });
    stream.setConditionIds(["cond-1"]);

    sockets[0]!.emitOpen();
    sockets[0]!.emitRaw("{not-json");
    await flushAsyncHandlers();

    expect(onGapDetected).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "protocol-error" }),
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onTradeEvents).not.toHaveBeenCalled();

    sockets[0]!.emitJson({
      event_type: "trade",
      id: "trade-1",
      taker_order_id: "ord-1",
      asset_id: "tok-1",
      side: "BUY",
      size: "10",
      price: "0.57",
      fee_rate_bps: "0",
      status: "MATCHED",
      timestamp: "1672290701",
      maker_address: "0xours",
      trader_side: "TAKER",
    });
    await flushAsyncHandlers();

    expect(onTradeEvents).toHaveBeenCalledTimes(1);
  });

  it("updates subscribed markets without reconnecting", () => {
    const sockets: FakeUserSocket[] = [];
    const stream = new LiveUserEventStream({
      auth: { apiKey: "key", secret: "secret", passphrase: "pass" },
      traderAddress: "0xours",
      createWebSocket: () => {
        const socket = new FakeUserSocket();
        sockets.push(socket);
        return socket;
      },
      handlers: {
        onTradeEvents: vi.fn(),
        onOrderEvents: vi.fn(),
      },
    });

    stream.setConditionIds(["cond-1", "cond-2"]);
    sockets[0]!.emitOpen();
    expect(sockets).toHaveLength(1);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      auth: { apiKey: "key", secret: "secret", passphrase: "pass" },
      initial_dump: true,
      markets: ["cond-1", "cond-2"],
      operation: "subscribe",
      type: "user",
    });

    stream.setConditionIds(["cond-2", "cond-3"]);
    expect(sockets).toHaveLength(1);
    expect(JSON.parse(sockets[0]!.sent[1]!)).toEqual({
      auth: { apiKey: "key", secret: "secret", passphrase: "pass" },
      type: "user",
      operation: "unsubscribe",
      markets: ["cond-1"],
    });
    expect(JSON.parse(sockets[0]!.sent[2]!)).toEqual({
      auth: { apiKey: "key", secret: "secret", passphrase: "pass" },
      type: "user",
      operation: "subscribe",
      markets: ["cond-3"],
    });
  });
});

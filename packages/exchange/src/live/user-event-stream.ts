import type {
  ExchangeUserEventStream,
  ExchangeUserOrderEvent,
  ExchangeUserTradeEvent,
} from "@plankton/domain";
import { mapUserOrderEvent, mapUserTradeEvent } from "./user-event-mappers.js";

const USER_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 2_000;

export interface UserEventStreamAuth {
  readonly apiKey: string;
  readonly secret: string;
  readonly passphrase: string;
}

export interface UserEventWebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

function defaultWebSocketFactory(url: string): UserEventWebSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => UserEventWebSocketLike })
    .WebSocket;
  if (!ctor) {
    throw new Error("WebSocket is not available in the current runtime");
  }
  return new ctor(url);
}

function normalizeWebSocketPayload(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return null;
}

export class LiveUserEventStream implements ExchangeUserEventStream {
  private readonly intentionallyClosedSockets = new WeakSet<UserEventWebSocketLike>();
  private socket: UserEventWebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly deps: Readonly<{
      auth: UserEventStreamAuth;
      traderAddress: string | null;
      createWebSocket?: ((url: string) => UserEventWebSocketLike) | undefined;
      handlers: Readonly<{
        onTradeEvents: (events: readonly ExchangeUserTradeEvent[]) => Promise<void> | void;
        onOrderEvents: (events: readonly ExchangeUserOrderEvent[]) => Promise<void> | void;
        onGapDetected?: (
          info: Readonly<{ reason: string; timestamp: number }>,
        ) => Promise<void> | void;
        onError?: (error: unknown) => Promise<void> | void;
      }>;
    }>,
  ) {
    this.connect();
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    this.closeSocket({ intentional: true });
  }

  private connect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      const socket = (this.deps.createWebSocket ?? defaultWebSocketFactory)(USER_WS_URL);
      this.socket = socket;

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            auth: this.deps.auth,
            type: "user",
          }),
        );
        this.startHeartbeat(socket);
      };

      socket.onmessage = (event) => {
        void this.handleMessage(socket, event.data);
      };

      socket.onerror = (event) => {
        if (this.shouldIgnoreSocketError(socket)) return;
        void this.deps.handlers.onError?.(event);
      };

      socket.onclose = () => {
        const ignoreEvent = this.shouldIgnoreSocketClose(socket);
        if (this.socket === socket) {
          this.socket = null;
        }
        if (ignoreEvent || this.closed) return;
        this.clearHeartbeat(socket);
        void this.deps.handlers.onGapDetected?.({
          reason: "socket-close",
          timestamp: Date.now(),
        });
        this.scheduleReconnect();
      };
    } catch (error) {
      void this.deps.handlers.onError?.(error);
      this.scheduleReconnect();
    }
  }

  private startHeartbeat(socket: UserEventWebSocketLike): void {
    this.clearHeartbeat(socket);
    this.pingTimer = setInterval(() => {
      if (this.closed || this.socket !== socket) return;
      if (this.pongTimer) return;
      socket.send(JSON.stringify({}));
      this.pongTimer = setTimeout(() => {
        if (this.closed || this.socket !== socket) return;
        void this.deps.handlers.onGapDetected?.({
          reason: "pong-timeout",
          timestamp: Date.now(),
        });
        this.reconnect();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private clearHeartbeat(socket: UserEventWebSocketLike): void {
    if (this.socket !== socket && this.socket != null) return;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private reconnect(): void {
    if (this.closed) return;
    this.clearTimers();
    this.closeSocket({ intentional: true });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private shouldIgnoreSocketError(socket: UserEventWebSocketLike): boolean {
    if (this.intentionallyClosedSockets.has(socket)) return true;
    return this.socket !== socket && this.socket != null;
  }

  private shouldIgnoreSocketClose(socket: UserEventWebSocketLike): boolean {
    if (this.intentionallyClosedSockets.has(socket)) {
      this.intentionallyClosedSockets.delete(socket);
      return true;
    }
    return this.socket !== socket && this.socket != null;
  }

  private closeSocket(opts?: { intentional?: boolean }): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && opts?.intentional) {
      this.intentionallyClosedSockets.add(socket);
    }
    socket?.close();
  }

  private async handleMessage(socket: UserEventWebSocketLike, data: unknown): Promise<void> {
    try {
      if (this.socket !== socket) return;
      const text = normalizeWebSocketPayload(data);
      if (!text) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch (error) {
        await this.deps.handlers.onGapDetected?.({
          reason: "invalid-payload",
          timestamp: Date.now(),
        });
        await this.deps.handlers.onError?.(error);
        return;
      }

      if (this.isPongPayload(parsed)) {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
        return;
      }

      const records = Array.isArray(parsed) ? parsed : [parsed];
      const tradeEvents: ExchangeUserTradeEvent[] = [];
      const orderEvents: ExchangeUserOrderEvent[] = [];

      for (const record of records) {
        if (!record || typeof record !== "object") continue;
        const raw = record as Record<string, unknown>;
        const eventType = String(raw.event_type ?? "").toLowerCase();
        if (eventType === "trade") {
          const tradeEvent = mapUserTradeEvent(raw, this.deps.traderAddress);
          if (tradeEvent) tradeEvents.push(tradeEvent);
          continue;
        }
        if (eventType === "order") {
          const orderEvent = mapUserOrderEvent(raw);
          if (orderEvent) orderEvents.push(orderEvent);
        }
      }

      if (tradeEvents.length > 0) {
        await this.deps.handlers.onTradeEvents(tradeEvents);
      }
      if (orderEvents.length > 0) {
        await this.deps.handlers.onOrderEvents(orderEvents);
      }
    } catch (error) {
      await this.deps.handlers.onError?.(error);
    }
  }

  private isPongPayload(payload: unknown): boolean {
    return (
      payload != null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      Object.keys(payload as Record<string, unknown>).length === 0
    );
  }
}

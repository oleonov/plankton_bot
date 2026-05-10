import type {
  ExchangeUserEventStream,
  ExchangeUserOrderEvent,
  ExchangeUserTradeEvent,
} from "@krabs/domain";
import { mapUserOrderEvent, mapUserTradeEvent } from "./user-event-mappers.js";

const USER_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 2_000;
const HEARTBEAT_PING = "PING";
const HEARTBEAT_PONG = "PONG";

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

function normalizeConditionIds(conditionIds: readonly string[]): string[] {
  return [
    ...new Set(conditionIds.map((value) => value.trim()).filter((value) => value.length > 0)),
  ].sort();
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function buildUserSubscriptionPayload(input: {
  auth: UserEventStreamAuth;
  conditionIds: readonly string[];
  operation: "subscribe" | "unsubscribe";
  initialDump?: boolean;
}): string {
  return JSON.stringify({
    auth: input.auth,
    type: "user",
    operation: input.operation,
    markets: input.conditionIds,
    ...(input.initialDump === undefined ? {} : { initial_dump: input.initialDump }),
  });
}

export class LiveUserEventStream implements ExchangeUserEventStream {
  private readonly intentionallyClosedSockets = new WeakSet<UserEventWebSocketLike>();
  private socket: UserEventWebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private socketOpen = false;
  private desiredConditionIds: string[] = [];
  private subscribedConditionIds: string[] = [];

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
  ) {}

  setConditionIds(conditionIds: readonly string[]): void {
    const next = normalizeConditionIds(conditionIds);
    if (arraysEqual(this.desiredConditionIds, next)) return;
    this.desiredConditionIds = next;

    if (this.closed) return;
    if (this.desiredConditionIds.length === 0) {
      this.subscribedConditionIds = [];
      this.clearTimers();
      this.closeSocket({ intentional: true });
      return;
    }

    if (!this.socket) {
      this.connect();
      return;
    }

    if (this.socketOpen) {
      this.syncSubscription(this.socket);
    }
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    this.closeSocket({ intentional: true });
  }

  private connect(): void {
    if (this.closed) return;
    if (this.desiredConditionIds.length === 0) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      const socket = (this.deps.createWebSocket ?? defaultWebSocketFactory)(USER_WS_URL);
      this.socket = socket;
      this.socketOpen = false;
      this.subscribedConditionIds = [];

      socket.onopen = () => {
        if (this.socket !== socket || this.closed) return;
        this.socketOpen = true;
        socket.send(
          buildUserSubscriptionPayload({
            auth: this.deps.auth,
            conditionIds: this.desiredConditionIds,
            operation: "subscribe",
            initialDump: true,
          }),
        );
        this.subscribedConditionIds = [...this.desiredConditionIds];
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
          this.socketOpen = false;
        }
        if (ignoreEvent || this.closed) return;
        this.clearHeartbeat(socket);
        this.subscribedConditionIds = [];
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
      socket.send(HEARTBEAT_PING);
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
    this.subscribedConditionIds = [];
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
    this.socketOpen = false;
    if (socket && opts?.intentional) {
      this.intentionallyClosedSockets.add(socket);
    }
    socket?.close();
  }

  private syncSubscription(socket: UserEventWebSocketLike): void {
    if (this.socket !== socket || !this.socketOpen || this.closed) return;
    const next = this.desiredConditionIds;
    const prev = this.subscribedConditionIds;

    const toUnsubscribe = prev.filter((conditionId) => !next.includes(conditionId));
    if (toUnsubscribe.length > 0) {
      socket.send(
        buildUserSubscriptionPayload({
          auth: this.deps.auth,
          conditionIds: toUnsubscribe,
          operation: "unsubscribe",
        }),
      );
    }

    const toSubscribe = next.filter((conditionId) => !prev.includes(conditionId));
    if (toSubscribe.length > 0) {
      socket.send(
        buildUserSubscriptionPayload({
          auth: this.deps.auth,
          conditionIds: toSubscribe,
          operation: "subscribe",
        }),
      );
    }

    this.subscribedConditionIds = [...next];
  }

  private async handleMessage(socket: UserEventWebSocketLike, data: unknown): Promise<void> {
    try {
      if (this.socket !== socket) return;
      const text = normalizeWebSocketPayload(data);
      if (!text) return;
      const trimmed = text.trim();
      if (this.isPongPayload(trimmed)) {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch (error) {
        await this.deps.handlers.onGapDetected?.({
          reason: "protocol-error",
          timestamp: Date.now(),
        });
        await this.deps.handlers.onError?.(
          new Error(`unexpected user websocket payload: ${trimmed}`, {
            cause: error,
          }),
        );
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
    if (typeof payload === "string") {
      return payload.trim().toUpperCase() === HEARTBEAT_PONG;
    }
    return (
      payload != null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      Object.keys(payload as Record<string, unknown>).length === 0
    );
  }
}

import type {
  ExchangeUserEventStream,
  ExchangeUserOrderEvent,
  ExchangeUserTradeEvent,
} from "@krabs/domain";
import { Worker } from "node:worker_threads";
import type {
  SerializedUserWorkerError,
  UserEventWorkerCommand,
  UserEventWorkerData,
  UserEventWorkerEvent,
} from "./user-event-worker-protocol.js";
import { mapUserOrderEvent, mapUserTradeEvent } from "./user-event-mappers.js";
import {
  arraysEqual,
  buildUserSubscriptionPayload,
  defaultUserEventWebSocketFactory,
  isUserPongPayload,
  normalizeConditionIds,
  normalizeUserWebSocketPayload,
  USER_HEARTBEAT_PING,
  USER_PING_INTERVAL_MS,
  USER_PONG_TIMEOUT_MS,
  USER_RECONNECT_DELAY_MS,
  USER_WS_URL,
  type UserEventStreamAuth,
  type UserEventWebSocketLike,
} from "./user-event-ws-protocol.js";

export type { UserEventStreamAuth, UserEventWebSocketLike } from "./user-event-ws-protocol.js";

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
      useWorker?: boolean | undefined;
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
    const useWorker = deps.useWorker ?? deps.createWebSocket === undefined;
    this.workerBridge = useWorker ? new UserEventWorkerBridge(deps) : null;
  }

  private readonly workerBridge: UserEventWorkerBridge | null;

  setConditionIds(conditionIds: readonly string[]): void {
    if (this.workerBridge) {
      this.workerBridge.setConditionIds(conditionIds);
      return;
    }
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
    if (this.workerBridge) {
      this.workerBridge.close();
      return;
    }
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
      const socket = (this.deps.createWebSocket ?? defaultUserEventWebSocketFactory)(USER_WS_URL);
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

      socket.onclose = (event) => {
        const ignoreEvent = this.shouldIgnoreSocketClose(socket);
        if (this.socket === socket) {
          this.socket = null;
          this.socketOpen = false;
        }
        if (ignoreEvent || this.closed) return;
        this.clearHeartbeat(socket);
        this.subscribedConditionIds = [];
        void this.deps.handlers.onError?.(
          Object.assign(new Error("user websocket closed"), {
            code: "USER_WS_SOCKET_CLOSED",
            closeCode: event.code,
            closeReason: event.reason,
            conditionCount: this.desiredConditionIds.length,
          }),
        );
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
      socket.send(USER_HEARTBEAT_PING);
      this.pongTimer = setTimeout(() => {
        if (this.closed || this.socket !== socket) return;
        void this.deps.handlers.onError?.(
          Object.assign(new Error("user websocket pong timeout"), {
            code: "USER_WS_PONG_TIMEOUT",
            conditionCount: this.desiredConditionIds.length,
          }),
        );
        void this.deps.handlers.onGapDetected?.({
          reason: "pong-timeout",
          timestamp: Date.now(),
        });
        this.reconnect();
      }, USER_PONG_TIMEOUT_MS);
    }, USER_PING_INTERVAL_MS);
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
    }, USER_RECONNECT_DELAY_MS);
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
      const text = normalizeUserWebSocketPayload(data);
      if (!text) return;
      const trimmed = text.trim();
      if (isUserPongPayload(trimmed)) {
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

      if (isUserPongPayload(parsed)) {
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
}

class UserEventWorkerBridge implements ExchangeUserEventStream {
  private readonly worker: Worker;
  private closed = false;

  constructor(
    private readonly deps: Readonly<{
      auth: UserEventStreamAuth;
      traderAddress: string | null;
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
    const workerData: UserEventWorkerData = {
      auth: deps.auth,
      traderAddress: deps.traderAddress,
    };
    this.worker = new Worker(new URL("./user-event-worker.js", import.meta.url), { workerData });
    this.worker.on("message", (message: unknown) => this.handleWorkerMessage(message));
    this.worker.on("error", (error) => {
      void this.deps.handlers.onError?.(error);
      void this.deps.handlers.onGapDetected?.({ reason: "worker-error", timestamp: Date.now() });
    });
    this.worker.on("exit", (code) => {
      if (this.closed || code === 0) return;
      void this.deps.handlers.onError?.(
        Object.assign(new Error(`user-event worker exited with code ${code}`), {
          code: "USER_WS_WORKER_EXITED",
        }),
      );
      void this.deps.handlers.onGapDetected?.({ reason: "worker-exit", timestamp: Date.now() });
    });
  }

  setConditionIds(conditionIds: readonly string[]): void {
    this.worker.postMessage({ type: "set-condition-ids", conditionIds });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const command: UserEventWorkerCommand = { type: "close" };
    this.worker.postMessage(command);
    void this.worker.terminate();
  }

  private handleWorkerMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const event = message as UserEventWorkerEvent;
    switch (event.type) {
      case "trade-events":
        void this.deps.handlers.onTradeEvents(event.events);
        break;
      case "order-events":
        void this.deps.handlers.onOrderEvents(event.events);
        break;
      case "gap":
        void this.deps.handlers.onGapDetected?.({
          reason: event.reason,
          timestamp: event.timestamp,
        });
        break;
      case "error":
        void this.deps.handlers.onError?.(deserializeUserWorkerError(event.error));
        break;
      case "heartbeat":
        break;
    }
  }
}

function deserializeUserWorkerError(error: SerializedUserWorkerError): Error {
  const result = Object.assign(new Error(error.message), {
    code: error.code,
    conditionCount: error.conditionCount,
    closeCode: error.closeCode,
    closeReason: error.closeReason,
  });
  result.name = error.name ?? "Error";
  if (error.stack) result.stack = error.stack;
  return result;
}

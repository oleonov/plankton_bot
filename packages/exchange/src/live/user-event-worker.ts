import { parentPort, workerData } from "node:worker_threads";
import type { ExchangeUserOrderEvent, ExchangeUserTradeEvent } from "@krabs/domain";
import { mapUserOrderEvent, mapUserTradeEvent } from "./user-event-mappers.js";
import type {
  SerializedUserWorkerError,
  UserEventWorkerCommand,
  UserEventWorkerData,
  UserEventWorkerEvent,
  UserWorkerHeartbeatSnapshot,
} from "./user-event-worker-protocol.js";
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
  type UserEventWebSocketLike,
} from "./user-event-ws-protocol.js";

const EVENT_LOOP_SAMPLE_MS = 1_000;

if (!parentPort) {
  throw new Error("user-event-worker requires parentPort");
}

class UserEventWorkerRuntime {
  private readonly intentionallyClosedSockets = new WeakSet<UserEventWebSocketLike>();
  private socket: UserEventWebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private eventLoopTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private socketOpen = false;
  private desiredConditionIds: string[] = [];
  private subscribedConditionIds: string[] = [];
  private expectedEventLoopTickAt = Date.now() + EVENT_LOOP_SAMPLE_MS;
  private workerEventLoopLagMaxMs = 0;
  private heartbeat: UserWorkerHeartbeatSnapshot = {
    pingSent: 0,
    pongReceived: 0,
    timeoutFired: 0,
    timeoutSuppressedByInbound: 0,
    lastPingSentAt: null,
    lastPongAt: null,
    lastInboundMessageAt: null,
    workerEventLoopLagMaxMs: 0,
  };

  constructor(private readonly cfg: UserEventWorkerData) {
    this.startEventLoopSampler();
  }

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
    if (this.socketOpen) this.syncSubscription(this.socket);
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    if (this.eventLoopTimer) {
      clearInterval(this.eventLoopTimer);
      this.eventLoopTimer = null;
    }
    this.closeSocket({ intentional: true });
  }

  private connect(): void {
    if (this.closed || this.desiredConditionIds.length === 0) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      const socket = defaultUserEventWebSocketFactory(USER_WS_URL);
      this.socket = socket;
      this.socketOpen = false;
      this.subscribedConditionIds = [];
      socket.onopen = () => {
        if (this.socket !== socket || this.closed) return;
        this.socketOpen = true;
        socket.send(
          buildUserSubscriptionPayload({
            auth: this.cfg.auth,
            conditionIds: this.desiredConditionIds,
            operation: "subscribe",
            initialDump: true,
          }),
        );
        this.subscribedConditionIds = [...this.desiredConditionIds];
        this.startHeartbeat(socket);
      };
      socket.onmessage = (event) => {
        this.handleMessage(socket, event.data);
      };
      socket.onerror = (event) => {
        if (this.shouldIgnoreSocketError(socket)) return;
        this.postError(serializeUnknownError(event));
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
        const closeError: SerializedUserWorkerError = {
          message: "user websocket closed",
          code: "USER_WS_SOCKET_CLOSED",
          conditionCount: this.desiredConditionIds.length,
        };
        this.postError({
          ...closeError,
          ...(event.code !== undefined ? { closeCode: event.code } : {}),
          ...(event.reason !== undefined ? { closeReason: event.reason } : {}),
        });
        this.postGap("socket-close");
        this.scheduleReconnect();
      };
    } catch (error) {
      this.postError(serializeUnknownError(error));
      this.scheduleReconnect();
    }
  }

  private startHeartbeat(socket: UserEventWebSocketLike): void {
    this.clearHeartbeat(socket);
    this.pingTimer = setInterval(() => {
      if (this.closed || this.socket !== socket) return;
      if (this.pongTimer) return;
      const sentAt = Date.now();
      socket.send(USER_HEARTBEAT_PING);
      this.heartbeat = {
        ...this.heartbeat,
        pingSent: this.heartbeat.pingSent + 1,
        lastPingSentAt: sentAt,
      };
      this.postHeartbeat();
      this.pongTimer = setTimeout(
        () => {
          if (this.closed || this.socket !== socket) return;
          const lastInbound = this.heartbeat.lastInboundMessageAt ?? 0;
          if (lastInbound >= sentAt) {
            this.heartbeat = {
              ...this.heartbeat,
              timeoutSuppressedByInbound: this.heartbeat.timeoutSuppressedByInbound + 1,
            };
            this.clearPongTimer(null);
            return;
          }
          this.heartbeat = {
            ...this.heartbeat,
            timeoutFired: this.heartbeat.timeoutFired + 1,
          };
          this.postHeartbeat();
          this.postError({
            message: "user websocket pong timeout",
            code: "USER_WS_PONG_TIMEOUT",
            conditionCount: this.desiredConditionIds.length,
          });
          this.postGap("pong-timeout");
          this.reconnect();
        },
        Math.max(USER_PONG_TIMEOUT_MS * 2, USER_PONG_TIMEOUT_MS + this.workerEventLoopLagMaxMs),
      );
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

  private clearPongTimer(pongAt: number | null): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    if (pongAt != null) {
      this.heartbeat = {
        ...this.heartbeat,
        pongReceived: this.heartbeat.pongReceived + 1,
        lastPongAt: pongAt,
      };
    }
    this.postHeartbeat();
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

  private syncSubscription(socket: UserEventWebSocketLike): void {
    if (this.socket !== socket || !this.socketOpen || this.closed) return;
    const next = this.desiredConditionIds;
    const prev = this.subscribedConditionIds;
    const toUnsubscribe = prev.filter((conditionId) => !next.includes(conditionId));
    if (toUnsubscribe.length > 0) {
      socket.send(
        buildUserSubscriptionPayload({
          auth: this.cfg.auth,
          conditionIds: toUnsubscribe,
          operation: "unsubscribe",
        }),
      );
    }
    const toSubscribe = next.filter((conditionId) => !prev.includes(conditionId));
    if (toSubscribe.length > 0) {
      socket.send(
        buildUserSubscriptionPayload({
          auth: this.cfg.auth,
          conditionIds: toSubscribe,
          operation: "subscribe",
        }),
      );
    }
    this.subscribedConditionIds = [...next];
  }

  private handleMessage(socket: UserEventWebSocketLike, data: unknown): void {
    try {
      if (this.socket !== socket) return;
      const nowMs = Date.now();
      this.heartbeat = { ...this.heartbeat, lastInboundMessageAt: nowMs };
      const text = normalizeUserWebSocketPayload(data);
      if (!text) return;
      const trimmed = text.trim();
      if (isUserPongPayload(trimmed)) {
        this.clearPongTimer(nowMs);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch (error) {
        this.postGap("protocol-error");
        this.postError({
          message: `unexpected user websocket payload: ${trimmed}`,
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        });
        return;
      }
      if (isUserPongPayload(parsed)) {
        this.clearPongTimer(nowMs);
        return;
      }
      this.postParsedRecords(Array.isArray(parsed) ? parsed : [parsed]);
    } catch (error) {
      this.postError(serializeUnknownError(error));
    }
  }

  private postParsedRecords(records: readonly unknown[]): void {
    const tradeEvents: ExchangeUserTradeEvent[] = [];
    const orderEvents: ExchangeUserOrderEvent[] = [];
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const raw = record as Record<string, unknown>;
      const eventType = String(raw.event_type ?? "").toLowerCase();
      if (eventType === "trade") {
        const tradeEvent = mapUserTradeEvent(raw, this.cfg.traderAddress);
        if (tradeEvent) tradeEvents.push(tradeEvent);
        continue;
      }
      if (eventType === "order") {
        const orderEvent = mapUserOrderEvent(raw);
        if (orderEvent) orderEvents.push(orderEvent);
      }
    }
    if (tradeEvents.length > 0) this.post({ type: "trade-events", events: tradeEvents });
    if (orderEvents.length > 0) this.post({ type: "order-events", events: orderEvents });
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
    if (socket && opts?.intentional) this.intentionallyClosedSockets.add(socket);
    socket?.close();
  }

  private startEventLoopSampler(): void {
    this.eventLoopTimer = setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - this.expectedEventLoopTickAt);
      this.expectedEventLoopTickAt = now + EVENT_LOOP_SAMPLE_MS;
      if (lag > this.workerEventLoopLagMaxMs) {
        this.workerEventLoopLagMaxMs = lag;
        this.heartbeat = { ...this.heartbeat, workerEventLoopLagMaxMs: lag };
        this.postHeartbeat();
      }
    }, EVENT_LOOP_SAMPLE_MS);
  }

  private postGap(reason: string): void {
    this.post({ type: "gap", reason, timestamp: Date.now() });
  }

  private postError(error: SerializedUserWorkerError): void {
    this.post({ type: "error", error });
  }

  private postHeartbeat(): void {
    this.post({ type: "heartbeat", heartbeat: this.heartbeat });
  }

  private post(message: UserEventWorkerEvent): void {
    parentPort!.postMessage(message);
  }
}

const runtime = new UserEventWorkerRuntime(workerData as UserEventWorkerData);

parentPort.on("message", (message: UserEventWorkerCommand) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "set-condition-ids") {
    runtime.setConditionIds(message.conditionIds);
  } else if (message.type === "close") {
    runtime.close();
  }
});

function serializeUnknownError(error: unknown): SerializedUserWorkerError {
  if (error instanceof Error) {
    const maybe = error as Error & { code?: unknown };
    let serialized: SerializedUserWorkerError = { message: error.message, name: error.name };
    if (error.stack) serialized = { ...serialized, stack: error.stack };
    if (typeof maybe.code === "string") serialized = { ...serialized, code: maybe.code };
    return serialized;
  }
  return { message: String(error) };
}

import type { ExchangeUserOrderEvent, ExchangeUserTradeEvent } from "@krabs/domain";
import type { UserEventStreamAuth } from "./user-event-ws-protocol.js";

export type UserEventWorkerCommand =
  | { readonly type: "set-condition-ids"; readonly conditionIds: readonly string[] }
  | { readonly type: "close" };

export interface SerializedUserWorkerError {
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
  readonly code?: string;
  readonly conditionCount?: number;
  readonly closeCode?: number;
  readonly closeReason?: string;
}

export interface UserWorkerHeartbeatSnapshot {
  readonly pingSent: number;
  readonly pongReceived: number;
  readonly timeoutFired: number;
  readonly timeoutSuppressedByInbound: number;
  readonly lastPingSentAt: number | null;
  readonly lastPongAt: number | null;
  readonly lastInboundMessageAt: number | null;
  readonly workerEventLoopLagMaxMs: number;
}

export type UserEventWorkerEvent =
  | {
      readonly type: "trade-events";
      readonly events: readonly ExchangeUserTradeEvent[];
    }
  | {
      readonly type: "order-events";
      readonly events: readonly ExchangeUserOrderEvent[];
    }
  | { readonly type: "gap"; readonly reason: string; readonly timestamp: number }
  | { readonly type: "error"; readonly error: SerializedUserWorkerError }
  | { readonly type: "heartbeat"; readonly heartbeat: UserWorkerHeartbeatSnapshot };

export interface UserEventWorkerData {
  readonly auth: UserEventStreamAuth;
  readonly traderAddress: string | null;
}

export const USER_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
export const USER_HEARTBEAT_PING = "PING";
export const USER_HEARTBEAT_PONG = "PONG";
export const USER_PING_INTERVAL_MS = 10_000;
export const USER_PONG_TIMEOUT_MS = 15_000;
export const USER_RECONNECT_DELAY_MS = 2_000;

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

export function defaultUserEventWebSocketFactory(url: string): UserEventWebSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => UserEventWebSocketLike })
    .WebSocket;
  if (!ctor) {
    throw new Error("WebSocket is not available in the current runtime");
  }
  return new ctor(url);
}

export function normalizeUserWebSocketPayload(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return null;
}

export function normalizeConditionIds(conditionIds: readonly string[]): string[] {
  return [
    ...new Set(conditionIds.map((value) => value.trim()).filter((value) => value.length > 0)),
  ].sort();
}

export function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function buildUserSubscriptionPayload(input: {
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

export function isUserPongPayload(payload: unknown): boolean {
  if (typeof payload === "string") {
    return payload.trim().toUpperCase() === USER_HEARTBEAT_PONG;
  }
  return (
    payload != null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload as Record<string, unknown>).length === 0
  );
}

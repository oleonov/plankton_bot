import { extractBookTokenId, parseOptionalIsoTimestamp } from "./market-data-stream-shared.js";

export const CLOB_MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
export const HEARTBEAT_PING = "PING";
export const HEARTBEAT_PONG = "PONG";
export const PING_INTERVAL_MS = 10_000;
export const PONG_TIMEOUT_MS = 15_000;

export function normalizeTokenIds(tokenIds: readonly string[]): string[] {
  return [
    ...new Set(tokenIds.map((value) => value.trim()).filter((value) => value.length > 0)),
  ].sort();
}

export function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function chunkItems<T>(items: readonly T[], chunkSize: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export function buildMarketSubscriptionPayload(tokenIds: readonly string[]): string {
  return JSON.stringify({
    type: "market",
    assets_ids: tokenIds,
    custom_feature_enabled: true,
  });
}

export function buildMarketSubscriptionUpdatePayload(
  operation: "subscribe" | "unsubscribe",
  tokenIds: readonly string[],
  customFeatureEnabled: boolean,
): string {
  return JSON.stringify({
    operation,
    assets_ids: tokenIds,
    ...(customFeatureEnabled ? { custom_feature_enabled: true } : {}),
  });
}

export function isPongPayload(payload: unknown): boolean {
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

export interface ParsedRecordMetrics {
  readonly eventCount: number;
  readonly latencySamplesMs: readonly number[];
}

export function collectStreamUpdatesMetricsOnly(
  records: readonly unknown[],
  nowMs: number,
): ParsedRecordMetrics {
  let eventCount = 0;
  const latencySamplesMs: number[] = [];

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const raw = record as Record<string, unknown>;
    const eventType = typeof raw.event_type === "string" ? raw.event_type : "";
    if (!eventType) continue;
    eventCount++;
    noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
    if (eventType === "price_change" && Array.isArray(raw.price_changes)) {
      eventCount += raw.price_changes.length - 1;
      for (const pc of raw.price_changes) {
        if (!pc || typeof pc !== "object") continue;
        noteLatencySample(latencySamplesMs, (pc as Record<string, unknown>).timestamp, nowMs);
      }
    }
  }

  return { eventCount, latencySamplesMs };
}

export function extractTokenIdsFromRecords(records: readonly unknown[]): readonly string[] {
  const ids = new Set<string>();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const raw = record as Record<string, unknown>;
    const tokenId = extractBookTokenId(raw);
    if (tokenId) ids.add(tokenId);
    if (Array.isArray(raw.price_changes)) {
      for (const pc of raw.price_changes) {
        if (!pc || typeof pc !== "object") continue;
        const tid = extractBookTokenId(pc as Record<string, unknown>);
        if (tid) ids.add(tid);
      }
    }
    const assetIds = raw.assets_ids ?? raw.clob_token_ids;
    if (Array.isArray(assetIds)) {
      for (const id of assetIds) {
        if (typeof id === "string" && id.trim()) ids.add(id.trim());
      }
    }
  }
  return [...ids];
}

export function noteLatencySample(samples: number[], timestamp: unknown, nowMs: number): void {
  const eventAtIso = parseOptionalIsoTimestamp(timestamp);
  if (!eventAtIso) return;
  const eventAtMs = Date.parse(eventAtIso);
  if (!Number.isFinite(eventAtMs)) return;
  const ageMs = nowMs - eventAtMs;
  if (ageMs < -5_000 || ageMs > 60_000) return;
  samples.push(Math.max(0, ageMs));
}

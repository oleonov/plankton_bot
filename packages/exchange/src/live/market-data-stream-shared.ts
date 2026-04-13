import type { MarketPricingStreamLatencySummary } from "@plankton/domain";

export interface MarketDataWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
}

export function defaultMarketDataWebSocketFactory(url: string): MarketDataWebSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => MarketDataWebSocketLike })
    .WebSocket;
  if (!ctor) {
    throw new Error("WebSocket is not available in the current runtime");
  }
  return new ctor(url);
}

export function parseOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseOptionalIsoTimestamp(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return new Date(numeric).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function extractBookTokenId(raw: Record<string, unknown>): string | null {
  if (typeof raw.asset_id === "string") return raw.asset_id;
  if (typeof raw.token_id === "string") return raw.token_id;
  return null;
}

export function normalizeWebSocketPayload(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return null;
}

export function summarizeLatencySamples(
  latencySamplesMs: readonly number[],
): MarketPricingStreamLatencySummary | null {
  if (latencySamplesMs.length === 0) return null;
  const sorted = [...latencySamplesMs].sort((left, right) => left - right);
  const count = sorted.length;
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const pickQuantile = (quantile: number): number => {
    const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile));
    return sorted[index] ?? 0;
  };
  return {
    count,
    avgMs: Number((sum / count).toFixed(2)),
    minMs: sorted[0] ?? 0,
    p50Ms: pickQuantile(0.5),
    p95Ms: pickQuantile(0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

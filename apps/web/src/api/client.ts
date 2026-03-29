import type { ApiEnvelope } from "./types.ts";

// ─── Unauthorized callback ───────────────────────────────────────────

let onUnauthorized: (() => void) | null = null;

export function registerOnUnauthorized(cb: () => void): () => void {
  onUnauthorized = cb;
  return () => {
    if (onUnauthorized === cb) onUnauthorized = null;
  };
}

// ─── API transport ───────────────────────────────────────────────────

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);

  if (res.status === 401) {
    onUnauthorized?.();
    throw new Error("Unauthorized");
  }

  const body = (await res.json()) as ApiEnvelope<T>;

  if (!body.ok || body.data === null) {
    throw new Error(body.error?.message ?? `API error: ${res.status}`);
  }

  return body.data;
}

export function apiPost<T>(path: string, payload?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    ...(payload != null
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
      : {}),
  });
}

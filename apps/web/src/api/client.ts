import type { ApiEnvelope } from "./types.ts";

function getApiKey(): string {
  return localStorage.getItem("plankton_api_key")
    ?? import.meta.env.VITE_PLANKTON_API_KEY
    ?? "";
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${getApiKey()}`,
    },
  });

  const body = (await res.json()) as ApiEnvelope<T>;

  if (!body.ok || body.data === null) {
    throw new Error(body.error?.message ?? `API error: ${res.status}`);
  }

  return body.data;
}

export function apiPost<T>(path: string, payload?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

/** Exported for SSE (EventSource cannot send headers, needs key for URL param). */
export { getApiKey };

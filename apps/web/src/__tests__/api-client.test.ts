import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { apiFetch, apiPost, registerOnUnauthorized } from "../api/client.ts";
import { server } from "../test/server.ts";

// Pause MSW so vi.stubGlobal("fetch") works without interception
beforeAll(() => server.close());
afterAll(() => server.listen());

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse<T>(status: number, body: T) {
  return { status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) };
}

function okEnvelope<T>(data: T) {
  return jsonResponse(200, { ok: true, data, error: null, ts: "2026-01-01T00:00:00Z" });
}

describe("apiFetch", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("makes requests without Authorization header", async () => {
    mockFetch.mockResolvedValue(okEnvelope({ status: "ok" }));

    await apiFetch("/api/v1/health");

    const callInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = callInit?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBeUndefined();
  });

  it("calls registered onUnauthorized callback on 401", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(401, {
        ok: false,
        data: null,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        ts: "",
      }),
    );

    const cb = vi.fn();
    const deregister = registerOnUnauthorized(cb);

    await expect(apiFetch("/api/v1/status")).rejects.toThrow("Unauthorized");
    expect(cb).toHaveBeenCalledOnce();

    deregister();
  });

  it("deregister prevents callback from being called", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(401, {
        ok: false,
        data: null,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        ts: "",
      }),
    );

    const cb = vi.fn();
    const deregister = registerOnUnauthorized(cb);
    deregister();

    await expect(apiFetch("/api/v1/status")).rejects.toThrow("Unauthorized");
    expect(cb).not.toHaveBeenCalled();
  });

  it("throws on non-ok response with error message from body", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(500, {
        ok: false,
        data: null,
        error: { code: "INTERNAL", message: "something broke" },
        ts: "",
      }),
    );

    await expect(apiFetch("/api/v1/status")).rejects.toThrow("something broke");
  });
});

describe("apiPost", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends JSON body with POST method", async () => {
    mockFetch.mockResolvedValue(okEnvelope({ id: 1 }));

    const payload = { action: "pause" };
    await apiPost("/api/v1/control", payload);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/control",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiFetch } from "../api/client.ts";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock localStorage
const store: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, val: string) => { store[key] = val; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { for (const k in store) delete store[k]; },
});

describe("apiFetch", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    localStorage.clear();
  });

  it("adds Authorization header", async () => {
    localStorage.setItem("plankton_api_key", "test-key-123");

    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: true, data: { status: "ok" }, error: null, ts: "" }),
    });

    await apiFetch("/api/v1/health");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key-123",
        }),
      }),
    );
  });

  it("throws on error response", async () => {
    mockFetch.mockResolvedValue({
      status: 401,
      json: () => Promise.resolve({ ok: false, data: null, error: { code: "UNAUTHORIZED", message: "bad" }, ts: "" }),
    });

    await expect(apiFetch("/api/v1/status")).rejects.toThrow("bad");
  });
});

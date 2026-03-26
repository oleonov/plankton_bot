import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GammaResolutionClient } from "../gamma/resolution-client.js";

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Gamma /markets/slug/{slug} returns camelCase fields. */
function gammaMarketPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "12345",
    conditionId: "0xabc123",
    slug: "bitcoin-above-100k",
    closed: true,
    closedTime: "2026-03-25T16:00:00Z",
    umaResolutionStatus: "resolved",
    endDateIso: "2026-03-25T16:00:00Z",
    endDate: "2026-03-25",
    ...overrides,
  };
}

describe("GammaResolutionClient", () => {
  const originalFetch = globalThis.fetch;
  let client: GammaResolutionClient;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    client = new GammaResolutionClient({
      baseUrl: "https://test.gamma.api",
      maxRetries: 1,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ─── camelCase field parsing ───────────────────────────────────────

  it("parses camelCase fields from Gamma response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(gammaMarketPayload()));

    const info = await client.getMarketBySlug("bitcoin-above-100k");

    expect(info).not.toBeNull();
    expect(info!.conditionId).toBe("0xabc123");
    expect(info!.closed).toBe(true);
    expect(info!.closedTime).toBe("2026-03-25T16:00:00Z");
    expect(info!.umaResolutionStatus).toBe("resolved");
    expect(info!.endDate).toBe("2026-03-25T16:00:00Z");
  });

  it("parses snake_case fields for backwards compatibility", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse({
        condition_id: "0xdef456",
        slug: "test-market",
        closed: true,
        closed_time: "2026-03-20T00:00:00Z",
        uma_resolution_status: "resolved",
        end_date_iso: "2026-03-20T00:00:00Z",
      }),
    );

    const info = await client.getMarketBySlug("test-market");

    expect(info).not.toBeNull();
    expect(info!.conditionId).toBe("0xdef456");
    expect(info!.closedTime).toBe("2026-03-20T00:00:00Z");
    expect(info!.umaResolutionStatus).toBe("resolved");
    expect(info!.endDate).toBe("2026-03-20T00:00:00Z");
  });

  it("returns null when response has no conditionId in either case", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse({ slug: "test", closed: true }), // no conditionId field
    );

    const info = await client.getMarketBySlug("test");
    expect(info).toBeNull();
  });

  // ─── HTTP status handling ─────────────────────────────────────────

  it("returns null on 404", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(null, 404));

    const info = await client.getMarketBySlug("nonexistent");
    expect(info).toBeNull();
  });

  it("returns null on 422 (conditionId not accepted by /markets endpoint)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(null, 422));

    const info = await client.getMarketById("0xabc123");
    expect(info).toBeNull();
  });

  it("throws on other non-ok status codes", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(null, 500));

    await expect(client.getMarketBySlug("test")).rejects.toThrow("Gamma API responded with 500");
  });

  // ─── edge cases ───────────────────────────────────────────────────

  it("returns null for empty array response (delisted)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse([]));

    const info = await client.getMarketBySlug("delisted");
    expect(info).toBeNull();
  });

  it("prefers camelCase over snake_case when both present", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse({
        conditionId: "camel",
        condition_id: "snake",
        slug: "test",
        closed: false,
        closedTime: "camel-time",
        closed_time: "snake-time",
      }),
    );

    const info = await client.getMarketBySlug("test");
    expect(info!.conditionId).toBe("camel");
    expect(info!.closedTime).toBe("camel-time");
  });
});

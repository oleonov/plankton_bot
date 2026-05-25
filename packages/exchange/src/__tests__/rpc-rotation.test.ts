import { describe, it, expect, vi } from "vitest";
import { createRpcRotator, isRateLimitError, redactRpcUrl } from "../live/rpc-rotation.js";

const TO = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const DATA = "0xabcdef";

function ok(result: string): Response {
  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
function rateLimited(): Response {
  return new Response("limited", { status: 429, statusText: "Too Many Requests" });
}
function asFetch(fn: (url: string) => Promise<Response>): typeof fetch {
  return fn as unknown as typeof fetch;
}

describe("isRateLimitError", () => {
  it("matches 429 / too many requests / rate limit / quota messages", () => {
    expect(isRateLimitError(new Error("RPC HTTP 429: Too Many Requests"))).toBe(true);
    expect(isRateLimitError(new Error("too many requests"))).toBe(true);
    expect(isRateLimitError(new Error("rate limit reached"))).toBe(true);
    expect(isRateLimitError(new Error("quota exceeded"))).toBe(true);
    expect(isRateLimitError(new Error("boom"))).toBe(false);
  });
});

describe("redactRpcUrl", () => {
  it("redacts the key segment", () => {
    const out = redactRpcUrl("https://polygon-mainnet.g.alchemy.com/v2/SECRETKEY12345");
    expect(out).not.toContain("SECRETKEY12345");
    expect(out).toContain("alchemy.com");
  });
});

describe("createRpcRotator — round-robin", () => {
  it("advances the cursor after each successful call (key1 → key2 → key1)", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return ok("0x01");
    });
    const rotator = createRpcRotator({
      primaryUrls: ["https://k1.example", "https://k2.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    await rotator.ethCall(TO, DATA, { source: "test" });
    await rotator.ethCall(TO, DATA, { source: "test" });
    await rotator.ethCall(TO, DATA, { source: "test" });
    expect(seen).toEqual(["https://k1.example", "https://k2.example", "https://k1.example"]);
  });

  it("throws when constructed with no primary URLs", () => {
    expect(() => createRpcRotator({ primaryUrls: [] })).toThrow(/at least one primary/i);
  });

  it("wraps around: index >= length → 0", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return ok("0x01");
    });
    const rotator = createRpcRotator({
      primaryUrls: ["https://k1.example", "https://k2.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    for (let i = 0; i < 4; i += 1) await rotator.ethCall(TO, DATA, { source: "test" });
    expect(seen).toEqual([
      "https://k1.example",
      "https://k2.example",
      "https://k1.example",
      "https://k2.example",
    ]);
  });
});

describe("createRpcRotator — 429-failover + cursor edge-case", () => {
  it("fails over to the next primary on 429 within one call", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return url === "https://k1.example" ? rateLimited() : ok("0x01");
    });
    const rotator = createRpcRotator({
      primaryUrls: ["https://k1.example", "https://k2.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    const result = await rotator.ethCall(TO, DATA, { source: "test" });
    expect(result).toBe("0x01");
    expect(seen).toEqual(["https://k1.example", "https://k2.example"]);
  });

  it("cursor edge-case: start k, 429 at k, success at k+1 → next call starts at k+2", async () => {
    // 3 primaries. Call 1 starts at index 0, 429 at 0, success at 1.
    // Next call must start at index 2 (not 1).
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return url === "https://k1.example" ? rateLimited() : ok("0x01");
    });
    const rotator = createRpcRotator({
      primaryUrls: ["https://k1.example", "https://k2.example", "https://k3.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    await rotator.ethCall(TO, DATA, { source: "test" }); // 0 (429) → 1 (ok)
    seen.length = 0;
    await rotator.ethCall(TO, DATA, { source: "test" }); // must start at 2
    expect(seen[0]).toBe("https://k3.example");
  });
});

describe("createRpcRotator — concurrency", () => {
  it("two parallel ethCalls start at different primary indices", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      await new Promise((r) => setTimeout(r, 5));
      return ok("0x01");
    });
    const rotator = createRpcRotator({
      primaryUrls: ["https://k1.example", "https://k2.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    await Promise.all([
      rotator.ethCall(TO, DATA, { source: "test" }),
      rotator.ethCall(TO, DATA, { source: "test" }),
    ]);
    expect(new Set(seen)).toEqual(new Set(["https://k1.example", "https://k2.example"]));
  });
});

describe("createRpcRotator — fallback tier", () => {
  it("single primary: 429 jumps straight to the fallback tier", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return url === "https://only.example" ? rateLimited() : ok("0x01");
    });
    const rotator = createRpcRotator({
      primaryUrls: ["https://only.example"],
      fallbackUrls: ["https://fb.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    const result = await rotator.ethCall(TO, DATA, { source: "test" });
    expect(result).toBe("0x01");
    expect(seen).toEqual(["https://only.example", "https://fb.example"]);
  });

  it("reaches fallback only after ALL primaries 429", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return url.startsWith("https://fb") ? ok("0x01") : rateLimited();
    });
    const rotator = createRpcRotator({
      primaryUrls: ["https://k1.example", "https://k2.example"],
      fallbackUrls: ["https://fb.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    const result = await rotator.ethCall(TO, DATA, { source: "test" });
    expect(result).toBe("0x01");
    expect(seen).toEqual(["https://k1.example", "https://k2.example", "https://fb.example"]);
  });

  it("propagates a non-429 error immediately without trying fallback", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500, statusText: "err" }));
    const rotator = createRpcRotator({
      primaryUrls: ["https://k1.example"],
      fallbackUrls: ["https://fb.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    await expect(rotator.ethCall(TO, DATA, { source: "test" })).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("propagates a 429 when all primaries and fallbacks are exhausted", async () => {
    const fetchImpl = vi.fn(async () => rateLimited());
    const rotator = createRpcRotator({
      primaryUrls: ["https://k1.example"],
      fallbackUrls: ["https://fb.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    await expect(rotator.ethCall(TO, DATA, { source: "test" })).rejects.toThrow(/429/);
  });
});

describe("createRpcRotator — log redaction at the rotator boundary", () => {
  it("redacts the rpc key in 429-failover warn logs (message and structured field)", async () => {
    const primaryUrls = [
      "https://polygon-mainnet.g.alchemy.com/v2/SECRET_KEY_1",
      "https://polygon-mainnet.g.alchemy.com/v2/SECRET_KEY_2",
    ];
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const fetchImpl = vi.fn(async (url: string) =>
      url === primaryUrls[0] ? rateLimited() : ok("0x01"),
    );
    const rotator = createRpcRotator({ primaryUrls, fetchImpl: asFetch(fetchImpl), logger });

    await rotator.ethCall(TO, DATA, { source: "test" });

    expect(logger.warn).toHaveBeenCalled();
    const allWarnCalls = logger.warn.mock.calls.flat();
    const serialized = JSON.stringify(allWarnCalls);
    expect(serialized).not.toContain("SECRET_KEY_1");
    expect(serialized).not.toContain("SECRET_KEY_2");

    // The structured meta field (not just the message string) must be redacted.
    const meta = logger.warn.mock.calls[0]![1] as { rpcUrl?: string };
    expect(meta.rpcUrl).toBeDefined();
    expect(meta.rpcUrl).not.toContain("SECRET_KEY_1");
  });
});

describe("createRpcRotator — non-429 with multiple primaries", () => {
  it("propagates a non-429 immediately without touching k2/k3 or the fallback", async () => {
    const primaryUrls = [
      "https://polygon-mainnet.g.alchemy.com/v2/k1",
      "https://polygon-mainnet.g.alchemy.com/v2/k2",
      "https://polygon-mainnet.g.alchemy.com/v2/k3",
    ];
    const fallbackUrls = ["https://lb.drpc.org/ogrpc?network=polygon"];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === primaryUrls[0]) throw new Error("HTTP 500");
      return ok("0x01");
    });
    const rotator = createRpcRotator({ primaryUrls, fallbackUrls, fetchImpl: asFetch(fetchImpl) });

    await expect(rotator.ethCall(TO, DATA, { source: "test" })).rejects.toThrow();
    const calledUrls = fetchImpl.mock.calls.map((c) => c[0]);
    expect(calledUrls).toEqual([primaryUrls[0]]);
    expect(calledUrls).not.toContain(primaryUrls[1]);
    expect(calledUrls).not.toContain(primaryUrls[2]);
    expect(calledUrls).not.toContain(fallbackUrls[0]);

    // The cursor is reserved before the await, so even a non-429 failure advances it:
    // the next call starts at k2, never retries the failed k1. The success-only
    // round-robin tests above don't exercise the failure path.
    await rotator.ethCall(TO, DATA, { source: "test" });
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toBe(primaryUrls[1]);
  });
});

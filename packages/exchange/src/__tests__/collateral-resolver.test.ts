import { describe, it, expect, vi } from "vitest";
import { createCollateralResolver, __test } from "../live/collateral-resolver.js";

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const CONDITION_ID = "0x5c17cb524463fedfc76105217304da21e4fa0ab97d99cca7a9023caaf894064c";
const CONDITION_ID_2 = "0x5c17cb524463fedfc76105217304da21e4fa0ab97d99cca7a9023caaf894064d";
// Verified on Polygon mainnet for the conditionId above, indexSet=1.
const COLLECTION_ID = "0x113c933ebbd5687b7b67aca837225f77cbeb86b5fa097dad9b81a4370120e59f";
const CANONICAL_USDC_YES =
  "73819553356143091807094240472699424599682747424521818839988568728123283653250";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("computePositionId", () => {
  it("matches on-chain positionId for known USDC YES position", () => {
    const pid = __test.computePositionId(USDC, COLLECTION_ID);
    expect(pid.toString()).toBe(CANONICAL_USDC_YES);
  });

  it("returns a different positionId for pUSD with the same collectionId", () => {
    const pidUsdc = __test.computePositionId(USDC, COLLECTION_ID);
    const pidPusd = __test.computePositionId(PUSD, COLLECTION_ID);
    expect(pidPusd).not.toBe(pidUsdc);
  });
});

describe("encodeGetCollectionIdCall", () => {
  it("packs selector + parent + conditionId + indexSet as 100 hex chars", () => {
    const data = __test.encodeGetCollectionIdCall(CONDITION_ID, 1n);
    // selector (8) + parent (64) + conditionId (64) + indexSet (64) = 200 hex chars
    expect(data.length).toBe(2 + 200);
    expect(data.startsWith("0x856296f7")).toBe(true);
    expect(data.slice(10, 10 + 64)).toBe("0".repeat(64));
    expect(data.slice(10 + 64, 10 + 64 + 64)).toBe(CONDITION_ID.slice(2));
    expect(data.slice(10 + 64 + 64)).toBe("1".padStart(64, "0"));
  });

  it("rejects malformed conditionId", () => {
    expect(() => __test.encodeGetCollectionIdCall("0xdeadbeef", 1n)).toThrow();
  });
});

describe("createCollateralResolver", () => {
  it("picks USDC when canonical tokenId matches USDC positionId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ result: COLLECTION_ID }));
    const resolver = createCollateralResolver({
      rpcUrl: "http://rpc.local",
      conditionalTokensAddress: CTF,
      candidates: [USDC, PUSD],
      fetchImpl,
    });

    const result = await resolver({
      conditionId: CONDITION_ID,
      canonicalTokenId: CANONICAL_USDC_YES,
      indexSet: 1n,
    });

    expect(result).toBe(USDC);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns null when no candidate matches", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ result: COLLECTION_ID }));
    const warn = vi.fn();
    const resolver = createCollateralResolver({
      rpcUrl: "http://rpc.local",
      conditionalTokensAddress: CTF,
      candidates: [PUSD],
      fetchImpl,
      logger: { warn, error: vi.fn() },
    });

    const result = await resolver({
      conditionId: CONDITION_ID,
      canonicalTokenId: CANONICAL_USDC_YES,
      indexSet: 1n,
    });

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("caches resolution per conditionId across calls", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ result: COLLECTION_ID }));
    const resolver = createCollateralResolver({
      rpcUrl: "http://rpc.local",
      conditionalTokensAddress: CTF,
      candidates: [USDC, PUSD],
      fetchImpl,
    });

    const first = await resolver({
      conditionId: CONDITION_ID,
      canonicalTokenId: CANONICAL_USDC_YES,
      indexSet: 1n,
    });
    const second = await resolver({
      conditionId: CONDITION_ID,
      canonicalTokenId: CANONICAL_USDC_YES,
      indexSet: 1n,
    });

    expect(first).toBe(USDC);
    expect(second).toBe(USDC);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws and logs error on RPC HTTP failure (preserves cause for upstream classifier)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("oops", { status: 500, statusText: "Internal" }));
    const error = vi.fn();
    const resolver = createCollateralResolver({
      rpcUrl: "http://rpc.local",
      conditionalTokensAddress: CTF,
      candidates: [USDC, PUSD],
      fetchImpl,
      logger: { warn: vi.fn(), error },
    });

    await expect(
      resolver({
        conditionId: CONDITION_ID,
        canonicalTokenId: CANONICAL_USDC_YES,
        indexSet: 1n,
      }),
    ).rejects.toThrow(/RPC HTTP 500/);
    expect(error).toHaveBeenCalledOnce();
  });

  it("throws when RPC payload signals JSON error (preserves cause)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "execution reverted" } }));
    const error = vi.fn();
    const resolver = createCollateralResolver({
      rpcUrl: "http://rpc.local",
      conditionalTokensAddress: CTF,
      candidates: [USDC, PUSD],
      fetchImpl,
      logger: { warn: vi.fn(), error },
    });

    await expect(
      resolver({
        conditionId: CONDITION_ID,
        canonicalTokenId: CANONICAL_USDC_YES,
        indexSet: 1n,
      }),
    ).rejects.toThrow(/execution reverted/);
    expect(error).toHaveBeenCalledOnce();
  });

  it("propagates a 429 message so upstream rate-limit detection works", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("limited", { status: 429, statusText: "Too Many Requests" }));
    const resolver = createCollateralResolver({
      rpcUrl: "http://rpc.local",
      conditionalTokensAddress: CTF,
      candidates: [USDC, PUSD],
      fetchImpl,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    await expect(
      resolver({
        conditionId: CONDITION_ID,
        canonicalTokenId: CANONICAL_USDC_YES,
        indexSet: 1n,
      }),
    ).rejects.toThrow(/429/);
  });

  it("retries the next RPC URL when the current endpoint is rate-limited", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("quota exceeded", { status: 429, statusText: "Too Many Requests" }),
      )
      .mockResolvedValueOnce(jsonResponse({ result: COLLECTION_ID }));
    const warn = vi.fn();
    const resolver = createCollateralResolver({
      rpcUrls: ["https://rpc-one.local", "https://rpc-two.local"],
      conditionalTokensAddress: CTF,
      candidates: [USDC, PUSD],
      fetchImpl,
      logger: { warn, error: vi.fn() },
    });

    const result = await resolver({
      conditionId: CONDITION_ID,
      canonicalTokenId: CANONICAL_USDC_YES,
      indexSet: 1n,
    });

    expect(result).toBe(USDC);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://rpc-one.local");
    expect(fetchImpl.mock.calls[1]![0]).toBe("https://rpc-two.local");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("rotates the starting RPC URL between uncached calls", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ result: COLLECTION_ID })));
    const resolver = createCollateralResolver({
      rpcUrls: ["https://rpc-one.local", "https://rpc-two.local"],
      conditionalTokensAddress: CTF,
      candidates: [USDC, PUSD],
      fetchImpl,
    });

    await resolver({
      conditionId: CONDITION_ID,
      canonicalTokenId: CANONICAL_USDC_YES,
      indexSet: 1n,
    });
    await resolver({
      conditionId: CONDITION_ID_2,
      canonicalTokenId: CANONICAL_USDC_YES,
      indexSet: 1n,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://rpc-one.local");
    expect(fetchImpl.mock.calls[1]![0]).toBe("https://rpc-two.local");
  });

  it("throws the final rate-limit error when every RPC URL is exhausted", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("first", { status: 429, statusText: "Too Many Requests" }),
      )
      .mockResolvedValueOnce(
        new Response("second", { status: 429, statusText: "Too Many Requests" }),
      );
    const resolver = createCollateralResolver({
      rpcUrls: ["https://rpc-one.local", "https://rpc-two.local"],
      conditionalTokensAddress: CTF,
      candidates: [USDC, PUSD],
      fetchImpl,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    await expect(
      resolver({
        conditionId: CONDITION_ID,
        canonicalTokenId: CANONICAL_USDC_YES,
        indexSet: 1n,
      }),
    ).rejects.toThrow(/second/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

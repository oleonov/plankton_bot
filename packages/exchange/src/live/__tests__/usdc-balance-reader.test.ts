import { describe, it, expect, vi } from "vitest";
import { readErc20Balance, readErc20Allowance } from "../usdc-balance-reader.js";
import { createRpcRotator } from "../rpc-rotation.js";

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const SPENDER = "0x2222222222222222222222222222222222222222" as const;
// abi-encoded uint256 = 1_000_000 (1 USDC, 6 decimals)
const ONE_USDC_HEX = "0x" + (1_000_000).toString(16).padStart(64, "0");

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

describe("readErc20Balance via rotator", () => {
  it("returns the decoded balance", async () => {
    const fetchImpl = vi.fn(async () => ok(ONE_USDC_HEX));
    const rotator = createRpcRotator({
      primaryUrls: ["https://k1.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    const balance = await readErc20Balance({ rotator, token: USDC, owner: OWNER });
    expect(balance).toBe(1_000_000n);
  });

  it("fails over to the second primary on 429", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return url === "https://k1.example" ? rateLimited() : ok(ONE_USDC_HEX);
    });
    const rotator = createRpcRotator({
      primaryUrls: ["https://k1.example", "https://k2.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    const balance = await readErc20Balance({ rotator, token: USDC, owner: OWNER });
    expect(balance).toBe(1_000_000n);
    expect(seen).toEqual(["https://k1.example", "https://k2.example"]);
  });

  it("propagates a non-429 RPC failure (must not coerce to 0n)", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500, statusText: "err" }));
    const rotator = createRpcRotator({
      primaryUrls: ["https://k1.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    await expect(readErc20Balance({ rotator, token: USDC, owner: OWNER })).rejects.toThrow(/500/);
  });
});

describe("readErc20Allowance via rotator", () => {
  it("returns the decoded allowance", async () => {
    const fetchImpl = vi.fn(async () => ok(ONE_USDC_HEX));
    const rotator = createRpcRotator({
      primaryUrls: ["https://k1.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    const allowance = await readErc20Allowance({
      rotator,
      token: USDC,
      owner: OWNER,
      spender: SPENDER,
    });
    expect(allowance).toBe(1_000_000n);
  });

  it("propagates a non-429 RPC failure (must not coerce to 0n)", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500, statusText: "err" }));
    const rotator = createRpcRotator({
      primaryUrls: ["https://k1.example"],
      fetchImpl: asFetch(fetchImpl),
    });
    await expect(
      readErc20Allowance({ rotator, token: USDC, owner: OWNER, spender: SPENDER }),
    ).rejects.toThrow(/500/);
  });
});

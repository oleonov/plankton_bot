import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData } from "viem";
import { readErc20Balance } from "../usdc-balance-reader.js";
import { ERC20_BALANCE_ABI, USDC_E_ADDRESS } from "../pusd-wrapper.js";

const RPC_URL = "https://polygon-rpc.example";
const OWNER = "0x1234567890123456789012345678901234567890" as const;
// 7.03 USDC in raw units (6 decimals)
const EXPECTED_BALANCE = 7_030_000n;

function hex32(value: bigint): string {
  return "0x" + value.toString(16).padStart(64, "0");
}

function makeJsonFetch(result: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ result }),
  }) as unknown as typeof fetch;
}

describe("readErc20Balance", () => {
  it("decodes a 32-byte uint256 hex result to bigint", async () => {
    const fetchImpl = makeJsonFetch(hex32(EXPECTED_BALANCE));
    const balance = await readErc20Balance({
      rpcUrl: RPC_URL,
      token: USDC_E_ADDRESS,
      owner: OWNER,
      fetchImpl,
    });
    expect(balance).toBe(EXPECTED_BALANCE);
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown];
    expect(url).toBe(RPC_URL);
    const body = JSON.parse(
      ((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }])[1]
        .body,
    ) as { method: string; params: [{ to: string; data: string }, string] };
    expect(body.method).toBe("eth_call");
    expect(body.params[0].to).toBe(USDC_E_ADDRESS);
    const expectedData = encodeFunctionData({
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [OWNER],
    });
    expect(body.params[0].data).toBe(expectedData);
  });

  it("throws on 4xx HTTP response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 429, statusText: "Too Many Requests" }) as unknown as typeof fetch;
    await expect(
      readErc20Balance({ rpcUrl: RPC_URL, token: USDC_E_ADDRESS, owner: OWNER, fetchImpl }),
    ).rejects.toThrow(/RPC HTTP 429/);
  });

  it("throws on RPC error JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: { message: "execution reverted" } }),
    }) as unknown as typeof fetch;
    await expect(
      readErc20Balance({ rpcUrl: RPC_URL, token: USDC_E_ADDRESS, owner: OWNER, fetchImpl }),
    ).rejects.toThrow(/execution reverted/);
  });

  it("propagates network failure to the caller", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network error")) as unknown as typeof fetch;
    await expect(
      readErc20Balance({ rpcUrl: RPC_URL, token: USDC_E_ADDRESS, owner: OWNER, fetchImpl }),
    ).rejects.toThrow(/network error/);
  });

  it("throws on truncated hex (parse failure)", async () => {
    // 31 bytes — decodeFunctionResult will throw because the data is too short
    const fetchImpl = makeJsonFetch("0x" + "00".repeat(31));
    await expect(
      readErc20Balance({ rpcUrl: RPC_URL, token: USDC_E_ADDRESS, owner: OWNER, fetchImpl }),
    ).rejects.toThrow();
  });
});

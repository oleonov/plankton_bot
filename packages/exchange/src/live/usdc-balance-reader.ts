import { encodeFunctionData, decodeFunctionResult } from "viem";
import { ERC20_BALANCE_ABI, ERC20_ALLOWANCE_ABI } from "./pusd-wrapper.js";

const DEFAULT_TIMEOUT_MS = 8_000;

// RPC failures here must NOT silently coerce to 0n: a balance read that fails
// during the post-redeem sweep would otherwise mask pending USDC.e and skip
// activation entirely, leaving funds stranded on the proxy wallet. Throw so
// the caller routes the failure through its infra-alert classifier and writes
// an error row to the audit log instead of a misleading "zero_balance".
async function ethCallRpc(
  rpcUrl: string,
  to: `0x${string}`,
  data: `0x${string}`,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}: ${response.statusText}`);
  }
  const json = (await response.json()) as { result?: string; error?: { message?: string } };
  if (json.error) {
    throw new Error(`RPC error: ${json.error.message ?? "unknown"}`);
  }
  if (typeof json.result !== "string" || !json.result.startsWith("0x")) {
    throw new Error(`RPC returned unexpected result: ${JSON.stringify(json.result)}`);
  }
  return json.result;
}

export async function readErc20Balance(opts: {
  rpcUrl: string;
  token: `0x${string}`;
  owner: `0x${string}`;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<bigint> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const data = encodeFunctionData({
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [opts.owner],
  });
  const result = await ethCallRpc(opts.rpcUrl, opts.token, data, fetchImpl, timeoutMs);
  return decodeFunctionResult({
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    data: result as `0x${string}`,
  });
}

export async function readErc20Allowance(opts: {
  rpcUrl: string;
  token: `0x${string}`;
  owner: `0x${string}`;
  spender: `0x${string}`;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<bigint> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const data = encodeFunctionData({
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [opts.owner, opts.spender],
  });
  const result = await ethCallRpc(opts.rpcUrl, opts.token, data, fetchImpl, timeoutMs);
  return decodeFunctionResult({
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    data: result as `0x${string}`,
  });
}

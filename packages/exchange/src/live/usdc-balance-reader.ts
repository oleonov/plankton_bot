import { encodeFunctionData, decodeFunctionResult } from "viem";
import { ERC20_BALANCE_ABI, ERC20_ALLOWANCE_ABI } from "./pusd-wrapper.js";
import type { RpcRotator } from "./rpc-rotation.js";

// RPC failures here must NOT silently coerce to 0n: a balance read that fails
// during the post-redeem sweep would otherwise mask pending USDC.e and skip
// activation entirely, leaving funds stranded on the proxy wallet. The rotator
// throws (after exhausting endpoints) so the caller routes the failure through
// its infra-alert classifier instead of writing a misleading "zero_balance".

export async function readErc20Balance(opts: {
  rotator: RpcRotator;
  token: `0x${string}`;
  owner: `0x${string}`;
}): Promise<bigint> {
  const data = encodeFunctionData({
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [opts.owner],
  });
  const result = await opts.rotator.ethCall(opts.token, data, { source: "balance-reader" });
  return decodeFunctionResult({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", data: result });
}

export async function readErc20Allowance(opts: {
  rotator: RpcRotator;
  token: `0x${string}`;
  owner: `0x${string}`;
  spender: `0x${string}`;
}): Promise<bigint> {
  const data = encodeFunctionData({
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [opts.owner, opts.spender],
  });
  const result = await opts.rotator.ethCall(opts.token, data, { source: "balance-reader" });
  return decodeFunctionResult({
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    data: result,
  });
}

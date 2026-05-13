import { describe, expect, it } from "vitest";
import { encodeFunctionData, decodeFunctionResult } from "viem";
import {
  ERC20_APPROVE_ABI,
  PUSD_WRAP_ABI,
  PUSD_WRAPPER_ADDRESS,
  USDC_E_ADDRESS,
} from "../pusd-wrapper.js";

const SPENDER = PUSD_WRAPPER_ADDRESS;
const OWNER = "0x1234567890123456789012345678901234567890" as const;
const AMOUNT = 7_030_000n;

describe("ERC20_APPROVE_ABI encode/decode", () => {
  it("round-trips approve(spender, amount)", () => {
    const data = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [SPENDER, AMOUNT],
    });
    expect(data.startsWith("0x")).toBe(true);
    // approve returns bool — encode a true result and decode it
    const returnData = "0x0000000000000000000000000000000000000000000000000000000000000001";
    const result = decodeFunctionResult({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      data: returnData,
    });
    expect(result).toBe(true);
    // selector is keccak256("approve(address,uint256)")[0:4] = 0x095ea7b3
    expect(data.slice(0, 10)).toBe("0x095ea7b3");
    // spender address padded to 32 bytes
    expect(data.toLowerCase()).toContain(SPENDER.slice(2).toLowerCase().padStart(64, "0"));
    // amount padded to 32 bytes
    expect(data).toContain(AMOUNT.toString(16).padStart(64, "0"));
  });
});

describe("PUSD_WRAP_ABI encode wrap", () => {
  it("encodes wrap(_asset, _to, _amount) with correct selector and args", () => {
    const data = encodeFunctionData({
      abi: PUSD_WRAP_ABI,
      functionName: "wrap",
      args: [USDC_E_ADDRESS, OWNER, AMOUNT],
    });
    expect(data.startsWith("0x")).toBe(true);
    // selector is keccak256("wrap(address,address,uint256)")[0:4]
    expect(data.slice(0, 10)).toBe("0x62355638");
    expect(data.toLowerCase()).toContain(USDC_E_ADDRESS.slice(2).toLowerCase().padStart(64, "0"));
    expect(data.toLowerCase()).toContain(OWNER.slice(2).toLowerCase().padStart(64, "0"));
    expect(data).toContain(AMOUNT.toString(16).padStart(64, "0"));
  });
});

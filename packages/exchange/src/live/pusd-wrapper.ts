import { parseAbi } from "viem";

export const PUSD_WRAPPER_ADDRESS = "0x93070a847efEf7F70739046A929D47a521F5B8ee" as const;
export const USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
export const USDC_NATIVE_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as const;
export const USDC_DECIMALS = 6;

export const ERC20_BALANCE_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);
export const ERC20_APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
export const ERC20_ALLOWANCE_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
]);
export const PUSD_WRAP_ABI = parseAbi([
  "function wrap(address _asset, address _to, uint256 _amount)",
]);

export const ACTIVATION_ASSETS = [
  { address: USDC_E_ADDRESS, symbol: "USDC.e" },
  { address: USDC_NATIVE_ADDRESS, symbol: "USDC" },
] as const;

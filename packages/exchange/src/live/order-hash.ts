import { getContractConfig } from "@polymarket/clob-client-v2";
import { hashTypedData } from "viem";

export const CLOB_V2_ORDER_DOMAIN = {
  name: "Polymarket CTF Exchange",
  version: "2",
} as const;

export const CLOB_V2_ORDER_FIELDS = [
  { name: "salt", type: "uint256" },
  { name: "maker", type: "address" },
  { name: "signer", type: "address" },
  { name: "tokenId", type: "uint256" },
  { name: "makerAmount", type: "uint256" },
  { name: "takerAmount", type: "uint256" },
  { name: "side", type: "uint8" },
  { name: "signatureType", type: "uint8" },
  { name: "timestamp", type: "uint256" },
  { name: "metadata", type: "bytes32" },
  { name: "builder", type: "bytes32" },
] as const;

type SignedOrderV2 = {
  readonly salt: string;
  readonly maker: string;
  readonly signer: string;
  readonly tokenId: string;
  readonly makerAmount: string;
  readonly takerAmount: string;
  readonly side: "BUY" | "SELL";
  readonly signatureType: number;
  readonly timestamp: string;
  readonly metadata: string;
  readonly builder: string;
  readonly signature: string;
};

const V2_KEYS: readonly (keyof SignedOrderV2)[] = [
  "salt",
  "maker",
  "signer",
  "tokenId",
  "makerAmount",
  "takerAmount",
  "side",
  "signatureType",
  "timestamp",
  "metadata",
  "builder",
  "signature",
];

function requireV2Order(value: unknown): SignedOrderV2 {
  if (!value || typeof value !== "object") throw new Error("expected a V2 signed order");
  const order = value as Record<string, unknown>;
  if ("taker" in order || "nonce" in order || "feeRateBps" in order) {
    throw new Error("V1 signed orders are not supported");
  }
  if (
    V2_KEYS.some((key) => order[key] === undefined) ||
    typeof order.salt !== "string" ||
    typeof order.maker !== "string" ||
    typeof order.signer !== "string" ||
    typeof order.tokenId !== "string" ||
    typeof order.makerAmount !== "string" ||
    typeof order.takerAmount !== "string" ||
    (order.side !== "BUY" && order.side !== "SELL") ||
    typeof order.signatureType !== "number" ||
    !Number.isInteger(order.signatureType) ||
    typeof order.timestamp !== "string" ||
    typeof order.metadata !== "string" ||
    typeof order.builder !== "string" ||
    typeof order.signature !== "string"
  ) {
    throw new Error("unknown signed order shape; expected V2 fields");
  }
  return order as SignedOrderV2;
}

export function hashSignedOrderV2(order: unknown, chainId: number, negRisk: boolean): string {
  const signed = requireV2Order(order);
  const contracts = getContractConfig(chainId);
  const verifyingContract = negRisk ? contracts.negRiskExchangeV2 : contracts.exchangeV2;
  if (!verifyingContract) throw new Error(`no V2 exchange contract for chain ${chainId}`);

  return hashTypedData({
    domain: { ...CLOB_V2_ORDER_DOMAIN, chainId, verifyingContract },
    types: { Order: CLOB_V2_ORDER_FIELDS },
    primaryType: "Order",
    message: {
      salt: signed.salt,
      maker: signed.maker,
      signer: signed.signer,
      tokenId: signed.tokenId,
      makerAmount: signed.makerAmount,
      takerAmount: signed.takerAmount,
      side: signed.side === "BUY" ? 0 : 1,
      signatureType: signed.signatureType,
      timestamp: signed.timestamp,
      metadata: signed.metadata,
      builder: signed.builder,
    },
  } as never);
}

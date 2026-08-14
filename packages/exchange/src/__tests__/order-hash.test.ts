import { getContractConfig } from "@polymarket/clob-client-v2";
import { describe, expect, it } from "vitest";
import {
  CLOB_V2_ORDER_DOMAIN,
  CLOB_V2_ORDER_FIELDS,
  hashSignedOrderV2,
} from "../live/order-hash.js";

const order = {
  salt: "123456789",
  maker: "0x1111111111111111111111111111111111111111",
  signer: "0x2222222222222222222222222222222222222222",
  tokenId: "9876543210123456789",
  makerAmount: "5000000",
  takerAmount: "10000000",
  side: "BUY" as const,
  signatureType: 1,
  timestamp: "1700000000000",
  metadata: `0x${"00".repeat(32)}`,
  builder: `0x${"ab".repeat(32)}`,
  expiration: "0",
  signature: "0xsignature",
};

describe("hashSignedOrderV2", () => {
  it("matches the audited standard V2 vector", () => {
    expect(hashSignedOrderV2(order, 137, false)).toBe(
      "0xa2b09ce8441ecb0330c23b0622ccf7ffb3a9341b485f1748d08a983182c5a52d",
    );
  });

  it("matches the audited neg-risk V2 vector", () => {
    expect(hashSignedOrderV2(order, 137, true)).toBe(
      "0x236a095ec8781b4e3853194dda31376d3e00a60d501a218f301211270cc4aa92",
    );
  });

  it("uses the pinned V2 domain, contracts and field schema", () => {
    const contracts = getContractConfig(137);
    expect(CLOB_V2_ORDER_DOMAIN).toEqual({ name: "Polymarket CTF Exchange", version: "2" });
    expect(contracts.exchangeV2).toBe("0xE111180000d2663C0091e4f400237545B87B996B");
    expect(contracts.negRiskExchangeV2).toBe("0xe2222d279d744050d28e00520010520000310F59");
    expect(CLOB_V2_ORDER_FIELDS).toEqual([
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
    ]);
  });

  it("refuses V1 and unknown signed-order shapes", () => {
    expect(() => hashSignedOrderV2({ ...order, taker: order.maker }, 137, false)).toThrow(
      "V1 signed orders are not supported",
    );
    expect(() => hashSignedOrderV2({ salt: order.salt }, 137, false)).toThrow(
      "unknown signed order shape",
    );
  });
});

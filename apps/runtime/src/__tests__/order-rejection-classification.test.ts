import { describe, expect, it } from "vitest";
import {
  createCommandId,
  createConditionId,
  createTokenId,
  ExchangeErrorCode,
  type ClientOrderId,
} from "@plankton/domain";
import {
  isGatewayOrderReject,
  type OrderRejectedEvent,
} from "../order-rejection-classification.js";

function makeOrderRejectedEvent(overrides: Partial<OrderRejectedEvent> = {}): OrderRejectedEvent {
  return {
    commandId: createCommandId("cmd-reject"),
    clientOrderId: "client-reject" as ClientOrderId,
    tokenId: createTokenId("token-reject"),
    conditionId: createConditionId("condition-reject"),
    reason: "wallet_buy_capacity_exhausted",
    errorCode: ExchangeErrorCode.InsufficientBalance,
    signalReason: "probe-entry",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("isGatewayOrderReject", () => {
  it("does not classify internal capacity rejects as gateway rejects", () => {
    expect(isGatewayOrderReject(makeOrderRejectedEvent())).toBe(false);
  });

  it("classifies rejects with exchange error details as gateway rejects", () => {
    expect(
      isGatewayOrderReject(
        makeOrderRejectedEvent({
          reason: "exchange-insufficient-balance-or-allowance",
          exchangeErrorDetails: { responseBody: "insufficient balance" },
        }),
      ),
    ).toBe(true);
  });

  it("classifies rejects with exchange error message as gateway rejects", () => {
    expect(
      isGatewayOrderReject(
        makeOrderRejectedEvent({
          reason: "exchange rejected order",
          exchangeErrorMessage: "not enough balance / allowance",
        }),
      ),
    ).toBe(true);
  });
});

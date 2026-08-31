import { describe, expect, it } from "vitest";
import { classifyExchangeRejectionReason } from "../exchange-rejection-classifier.js";

describe("classifyExchangeRejectionReason", () => {
  it("classifies not enough balance bodies", () => {
    expect(
      classifyExchangeRejectionReason({
        responseBody: {
          error: "not enough balance / allowance: the balance is not enough",
        },
      }),
    ).toBe("rejection_balance_insufficient");
  });

  it("classifies not enough allowance bodies", () => {
    expect(
      classifyExchangeRejectionReason({
        responseBody: {
          error: "not enough allowance for token",
        },
      }),
    ).toBe("rejection_balance_insufficient");
  });

  it("classifies lower-than-minimum size bodies", () => {
    expect(
      classifyExchangeRejectionReason({
        responseBody: {
          error: "order is invalid. Size (3) lower than the minimum: 5",
        },
      }),
    ).toBe("rejection_min_size");
  });

  it("classifies post-only cross bodies", () => {
    expect(
      classifyExchangeRejectionReason({
        responseBody: {
          error: "invalid post-only order: order crosses book",
        },
      }),
    ).toBe("rejection_post_only_cross");
  });

  it("classifies missing-order-id internal envelopes", () => {
    expect(
      classifyExchangeRejectionReason({ responseBody: null, reason: "missing-order-id" }),
    ).toBe("rejection_missing_order_id");
  });

  it("uses deterministic precedence for multi-string payloads", () => {
    expect(
      classifyExchangeRejectionReason({
        responseBody: {
          error: "not enough balance",
          details: "Size (3) lower than the minimum: 5",
        },
      }),
    ).toBe("rejection_balance_insufficient");
  });

  it("ignores strings deeper than the recursion cap", () => {
    expect(
      classifyExchangeRejectionReason({
        a: { b: { c: { d: { e: { f: { g: { h: "not enough balance" } } } } } } },
      }),
    ).toBe("rejection_no_payload");
  });

  it("returns unknown for non-empty unrecognized bodies", () => {
    expect(
      classifyExchangeRejectionReason({
        responseBody: {
          error: "some future CLOB error",
        },
      }),
    ).toBe("rejection_unknown");
  });

  it("returns no-payload for null payload", () => {
    expect(classifyExchangeRejectionReason(null)).toBe("rejection_no_payload");
  });

  it("returns no-payload for empty string payload", () => {
    expect(classifyExchangeRejectionReason("")).toBe("rejection_no_payload");
  });

  it("classifies invalid tick size bodies", () => {
    expect(
      classifyExchangeRejectionReason({
        responseBody: {
          error: "invalid tick size",
        },
      }),
    ).toBe("rejection_invalid_tick");
  });

  it("classifies minimum-for-the-market-is bodies", () => {
    expect(
      classifyExchangeRejectionReason({
        responseBody: {
          error: "the minimum for the market is 0.01",
        },
      }),
    ).toBe("rejection_invalid_tick");
  });

  it("classifies invalid tick size as plain string payload", () => {
    expect(classifyExchangeRejectionReason("invalid tick size")).toBe("rejection_invalid_tick");
  });

  it.each([
    { status: 503, error: " Trading Is Disabled " },
    { status: 503, message: "trading is disabled" },
    { responseBody: { status: 503, error: "trading is disabled" } },
    { errorDetails: { responseBody: { status: 503, message: "TRADING IS DISABLED" } } },
  ])("classifies only structurally exact trading-disabled responses", (payload) => {
    expect(classifyExchangeRejectionReason(payload)).toBe("rejection_trading_disabled");
  });

  it.each([
    { status: "503", error: "trading is disabled" },
    { status: 503, error: "trading is disabled right now" },
    { status: 503, error: "service unavailable" },
    Object.assign(new Error("trading is disabled"), { status: 503 }),
    { errorDetails: { responseBody: { status: 503, error: "generic outage" } } },
  ])("keeps near, thrown, and generic 503 outcomes unknown", (payload) => {
    expect(classifyExchangeRejectionReason(payload)).toBe("rejection_unknown");
  });
});

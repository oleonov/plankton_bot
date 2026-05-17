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
});

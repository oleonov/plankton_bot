import { describe, it, expect } from "vitest";
import { classifyError } from "../errors.js";

describe("classifyError", () => {
  it("maps insufficient balance", () => {
    expect(classifyError(new Error("Insufficient balance")).code).toBe("INSUFFICIENT_BALANCE");
    expect(classifyError(new Error("not enough funds")).code).toBe("INSUFFICIENT_BALANCE");
  });

  it("maps axios-like insufficient balance responses and redacts auth headers", () => {
    const err = new Error("Request failed");
    Object.assign(err, {
      response: {
        status: 400,
        data: {
          error: "not enough balance / allowance: balance: 43130000",
        },
      },
      config: {
        headers: {
          POLY_API_KEY: "api-key-value",
          POLY_BUILDER_SIGNATURE: "builder-signature-value",
        },
      },
    });

    const result = classifyError(err);

    expect(result.code).toBe("INSUFFICIENT_BALANCE");
    expect(result.message).toContain("not enough balance / allowance");
    expect(result.details).toMatchObject({ status: 400 });
    expect(result.message).not.toContain("api-key-value");
    expect(result.message).not.toContain("builder-signature-value");
  });

  it("maps invalid price", () => {
    expect(classifyError(new Error("invalid price")).code).toBe("INVALID_PRICE");
    expect(classifyError(new Error("Price must be between 0 and 1")).code).toBe("INVALID_PRICE");
  });

  it("maps invalid size", () => {
    expect(classifyError(new Error("invalid size")).code).toBe("INVALID_SIZE");
    expect(classifyError(new Error("min order size")).code).toBe("INVALID_SIZE");
  });

  it("maps duplicate order", () => {
    expect(classifyError(new Error("Duplicate order")).code).toBe("DUPLICATE_CLIENT_ORDER_ID");
    expect(classifyError(new Error("Order already exists")).code).toBe("DUPLICATE_CLIENT_ORDER_ID");
  });

  it("maps order not found", () => {
    expect(classifyError(new Error("order not found")).code).toBe("ORDER_NOT_FOUND");
    expect(classifyError(new Error("order_not_found")).code).toBe("ORDER_NOT_FOUND");
  });

  it("maps market not found", () => {
    expect(classifyError(new Error("Market not found")).code).toBe("MARKET_NOT_FOUND");
  });

  it("maps market closed", () => {
    expect(classifyError(new Error("Market closed")).code).toBe("MARKET_CLOSED");
    expect(classifyError(new Error("closed_only mode")).code).toBe("MARKET_CLOSED");
  });

  it("maps rate limited", () => {
    expect(classifyError(new Error("Rate limit exceeded")).code).toBe("RATE_LIMITED");
    expect(classifyError(new Error("Too many requests")).code).toBe("RATE_LIMITED");
  });

  it("maps nonce error", () => {
    expect(classifyError(new Error("Invalid nonce")).code).toBe("NONCE_ERROR");
  });

  it("maps network errors", () => {
    expect(classifyError(new Error("Network error")).code).toBe("NETWORK_ERROR");
    expect(classifyError(new Error("ECONNREFUSED")).code).toBe("NETWORK_ERROR");
    expect(classifyError(new Error("Request timeout")).code).toBe("NETWORK_ERROR");
    expect(classifyError(new Error("fetch failed")).code).toBe("NETWORK_ERROR");
  });

  it("maps auth errors", () => {
    expect(classifyError(new Error("Unauthorized")).code).toBe("AUTHENTICATION_FAILED");
    expect(classifyError(new Error("403 forbidden")).code).toBe("AUTHENTICATION_FAILED");
    expect(classifyError(new Error("Authentication failed")).code).toBe("AUTHENTICATION_FAILED");
  });

  it("returns UNKNOWN for unrecognized errors", () => {
    expect(classifyError(new Error("Something weird happened")).code).toBe("UNKNOWN");
  });

  it("handles non-Error objects", () => {
    const result = classifyError("string error");
    expect(result.code).toBe("UNKNOWN");
    expect(result.message).toBe("string error");
  });
});

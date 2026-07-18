import { describe, expect, it } from "vitest";
import { isRateLimitError, isTransientNetworkError } from "../network-errors.js";

describe("exchange isTransientNetworkError", () => {
  it.each([
    "Gamma API responded with 500: Internal Server Error",
    "Gamma API responded with 502: Bad Gateway",
    "Gamma API responded with 503: Service Unavailable",
    "Gamma API responded with 504: Gateway Timeout",
  ])("treats Gamma 5xx response errors as transient: %s", (message) => {
    expect(isTransientNetworkError(new Error(message))).toBe(true);
  });

  it.each(["Gamma API responded with 400: Bad Request", "Gamma API responded with 404: Not Found"])(
    "does not treat permanent Gamma 4xx as transient: %s",
    (message) => {
      expect(isTransientNetworkError(new Error(message))).toBe(false);
    },
  );

  it.each([
    "Gamma API responded with 403: Forbidden",
    "Gamma pricing request failed: 403 Forbidden",
  ])("treats a Gamma 403 (rate-limit/WAF throttling) as transient: %s", (message) => {
    expect(isTransientNetworkError(new Error(message))).toBe(true);
  });

  it.each(["403", "Forbidden", "Request failed with status code 403"])(
    "does not treat a non-Gamma-prefixed 403 as transient (scope guard): %s",
    (message) => {
      expect(isTransientNetworkError(new Error(message))).toBe(false);
    },
  );
});

describe("exchange isRateLimitError", () => {
  it("does not classify a Gamma 403 as a rate-limit error (kept in the transient bucket)", () => {
    expect(isRateLimitError(new Error("Gamma API responded with 403: Forbidden"))).toBe(false);
  });
});

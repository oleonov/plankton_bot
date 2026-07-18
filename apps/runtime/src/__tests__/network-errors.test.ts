import { describe, expect, it } from "vitest";
import { classifyHttpError, isRateLimitError, isTransientNetworkError } from "../network-errors.js";

describe("isTransientNetworkError", () => {
  it.each([
    "Gamma API responded with 500: Internal Server Error",
    "Gamma API responded with 502: Bad Gateway",
    "Gamma API responded with 503: Service Unavailable",
    "Gamma API responded with 504: Gateway Timeout",
  ])("treats scanner Gamma 5xx as transient: %s", (message) => {
    expect(isTransientNetworkError(new Error(message))).toBe(true);
  });

  it.each(["Gamma API responded with 400: Bad Request", "Gamma API responded with 404: Not Found"])(
    "does not treat scanner Gamma 4xx as transient: %s",
    (message) => {
      expect(isTransientNetworkError(new Error(message))).toBe(false);
    },
  );

  it.each([
    "Gamma API responded with 403: Forbidden",
    "Gamma pricing request failed: 403 Forbidden",
  ])("treats a scanner Gamma 403 (rate-limit/WAF throttling) as transient: %s", (message) => {
    expect(isTransientNetworkError(new Error(message))).toBe(true);
  });

  it.each(["403", "Forbidden", "Request failed with status code 403"])(
    "does not treat a non-Gamma-prefixed 403 as transient (scope guard): %s",
    (message) => {
      expect(isTransientNetworkError(new Error(message))).toBe(false);
    },
  );
});

describe("isRateLimitError", () => {
  it("does not classify a Gamma 403 as a rate-limit error", () => {
    expect(isRateLimitError(new Error("Gamma API responded with 403: Forbidden"))).toBe(false);
  });
});

describe("classifyHttpError", () => {
  it.each([
    ["Gamma pricing request failed: 429 Too Many Requests", "rate_limit"],
    ["TimeoutError: operation was aborted due to timeout", "timeout"],
    ["socket hang up", "tls_or_socket"],
    ["getaddrinfo ENOTFOUND gamma-api.polymarket.com", "dns"],
    ["Gamma API responded with 500: Internal Server Error", "server_5xx"],
    ["Gamma pricing request failed: 503 Service Unavailable", "server_5xx"],
    ["Gamma pricing request failed: 400 Bad Request", "client_4xx"],
    // Gamma 403 is transient for the RETRY decision but still labels as client_4xx for telemetry.
    ["Gamma API responded with 403: Forbidden", "client_4xx"],
    ["unexpected failure", "unknown"],
  ] as const)("classifies %s as %s", (message, expected) => {
    expect(classifyHttpError(new Error(message))).toBe(expected);
  });
});

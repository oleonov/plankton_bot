import { describe, expect, it } from "vitest";
import { classifyHttpError, isTransientNetworkError } from "../network-errors.js";

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
    ["unexpected failure", "unknown"],
  ] as const)("classifies %s as %s", (message, expected) => {
    expect(classifyHttpError(new Error(message))).toBe(expected);
  });
});

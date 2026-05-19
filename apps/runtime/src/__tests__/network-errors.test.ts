import { describe, expect, it } from "vitest";
import { classifyHttpError } from "../network-errors.js";

describe("classifyHttpError", () => {
  it.each([
    ["Gamma pricing request failed: 429 Too Many Requests", "rate_limit"],
    ["TimeoutError: operation was aborted due to timeout", "timeout"],
    ["socket hang up", "tls_or_socket"],
    ["getaddrinfo ENOTFOUND gamma-api.polymarket.com", "dns"],
    ["Gamma pricing request failed: 503 Service Unavailable", "server_5xx"],
    ["Gamma pricing request failed: 400 Bad Request", "client_4xx"],
    ["unexpected failure", "unknown"],
  ] as const)("classifies %s as %s", (message, expected) => {
    expect(classifyHttpError(new Error(message))).toBe(expected);
  });
});

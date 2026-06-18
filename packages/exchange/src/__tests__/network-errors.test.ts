import { describe, expect, it } from "vitest";
import { isTransientNetworkError } from "../network-errors.js";

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
});

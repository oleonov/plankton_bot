/**
 * Tests for installClobErrorSanitizer + sanitizeAxiosError.
 *
 * Regression: @polymarket/clob-client@4.22.8 calls
 *   JSON.stringify({ ..., config: err.response.config })
 * during error logging. err.response.config carries the keep-alive
 * https.Agent which holds circular references to live ClientRequest
 * objects. JSON.stringify throws TypeError, masking the real exchange
 * error (e.g. "not enough balance") behind a "Converting circular
 * structure to JSON" message and an UNKNOWN classification.
 *
 * sanitizeAxiosError must remove the offending fields so the SDK's
 * serialization succeeds and the real error reaches our classifier.
 */
import { describe, it, expect } from "vitest";
import { installClobErrorSanitizer, sanitizeAxiosError } from "../live/clob-error-sanitizer.js";

function buildCircularConfig(): Record<string, unknown> {
  const agent: Record<string, unknown> = { keepAlive: true };
  const sockets: Record<string, unknown[]> = {};
  const request: Record<string, unknown> = { agent };
  sockets["clob.polymarket.com:443"] = [{ _httpMessage: request }];
  agent["sockets"] = sockets;
  request["agent"] = agent;
  return {
    method: "post",
    url: "https://clob.polymarket.com/order",
    httpsAgent: agent,
    transformRequest: [() => null],
    transformResponse: [() => null],
    adapter: () => null,
  };
}

function buildBalanceError(): {
  isAxiosError: true;
  config: Record<string, unknown>;
  response: { status: number; data: { error: string }; config: Record<string, unknown> };
} {
  return {
    isAxiosError: true,
    config: buildCircularConfig(),
    response: {
      status: 400,
      data: { error: "not enough balance / allowance: balance 1958089, order 8379000" },
      config: buildCircularConfig(),
    },
  };
}

describe("sanitizeAxiosError", () => {
  it("makes a circular axios error JSON-serializable while preserving response data", () => {
    const err = buildBalanceError();
    expect(() => JSON.stringify(err)).toThrow(TypeError);

    sanitizeAxiosError(err);

    expect(() => JSON.stringify(err)).not.toThrow();
    expect(err.response.data.error).toContain("not enough balance");
    expect(err.response.config).not.toHaveProperty("httpsAgent");
    expect(err.config).not.toHaveProperty("httpsAgent");
  });

  it("is a no-op on non-object inputs", () => {
    expect(() => sanitizeAxiosError(null)).not.toThrow();
    expect(() => sanitizeAxiosError(undefined)).not.toThrow();
    expect(() => sanitizeAxiosError("boom")).not.toThrow();
    expect(() => sanitizeAxiosError(42)).not.toThrow();
  });

  it("tolerates errors without config or response", () => {
    const err = { message: "bare error" };
    expect(() => sanitizeAxiosError(err)).not.toThrow();
    expect(err).toEqual({ message: "bare error" });
  });
});

describe("installClobErrorSanitizer", () => {
  function fakeAxios(): {
    instance: { interceptors: { response: { use: typeof use } } };
    handlers: Array<(error: unknown) => unknown>;
  } {
    const handlers: Array<(error: unknown) => unknown> = [];
    function use(_onFulfilled: unknown, onRejected: (error: unknown) => unknown): number {
      handlers.push(onRejected);
      return handlers.length - 1;
    }
    return {
      instance: { interceptors: { response: { use } } },
      handlers,
    };
  }

  it("registers an error interceptor that sanitizes and re-rejects", async () => {
    const { instance, handlers } = fakeAxios();
    installClobErrorSanitizer(instance);
    expect(handlers).toHaveLength(1);

    const err = buildBalanceError();
    await expect(handlers[0]!(err)).rejects.toBe(err);
    expect(() => JSON.stringify(err)).not.toThrow();
  });

  it("is idempotent on the same instance", () => {
    const { instance, handlers } = fakeAxios();
    installClobErrorSanitizer(instance);
    installClobErrorSanitizer(instance);
    installClobErrorSanitizer(instance);
    expect(handlers).toHaveLength(1);
  });

  it("registers separately on distinct instances", () => {
    const a = fakeAxios();
    const b = fakeAxios();
    installClobErrorSanitizer(a.instance);
    installClobErrorSanitizer(b.instance);
    expect(a.handlers).toHaveLength(1);
    expect(b.handlers).toHaveLength(1);
  });
});

import { describe, it, expect } from "vitest";
import {
  classifyFetchError,
  isRetryableReason,
  FetchParseError,
} from "../clob-error-classifier.js";

// Helpers that build the error shapes the CLOB client actually produces.
function thrown(message: string, status?: number, code?: string): Error {
  const err = new Error(message);
  if (status !== undefined) Object.assign(err, { status });
  if (code !== undefined) Object.assign(err, { code });
  return err;
}
function axios(message: string, status: number): Error {
  const err = new Error(message);
  Object.assign(err, { response: { status } });
  return err;
}
function returned(error: string, status?: number): Record<string, unknown> {
  // throwOnError=false path: the client RETURNS { error, status } instead of throwing.
  return status === undefined ? { error } : { error, status };
}

describe("classifyFetchError — status-first", () => {
  it("CRITICAL: 429 Too Many Requests → rate_limit (closes isTransientAxiosError gap)", () => {
    expect(classifyFetchError(thrown("rate limited", 429))).toBe("rate_limit");
    expect(classifyFetchError(returned("too many requests", 429))).toBe("rate_limit");
    expect(classifyFetchError(axios("Request failed with status code 429", 429))).toBe(
      "rate_limit",
    );
    expect(isRetryableReason(classifyFetchError(thrown("x", 429)))).toBe(true);
  });

  it("CRITICAL: 408 Request Timeout → rate_limit (transient, retryable)", () => {
    expect(classifyFetchError(thrown("request timeout", 408))).toBe("rate_limit");
    expect(classifyFetchError(returned("timeout", 408))).toBe("rate_limit");
    expect(isRetryableReason(classifyFetchError(thrown("x", 408)))).toBe(true);
  });

  it("5xx → server (transient)", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyFetchError(thrown("server error", status))).toBe("server");
      expect(isRetryableReason("server")).toBe(true);
    }
    expect(classifyFetchError(axios("Bad Gateway", 502))).toBe("server");
  });

  it("4xx (other than 429/408) → client (permanent, NOT retryable)", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyFetchError(thrown("bad request", status))).toBe("client");
    }
    expect(isRetryableReason("client")).toBe(false);
    expect(classifyFetchError(returned("invalid", 400))).toBe("client");
  });

  it("status wins over a transient-looking message (status-first)", () => {
    // 400 body that happens to contain the word "timeout" stays permanent.
    expect(classifyFetchError(thrown("operation timeout", 400))).toBe("client");
  });
});

describe("classifyFetchError — network/socket codes", () => {
  it("socket codes (err.code) → timeout (transient)", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH"]) {
      expect(classifyFetchError(thrown("socket failure", undefined, code))).toBe("timeout");
    }
  });

  it("undici UND_ERR_ code → timeout", () => {
    expect(classifyFetchError(thrown("fetch failed", undefined, "UND_ERR_SOCKET"))).toBe("timeout");
  });
});

describe("classifyFetchError — message substrings (permanent BEFORE transient)", () => {
  it("permanent business strings → client (no retry)", () => {
    expect(
      classifyFetchError(thrown("invalid tick size (0.001), minimum for the market is 0.01")),
    ).toBe("client");
    expect(classifyFetchError(returned("not enough balance / allowance"))).toBe("client");
    expect(classifyFetchError(thrown("invalid amount for a market order"))).toBe("client");
    expect(classifyFetchError(thrown("order has crosses book"))).toBe("client");
    expect(classifyFetchError(thrown("market is inactive"))).toBe("client");
  });

  it("transient server strings → server (retryable)", () => {
    expect(classifyFetchError(thrown("order manager not ready"))).toBe("server");
    expect(classifyFetchError(returned("service not ready"))).toBe("server");
    expect(classifyFetchError(thrown("503 Service Unavailable"))).toBe("server");
  });

  it("transient timeout/socket strings → timeout", () => {
    expect(classifyFetchError(thrown("socket hang up"))).toBe("timeout");
    expect(classifyFetchError(thrown("request timed out"))).toBe("timeout");
    expect(classifyFetchError(thrown("fetch failed"))).toBe("timeout");
  });

  it("permanent is checked BEFORE transient — a permanent message with 'timeout' stays client", () => {
    expect(
      classifyFetchError(thrown("invalid tick size for market — upstream request timeout")),
    ).toBe("client");
  });

  it("rate-limit message without status → rate_limit", () => {
    expect(classifyFetchError(thrown("Too Many Requests"))).toBe("rate_limit");
    expect(classifyFetchError(thrown("rate limit exceeded"))).toBe("rate_limit");
  });
});

describe("classifyFetchError — parse + unknown", () => {
  it("FetchParseError → parse (NOT retryable — our parsing bug, not transport)", () => {
    expect(classifyFetchError(new FetchParseError("response was not an array"))).toBe("parse");
    expect(isRetryableReason("parse")).toBe(false);
  });

  it("no status, no code, unrecognised message → unknown (conservative transient)", () => {
    expect(classifyFetchError(thrown("something completely unexpected happened"))).toBe("unknown");
    expect(classifyFetchError("plain string failure")).toBe("unknown");
    expect(isRetryableReason("unknown")).toBe(true);
  });
});

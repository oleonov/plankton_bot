import { describe, expect, it } from "vitest";
import {
  isSettlementInfraRateLimitError,
  parseRpcRateLimitResetMs,
  SettlementInfraBreaker,
} from "../modules/settlement-infra-breaker.js";

describe("SettlementInfraBreaker", () => {
  it("parses provider reset windows from 429 messages", () => {
    expect(
      parseRpcRateLimitResetMs(
        new Error(
          '{"error":"request error","status":429,"data":{"error":"quota exceeded: 0 units remaining, resets in 3238 seconds"}}',
        ),
      ),
    ).toBe(3_238_000);
  });

  it("uses the upstream reset when it is longer than the default pause", () => {
    let now = 1_000;
    const breaker = new SettlementInfraBreaker({ now: () => now });

    const pause = breaker.pause(
      "POLYGON_RPC_RATE_LIMITED",
      new Error("quota exceeded: 0 units remaining, resets in 600 seconds"),
    );

    expect(pause).toMatchObject({
      code: "POLYGON_RPC_RATE_LIMITED",
      pauseMs: 600_000,
      upstreamPauseMs: 600_000,
      until: 601_000,
    });
    expect(breaker.isOpen()).toBe(true);

    now = 601_001;
    expect(breaker.isOpen()).toBe(false);
  });

  it("detects settlement infra rate-limit errors shared by settlement callers", () => {
    for (const message of [
      "429",
      "rate limit",
      "too many requests",
      "throughput limit",
      "quota exceeded",
      "exceeded its compute units",
    ]) {
      expect(isSettlementInfraRateLimitError(new Error(message))).toBe(true);
    }

    expect(isSettlementInfraRateLimitError(new Error("transaction reverted"))).toBe(false);
  });
});

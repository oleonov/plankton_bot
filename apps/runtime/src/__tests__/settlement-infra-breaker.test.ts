import { describe, expect, it } from "vitest";
import {
  isSettlementInfraRateLimitError,
  isZeroBalancePrecheckSkipError,
  parseRpcRateLimitResetMs,
  SettlementInfraBreaker,
  type SettlementInfraPauseStore,
} from "../modules/settlement-infra-breaker.js";

function memoryStore(
  initial: { disabledUntilMs: number; code: string | null } | null = null,
): SettlementInfraPauseStore & { saved: Array<{ disabledUntilMs: number; code: string | null }> } {
  let record = initial;
  return {
    saved: [],
    load: () => record,
    save(disabledUntilMs: number, code: string | null) {
      record = { disabledUntilMs, code };
      this.saved.push({ disabledUntilMs, code });
    },
  };
}

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

describe("isZeroBalancePrecheckSkipError", () => {
  it("matches the relayer zero-position-balance precheck envelope", () => {
    expect(
      isZeroBalancePrecheckSkipError(
        new Error(
          '{"error":"request error","status":400,"data":{"error":"PRECHECK_SKIPPED: redeem skipped: zero position balance"}}',
        ),
      ),
    ).toBe(true);
  });

  it("does NOT match a generic PRECHECK_SKIPPED with another reason", () => {
    expect(isZeroBalancePrecheckSkipError(new Error("PRECHECK_SKIPPED: nothing to do"))).toBe(
      false,
    );
  });

  it("does NOT match unrelated or rate-limit errors", () => {
    expect(isZeroBalancePrecheckSkipError(new Error("429 too many requests"))).toBe(false);
    expect(isZeroBalancePrecheckSkipError(new Error("zero position balance"))).toBe(false);
    expect(isZeroBalancePrecheckSkipError(null)).toBe(false);
  });
});

describe("SettlementInfraBreaker persistence", () => {
  it("persists the open window when it trips", () => {
    const store = memoryStore();
    const breaker = new SettlementInfraBreaker({ now: () => 1_000, store });

    breaker.pause("POLYGON_RPC_RATE_LIMITED", new Error("resets in 600 seconds"));

    expect(store.saved.at(-1)).toMatchObject({
      disabledUntilMs: 601_000,
      code: "POLYGON_RPC_RATE_LIMITED",
    });
  });

  it("re-arms an open window after a simulated restart", () => {
    let now = 1_000;
    const store = memoryStore();
    const first = new SettlementInfraBreaker({ now: () => now, store });
    first.pause("POLYGON_RPC_RATE_LIMITED", new Error("resets in 600 seconds"));

    // Fresh process reads the persisted window — pause is still in effect.
    const restarted = new SettlementInfraBreaker({ now: () => now, store });
    expect(restarted.isOpen()).toBe(true);

    now = 601_001;
    expect(restarted.isOpen()).toBe(false);
  });

  it("does not re-arm an already-expired window after a restart", () => {
    const store = memoryStore({ disabledUntilMs: 500, code: "POLYGON_RPC_RATE_LIMITED" });
    const breaker = new SettlementInfraBreaker({ now: () => 1_000, store });
    expect(breaker.isOpen()).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { executeWithRetry } from "../retry-helper.js";
import { classifyFetchError, FetchParseError } from "../clob-error-classifier.js";
import type { FetchReason } from "../fetch-result.js";

function statusError(status: number): Error {
  const err = new Error(`HTTP ${status}`);
  Object.assign(err, { status });
  return err;
}

function makeConfig(overrides?: Partial<{ retries: number; backoffMs: number[] }>) {
  const slept: number[] = [];
  const retried: FetchReason[] = [];
  return {
    slept,
    retried,
    config: {
      retries: overrides?.retries ?? 3,
      backoffMs: overrides?.backoffMs ?? [10, 20, 30],
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      source: "open_orders" as const,
      onRetry: (reason: FetchReason) => {
        retried.push(reason);
      },
    },
  };
}

describe("executeWithRetry", () => {
  it("returns ok:true on first success — no sleep, no retry", async () => {
    const { config, slept, retried } = makeConfig();
    let calls = 0;
    const result = await executeWithRetry(
      async () => {
        calls++;
        return [1, 2, 3];
      },
      classifyFetchError,
      config,
    );
    expect(result).toEqual({ ok: true, data: [1, 2, 3] });
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
    expect(retried).toEqual([]);
  });

  it("retries a transient failure then succeeds, sleeping with backoff", async () => {
    const { config, slept, retried } = makeConfig();
    let calls = 0;
    const result = await executeWithRetry(
      async () => {
        calls++;
        if (calls === 1) throw statusError(503);
        return "ok";
      },
      classifyFetchError,
      config,
    );
    expect(result).toEqual({ ok: true, data: "ok" });
    expect(calls).toBe(2);
    expect(slept).toEqual([10]);
    expect(retried).toEqual(["server"]);
  });

  it("exhausts retries on persistent transient → ok:false with attempts === retries+1", async () => {
    const { config, slept, retried } = makeConfig({ retries: 3, backoffMs: [10, 20, 30] });
    let calls = 0;
    const result = await executeWithRetry(
      async () => {
        calls++;
        throw statusError(429);
      },
      classifyFetchError,
      config,
    );
    expect(result).toEqual({ ok: false, reason: "rate_limit", attempts: 4 });
    expect(calls).toBe(4);
    expect(slept).toEqual([10, 20, 30]);
    expect(retried).toEqual(["rate_limit", "rate_limit", "rate_limit"]);
  });

  it("does NOT retry a permanent client error", async () => {
    const { config, slept, retried } = makeConfig();
    let calls = 0;
    const result = await executeWithRetry(
      async () => {
        calls++;
        throw statusError(400);
      },
      classifyFetchError,
      config,
    );
    expect(result).toEqual({ ok: false, reason: "client", attempts: 1 });
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
    expect(retried).toEqual([]);
  });

  it("does NOT retry a parse error", async () => {
    const { config } = makeConfig();
    let calls = 0;
    const result = await executeWithRetry(
      async () => {
        calls++;
        throw new FetchParseError("not an array");
      },
      classifyFetchError,
      config,
    );
    expect(result).toEqual({ ok: false, reason: "parse", attempts: 1 });
    expect(calls).toBe(1);
  });

  it("logs a structured diagnostic when an error is classified as unknown", async () => {
    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const log = {
      warn: (obj: Record<string, unknown>, msg: string) => {
        warnings.push({ obj, msg });
      },
    };
    const err = Object.assign(new Error("weird failure"), { status: 418, code: "ETEAPOT" });

    const result = await executeWithRetry(
      async () => {
        throw err;
      },
      () => "unknown" as FetchReason,
      { retries: 0, backoffMs: [], sleep: async () => {}, source: "fills", log },
    );

    expect(result).toEqual({ ok: false, reason: "unknown", attempts: 1 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.obj).toMatchObject({
      reason: "unknown",
      source: "fills",
      details: { status: 418, code: "ETEAPOT", message: "weird failure" },
    });
  });

  it("does not emit the unknown diagnostic for a recognized reason", async () => {
    const warnings: unknown[] = [];
    const log = {
      warn: (obj: Record<string, unknown>, msg: string) => {
        warnings.push({ obj, msg });
      },
    };

    await executeWithRetry(
      async () => {
        throw statusError(400);
      },
      classifyFetchError,
      { retries: 0, backoffMs: [], sleep: async () => {}, source: "open_orders" as const, log },
    );

    expect(warnings).toEqual([]);
  });

  it("retries=0 disables retries even for transient errors", async () => {
    const { config, slept } = makeConfig({ retries: 0, backoffMs: [] });
    let calls = 0;
    const result = await executeWithRetry(
      async () => {
        calls++;
        throw statusError(503);
      },
      classifyFetchError,
      config,
    );
    expect(result).toEqual({ ok: false, reason: "server", attempts: 1 });
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });
});

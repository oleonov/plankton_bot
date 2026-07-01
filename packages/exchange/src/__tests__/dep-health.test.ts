import { describe, it, expect } from "vitest";
import type { DepHealthRecorder, DepKey } from "@krabs/domain";
import { timeDepCall, fetchResultOk } from "../dep-health.js";

function fakeRecorder() {
  const calls: { dep: DepKey; latencyMs: number; ok: boolean }[] = [];
  const recorder: DepHealthRecorder = {
    record: (dep, latencyMs, ok) => {
      calls.push({ dep, latencyMs, ok });
    },
  };
  return { recorder, calls };
}

describe("timeDepCall (measure-only)", () => {
  it("returns the wrapped value unchanged and records ok", async () => {
    const { recorder, calls } = fakeRecorder();
    const out = await timeDepCall(recorder, "clob", async () => 42);
    expect(out).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.dep).toBe("clob");
    expect(calls[0]!.ok).toBe(true);
    expect(calls[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("propagates the thrown error unchanged and records a fail", async () => {
    const { recorder, calls } = fakeRecorder();
    const boom = new Error("network down");
    await expect(
      timeDepCall(recorder, "rpc", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(calls).toEqual([expect.objectContaining({ dep: "rpc", ok: false })]);
  });

  it("classifies ok/fail from the isOk predicate, not just !threw", async () => {
    const { recorder, calls } = fakeRecorder();
    await timeDepCall(recorder, "gamma", async () => ({ error: "bad" }), {
      isOk: (v: { error?: string }) => v.error === undefined,
    });
    expect(calls[0]!.ok).toBe(false);
  });

  it("skips recording when shouldRecord returns false (no-op call)", async () => {
    const { recorder, calls } = fakeRecorder();
    const out = await timeDepCall(recorder, "relayer", async () => ({ status: "skipped" }), {
      shouldRecord: (v: { status: string }) => v.status !== "skipped",
    });
    expect(out).toEqual({ status: "skipped" });
    expect(calls).toHaveLength(0);
  });

  it("is a transparent pass-through with no recorder (no behaviour change)", async () => {
    const out = await timeDepCall(null, "clob", async () => "value");
    expect(out).toBe("value");
    await expect(
      timeDepCall(undefined, "clob", async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
  });

  it("a recorder that throws never affects the wrapped call", async () => {
    const recorder: DepHealthRecorder = {
      record: () => {
        throw new Error("telemetry boom");
      },
    };
    await expect(timeDepCall(recorder, "clob", async () => "ok")).resolves.toBe("ok");
  });

  it("fetchResultOk maps a FetchResult to ok/fail", () => {
    expect(fetchResultOk({ ok: true, data: [] })).toBe(true);
    expect(fetchResultOk({ ok: false, reason: "unknown", attempts: 3 })).toBe(false);
  });
});

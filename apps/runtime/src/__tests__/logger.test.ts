import { describe, it, expect, vi } from "vitest";
import { compactErrSerializer, createLogger } from "../logger.js";

describe("emitted error observation", () => {
  it("observes child errors and fatal levels without exposing log objects and fails open", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const observed = vi.fn();
      const logger = createLogger("error", "test", observed);
      const child = logger.child({ module: "execution" }).child({ tokenId: "not-a-category" });
      child.warn("filtered");
      child.error({ authorization: "test-private", err: new Error("private-message") }, "error");
      child.fatal("fatal");
      expect(observed.mock.calls).toEqual([
        [50, "execution"],
        [60, "execution"],
      ]);
      observed.mockImplementation(() => {
        throw new Error("sink unavailable");
      });
      expect(() => child.error("still emitted")).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("compactErrSerializer", () => {
  it("strips DOMException enum constants (INDEX_SIZE_ERR..DATA_CLONE_ERR)", () => {
    const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const out = compactErrSerializer(err) as Record<string, unknown>;

    expect(out.type).toBe("DOMException");
    expect(out.message).toBe("The operation was aborted due to timeout");
    expect(typeof out.stack).toBe("string");
    expect(out.code).toBe(23);
    // Must NOT include native DOMException enum constants
    expect(out.INDEX_SIZE_ERR).toBeUndefined();
    expect(out.DOMSTRING_SIZE_ERR).toBeUndefined();
    expect(out.HIERARCHY_REQUEST_ERR).toBeUndefined();
    expect(out.DATA_CLONE_ERR).toBeUndefined();
    expect(out.TIMEOUT_ERR).toBeUndefined();
  });

  it("preserves cause chain recursively", () => {
    const root = new Error("root cause");
    const wrapped = new Error("wrapped", { cause: root });
    const out = compactErrSerializer(wrapped) as Record<string, unknown>;
    const cause = out.cause as Record<string, unknown>;

    expect(out.message).toBe("wrapped");
    expect(cause.message).toBe("root cause");
  });

  it("preserves code field on plain Error", () => {
    const err = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const out = compactErrSerializer(err) as Record<string, unknown>;

    expect(out.message).toBe("connection refused");
    expect(out.code).toBe("ECONNREFUSED");
  });

  it("handles AggregateError via `errors` array", () => {
    const err = new AggregateError([new Error("a"), new Error("b")], "multi");
    const out = compactErrSerializer(err) as Record<string, unknown>;
    const errors = out.errors as Array<Record<string, unknown>>;

    expect(out.message).toBe("multi");
    expect(errors).toHaveLength(2);
    expect(errors[0]!.message).toBe("a");
    expect(errors[1]!.message).toBe("b");
  });

  it("short-circuits circular references", () => {
    const err = new Error("outer") as Error & { cause?: unknown };
    err.cause = err;
    const out = compactErrSerializer(err) as Record<string, unknown>;

    expect(out.message).toBe("outer");
    expect(out.cause).toBe("[Circular]");
  });

  it("passes through non-object values unchanged", () => {
    expect(compactErrSerializer(null)).toBeNull();
    expect(compactErrSerializer("string error")).toBe("string error");
    expect(compactErrSerializer(42)).toBe(42);
  });
});

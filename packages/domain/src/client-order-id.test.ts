import { describe, it, expect } from "vitest";
import { buildClientOrderId } from "./client-order-id.js";
import type { TokenId } from "./ids.js";

const base = () => ({
  signalId: "sig-aaa-bbb",
  tokenId: "tok-123" as TokenId,
  side: "buy" as const,
});

describe("buildClientOrderId", () => {
  it("returns deterministic output for the same inputs", () => {
    const a = buildClientOrderId(base());
    const b = buildClientOrderId(base());
    expect(a).toBe(b);
  });

  it("produces the plk_ prefix followed by 16 hex chars", () => {
    const id = buildClientOrderId(base());
    expect(id).toMatch(/^plk_[0-9a-f]{16}$/);
  });

  it("differs when signalId changes", () => {
    const a = buildClientOrderId(base());
    const b = buildClientOrderId({ ...base(), signalId: "sig-ccc-ddd" });
    expect(a).not.toBe(b);
  });

  it("differs when side changes", () => {
    const a = buildClientOrderId(base());
    const b = buildClientOrderId({ ...base(), side: "sell" });
    expect(a).not.toBe(b);
  });

  it("differs when tokenId changes", () => {
    const a = buildClientOrderId(base());
    const b = buildClientOrderId({ ...base(), tokenId: "tok-999" as TokenId });
    expect(a).not.toBe(b);
  });
});

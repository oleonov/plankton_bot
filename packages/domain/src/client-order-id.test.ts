import { describe, it, expect } from "vitest";
import { buildClientOrderId, buildPartialExitClientOrderId } from "./client-order-id.js";
import type { TokenId } from "./ids.js";

const base = () => ({
  signalId: "sig-aaa-bbb",
  tokenId: "tok-123" as TokenId,
  side: "buy" as const,
});

const SLOT_MS = 300_000;

describe("buildClientOrderId", () => {
  it("returns deterministic output for the same inputs", () => {
    const a = buildClientOrderId(base());
    const b = buildClientOrderId(base());
    expect(a).toBe(b);
  });

  it("produces the krb_ prefix followed by 16 hex chars", () => {
    const id = buildClientOrderId(base());
    expect(id).toMatch(/^krb_[0-9a-f]{16}$/);
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

describe("buildPartialExitClientOrderId (Track S5 P1)", () => {
  const token = "tok-123" as TokenId;

  it("encodes the S5/P1 namespace, token, and 5-minute epoch slot", () => {
    const id = buildPartialExitClientOrderId({ tokenId: token, nowMs: 9 * SLOT_MS + 1_000 });
    expect(id).toBe("tk:s5:p1:tok-123:9");
  });

  it("returns the same id for two partials inside one 5-minute slot", () => {
    const a = buildPartialExitClientOrderId({ tokenId: token, nowMs: 9 * SLOT_MS });
    const b = buildPartialExitClientOrderId({ tokenId: token, nowMs: 9 * SLOT_MS + SLOT_MS - 1 });
    expect(a).toBe(b);
  });

  it("returns a different id once the slot advances", () => {
    const a = buildPartialExitClientOrderId({ tokenId: token, nowMs: 9 * SLOT_MS });
    const b = buildPartialExitClientOrderId({ tokenId: token, nowMs: 10 * SLOT_MS });
    expect(a).not.toBe(b);
  });

  it("differs when the token changes within the same slot", () => {
    const a = buildPartialExitClientOrderId({ tokenId: token, nowMs: 9 * SLOT_MS });
    const b = buildPartialExitClientOrderId({ tokenId: "tok-999" as TokenId, nowMs: 9 * SLOT_MS });
    expect(a).not.toBe(b);
  });
});

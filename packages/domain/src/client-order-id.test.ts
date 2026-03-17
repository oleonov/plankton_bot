import { describe, it, expect } from "vitest";
import { buildClientOrderId, type ClientOrderIdParts } from "./client-order-id.js";
import { createFamilyId, createTokenId } from "./ids.js";

function makeParts(overrides?: Partial<ClientOrderIdParts>): ClientOrderIdParts {
  return {
    familyId: createFamilyId("fam-elections"),
    tokenId: createTokenId("tok-yes-abc123"),
    side: "buy",
    intentEpochMs: 1700000000000,
    sequenceInTick: 0,
    ...overrides,
  };
}

describe("buildClientOrderId", () => {
  it("returns deterministic output for the same inputs", () => {
    const a = buildClientOrderId(makeParts());
    const b = buildClientOrderId(makeParts());
    expect(a).toBe(b);
  });

  it("produces the plk_ prefix followed by 16 hex chars", () => {
    const id = buildClientOrderId(makeParts());
    expect(id).toMatch(/^plk_[0-9a-f]{16}$/);
  });

  it("differs when sequenceInTick changes (F3 collision avoidance)", () => {
    const seq0 = buildClientOrderId(makeParts({ sequenceInTick: 0 }));
    const seq1 = buildClientOrderId(makeParts({ sequenceInTick: 1 }));
    const seq2 = buildClientOrderId(makeParts({ sequenceInTick: 2 }));
    expect(seq0).not.toBe(seq1);
    expect(seq1).not.toBe(seq2);
    expect(seq0).not.toBe(seq2);
  });

  it("differs when side changes", () => {
    const buy = buildClientOrderId(makeParts({ side: "buy" }));
    const sell = buildClientOrderId(makeParts({ side: "sell" }));
    expect(buy).not.toBe(sell);
  });

  it("differs when tokenId changes", () => {
    const a = buildClientOrderId(makeParts({ tokenId: createTokenId("tok-a") }));
    const b = buildClientOrderId(makeParts({ tokenId: createTokenId("tok-b") }));
    expect(a).not.toBe(b);
  });

  it("differs when familyId changes", () => {
    const a = buildClientOrderId(makeParts({ familyId: createFamilyId("fam-a") }));
    const b = buildClientOrderId(makeParts({ familyId: createFamilyId("fam-b") }));
    expect(a).not.toBe(b);
  });

  it("differs when intentEpochMs changes", () => {
    const a = buildClientOrderId(makeParts({ intentEpochMs: 1700000000000 }));
    const b = buildClientOrderId(makeParts({ intentEpochMs: 1700000001000 }));
    expect(a).not.toBe(b);
  });
});

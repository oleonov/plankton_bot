import { describe, expect, it } from "vitest";
import {
  DEFAULT_DUST_ABANDONMENT_POLICY,
  isAbandoned,
  shouldMarkAbandoned,
  shouldRecoverFromPriceMove,
} from "@krabs/domain";
import type { LegState, TokenId } from "@krabs/domain";

const TOKEN = "tok-dust" as TokenId;

function leg(overrides: Partial<LegState> = {}): LegState {
  return {
    tokenId: TOKEN,
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    firstTradePrice: 0.1,
    firstTradeAt: "2026-01-01T00:00:00Z",
    lastTradeAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    cumulativeBuySize: 100,
    cumulativeBuyNotional: 10,
    cumulativeSellSize: 0,
    consecutiveSellResidualRejects: 0,
    abandonedAtPrice: null,
    abandonedAtTs: null,
    ...overrides,
  };
}

describe("isAbandoned", () => {
  it("returns false for null leg", () => {
    expect(isAbandoned(null)).toBe(false);
  });

  it("returns false when abandonedAtTs is null", () => {
    expect(isAbandoned(leg())).toBe(false);
  });

  it("returns true when abandonedAtTs is set", () => {
    expect(isAbandoned(leg({ abandonedAtTs: "2026-01-02T00:00:00Z" }))).toBe(true);
  });
});

describe("shouldMarkAbandoned", () => {
  it("returns false when counter below threshold", () => {
    expect(
      shouldMarkAbandoned(
        leg({ consecutiveSellResidualRejects: 9 }),
        DEFAULT_DUST_ABANDONMENT_POLICY,
      ),
    ).toBe(false);
  });

  it("returns true when counter hits maxConsecutiveRejects exactly", () => {
    expect(
      shouldMarkAbandoned(
        leg({
          consecutiveSellResidualRejects: DEFAULT_DUST_ABANDONMENT_POLICY.maxConsecutiveRejects,
        }),
        DEFAULT_DUST_ABANDONMENT_POLICY,
      ),
    ).toBe(true);
  });

  it("returns false when already abandoned (idempotent)", () => {
    expect(
      shouldMarkAbandoned(
        leg({
          consecutiveSellResidualRejects: DEFAULT_DUST_ABANDONMENT_POLICY.maxConsecutiveRejects + 5,
          abandonedAtTs: "2026-01-02T00:00:00Z",
          abandonedAtPrice: 0.05,
        }),
        DEFAULT_DUST_ABANDONMENT_POLICY,
      ),
    ).toBe(false);
  });

  it("returns false when policy disabled", () => {
    expect(
      shouldMarkAbandoned(leg({ consecutiveSellResidualRejects: 99 }), {
        ...DEFAULT_DUST_ABANDONMENT_POLICY,
        enabled: false,
      }),
    ).toBe(false);
  });
});

describe("shouldRecoverFromPriceMove", () => {
  it("returns false when not abandoned", () => {
    expect(shouldRecoverFromPriceMove(leg(), 1.0, DEFAULT_DUST_ABANDONMENT_POLICY)).toBe(false);
  });

  it("recovers when price ratio >= 1.5x", () => {
    // 0.2 / 0.1 = 2.0 ≥ 1.5 — safely above the boundary, no FP edge.
    const abandoned = leg({ abandonedAtTs: "2026-01-02T00:00:00Z", abandonedAtPrice: 0.1 });
    expect(shouldRecoverFromPriceMove(abandoned, 0.2, DEFAULT_DUST_ABANDONMENT_POLICY)).toBe(true);
  });

  it("does not recover below 1.5x", () => {
    const abandoned = leg({ abandonedAtTs: "2026-01-02T00:00:00Z", abandonedAtPrice: 0.1 });
    expect(shouldRecoverFromPriceMove(abandoned, 0.149, DEFAULT_DUST_ABANDONMENT_POLICY)).toBe(
      false,
    );
  });

  it("does not recover when abandonedAtPrice is null/invalid", () => {
    const abandoned = leg({ abandonedAtTs: "2026-01-02T00:00:00Z", abandonedAtPrice: null });
    expect(shouldRecoverFromPriceMove(abandoned, 1.0, DEFAULT_DUST_ABANDONMENT_POLICY)).toBe(false);
  });

  it("does not recover when policy disabled", () => {
    const abandoned = leg({ abandonedAtTs: "2026-01-02T00:00:00Z", abandonedAtPrice: 0.1 });
    expect(
      shouldRecoverFromPriceMove(abandoned, 1.0, {
        ...DEFAULT_DUST_ABANDONMENT_POLICY,
        enabled: false,
      }),
    ).toBe(false);
  });
});

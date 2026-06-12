import { describe, expect, it } from "vitest";
import { createTokenId } from "./ids.js";
import {
  DEFAULT_TRACK_S1_WALKING_LADDER_POLICY,
  buildLadder,
  buildS1LadderId,
  buildS1SignalId,
} from "./ladder-construction.js";

const tokenId = createTokenId("s1-token");

describe("buildLadder", () => {
  it("builds a four-tier cheap longshot ladder with Plankton-style sizing", () => {
    const result = buildLadder({
      tokenId,
      openedAt: "2026-06-12T10:00:00.000Z",
      avgEntryPrice: 0.014,
      positionSize: 100,
      bestBid: 0.02,
      bestAsk: 0.12,
      tickSize: 0.001,
      minOrderSize: 10,
      policy: DEFAULT_TRACK_S1_WALKING_LADDER_POLICY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tiers).toHaveLength(4);
    expect(result.topPrice).toBeLessThanOrEqual(0.014 * 6);
    expect(result.tiers.map((t) => t.size)).toEqual([10, 20, 30, 40]);
    expect(result.tiers[0]!.price).toBeGreaterThan(0.02);
    expect(result.tiers.at(-1)!.role).toBe("target");
  });

  it("uses the mid-range markup ceiling for avgEntry in [0.02, 0.05)", () => {
    const result = buildLadder({
      tokenId,
      openedAt: "2026-06-12T10:00:00.000Z",
      avgEntryPrice: 0.035,
      positionSize: 100,
      bestBid: 0.04,
      bestAsk: 0.2,
      tickSize: 0.001,
      minOrderSize: 10,
      policy: DEFAULT_TRACK_S1_WALKING_LADDER_POLICY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.topPrice).toBeCloseTo(0.078, 3);
  });

  it("derives min size from the smallest tier fraction, not the tier count", () => {
    const base = {
      tokenId,
      openedAt: "2026-06-12T10:00:00.000Z",
      avgEntryPrice: 0.014,
      bestBid: 0.02,
      bestAsk: 0.12,
      tickSize: 0.001,
      minOrderSize: 10,
      policy: DEFAULT_TRACK_S1_WALKING_LADDER_POLICY,
    };

    expect(buildLadder({ ...base, positionSize: 90 })).toMatchObject({
      ok: false,
      reason: "below_min_tier_size",
    });
    expect(buildLadder({ ...base, positionSize: 100 }).ok).toBe(true);
  });

  it("allows a two-tier custom distribution at 2x min order size", () => {
    const result = buildLadder({
      tokenId,
      openedAt: "2026-06-12T10:00:00.000Z",
      avgEntryPrice: 0.014,
      positionSize: 20,
      bestBid: 0.02,
      bestAsk: 0.12,
      tickSize: 0.001,
      minOrderSize: 10,
      policy: {
        ...DEFAULT_TRACK_S1_WALKING_LADDER_POLICY,
        numTiers: 2,
        volumeDistribution: [0.5, 0.5],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tiers.map((t) => t.size)).toEqual([10, 10]);
  });

  it("rejects four-tier ladders when the price band cannot fit monotonic tick steps", () => {
    const result = buildLadder({
      tokenId,
      openedAt: "2026-06-12T10:00:00.000Z",
      avgEntryPrice: 0.014,
      positionSize: 100,
      bestBid: 0.02,
      bestAsk: 0.024,
      tickSize: 0.001,
      minOrderSize: 10,
      policy: DEFAULT_TRACK_S1_WALKING_LADDER_POLICY,
    });

    expect(result).toEqual({ ok: false, reason: "insufficient_price_band" });
  });

  it("still builds a two-tier ladder in the same narrow band when one tick interval fits", () => {
    const result = buildLadder({
      tokenId,
      openedAt: "2026-06-12T10:00:00.000Z",
      avgEntryPrice: 0.014,
      positionSize: 100,
      bestBid: 0.02,
      bestAsk: 0.024,
      tickSize: 0.001,
      minOrderSize: 10,
      policy: {
        ...DEFAULT_TRACK_S1_WALKING_LADDER_POLICY,
        numTiers: 2,
        volumeDistribution: [0.5, 0.5],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tiers.map((tier) => tier.price)).toEqual([0.021, 0.023]);
  });

  it("never rounds tier sizes above the source position size", () => {
    const result = buildLadder({
      tokenId,
      openedAt: "2026-06-12T10:00:00.000Z",
      avgEntryPrice: 0.014,
      positionSize: 99.999999,
      bestBid: 0.02,
      bestAsk: 0.12,
      tickSize: 0.001,
      minOrderSize: 1,
      policy: DEFAULT_TRACK_S1_WALKING_LADDER_POLICY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sizeSum = result.tiers.reduce((sum, tier) => sum + tier.size, 0);
    expect(sizeSum).toBeLessThanOrEqual(99.999999);
  });

  it("returns deterministic ladder and tier signal ids across restarts", () => {
    const a = buildS1LadderId({
      tokenId,
      openedAt: "2026-06-12T10:00:00.000Z",
      avgEntryPrice: 0.014,
    });
    const b = buildS1LadderId({
      tokenId,
      openedAt: "2026-06-12T10:00:00.000Z",
      avgEntryPrice: 0.014,
    });

    expect(a).toBe(b);
    expect(buildS1SignalId(tokenId, a, 0)).toBe(buildS1SignalId(tokenId, b, 0));
    expect(buildS1SignalId(tokenId, a, 0)).not.toBe(buildS1SignalId(tokenId, a, 1));
  });
});

import { describe, expect, it } from "vitest";
import { GATE_ENTRY_RULE_ID, SignalReason, type Order } from "@krabs/domain";
import {
  GATE_TTL_CAP_MS,
  GATE_TTL_FLOOR_MS,
  findOldestStaleOpenBuy,
  gateAdaptiveTtlMs,
  resolveEntryBuyOrderTtlMs,
} from "../buy-order-lifecycle.js";

const MIN = 60_000;
const H = 60 * MIN;

describe("gateAdaptiveTtlMs", () => {
  it("scales inversely with tradeCount3h (580/tc minutes)", () => {
    expect(gateAdaptiveTtlMs(1)).toBe(580 * MIN); // 9.67h
    expect(gateAdaptiveTtlMs(3)).toBe(Math.round(580 / 3) * MIN); // ≈3.22h
    expect(gateAdaptiveTtlMs(10)).toBe(58 * MIN);
  });

  it("clamps to the 30-min floor on active markets", () => {
    expect(gateAdaptiveTtlMs(40)).toBe(GATE_TTL_FLOOR_MS); // 580/40≈15m → floor 30m
    expect(gateAdaptiveTtlMs(80)).toBe(GATE_TTL_FLOOR_MS);
    expect(gateAdaptiveTtlMs(500)).toBe(GATE_TTL_FLOOR_MS);
  });

  it("returns the 12h cap for dead/unknown markets (0, negative, null)", () => {
    expect(gateAdaptiveTtlMs(0)).toBe(GATE_TTL_CAP_MS);
    expect(gateAdaptiveTtlMs(-5)).toBe(GATE_TTL_CAP_MS);
    expect(gateAdaptiveTtlMs(null)).toBe(GATE_TTL_CAP_MS);
    // deadest measurable (tc=1) stays below the cap
    expect(gateAdaptiveTtlMs(1)).toBeLessThan(GATE_TTL_CAP_MS);
  });
});

describe("resolveEntryBuyOrderTtlMs — GATE branch", () => {
  const gate = { signalReason: SignalReason.ProbeEntry, decisionRuleId: GATE_ENTRY_RULE_ID };

  it("uses the adaptive TTL for GATE, NOT the 10-min probe floor", () => {
    expect(resolveEntryBuyOrderTtlMs(gate, { horizon: null }, 3)).toBe(Math.round(580 / 3) * MIN);
    // a plain ProbeEntry (non-GATE) on the same null-horizon market keeps the 10-min probe TTL
    expect(
      resolveEntryBuyOrderTtlMs(
        { signalReason: SignalReason.ProbeEntry, decisionRuleId: "R23" },
        { horizon: null },
      ),
    ).toBe(10 * MIN);
  });

  it("falls back to the cap when tradeCount3h is absent/null (stale-cleaner path)", () => {
    expect(resolveEntryBuyOrderTtlMs(gate, { horizon: null })).toBe(GATE_TTL_CAP_MS);
    expect(resolveEntryBuyOrderTtlMs(gate, { horizon: null }, null)).toBe(GATE_TTL_CAP_MS);
  });
});

describe("resolveEntryBuyOrderTtlMs — non-GATE regression (byte-identical)", () => {
  it("ProbeEntry / ConfirmScale / ScaleIn / horizon paths unchanged", () => {
    const nr = (signalReason: string) => ({ signalReason, decisionRuleId: "R23" });
    expect(resolveEntryBuyOrderTtlMs(nr(SignalReason.ProbeEntry), { horizon: "daily" })).toBe(
      5 * MIN,
    );
    expect(resolveEntryBuyOrderTtlMs(nr(SignalReason.ProbeEntry), { horizon: "intraday-4h" })).toBe(
      1 * MIN,
    );
    expect(resolveEntryBuyOrderTtlMs(nr(SignalReason.ConfirmScale), { horizon: "daily" })).toBe(
      3 * H,
    );
    expect(resolveEntryBuyOrderTtlMs(nr(SignalReason.ScaleIn), { horizon: "deadline" })).toBe(
      3 * H,
    );
    // plain first-entry, null horizon → DEFAULT_TTL_MS 6h
    expect(resolveEntryBuyOrderTtlMs(nr("some-reason"), { horizon: null })).toBe(6 * H);
    expect(resolveEntryBuyOrderTtlMs(nr("some-reason"), { horizon: "deadline" })).toBe(24 * H);
  });
});

describe("findOldestStaleOpenBuy — GATE adaptive TTL", () => {
  const now = 1_800_000_000_000;
  const mkOrder = (ageMs: number, decisionRuleId: string): Order =>
    ({
      side: "buy",
      status: "open",
      createdAt: new Date(now - ageMs).toISOString(),
      signalReason: SignalReason.ProbeEntry,
      decisionRuleId,
      tokenId: "tok-1",
    }) as unknown as Order;
  const noMarket = () => null;

  it("does NOT evict a GATE order younger than its adaptive TTL", () => {
    const order = mkOrder(20 * MIN, GATE_ENTRY_RULE_ID); // tc=3 → ~3.2h TTL
    const stale = findOldestStaleOpenBuy([order], noMarket, now, () => 3);
    expect(stale).toBeNull();
  });

  it("evicts a GATE order older than its adaptive TTL", () => {
    const order = mkOrder(4 * H, GATE_ENTRY_RULE_ID); // tc=3 → ~3.2h TTL, 4h > TTL
    const stale = findOldestStaleOpenBuy([order], noMarket, now, () => 3);
    expect(stale).toBe(order);
  });

  it("uses the cap for GATE when no tradeCount accessor is provided (cleaner path)", () => {
    const order = mkOrder(20 * MIN, GATE_ENTRY_RULE_ID);
    expect(findOldestStaleOpenBuy([order], noMarket, now)).toBeNull(); // cap 12h >> 20m
  });
});

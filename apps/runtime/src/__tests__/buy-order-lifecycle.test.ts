import { describe, expect, it } from "vitest";
import { GATE_ENTRY_RULE_ID, SignalReason, type Order } from "@krabs/domain";
import {
  ADAPTIVE_ENTRY_TTL_CAP_MS,
  ADAPTIVE_ENTRY_TTL_FLOOR_MS,
  adaptiveEntryTtlMs,
  findOldestStaleOpenBuy,
  resolveEntryBuyOrderTtlMs,
  usesAdaptiveFirstEntryTtl,
} from "../buy-order-lifecycle.js";

const MIN = 60_000;
const H = 60 * MIN;

describe("adaptiveEntryTtlMs", () => {
  it("scales inversely with tradeCount3h (580/tc minutes)", () => {
    expect(adaptiveEntryTtlMs(1)).toBe(580 * MIN); // 9.67h
    expect(adaptiveEntryTtlMs(3)).toBe(Math.round(580 / 3) * MIN); // ≈3.22h
    expect(adaptiveEntryTtlMs(10)).toBe(58 * MIN);
  });

  it("clamps to the 30-min floor on active markets", () => {
    expect(adaptiveEntryTtlMs(40)).toBe(ADAPTIVE_ENTRY_TTL_FLOOR_MS); // 580/40≈15m → floor 30m
    expect(adaptiveEntryTtlMs(80)).toBe(ADAPTIVE_ENTRY_TTL_FLOOR_MS);
    expect(adaptiveEntryTtlMs(500)).toBe(ADAPTIVE_ENTRY_TTL_FLOOR_MS);
  });

  it("returns the 12h cap for dead/unknown markets (0, negative, null)", () => {
    expect(adaptiveEntryTtlMs(0)).toBe(ADAPTIVE_ENTRY_TTL_CAP_MS);
    expect(adaptiveEntryTtlMs(-5)).toBe(ADAPTIVE_ENTRY_TTL_CAP_MS);
    expect(adaptiveEntryTtlMs(null)).toBe(ADAPTIVE_ENTRY_TTL_CAP_MS);
    // deadest measurable (tc=1) stays below the cap
    expect(adaptiveEntryTtlMs(1)).toBeLessThan(ADAPTIVE_ENTRY_TTL_CAP_MS);
  });
});

describe("resolveEntryBuyOrderTtlMs — GATE branch", () => {
  const gate = { signalReason: SignalReason.ProbeEntry, decisionRuleId: GATE_ENTRY_RULE_ID };

  it("uses the adaptive TTL for GATE, NOT the 10-min probe floor", () => {
    expect(resolveEntryBuyOrderTtlMs(gate, { horizon: null }, 3)).toBe(Math.round(580 / 3) * MIN);
    // a plain ProbeEntry (non-GATE) on the same null-horizon market is ALSO a first-entry now
    // (R23/FALLBACK/D-rule dip triggers share the GATE cohort) — cap when tradeCount3h is absent.
    expect(
      resolveEntryBuyOrderTtlMs(
        { signalReason: SignalReason.ProbeEntry, decisionRuleId: "R23" },
        { horizon: null },
      ),
    ).toBe(ADAPTIVE_ENTRY_TTL_CAP_MS);
  });

  it("falls back to the cap when tradeCount3h is absent/null (stale-cleaner path)", () => {
    expect(resolveEntryBuyOrderTtlMs(gate, { horizon: null })).toBe(ADAPTIVE_ENTRY_TTL_CAP_MS);
    expect(resolveEntryBuyOrderTtlMs(gate, { horizon: null }, null)).toBe(
      ADAPTIVE_ENTRY_TTL_CAP_MS,
    );
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

describe("resolveEntryBuyOrderTtlMs — first-entry adaptive TTL (long-lived horizons)", () => {
  it("R23 dip-trigger first-entry on a null-horizon (long-lived) market uses the tracked adaptive TTL", () => {
    const order = { signalReason: SignalReason.ProbeEntry, decisionRuleId: "R23_DIP_TRIGGER" };
    expect(resolveEntryBuyOrderTtlMs(order, { horizon: null }, 3)).toBe(Math.round(580 / 3) * MIN);
  });

  it("FALLBACK/D-rule first-entry on a deadline market: cap with no tradeCount, tracked TTL with tc=10", () => {
    const order = { signalReason: SignalReason.ProbeEntry, decisionRuleId: "FALLBACK" };
    expect(resolveEntryBuyOrderTtlMs(order, { horizon: "deadline" })).toBe(
      ADAPTIVE_ENTRY_TTL_CAP_MS,
    );
    expect(resolveEntryBuyOrderTtlMs(order, { horizon: "deadline" }, 10)).toBe(58 * MIN);
  });

  it("ad-hoc horizon first-entry is long-lived too (adaptive cap, not the 10-min probe floor)", () => {
    const order = { signalReason: SignalReason.ProbeEntry, decisionRuleId: "R23_DIP_TRIGGER" };
    expect(resolveEntryBuyOrderTtlMs(order, { horizon: "ad-hoc" })).toBe(ADAPTIVE_ENTRY_TTL_CAP_MS);
  });

  it("REGRESSION GUARD: short-horizon (intraday-4h/daily) first-entries stay on the probe TTLs", () => {
    const order = { signalReason: SignalReason.ProbeEntry, decisionRuleId: "R23_DIP_TRIGGER" };
    expect(resolveEntryBuyOrderTtlMs(order, { horizon: "intraday-4h" })).toBe(1 * MIN);
    expect(resolveEntryBuyOrderTtlMs(order, { horizon: "daily" })).toBe(5 * MIN);
  });

  it("REGRESSION GUARD: scale-ins (ConfirmScale/ScaleIn/HeavyScale) never get adaptive TTL (H6)", () => {
    expect(
      resolveEntryBuyOrderTtlMs(
        { signalReason: SignalReason.ConfirmScale, decisionRuleId: "R23_DIP_TRIGGER" },
        { horizon: "daily" },
      ),
    ).toBe(3 * H);
    expect(
      resolveEntryBuyOrderTtlMs(
        { signalReason: SignalReason.ScaleIn, decisionRuleId: "R23_DIP_TRIGGER" },
        { horizon: "deadline" },
      ),
    ).toBe(3 * H);
    expect(
      resolveEntryBuyOrderTtlMs(
        { signalReason: SignalReason.HeavyScale, decisionRuleId: "R23_DIP_TRIGGER" },
        { horizon: "deadline" },
      ),
    ).toBe(3 * H);
  });

  it("a scale-in carrying the GATE rule-id is STILL excluded from adaptive TTL (ProbeEntry-first gate)", () => {
    expect(
      resolveEntryBuyOrderTtlMs(
        { signalReason: SignalReason.ConfirmScale, decisionRuleId: GATE_ENTRY_RULE_ID },
        { horizon: "deadline" },
      ),
    ).toBe(3 * H);
  });

  it("MISSING MARKET ROW: a null market keeps the 10-min probe TTL for every lane, including GATE", () => {
    expect(
      resolveEntryBuyOrderTtlMs(
        { signalReason: SignalReason.ProbeEntry, decisionRuleId: "R23_DIP_TRIGGER" },
        null,
      ),
    ).toBe(10 * MIN);
    expect(
      resolveEntryBuyOrderTtlMs(
        { signalReason: SignalReason.ProbeEntry, decisionRuleId: GATE_ENTRY_RULE_ID },
        null,
      ),
    ).toBe(10 * MIN);
  });

  it("GATE first-entry on a present null-horizon row remains adaptive (tracked and cap fallback)", () => {
    const gate = { signalReason: SignalReason.ProbeEntry, decisionRuleId: GATE_ENTRY_RULE_ID };
    expect(resolveEntryBuyOrderTtlMs(gate, { horizon: null }, 3)).toBe(Math.round(580 / 3) * MIN);
    expect(resolveEntryBuyOrderTtlMs(gate, { horizon: null })).toBe(ADAPTIVE_ENTRY_TTL_CAP_MS);
  });
});

describe("usesAdaptiveFirstEntryTtl", () => {
  it("is false for any scale-in reason, even carrying the GATE rule-id (guard precedes GATE)", () => {
    expect(
      usesAdaptiveFirstEntryTtl(
        { signalReason: SignalReason.ConfirmScale, decisionRuleId: GATE_ENTRY_RULE_ID },
        { horizon: "deadline" },
      ),
    ).toBe(false);
    expect(
      usesAdaptiveFirstEntryTtl(
        { signalReason: SignalReason.ScaleIn, decisionRuleId: "R23_DIP_TRIGGER" },
        { horizon: null },
      ),
    ).toBe(false);
    expect(
      usesAdaptiveFirstEntryTtl(
        { signalReason: SignalReason.HeavyScale, decisionRuleId: "R23_DIP_TRIGGER" },
        { horizon: "ad-hoc" },
      ),
    ).toBe(false);
  });

  it("is false for a missing market row, for every lane including GATE", () => {
    expect(
      usesAdaptiveFirstEntryTtl(
        { signalReason: SignalReason.ProbeEntry, decisionRuleId: "R23_DIP_TRIGGER" },
        null,
      ),
    ).toBe(false);
    expect(
      usesAdaptiveFirstEntryTtl(
        { signalReason: SignalReason.ProbeEntry, decisionRuleId: GATE_ENTRY_RULE_ID },
        null,
      ),
    ).toBe(false);
  });

  it("is true for GATE first-entries on a present row, regardless of horizon", () => {
    expect(
      usesAdaptiveFirstEntryTtl(
        { signalReason: SignalReason.ProbeEntry, decisionRuleId: GATE_ENTRY_RULE_ID },
        { horizon: "daily" },
      ),
    ).toBe(true);
    expect(
      usesAdaptiveFirstEntryTtl(
        { signalReason: SignalReason.ProbeEntry, decisionRuleId: GATE_ENTRY_RULE_ID },
        { horizon: null },
      ),
    ).toBe(true);
  });

  it("is true for non-GATE first-entries only on null/deadline/ad-hoc horizons", () => {
    const order = { signalReason: SignalReason.ProbeEntry, decisionRuleId: "R23_DIP_TRIGGER" };
    expect(usesAdaptiveFirstEntryTtl(order, { horizon: null })).toBe(true);
    expect(usesAdaptiveFirstEntryTtl(order, { horizon: "deadline" })).toBe(true);
    expect(usesAdaptiveFirstEntryTtl(order, { horizon: "ad-hoc" })).toBe(true);
  });

  it("is false for non-GATE first-entries on short-lived horizons (intraday-4h/daily)", () => {
    const order = { signalReason: SignalReason.ProbeEntry, decisionRuleId: "R23_DIP_TRIGGER" };
    expect(usesAdaptiveFirstEntryTtl(order, { horizon: "intraday-4h" })).toBe(false);
    expect(usesAdaptiveFirstEntryTtl(order, { horizon: "daily" })).toBe(false);
  });

  it("is false for an explicit marketable taker (metadata executionPricingMode=taker), even GATE", () => {
    // Positive-only exclusion: only an exact "taker" is excluded; makerOverride-converted takers persist
    // "maker" and stay adaptive. A maker can never be falsely caught (unlike the reverted postOnly try).
    const takerMeta = { executionPricingMode: "taker" };
    expect(
      usesAdaptiveFirstEntryTtl(
        {
          signalReason: SignalReason.ProbeEntry,
          decisionRuleId: "R23_DIP_TRIGGER",
          metadata: takerMeta,
        },
        { horizon: null },
      ),
    ).toBe(false);
    expect(
      usesAdaptiveFirstEntryTtl(
        {
          signalReason: SignalReason.ProbeEntry,
          decisionRuleId: GATE_ENTRY_RULE_ID,
          metadata: takerMeta,
        },
        { horizon: null },
      ),
    ).toBe(false);
  });

  it("stays adaptive for makers: metadata absent, maker mode, or any non-taker pricing mode", () => {
    const base = { signalReason: SignalReason.ProbeEntry, decisionRuleId: "R23_DIP_TRIGGER" };
    expect(usesAdaptiveFirstEntryTtl({ ...base }, { horizon: null })).toBe(true); // metadata absent
    expect(
      usesAdaptiveFirstEntryTtl(
        { ...base, metadata: { executionPricingMode: "maker" } },
        { horizon: null },
      ),
    ).toBe(true);
    expect(
      usesAdaptiveFirstEntryTtl(
        { ...base, metadata: { executionPricingMode: "ladder" } },
        { horizon: null },
      ),
    ).toBe(true);
    expect(usesAdaptiveFirstEntryTtl({ ...base, metadata: {} }, { horizon: null })).toBe(true);
  });
});

describe("resolveEntryBuyOrderTtlMs — marketable-taker guard", () => {
  it("gives a taker ProbeEntry residual the short 10-min probe TTL, not the 12h adaptive cap", () => {
    const takerR23 = {
      signalReason: SignalReason.ProbeEntry,
      decisionRuleId: "R23_DIP_TRIGGER",
      metadata: { executionPricingMode: "taker" },
    };
    expect(resolveEntryBuyOrderTtlMs(takerR23, { horizon: null })).toBe(10 * MIN);
    expect(resolveEntryBuyOrderTtlMs(takerR23, { horizon: null }, 3)).toBe(10 * MIN); // even with a live count
    // the maker counterpart on the same market keeps the adaptive cap
    expect(
      resolveEntryBuyOrderTtlMs(
        { signalReason: SignalReason.ProbeEntry, decisionRuleId: "R23_DIP_TRIGGER" },
        { horizon: null },
      ),
    ).toBe(ADAPTIVE_ENTRY_TTL_CAP_MS);
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
  const nullHorizonMarket = () => ({ horizon: null });

  it("does NOT evict a GATE order younger than its adaptive TTL (present null-horizon row)", () => {
    const order = mkOrder(20 * MIN, GATE_ENTRY_RULE_ID); // tc=3 → ~3.2h TTL
    const stale = findOldestStaleOpenBuy([order], nullHorizonMarket, now, () => 3);
    expect(stale).toBeNull();
  });

  it("evicts a GATE order older than its adaptive TTL (present null-horizon row)", () => {
    const order = mkOrder(4 * H, GATE_ENTRY_RULE_ID); // tc=3 → ~3.2h TTL, 4h > TTL
    const stale = findOldestStaleOpenBuy([order], nullHorizonMarket, now, () => 3);
    expect(stale).toBe(order);
  });

  it("uses the cap for GATE when no tradeCount accessor is provided (cleaner path)", () => {
    const order = mkOrder(20 * MIN, GATE_ENTRY_RULE_ID);
    expect(findOldestStaleOpenBuy([order], nullHorizonMarket, now)).toBeNull(); // cap 12h >> 20m
  });

  it("MISSING MARKET ROW: a GATE order still gets the conservative 10-min probe TTL when the row itself is missing", () => {
    const order = mkOrder(20 * MIN, GATE_ENTRY_RULE_ID);
    // market===null guard precedes the GATE check (usesAdaptiveFirstEntryTtl rule 2) → 10-min probe
    // TTL, not the ~3.2h/12h-cap adaptive TTL, even though tradeCountForOrder is supplied.
    const stale = findOldestStaleOpenBuy([order], noMarket, now, () => 3);
    expect(stale).toBe(order); // 20m > 10m probe TTL
  });

  it("ACCESSOR GATE (non-GATE R23): consults tradeCountForOrder for any adaptive first-entry, not just GATE", () => {
    const order = mkOrder(40 * MIN, "R23_DIP_TRIGGER");
    // adaptiveEntryTtlMs(40) = round(580/40)=15m → floor 30m; 40m age > 30m TTL → stale
    const stale = findOldestStaleOpenBuy([order], nullHorizonMarket, now, () => 40);
    expect(stale).toBe(order);
  });

  it("CONTROL: same R23 order with a null-tradeCount accessor falls back to the 12h cap (not stale)", () => {
    const order = mkOrder(40 * MIN, "R23_DIP_TRIGGER");
    // adaptiveEntryTtlMs(null) = 12h cap; 40m age << 12h → not stale
    const stale = findOldestStaleOpenBuy([order], nullHorizonMarket, now, () => null);
    expect(stale).toBeNull();
  });
});

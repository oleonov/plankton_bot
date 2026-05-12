import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPRICE_CHAIN_POLICY,
  nextRepriceChainState,
  shouldBlockRepriceChain,
} from "@krabs/domain";
import type { LegState, TokenId } from "@krabs/domain";

const TOKEN = "tok-reprice" as TokenId;
const WINDOW_MS = DEFAULT_REPRICE_CHAIN_POLICY.windowMs;
const CAP = DEFAULT_REPRICE_CHAIN_POLICY.maxChainCount;

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
    cumulativeBuySize: 0,
    cumulativeBuyNotional: 0,
    cumulativeSellSize: 0,
    ...overrides,
  };
}

function legWithEvents(timestamps: string[], overrides: Partial<LegState> = {}): LegState {
  return leg({
    repriceChainEvents24hJson: JSON.stringify(timestamps),
    repriceChainCount24h: timestamps.length,
    repriceChainWindowStartTs: timestamps[0] ?? null,
    ...overrides,
  });
}

describe("shouldBlockRepriceChain", () => {
  it("does not block when no events recorded", () => {
    expect(shouldBlockRepriceChain(leg(), Date.now(), DEFAULT_REPRICE_CHAIN_POLICY)).toBe(false);
  });

  it("does not block when fresh count below cap", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const timestamps = Array.from({ length: CAP - 1 }, (_, i) =>
      new Date(now - i * 1000).toISOString(),
    );
    expect(
      shouldBlockRepriceChain(legWithEvents(timestamps), now, DEFAULT_REPRICE_CHAIN_POLICY),
    ).toBe(false);
  });

  it("blocks when cap reached inside the rolling window", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const timestamps = Array.from({ length: CAP }, (_, i) =>
      new Date(now - i * 1000).toISOString(),
    );
    expect(
      shouldBlockRepriceChain(legWithEvents(timestamps), now, DEFAULT_REPRICE_CHAIN_POLICY),
    ).toBe(true);
  });

  it("does NOT block after the oldest events drop out of the window (true sliding)", () => {
    const now = Date.parse("2026-01-02T12:00:00Z");
    // 13 events: 7 inside window, 6 outside. Effective count = 7 < 13 → unblocked.
    const inside = Array.from({ length: 7 }, (_, i) => new Date(now - i * 1000).toISOString());
    const outside = Array.from({ length: 6 }, (_, i) =>
      new Date(now - WINDOW_MS - (i + 1) * 1000).toISOString(),
    );
    const ls = legWithEvents([...inside, ...outside]);
    expect(shouldBlockRepriceChain(ls, now, DEFAULT_REPRICE_CHAIN_POLICY)).toBe(false);
  });

  it("does not block when policy disabled", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const timestamps = Array.from({ length: CAP * 2 }, (_, i) =>
      new Date(now - i * 1000).toISOString(),
    );
    expect(
      shouldBlockRepriceChain(legWithEvents(timestamps), now, {
        ...DEFAULT_REPRICE_CHAIN_POLICY,
        enabled: false,
      }),
    ).toBe(false);
  });

  it("does not block for null legState", () => {
    expect(shouldBlockRepriceChain(null, Date.now(), DEFAULT_REPRICE_CHAIN_POLICY)).toBe(false);
  });

  it("tolerates malformed JSON without throwing", () => {
    const ls = leg({ repriceChainEvents24hJson: "{not-json" });
    expect(() =>
      shouldBlockRepriceChain(ls, Date.now(), DEFAULT_REPRICE_CHAIN_POLICY),
    ).not.toThrow();
    expect(shouldBlockRepriceChain(ls, Date.now(), DEFAULT_REPRICE_CHAIN_POLICY)).toBe(false);
  });
});

describe("nextRepriceChainState", () => {
  it("seeds the array on the first reprice", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const next = nextRepriceChainState(null, now, DEFAULT_REPRICE_CHAIN_POLICY);
    expect(next.count).toBe(1);
    const parsed = JSON.parse(next.eventsJson) as string[];
    expect(parsed).toEqual([new Date(now).toISOString()]);
    expect(next.windowStartIso).toBe(parsed[0]);
  });

  it("appends to an active window", () => {
    const now = Date.parse("2026-01-01T01:00:00Z");
    const prevTs = new Date(now - 1000).toISOString();
    const ls = legWithEvents([prevTs]);
    const next = nextRepriceChainState(ls, now, DEFAULT_REPRICE_CHAIN_POLICY);
    expect(next.count).toBe(2);
    expect(JSON.parse(next.eventsJson)).toEqual([prevTs, new Date(now).toISOString()]);
  });

  it("drops stale events at append time", () => {
    const now = Date.parse("2026-01-02T01:00:00Z");
    const staleTs = new Date(now - WINDOW_MS - 5000).toISOString();
    const freshTs = new Date(now - 5000).toISOString();
    const ls = legWithEvents([staleTs, freshTs]);
    const next = nextRepriceChainState(ls, now, DEFAULT_REPRICE_CHAIN_POLICY);
    expect(next.count).toBe(2);
    expect(JSON.parse(next.eventsJson)).toEqual([freshTs, new Date(now).toISOString()]);
  });

  it("does not push new event past cap (internal guard)", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    // 13 prior events strictly before `now` so the asserted "not appended"
    // condition is unambiguous.
    const timestamps = Array.from({ length: CAP }, (_, i) =>
      new Date(now - (i + 1) * 1000).toISOString(),
    );
    const ls = legWithEvents(timestamps);
    const next = nextRepriceChainState(ls, now, DEFAULT_REPRICE_CHAIN_POLICY);
    expect(next.count).toBe(CAP);
    const persisted = JSON.parse(next.eventsJson) as string[];
    expect(persisted).toHaveLength(CAP);
    // Existing events preserved verbatim, nowMs not appended.
    expect(persisted).toEqual(timestamps);
    expect(persisted.includes(new Date(now).toISOString())).toBe(false);
  });

  it("window rolls over after 24h: 13 events in 23h + 1 event at 25h starts fresh window", () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    // 13 events tightly clustered at the start of the period (well within
    // the first 23 hours from t0). 1-second spacing keeps them grouped so
    // that advancing 25h pushes every single one beyond the 24h cutoff.
    const timestamps = Array.from({ length: CAP }, (_, i) => new Date(t0 + i * 1000).toISOString());
    let ls = legWithEvents(timestamps);

    // At the moment of the 13th event the cap is reached.
    const tBaseline = t0 + (CAP - 1) * 1000;
    expect(shouldBlockRepriceChain(ls, tBaseline, DEFAULT_REPRICE_CHAIN_POLICY)).toBe(true);

    // Advance clock to 25 hours after the FIRST event — the entire prior
    // chain is now outside the 24h rolling window.
    const tAfter = t0 + 25 * 60 * 60 * 1000;
    const next = nextRepriceChainState(ls, tAfter, DEFAULT_REPRICE_CHAIN_POLICY);
    expect(next.count).toBe(1);
    const expectedIso = new Date(tAfter).toISOString();
    expect(next.windowStartIso).toBe(expectedIso);
    expect(JSON.parse(next.eventsJson)).toEqual([expectedIso]);

    ls = {
      ...ls,
      repriceChainCount24h: next.count,
      repriceChainWindowStartTs: next.windowStartIso,
      repriceChainEvents24hJson: next.eventsJson,
    };
    expect(shouldBlockRepriceChain(ls, tAfter, DEFAULT_REPRICE_CHAIN_POLICY)).toBe(false);
  });
});

describe("CHANGE C — full scenario via helpers", () => {
  it("processes 13 events then blocks the 14th", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    let ls: LegState = leg();

    for (let i = 1; i <= CAP; i++) {
      const t = now + i * 1000;
      expect(shouldBlockRepriceChain(ls, t, DEFAULT_REPRICE_CHAIN_POLICY)).toBe(false);
      const next = nextRepriceChainState(ls, t, DEFAULT_REPRICE_CHAIN_POLICY);
      expect(next.count).toBe(i);
      ls = {
        ...ls,
        repriceChainCount24h: next.count,
        repriceChainWindowStartTs: next.windowStartIso,
        repriceChainEvents24hJson: next.eventsJson,
      };
    }
    // 14th attempt inside the window
    expect(shouldBlockRepriceChain(ls, now + (CAP + 1) * 1000, DEFAULT_REPRICE_CHAIN_POLICY)).toBe(
      true,
    );
  });

  it("counts mixed downpriced and sell-replace events in one 24h chain", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    let ls: LegState = leg();
    const sources = [
      ...Array.from({ length: 7 }, () => "downpriced_reprice"),
      ...Array.from({ length: 5 }, () => "sell_replace_reprice"),
    ];

    sources.forEach((_source, i) => {
      const t = now + (i + 1) * 1000;
      expect(shouldBlockRepriceChain(ls, t, DEFAULT_REPRICE_CHAIN_POLICY)).toBe(false);
      const next = nextRepriceChainState(ls, t, DEFAULT_REPRICE_CHAIN_POLICY);
      expect(next.count).toBe(i + 1);
      ls = {
        ...ls,
        repriceChainCount24h: next.count,
        repriceChainWindowStartTs: next.windowStartIso,
        repriceChainEvents24hJson: next.eventsJson,
      };
    });

    const thirteenthTs = now + 13 * 1000;
    expect(shouldBlockRepriceChain(ls, thirteenthTs, DEFAULT_REPRICE_CHAIN_POLICY)).toBe(false);
    const thirteenth = nextRepriceChainState(ls, thirteenthTs, DEFAULT_REPRICE_CHAIN_POLICY);
    expect(thirteenth.count).toBe(CAP);
    ls = {
      ...ls,
      repriceChainCount24h: thirteenth.count,
      repriceChainWindowStartTs: thirteenth.windowStartIso,
      repriceChainEvents24hJson: thirteenth.eventsJson,
    };

    expect(shouldBlockRepriceChain(ls, now + 14 * 1000, DEFAULT_REPRICE_CHAIN_POLICY)).toBe(true);
  });

  it("unblocks as old events slide out of the rolling window", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    // 13 events compressed at t=0..12s
    const timestamps = Array.from({ length: CAP }, (_, i) =>
      new Date(now + i * 1000).toISOString(),
    );
    const ls = legWithEvents(timestamps);
    // Just inside window: cap reached
    expect(shouldBlockRepriceChain(ls, now + 13 * 1000, DEFAULT_REPRICE_CHAIN_POLICY)).toBe(true);
    // After window slides past the earliest event (need to drop at least 1)
    const after = now + WINDOW_MS + 500;
    expect(shouldBlockRepriceChain(ls, after, DEFAULT_REPRICE_CHAIN_POLICY)).toBe(false);
  });
});

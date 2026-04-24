import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bootstrapDatabase, type DbConnection } from "@plankton/db";
import {
  buildLegStateMap,
  getLegStateOrEmpty,
  derivePhase,
  EMPTY_LEG_STATE,
} from "../enrich-leg-state.js";

describe("derivePhase", () => {
  it("returns S0 when position is closed regardless of leg state", () => {
    expect(
      derivePhase("closed", { buyCount: 3, sellCount: 3, lastAction: "SELL", lastActionAt: null }),
    ).toBe("S0");
  });

  it("returns S0 when position is dust regardless of leg state", () => {
    expect(
      derivePhase("dust", { buyCount: 2, sellCount: 0, lastAction: "BUY", lastActionAt: null }),
    ).toBe("S0");
  });

  it("returns S0 when leg state is empty (no fills yet)", () => {
    expect(derivePhase("open", EMPTY_LEG_STATE)).toBe("S0");
  });

  it("returns S1 on first BUY (buy_count === 1, last_action=BUY)", () => {
    expect(
      derivePhase("open", {
        buyCount: 1,
        sellCount: 0,
        lastAction: "BUY",
        lastActionAt: "2026-04-24T10:00:00Z",
      }),
    ).toBe("S1");
  });

  it("returns S2 on second BUY (buy_count >= 2, last_action=BUY)", () => {
    expect(
      derivePhase("open", {
        buyCount: 2,
        sellCount: 0,
        lastAction: "BUY",
        lastActionAt: null,
      }),
    ).toBe("S2");
  });

  it("returns S2 for accumulating (many buys, no sells)", () => {
    expect(
      derivePhase("open", {
        buyCount: 5,
        sellCount: 0,
        lastAction: "BUY",
        lastActionAt: null,
      }),
    ).toBe("S2");
  });

  it("returns S3 when position open and last action is SELL", () => {
    expect(
      derivePhase("open", {
        buyCount: 3,
        sellCount: 1,
        lastAction: "SELL",
        lastActionAt: null,
      }),
    ).toBe("S3");
  });

  it("stays S2 after partial sell + new BUY (counter does not reset)", () => {
    // buy_count keeps accumulating per spec; buy_count=4 with last_action=BUY
    // means "accumulating even after some distribution".
    expect(
      derivePhase("open", {
        buyCount: 4,
        sellCount: 2,
        lastAction: "BUY",
        lastActionAt: null,
      }),
    ).toBe("S2");
  });

  it("returns S0 when last_action is null but counters exist (unreachable in practice)", () => {
    expect(
      derivePhase("open", {
        buyCount: 1,
        sellCount: 0,
        lastAction: null,
        lastActionAt: null,
      }),
    ).toBe("S0");
  });
});

describe("buildLegStateMap", () => {
  let conn: DbConnection;

  beforeEach(() => {
    conn = bootstrapDatabase(":memory:");
  });

  afterEach(() => {
    conn.close();
  });

  it("returns empty map for empty tokenIds", () => {
    const map = buildLegStateMap(conn.db, []);
    expect(map.size).toBe(0);
  });

  it("builds a map keyed by token_id with numeric counters", () => {
    conn.db
      .prepare(
        `INSERT INTO leg_states (token_id, buy_count, sell_count, last_action,
          first_trade_price, first_trade_at, last_trade_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "tok-a",
        2,
        1,
        "BUY",
        0.12,
        "2026-04-24T10:00:00Z",
        "2026-04-24T10:30:00Z",
        "2026-04-24T10:30:00Z",
      );
    conn.db
      .prepare(
        `INSERT INTO leg_states (token_id, buy_count, sell_count, last_action,
          first_trade_price, first_trade_at, last_trade_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "tok-b",
        1,
        0,
        "BUY",
        0.5,
        "2026-04-24T11:00:00Z",
        "2026-04-24T11:00:00Z",
        "2026-04-24T11:00:00Z",
      );

    const map = buildLegStateMap(conn.db, ["tok-a", "tok-b", "tok-missing"]);
    expect(map.size).toBe(2);
    expect(map.get("tok-a")).toEqual({
      buyCount: 2,
      sellCount: 1,
      lastAction: "BUY",
      lastActionAt: "2026-04-24T10:30:00Z",
    });
    expect(map.get("tok-b")).toEqual({
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      lastActionAt: "2026-04-24T11:00:00Z",
    });
  });

  it("normalises unknown last_action values to null", () => {
    conn.db
      .prepare(
        `INSERT INTO leg_states (token_id, buy_count, sell_count, last_action,
          first_trade_price, first_trade_at, last_trade_at, updated_at)
         VALUES (?, 0, 0, ?, 0, ?, ?, ?)`,
      )
      .run("tok-x", "NOPE", "2026-04-24T10:00:00Z", "2026-04-24T10:00:00Z", "2026-04-24T10:00:00Z");

    const map = buildLegStateMap(conn.db, ["tok-x"]);
    expect(map.get("tok-x")?.lastAction).toBeNull();
  });
});

describe("getLegStateOrEmpty", () => {
  it("returns EMPTY_LEG_STATE when token is missing", () => {
    const map = new Map();
    expect(getLegStateOrEmpty(map, "nope")).toBe(EMPTY_LEG_STATE);
  });

  it("returns the stored leg state when token exists", () => {
    const map = new Map([
      [
        "tok-a",
        { buyCount: 1, sellCount: 0, lastAction: "BUY" as const, lastActionAt: null },
      ],
    ]);
    expect(getLegStateOrEmpty(map, "tok-a").buyCount).toBe(1);
  });
});

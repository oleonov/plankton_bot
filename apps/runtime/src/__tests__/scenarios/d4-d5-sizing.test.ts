/**
 * Scenario: D4 / D5 deterministic sizing (spec §2)
 *
 * Exercises the pure `evaluateSize` function with the exact AlgoSizeRule rows
 * that `ensureAlgoRulesDefaults` seeds into the database (packages/db/src/bootstrap.ts).
 * No module wiring — this validates the sizing table is spec-correct independently
 * of any DB or runtime machinery.
 *
 * Spec §2 rules under test:
 *   D5: state=S1 AND price≥0.20 → SELL size = $5.73  (size rule id "S2", priority 20)
 *   D4: state=S2 AND price≥0.20 → SELL size = $5.81  (size rule id "S1", priority 10)
 */

import { describe, it, expect } from "vitest";
import { evaluateSize } from "@plankton/domain";
import type { AlgoSizeRule } from "@plankton/domain";

// ─── Seed fixture ─────────────────────────────────────────────────────────────
// Mirrors the exact rows inserted by ensureAlgoRulesDefaults in
// packages/db/src/bootstrap.ts (SELL section, lines 219–226).

const SELL_SIZE_RULES: AlgoSizeRule[] = [
  {
    id: 9,
    actionType: "SELL",
    priority: 10,
    ruleId: "S1",
    stateCondition: "S2",
    priceOperator: ">=",
    priceValue: 0.2,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 5.81,
  },
  {
    id: 10,
    actionType: "SELL",
    priority: 20,
    ruleId: "S2",
    stateCondition: "S1",
    priceOperator: ">=",
    priceValue: 0.2,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 5.73,
  },
  {
    id: 11,
    actionType: "SELL",
    priority: 30,
    ruleId: "S3",
    stateCondition: "OTHER",
    priceOperator: ">=",
    priceValue: 0.2,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 5.0,
  },
  {
    id: 12,
    actionType: "SELL",
    priority: 40,
    ruleId: "S4",
    stateCondition: "S2",
    priceOperator: "<",
    priceValue: 0.05,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 1.05,
  },
  {
    id: 13,
    actionType: "SELL",
    priority: 50,
    ruleId: "S5",
    stateCondition: "S3",
    priceOperator: "<",
    priceValue: 0.05,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 0.71,
  },
  {
    id: 14,
    actionType: "SELL",
    priority: 60,
    ruleId: "S6",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: 1,
    buyCountMax: 1,
    sizeUsdc: 1.54,
  },
  {
    id: 15,
    actionType: "SELL",
    priority: 70,
    ruleId: "S7",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: 2,
    buyCountMax: 3,
    sizeUsdc: 2.33,
  },
  {
    id: 16,
    actionType: "SELL",
    priority: 999,
    ruleId: "FALLBACK",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 2.63,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("scenario: D4/D5 deterministic sizing (spec §2)", () => {
  describe("D5 sizing — state=S1 + price≥0.20 → $5.73", () => {
    it("matches size rule S2 (5.73) at the exact threshold price=0.20", () => {
      expect(
        evaluateSize("SELL", { state: "S1", price: 0.2, nthBuy: 0, buyCount: 1 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 5.73, ruleId: "S2" });
    });

    it("matches size rule S2 (5.73) at price=0.25 (above threshold)", () => {
      expect(
        evaluateSize("SELL", { state: "S1", price: 0.25, nthBuy: 0, buyCount: 1 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 5.73, ruleId: "S2" });
    });

    it("matches size rule S2 (5.73) at price=0.99 (high price)", () => {
      expect(
        evaluateSize("SELL", { state: "S1", price: 0.99, nthBuy: 0, buyCount: 1 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 5.73, ruleId: "S2" });
    });

    it("does NOT match S2 at price=0.1999 (below threshold) — falls through to S6 for buyCount=1", () => {
      expect(
        evaluateSize(
          "SELL",
          { state: "S1", price: 0.1999, nthBuy: 0, buyCount: 1 },
          SELL_SIZE_RULES,
        ),
      ).toEqual({ sizeUsdc: 1.54, ruleId: "S6" });
    });
  });

  describe("D4 sizing — state=S2 + price≥0.20 → $5.81", () => {
    it("matches size rule S1 (5.81) at the exact threshold price=0.20", () => {
      expect(
        evaluateSize("SELL", { state: "S2", price: 0.2, nthBuy: 0, buyCount: 2 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 5.81, ruleId: "S1" });
    });

    it("matches size rule S1 (5.81) at price=0.30 (above threshold)", () => {
      expect(
        evaluateSize("SELL", { state: "S2", price: 0.3, nthBuy: 0, buyCount: 3 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 5.81, ruleId: "S1" });
    });

    it("matches size rule S1 (5.81) at price=0.50 (high price)", () => {
      expect(
        evaluateSize("SELL", { state: "S2", price: 0.5, nthBuy: 0, buyCount: 4 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 5.81, ruleId: "S1" });
    });

    it("does NOT match S1 at price=0.1999 (below threshold) — falls through to S7 for buyCount=2", () => {
      expect(
        evaluateSize(
          "SELL",
          { state: "S2", price: 0.1999, nthBuy: 0, buyCount: 2 },
          SELL_SIZE_RULES,
        ),
      ).toEqual({ sizeUsdc: 2.33, ruleId: "S7" });
    });
  });

  describe("priority ordering — S1 (D4) precedes S2 (D5)", () => {
    it("S2 state selects D4 rule (5.81) not D5 rule (5.73)", () => {
      // Rule S1 (priority=10, state=S2) must win over S2 (priority=20, state=S1).
      // This confirms the DB seed priority order is correct.
      const result = evaluateSize(
        "SELL",
        { state: "S2", price: 0.35, nthBuy: 0, buyCount: 2 },
        SELL_SIZE_RULES,
      );
      expect(result.sizeUsdc).toBe(5.81);
      expect(result.ruleId).toBe("S1");
    });

    it("S1 state selects D5 rule (5.73) which is distinct from D4 (5.81)", () => {
      const result = evaluateSize(
        "SELL",
        { state: "S1", price: 0.35, nthBuy: 0, buyCount: 1 },
        SELL_SIZE_RULES,
      );
      expect(result.sizeUsdc).toBe(5.73);
      expect(result.ruleId).toBe("S2");
    });
  });
});

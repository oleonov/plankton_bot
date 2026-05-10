import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteAlgoRulesRepository } from "../repositories/algo-rules-repository.js";
import { ensureAlgoRulesDefaults } from "../bootstrap.js";
import { evaluateDecision, evaluateSize } from "@krabs/domain";
import type { EvalContext } from "@krabs/domain";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  const sql = readFileSync(join(import.meta.dirname, "../migrations/028_algo_engine.sql"), "utf-8");
  db.exec(sql);
  return db;
}

describe("SqliteAlgoRulesRepository", () => {
  let db: Database.Database;
  let repo: SqliteAlgoRulesRepository;

  beforeEach(() => {
    db = createTestDb();
    ensureAlgoRulesDefaults(db);
    repo = new SqliteAlgoRulesRepository(db);
  });

  it("returns decision rules sorted by priority", () => {
    const rules = repo.getDecisionRules();
    expect(rules.length).toBeGreaterThan(0);
    // Verify sorted by priority
    for (let i = 1; i < rules.length; i++) {
      expect(rules[i]!.priority).toBeGreaterThanOrEqual(rules[i - 1]!.priority);
    }
    // Verify FALLBACK exists
    expect(rules[rules.length - 1]!.ruleId).toBe("FALLBACK");
  });

  it("returns BUY size rules with state+price before nth_buy (spec v2.2 §2)", () => {
    const rules = repo.getSizeRules("BUY");
    expect(rules.length).toBe(8); // B1, B2, B3, B4, B5, B6, B7, FALLBACK
    const ruleIds = rules.map((r) => r.ruleId);
    expect(ruleIds).toEqual(["B1", "B2", "B3", "B4", "B5", "B6", "B7", "FALLBACK"]);
  });

  it("returns SELL size rules sorted by priority", () => {
    const rules = repo.getSizeRules("SELL");
    expect(rules.length).toBe(8); // S1-S7 + FALLBACK
    expect(rules[rules.length - 1]!.ruleId).toBe("FALLBACK");
  });

  it("does not re-seed if rules already exist", () => {
    ensureAlgoRulesDefaults(db); // Call again
    const rules = repo.getDecisionRules();
    // Count should be same as first seed (D1-D7 + FALLBACK, no algo-REDEEM).
    expect(rules.length).toBe(8);
  });
});

describe("seeded defaults match spec", () => {
  let db: Database.Database;
  let repo: SqliteAlgoRulesRepository;

  beforeEach(() => {
    db = createTestDb();
    ensureAlgoRulesDefaults(db);
    repo = new SqliteAlgoRulesRepository(db);
  });

  // Fields: priority, ruleId, stateCondition, priceOperator, priceValue,
  //         timeSinceLastOperator, timeSinceLastSeconds,
  //         buyCountMin, buyCountMax, holdDurationOperator, holdDurationSeconds, action
  it.each([
    [20, "D1", "S2", "<", 0.05, "<=", 60, null, null, null, null, "BUY"],
    [30, "D2", "S3", "<", 0.05, "<=", 60, null, null, null, null, "SELL"],
    [40, "D3", "S1", "<", 0.05, null, null, null, null, null, null, "BUY"],
    [50, "D4", "S2", ">=", 0.2, ">", 60, null, null, null, null, "SELL"],
    [60, "D5", "S1", ">=", 0.2, null, null, null, null, null, null, "SELL"],
    [70, "D6", "S2", null, null, null, null, 4, null, null, null, "HOLD"],
    [80, "D7", "S3", null, null, null, null, null, null, null, null, "SELL"],
    [999, "FALLBACK", "ANY", null, null, null, null, null, null, null, null, "BUY"],
  ] as const)(
    "decision rule priority=%i ruleId=%s",
    (
      priority,
      ruleId,
      stateCondition,
      priceOperator,
      priceValue,
      timeSinceLastOperator,
      timeSinceLastSeconds,
      buyCountMin,
      buyCountMax,
      holdDurationOperator,
      holdDurationSeconds,
      action,
    ) => {
      const rules = repo.getDecisionRules();
      const rule = rules.find((r) => r.ruleId === ruleId && r.priority === priority);
      expect(rule).toBeDefined();
      expect(rule!.stateCondition).toBe(stateCondition);
      expect(rule!.priceOperator).toBe(priceOperator);
      expect(rule!.priceValue).toBe(priceValue);
      expect(rule!.timeSinceLastOperator).toBe(timeSinceLastOperator);
      expect(rule!.timeSinceLastSeconds).toBe(timeSinceLastSeconds);
      expect(rule!.buyCountMin).toBe(buyCountMin);
      expect(rule!.buyCountMax).toBe(buyCountMax);
      expect(rule!.holdDurationOperator).toBe(holdDurationOperator);
      expect(rule!.holdDurationSeconds).toBe(holdDurationSeconds);
      expect(rule!.action).toBe(action);
    },
  );

  // Fields: priority, ruleId, stateCondition, priceOperator, priceValue,
  //         nthBuy, buyCountMin, buyCountMax, sizeUsdc
  it.each([
    [10, "B1", "OTHER", ">=", 0.2, null, null, null, 8.41],
    [20, "B2", "S1", ">=", 0.2, null, null, null, 4.29],
    [30, "B3", "S3", "<", 0.05, null, null, null, 0.88],
    [40, "B4", "S2", "<", 0.05, null, null, null, 0.14],
    [50, "B5", "ANY", null, null, 1, null, null, 0.99],
    [60, "B6", "ANY", null, null, 2, null, null, 1.04],
    [70, "B7", "ANY", null, null, 3, null, null, 3.85],
    [999, "FALLBACK", "ANY", null, null, null, null, null, 2.73],
  ] as const)(
    "BUY size rule priority=%i ruleId=%s",
    (
      priority,
      ruleId,
      stateCondition,
      priceOperator,
      priceValue,
      nthBuy,
      buyCountMin,
      buyCountMax,
      sizeUsdc,
    ) => {
      const rules = repo.getSizeRules("BUY");
      const rule = rules.find((r) => r.ruleId === ruleId && r.priority === priority);
      expect(rule).toBeDefined();
      expect(rule!.stateCondition).toBe(stateCondition);
      expect(rule!.priceOperator).toBe(priceOperator);
      expect(rule!.priceValue).toBe(priceValue);
      expect(rule!.nthBuy).toBe(nthBuy);
      expect(rule!.buyCountMin).toBe(buyCountMin);
      expect(rule!.buyCountMax).toBe(buyCountMax);
      expect(rule!.sizeUsdc).toBe(sizeUsdc);
    },
  );

  // Fields: priority, ruleId, stateCondition, priceOperator, priceValue,
  //         nthBuy, buyCountMin, buyCountMax, sizeUsdc
  it.each([
    [10, "S1", "S2", ">=", 0.2, null, null, null, 5.81],
    [20, "S2", "S1", ">=", 0.2, null, null, null, 5.73],
    [30, "S3", "OTHER", ">=", 0.2, null, null, null, 5.0],
    [40, "S4", "S2", "<", 0.05, null, null, null, 1.05],
    [50, "S5", "S3", "<", 0.05, null, null, null, 0.71],
    [60, "S6", "ANY", null, null, null, 1, 1, 1.54],
    [70, "S7", "ANY", null, null, null, 2, 3, 2.33],
    [999, "FALLBACK", "ANY", null, null, null, null, null, 2.63],
  ] as const)(
    "SELL size rule priority=%i ruleId=%s",
    (
      priority,
      ruleId,
      stateCondition,
      priceOperator,
      priceValue,
      nthBuy,
      buyCountMin,
      buyCountMax,
      sizeUsdc,
    ) => {
      const rules = repo.getSizeRules("SELL");
      const rule = rules.find((r) => r.ruleId === ruleId && r.priority === priority);
      expect(rule).toBeDefined();
      expect(rule!.stateCondition).toBe(stateCondition);
      expect(rule!.priceOperator).toBe(priceOperator);
      expect(rule!.priceValue).toBe(priceValue);
      expect(rule!.nthBuy).toBe(nthBuy);
      expect(rule!.buyCountMin).toBe(buyCountMin);
      expect(rule!.buyCountMax).toBe(buyCountMax);
      expect(rule!.sizeUsdc).toBe(sizeUsdc);
    },
  );
});

// ─── End-to-end: bootstrap-seeded rules drive the engine ─────────────────────
//
// Closes the integration gap: prior tests verified the seeded rows look correct
// and the engine tests used synthetic rule fixtures. This block pipes the rows
// that ensureAlgoRulesDefaults actually writes through evaluateDecision /
// evaluateSize, so a silent drift between seed and engine
// would fail here before reaching the runtime.

describe("seeded rules drive engine end-to-end (06_algorithm_spec scenarios)", () => {
  let db: Database.Database;
  let decisionRules: ReturnType<SqliteAlgoRulesRepository["getDecisionRules"]>;
  let buySizeRules: ReturnType<SqliteAlgoRulesRepository["getSizeRules"]>;
  let sellSizeRules: ReturnType<SqliteAlgoRulesRepository["getSizeRules"]>;

  beforeEach(() => {
    db = createTestDb();
    ensureAlgoRulesDefaults(db);
    const repo = new SqliteAlgoRulesRepository(db);
    decisionRules = repo.getDecisionRules();
    buySizeRules = repo.getSizeRules("BUY");
    sellSizeRules = repo.getSizeRules("SELL");
  });

  function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
    return {
      state: "OTHER",
      price: 0.1,
      timeSinceLastSeconds: null,
      buyCount: 0,
      holdDurationSeconds: null,
      ...overrides,
    };
  }

  it("OTHER + no leg → FALLBACK BUY, nth_buy=1 size B5=0.99 (R37)", () => {
    const decision = evaluateDecision(ctx({ state: "OTHER", price: 0.03 }), decisionRules);
    expect(decision.action).toBe("BUY");
    expect(decision.ruleId).toBe("FALLBACK");

    const size = evaluateSize(
      "BUY",
      { state: "OTHER", price: 0.03, nthBuy: 1, buyCount: 0 },
      buySizeRules,
    );
    expect(size.ruleId).toBe("B5");
    expect(size.sizeUsdc).toBe(0.99);
  });

  it("S1 + price<0.05 falls to D3 BUY; algo-REDEEM is not seeded", () => {
    expect(decisionRules.some((rule) => rule.action === "REDEEM")).toBe(false);
    const decision = evaluateDecision(
      ctx({ state: "S1", price: 0.03, holdDurationSeconds: 7200 }),
      decisionRules,
    );
    expect(decision.action).toBe("BUY");
    expect(decision.ruleId).toBe("D3");
  });

  it("S2 + price<0.05 + timeSinceLast≤60 → D1 BUY (spec §1)", () => {
    const decision = evaluateDecision(
      ctx({ state: "S2", price: 0.03, timeSinceLastSeconds: 30, holdDurationSeconds: 7200 }),
      decisionRules,
    );
    expect(decision.action).toBe("BUY");
    expect(decision.ruleId).toBe("D1");
  });

  it("S3 + price<0.05 + timeSinceLast≤60 → D2 SELL, size S5=0.71 (R37)", () => {
    const decision = evaluateDecision(
      ctx({ state: "S3", price: 0.03, timeSinceLastSeconds: 10 }),
      decisionRules,
    );
    expect(decision.action).toBe("SELL");
    expect(decision.ruleId).toBe("D2");

    const size = evaluateSize(
      "SELL",
      { state: "S3", price: 0.03, nthBuy: 0, buyCount: 2 },
      sellSizeRules,
    );
    expect(size.ruleId).toBe("S5");
    expect(size.sizeUsdc).toBe(0.71);
  });

  it("S2 + price≥0.20 + timeSinceLast>60 → D4 SELL, size S1=5.81 (R37)", () => {
    const decision = evaluateDecision(
      ctx({ state: "S2", price: 0.25, timeSinceLastSeconds: 120 }),
      decisionRules,
    );
    expect(decision.action).toBe("SELL");
    expect(decision.ruleId).toBe("D4");

    const size = evaluateSize(
      "SELL",
      { state: "S2", price: 0.25, nthBuy: 0, buyCount: 3 },
      sellSizeRules,
    );
    expect(size.ruleId).toBe("S1");
    expect(size.sizeUsdc).toBe(5.81);
  });

  it("S1 + price≥0.20 → D5 SELL, size S2=5.73", () => {
    const decision = evaluateDecision(ctx({ state: "S1", price: 0.3 }), decisionRules);
    expect(decision.action).toBe("SELL");
    expect(decision.ruleId).toBe("D5");

    const size = evaluateSize(
      "SELL",
      { state: "S1", price: 0.3, nthBuy: 0, buyCount: 1 },
      sellSizeRules,
    );
    expect(size.ruleId).toBe("S2");
    expect(size.sizeUsdc).toBe(5.73);
  });

  it("S2 + buy_count≥4 → D6 HOLD", () => {
    const decision = evaluateDecision(ctx({ state: "S2", price: 0.1, buyCount: 5 }), decisionRules);
    expect(decision.action).toBe("HOLD");
    expect(decision.ruleId).toBe("D6");
  });

  it("S3 (no other rule matches) → D7 SELL", () => {
    const decision = evaluateDecision(
      ctx({ state: "S3", price: 0.1, timeSinceLastSeconds: 120 }),
      decisionRules,
    );
    expect(decision.action).toBe("SELL");
    expect(decision.ruleId).toBe("D7");
  });

  it("sell_context: buyCount=1 → S6=1.54; buyCount=3 → S7=2.33 (R37)", () => {
    const afterOneBuy = evaluateSize(
      "SELL",
      { state: "OTHER", price: 0.1, nthBuy: 0, buyCount: 1 },
      sellSizeRules,
    );
    expect(afterOneBuy.ruleId).toBe("S6");
    expect(afterOneBuy.sizeUsdc).toBe(1.54);

    const afterThreeBuys = evaluateSize(
      "SELL",
      { state: "OTHER", price: 0.1, nthBuy: 0, buyCount: 3 },
      sellSizeRules,
    );
    expect(afterThreeBuys.ruleId).toBe("S7");
    expect(afterThreeBuys.sizeUsdc).toBe(2.33);
  });

  it("BUY fallback=2.73 when no specific rule matches (R37)", () => {
    // buyCount=5 → nthBuy=6 (beyond B5/B6/B7), state=S2 + price=0.10 (neither B4 <0.05 nor B1/B2 ≥0.20)
    const size = evaluateSize(
      "BUY",
      { state: "S2", price: 0.1, nthBuy: 6, buyCount: 5 },
      buySizeRules,
    );
    expect(size.ruleId).toBe("FALLBACK");
    expect(size.sizeUsdc).toBe(2.73);
  });

  it("SELL fallback=2.63 when no specific rule matches (R37)", () => {
    // state=OTHER + price=0.1 (no state+price match, buyCount=0 outside S6/S7 range)
    const size = evaluateSize(
      "SELL",
      { state: "OTHER", price: 0.1, nthBuy: 0, buyCount: 0 },
      sellSizeRules,
    );
    expect(size.ruleId).toBe("FALLBACK");
    expect(size.sizeUsdc).toBe(2.63);
  });
});

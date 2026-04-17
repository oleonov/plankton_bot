import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteAlgoRulesRepository } from "../repositories/algo-rules-repository.js";
import { ensureAlgoRulesDefaults } from "../bootstrap.js";
import { evaluateDecision, evaluateRedeem, evaluateSize } from "@plankton/domain";
import type { EvalContext } from "@plankton/domain";
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
    // Count should be same as first seed (10 decision rules)
    expect(rules.length).toBe(10);
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
    [10, "REDEEM", "S1", "<", 0.05, null, null, null, null, "<=", 3600, "REDEEM"],
    [11, "REDEEM", "S2", "<", 0.05, null, null, null, null, "<=", 3600, "REDEEM"],
    [20, "D1", "S2", "<", 0.05, "<=", 60, null, null, null, null, "BUY"],
    [30, "D2", "S3", "<", 0.05, "<=", 60, null, null, null, null, "SELL"],
    [40, "D3", "S1", "<", 0.05, null, null, null, null, null, null, "BUY"],
    [50, "D4", "S2", ">=", 0.2, ">", 60, null, null, null, null, "SELL"],
    [60, "D5", "S1", ">=", 0.2, null, null, null, null, null, null, "SELL"],
    [70, "D6", "S2", null, null, null, null, 4, null, null, null, "BUY"],
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
    [10, "B1", "OTHER", ">=", 0.2, null, null, null, 8.38],
    [20, "B2", "S1", ">=", 0.2, null, null, null, 4.17],
    [30, "B3", "S3", "<", 0.05, null, null, null, 0.76],
    [40, "B4", "S2", "<", 0.05, null, null, null, 0.12],
    [50, "B5", "ANY", null, null, 1, null, null, 2.1],
    [60, "B6", "ANY", null, null, 2, null, null, 1.17],
    [70, "B7", "ANY", null, null, 3, null, null, 0.92],
    [999, "FALLBACK", "ANY", null, null, null, null, null, 0.44],
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
    [10, "S1", "S2", ">=", 0.2, null, null, null, 6.48],
    [20, "S2", "S1", ">=", 0.2, null, null, null, 6.31],
    [30, "S3", "OTHER", ">=", 0.2, null, null, null, 3.4],
    [40, "S4", "S2", "<", 0.05, null, null, null, 1.01],
    [50, "S5", "S3", "<", 0.05, null, null, null, 0.59],
    [60, "S6", "ANY", null, null, null, 1, 1, 2.85],
    [70, "S7", "ANY", null, null, null, 2, 3, 2.14],
    [999, "FALLBACK", "ANY", null, null, null, null, null, 1.62],
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
// evaluateRedeem / evaluateSize, so a silent drift between seed and engine
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

  it("OTHER + no leg → FALLBACK BUY, nth_buy=1 size 2.10 (spec §3)", () => {
    const decision = evaluateDecision(ctx({ state: "OTHER", price: 0.03 }), decisionRules);
    expect(decision.action).toBe("BUY");
    expect(decision.ruleId).toBe("FALLBACK");

    const size = evaluateSize(
      "BUY",
      { state: "OTHER", price: 0.03, nthBuy: 1, buyCount: 0 },
      buySizeRules,
    );
    expect(size.ruleId).toBe("B5");
    expect(size.sizeUsdc).toBe(2.1);
  });

  it("S2 + price<0.05 + holdDuration≤3600 → REDEEM (spec §8)", () => {
    const redeem = evaluateRedeem(
      ctx({ state: "S2", price: 0.03, holdDurationSeconds: 1800 }),
      decisionRules,
    );
    expect(redeem).not.toBeNull();
    expect(redeem!.ruleId).toBe("REDEEM");
  });

  it("S1 + price<0.05 + holdDuration>3600 → does NOT redeem, falls to D3 BUY", () => {
    const redeem = evaluateRedeem(
      ctx({ state: "S1", price: 0.03, holdDurationSeconds: 7200 }),
      decisionRules,
    );
    expect(redeem).toBeNull();

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

  it("S3 + price<0.05 + timeSinceLast≤60 → D2 SELL, size S5=0.59 (spec §2)", () => {
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
    expect(size.sizeUsdc).toBe(0.59);
  });

  it("S2 + price≥0.20 + timeSinceLast>60 → D4 SELL, size S1=6.48 (spec §1/§2)", () => {
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
    expect(size.sizeUsdc).toBe(6.48);
  });

  it("S1 + price≥0.20 → D5 SELL, size S2=6.31", () => {
    const decision = evaluateDecision(ctx({ state: "S1", price: 0.3 }), decisionRules);
    expect(decision.action).toBe("SELL");
    expect(decision.ruleId).toBe("D5");

    const size = evaluateSize(
      "SELL",
      { state: "S1", price: 0.3, nthBuy: 0, buyCount: 1 },
      sellSizeRules,
    );
    expect(size.ruleId).toBe("S2");
    expect(size.sizeUsdc).toBe(6.31);
  });

  it("S2 + buy_count≥4 → D6 BUY", () => {
    const decision = evaluateDecision(ctx({ state: "S2", price: 0.1, buyCount: 5 }), decisionRules);
    expect(decision.action).toBe("BUY");
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

  it("sell_context: buyCount=1 → S6=2.85; buyCount=3 → S7=2.14 (spec §2)", () => {
    const afterOneBuy = evaluateSize(
      "SELL",
      { state: "OTHER", price: 0.1, nthBuy: 0, buyCount: 1 },
      sellSizeRules,
    );
    expect(afterOneBuy.ruleId).toBe("S6");
    expect(afterOneBuy.sizeUsdc).toBe(2.85);

    const afterThreeBuys = evaluateSize(
      "SELL",
      { state: "OTHER", price: 0.1, nthBuy: 0, buyCount: 3 },
      sellSizeRules,
    );
    expect(afterThreeBuys.ruleId).toBe("S7");
    expect(afterThreeBuys.sizeUsdc).toBe(2.14);
  });

  it("BUY fallback=0.44 when no specific rule matches (spec §2)", () => {
    // buyCount=5 → nthBuy=6 (beyond B5/B6/B7), state=S2 + price=0.10 (neither B4 <0.05 nor B1/B2 ≥0.20)
    const size = evaluateSize(
      "BUY",
      { state: "S2", price: 0.1, nthBuy: 6, buyCount: 5 },
      buySizeRules,
    );
    expect(size.ruleId).toBe("FALLBACK");
    expect(size.sizeUsdc).toBe(0.44);
  });

  it("SELL fallback=1.62 when no specific rule matches (spec §2)", () => {
    // state=OTHER + price=0.1 (no state+price match, buyCount=0 outside S6/S7 range)
    const size = evaluateSize(
      "SELL",
      { state: "OTHER", price: 0.1, nthBuy: 0, buyCount: 0 },
      sellSizeRules,
    );
    expect(size.ruleId).toBe("FALLBACK");
    expect(size.sizeUsdc).toBe(1.62);
  });
});

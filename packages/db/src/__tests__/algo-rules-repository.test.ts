import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteAlgoRulesRepository } from "../repositories/algo-rules-repository.js";
import { ensureAlgoRulesDefaults } from "../bootstrap.js";
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

  it("returns BUY size rules with nth_buy before state+price", () => {
    const rules = repo.getSizeRules("BUY");
    expect(rules.length).toBe(8); // B5, B6, B7, B1, B2, B3, B4, FALLBACK
    const ruleIds = rules.map((r) => r.ruleId);
    expect(ruleIds).toEqual(["B5", "B6", "B7", "B1", "B2", "B3", "B4", "FALLBACK"]);
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
    [10, "B5", "ANY", null, null, 1, null, null, 2.1],
    [20, "B6", "ANY", null, null, 2, null, null, 1.17],
    [30, "B7", "ANY", null, null, 3, null, null, 0.92],
    [40, "B1", "OTHER", ">=", 0.2, null, null, null, 8.38],
    [50, "B2", "S1", ">=", 0.2, null, null, null, 4.17],
    [60, "B3", "S3", "<", 0.05, null, null, null, 0.76],
    [70, "B4", "S2", "<", 0.05, null, null, null, 0.12],
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

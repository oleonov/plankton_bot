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

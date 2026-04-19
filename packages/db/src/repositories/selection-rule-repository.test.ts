import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { SelectionRuleRepository } from "./selection-rule-repository.js";

let db: Database.Database;
let repo: SelectionRuleRepository;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(readFileSync("src/schemas/control.sql", "utf8"));
  db.exec("INSERT INTO profiles (profile_id, display_name) VALUES ('simulation','Simulation')");
  db.exec("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)");
  repo = new SelectionRuleRepository(db);
});

describe("SelectionRuleRepository", () => {
  it("insert + list round-trip; version bumps", () => {
    const before = repo.getVersion();
    const r = repo.insert({
      profileId: "simulation",
      ruleType: "include_prefix",
      pattern: "bitcoin-",
      enabled: true,
      note: null,
    });
    expect(r.ruleId).toBeTruthy();
    expect(repo.list("simulation")).toHaveLength(1);
    expect(repo.getVersion()).toBe(before + 1);
  });

  it("UNIQUE(profile, type, pattern) rejects duplicates", () => {
    repo.insert({
      profileId: "simulation",
      ruleType: "include_prefix",
      pattern: "bitcoin-",
      enabled: true,
      note: null,
    });
    expect(() =>
      repo.insert({
        profileId: "simulation",
        ruleType: "include_prefix",
        pattern: "bitcoin-",
        enabled: true,
        note: null,
      }),
    ).toThrow(/UNIQUE/);
  });

  it("patch toggles enabled; bumps version", () => {
    const r = repo.insert({
      profileId: "simulation",
      ruleType: "include_prefix",
      pattern: "bitcoin-",
      enabled: true,
      note: null,
    });
    const v1 = repo.getVersion();
    repo.patch(r.ruleId, { enabled: false });
    expect(repo.findById(r.ruleId)?.enabled).toBe(false);
    expect(repo.getVersion()).toBe(v1 + 1);
  });

  it("delete removes row; bumps version", () => {
    const r = repo.insert({
      profileId: "simulation",
      ruleType: "include_prefix",
      pattern: "bitcoin-",
      enabled: true,
      note: null,
    });
    const v1 = repo.getVersion();
    expect(repo.delete(r.ruleId)).toBe(true);
    expect(repo.findById(r.ruleId)).toBeNull();
    expect(repo.getVersion()).toBe(v1 + 1);
  });
});

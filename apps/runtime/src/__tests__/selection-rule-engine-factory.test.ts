import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { SelectionRuleRepository } from "@plankton/db";
import { RefreshableSelectionRuleEngine } from "../selection-rule-engine-factory.js";

const CONTROL_SQL = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/db/src/schemas/control.sql"),
  "utf-8",
);

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(CONTROL_SQL);
  db.prepare(
    "INSERT INTO profiles (profile_id, display_name) VALUES ('simulation', 'Simulation')",
  ).run();
  db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
  return db;
}

describe("RefreshableSelectionRuleEngine", () => {
  let db: Database.Database;
  let repo: SelectionRuleRepository;
  let engine: RefreshableSelectionRuleEngine;

  beforeEach(() => {
    db = makeDb();
    repo = new SelectionRuleRepository(db);
    engine = new RefreshableSelectionRuleEngine(repo, "simulation");
  });

  it("resolves no_match when rule set is empty on construction", () => {
    const decision = engine.resolve("bitcoin-price-2026", "bitcoin-up");
    expect(decision.status).toBe("no_match");
  });

  it("resolves correctly when seeded with rules at construction", () => {
    repo.insert({
      profileId: "simulation",
      ruleType: "include_prefix",
      pattern: "bitcoin-",
      enabled: true,
      note: null,
    });
    // Must create engine AFTER seeding so construction sees the rules
    const seededEngine = new RefreshableSelectionRuleEngine(repo, "simulation");
    const decision = seededEngine.resolve("bitcoin-price-2026", "bitcoin-up");
    expect(decision.status).toBe("include");
  });

  it("refreshIfStale is idempotent when version has not changed", () => {
    const before = engine.current;
    engine.refreshIfStale();
    // Same object reference — no rebuild happened
    expect(engine.current).toBe(before);
  });

  it("reloads engine when version is bumped via repo write", () => {
    const before = engine.current;

    // Simulate an external mutation (e.g. operator API adds a rule)
    repo.insert({
      profileId: "simulation",
      ruleType: "include_prefix",
      pattern: "elon-musk-",
      enabled: true,
      note: null,
    });

    // Version is now ahead — refreshIfStale should rebuild
    engine.refreshIfStale();
    expect(engine.current).not.toBe(before);

    // The new engine must know about the inserted rule
    const decision = engine.resolve("elon-musk-wins-2026", "elon-musk-up");
    expect(decision.status).toBe("include");
  });

  it("does not reload on a second refreshIfStale call after already syncing", () => {
    repo.insert({
      profileId: "simulation",
      ruleType: "include_prefix",
      pattern: "bitcoin-",
      enabled: true,
      note: null,
    });
    engine.refreshIfStale(); // first refresh picks up the new rule
    const afterFirst = engine.current;
    engine.refreshIfStale(); // version unchanged — no rebuild
    expect(engine.current).toBe(afterFirst);
  });

  it("current getter returns delegate to engine.resolve correctly", () => {
    repo.insert({
      profileId: "simulation",
      ruleType: "exclude_slug",
      pattern: "spam-market",
      enabled: true,
      note: null,
    });
    engine.refreshIfStale();
    const decision = engine.current.resolve("some-event", "spam-market");
    expect(decision.status).toBe("exclude");
  });
});

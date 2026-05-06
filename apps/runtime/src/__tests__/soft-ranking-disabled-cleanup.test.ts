import Database from "better-sqlite3";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { softRankingDisabledCleanup } from "../soft-ranking-disabled-cleanup.js";

let db: Database.Database;

function makeLog() {
  return pino({ level: "silent" });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE runtime_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric_name TEXT NOT NULL,
      value REAL NOT NULL,
      labels TEXT,
      captured_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE markets (
      token_id TEXT PRIMARY KEY,
      score REAL,
      score_model_version TEXT,
      scored_at TEXT,
      features_captured_at TEXT
    );
  `);
});

afterEach(() => {
  db.close();
});

describe("softRankingDisabledCleanup", () => {
  it("nulls all four score-ownership columns when artifact is disabled", () => {
    db.prepare(
      "INSERT INTO markets (token_id, score, score_model_version, scored_at, features_captured_at) VALUES (?, ?, ?, ?, ?)",
    ).run("0xabc", 0.85, "v1.0.0", "2026-05-06T00:00:00Z", "2026-05-06T00:00:00Z");

    softRankingDisabledCleanup(db, makeLog());

    const row = db.prepare("SELECT * FROM markets WHERE token_id = ?").get("0xabc") as {
      score: number | null;
      score_model_version: string | null;
      scored_at: string | null;
      features_captured_at: string | null;
    };
    expect(row.score).toBeNull();
    expect(row.score_model_version).toBeNull();
    expect(row.scored_at).toBeNull();
    expect(row.features_captured_at).toBeNull();
  });

  it("clears rows where only features_captured_at lingers (D4 ownership invariant)", () => {
    // Pathological state: prior buggy cleanup nulled 3 columns, leaving
    // features_captured_at as a stale orphan. Fix 1 must rescue this row.
    db.prepare(
      "INSERT INTO markets (token_id, score, score_model_version, scored_at, features_captured_at) VALUES (?, NULL, NULL, NULL, ?)",
    ).run("0xorphan", "2026-05-06T00:00:00Z");

    softRankingDisabledCleanup(db, makeLog());

    const row = db
      .prepare("SELECT features_captured_at FROM markets WHERE token_id = ?")
      .get("0xorphan") as { features_captured_at: string | null };
    expect(row.features_captured_at).toBeNull();
  });

  it("deletes the persisted score_distribution snapshot", () => {
    db.prepare(
      "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, 1, ?, ?)",
    ).run("score_distribution", '{"snapshot":1}', "2026-05-06T00:00:00Z");
    db.prepare(
      "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, 1, NULL, ?)",
    ).run("other_metric", "2026-05-06T00:00:00Z");

    softRankingDisabledCleanup(db, makeLog());

    const remaining = db
      .prepare("SELECT metric_name FROM runtime_metrics ORDER BY metric_name")
      .all() as { metric_name: string }[];
    expect(remaining).toEqual([{ metric_name: "other_metric" }]);
  });

  it("logs the rows-cleared count when at least one row was modified", () => {
    db.prepare(
      "INSERT INTO markets (token_id, score, score_model_version, scored_at, features_captured_at) VALUES (?, ?, ?, ?, ?)",
    ).run("0xabc", 0.5, "v1", "2026-05-06T00:00:00Z", "2026-05-06T00:00:00Z");
    db.prepare(
      "INSERT INTO markets (token_id, score, score_model_version, scored_at, features_captured_at) VALUES (?, ?, ?, ?, ?)",
    ).run("0xdef", 0.6, "v1", "2026-05-06T00:00:00Z", "2026-05-06T00:00:00Z");
    const log = makeLog();
    const infoSpy = vi.spyOn(log, "info");

    softRankingDisabledCleanup(db, log);

    const cleared = infoSpy.mock.calls.find(
      (call) => call[1] === "soft_ranking_disabled_score_columns_cleared",
    );
    expect(cleared?.[0]).toEqual({ rows: 2 });
  });

  it("is a no-op when no rows carry score values", () => {
    db.prepare("INSERT INTO markets (token_id) VALUES (?)").run("0xabc");
    const log = makeLog();
    const infoSpy = vi.spyOn(log, "info");

    softRankingDisabledCleanup(db, log);

    expect(
      infoSpy.mock.calls.some((call) => call[1] === "soft_ranking_disabled_score_columns_cleared"),
    ).toBe(false);
  });
});

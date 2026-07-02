import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../migrations/runner.js";

describe("migration 081 signature features", () => {
  it("adds nullable sig_* columns and index, idempotently", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    runMigrations(db); // idempotent second run must not throw
    const cols = (db.prepare("PRAGMA table_info(markets)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const c of [
      "sig_mid",
      "sig_cheap_mid",
      "sig_liquidity",
      "sig_vol24h",
      "sig_features_at",
    ]) {
      expect(cols).toContain(c);
    }
    const idx = (db.prepare("PRAGMA index_list(markets)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(idx).toContain("idx_markets_signature");
  });
});

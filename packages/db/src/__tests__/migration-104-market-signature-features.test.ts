import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../migrations/runner.js";

const MIGRATION = "104_market_signature_features_table.sql";

describe("migration 104 market signature feature table", () => {
  it("backfills legacy signature tuples without overwriting a replayed side row", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare(
      `INSERT INTO markets
         (token_id, condition_id, slug, question, outcome, active, tick_size, neg_risk,
          sig_mid, sig_cheap_mid, sig_liquidity, sig_vol24h, sig_features_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0.001, 0, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-token",
      "condition",
      "slug",
      "Question?",
      "Yes",
      0.04,
      null,
      800,
      null,
      "2026-08-26T00:00:00.000Z",
      "2026-08-26T00:00:01.000Z",
    );

    db.exec("DROP TABLE market_signature_features");
    db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(MIGRATION);
    runMigrations(db);

    expect(
      db.prepare("SELECT * FROM market_signature_features WHERE token_id = ?").get("legacy-token"),
    ).toMatchObject({
      sig_mid: 0.04,
      sig_cheap_mid: null,
      sig_liquidity: 800,
      sig_vol24h: null,
      sig_features_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:01.000Z",
    });

    db.prepare(
      `UPDATE market_signature_features
          SET sig_liquidity = 900, sig_features_at = '2026-08-27T00:00:00.000Z'
        WHERE token_id = 'legacy-token'`,
    ).run();
    db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(MIGRATION);
    runMigrations(db);
    expect(
      db
        .prepare(
          "SELECT sig_liquidity, sig_features_at FROM market_signature_features WHERE token_id = ?",
        )
        .get("legacy-token"),
    ).toEqual({ sig_liquidity: 900, sig_features_at: "2026-08-27T00:00:00.000Z" });
    db.close();
  });
});

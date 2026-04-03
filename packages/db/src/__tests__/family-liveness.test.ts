import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../connection.js";
import { readFamilyLiveness } from "../family-liveness.js";

const LEDGER_SQL = readFileSync(resolve(import.meta.dirname, "../schemas/ledger.sql"), "utf-8");

describe("readFamilyLiveness", () => {
  it("derives active, dormant, and unseen families from markets", () => {
    const conn = openDatabase(":memory:");
    conn.db.exec(LEDGER_SQL);

    conn.db.exec(`
      INSERT INTO markets
        (token_id, condition_id, slug, question, outcome, family_id, active, tick_size, neg_risk, created_at, updated_at)
      VALUES
        ('tok-a1', 'cond-a', 'slug-a1', 'Q1', 'YES', 'fam-active', 1, 0.01, 0, datetime('now'), '2026-04-03T00:00:00Z'),
        ('tok-a2', 'cond-a', 'slug-a2', 'Q1', 'NO',  'fam-active', 1, 0.01, 0, datetime('now'), '2026-04-03T00:00:00Z'),
        ('tok-d1', 'cond-d', 'slug-d1', 'Q2', 'YES', 'fam-dormant', 0, 0.01, 0, datetime('now'), '2026-04-02T00:00:00Z')
    `);

    const liveness = readFamilyLiveness(conn.db, ["fam-active", "fam-dormant", "fam-unseen"]);

    expect(liveness.get("fam-active")).toMatchObject({
      activeMarketCount: 2,
      knownMarketCount: 2,
      liveness: "active",
    });
    expect(liveness.get("fam-dormant")).toMatchObject({
      activeMarketCount: 0,
      knownMarketCount: 1,
      liveness: "dormant",
    });
    expect(liveness.get("fam-unseen")).toMatchObject({
      activeMarketCount: 0,
      knownMarketCount: 0,
      liveness: "unseen",
    });

    conn.close();
  });
});

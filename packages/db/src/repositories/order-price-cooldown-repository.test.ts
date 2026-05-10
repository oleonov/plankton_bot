import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTokenId, type OrderPriceCooldown } from "@krabs/domain";
import { SqliteOrderPriceCooldownRepository } from "./order-price-cooldown-repository.js";

describe("SqliteOrderPriceCooldownRepository", () => {
  it("persists cooldown rows across repository restarts", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-price-cooldown-"));
    const dbPath = path.join(tmpDir, "ledger.db");
    try {
      const db1 = new Database(dbPath);
      db1.exec(readMigration());
      const repo1 = new SqliteOrderPriceCooldownRepository(db1);
      repo1.upsert(cooldown({ staleCancelCount: 2, cooldownUntilTsUtc: 1_800_000 }));
      db1.close();

      const db2 = new Database(dbPath);
      const repo2 = new SqliteOrderPriceCooldownRepository(db2);
      const loaded = repo2.get(createTokenId("token-1"), "buy", 4900);
      db2.close();

      expect(loaded).toMatchObject({
        side: "buy",
        priceX10000: 4900,
        staleCancelCount: 2,
        cooldownUntilTsUtc: 1_800_000,
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps different prices independent and can delete by token", () => {
    const db = new Database(":memory:");
    db.exec(readMigration());
    const repo = new SqliteOrderPriceCooldownRepository(db);

    repo.upsert(cooldown({ priceX10000: 4900 }));
    repo.upsert(cooldown({ priceX10000: 5000, staleCancelCount: 3 }));

    expect(repo.get(createTokenId("token-1"), "buy", 4900)?.staleCancelCount).toBe(1);
    expect(repo.get(createTokenId("token-1"), "buy", 5000)?.staleCancelCount).toBe(3);
    expect(repo.deleteByTokenId(createTokenId("token-1"))).toBe(2);
    expect(repo.findAll()).toEqual([]);
    db.close();
  });
});

function readMigration(): string {
  return readFileSync(
    path.join(import.meta.dirname, "..", "migrations", "052_order_price_cooldowns.sql"),
    "utf-8",
  );
}

function cooldown(overrides: Partial<OrderPriceCooldown> = {}): OrderPriceCooldown {
  return {
    tokenId: createTokenId("token-1"),
    side: "buy",
    priceX10000: 4900,
    staleCancelCount: 1,
    cooldownUntilTsUtc: 1_000_000,
    lastEventTsUtc: 500_000,
    ...overrides,
  };
}

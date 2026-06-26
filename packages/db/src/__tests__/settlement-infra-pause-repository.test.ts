import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapLedgerDb } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteSettlementInfraPauseRepository } from "../repositories/settlement-infra-pause-repository.js";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteSettlementInfraPauseRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-settlement-pause-"));
  conn = bootstrapLedgerDb(path.join(tmpDir, "ledger.db"));
  repo = new SqliteSettlementInfraPauseRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteSettlementInfraPauseRepository (migration 078)", () => {
  it("creates the settlement_infra_pause table on bootstrap", () => {
    const table = conn.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("settlement_infra_pause");
    expect(table).toBeDefined();
  });

  it("returns null before any pause is persisted", () => {
    expect(repo.load()).toBeNull();
  });

  it("persists and overwrites a single pause row across restarts", () => {
    repo.save(1_000, "POLYGON_RPC_RATE_LIMITED");
    expect(repo.load()).toEqual({ disabledUntilMs: 1_000, code: "POLYGON_RPC_RATE_LIMITED" });

    repo.save(5_000, "POLYGON_RPC_RATE_LIMITED");
    expect(repo.load()).toEqual({ disabledUntilMs: 5_000, code: "POLYGON_RPC_RATE_LIMITED" });

    const count = conn.db.prepare("SELECT COUNT(*) AS c FROM settlement_infra_pause").get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  });
});

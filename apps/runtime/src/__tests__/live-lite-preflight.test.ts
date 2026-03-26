import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import { liveLitePreflight } from "../live-lite-preflight.js";
import type { LiveLiteConfig } from "../live-lite-guard.js";

const ENVELOPE: LiveLiteConfig = {
  familyAllowlist: ["fam-a", "fam-b"],
  maxFamilies: 2,
  maxOpenValueUsdc: 50,
  maxOrderUsdc: 10,
  maxActiveMarkets: 5,
};

function withTempDb(fn: (conn: DbConnection) => void): void {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-preflight-"));
  const conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  try {
    fn(conn);
  } finally {
    conn.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("liveLitePreflight", () => {
  it("returns shouldPause=false and no violations for a clean DB", () => {
    withTempDb((conn) => {
      const result = liveLitePreflight(conn.db, ENVELOPE);
      expect(result.shouldPause).toBe(false);
      expect(result.violations).toHaveLength(0);
    });
  });

  it("flags open position with non-allowlisted family", () => {
    withTempDb((conn) => {
      conn.db
        .prepare(
          `INSERT INTO positions (position_id, token_id, family_id, side, size, avg_entry_price, cost_basis_usdc, realized_pnl, status, opened_at, updated_at)
         VALUES ('pos-1', 'tok-1', 'fam-outside', 'buy', 10, 0.4, 4, 0, 'open', datetime('now'), datetime('now'))`,
        )
        .run();

      const result = liveLitePreflight(conn.db, ENVELOPE);

      expect(result.shouldPause).toBe(true);
      expect(result.violations.some((v) => v.includes("fam-outside"))).toBe(true);
    });
  });

  it("does not flag open position with allowlisted family", () => {
    withTempDb((conn) => {
      conn.db
        .prepare(
          `INSERT INTO positions (position_id, token_id, family_id, side, size, avg_entry_price, cost_basis_usdc, realized_pnl, status, opened_at, updated_at)
         VALUES ('pos-1', 'tok-1', 'fam-a', 'buy', 10, 0.4, 4, 0, 'open', datetime('now'), datetime('now'))`,
        )
        .run();

      const result = liveLitePreflight(conn.db, ENVELOPE);
      expect(result.shouldPause).toBe(false);
    });
  });

  it("flags combined exposure exceeding cap (position $40 + buy order $15 = $55 > $50)", () => {
    withTempDb((conn) => {
      conn.db
        .prepare(
          `INSERT INTO positions (position_id, token_id, family_id, side, size, avg_entry_price, cost_basis_usdc, realized_pnl, status, opened_at, updated_at)
         VALUES ('pos-1', 'tok-1', 'fam-a', 'buy', 100, 0.4, 40, 0, 'open', datetime('now'), datetime('now'))`,
        )
        .run();

      conn.db
        .prepare(
          `INSERT INTO orders (order_id, client_order_id, token_id, family_id, side, order_type, price, size, size_usdc, status, bot_run_id, created_at, updated_at)
         VALUES ('ord-1', 'plk_ord1', 'tok-2', 'fam-b', 'buy', 'limit', 0.5, 30, 15, 'open', 'run-1', datetime('now'), datetime('now'))`,
        )
        .run();

      const result = liveLitePreflight(conn.db, ENVELOPE);

      expect(result.shouldPause).toBe(true);
      expect(result.violations.some((v) => v.includes("exceeds cap"))).toBe(true);
    });
  });

  it("flags open order with non-allowlisted family", () => {
    withTempDb((conn) => {
      conn.db
        .prepare(
          `INSERT INTO orders (order_id, client_order_id, token_id, family_id, side, order_type, price, size, size_usdc, status, bot_run_id, created_at, updated_at)
         VALUES ('ord-1', 'plk_ord1', 'tok-1', 'fam-outside', 'buy', 'limit', 0.5, 10, 5, 'pending', 'run-1', datetime('now'), datetime('now'))`,
        )
        .run();

      const result = liveLitePreflight(conn.db, ENVELOPE);

      expect(result.shouldPause).toBe(true);
      expect(result.violations.some((v) => v.includes("fam-outside"))).toBe(true);
    });
  });

  it("flags active markets count exceeding cap", () => {
    withTempDb((conn) => {
      const envelope: LiveLiteConfig = { ...ENVELOPE, maxActiveMarkets: 1 };

      // Insert two open positions for different tokens
      conn.db
        .prepare(
          `INSERT INTO positions (position_id, token_id, family_id, side, size, avg_entry_price, cost_basis_usdc, realized_pnl, status, opened_at, updated_at)
         VALUES ('pos-1', 'tok-1', 'fam-a', 'buy', 5, 0.4, 2, 0, 'open', datetime('now'), datetime('now'))`,
        )
        .run();
      conn.db
        .prepare(
          `INSERT INTO positions (position_id, token_id, family_id, side, size, avg_entry_price, cost_basis_usdc, realized_pnl, status, opened_at, updated_at)
         VALUES ('pos-2', 'tok-2', 'fam-b', 'buy', 5, 0.4, 2, 0, 'open', datetime('now'), datetime('now'))`,
        )
        .run();

      const result = liveLitePreflight(conn.db, envelope);

      expect(result.shouldPause).toBe(true);
      expect(result.violations.some((v) => v.includes("active markets"))).toBe(true);
    });
  });
});

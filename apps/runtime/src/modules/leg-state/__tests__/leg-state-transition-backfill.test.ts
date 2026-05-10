import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { bootstrapDatabase, SqliteLegStateTransitionRepository } from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import { createTokenId } from "@krabs/domain";
import type { Logger } from "../../../logger.js";
import { backfillLegStateTransitionsFromLedger } from "../leg-state-transition-backfill.js";

function makeLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => makeLogger(),
  } as unknown as Logger;
}

function seedLedger(db: Database.Database): void {
  db.exec(`
    INSERT INTO positions (position_id, token_id, condition_id, side, size, avg_entry_price,
      cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, updated_at)
    VALUES ('pos-1', 'tok-1', 'cond-1', 'buy', 10, 0.1, 1, 1, 0, 'open',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

    INSERT INTO orders (order_id, client_order_id, token_id, condition_id, side, order_type,
      price, size, size_usdc, status, exchange_order_id, bot_run_id, created_at, updated_at)
    VALUES
      ('ord-1', 'coid-1', 'tok-1', 'cond-1', 'buy', 'GTC', 0.10, 5, 0.50, 'filled',
        'ex-1', 'run-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      ('ord-2', 'coid-2', 'tok-1', 'cond-1', 'buy', 'GTC', 0.08, 5, 0.40, 'filled',
        'ex-2', 'run-1', '2026-01-01T00:01:00Z', '2026-01-01T00:01:00Z'),
      ('ord-3', 'coid-3', 'tok-1', 'cond-1', 'sell', 'GTC', 0.20, 3, 0.60, 'filled',
        'ex-3', 'run-1', '2026-01-01T00:02:00Z', '2026-01-01T00:02:00Z'),
      ('ord-invalid', 'coid-invalid', 'tok-2', 'cond-2', 'sell', 'GTC', 0.30, 1, 0.30,
        'filled', 'ex-4', 'run-1', '2026-01-01T00:03:00Z', '2026-01-01T00:03:00Z');

    INSERT INTO fills (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
      filled_at)
    VALUES
      ('fill-1', 'ord-1', 'tok-1', 'cond-1', 'buy', 0.10, 5, 0.50,
        '2026-01-01T00:00:00Z'),
      ('fill-2', 'ord-2', 'tok-1', 'cond-1', 'buy', 0.08, 5, 0.40,
        '2026-01-01T00:01:00Z'),
      ('fill-3', 'ord-3', 'tok-1', 'cond-1', 'sell', 0.20, 3, 0.60,
        '2026-01-01T00:02:00Z'),
      ('fill-invalid', 'ord-invalid', 'tok-2', 'cond-2', 'sell', 0.30, 1, 0.30,
        '2026-01-01T00:03:00Z');
  `);
}

describe("backfillLegStateTransitionsFromLedger", () => {
  let conn: DbConnection;
  let db: Database.Database;
  let repo: SqliteLegStateTransitionRepository;

  beforeEach(() => {
    conn = bootstrapDatabase(":memory:");
    db = conn.db;
    repo = new SqliteLegStateTransitionRepository(db);
    seedLedger(db);
  });

  afterEach(() => {
    conn.close();
  });

  it("replays fills into an idempotent phase transition audit trail", () => {
    const first = backfillLegStateTransitionsFromLedger(db, repo, makeLogger());
    expect(first).toEqual({
      scannedFills: 4,
      insertedTransitions: 3,
      skippedInvalidSells: 1,
    });

    const transitions = repo.findByTokenId(createTokenId("tok-1"));
    expect(transitions.map((t) => `${t.fromPhase}->${t.toPhase}:${t.action}`)).toEqual([
      "S2->S3:SELL",
      "S1->S2:BUY",
      "S0->S1:BUY",
    ]);

    const second = backfillLegStateTransitionsFromLedger(db, repo, makeLogger());
    expect(second.insertedTransitions).toBe(0);
    expect(repo.findByTokenId(createTokenId("tok-1"))).toHaveLength(3);
  });
});

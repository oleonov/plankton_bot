import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrderId } from "@krabs/domain";
import { bootstrapLedgerDb } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteOrderRepository } from "../repositories/order-repository.js";
import { SqliteSettlementLedgerRepository } from "../repositories/settlement-ledger-repository.js";

// Incident 2026-10-05: exchange fill `…:08.000Z` on a BUY created locally at `…:08.228Z`.
const BUY_CREATED_AT = "2026-08-01T00:00:08.228Z";

describe("SqliteSettlementLedgerRepository.findLocalClosureEvidence fill attribution", () => {
  let conn: DbConnection;

  beforeEach(() => {
    conn = bootstrapLedgerDb(":memory:");
    conn.db.exec(`
      INSERT INTO positions (position_id,token_id,condition_id,side,size,status,opened_at,closed_at)
      VALUES ('position','loser','condition','buy',0,'closed',
        '2026-08-01T00:00:00.000Z','2026-08-02T00:00:00.000Z');
      INSERT INTO orders (order_id,client_order_id,exchange_order_id,token_id,condition_id,
        position_id,side,order_type,price,size,size_usdc,status,bot_run_id,created_at)
      VALUES ('sell','sell-client','sell-exchange','loser','condition','position','sell','GTC',
        0.2,10,2,'open','run','2026-08-01T00:00:30.000Z');`);
    conn.db
      .prepare(
        `INSERT INTO orders (order_id,client_order_id,exchange_order_id,token_id,condition_id,
        position_id,side,order_type,price,size,size_usdc,status,bot_run_id,created_at)
      VALUES ('buy','buy-client','buy-exchange','loser','condition','position','buy','GTC',
        0.1,10,1,'filled','run',?)`,
      )
      .run(BUY_CREATED_AT);
  });
  afterEach(() => conn.close());

  const evidenceWithBuyFillAt = (filledAt: string) => {
    conn.db
      .prepare(
        `INSERT INTO fills (fill_id,order_id,token_id,condition_id,side,price,size,size_usdc,reconciled,filled_at)
      VALUES ('buy-fill','buy','loser','condition','buy',0.1,10,1,1,?)`,
      )
      .run(filledAt);
    const sell = new SqliteOrderRepository(conn.db).findById(createOrderId("sell"))!;
    return new SqliteSettlementLedgerRepository(conn.db).findLocalClosureEvidence(sell);
  };

  it("attributes a whole-second fill to its order created later within that second", () => {
    const evidence = evidenceWithBuyFillAt("2026-08-01T00:00:08.000Z");
    expect(evidence?.fills.map((fill) => fill.fillId)).toEqual(["buy-fill"]);
  });

  it("rejects a fill a full second before its order's creation second", () => {
    expect(evidenceWithBuyFillAt("2026-08-01T00:00:07.000Z")).toBeNull();
  });
});

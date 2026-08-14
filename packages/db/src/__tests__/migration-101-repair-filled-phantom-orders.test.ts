import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/101_repair_filled_phantom_orders.sql", import.meta.url),
  "utf8",
);

type Order = {
  id: string;
  status?: string;
  exchangeId?: string | null;
  reason?: string | null;
  size?: number;
  metadata?: string | null;
  fill?: {
    size: number;
    side?: string;
    price?: number;
    sizeUsdc?: number;
    liquidityRole?: string;
  };
};

function fixture(orders: Order[]): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE orders (
      order_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      exchange_order_id TEXT,
      cancel_reason TEXT,
      size REAL NOT NULL,
      metadata_json TEXT
    );
    CREATE TABLE fills (
      fill_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL NOT NULL,
      size_usdc REAL NOT NULL,
      liquidity_role TEXT NOT NULL
    );
  `);
  const order = db.prepare(
    "INSERT INTO orders VALUES (@id, @status, @exchangeId, @reason, @size, @metadata)",
  );
  const fill = db.prepare("INSERT INTO fills VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const row of orders) {
    order.run({
      id: row.id,
      status: row.status ?? "cancelled",
      exchangeId: row.exchangeId === undefined ? row.id : row.exchangeId,
      reason: row.reason === undefined ? "phantom_missing_on_exchange" : row.reason,
      size: row.size ?? 100,
      metadata: row.metadata ?? '{"audit":"keep"}',
    });
    if (row.fill !== undefined) {
      fill.run(
        `fill-${row.id}`,
        row.id,
        row.fill.side ?? "buy",
        row.fill.price ?? 1,
        row.fill.size,
        row.fill.sizeUsdc ?? row.fill.size,
        row.fill.liquidityRole ?? "maker",
      );
    }
  }
  return db;
}

describe("migration 101 repair filled phantom orders", () => {
  it("repairs only exact, sufficiently covered cancelled phantom identities", () => {
    const db = fixture([
      { id: "complete", fill: { size: 100 } },
      { id: "near-complete", fill: { size: 99.5 } },
      {
        id: "legacy-taker",
        fill: { size: 99.4, price: 0.95, sizeUsdc: 95, liquidityRole: "taker" },
      },
      { id: "partial", fill: { size: 99.49 } },
      { id: "zero", fill: { size: 0 } },
      { id: "non-exact", exchangeId: "exchange-non-exact", fill: { size: 100 } },
      { id: "wrong-reason", reason: "operator_cancelled", fill: { size: 100 } },
      { id: "rejected", status: "rejected", fill: { size: 100 } },
      { id: "already-filled", status: "filled", fill: { size: 100 } },
      { id: "null-exchange", exchangeId: null, fill: { size: 100 } },
      {
        id: "legacy-maker",
        fill: { size: 99.4, price: 0.95, sizeUsdc: 95, liquidityRole: "maker" },
      },
    ]);
    const before = db
      .prepare("SELECT cancel_reason, metadata_json FROM orders WHERE order_id = 'complete'")
      .get();

    db.exec(migration);

    const statuses = db
      .prepare("SELECT order_id, status FROM orders ORDER BY order_id")
      .all() as Array<{ order_id: string; status: string }>;
    expect(Object.fromEntries(statuses.map((row) => [row.order_id, row.status]))).toEqual({
      "already-filled": "filled",
      complete: "filled",
      "legacy-maker": "cancelled",
      "legacy-taker": "filled",
      "near-complete": "filled",
      "non-exact": "cancelled",
      "null-exchange": "cancelled",
      partial: "cancelled",
      rejected: "rejected",
      "wrong-reason": "cancelled",
      zero: "cancelled",
    });
    expect(
      db
        .prepare("SELECT cancel_reason, metadata_json FROM orders WHERE order_id = 'complete'")
        .get(),
    ).toEqual(before);
    expect(db.prepare("SELECT status FROM orders WHERE order_id = 'legacy-maker'").get()).toEqual({
      status: "cancelled",
    });

    db.exec(migration);
    expect(db.prepare("SELECT changes() AS changed").get()).toEqual({ changed: 0 });
  });
});

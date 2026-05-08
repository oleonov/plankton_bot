/**
 * Reset persistent same-price cooldowns.
 *
 * Usage:
 *   npx tsx scripts/reset-order-price-cooldown.ts --db <ledger.db> --token-id <token>
 *   npx tsx scripts/reset-order-price-cooldown.ts --db <ledger.db> --token-id <token> --side buy --price 0.49 --apply
 *
 * Defaults to dry-run. Add --apply to delete rows.
 */

import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const Database = require("better-sqlite3") as typeof import("better-sqlite3").default;

interface Args {
  dbPath: string;
  tokenId: string;
  side: "buy" | "sell" | null;
  price: number | null;
  apply: boolean;
}

const args = parseArgs(process.argv.slice(2));
const priceX10000 = args.price == null ? null : Math.round(args.price * 10_000);
const db = new Database(args.dbPath, { readonly: !args.apply });

try {
  const rows = selectRows(db, args.tokenId, args.side, priceX10000);
  console.log(
    JSON.stringify(
      {
        mode: args.apply ? "apply" : "dry-run",
        matchedRows: rows.length,
        rows,
      },
      null,
      2,
    ),
  );

  if (args.apply) {
    const deleted = deleteRows(db, args.tokenId, args.side, priceX10000);
    console.log(`deleted ${deleted} cooldown row(s)`);
  }
} finally {
  db.close();
}

function parseArgs(raw: string[]): Args {
  const value = (name: string): string | null => {
    const index = raw.indexOf(name);
    return index >= 0 ? (raw[index + 1] ?? null) : null;
  };

  const dbPath = value("--db") ?? process.env.LEDGER_PATH ?? null;
  const tokenId = value("--token-id");
  const side = value("--side");
  const priceRaw = value("--price");
  if (!dbPath || !tokenId) {
    throw new Error("required: --db <ledger.db> --token-id <token>");
  }
  if (side != null && side !== "buy" && side !== "sell") {
    throw new Error("--side must be buy or sell");
  }
  if ((side == null) !== (priceRaw == null)) {
    throw new Error("--side and --price must be supplied together for exact-key reset");
  }
  const price = priceRaw == null ? null : Number(priceRaw);
  if (price != null && (!Number.isFinite(price) || price <= 0)) {
    throw new Error("--price must be a positive number");
  }

  return {
    dbPath,
    tokenId,
    side,
    price,
    apply: raw.includes("--apply"),
  };
}

function selectRows(
  db: import("better-sqlite3").Database,
  tokenId: string,
  side: "buy" | "sell" | null,
  priceX10000: number | null,
): unknown[] {
  if (side && priceX10000 != null) {
    return db
      .prepare(
        `SELECT * FROM order_price_cooldowns
         WHERE token_id = ? AND side = ? AND price_x10000 = ?`,
      )
      .all(tokenId, side, priceX10000);
  }
  return db
    .prepare("SELECT * FROM order_price_cooldowns WHERE token_id = ? ORDER BY side, price_x10000")
    .all(tokenId);
}

function deleteRows(
  db: import("better-sqlite3").Database,
  tokenId: string,
  side: "buy" | "sell" | null,
  priceX10000: number | null,
): number {
  if (side && priceX10000 != null) {
    return Number(
      db
        .prepare(
          `DELETE FROM order_price_cooldowns
           WHERE token_id = ? AND side = ? AND price_x10000 = ?`,
        )
        .run(tokenId, side, priceX10000).changes,
    );
  }
  return Number(
    db.prepare("DELETE FROM order_price_cooldowns WHERE token_id = ?").run(tokenId).changes,
  );
}

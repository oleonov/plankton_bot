import type Database from "better-sqlite3";
import type { TokenId } from "@plankton/domain";

export interface PriceHistoryProvider {
  findReferencePrice(tokenId: TokenId, targetMs: number, maxAgeMs: number): number | null;
}

export class MarketSnapshotPriceHistoryProvider implements PriceHistoryProvider {
  private readonly findReference;

  constructor(db: Database.Database) {
    this.findReference = db.prepare(
      `SELECT best_bid, best_ask, last_price
       FROM market_snapshots
       WHERE token_id = ?
         AND captured_at <= ?
         AND captured_at >= ?
       ORDER BY captured_at DESC
       LIMIT 1`,
    );
  }

  findReferencePrice(tokenId: TokenId, targetMs: number, maxAgeMs: number): number | null {
    const targetIso = new Date(targetMs).toISOString();
    const oldestIso = new Date(targetMs - maxAgeMs).toISOString();
    const row = this.findReference.get(tokenId, targetIso, oldestIso) as
      | {
          best_bid: number | null;
          best_ask: number | null;
          last_price: number | null;
        }
      | undefined;
    if (!row) return null;
    return normalizedSnapshotPrice(row);
  }
}

export function normalizedSnapshotPrice(row: {
  best_bid: number | null;
  best_ask: number | null;
  last_price: number | null;
}): number | null {
  const bid = finitePositive(row.best_bid);
  const ask = finitePositive(row.best_ask);
  if (bid != null && ask != null) return (bid + ask) / 2;
  return finitePositive(row.last_price) ?? bid ?? ask;
}

function finitePositive(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

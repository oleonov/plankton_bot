import type Database from "better-sqlite3";
import type { ExecutionTelemetrySnapshot } from "@plankton/domain";

export interface ProfileMetrics {
  openOrders: number;
  openPositions: number;
  totalExposureUsdc: number;
}

function emptyExecutionTelemetry(): ExecutionTelemetrySnapshot {
  return {
    totalFills: 0,
    volumeUsdc: 0,
    makerFills: 0,
    takerFills: 0,
    unknownFills: 0,
    makerRatio: null,
    takerRatio: null,
    explicitFeesUsdc: 0,
    feeLeakageRatio: null,
    lastFillAt: null,
  };
}

export class ValidationMetricsReader {
  constructor(private readonly ledgerDb: Database.Database) {}

  readProfileMetrics(): ProfileMetrics {
    const orders = this.ledgerDb
      .prepare(
        "SELECT COUNT(*) as cnt FROM orders WHERE status IN ('open', 'pending', 'partially-filled')",
      )
      .get() as { cnt: number };

    const positions = this.ledgerDb
      .prepare("SELECT COUNT(*) as cnt FROM positions WHERE status = 'open'")
      .get() as { cnt: number };

    const exposure = this.ledgerDb
      .prepare(
        "SELECT COALESCE(SUM(cost_basis_usdc), 0) as total FROM positions WHERE status = 'open'",
      )
      .get() as { total: number };

    return {
      openOrders: orders.cnt,
      openPositions: positions.cnt,
      totalExposureUsdc: exposure.total,
    };
  }

  /** Sum of realized PnL from all positions (closed + dust). */
  readRealizedPnl(): number {
    const row = this.ledgerDb
      .prepare("SELECT COALESCE(SUM(realized_pnl), 0) as total FROM positions")
      .get() as { total: number };
    return row.total;
  }

  readExecutionTelemetry(familyId: string, sinceHours: number = 24): ExecutionTelemetrySnapshot {
    const sinceIso = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
    const row = this.ledgerDb
      .prepare(
        `SELECT
           COUNT(*) AS total_fills,
           COALESCE(SUM(size_usdc), 0) AS volume_usdc,
           COALESCE(SUM(CASE WHEN liquidity_role = 'maker' THEN 1 ELSE 0 END), 0) AS maker_fills,
           COALESCE(SUM(CASE WHEN liquidity_role = 'taker' THEN 1 ELSE 0 END), 0) AS taker_fills,
           COALESCE(SUM(CASE WHEN liquidity_role = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_fills,
           COALESCE(SUM(fee), 0) AS explicit_fees_usdc,
           MAX(filled_at) AS last_fill_at
         FROM fills
         WHERE family_id = ? AND filled_at >= ?`,
      )
      .get(familyId, sinceIso) as
      | {
          total_fills: number;
          volume_usdc: number;
          maker_fills: number;
          taker_fills: number;
          unknown_fills: number;
          explicit_fees_usdc: number;
          last_fill_at: string | null;
        }
      | undefined;

    if (!row) return emptyExecutionTelemetry();

    const totalFills = row.total_fills ?? 0;
    const volumeUsdc = row.volume_usdc ?? 0;
    const makerFills = row.maker_fills ?? 0;
    const takerFills = row.taker_fills ?? 0;
    const unknownFills = row.unknown_fills ?? 0;
    const explicitFeesUsdc = row.explicit_fees_usdc ?? 0;

    return {
      totalFills,
      volumeUsdc,
      makerFills,
      takerFills,
      unknownFills,
      makerRatio: totalFills > 0 ? makerFills / totalFills : null,
      takerRatio: totalFills > 0 ? takerFills / totalFills : null,
      explicitFeesUsdc,
      feeLeakageRatio: volumeUsdc > 0 ? explicitFeesUsdc / volumeUsdc : null,
      lastFillAt: row.last_fill_at ?? null,
    };
  }
}

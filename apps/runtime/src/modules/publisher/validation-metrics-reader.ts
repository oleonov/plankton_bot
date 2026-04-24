import type Database from "better-sqlite3";

export interface ProfileMetrics {
  openOrders: number;
  openPositions: number;
  totalExposureUsdc: number;
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
      .prepare("SELECT COUNT(*) as cnt FROM positions WHERE status IN ('open','dust')")
      .get() as { cnt: number };

    const exposure = this.ledgerDb
      .prepare(
        "SELECT COALESCE(SUM(cost_basis_usdc), 0) as total FROM positions WHERE status IN ('open','dust')",
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
}

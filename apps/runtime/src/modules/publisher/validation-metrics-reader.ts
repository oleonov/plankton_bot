import type Database from "better-sqlite3";

function maxTimestamp(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export interface FamilyMetrics {
  familyId: string;
  openValueUsdc: number;
  openPositions: number;
  activeMarkets: number;
  realizedPnl: number;
  tailCostUsdc: number;
  tailAdjustedPnl: number;
  effectiveMode: string | null;
  lastTradeAt: string | null;
}

export interface ProfileMetrics {
  openOrders: number;
  openPositions: number;
  totalExposureUsdc: number;
}

export interface TradeMetrics {
  tradeCount: number;
  distinctMarkets: number;
  tailAdjustedPnl: number;
  realizedPnl: number;
  repricingExits: number;
  totalNonSettlementClosed: number;
}

export interface ToxicityMetrics {
  dustCount: number;
  positionCount: number;
  tailCostUsdc: number;
  realizedPnlUsdc: number;
  reduceOnlyCount: number;
  staleCount: number;
  totalOpen: number;
}

const EMPTY_FAMILY: Omit<FamilyMetrics, "familyId"> = {
  openValueUsdc: 0,
  openPositions: 0,
  activeMarkets: 0,
  realizedPnl: 0,
  tailCostUsdc: 0,
  tailAdjustedPnl: 0,
  effectiveMode: null,
  lastTradeAt: null,
};

export class ValidationMetricsReader {
  constructor(private readonly ledgerDb: Database.Database) {}

  readFamilyMetrics(familyIds: string[]): FamilyMetrics[] {
    if (familyIds.length === 0) return [];

    const stmt = this.ledgerDb.prepare(
      "SELECT * FROM family_runtime_state WHERE family_id = ?",
    );

    return familyIds.map((fid) => {
      const row = stmt.get(fid) as Record<string, unknown> | undefined;
      if (!row) return { familyId: fid, ...EMPTY_FAMILY };

      return {
        familyId: fid,
        openValueUsdc: Number(row.open_value_usdc ?? 0),
        openPositions: Number(row.open_position_count ?? 0),
        activeMarkets: Number(row.active_market_count ?? 0),
        realizedPnl: 0, // per-position PnL now computed in readTradeMetrics for scorecards
        tailCostUsdc: Number(row.current_tail_cost_usdc ?? 0),
        tailAdjustedPnl: Number(row.tail_adjusted_pnl_live ?? 0),
        effectiveMode: (row.effective_mode as string) ?? null,
        lastTradeAt: maxTimestamp(row.last_entry_ts as string | null, row.last_exit_ts as string | null),
      };
    });
  }

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
        "SELECT COALESCE(SUM(open_value_usdc), 0) as total FROM family_runtime_state",
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
      .prepare(
        "SELECT COALESCE(SUM(realized_pnl), 0) as total FROM positions",
      )
      .get() as { total: number };
    return row.total;
  }

  readTradeMetrics(familyId: string): TradeMetrics {
    const tradeCount = this.ledgerDb
      .prepare("SELECT COUNT(*) AS v FROM fills WHERE family_id = ?")
      .get(familyId) as { v: number };

    const distinctMarkets = this.ledgerDb
      .prepare("SELECT COUNT(DISTINCT token_id) AS v FROM fills WHERE family_id = ?")
      .get(familyId) as { v: number };

    const tailRow = this.ledgerDb
      .prepare("SELECT tail_adjusted_pnl_live AS v FROM family_runtime_state WHERE family_id = ?")
      .get(familyId) as { v: number } | undefined;

    const realizedPnlRow = this.ledgerDb
      .prepare("SELECT COALESCE(SUM(realized_pnl), 0) AS v FROM positions WHERE family_id = ?")
      .get(familyId) as { v: number };

    const repricingRows = this.ledgerDb
      .prepare(
        `SELECT pl.position_id
         FROM pnl_ledger pl
         JOIN fills f ON f.fill_id = pl.fill_id
         JOIN orders o ON o.order_id = f.order_id
         WHERE pl.family_id = ? AND o.signal_reason = 'repricing-exit'
         GROUP BY pl.position_id
         HAVING SUM(pl.delta) > 0`,
      )
      .all(familyId) as { position_id: string }[];

    const totalNonSettlementClosed = this.ledgerDb
      .prepare(
        `SELECT COUNT(*) AS v FROM positions
         WHERE family_id = ? AND status = 'closed'
         AND position_id NOT IN (SELECT position_id FROM settlement_ledger)`,
      )
      .get(familyId) as { v: number };

    return {
      tradeCount: tradeCount.v,
      distinctMarkets: distinctMarkets.v,
      tailAdjustedPnl: tailRow?.v ?? 0,
      realizedPnl: realizedPnlRow.v,
      repricingExits: repricingRows.length,
      totalNonSettlementClosed: totalNonSettlementClosed.v,
    };
  }

  readToxicityMetrics(familyId: string, staleHours: number = 48): ToxicityMetrics {
    const stateRow = this.ledgerDb
      .prepare(
        `SELECT open_dust_count, open_position_count, current_tail_cost_usdc
         FROM family_runtime_state WHERE family_id = ?`,
      )
      .get(familyId) as
      | { open_dust_count: number; open_position_count: number; current_tail_cost_usdc: number }
      | undefined;

    const realizedPnlRow = this.ledgerDb
      .prepare("SELECT COALESCE(SUM(realized_pnl), 0) AS v FROM positions WHERE family_id = ?")
      .get(familyId) as { v: number };

    const staleCutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
    const staleRow = this.ledgerDb
      .prepare(
        `SELECT COUNT(*) AS v FROM positions
         WHERE family_id = ? AND status = 'open' AND updated_at < ?`,
      )
      .get(familyId, staleCutoff) as { v: number };

    const totalOpenRow = this.ledgerDb
      .prepare("SELECT COUNT(*) AS v FROM positions WHERE family_id = ? AND status = 'open'")
      .get(familyId) as { v: number };

    return {
      dustCount: stateRow?.open_dust_count ?? 0,
      positionCount: stateRow?.open_position_count ?? 0,
      tailCostUsdc: stateRow?.current_tail_cost_usdc ?? 0,
      realizedPnlUsdc: realizedPnlRow.v,
      reduceOnlyCount: 0, // state_transitions lives in control DB, not available here
      staleCount: staleRow.v,
      totalOpen: totalOpenRow.v,
    };
  }
}

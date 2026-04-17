import type Database from "better-sqlite3";
import type { ExecutionTelemetrySnapshot } from "@plankton/domain";

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

const EMPTY_FAMILY: Omit<FamilyMetrics, "familyId"> = {
  openValueUsdc: 0,
  openPositions: 0,
  activeMarkets: 0,
  realizedPnl: 0,
  tailCostUsdc: 0,
  tailAdjustedPnl: 0,
  lastTradeAt: null,
};

export class ValidationMetricsReader {
  constructor(private readonly ledgerDb: Database.Database) {}

  readFamilyMetrics(familyIds: string[]): FamilyMetrics[] {
    if (familyIds.length === 0) return [];

    const stmt = this.ledgerDb.prepare("SELECT * FROM family_runtime_state WHERE family_id = ?");

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
        lastTradeAt: maxTimestamp(
          row.last_entry_ts as string | null,
          row.last_exit_ts as string | null,
        ),
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
      .prepare("SELECT COALESCE(SUM(open_value_usdc), 0) as total FROM family_runtime_state")
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

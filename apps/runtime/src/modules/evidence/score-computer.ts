/**
 * ScoreComputer — extracts raw metrics from SQLite for the pure scoring
 * functions in @plankton/domain/scoring.  Does NOT compute final scores;
 * callers feed the returned metric objects into the domain scoring fns.
 */

import type Database from "better-sqlite3";
import { type ProfileId } from "@plankton/domain";

// ─── Metric interfaces ──────────────────────────────────────────────────

export interface RecycleMetrics {
  tradeCount: number;
  distinctMarkets: number;
  tailAdjustedPnl: number;
  repricingExits: number;
  totalNonSettlementClosed: number;
}

export interface ToxicityMetrics {
  dustCount: number;
  positionCount: number;
  tailCostUsdc: number;
  realizedPnlUsdc: number;
  reduceOnlyCount: number;
  weeksDeployed: number;
  staleCount: number;
  totalOpen: number;
}

// ─── ScoreComputer ───────────────────────────────────────────────────────

export class ScoreComputer {
  private readonly controlDb: Database.Database | null;
  private readonly activeProfile: ProfileId | null;
  constructor(
    private readonly db: Database.Database,
    controlDb?: Database.Database,
    activeProfile?: ProfileId | null,
  ) {
    this.controlDb = controlDb ?? null;
    this.activeProfile = activeProfile ?? null;
  }

  computeRecycleMetrics(familyId: string): RecycleMetrics {
    const tradeCount = this.db
      .prepare(`SELECT COUNT(*) AS v FROM fills WHERE family_id = ?`)
      .get(familyId) as { v: number } | undefined;

    const distinctMarkets = this.db
      .prepare(`SELECT COUNT(DISTINCT token_id) AS v FROM fills WHERE family_id = ?`)
      .get(familyId) as { v: number } | undefined;

    const tailRow = this.db
      .prepare(`SELECT tail_adjusted_pnl_live AS v FROM family_runtime_state WHERE family_id = ?`)
      .get(familyId) as { v: number } | undefined;

    // Repricing exits: positions closed via repricing-exit that had positive PnL
    const repricingRows = this.db
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

    const totalNonSettlementClosed = this.db
      .prepare(
        `SELECT COUNT(*) AS v FROM positions
         WHERE family_id = ? AND status = 'closed'
         AND position_id NOT IN (SELECT position_id FROM settlement_ledger)`,
      )
      .get(familyId) as { v: number } | undefined;

    return {
      tradeCount: tradeCount?.v ?? 0,
      distinctMarkets: distinctMarkets?.v ?? 0,
      tailAdjustedPnl: tailRow?.v ?? 0,
      repricingExits: repricingRows.length,
      totalNonSettlementClosed: totalNonSettlementClosed?.v ?? 0,
    };
  }

  computeToxicityMetrics(familyId: string, staleHours: number = 48): ToxicityMetrics {
    const stateRow = this.db
      .prepare(
        `SELECT open_dust_count, open_position_count, current_tail_cost_usdc,
                tail_adjusted_pnl_live
         FROM family_runtime_state WHERE family_id = ?`,
      )
      .get(familyId) as
      | {
          open_dust_count: number;
          open_position_count: number;
          current_tail_cost_usdc: number;
          tail_adjusted_pnl_live: number;
        }
      | undefined;

    const realizedPnlRow = this.db
      .prepare(`SELECT SUM(realized_pnl) AS v FROM positions WHERE family_id = ?`)
      .get(familyId) as { v: number | null } | undefined;

    // state_transitions and family_catalog live in control.db, not ledger
    const ctrlDb = this.controlDb;
    const reduceOnlyRow = ctrlDb
      ? (ctrlDb
          .prepare(
            `SELECT COUNT(*) AS v FROM state_transitions
             WHERE entity_type = 'family' AND entity_id = ?
             AND to_state IN ('reduce-only', 'ReduceOnly')
             AND (
               ? IS NULL
               OR profile = ?
               OR (
                 profile IS NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM state_transitions st2
                   WHERE st2.entity_type = 'family'
                     AND st2.entity_id = ?
                     AND st2.to_state IN ('reduce-only', 'ReduceOnly')
                     AND st2.profile = ?
                 )
               )
             )`,
          )
          .get(familyId, this.activeProfile, this.activeProfile, familyId, this.activeProfile) as
          | { v: number }
          | undefined)
      : undefined;

    const catalogRow = ctrlDb
      ? (ctrlDb
          .prepare(`SELECT created_at FROM family_catalog WHERE family_id = ?`)
          .get(familyId) as { created_at: string } | undefined)
      : undefined;

    const weeksDeployed = catalogRow
      ? (Date.now() - new Date(catalogRow.created_at).getTime()) / (1000 * 60 * 60 * 24 * 7)
      : 0;

    // Stale positions: open positions whose last update is older than staleHours
    const staleCutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
    const staleRow = this.db
      .prepare(
        `SELECT COUNT(*) AS v FROM positions
         WHERE family_id = ? AND status = 'open' AND updated_at < ?`,
      )
      .get(familyId, staleCutoff) as { v: number } | undefined;

    const totalOpenRow = this.db
      .prepare(`SELECT COUNT(*) AS v FROM positions WHERE family_id = ? AND status = 'open'`)
      .get(familyId) as { v: number } | undefined;

    return {
      dustCount: stateRow?.open_dust_count ?? 0,
      positionCount: stateRow?.open_position_count ?? 0,
      tailCostUsdc: stateRow?.current_tail_cost_usdc ?? 0,
      realizedPnlUsdc: realizedPnlRow?.v ?? 0,
      reduceOnlyCount: reduceOnlyRow?.v ?? 0,
      weeksDeployed,
      staleCount: staleRow?.v ?? 0,
      totalOpen: totalOpenRow?.v ?? 0,
    };
  }
}

/**
 * ScoreComputer — extracts raw metrics from SQLite for the pure scoring
 * functions in @plankton/domain/scoring.  Does NOT compute final scores;
 * callers feed the returned metric objects into the domain scoring fns.
 */

import type Database from "better-sqlite3";
import { isWithinHealthWindow, type ProfileId } from "@plankton/domain";

// ─── Metric interfaces ──────────────────────────────────────────────────

export interface RecurrenceMetrics {
  spanDays: number;
  presenceDays: number;
  totalDays: number;
  cadenceStddev: number;
  cadenceMean: number;
  distinctConditions: number;
}

export interface RecycleMetrics {
  tradeCount: number;
  distinctMarkets: number;
  tailAdjustedPnl: number;
  repricingExits: number;
  totalNonSettlementClosed: number;
}

export interface LiveViabilityMetrics {
  activeMarketCount: number;
  healthyEndDateFraction: number;
  clusterVolume24h: number;
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

// ─── Helpers ─────────────────────────────────────────────────────────────

function computeGapStats(sortedDates: string[]): { mean: number; stddev: number } {
  if (sortedDates.length < 2) return { mean: 0, stddev: 0 };

  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(sortedDates[i - 1]!).getTime();
    const curr = new Date(sortedDates[i]!).getTime();
    gaps.push((curr - prev) / (1000 * 60 * 60 * 24));
  }

  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  return { mean, stddev: Math.sqrt(variance) };
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

  computeRecurrenceMetrics(candidateId: string): RecurrenceMetrics {
    const span = this.db
      .prepare(
        `SELECT julianday(MAX(observed_at)) - julianday(MIN(observed_at)) AS v
         FROM candidate_observations WHERE candidate_id = ?`,
      )
      .get(candidateId) as { v: number | null } | undefined;

    const presenceDays = this.db
      .prepare(
        `SELECT COUNT(DISTINCT date(observed_at)) AS v
         FROM candidate_observations
         WHERE candidate_id = ? AND active_market_count >= 2`,
      )
      .get(candidateId) as { v: number } | undefined;

    const totalDays = this.db
      .prepare(
        `SELECT COUNT(DISTINCT date(observed_at)) AS v
         FROM candidate_observations WHERE candidate_id = ?`,
      )
      .get(candidateId) as { v: number } | undefined;

    const distinctConditions = this.db
      .prepare(
        `SELECT COUNT(DISTINCT condition_id) AS v
         FROM candidate_observation_markets WHERE candidate_id = ?`,
      )
      .get(candidateId) as { v: number } | undefined;

    // Cadence: compute inter-observation-day gap stats
    const dateRows = this.db
      .prepare(
        `SELECT DISTINCT date(observed_at) AS d
         FROM candidate_observations WHERE candidate_id = ?
         ORDER BY d`,
      )
      .all(candidateId) as { d: string }[];

    const { mean, stddev } = computeGapStats(dateRows.map((r) => r.d));

    return {
      spanDays: span?.v ?? 0,
      presenceDays: presenceDays?.v ?? 0,
      totalDays: totalDays?.v ?? 0,
      cadenceMean: mean,
      cadenceStddev: stddev,
      distinctConditions: distinctConditions?.v ?? 0,
    };
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

  computeLiveViabilityMetrics(candidateId: string, horizon: string): LiveViabilityMetrics {
    const candidateRow = this.db
      .prepare(
        `SELECT active_market_count, cluster_volume_24h
         FROM family_candidates WHERE candidate_id = ?`,
      )
      .get(candidateId) as { active_market_count: number; cluster_volume_24h: number } | undefined;

    if (!candidateRow) {
      return { activeMarketCount: 0, healthyEndDateFraction: 0, clusterVolume24h: 0 };
    }

    // Latest observation timestamp
    const latestObs = this.db
      .prepare(
        `SELECT observed_at FROM candidate_observations
         WHERE candidate_id = ? ORDER BY observed_at DESC LIMIT 1`,
      )
      .get(candidateId) as { observed_at: string } | undefined;

    let healthyFraction = 0;
    if (latestObs) {
      const markets = this.db
        .prepare(
          `SELECT end_date FROM candidate_observation_markets
           WHERE candidate_id = ? AND observed_at = ?`,
        )
        .all(candidateId, latestObs.observed_at) as { end_date: string | null }[];

      if (markets.length > 0) {
        const now = new Date();
        const healthy = markets.filter((m) => isWithinHealthWindow(horizon, m.end_date, now));
        healthyFraction = healthy.length / markets.length;
      }
    }

    return {
      activeMarketCount: candidateRow.active_market_count,
      healthyEndDateFraction: healthyFraction,
      clusterVolume24h: candidateRow.cluster_volume_24h,
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

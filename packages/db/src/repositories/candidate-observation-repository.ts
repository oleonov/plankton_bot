import type Database from "better-sqlite3";
import type {
  CandidateObservationRepository,
  CandidateObservation,
  CandidateObservationMarket,
} from "@plankton/domain";

interface ObservationRow {
  id: number;
  candidate_id: string;
  active_market_count: number;
  cluster_volume_24h: number;
  nearest_end_date: string | null;
  observed_at: string;
}

interface MarketRow {
  candidate_id: string;
  observed_at: string;
  condition_id: string;
  slug: string;
  end_date: string | null;
  volume_24h: number | null;
}

function rowToObservation(row: ObservationRow): CandidateObservation {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    activeMarketCount: row.active_market_count,
    clusterVolume24h: row.cluster_volume_24h,
    nearestEndDate: row.nearest_end_date,
    observedAt: row.observed_at,
  };
}

function rowToMarket(row: MarketRow): CandidateObservationMarket {
  return {
    candidateId: row.candidate_id,
    observedAt: row.observed_at,
    conditionId: row.condition_id,
    slug: row.slug,
    endDate: row.end_date,
    volume24h: row.volume_24h,
  };
}

export class SqliteCandidateObservationRepository implements CandidateObservationRepository {
  constructor(private readonly db: Database.Database) {}

  insertObservation(obs: Omit<CandidateObservation, "id">): void {
    this.db
      .prepare(
        `INSERT INTO candidate_observations
           (candidate_id, active_market_count, cluster_volume_24h, nearest_end_date, observed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        obs.candidateId,
        obs.activeMarketCount,
        obs.clusterVolume24h,
        obs.nearestEndDate,
        obs.observedAt,
      );
  }

  insertMarkets(markets: CandidateObservationMarket[]): void {
    if (markets.length === 0) return;
    const insertMany = this.db.transaction((items: CandidateObservationMarket[]) => {
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO candidate_observation_markets
           (candidate_id, observed_at, condition_id, slug, end_date, volume_24h)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const m of items) {
        stmt.run(m.candidateId, m.observedAt, m.conditionId, m.slug, m.endDate, m.volume24h);
      }
    });
    insertMany(markets);
  }

  findObservations(candidateId: string, limit: number): CandidateObservation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM candidate_observations
         WHERE candidate_id = ? ORDER BY observed_at DESC LIMIT ?`,
      )
      .all(candidateId, limit) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  findMarkets(candidateId: string, observedAt: string): CandidateObservationMarket[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM candidate_observation_markets
         WHERE candidate_id = ? AND observed_at = ?`,
      )
      .all(candidateId, observedAt) as MarketRow[];
    return rows.map(rowToMarket);
  }

  countDistinctConditions(candidateId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT condition_id) as cnt
         FROM candidate_observation_markets WHERE candidate_id = ?`,
      )
      .get(candidateId) as { cnt: number };
    return row.cnt;
  }

  prune(olderThanIso: string): number {
    // Delete markets first (FK-safe), then observations
    this.db
      .prepare(
        `DELETE FROM candidate_observation_markets
         WHERE candidate_id || observed_at IN (
           SELECT candidate_id || observed_at FROM candidate_observations
           WHERE observed_at < ?
         )`,
      )
      .run(olderThanIso);
    const info = this.db
      .prepare("DELETE FROM candidate_observations WHERE observed_at < ?")
      .run(olderThanIso);
    return info.changes;
  }

  /**
   * Aggressively prune observation history for low-value tail candidates.
   * Low-value tail: discovered + ignore + low confidence + unmatched.
   * Deletes markets first (FK-safe), then observations.
   */
  pruneLowValueTail(olderThanIso: string): number {
    const lowValueFilter = `
      candidate_id IN (
        SELECT candidate_id FROM family_candidates
        WHERE status = 'discovered'
          AND gate_recommendation = 'ignore'
          AND pattern_confidence = 'low'
          AND matched_family_id IS NULL
      )
    `;

    this.db
      .prepare(
        `DELETE FROM candidate_observation_markets
         WHERE ${lowValueFilter}
           AND observed_at < ?`,
      )
      .run(olderThanIso);

    const info = this.db
      .prepare(
        `DELETE FROM candidate_observations
         WHERE ${lowValueFilter}
           AND observed_at < ?`,
      )
      .run(olderThanIso);

    return info.changes;
  }
}

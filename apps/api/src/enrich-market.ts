/**
 * Shared market metadata enrichment for API DTOs.
 * Looks up market rows by token_id and attaches slug, question, outcome, conditionId.
 */

import type Database from "better-sqlite3";

export interface MarketMeta {
  slug: string | null;
  eventSlug: string | null;
  question: string | null;
  outcome: string | null;
  conditionId: string | null;
  endDate: string | null;
}

const EMPTY_META: MarketMeta = {
  slug: null,
  eventSlug: null,
  question: null,
  outcome: null,
  conditionId: null,
  endDate: null,
};

/**
 * Build a Map<tokenId, MarketMeta> for a set of token IDs.
 * Single query with IN clause — avoids N+1.
 */
export function buildMarketMetaMap(
  db: Database.Database,
  tokenIds: string[],
): Map<string, MarketMeta> {
  const result = new Map<string, MarketMeta>();
  if (tokenIds.length === 0) return result;

  const unique = [...new Set(tokenIds)];
  const placeholders = unique.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT token_id, slug, event_slug, question, outcome, condition_id, end_date FROM markets WHERE token_id IN (${placeholders})`,
    )
    .all(...unique) as Array<Record<string, unknown>>;

  for (const row of rows) {
    result.set(row.token_id as string, {
      slug: (row.slug as string) ?? null,
      eventSlug: (row.event_slug as string) ?? null,
      question: (row.question as string) ?? null,
      outcome: (row.outcome as string) ?? null,
      conditionId: (row.condition_id as string) ?? null,
      endDate: (row.end_date as string) ?? null,
    });
  }

  return result;
}

/** Get meta for a single tokenId, returning EMPTY_META if not found. */
export function getMetaOrEmpty(metaMap: Map<string, MarketMeta>, tokenId: string): MarketMeta {
  return metaMap.get(tokenId) ?? EMPTY_META;
}

export interface ResolutionInfo {
  resolution: string; // "YES" | "NO" | "unknown"
  resolutionStatus: string; // "detected" | "settled"
}

/**
 * Build a Map<conditionId, ResolutionInfo> for a set of condition IDs.
 * Single query with IN clause — avoids N+1.
 */
export function buildResolutionMap(
  db: Database.Database,
  conditionIds: string[],
): Map<string, ResolutionInfo> {
  const result = new Map<string, ResolutionInfo>();
  const unique = [...new Set(conditionIds.filter(Boolean))];
  if (unique.length === 0) return result;

  const placeholders = unique.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT condition_id, resolution, status FROM market_resolutions WHERE condition_id IN (${placeholders})`,
    )
    .all(...unique) as Array<Record<string, unknown>>;

  for (const row of rows) {
    result.set(row.condition_id as string, {
      resolution: row.resolution as string,
      resolutionStatus: row.status as string,
    });
  }

  return result;
}

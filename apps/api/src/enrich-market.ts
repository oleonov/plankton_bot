/**
 * Shared market metadata enrichment for API DTOs.
 * Looks up market rows by token_id and attaches slug, question, outcome, conditionId.
 */

import type Database from "better-sqlite3";

export interface MarketMeta {
  slug: string | null;
  question: string | null;
  outcome: string | null;
  conditionId: string | null;
}

const EMPTY_META: MarketMeta = { slug: null, question: null, outcome: null, conditionId: null };

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
      `SELECT token_id, slug, question, outcome, condition_id FROM markets WHERE token_id IN (${placeholders})`,
    )
    .all(...unique) as Array<Record<string, unknown>>;

  for (const row of rows) {
    result.set(row.token_id as string, {
      slug: (row.slug as string) ?? null,
      question: (row.question as string) ?? null,
      outcome: (row.outcome as string) ?? null,
      conditionId: (row.condition_id as string) ?? null,
    });
  }

  return result;
}

/** Get meta for a single tokenId, returning EMPTY_META if not found. */
export function getMetaOrEmpty(
  metaMap: Map<string, MarketMeta>,
  tokenId: string,
): MarketMeta {
  return metaMap.get(tokenId) ?? EMPTY_META;
}

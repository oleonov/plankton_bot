import type Database from "better-sqlite3";
import {
  toCanonicalIso,
  type MarketResolutionRepository,
  type MarketResolution,
} from "@krabs/domain";

/**
 * Canonicalize a `resolved_at` value before it lands in the NOT NULL column.
 *
 * This repository is the ONLY writer of `market_resolutions.resolved_at`, so it is the single
 * place that must hold the invariant migration 095 established: every rendering is canonical
 * ISO-8601 UTC with milliseconds, or lexical order stops matching chronological order again. A
 * caller-side fix (e.g. only the detector's delisted-market fallback) would miss any other
 * source of a legacy rendering — `candidates[].endDate` alone already carries 1M+ historical
 * `markets.end_date` values in the 20-char ISO-without-ms shape.
 *
 * Falls back to the raw value, never NULL, when `toCanonicalIso` can't parse it: the column is
 * declared NOT NULL, so writing NULL would trade a bad rendering for a crash. Preserving the raw
 * value keeps today's behavior for whatever unparseable input already flows through unnoticed.
 */
function canonicalResolvedAt(resolvedAt: string): string {
  return toCanonicalIso(resolvedAt) ?? resolvedAt;
}

export class SqliteMarketResolutionRepository implements MarketResolutionRepository {
  constructor(private readonly db: Database.Database) {}

  save(resolution: MarketResolution): void {
    this.db
      .prepare(
        `INSERT INTO market_resolutions
           (condition_id, resolution, resolved_at, detected_at, source, raw_response, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(condition_id) DO NOTHING`,
      )
      .run(
        resolution.conditionId,
        resolution.resolution,
        canonicalResolvedAt(resolution.resolvedAt),
        resolution.detectedAt,
        resolution.source,
        resolution.rawResponse,
        resolution.status,
      );
  }

  findByConditionId(conditionId: string): MarketResolution | null {
    const row = this.db
      .prepare("SELECT * FROM market_resolutions WHERE condition_id = ?")
      .get(conditionId) as Record<string, unknown> | undefined;
    return row ? this.rowToResolution(row) : null;
  }

  findAll(): MarketResolution[] {
    const rows = this.db.prepare("SELECT * FROM market_resolutions").all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToResolution(r));
  }

  updateResolution(
    conditionId: string,
    resolution: string,
    resolvedAt: string,
    source: string,
  ): void {
    this.db
      .prepare(
        `UPDATE market_resolutions
         SET resolution = ?, resolved_at = ?, source = ?, status = 'settled'
         WHERE condition_id = ?`,
      )
      .run(resolution, canonicalResolvedAt(resolvedAt), source, conditionId);
  }

  promoteUnknownResolution(
    conditionId: string,
    resolution: string,
    resolvedAt: string,
    source: MarketResolution["source"],
    rawResponse: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE market_resolutions
         SET resolution = ?, resolved_at = ?, source = ?, raw_response = ?
         WHERE condition_id = ? AND status = 'detected' AND resolution = 'unknown'`,
      )
      .run(resolution, canonicalResolvedAt(resolvedAt), source, rawResponse, conditionId);
    return result.changes === 1;
  }

  markSettled(conditionId: string): void {
    this.db
      .prepare("UPDATE market_resolutions SET status = 'settled' WHERE condition_id = ?")
      .run(conditionId);
  }

  private rowToResolution(row: Record<string, unknown>): MarketResolution {
    return {
      conditionId: row.condition_id as string,
      resolution: row.resolution as string,
      resolvedAt: row.resolved_at as string,
      detectedAt: row.detected_at as string,
      source: row.source as MarketResolution["source"],
      rawResponse: (row.raw_response as string) ?? null,
      status: (row.status as "detected" | "settled") ?? "settled",
    };
  }
}

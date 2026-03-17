import type Database from "better-sqlite3";
import type { MarketResolutionRepository } from "@plankton/domain";
import type { MarketResolution } from "@plankton/domain";

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
        resolution.resolvedAt,
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
    const rows = this.db
      .prepare("SELECT * FROM market_resolutions")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToResolution(r));
  }

  markSettled(conditionId: string): void {
    this.db
      .prepare("UPDATE market_resolutions SET status = 'settled' WHERE condition_id = ?")
      .run(conditionId);
  }

  private rowToResolution(row: Record<string, unknown>): MarketResolution {
    return {
      conditionId: row.condition_id as string,
      resolution: row.resolution as "YES" | "NO" | "unknown",
      resolvedAt: row.resolved_at as string,
      detectedAt: row.detected_at as string,
      source: row.source as MarketResolution["source"],
      rawResponse: (row.raw_response as string) ?? null,
      status: (row.status as "detected" | "settled") ?? "settled",
    };
  }
}

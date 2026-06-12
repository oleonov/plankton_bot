import type Database from "better-sqlite3";
import type { RiskEventRepository, S1OrphanOwnership } from "@krabs/domain";

export class SqliteRiskEventRepository implements RiskEventRepository {
  constructor(private readonly db: Database.Database) {}

  insert(event: { eventType: string; payload: Record<string, unknown> }): void {
    this.db
      .prepare("INSERT INTO risk_events (event_type, payload) VALUES (?, ?)")
      .run(event.eventType, JSON.stringify(event.payload));
  }

  countSince(createdAtIso: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM risk_events WHERE created_at >= ?")
      .get(toSqliteDateTime(createdAtIso)) as { c: number };
    return row.c;
  }

  findOrphanS1Ownerships(): S1OrphanOwnership[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.payload, a.created_at
         FROM risk_events a
         WHERE a.event_type = 's1_ownership_assumed'
           AND NOT EXISTS (
             SELECT 1
             FROM risk_events r2
             WHERE r2.event_type = 's1_ownership_released'
               AND json_extract(r2.payload, '$.tokenId') = json_extract(a.payload, '$.tokenId')
               AND r2.id > a.id
           )
         ORDER BY a.id ASC`,
      )
      .all() as Array<{ id: number; payload: string; created_at: string }>;

    const latestByToken = new Map<string, { id: number; ownership: S1OrphanOwnership }>();
    for (const row of rows) {
      const payload = parsePayload(row.payload);
      const tokenId = readString(payload.tokenId);
      if (!tokenId) continue;
      const conditionId = readString(payload.conditionId) ?? "";
      const ladderId = readString(payload.ladderId) ?? `recovered_${tokenId}`;
      const assumedAtIso =
        readString(payload.signalTimestamp) ?? sqliteDateTimeToIso(row.created_at);
      latestByToken.set(tokenId, {
        id: row.id,
        ownership: { tokenId, conditionId, ladderId, assumedAtIso },
      });
    }

    return [...latestByToken.values()].sort((a, b) => a.id - b.id).map((entry) => entry.ownership);
  }
}

function toSqliteDateTime(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sqliteDateTimeToIso(value: string): string {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

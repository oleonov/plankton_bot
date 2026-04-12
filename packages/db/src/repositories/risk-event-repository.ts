import type Database from "better-sqlite3";
import type { RiskEventRepository, FamilyId } from "@plankton/domain";

export class SqliteRiskEventRepository implements RiskEventRepository {
  constructor(private readonly db: Database.Database) {}

  insert(event: {
    eventType: string;
    familyId: FamilyId | null;
    payload: Record<string, unknown>;
  }): void {
    this.db
      .prepare("INSERT INTO risk_events (event_type, family_id, payload) VALUES (?, ?, ?)")
      .run(event.eventType, event.familyId, JSON.stringify(event.payload));
  }

  countSince(createdAtIso: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM risk_events WHERE created_at >= ?")
      .get(createdAtIso) as { c: number };
    return row.c;
  }
}

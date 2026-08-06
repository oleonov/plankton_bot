import type Database from "better-sqlite3";
import type { RiskEventRepository, S1OrphanOwnership } from "@krabs/domain";
import { withShutdownBusyTimeout } from "../connection.js";
import { toSqliteDateTime } from "../db-timestamp.js";

export class SqliteRiskEventRepository implements RiskEventRepository {
  private shuttingDown = false;

  constructor(private readonly db: Database.Database) {}

  /**
   * From here on every risk_events INSERT is bounded by the short teardown busy_timeout.
   *
   * The bound lives HERE, not in `RiskEventWriter`, because that writer is only one of roughly a
   * dozen holders of this repository, and several of them — the order-lifetime module among them —
   * insert during their own `stop()`. better-sqlite3 is synchronous, so a single insert that loses
   * the writer lock to the checkpoint worker freezes the event loop for the connection's full
   * 30-second timeout, during which neither the teardown deadline nor the global shutdown timer can
   * fire. One choke point every holder already goes through is the only place the bound is
   * checkable; per-caller bounds would be a list to keep in sync forever.
   *
   * Reads are deliberately left alone: WAL readers do not contend for the writer lock.
   *
   * Like {@link withShutdownBusyTimeout} itself, this is per-WRITE and never a connection-wide
   * pragma — execution drains its queue on this same connection, and an order the exchange has
   * already accepted must be persisted at the full runtime timeout or it exists on the exchange
   * with no local row.
   */
  enterShutdownMode(): void {
    this.shuttingDown = true;
  }

  insert(event: { eventType: string; payload: Record<string, unknown> }): void {
    const write = (): void => {
      this.db
        .prepare("INSERT INTO risk_events (event_type, payload) VALUES (?, ?)")
        .run(event.eventType, JSON.stringify(event.payload));
    };
    if (this.shuttingDown) {
      withShutdownBusyTimeout(this.db, write);
      return;
    }
    write();
  }

  countSince(createdAtIso: string): number {
    // The bound is rendered in the column's own space format because `insert` above never binds
    // `created_at` — the `DEFAULT (datetime('now'))` is its sole writer. An unparseable bound is
    // passed through untouched rather than silently shifted to a different instant.
    const ms = Date.parse(createdAtIso);
    const bound = Number.isFinite(ms) ? toSqliteDateTime(ms) : createdAtIso;
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM risk_events WHERE created_at >= ?")
      .get(bound) as { c: number };
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

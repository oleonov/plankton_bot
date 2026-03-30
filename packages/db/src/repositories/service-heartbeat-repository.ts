import type Database from "better-sqlite3";
import type { ServiceHeartbeatRepository, ServiceHeartbeat } from "@plankton/domain";
import type { ProfileId } from "@plankton/domain";

export class SqliteServiceHeartbeatRepository implements ServiceHeartbeatRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(heartbeat: ServiceHeartbeat): void {
    this.db
      .prepare(
        `INSERT INTO service_heartbeats
         (service_name, instance_id, profile, run_id, last_heartbeat_at, status_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(service_name, instance_id) DO UPDATE SET
           profile = excluded.profile,
           run_id = excluded.run_id,
           last_heartbeat_at = excluded.last_heartbeat_at,
           status_json = excluded.status_json`,
      )
      .run(
        heartbeat.serviceName,
        heartbeat.instanceId,
        heartbeat.profile,
        heartbeat.runId,
        heartbeat.lastHeartbeatAt,
        heartbeat.statusJson,
      );
  }

  findByService(serviceName: string): ServiceHeartbeat[] {
    const rows = this.db
      .prepare("SELECT * FROM service_heartbeats WHERE service_name = ?")
      .all(serviceName) as Record<string, unknown>[];
    return rows.map(rowToHeartbeat);
  }

  findAll(): ServiceHeartbeat[] {
    const rows = this.db.prepare("SELECT * FROM service_heartbeats").all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToHeartbeat);
  }
}

function rowToHeartbeat(row: Record<string, unknown>): ServiceHeartbeat {
  return {
    serviceName: row.service_name as string,
    instanceId: row.instance_id as string,
    profile: (row.profile as ProfileId) ?? null,
    runId: (row.run_id as string) ?? null,
    lastHeartbeatAt: row.last_heartbeat_at as string,
    statusJson: (row.status_json as string) ?? null,
  };
}

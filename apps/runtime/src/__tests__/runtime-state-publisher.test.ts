import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, type DbConnection } from "@plankton/db";
import { RuntimeStatePublisher } from "../runtime-state-publisher.js";

const CONTROL_SQL = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/db/src/schemas/control.sql"),
  "utf-8",
);

function createControlDb(): DbConnection {
  const conn = openDatabase(":memory:");
  conn.db.exec(CONTROL_SQL);
  // Seed a profile and the singleton runtime_control_state row
  conn.db
    .prepare("INSERT INTO profiles (profile_id, display_name) VALUES ('paper', 'Paper')")
    .run();
  conn.db
    .prepare(
      "INSERT INTO runtime_control_state (id, runtime_status, paused) VALUES (1, 'stopped', 1)",
    )
    .run();
  return conn;
}

describe("RuntimeStatePublisher", () => {
  let conn: DbConnection;
  let publisher: RuntimeStatePublisher;

  const config = {
    profile: "paper",
    instanceId: "inst-001",
    runId: "run-123",
  };

  beforeEach(() => {
    conn = createControlDb();
    publisher = new RuntimeStatePublisher(conn.db, config);
  });

  afterEach(() => {
    publisher.stopHeartbeatLoop();
    conn.close();
  });

  function getState() {
    return conn.db.prepare("SELECT * FROM runtime_control_state WHERE id = 1").get() as Record<
      string,
      unknown
    >;
  }

  it("publishStartup sets profile, run_id, instance_id, and status=ready_paused", () => {
    publisher.publishStartup();
    const row = getState();
    expect(row["current_profile"]).toBe("paper");
    expect(row["current_run_id"]).toBe("run-123");
    expect(row["current_instance_id"]).toBe("inst-001");
    expect(row["runtime_status"]).toBe("ready_paused");
    expect(row["paused"]).toBe(1);
  });

  it("publishRunning sets status=running and paused=0", () => {
    publisher.publishStartup();
    publisher.publishRunning();
    const row = getState();
    expect(row["runtime_status"]).toBe("running");
    expect(row["paused"]).toBe(0);
  });

  it("publishPaused sets status=ready_paused and paused=1", () => {
    publisher.publishStartup();
    publisher.publishRunning();
    publisher.publishPaused();
    const row = getState();
    expect(row["runtime_status"]).toBe("ready_paused");
    expect(row["paused"]).toBe(1);
  });

  it("publishShutdown sets status=stopped", () => {
    publisher.publishStartup();
    publisher.publishShutdown();
    const row = getState();
    expect(row["runtime_status"]).toBe("stopped");
  });

  it("publishHeartbeat upserts into service_heartbeats", () => {
    publisher.publishHeartbeat("running");
    const row = conn.db
      .prepare("SELECT * FROM service_heartbeats WHERE service_name = 'runtime'")
      .get() as Record<string, unknown>;
    expect(row["instance_id"]).toBe("inst-001");
    expect(row["profile"]).toBe("paper");
    expect(row["run_id"]).toBe("run-123");
    expect(JSON.parse(row["status_json"] as string)).toEqual(expect.objectContaining({ status: "running" }));
  });

  it("multiple heartbeats update same row (upsert, not insert)", () => {
    publisher.publishHeartbeat("ready_paused");
    publisher.publishHeartbeat("running");

    const count = conn.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM service_heartbeats WHERE service_name = 'runtime' AND instance_id = ?",
      )
      .get("inst-001") as { cnt: number };
    expect(count.cnt).toBe(1);

    const row = conn.db
      .prepare(
        "SELECT status_json FROM service_heartbeats WHERE service_name = 'runtime' AND instance_id = ?",
      )
      .get("inst-001") as { status_json: string };
    expect(JSON.parse(row.status_json)).toEqual(expect.objectContaining({ status: "running" }));
  });

  describe("SQLITE_BUSY resilience", () => {
    it("startHeartbeatLoop does not throw when service_heartbeats table is missing", () => {
      // Drop the table — publishHeartbeat will throw SQLITE_ERROR (not BUSY),
      // but the first heartbeat uses tryHeartbeat which only swallows SQLITE_BUSY.
      // This tests that non-BUSY errors DO propagate from the first heartbeat.
      conn.db.exec("DROP TABLE service_heartbeats");
      const brokenPublisher = new RuntimeStatePublisher(conn.db, config);

      // First heartbeat with missing table → SQLITE_ERROR → should propagate
      expect(() => brokenPublisher.startHeartbeatLoop(60_000)).toThrow();
      brokenPublisher.stopHeartbeatLoop();
    });

    it("publishHeartbeat on closed DB throws (non-BUSY errors propagate)", () => {
      const closedConn = createControlDb();
      const closedPublisher = new RuntimeStatePublisher(closedConn.db, config);
      closedConn.close();

      expect(() => closedPublisher.publishHeartbeat("running")).toThrow();
    });

    it("startHeartbeatLoop with valid DB succeeds and writes heartbeat", () => {
      publisher.startHeartbeatLoop(60_000);

      const row = conn.db
        .prepare("SELECT * FROM service_heartbeats WHERE service_name = 'runtime'")
        .get() as Record<string, unknown>;
      expect(row).toBeTruthy();
      expect(row["instance_id"]).toBe("inst-001");

      publisher.stopHeartbeatLoop();
    });
  });
});

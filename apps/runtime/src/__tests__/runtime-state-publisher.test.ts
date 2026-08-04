import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, type DbConnection } from "@krabs/db";
import { RuntimeStatePublisher } from "../runtime-state-publisher.js";
import { PeriodicTimers } from "../periodic-timers.js";
import type { TimerRegistry } from "../periodic-timers.js";

// A RAW registry on purpose: the real `PeriodicTimers` swallows a throwing tick, which would make
// the "SQLITE_BUSY is swallowed" assertions below vacuous — they must keep proving that
// `tryHeartbeat` itself swallows BUSY, not that the registry hides everything.
const rawTimers: TimerRegistry = {
  every: (_name, intervalMs, tick) => setInterval(tick, intervalMs),
};

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
    expect(JSON.parse(row["status_json"] as string)).toEqual(
      expect.objectContaining({ status: "running" }),
    );
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
      expect(() => brokenPublisher.startHeartbeatLoop(60_000, rawTimers)).toThrow();
      brokenPublisher.stopHeartbeatLoop();
    });

    it("publishHeartbeat on closed DB throws (non-BUSY errors propagate)", () => {
      const closedConn = createControlDb();
      const closedPublisher = new RuntimeStatePublisher(closedConn.db, config);
      closedConn.close();

      expect(() => closedPublisher.publishHeartbeat("running")).toThrow();
    });

    it("startHeartbeatLoop with valid DB succeeds and writes heartbeat", () => {
      publisher.startHeartbeatLoop(60_000, rawTimers);

      const row = conn.db
        .prepare("SELECT * FROM service_heartbeats WHERE service_name = 'runtime'")
        .get() as Record<string, unknown>;
      expect(row).toBeTruthy();
      expect(row["instance_id"]).toBe("inst-001");

      publisher.stopHeartbeatLoop();
    });

    it("first heartbeat SQLITE_BUSY is swallowed — startHeartbeatLoop does not throw", () => {
      const busyError = new Error("database is locked") as Error & { code: string };
      busyError.code = "SQLITE_BUSY";

      const spy = vi.spyOn(publisher, "publishHeartbeat").mockImplementation(() => {
        throw busyError;
      });

      // Should NOT throw — SQLITE_BUSY is swallowed on first heartbeat
      expect(() => publisher.startHeartbeatLoop(60_000, rawTimers)).not.toThrow();
      publisher.stopHeartbeatLoop();
      spy.mockRestore();
    });

    it("interval heartbeat SQLITE_BUSY is swallowed — loop continues", () => {
      vi.useFakeTimers();

      const busyError = new Error("database is locked") as Error & { code: string };
      busyError.code = "SQLITE_BUSY";

      publisher.startHeartbeatLoop(1_000, rawTimers);

      // Verify first heartbeat wrote normally
      const row1 = conn.db
        .prepare("SELECT * FROM service_heartbeats WHERE service_name = 'runtime'")
        .get() as Record<string, unknown>;
      expect(row1).toBeTruthy();

      // Make next heartbeat throw SQLITE_BUSY
      const spy = vi.spyOn(publisher, "publishHeartbeat").mockImplementation(() => {
        throw busyError;
      });

      // Advance timer — interval fires, SQLITE_BUSY swallowed, no crash
      expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();

      // Restore and advance again — heartbeat resumes
      spy.mockRestore();
      vi.advanceTimersByTime(1_000);

      publisher.stopHeartbeatLoop();
      vi.useRealTimers();
    });

    it("registers the tick so teardown's stopAll() cancels it before the supervisor wait", () => {
      // `tryHeartbeat` rethrows everything that is not SQLITE_BUSY — SQLITE_FULL under disk
      // pressure, or a closed connection during teardown. A bare interval has no handler above it,
      // so that escape ends Node; and `stopHeartbeatLoop()` only runs AFTER the 40-second
      // supervisor wait, across which a 15-second heartbeat fires about nine times. Being in the
      // registry is what moves the cancellation to the top of the handler.
      vi.useFakeTimers();
      const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), child: () => log } as any;
      const timers = new PeriodicTimers(log);
      const spy = vi.spyOn(publisher, "publishHeartbeat");

      publisher.startHeartbeatLoop(1_000, timers);
      expect(spy).toHaveBeenCalledTimes(1); // the direct first heartbeat

      timers.stopAll();
      vi.advanceTimersByTime(5_000);

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      vi.useRealTimers();
    });
  });
});

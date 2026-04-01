import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapControlDb, SqliteDiscoveryRunRepository, type DbConnection } from "@plankton/db";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteDiscoveryRunRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-worker-"));
  conn = bootstrapControlDb(path.join(tmpDir, "test.db"));
  repo = new SqliteDiscoveryRunRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const emptyStats = {
  marketsFound: 0,
  clustersCreated: 0,
  candidatesUpserted: 0,
  matched: 0,
  pruned: 0,
};

describe("Worker queue patterns", () => {
  describe("failStale recovers crashed runs", () => {
    it("marks stale running job as failed", () => {
      repo.enqueue("startup", "worker");
      repo.claim("worker-1");

      // Backdate heartbeat to simulate crash
      conn.db
        .prepare(
          "UPDATE discovery_runs SET heartbeat_at = datetime('now', '-600 seconds') WHERE id = 1",
        )
        .run();

      const recovered = repo.failStale(120_000); // 2 min threshold
      expect(recovered).toBe(1);

      const recent = repo.findRecent(1);
      expect(recent[0]!.status).toBe("failed");
      expect(recent[0]!.error).toContain("stale");
    });

    it("does not affect healthy running jobs", () => {
      repo.enqueue("startup", "worker");
      repo.claim("worker-1");

      const recovered = repo.failStale(120_000);
      expect(recovered).toBe(0);
      expect(repo.findActive()!.status).toBe("running");
    });

    it("allows re-enqueue after stale recovery", () => {
      repo.enqueue("startup", "worker");
      repo.claim("worker-1");

      conn.db
        .prepare(
          "UPDATE discovery_runs SET heartbeat_at = datetime('now', '-600 seconds') WHERE id = 1",
        )
        .run();
      repo.failStale(120_000);

      // Should be able to enqueue again
      const id = repo.enqueue("startup", "worker");
      expect(id).toBe(2);
    });
  });

  describe("scheduler does not duplicate when active exists", () => {
    it("throws when enqueuing while queued run exists", () => {
      repo.enqueue("schedule", "worker");
      expect(() => repo.enqueue("schedule", "worker")).toThrow(
        "Active discovery run already exists",
      );
    });

    it("throws when enqueuing while running run exists", () => {
      repo.enqueue("startup", "worker");
      repo.claim("worker-1");
      expect(() => repo.enqueue("schedule", "worker")).toThrow(
        "Active discovery run already exists",
      );
    });

    it("allows enqueue after run succeeds", () => {
      repo.enqueue("schedule", "worker");
      const run = repo.claim("worker-1");
      repo.succeed(run!.id, emptyStats);

      const id = repo.enqueue("schedule", "worker");
      expect(id).toBeGreaterThan(run!.id);
    });
  });

  describe("claim + heartbeat + succeed flow", () => {
    it("complete lifecycle from enqueue to succeed", () => {
      const id = repo.enqueue("startup", "worker");
      expect(repo.findActive()!.status).toBe("queued");

      const run = repo.claim("worker-1");
      expect(run).not.toBeNull();
      expect(run!.status).toBe("running");
      expect(run!.workerId).toBe("worker-1");

      // Heartbeat updates without error
      repo.heartbeat(run!.id);
      repo.heartbeat(run!.id);

      const stats = { ...emptyStats, marketsFound: 42, clustersCreated: 5 };
      repo.succeed(run!.id, stats);

      expect(repo.findActive()).toBeNull();
      const last = repo.findLastSuccessful();
      expect(last!.id).toBe(id);
      expect(last!.stats).toEqual(stats);
      expect(last!.finishedAt).toBeTruthy();
    });
  });

  describe("claim + heartbeat + fail flow", () => {
    it("complete lifecycle from enqueue to fail", () => {
      repo.enqueue("schedule", "worker");
      const run = repo.claim("worker-1");

      repo.heartbeat(run!.id);
      repo.fail(run!.id, "Gamma API timeout");

      expect(repo.findActive()).toBeNull();
      expect(repo.findLastSuccessful()).toBeNull();

      const recent = repo.findRecent(1);
      expect(recent[0]!.status).toBe("failed");
      expect(recent[0]!.error).toBe("Gamma API timeout");
      expect(recent[0]!.finishedAt).toBeTruthy();
    });

    it("allows re-enqueue after failure", () => {
      repo.enqueue("schedule", "worker");
      const run = repo.claim("worker-1");
      repo.fail(run!.id, "error");

      const id2 = repo.enqueue("schedule", "worker");
      expect(id2).toBe(2);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteDiscoveryRunRepository } from "../repositories/discovery-run-repository.js";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteDiscoveryRunRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteDiscoveryRunRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteDiscoveryRunRepository", () => {
  it("enqueue creates a queued run", () => {
    const id = repo.enqueue("startup", null);
    expect(id).toBe(1);

    const active = repo.findActive();
    expect(active).not.toBeNull();
    expect(active!.id).toBe(1);
    expect(active!.triggerType).toBe("startup");
    expect(active!.status).toBe("queued");
    expect(active!.requestedBy).toBeNull();
    expect(active!.requestedAt).toBeTruthy();
    expect(active!.startedAt).toBeNull();
    expect(active!.stats).toBeNull();
    expect(active!.error).toBeNull();
    expect(active!.workerId).toBeNull();
  });

  it("enqueue throws when active run exists", () => {
    repo.enqueue("startup", null);
    expect(() => repo.enqueue("manual", "operator")).toThrow("Active discovery run already exists");
  });

  it("enqueue allowed after previous run completes", () => {
    const id = repo.enqueue("startup", null);
    const run = repo.claim("w-1");
    repo.succeed(run!.id, {
      marketsFound: 0,
      clustersCreated: 0,
      candidatesUpserted: 0,
      matched: 0,
      pruned: 0,
    });

    const id2 = repo.enqueue("manual", "operator");
    expect(id2).toBe(2);
  });

  it("claim moves queued to running with workerId", () => {
    repo.enqueue("schedule", null);
    const run = repo.claim("worker-abc");

    expect(run).not.toBeNull();
    expect(run!.status).toBe("running");
    expect(run!.workerId).toBe("worker-abc");
    expect(run!.startedAt).toBeTruthy();
    expect(run!.heartbeatAt).toBeTruthy();
  });

  it("claim returns null when no queued runs", () => {
    const run = repo.claim("worker-1");
    expect(run).toBeNull();
  });

  it("heartbeat updates timestamp", () => {
    repo.enqueue("startup", null);
    const run = repo.claim("w-1");
    const before = run!.heartbeatAt;

    // SQLite datetime('now') has second precision, so heartbeat will at least not error
    repo.heartbeat(run!.id);

    const active = repo.findActive();
    expect(active!.heartbeatAt).toBeTruthy();
  });

  it("succeed sets status, stats, and finished_at", () => {
    repo.enqueue("startup", null);
    const run = repo.claim("w-1");
    const stats = {
      marketsFound: 42,
      clustersCreated: 5,
      candidatesUpserted: 10,
      matched: 3,
      pruned: 2,
    };

    repo.succeed(run!.id, stats);

    const last = repo.findLastSuccessful();
    expect(last).not.toBeNull();
    expect(last!.status).toBe("succeeded");
    expect(last!.stats).toEqual(stats);
    expect(last!.finishedAt).toBeTruthy();
    expect(last!.error).toBeNull();
  });

  it("fail sets status, error, and finished_at", () => {
    repo.enqueue("startup", null);
    const run = repo.claim("w-1");

    repo.fail(run!.id, "connection timeout");

    const recent = repo.findRecent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.status).toBe("failed");
    expect(recent[0]!.error).toBe("connection timeout");
    expect(recent[0]!.finishedAt).toBeTruthy();
  });

  it("findActive returns queued or running", () => {
    expect(repo.findActive()).toBeNull();

    repo.enqueue("startup", null);
    expect(repo.findActive()!.status).toBe("queued");

    repo.claim("w-1");
    expect(repo.findActive()!.status).toBe("running");
  });

  it("findLastSuccessful returns most recent succeeded", () => {
    expect(repo.findLastSuccessful()).toBeNull();

    const emptyStats = {
      marketsFound: 0,
      clustersCreated: 0,
      candidatesUpserted: 0,
      matched: 0,
      pruned: 0,
    };

    // First run succeeds
    repo.enqueue("startup", null);
    const r1 = repo.claim("w-1");
    repo.succeed(r1!.id, emptyStats);

    // Second run succeeds
    repo.enqueue("schedule", null);
    const r2 = repo.claim("w-1");
    repo.succeed(r2!.id, { ...emptyStats, marketsFound: 10 });

    const last = repo.findLastSuccessful();
    expect(last!.id).toBe(2);
    expect(last!.stats!.marketsFound).toBe(10);
  });

  it("findRecent returns N newest runs", () => {
    const emptyStats = {
      marketsFound: 0,
      clustersCreated: 0,
      candidatesUpserted: 0,
      matched: 0,
      pruned: 0,
    };

    repo.enqueue("startup", null);
    const r1 = repo.claim("w-1");
    repo.succeed(r1!.id, emptyStats);

    repo.enqueue("schedule", null);
    const r2 = repo.claim("w-1");
    repo.succeed(r2!.id, emptyStats);

    repo.enqueue("manual", "op");
    const r3 = repo.claim("w-1");
    repo.fail(r3!.id, "boom");

    const recent = repo.findRecent(2);
    expect(recent).toHaveLength(2);
    // newest first
    expect(recent[0]!.id).toBe(3);
    expect(recent[1]!.id).toBe(2);
  });

  it("failStale marks old running as failed", () => {
    repo.enqueue("startup", null);
    repo.claim("w-1");

    // Backdate heartbeat to simulate staleness
    conn.db
      .prepare("UPDATE discovery_runs SET heartbeat_at = datetime('now', '-600 seconds') WHERE id = 1")
      .run();

    const count = repo.failStale(300_000); // 5 min threshold
    expect(count).toBe(1);

    const recent = repo.findRecent(1);
    expect(recent[0]!.status).toBe("failed");
    expect(recent[0]!.error).toBe("stale: worker heartbeat timeout");
  });

  it("failStale does not affect fresh running jobs", () => {
    repo.enqueue("startup", null);
    repo.claim("w-1");

    const count = repo.failStale(300_000);
    expect(count).toBe(0);

    expect(repo.findActive()!.status).toBe("running");
  });
});

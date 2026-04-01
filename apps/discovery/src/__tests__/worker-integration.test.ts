import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapControlDb, SqliteDiscoveryRunRepository, type DbConnection } from "@plankton/db";

/**
 * Integration tests for worker startup + queue lifecycle.
 *
 * Unit-level repository tests live in packages/db; these tests exercise the
 * multi-step sequences the worker performs at boot and during processing.
 */

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteDiscoveryRunRepository;

const emptyStats = {
  marketsFound: 0,
  clustersCreated: 0,
  candidatesUpserted: 0,
  matched: 0,
  pruned: 0,
};

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-wint-"));
  conn = bootstrapControlDb(path.join(tmpDir, "test.db"));
  repo = new SqliteDiscoveryRunRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Worker startup sequence", () => {
  it("recovers stale run then enqueues initial scan", () => {
    // Simulate a previous crashed run
    repo.enqueue("schedule", "worker");
    repo.claim("old-worker");
    conn.db
      .prepare(
        "UPDATE discovery_runs SET heartbeat_at = datetime('now', '-600 seconds') WHERE id = 1",
      )
      .run();

    // Worker startup: step 1 — recover stale
    const recovered = repo.failStale(120_000);
    expect(recovered).toBe(1);

    // Worker startup: step 2 — no recent success → enqueue initial
    const lastSuccess = repo.findLastSuccessful();
    expect(lastSuccess).toBeNull();
    const id = repo.enqueue("startup", "worker");
    expect(id).toBe(2);

    // Step 3 — claim and complete
    const run = repo.claim("new-worker");
    expect(run).not.toBeNull();
    expect(run!.id).toBe(2);
    repo.succeed(run!.id, { ...emptyStats, marketsFound: 10 });

    expect(repo.findActive()).toBeNull();
    expect(repo.findLastSuccessful()!.stats!.marketsFound).toBe(10);
  });

  it("skips initial enqueue when recent success exists", () => {
    // Seed a recent success
    repo.enqueue("schedule", "worker");
    const run = repo.claim("w-1");
    repo.succeed(run!.id, emptyStats);

    // Worker startup: step 1 — no stale
    expect(repo.failStale(120_000)).toBe(0);

    // Step 2 — recent success exists, no initial enqueue needed
    const lastSuccess = repo.findLastSuccessful();
    expect(lastSuccess).not.toBeNull();
    // In the worker, it checks age — we just verify the method works
    expect(lastSuccess!.finishedAt).toBeTruthy();
  });
});

describe("Manual trigger deduplication", () => {
  it("does not duplicate when scan already queued", () => {
    repo.enqueue("schedule", "worker");

    // Manual trigger while queued run exists
    const active = repo.findActive();
    expect(active).not.toBeNull();
    expect(active!.status).toBe("queued");

    // Worker code path: check active before enqueue
    expect(() => repo.enqueue("manual", "operator")).toThrow("Active discovery run already exists");
  });

  it("does not duplicate when scan already running", () => {
    repo.enqueue("schedule", "worker");
    repo.claim("worker-1");

    const active = repo.findActive();
    expect(active!.status).toBe("running");

    expect(() => repo.enqueue("manual", "operator")).toThrow("Active discovery run already exists");
  });

  it("manual enqueue succeeds after previous completes", () => {
    repo.enqueue("schedule", "worker");
    const run = repo.claim("worker-1");
    repo.succeed(run!.id, emptyStats);

    const id = repo.enqueue("manual", "operator");
    expect(id).toBe(2);
    const active = repo.findActive();
    expect(active!.triggerType).toBe("manual");
    expect(active!.requestedBy).toBe("operator");
  });
});

describe("Full enqueue → claim → succeed lifecycle", () => {
  it("stores stats and clears active slot", () => {
    const id = repo.enqueue("startup", "worker");

    // Queued
    const queued = repo.findActive();
    expect(queued!.status).toBe("queued");

    // Claim
    const run = repo.claim("worker-abc");
    expect(run!.id).toBe(id);
    expect(run!.status).toBe("running");

    // Heartbeats
    repo.heartbeat(run!.id);

    // Succeed with stats
    const stats = { ...emptyStats, marketsFound: 42, clustersCreated: 5 };
    repo.succeed(run!.id, stats);

    // Active slot cleared
    expect(repo.findActive()).toBeNull();

    // Stats stored
    const last = repo.findLastSuccessful();
    expect(last!.stats).toEqual(stats);
    expect(last!.finishedAt).toBeTruthy();
  });
});

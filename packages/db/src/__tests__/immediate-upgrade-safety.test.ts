import { describe, it, expect } from "vitest";
import { bootstrapDatabase } from "../bootstrap.js";
import { SqliteDiscoveryRunRepository } from "../repositories/discovery-run-repository.js";

describe("discovery-run-repository claim() uses immediate transaction", () => {
  it("claim() succeeds and returns the claimed run", () => {
    const conn = bootstrapDatabase(":memory:");
    const repo = new SqliteDiscoveryRunRepository(conn.db);

    const id = repo.enqueue("manual", "test");

    const claimed = repo.claim("worker-1");
    expect(claimed).toBeTruthy();
    expect(claimed!.id).toBe(id);
    expect(claimed!.status).toBe("running");
  });

  it("claim() returns null when queue is empty", () => {
    const conn = bootstrapDatabase(":memory:");
    const repo = new SqliteDiscoveryRunRepository(conn.db);

    const claimed = repo.claim("worker-1");
    expect(claimed).toBeNull();
  });
});

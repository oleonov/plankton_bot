import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteRiskEventRepository } from "../repositories/risk-event-repository.js";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteRiskEventRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteRiskEventRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteRiskEventRepository", () => {
  it("insert persists a risk event", () => {
    repo.insert({
      eventType: "signal_rejected",
      payload: { reasonCode: "max_dust_positions", rawReason: "dust 3 >= max 2" },
    });

    const rows = conn.db.prepare("SELECT * FROM risk_events").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe("signal_rejected");
    const payload = JSON.parse(rows[0]!.payload as string) as Record<string, unknown>;
    expect(payload.reasonCode).toBe("max_dust_positions");
  });

  it("insert multiple events", () => {
    repo.insert({
      eventType: "family_quarantined",
      payload: { reason: "operator command" },
    });
    repo.insert({
      eventType: "family_activated",
      payload: { reason: "resumed" },
    });

    const count = conn.db.prepare("SELECT COUNT(*) as c FROM risk_events").get() as { c: number };
    expect(count.c).toBe(2);
  });

  it("countSince returns recent event volume", () => {
    repo.insert({ eventType: "older", payload: { reason: "old" } });
    repo.insert({ eventType: "recent", payload: { reason: "new" } });

    conn.db
      .prepare("UPDATE risk_events SET created_at = ? WHERE event_type = 'older'")
      .run("2026-04-10T00:00:00.000Z");
    conn.db
      .prepare("UPDATE risk_events SET created_at = ? WHERE event_type = 'recent'")
      .run("2026-04-12T00:00:00.000Z");

    expect(repo.countSince("2026-04-11T00:00:00.000Z")).toBe(1);
    expect(repo.countSince("2026-04-09T00:00:00.000Z")).toBe(2);
  });
});

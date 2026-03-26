import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteRiskEventRepository } from "../repositories/risk-event-repository.js";
import { createFamilyId } from "@plankton/domain";

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
      familyId: createFamilyId("fam-btc"),
      payload: { reasonCode: "max_dust_positions", rawReason: "dust 3 >= max 2" },
    });

    const rows = conn.db.prepare("SELECT * FROM risk_events").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe("signal_rejected");
    expect(rows[0]!.family_id).toBe("fam-btc");
    const payload = JSON.parse(rows[0]!.payload as string) as Record<string, unknown>;
    expect(payload.reasonCode).toBe("max_dust_positions");
  });

  it("insert with null familyId", () => {
    repo.insert({
      eventType: "reconciliation_drift",
      familyId: null,
      payload: { details: "phantom order detected" },
    });

    const rows = conn.db.prepare("SELECT * FROM risk_events").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.family_id).toBeNull();
  });

  it("insert multiple events", () => {
    repo.insert({
      eventType: "family_quarantined",
      familyId: createFamilyId("fam-1"),
      payload: { reason: "operator command" },
    });
    repo.insert({
      eventType: "family_activated",
      familyId: createFamilyId("fam-1"),
      payload: { reason: "resumed" },
    });

    const count = conn.db.prepare("SELECT COUNT(*) as c FROM risk_events").get() as { c: number };
    expect(count.c).toBe(2);
  });
});

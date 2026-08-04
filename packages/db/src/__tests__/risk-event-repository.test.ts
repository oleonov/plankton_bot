import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { RUNTIME_BUSY_TIMEOUT_MS, SHUTDOWN_BUSY_TIMEOUT_MS } from "../connection.js";
import { SqliteRiskEventRepository } from "../repositories/risk-event-repository.js";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteRiskEventRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-test-"));
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
      eventType: "reconciliation_drift",
      payload: { details: "phantom order", severity: "warn" },
    });
    repo.insert({
      eventType: "max_exposure_breach",
      payload: { currentExposure: 612.5, limit: 500 },
    });

    const count = conn.db.prepare("SELECT COUNT(*) as c FROM risk_events").get() as { c: number };
    expect(count.c).toBe(2);
  });

  describe("enterShutdownMode", () => {
    // risk_events keeps being written while modules stop: RiskEventWriter's OrderRejected /
    // SignalRejected subscriptions are permanent, and order-lifetime inserts from inside its own
    // stop(). better-sqlite3 is synchronous, so one such insert losing the writer lock to the
    // checkpoint worker freezes the event loop for the connection's full 30s timeout — longer than
    // the whole shutdown budget. The bound sits on the repository because ~a dozen holders insert
    // through it directly; bounding one caller would leave the rest open.
    const pragmaCalls: string[] = [];

    beforeEach(() => {
      pragmaCalls.length = 0;
      const original = conn.db.pragma.bind(conn.db);
      conn.db.pragma = ((source: string, options?: unknown) => {
        pragmaCalls.push(source);
        return original(source, options as never);
      }) as typeof conn.db.pragma;
    });

    it("bounds the insert to the teardown busy_timeout and restores the connection's own", () => {
      repo.insert({ eventType: "signal_rejected", payload: {} });
      // Steady state pays no pragma round-trip — the bound is per-write, not per-connection.
      expect(pragmaCalls).toEqual([]);

      repo.enterShutdownMode();
      repo.insert({ eventType: "signal_rejected", payload: {} });

      expect(pragmaCalls).toContain(`busy_timeout = ${SHUTDOWN_BUSY_TIMEOUT_MS}`);
      // Restored, not left low: execution drains its queue on this same connection and an
      // exchange-accepted order must still persist at the full runtime timeout.
      expect(pragmaCalls.at(-1)).toBe(`busy_timeout = ${RUNTIME_BUSY_TIMEOUT_MS}`);
      expect(conn.db.pragma("busy_timeout", { simple: true })).toBe(RUNTIME_BUSY_TIMEOUT_MS);
    });

    it("still persists the row", () => {
      repo.enterShutdownMode();
      repo.insert({ eventType: "max_exposure_breach", payload: { limit: 500 } });

      const rows = conn.db.prepare("SELECT event_type FROM risk_events").all() as Array<{
        event_type: string;
      }>;
      expect(rows.map((r) => r.event_type)).toEqual(["max_exposure_breach"]);
    });
  });

  it("countSince returns recent event volume", () => {
    repo.insert({ eventType: "older", payload: { reason: "old" } });
    repo.insert({ eventType: "recent", payload: { reason: "new" } });

    conn.db
      .prepare("UPDATE risk_events SET created_at = ? WHERE event_type = 'older'")
      .run("2026-04-10 00:00:00");
    conn.db
      .prepare("UPDATE risk_events SET created_at = ? WHERE event_type = 'recent'")
      .run("2026-04-12 00:00:00");

    expect(repo.countSince("2026-04-11T00:00:00.000Z")).toBe(1);
    expect(repo.countSince("2026-04-09T00:00:00.000Z")).toBe(2);
  });

  it("finds unreleased S1 ownerships by tokenId inside payload JSON", () => {
    repo.insert({
      eventType: "s1_ownership_assumed",
      payload: {
        tokenId: "token-a",
        conditionId: "condition-a",
        ladderId: "ladder-a",
        signalTimestamp: "2026-06-12T10:00:00.000Z",
      },
    });
    repo.insert({
      eventType: "s1_ownership_assumed",
      payload: {
        tokenId: "token-b",
        conditionId: "condition-b",
        ladderId: "ladder-b",
        signalTimestamp: "2026-06-12T10:01:00.000Z",
      },
    });
    repo.insert({
      eventType: "s1_ownership_released",
      payload: {
        tokenId: "token-b",
        conditionId: "condition-b",
        ladderId: "ladder-b",
        reason: "fill",
        signalTimestamp: "2026-06-12T10:02:00.000Z",
      },
    });

    expect(repo.findOrphanS1Ownerships()).toEqual([
      {
        tokenId: "token-a",
        conditionId: "condition-a",
        ladderId: "ladder-a",
        assumedAtIso: "2026-06-12T10:00:00.000Z",
      },
    ]);
  });

  it("uses the latest unreleased assumption per token after a release pair", () => {
    repo.insert({
      eventType: "s1_ownership_assumed",
      payload: {
        tokenId: "token-a",
        conditionId: "condition-a",
        ladderId: "ladder-old",
        signalTimestamp: "2026-06-12T09:00:00.000Z",
      },
    });
    repo.insert({
      eventType: "s1_ownership_released",
      payload: {
        tokenId: "token-a",
        conditionId: "condition-a",
        ladderId: "ladder-old",
        reason: "operator",
        signalTimestamp: "2026-06-12T09:10:00.000Z",
      },
    });
    repo.insert({
      eventType: "s1_ownership_assumed",
      payload: {
        tokenId: "token-a",
        conditionId: "condition-a",
        ladderId: "ladder-new",
        signalTimestamp: "2026-06-12T10:00:00.000Z",
      },
    });

    expect(repo.findOrphanS1Ownerships()).toEqual([
      {
        tokenId: "token-a",
        conditionId: "condition-a",
        ladderId: "ladder-new",
        assumedAtIso: "2026-06-12T10:00:00.000Z",
      },
    ]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { bootstrapControlDb } from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import { StatusHistorySampler } from "../status-history-sampler.js";
import { startOfUtcDay } from "../status-history-store.js";

let ctrl: DbConnection;
let ledger: Database.Database;
const T = Date.UTC(2026, 6, 1, 12, 0, 0); // noon
const DAY = startOfUtcDay(T);

beforeEach(() => {
  ctrl = bootstrapControlDb(":memory:");
  // The runtime seeds this row in prod; a bare bootstrap does not, so ensure it.
  ctrl.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
  ctrl.db.prepare("UPDATE runtime_control_state SET paused = 0 WHERE id = 1").run();
  ledger = new Database(":memory:");
  ledger.exec(
    `CREATE TABLE runtime_metrics (
       id INTEGER PRIMARY KEY AUTOINCREMENT, metric_name TEXT NOT NULL,
       value REAL NOT NULL, labels TEXT, captured_at TEXT NOT NULL);
     CREATE TABLE position_drifts (status TEXT NOT NULL)`,
  );
});
afterEach(() => {
  ledger.close();
  ctrl.close();
});

function seedHeartbeat(atMs: number): void {
  ctrl.db
    .prepare(
      `INSERT INTO service_heartbeats (service_name, instance_id, last_heartbeat_at)
       VALUES ('runtime', 'i1', ?)
       ON CONFLICT(service_name, instance_id) DO UPDATE SET last_heartbeat_at = excluded.last_heartbeat_at`,
    )
    .run(new Date(atMs).toISOString());
}
function seedMarket(atMs: number): void {
  ledger
    .prepare(
      "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('market_data_last_update', 1, NULL, ?)",
    )
    .run(new Date(atMs).toISOString());
  const at = new Date(atMs).toISOString();
  ledger
    .prepare(
      "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, 1, NULL, ?)",
    )
    .run("last_reconciliation", at);
  ledger
    .prepare(
      "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, 1, NULL, ?)",
    )
    .run("reconciliation_clean", at);
}
function setPaused(paused: boolean): void {
  ctrl.db.prepare("UPDATE runtime_control_state SET paused = ? WHERE id = 1").run(paused ? 1 : 0);
}

function sampler(): StatusHistorySampler {
  return new StatusHistorySampler({
    ledgerDb: ledger,
    controlDb: ctrl.db,
    marketDataStaleThresholdMs: 120_000,
    intervalMs: 60_000,
    warmupBackstopMs: 300_000,
    heartbeatStaleMs: 90_000,
  });
}

function uptimeRow(): {
  sev: string;
  crit: number;
  known: number;
  maint: number;
  paused: number;
} {
  return ctrl.db
    .prepare(
      `SELECT sev, crit_secs AS crit, known_secs AS known, maintenance_secs AS maint, paused_secs AS paused
         FROM status_history WHERE series = 'uptime' AND bucket_ts = ?`,
    )
    .get(DAY) as { sev: string; crit: number; known: number; maint: number; paused: number };
}

describe("StatusHistorySampler — deploy warm-up / pause states", () => {
  it("writes uptime + 8 module series each tick", () => {
    sampler().tick(T);
    const rows = ctrl.db
      .prepare("SELECT DISTINCT series FROM status_history WHERE bucket_ts = ?")
      .all(DAY) as { series: string }[];
    expect(rows).toHaveLength(9);
  });

  it("records warm-up (no post-start evidence) as maintenance, not crit", () => {
    sampler().tick(T); // first tick: no heartbeat/market yet → warm-up
    const r = uptimeRow();
    expect(r.maint).toBeGreaterThan(0);
    expect(r.crit).toBe(0);
  });

  it("stale pre-restart evidence does NOT latch — stays maintenance", () => {
    // fresh but written BEFORE the sampler started → must not count as ready.
    seedHeartbeat(T - 10_000);
    seedMarket(T - 10_000);
    sampler().tick(T); // samplerStartedAt = T; evidence ≤ T → not post-start
    const r = uptimeRow();
    expect(r.maint).toBeGreaterThan(0);
    expect(r.crit).toBe(0);
  });

  it("latches ready on fresh post-start evidence and then records normal health", () => {
    const s = sampler();
    s.tick(T); // warm-up (maintenance 60s)
    seedHeartbeat(T + 30_000); // post-start + fresh
    seedMarket(T + 30_000);
    s.tick(T + 60_000); // ready → latch → normal
    const r = uptimeRow();
    expect(r.known).toBe(120); // both ticks observed
    expect(r.maint).toBe(60); // only the first (warm-up) tick was maintenance
    expect(r.crit).toBe(0);
    expect(r.sev).toBe("ok");
  });

  it("records unknown reconciliation evidence as a warning", () => {
    const s = sampler();
    s.tick(T);
    seedHeartbeat(T + 30_000);
    seedMarket(T + 30_000);
    ledger.prepare("DELETE FROM runtime_metrics WHERE metric_name = 'reconciliation_clean'").run();
    s.tick(T + 60_000);
    const row = ctrl.db
      .prepare("SELECT sev FROM status_history WHERE series = 'module:reconciliation'")
      .get() as { sev: string };
    expect(row.sev).toBe("warn");
  });

  it("records acknowledged external-state quarantine as warning, not green", () => {
    const s = sampler();
    s.tick(T);
    seedHeartbeat(T + 30_000);
    seedMarket(T + 30_000);
    const at = new Date(T + 30_000).toISOString();
    ledger.prepare("DELETE FROM runtime_metrics WHERE metric_name = 'reconciliation_clean'").run();
    ledger
      .prepare(
        "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, 1, NULL, ?)",
      )
      .run("reconciliation_acknowledged_external_state_unknown", at);
    s.tick(T + 60_000);
    const row = ctrl.db
      .prepare("SELECT sev FROM status_history WHERE series = 'module:reconciliation'")
      .get() as { sev: string };
    expect(row.sev).toBe("warn");
    expect(uptimeRow().sev).toBe("warn");
  });

  it("records crit once the warm-up backstop is exceeded without readiness", () => {
    const s = sampler();
    s.tick(T); // warm-up
    s.tick(T + 400_000); // > 300s backstop, still no evidence → dead runtime → crit
    expect(uptimeRow().crit).toBeGreaterThan(0);
  });

  it("records paused (not crit) when the runtime heartbeat is live", () => {
    const s = sampler();
    s.tick(T);
    seedHeartbeat(T + 30_000);
    seedMarket(T + 30_000);
    setPaused(true);
    s.tick(T + 60_000); // ready + paused + live → paused
    const r = uptimeRow();
    expect(r.paused).toBeGreaterThan(0);
    expect(r.crit).toBe(0);
  });

  it("records crit (not paused) when paused but the heartbeat is dead — no masking", () => {
    const s = sampler();
    s.tick(T);
    seedHeartbeat(T + 30_000);
    seedMarket(T + 30_000);
    s.tick(T + 60_000); // latch ready
    setPaused(true);
    // heartbeat now stale (last at T+30s); far past warm-up → dead runtime is an outage
    s.tick(T + 260_000);
    expect(uptimeRow().crit).toBeGreaterThan(0);
  });

  it("is fail-soft — a closed control DB does not throw", () => {
    const s = sampler();
    ctrl.close();
    expect(() => s.tick(T)).not.toThrow();
  });
});

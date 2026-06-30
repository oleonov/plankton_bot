import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { bootstrapControlDb } from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import { StatusHistorySampler } from "../status-history-sampler.js";
import { startOfUtcDay } from "../status-history-store.js";

let ctrl: DbConnection;
let ledger: Database.Database;
const NOON = Date.UTC(2026, 5, 30, 12, 0, 0);
const DAY = startOfUtcDay(NOON);

beforeEach(() => {
  ctrl = bootstrapControlDb(":memory:");
  ctrl.db
    .prepare("UPDATE runtime_control_state SET runtime_status = 'running', paused = 0 WHERE id = 1")
    .run();
  ledger = new Database(":memory:");
});
afterEach(() => {
  ledger.close();
  ctrl.close();
});

function sampler(): StatusHistorySampler {
  return new StatusHistorySampler({
    ledgerDb: ledger,
    controlDb: ctrl.db,
    marketDataStaleThresholdMs: 120_000,
    intervalMs: 60_000,
  });
}

describe("StatusHistorySampler", () => {
  it("writes uptime + 8 module series into today's bucket", () => {
    sampler().tick(NOON);
    const rows = ctrl.db
      .prepare("SELECT DISTINCT series FROM status_history WHERE bucket_ts = ?")
      .all(DAY) as { series: string }[];
    const series = rows.map((r) => r.series).sort();
    expect(series).toContain("uptime");
    expect(series.filter((s) => s.startsWith("module:"))).toHaveLength(8);
    expect(series).toHaveLength(9);
  });

  it("accumulates observed seconds across ticks (60s + 60s = 120s)", () => {
    const s = sampler();
    s.tick(NOON); // first tick assumes one interval (60s)
    s.tick(NOON + 60_000); // +60s delta
    const row = ctrl.db
      .prepare("SELECT known_secs AS k FROM status_history WHERE series = 'uptime' AND bucket_ts = ?")
      .get(DAY) as { k: number };
    expect(row.k).toBe(120);
  });

  it("clamps the elapsed delta so a long sampler gap cannot inflate one bucket", () => {
    const s = sampler();
    s.tick(NOON); // 60s
    s.tick(NOON + 10 * 60_000); // 10-minute gap → clamped to 2× interval = 120s
    const row = ctrl.db
      .prepare("SELECT known_secs AS k FROM status_history WHERE series = 'uptime' AND bucket_ts = ?")
      .get(DAY) as { k: number };
    expect(row.k).toBe(180); // 60 + 120 (clamped)
  });

  it("is fail-soft — a closed control DB does not throw", () => {
    const s = sampler();
    ctrl.close();
    expect(() => s.tick(NOON)).not.toThrow();
  });
});

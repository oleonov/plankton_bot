import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bootstrapControlDb } from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import {
  upsertStatusBucket,
  pruneStatusHistory,
  readStatusHistory,
  computeUptimePct,
  startOfUtcDay,
  DAY_MS,
} from "../status-history-store.js";

let conn: DbConnection;
const DAY = startOfUtcDay(Date.UTC(2026, 5, 30, 12, 0, 0));

beforeEach(() => {
  conn = bootstrapControlDb(":memory:");
});
afterEach(() => {
  conn.close();
});

function read(series: "uptime"): { sev: string; sev_rank: number; down: number; crit: number } {
  const row = conn.db
    .prepare(
      "SELECT sev, sev_rank, down_secs AS down, crit_secs AS crit FROM status_history WHERE series = ? AND bucket_ts = ?",
    )
    .get(series, DAY) as { sev: string; sev_rank: number; down: number; crit: number };
  return row;
}

describe("status-history store", () => {
  it("migration 064 created the status_history table", () => {
    const t = conn.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='status_history'")
      .get();
    expect(t).toBeTruthy();
  });

  it("worst-of-day is monotonic — a later ok tick cannot demote a crit day", () => {
    upsertStatusBucket(conn.db, {
      series: "uptime",
      bucketTs: DAY,
      sev: "ok",
      downSecs: 0,
      critSecs: 0,
      knownSecs: 60,
    });
    upsertStatusBucket(conn.db, {
      series: "uptime",
      bucketTs: DAY,
      sev: "crit",
      downSecs: 60,
      critSecs: 60,
      knownSecs: 60,
      detail: "no heartbeat",
    });
    upsertStatusBucket(conn.db, {
      series: "uptime",
      bucketTs: DAY,
      sev: "ok",
      downSecs: 0,
      critSecs: 0,
      knownSecs: 60,
    });
    const r = read("uptime");
    expect(r.sev).toBe("crit"); // stays red despite the trailing ok
    expect(r.sev_rank).toBe(2);
    expect(r.crit).toBe(60); // durations accumulate
    expect(r.down).toBe(60);
  });

  it("accumulates known/down/crit seconds across ticks", () => {
    for (let i = 0; i < 3; i++) {
      upsertStatusBucket(conn.db, {
        series: "uptime",
        bucketTs: DAY,
        sev: "warn",
        downSecs: 30,
        critSecs: 0,
        knownSecs: 60,
      });
    }
    const r = read("uptime");
    expect(r.sev).toBe("warn");
    expect(r.down).toBe(90);
    expect(r.crit).toBe(0);
  });

  it("readStatusHistory returns a full window oldest→newest with nodata synthesis", () => {
    upsertStatusBucket(conn.db, {
      series: "uptime",
      bucketTs: DAY,
      sev: "crit",
      downSecs: 120,
      critSecs: 120,
      knownSecs: 600,
      detail: "STALE",
    });
    const hist = readStatusHistory(conn.db, "uptime", 45, DAY + 12 * 3_600_000);
    expect(hist).toHaveLength(45);
    // ascending day order
    for (let i = 1; i < hist.length; i++) expect(hist[i]!.t).toBe(hist[i - 1]!.t + DAY_MS);
    // today (last) is the recorded crit; everything before is nodata
    const last = hist[44]!;
    expect(last.t).toBe(DAY);
    expect(last.s).toBe("crit");
    expect(last.critSecs).toBe(120);
    expect(last.detail).toBe("STALE");
    expect(hist[0]!.s).toBe("nodata");
  });

  it("a zero-known bucket is reported as nodata, not a healthy ok", () => {
    upsertStatusBucket(conn.db, {
      series: "uptime",
      bucketTs: DAY,
      sev: "ok",
      downSecs: 0,
      critSecs: 0,
      knownSecs: 0,
    });
    const hist = readStatusHistory(conn.db, "uptime", 1, DAY);
    expect(hist[0]!.s).toBe("nodata");
  });

  it("computeUptimePct = 1 − Σcrit/Σknown over the window (warn does not subtract)", () => {
    // 600s known, 60s crit, plus a warn-only day (no crit) → uptime ignores warn.
    upsertStatusBucket(conn.db, {
      series: "uptime",
      bucketTs: DAY,
      sev: "crit",
      downSecs: 60,
      critSecs: 60,
      knownSecs: 600,
    });
    upsertStatusBucket(conn.db, {
      series: "uptime",
      bucketTs: DAY - DAY_MS,
      sev: "warn",
      downSecs: 300,
      critSecs: 0,
      knownSecs: 600,
    });
    const pct = computeUptimePct(conn.db, 45, DAY + 12 * 3_600_000);
    // 60 crit / 1200 known = 5% → 95% uptime
    expect(pct).toBe(95);
  });

  it("computeUptimePct returns null (unknown, not a fake 100) when nothing observed", () => {
    expect(computeUptimePct(conn.db, 45, DAY)).toBeNull();
    expect(computeUptimePct(undefined, 45, DAY)).toBeNull();
  });

  it("prune removes buckets older than the cutoff and keeps the rest", () => {
    upsertStatusBucket(conn.db, {
      series: "uptime",
      bucketTs: DAY - 100 * DAY_MS,
      sev: "ok",
      downSecs: 0,
      critSecs: 0,
      knownSecs: 60,
    });
    upsertStatusBucket(conn.db, {
      series: "uptime",
      bucketTs: DAY,
      sev: "ok",
      downSecs: 0,
      critSecs: 0,
      knownSecs: 60,
    });
    const removed = pruneStatusHistory(conn.db, DAY - 45 * DAY_MS);
    expect(removed).toBe(1);
    const left = conn.db
      .prepare("SELECT COUNT(*) AS n FROM status_history WHERE series = 'uptime'")
      .get() as { n: number };
    expect(left.n).toBe(1);
  });
});

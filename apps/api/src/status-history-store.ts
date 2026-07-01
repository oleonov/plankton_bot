/**
 * status_history read/write — the bounded, auto-pruned per-day rollup behind the
 * Status screen's history bars. One row per (series, UTC day): worst-of-day
 * severity (monotonic via sev_rank) plus accumulated down/crit/known seconds,
 * and — for deploy warm-up / operator pause — separate maintenance/paused
 * accumulators that are excluded from the uptime %.
 *
 * Lives in control.db (profile-independent). Every read is fail-soft: a missing
 * table or a locked DB degrades to an all-"nodata" window, never a throw.
 */

import type Database from "better-sqlite3";
import { STATUS_SEV_RANK, type StatusSev, type StatusSeries } from "@krabs/domain";

export const STATUS_HISTORY_WINDOW_DAYS = 45;
export const DAY_MS = 86_400_000;

/** Epoch ms at the start of the UTC day containing `ms`. */
export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * A history element the API hands the UI. `nodata` = no observation that day;
 * `maintenance` / `paused` = the whole observed day was deploy warm-up / operator
 * pause (no real ok/warn/crit) — otherwise the bar shows the real worst severity.
 */
export type HistState = StatusSev | "nodata" | "maintenance" | "paused";
export interface HistPoint {
  t: number;
  s: HistState;
  downSecs: number;
  critSecs: number;
  maintenanceSecs: number;
  pausedSecs: number;
  detail?: string;
}

export interface StatusBucketWrite {
  series: StatusSeries;
  bucketTs: number;
  sev: StatusSev;
  downSecs: number;
  critSecs: number;
  knownSecs: number;
  maintenanceSecs?: number;
  pausedSecs?: number;
  detail?: string | null;
}

// Worst-of-day is monotonic: severity (+ its detail) only ever rises within a
// bucket; durations accumulate. A later green tick can never demote a red day.
// maintenance/paused ticks pass sev='ok' (never bump sev_rank) and only add to
// their own accumulators, so `sev` reflects real-health ticks only.
const UPSERT_SQL = `
INSERT INTO status_history
  (series, bucket_ts, sev_rank, sev, down_secs, crit_secs, known_secs, maintenance_secs, paused_secs, detail, updated_at)
VALUES (@series, @bucketTs, @sevRank, @sev, @downSecs, @critSecs, @knownSecs, @maintenanceSecs, @pausedSecs, @detail, datetime('now'))
ON CONFLICT(series, bucket_ts) DO UPDATE SET
  down_secs        = down_secs        + excluded.down_secs,
  crit_secs        = crit_secs        + excluded.crit_secs,
  known_secs       = known_secs       + excluded.known_secs,
  maintenance_secs = maintenance_secs + excluded.maintenance_secs,
  paused_secs      = paused_secs      + excluded.paused_secs,
  detail     = CASE WHEN excluded.sev_rank >= status_history.sev_rank
                    THEN excluded.detail ELSE status_history.detail END,
  sev        = CASE WHEN excluded.sev_rank >  status_history.sev_rank
                    THEN excluded.sev ELSE status_history.sev END,
  sev_rank   = MAX(status_history.sev_rank, excluded.sev_rank),
  updated_at = excluded.updated_at
`;

export function upsertStatusBucket(db: Database.Database, w: StatusBucketWrite): void {
  db.prepare(UPSERT_SQL).run({
    series: w.series,
    bucketTs: w.bucketTs,
    sevRank: STATUS_SEV_RANK[w.sev],
    sev: w.sev,
    downSecs: Math.round(w.downSecs),
    critSecs: Math.round(w.critSecs),
    knownSecs: Math.round(w.knownSecs),
    maintenanceSecs: Math.round(w.maintenanceSecs ?? 0),
    pausedSecs: Math.round(w.pausedSecs ?? 0),
    detail: w.detail ?? null,
  });
}

/** Delete buckets older than the cutoff. Returns the number of rows removed. */
export function pruneStatusHistory(db: Database.Database, cutoffTs: number): number {
  return db.prepare("DELETE FROM status_history WHERE bucket_ts < ?").run(cutoffTs).changes;
}

interface BucketRow {
  t: number;
  sev: StatusSev;
  d: number;
  c: number;
  k: number;
  m: number;
  p: number;
  detail: string | null;
}

/**
 * Last `windowDays` day-buckets for a series, oldest→newest. Days with no row or
 * zero observed seconds come back as `nodata`. A day whose entire observed time
 * was maintenance/paused (no real ok/warn/crit seconds) renders `paused` (if any
 * pause) else `maintenance`; otherwise the bar shows the real worst severity.
 */
export function readStatusHistory(
  db: Database.Database | undefined,
  series: StatusSeries,
  windowDays: number,
  nowMs: number,
): HistPoint[] {
  const todayStart = startOfUtcDay(nowMs);
  const firstStart = todayStart - (windowDays - 1) * DAY_MS;
  const byTs = new Map<number, BucketRow>();
  if (db) {
    try {
      const rows = db
        .prepare(
          `SELECT bucket_ts AS t, sev, down_secs AS d, crit_secs AS c, known_secs AS k,
                  maintenance_secs AS m, paused_secs AS p, detail
             FROM status_history WHERE series = ? AND bucket_ts >= ? ORDER BY bucket_ts ASC`,
        )
        .all(series, firstStart) as BucketRow[];
      for (const r of rows) byTs.set(r.t, r);
    } catch {
      // table missing / locked → all-nodata window, never throws
    }
  }

  const out: HistPoint[] = [];
  for (let i = 0; i < windowDays; i++) {
    const t = firstStart + i * DAY_MS;
    const row = byTs.get(t);
    if (!row || row.k <= 0) {
      out.push({ t, s: "nodata", downSecs: 0, critSecs: 0, maintenanceSecs: 0, pausedSecs: 0 });
      continue;
    }
    // Real-health time = observed − maintenance − paused. If none, the whole day
    // was warm-up / pause → show that state; pause wins over maintenance.
    const normalSecs = row.k - row.m - row.p;
    const s: HistState = normalSecs > 0 ? row.sev : row.p > 0 ? "paused" : "maintenance";
    out.push({
      t,
      s,
      downSecs: row.d,
      critSecs: row.c,
      maintenanceSecs: row.m,
      pausedSecs: row.p,
      ...(row.detail ? { detail: row.detail } : {}),
    });
  }
  return out;
}

/**
 * Real uptime % over the window = 1 − Σcrit_secs / (Σknown − Σmaintenance − Σpaused)
 * for the `uptime` series — outage time only; deploy warm-up and operator pause
 * are excluded from the denominator (Statuspage SLO semantics). Returns **null**
 * (→ "—") when the denominator ≤ 0 (nothing observed, or a fully warm-up/paused
 * window) so the UI never shows a fake healthy 100%.
 */
export function computeUptimePct(
  db: Database.Database | undefined,
  windowDays: number,
  nowMs: number,
): number | null {
  const firstStart = startOfUtcDay(nowMs) - (windowDays - 1) * DAY_MS;
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(known_secs), 0) AS known, COALESCE(SUM(crit_secs), 0) AS crit,
                COALESCE(SUM(maintenance_secs), 0) AS maint, COALESCE(SUM(paused_secs), 0) AS paused
           FROM status_history WHERE series = 'uptime' AND bucket_ts >= ?`,
      )
      .get(firstStart) as
      | { known: number; crit: number; maint: number; paused: number }
      | undefined;
    if (!row) return null;
    const denom = row.known - row.maint - row.paused;
    if (denom <= 0) return null;
    return Math.round((1 - row.crit / denom) * 1000) / 10;
  } catch {
    return null;
  }
}

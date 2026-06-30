/**
 * status_history read/write — the bounded, auto-pruned per-day rollup behind the
 * Status screen's history bars. One row per (series, UTC day): worst-of-day
 * severity (monotonic via sev_rank) plus accumulated down/crit/known seconds.
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

/** A history element the API hands the UI. `nodata` = no observation that day. */
export type HistState = StatusSev | "nodata";
export interface HistPoint {
  t: number;
  s: HistState;
  downSecs: number;
  critSecs: number;
  detail?: string;
}

export interface StatusBucketWrite {
  series: StatusSeries;
  bucketTs: number;
  sev: StatusSev;
  downSecs: number;
  critSecs: number;
  knownSecs: number;
  detail?: string | null;
}

// Worst-of-day is monotonic: severity (+ its detail) only ever rises within a
// bucket; durations accumulate. A later green tick can never demote a red day.
const UPSERT_SQL = `
INSERT INTO status_history
  (series, bucket_ts, sev_rank, sev, down_secs, crit_secs, known_secs, detail, updated_at)
VALUES (@series, @bucketTs, @sevRank, @sev, @downSecs, @critSecs, @knownSecs, @detail, datetime('now'))
ON CONFLICT(series, bucket_ts) DO UPDATE SET
  down_secs  = down_secs  + excluded.down_secs,
  crit_secs  = crit_secs  + excluded.crit_secs,
  known_secs = known_secs + excluded.known_secs,
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
  detail: string | null;
}

/**
 * Last `windowDays` day-buckets for a series, oldest→newest. Days with no row or
 * zero observed seconds come back as `nodata` so the strip is never literally
 * empty (the honest "before monitoring started" / "not yet sampled" state).
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
          `SELECT bucket_ts AS t, sev, down_secs AS d, crit_secs AS c, known_secs AS k, detail
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
      out.push({ t, s: "nodata", downSecs: 0, critSecs: 0 });
    } else {
      out.push({
        t,
        s: row.sev,
        downSecs: row.d,
        critSecs: row.c,
        ...(row.detail ? { detail: row.detail } : {}),
      });
    }
  }
  return out;
}

/**
 * Real uptime % over the window = 1 − Σcrit_secs / Σknown_secs for the `uptime`
 * series (outage time only; warn/degraded counts as up). Days with no
 * observation are excluded from the denominator. Returns **null** when nothing
 * has been observed yet (no DB, missing/locked table, or Σknown === 0) so the UI
 * can render "—" instead of a fake healthy 100%.
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
        `SELECT COALESCE(SUM(known_secs), 0) AS known, COALESCE(SUM(crit_secs), 0) AS crit
           FROM status_history WHERE series = 'uptime' AND bucket_ts >= ?`,
      )
      .get(firstStart) as { known: number; crit: number } | undefined;
    if (!row || row.known <= 0) return null;
    return Math.round((1 - row.crit / row.known) * 1000) / 10;
  } catch {
    return null;
  }
}

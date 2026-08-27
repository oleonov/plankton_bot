import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { readFileSync, statSync, statfsSync } from "node:fs";
import os from "node:os";
import { ok } from "../errors.js";
import type { LedgerPool } from "../ledger-pool.js";
import { resolveActiveLedger } from "../active-ledger.js";
import {
  collectSystemHealthSnapshot,
  countOpenBreakers,
  safe,
  type InfraAlertRow,
  type Sev,
} from "../system-health-snapshot.js";
import {
  computeUptimePct,
  readStatusHistory,
  STATUS_HISTORY_WINDOW_DAYS,
  type HistPoint,
} from "../status-history-store.js";

// Read-only technical health snapshot for the Status screen. The per-module /
// uptime severity comes from the SHARED collectSystemHealthSnapshot (also used
// by the StatusHistorySampler) so the live screen and recorded history can never
// disagree. History bars come from status_history (control.db). Every probe is
// isolated so a single failure degrades to a safe default rather than 500ing.

interface SystemHealthOpts {
  db: Database.Database;
  controlDb?: Database.Database;
  ledgerPool?: LedgerPool;
  marketDataStaleThresholdMs?: number;
}

interface ModuleHealth {
  nm: string;
  s: Sev;
  since: string;
  detail: string;
  hist: HistPoint[];
}
interface ResourceGauge {
  nm: string;
  val: number;
  max: number;
  unit: string;
  sub: [string, string];
  good: "low" | "high";
  dec?: number;
}
interface DepHealth {
  nm: string;
  s: Sev;
  lat: number | null;
  // null = error-rate not measured (no per-call instrumentation yet). NEVER a
  // fabricated healthy zero.
  err: number | null;
  hist: number[];
}
interface SystemHealthData {
  version: string;
  deploy: string;
  sha: string;
  // null = working-tree dirty state is not captured by build metadata (unknown).
  dirty: boolean | null;
  tradingState: "RUNNING" | "PAUSED";
  paused: boolean;
  pauseReason: string | null;
  // null = no observed history yet (unknown) — UI renders "—", never a fake 100%.
  uptimePct: number | null;
  uptodayHist: HistPoint[];
  // null = no market-data freshness metric available yet (unknown, not "fresh").
  marketDataStale: boolean | null;
  reconDrift: boolean;
  modules: ModuleHealth[];
  resources: ResourceGauge[];
  deps: DepHealth[];
  errors: {
    l50_1h: number;
    l60_1h: number;
    l50_24h: number;
    l60_24h: number;
    breakers: string;
    hist: { n: number; crit: boolean; t: number }[];
    top: { lv: "l50" | "l60"; code: string; cnt: number; when: string }[];
  };
  db: {
    ledger: number;
    control: number;
    wal: number;
    // null = not measured (SQLITE_BUSY count / accounting cycle not tracked here).
    locked: number | null;
    migration: string;
    retention: string;
    acctWarnings: number | null;
    unknownAcct: number | null;
    lastVacuum: string;
  };
  shadow: { nm: string; added: string }[];
}

// Observe-only experiments currently deployed in prod. Curated registry (the bot
// does not auto-judge experiments) — name + added date only, no verdict. Track A
// shadow is intentionally absent (removed from this codebase); Track A live
// enforcement is not a shadow; research-only guards are not deployed.
const SHADOW_REGISTRY: { nm: string; added: string }[] = [
  { nm: "Dead-market / Track B shadow", added: "Jun 12" },
  { nm: "Entry fresh-edge shadow", added: "Jun 21" },
  { nm: "ProfileLadder / sell-side shadow", added: "Jun 9" },
  { nm: "Plankton-signature entry shadow", added: "Jul 2" },
];

function readGitSha(): string {
  return safe(() => readFileSync("/app/GIT_SHA", "utf-8").trim(), "");
}

function readDeployMeta(): { version: string; deploy: string; sha: string } {
  return safe(
    () => {
      const raw = JSON.parse(readFileSync("/app/config/deploy-meta.json", "utf-8")) as {
        deployVersion?: number;
        sha?: string;
        deployedAt?: string;
      };
      return {
        version: raw.deployVersion != null ? `v${raw.deployVersion}` : "unknown",
        deploy: raw.deployedAt ?? "unknown",
        sha: raw.sha ?? "",
      };
    },
    { version: "unknown", deploy: "unknown", sha: "" },
  );
}

function bytesToMb(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 10) / 10;
}
function fileSizeMb(path: string): number {
  return safe(() => bytesToMb(statSync(path).size), 0);
}

function readHostResources(dbPath: string, walMb: number): ResourceGauge[] {
  const disk = safe<ResourceGauge>(
    () => {
      const fsStat = statfsSync(dbPath);
      const totalB = fsStat.blocks * fsStat.bsize;
      const freeB = fsStat.bavail * fsStat.bsize;
      const usedPct = totalB > 0 ? Math.round(((totalB - freeB) / totalB) * 100) : 0;
      const gb = (b: number) => Math.round((b / 1_073_741_824) * 10) / 10;
      return {
        nm: "Disk · krabs-data",
        val: usedPct,
        max: 100,
        unit: "% used",
        sub: [`${gb(freeB)} GB free`, `${gb(totalB - freeB)} / ${gb(totalB)} GB`],
        good: "low",
      };
    },
    { nm: "Disk · krabs-data", val: 0, max: 100, unit: "% used", sub: ["—", "—"], good: "low" },
  );

  const cores = os.cpus().length || 1;
  const load = os.loadavg()[0] ?? 0;
  const cpu: ResourceGauge = {
    nm: "CPU load / core",
    val: Math.round((load / cores) * 100) / 100,
    max: 2,
    unit: "norm",
    sub: [`${cores} cores`, "1m avg"],
    good: "low",
    dec: 2,
  };

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPct = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0;
  const gib = (b: number) => Math.round((b / 1_073_741_824) * 10) / 10;
  const mem: ResourceGauge = {
    nm: "Memory",
    val: memPct,
    max: 100,
    unit: "% used",
    sub: ["swap n/a", `${gib(totalMem - freeMem)} / ${gib(totalMem)} GB`],
    good: "low",
  };

  const wal: ResourceGauge = {
    nm: "WAL size",
    val: walMb,
    max: 256,
    unit: "MB",
    sub: [walMb > 60 ? "large" : "stable", "ckpt n/a"],
    good: "low",
  };

  return [disk, cpu, mem, wal];
}

function humanizeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// "level 50/60" are pino concepts not persisted in the DB. We map the persisted
// infra_alert severity to the same panel: error => l60, warning => l50.
function buildErrors(alerts24h: InfraAlertRow[]): SystemHealthData["errors"] {
  const oneHourAgo = Date.now() - 3_600_000;
  const inLastHour = (a: InfraAlertRow) => Date.parse(a.capturedAt) >= oneHourAgo;
  const l50 = alerts24h.filter((a) => a.severity === "warning");
  const l60 = alerts24h.filter((a) => a.severity === "error");
  const breakerOpen = countOpenBreakers(alerts24h);

  // 24 hourly buckets, oldest first; each carries its hour-start timestamp for
  // the bar tooltip.
  const hourMs = 3_600_000;
  const now = Date.now();
  const nowHour = Math.floor(now / hourMs) * hourMs;
  const hist = Array.from({ length: 24 }, (_, i) => ({
    n: 0,
    crit: false,
    t: nowHour - (23 - i) * hourMs,
  }));
  for (const a of alerts24h) {
    const ageH = Math.floor((now - Date.parse(a.capturedAt)) / hourMs);
    const bucket = hist[23 - ageH];
    if (bucket) {
      bucket.n += 1;
      if (a.severity === "error") bucket.crit = true;
    }
  }

  const counts = new Map<string, { lv: "l50" | "l60"; cnt: number; when: string }>();
  for (const a of alerts24h) {
    const lv: "l50" | "l60" = a.severity === "error" ? "l60" : "l50";
    const prev = counts.get(a.code);
    if (prev) prev.cnt += 1;
    else counts.set(a.code, { lv, cnt: 1, when: humanizeAgo(a.capturedAt) });
  }
  const top = [...counts.entries()]
    .map(([code, v]) => ({ lv: v.lv, code, cnt: v.cnt, when: v.when }))
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 6);

  return {
    l50_1h: l50.filter(inLastHour).length,
    l60_1h: l60.filter(inLastHour).length,
    l50_24h: l50.length,
    l60_24h: l60.length,
    breakers: breakerOpen > 0 ? `${breakerOpen} open` : "closed",
    hist,
    top,
  };
}

function depFromAlerts(nm: string, codeRe: RegExp, alerts: InfraAlertRow[]): DepHealth {
  const recent = alerts.filter((a) => codeRe.test(a.code) || codeRe.test(a.source));
  const hasError = recent.some((a) => a.severity === "error");
  const hasWarn = recent.some((a) => a.severity === "warning");
  // No latency/error-rate sampling exists yet (Phase 2) — reachability/severity
  // only. err is null (unmeasured), never a fabricated 0; hist stays empty so the
  // UI renders an explicit "not sampled" state rather than a fake "about to fill".
  return {
    nm,
    s: hasError ? "crit" : hasWarn ? "warn" : "ok",
    lat: null,
    err: null,
    hist: [],
  };
}

function latestMigration(db: Database.Database): string {
  return safe(() => {
    const row = db.prepare("SELECT name FROM schema_migrations ORDER BY id DESC LIMIT 1").get() as
      | { name?: string }
      | undefined;
    return row?.name ? "applied" : "none";
  }, "unknown");
}

function humanizeUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  return `${d}d ${h}h`;
}

export const systemHealthRoutes: FastifyPluginAsync<SystemHealthOpts> = async (app, opts) => {
  app.get("/system-health", async () => {
    const { db } = resolveActiveLedger(opts.db, opts.controlDb, opts.ledgerPool);
    const staleMs = opts.marketDataStaleThresholdMs ?? 120_000;
    const now = Date.now();
    const windowDays = STATUS_HISTORY_WINDOW_DAYS;

    const meta = readDeployMeta();
    const gitSha = readGitSha();

    // Shared snapshot — same computation the StatusHistorySampler records.
    const { snapshot, alerts1h, alerts24h } = collectSystemHealthSnapshot(
      db,
      opts.controlDb,
      staleMs,
    );
    const paused = snapshot.paused;

    const ledgerPath = safe(() => db.name, "");
    const controlPath = safe(() => opts.controlDb?.name ?? "", "");
    const walMb = ledgerPath ? fileSizeMb(`${ledgerPath}-wal`) : 0;

    const errors = buildErrors(alerts24h);
    const sinceUptime = humanizeUptime(process.uptime());

    const modules: ModuleHealth[] = snapshot.modules.map((m) => ({
      nm: m.nm,
      s: m.s,
      since: sinceUptime,
      detail: m.detail,
      hist: readStatusHistory(opts.controlDb, m.series, windowDays, now),
    }));

    const data: SystemHealthData = {
      version: meta.version,
      deploy: meta.deploy,
      sha: gitSha || meta.sha,
      dirty: null, // working-tree dirty state not captured by build metadata
      tradingState: paused ? "PAUSED" : "RUNNING",
      paused,
      pauseReason: paused ? "see Risk / runtime control" : null,
      uptimePct: computeUptimePct(opts.controlDb, windowDays, now),
      uptodayHist: readStatusHistory(opts.controlDb, "uptime", windowDays, now),
      marketDataStale: snapshot.marketDataStale,
      reconDrift: snapshot.reconDrift,
      modules,
      resources: readHostResources(ledgerPath || os.tmpdir(), walMb),
      deps: [
        depFromAlerts("CLOB API", /CLOB|POLYMARKET_CLOB|ORDER/i, alerts1h),
        depFromAlerts("Gamma API", /GAMMA/i, alerts1h),
        depFromAlerts("Polygon RPC", /POLYGON_RPC|RPC/i, alerts1h),
        depFromAlerts("Relayer / redeem", /RELAYER|REDEEM/i, alerts1h),
      ],
      errors,
      db: {
        ledger: ledgerPath ? fileSizeMb(ledgerPath) : 0,
        control: controlPath ? fileSizeMb(controlPath) : 0,
        wal: walMb,
        locked: null, // SQLITE_BUSY count not tracked — unknown, not 0
        migration: latestMigration(db),
        retention: "unknown", // pruner status not exposed
        acctWarnings: null, // requires position-cycle computation — unknown, not 0
        unknownAcct: null, // requires position-cycle computation — unknown, not 0
        lastVacuum: "n/a", // last VACUUM not tracked
      },
      shadow: SHADOW_REGISTRY,
    };

    return ok(data);
  });
};

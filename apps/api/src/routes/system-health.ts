import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { readFileSync, statSync, statfsSync } from "node:fs";
import os from "node:os";
import { ok } from "../errors.js";
import type { LedgerPool } from "../ledger-pool.js";
import { resolveActiveLedger } from "./status.js";

// Read-only technical health snapshot for the Status screen. Severity is NOT
// computed here — the UI derives ok/warn/crit from these raw values via one
// shared helper, so thresholds live in a single place. Every probe is isolated
// so a single failure degrades to a safe default rather than failing the page.

interface SystemHealthOpts {
  db: Database.Database;
  controlDb?: Database.Database;
  ledgerPool?: LedgerPool;
  marketDataStaleThresholdMs?: number;
}

type Sev = "ok" | "warn" | "crit";

interface ModuleHealth {
  nm: string;
  s: Sev;
  since: string;
  detail: string;
  hist: Sev[];
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
  uptimePct: number;
  uptodayHist: Sev[];
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
    hist: { n: number; crit: boolean }[];
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
  { nm: "Two-lane entry shadow", added: "Jun 18" },
  { nm: "Entry fresh-edge shadow", added: "Jun 21" },
  { nm: "ProfileLadder / sell-side shadow", added: "Jun 9" },
];

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

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

function readControlState(controlDb: Database.Database | undefined): {
  paused: boolean;
  status: string;
} {
  if (!controlDb) return { paused: false, status: "unknown" };
  return safe(
    () => {
      const row = controlDb
        .prepare("SELECT runtime_status, paused FROM runtime_control_state WHERE id = 1")
        .get() as { runtime_status?: string; paused?: number } | undefined;
      return { paused: (row?.paused ?? 0) === 1, status: row?.runtime_status ?? "unknown" };
    },
    { paused: false, status: "unknown" },
  );
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

interface InfraAlertRow {
  code: string;
  severity: "warning" | "error";
  source: string;
  capturedAt: string;
}

function readInfraAlerts(db: Database.Database, sinceMs: number): InfraAlertRow[] {
  const sinceIso = new Date(Date.now() - sinceMs).toISOString();
  return safe(() => {
    const rows = db
      .prepare(
        `SELECT labels, captured_at FROM runtime_metrics
          WHERE metric_name = 'infra_alert' AND captured_at >= ?
          ORDER BY captured_at DESC LIMIT 500`,
      )
      .all(sinceIso) as Array<{ labels: string | null; captured_at: string }>;
    const out: InfraAlertRow[] = [];
    for (const row of rows) {
      if (!row.labels) continue;
      const parsed = JSON.parse(row.labels) as {
        code?: string;
        severity?: string;
        source?: string;
      };
      if (!parsed.code || !parsed.source) continue;
      out.push({
        code: parsed.code,
        severity: parsed.severity === "warning" ? "warning" : "error",
        source: parsed.source,
        capturedAt: row.captured_at,
      });
    }
    return out;
  }, []);
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
  const breakerOpen = alerts24h.filter(
    (a) => /BREAKER|CIRCUIT/i.test(a.code) && inLastHour(a),
  ).length;

  // 24 hourly buckets, oldest first.
  const hist = Array.from({ length: 24 }, () => ({ n: 0, crit: false }));
  const now = Date.now();
  for (const a of alerts24h) {
    const ageH = Math.floor((now - Date.parse(a.capturedAt)) / 3_600_000);
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
  // No latency/error-rate sampling exists yet — reachability/severity only.
  // err is null (unmeasured), never a fabricated 0.
  return {
    nm,
    s: hasError ? "crit" : hasWarn ? "warn" : "ok",
    lat: null,
    err: null,
    hist: [],
  };
}

// Real market-data freshness from the runtime metric the bot writes on every
// MarketSnapshotReceived. null when the metric is absent (unknown) — we never
// claim "fresh" without evidence.
function readMarketDataStale(db: Database.Database, staleThresholdMs: number): boolean | null {
  return safe<boolean | null>(() => {
    const row = db
      .prepare(
        "SELECT captured_at AS ts FROM runtime_metrics WHERE metric_name = 'market_data_last_update' ORDER BY captured_at DESC LIMIT 1",
      )
      .get() as { ts?: string } | undefined;
    if (!row?.ts) return null;
    return Date.now() - new Date(row.ts).getTime() > staleThresholdMs;
  }, null);
}

function countOpenDrifts(db: Database.Database): number {
  return safe(() => {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM position_drifts WHERE status = 'open'")
      .get() as { n: number };
    return row.n;
  }, 0);
}

function latestMigration(db: Database.Database): string {
  return safe(() => {
    const row = db.prepare("SELECT name FROM schema_migrations ORDER BY id DESC LIMIT 1").get() as
      | { name?: string }
      | undefined;
    return row?.name ? "applied" : "none";
  }, "unknown");
}

function buildModules(args: {
  marketDataStale: boolean | null;
  reconDrift: boolean;
  paused: boolean;
  breakerOpen: boolean;
  runtimeAlive: boolean;
  since: string;
}): ModuleHealth[] {
  const base = (nm: string, s: Sev, detail: string): ModuleHealth => ({
    nm,
    s,
    since: args.since,
    detail,
    hist: [], // per-module history is not persisted yet (TODO)
  });
  const live: Sev = args.runtimeAlive ? "ok" : "crit";
  // Unknown freshness (null) is a warning, not a silent "fresh".
  const mdSev: Sev =
    args.marketDataStale === true ? "crit" : args.marketDataStale === false ? live : "warn";
  const mdDetail =
    args.marketDataStale === true ? "STALE" : args.marketDataStale === false ? "fresh" : "unknown";
  return [
    base("scanner", live, args.runtimeAlive ? "scanning" : "no heartbeat"),
    base("market data", mdSev, mdDetail),
    base("strategy", live, args.runtimeAlive ? "live" : "no heartbeat"),
    base(
      "risk",
      args.breakerOpen ? "crit" : live,
      args.breakerOpen ? "breaker open" : "no breakers",
    ),
    base("execution", live, "posting"),
    base(
      "reconciliation",
      args.reconDrift ? "crit" : live,
      args.reconDrift ? "drift detected" : "no drift",
    ),
    base("redeem", live, "idle"),
    base("manager / API", "ok", "responding"),
  ];
}

function humanizeUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  return `${d}d ${h}h`;
}

export const systemHealthRoutes: FastifyPluginAsync<SystemHealthOpts> = async (app, opts) => {
  app.get("/system-health", async () => {
    const { db } = resolveActiveLedger(opts.db, opts.controlDb, opts.ledgerPool);

    const meta = readDeployMeta();
    const gitSha = readGitSha();
    const control = readControlState(opts.controlDb);
    const paused = control.paused;
    const runtimeAlive = control.status === "running" || control.status === "ready_paused";

    const ledgerPath = safe(() => db.name, "");
    const controlPath = safe(() => opts.controlDb?.name ?? "", "");
    const walMb = ledgerPath ? fileSizeMb(`${ledgerPath}-wal`) : 0;

    const alerts1h = readInfraAlerts(db, 3_600_000);
    const alerts24h = readInfraAlerts(db, 86_400_000);
    const errors = buildErrors(alerts24h);
    const breakerOpen = errors.breakers !== "closed";

    const reconDrift = countOpenDrifts(db) > 0;
    const marketDataStale = readMarketDataStale(db, opts.marketDataStaleThresholdMs ?? 120_000);

    const sinceUptime = humanizeUptime(process.uptime());

    const data: SystemHealthData = {
      version: meta.version,
      deploy: meta.deploy,
      sha: gitSha || meta.sha,
      dirty: null, // working-tree dirty state not captured by build metadata
      tradingState: paused ? "PAUSED" : "RUNNING",
      paused,
      pauseReason: paused ? "see Risk / runtime control" : null,
      uptimePct: runtimeAlive ? 100 : 0, // no downtime history yet (TODO)
      uptodayHist: [], // uptime history not persisted yet (TODO)
      marketDataStale,
      reconDrift,
      modules: buildModules({
        marketDataStale,
        reconDrift,
        paused,
        breakerOpen,
        runtimeAlive,
        since: sinceUptime,
      }),
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

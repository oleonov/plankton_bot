import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok } from "../errors.js";
import { resolveInitialBalanceUsdc } from "../initial-balance.js";
import { resolveLiveLiteFunderAddress } from "../polymarket-portfolio.js";

interface PortfolioSeriesOpts {
  db: Database.Database;
  controlDb?: Database.Database;
  defaultInitialBalanceUsdc?: number | null | undefined;
}

type ExternalPnlPoint = { t: number; p: number };

const EXTERNAL_FIDELITY_MAP: Record<"1d" | "1w" | "1m" | "all", string> = {
  "1d": "1h",
  "1w": "3h",
  "1m": "1d",
  all: "1d",
};

const EXTERNAL_FIDELITY_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "3h": 3 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

const INTERVAL_WINDOW_MS: Partial<Record<"1d" | "1w" | "1m" | "all", number>> = {
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
};

function resolveProfileStart(
  controlDb: Database.Database | undefined,
  profileId: string,
): string | null {
  if (!controlDb) return null;
  try {
    const profileRow = controlDb
      .prepare("SELECT created_at FROM profiles WHERE profile_id = ?")
      .get(profileId) as { created_at: string | null } | undefined;
    return profileRow?.created_at ?? null;
  } catch {
    return null;
  }
}

async function fetchExternalPortfolioSeries(
  funderAddress: string,
  interval: "1d" | "1w" | "1m" | "all",
  profileStart: string | null,
): Promise<{
  items: Array<{
    equityUsdc: number;
    realizedPnlUsdc: number;
    positionValueUsdc: number;
    openValueUsdc: number;
    capturedAt: string;
  }>;
  baseline: number;
  currentEquity: number;
  portfolioPnl: number;
  historyStart: string | null;
  coverageComplete: boolean;
} | null> {
  const url = new URL("https://user-pnl-api.polymarket.com/user-pnl");
  url.searchParams.set("user_address", funderAddress);
  url.searchParams.set("interval", interval);
  const fidelity = EXTERNAL_FIDELITY_MAP[interval];
  url.searchParams.set("fidelity", fidelity);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const data = (await res.json()) as ExternalPnlPoint[];
    if (!Array.isArray(data) || data.length === 0) return null;

    const items = data.map((point) => ({
      equityUsdc: point.p,
      realizedPnlUsdc: 0,
      positionValueUsdc: 0,
      openValueUsdc: 0,
      capturedAt: new Date(point.t * 1000).toISOString(),
    }));
    const firstPoint = items[0] ?? null;
    const latest = items[items.length - 1] ?? null;
    const intervalWindowMs = INTERVAL_WINDOW_MS[interval] ?? null;
    const fidelityMs = EXTERNAL_FIDELITY_MS[fidelity] ?? 0;
    const windowStartMs =
      intervalWindowMs != null ? Date.now() - intervalWindowMs : Number.NEGATIVE_INFINITY;
    const profileStartMs = profileStart ? Date.parse(profileStart) : NaN;
    // Only 1D uses a rolling baseline (delta over the last 24h).
    // 1W/1M/ALL always show raw cumulative all-time PnL from Polymarket,
    // matching how the endpoint itself represents `p` as cumulative.
    const useRollingBaseline =
      interval === "1d" &&
      Number.isFinite(profileStartMs) &&
      profileStartMs - windowStartMs <= fidelityMs;
    const coverageComplete = interval === "all" || useRollingBaseline;
    const baseline = useRollingBaseline ? (firstPoint?.equityUsdc ?? 0) : 0;

    return {
      items,
      baseline,
      currentEquity: latest?.equityUsdc ?? 0,
      portfolioPnl: (latest?.equityUsdc ?? baseline) - baseline,
      historyStart: items[0]?.capturedAt ?? null,
      coverageComplete,
    };
  } catch {
    return null;
  }
}

export const portfolioSeriesRoutes: FastifyPluginAsync<PortfolioSeriesOpts> = async (app, opts) => {
  const { db, controlDb, defaultInitialBalanceUsdc } = opts;

  app.get<{ Querystring: { interval?: string } }>("/metrics/portfolio-series", async (request) => {
    const requestedInterval = request.query.interval ?? "1d";
    const interval =
      requestedInterval === "1d" ||
      requestedInterval === "1w" ||
      requestedInterval === "1m" ||
      requestedInterval === "all"
        ? requestedInterval
        : "1d";

    // Resolve current profile
    let profile: string | null = null;
    if (controlDb) {
      try {
        const row = controlDb
          .prepare("SELECT current_profile FROM runtime_control_state WHERE id = 1")
          .get() as { current_profile: string | null } | undefined;
        profile = row?.current_profile ?? null;
      } catch {
        /* legacy DBs without runtime_control_state */
      }
    }
    const effectiveProfile = profile ?? "simulation";

    if (effectiveProfile === "live-lite") {
      const funderAddress = resolveLiveLiteFunderAddress(controlDb, effectiveProfile);
      const profileStart = resolveProfileStart(controlDb, effectiveProfile);
      if (funderAddress) {
        const external = await fetchExternalPortfolioSeries(funderAddress, interval, profileStart);
        if (external) {
          return ok({
            ...external,
            interval,
          });
        }
      }
    }

    // Rolling windows with downsampling
    const bucketMinutes: Record<string, number> = {
      "1d": 5,
      "1w": 15,
      "1m": 60,
      all: 360,
    };
    const sinceMap: Record<string, string> = {
      "1d": "-1 day",
      "1w": "-7 days",
      "1m": "-30 days",
      all: "-90 days",
    };
    const since = sinceMap[interval] ?? "-1 day";
    const bucket = bucketMinutes[interval] ?? 5;
    const maxRawPoints = 200;

    const windowStartRow = db.prepare("SELECT datetime('now', ?) as ts").get(since) as {
      ts: string;
    };
    const windowStart = windowStartRow.ts;

    const historyStartRow = db
      .prepare(
        `SELECT captured_at
         FROM portfolio_snapshots
         WHERE profile = ?
         ORDER BY captured_at ASC
         LIMIT 1`,
      )
      .get(effectiveProfile) as { captured_at: string } | undefined;
    const historyStart = historyStartRow?.captured_at ?? null;

    const profileStart = resolveProfileStart(controlDb, effectiveProfile);

    const rawCountRow = db
      .prepare(
        `SELECT COUNT(*) as c
         FROM portfolio_snapshots
         WHERE profile = ? AND captured_at >= datetime('now', ?)`,
      )
      .get(effectiveProfile, since) as { c: number };
    const rawCount = rawCountRow.c;

    const itemQuery =
      rawCount <= maxRawPoints
        ? db.prepare(
            `SELECT equity_usdc, realized_pnl_usdc, position_value_usdc, open_value_usdc, captured_at
             FROM portfolio_snapshots
             WHERE profile = ? AND captured_at >= datetime('now', ?)
             ORDER BY captured_at ASC`,
          )
        : db.prepare(
            `SELECT ps.equity_usdc, ps.realized_pnl_usdc, ps.position_value_usdc, ps.open_value_usdc, ps.captured_at
             FROM portfolio_snapshots ps
             INNER JOIN (
               SELECT MAX(id) as max_id
               FROM portfolio_snapshots
               WHERE profile = ? AND captured_at >= datetime('now', ?)
               GROUP BY strftime('%Y-%m-%d', captured_at) || 'T' ||
                 printf('%02d', (CAST(strftime('%H', captured_at) AS INTEGER) * 60
                   + CAST(strftime('%M', captured_at) AS INTEGER)) / ?)
             ) b ON ps.id = b.max_id
             ORDER BY ps.captured_at ASC`,
          );

    const items =
      rawCount <= maxRawPoints
        ? (itemQuery.all(effectiveProfile, since) as Array<{
            equity_usdc: number;
            realized_pnl_usdc: number;
            position_value_usdc: number;
            open_value_usdc: number;
            captured_at: string;
          }>)
        : (itemQuery.all(effectiveProfile, since, bucket) as Array<{
            equity_usdc: number;
            realized_pnl_usdc: number;
            position_value_usdc: number;
            open_value_usdc: number;
            captured_at: string;
          }>);

    // Baseline: exact first raw snapshot in window
    const baselineRow = db
      .prepare(
        `SELECT equity_usdc FROM portfolio_snapshots
         WHERE profile = ? AND captured_at >= datetime('now', ?)
         ORDER BY captured_at ASC LIMIT 1`,
      )
      .get(effectiveProfile, since) as { equity_usdc: number } | undefined;

    // Initial balance from profile_settings
    const initialBalance =
      resolveInitialBalanceUsdc(controlDb, effectiveProfile, defaultInitialBalanceUsdc) ?? 0;

    const hasInitialBalance = initialBalance > 0;
    const effectiveCoverageStart =
      interval === "all"
        ? (profileStart ?? historyStart)
        : profileStart && profileStart > windowStart
          ? profileStart
          : windowStart;
    const coverageComplete =
      historyStart != null &&
      effectiveCoverageStart != null &&
      historyStart <= effectiveCoverageStart;

    const baseline =
      !coverageComplete && hasInitialBalance
        ? initialBalance
        : (baselineRow?.equity_usdc ?? initialBalance);
    const currentEquity = items.length > 0 ? items[items.length - 1]!.equity_usdc : baseline;

    return ok({
      items: items.map((p) => ({
        equityUsdc: p.equity_usdc,
        realizedPnlUsdc: p.realized_pnl_usdc,
        positionValueUsdc: p.position_value_usdc,
        openValueUsdc: p.open_value_usdc,
        capturedAt: p.captured_at,
      })),
      baseline,
      currentEquity,
      portfolioPnl: currentEquity - baseline,
      interval,
      historyStart,
      coverageComplete,
    });
  });
};

import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ledgerInstant, parseLedgerInstantMs } from "@krabs/db";
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

// `lookupFailed` is not the same signal as a null `createdAt`: no control.db and no matching row
// both mean "this profile has no recorded lifetime boundary", which the caller may safely treat as
// covered. A thrown query means the boundary may well exist and we simply could not read it, which
// must not be laundered into the same null the caller reads as "nothing to cover".
function resolveProfileStart(
  controlDb: Database.Database | undefined,
  profileId: string,
): { createdAt: string | null; lookupFailed: boolean } {
  if (!controlDb) return { createdAt: null, lookupFailed: false };
  try {
    const profileRow = controlDb
      .prepare("SELECT created_at FROM profiles WHERE profile_id = ?")
      .get(profileId) as { created_at: string | null } | undefined;
    return { createdAt: profileRow?.created_at ?? null, lookupFailed: false };
  } catch {
    return { createdAt: null, lookupFailed: true };
  }
}

async function fetchExternalPortfolioSeries(
  funderAddress: string,
  interval: "1d" | "1w" | "1m" | "all",
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
    const firstPointMs = firstPoint ? Date.parse(firstPoint.capturedAt) : NaN;
    // Polymarket's `p` is cumulative P/L. Windowed tabs display the delta
    // over that window when the API series itself covers it; ALL remains cumulative.
    const useRollingBaseline =
      interval !== "all" &&
      intervalWindowMs != null &&
      Number.isFinite(firstPointMs) &&
      firstPointMs - windowStartMs <= fidelityMs;
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
      if (funderAddress) {
        const external = await fetchExternalPortfolioSeries(funderAddress, interval);
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
    // The cutoff is computed in JS as canonical ISO rather than bound as a SQLite modifier string,
    // because `datetime('now', ...)` renders space-form and `' '` (0x20) sorts below `'T'` (0x54):
    // a raw compare then puts every ISO row sharing the cutoff's calendar day ABOVE it regardless
    // of time-of-day. These day counts are exact multiples of 86400s, same as the modifiers they
    // replace ("-1 day" / "-7 days" / "-30 days" / "-90 days").
    //
    // Every comparison and ordering over `captured_at` below then goes through `ledgerInstant()`
    // rather than comparing the bind lexically. Today's 24,063 production rows are all canonical
    // ISO — the sole writer (`ProfileRuntimePublisher`) binds `new Date().toISOString()` — but the
    // column also carries `DEFAULT (datetime('now'))`, which renders space-form and cannot be
    // dropped without recreating the table on the 18.38 GB live ledger. So the canonical rendering
    // holds only for as long as no writer omits the column, and this reader must not depend on
    // that: a single space-form row would otherwise sort below every same-day ISO row and fall out
    // of the window, or win the `ORDER BY … LIMIT 1` baseline it does not deserve. The wrap costs
    // the two `captured_at` indexes on a table retention caps at 90 days, which is why it is
    // affordable here and not on the tables `toSqliteDateTime` exists for.
    const sinceDays: Record<string, number> = {
      "1d": 1,
      "1w": 7,
      "1m": 30,
      all: 90,
    };
    const days = sinceDays[interval] ?? 1;
    const bucket = bucketMinutes[interval] ?? 5;
    const maxRawPoints = 200;

    const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const historyStartRow = db
      .prepare(
        `SELECT captured_at
         FROM portfolio_snapshots
         WHERE profile = ?
         ORDER BY ${ledgerInstant("captured_at")} ASC
         LIMIT 1`,
      )
      .get(effectiveProfile) as { captured_at: string } | undefined;
    const historyStart = historyStartRow?.captured_at ?? null;

    const { createdAt: profileStart, lookupFailed: profileLookupFailed } = resolveProfileStart(
      controlDb,
      effectiveProfile,
    );

    const rawCountRow = db
      .prepare(
        `SELECT COUNT(*) as c
         FROM portfolio_snapshots
         WHERE profile = ? AND ${ledgerInstant("captured_at")} >= ${ledgerInstant("?")}`,
      )
      .get(effectiveProfile, windowStart) as { c: number };
    const rawCount = rawCountRow.c;

    const itemQuery =
      rawCount <= maxRawPoints
        ? db.prepare(
            `SELECT equity_usdc, realized_pnl_usdc, position_value_usdc,
                    liquidation_value_usdc, unrealized_pnl_mid_usdc,
                    unrealized_pnl_liquidation_usdc, total_equity_liquidation_usdc,
                    open_value_usdc, captured_at
             FROM portfolio_snapshots
             WHERE profile = ? AND ${ledgerInstant("captured_at")} >= ${ledgerInstant("?")}
             ORDER BY ${ledgerInstant("captured_at")} ASC`,
          )
        : db.prepare(
            `SELECT ps.equity_usdc, ps.realized_pnl_usdc, ps.position_value_usdc,
                    ps.liquidation_value_usdc, ps.unrealized_pnl_mid_usdc,
                    ps.unrealized_pnl_liquidation_usdc, ps.total_equity_liquidation_usdc,
                    ps.open_value_usdc, ps.captured_at
             FROM portfolio_snapshots ps
             INNER JOIN (
               SELECT MAX(id) as max_id
               FROM portfolio_snapshots
               WHERE profile = ? AND ${ledgerInstant("captured_at")} >= ${ledgerInstant("?")}
               -- The bucket key stays unwrapped because strftime PARSES its argument instead of
               -- comparing it lexically, so ISO-ms, SQLite-space and ISO-without-ms all bucket
               -- identically. That tolerance is not total: strftime returns NULL for the Gamma
               -- +00 shapes, which would collapse every such row into one GROUP BY NULL bucket.
               -- No writer of this column can emit +00 (the explicit INSERT binds ISO, the
               -- surviving DEFAULT emits space), so it is unreachable here — but if that ever stops
               -- holding, this key needs the same replace(…, '+00', '') the comparisons use.
               GROUP BY strftime('%Y-%m-%d', captured_at) || 'T' ||
                 printf('%02d', (CAST(strftime('%H', captured_at) AS INTEGER) * 60
                   + CAST(strftime('%M', captured_at) AS INTEGER)) / ?)
             ) b ON ps.id = b.max_id
             ORDER BY ${ledgerInstant("ps.captured_at")} ASC`,
          );

    const items =
      rawCount <= maxRawPoints
        ? (itemQuery.all(effectiveProfile, windowStart) as Array<{
            equity_usdc: number;
            realized_pnl_usdc: number;
            position_value_usdc: number;
            liquidation_value_usdc: number | null;
            unrealized_pnl_mid_usdc: number | null;
            unrealized_pnl_liquidation_usdc: number | null;
            total_equity_liquidation_usdc: number | null;
            open_value_usdc: number;
            captured_at: string;
          }>)
        : (itemQuery.all(effectiveProfile, windowStart, bucket) as Array<{
            equity_usdc: number;
            realized_pnl_usdc: number;
            position_value_usdc: number;
            liquidation_value_usdc: number | null;
            unrealized_pnl_mid_usdc: number | null;
            unrealized_pnl_liquidation_usdc: number | null;
            total_equity_liquidation_usdc: number | null;
            open_value_usdc: number;
            captured_at: string;
          }>);

    // Baseline: exact first raw snapshot in window
    const baselineRow = db
      .prepare(
        `SELECT equity_usdc FROM portfolio_snapshots
         WHERE profile = ? AND ${ledgerInstant("captured_at")} >= ${ledgerInstant("?")}
         ORDER BY ${ledgerInstant("captured_at")} ASC LIMIT 1`,
      )
      .get(effectiveProfile, windowStart) as { equity_usdc: number } | undefined;

    // Initial balance from profile_settings
    const initialBalance =
      resolveInitialBalanceUsdc(controlDb, effectiveProfile, defaultInitialBalanceUsdc) ?? 0;

    const hasInitialBalance = initialBalance > 0;
    // These three timestamps come from three different writers — `profileStart` from control.db
    // (`profiles.created_at`), `historyStart` from the ledger, `windowStart` from JS — so a raw
    // string compare hits the same `' '` (0x20) < `'T'` (0x54) trap the SQL above now avoids: a
    // space-rendered profile start would compare below every same-day ISO window start and flip
    // `coverageComplete`. Both columns are canonical ISO on production today (all 3 `profiles`
    // rows measured 2026-08-06; `portfolio_snapshots.captured_at` 24,063/24,063 per migration
    // 095), but both also carry `DEFAULT (datetime('now'))` as a second, un-removable writer
    // path. Comparing parsed instants is the only ordering that survives either one firing.
    const historyStartMs = parseLedgerInstantMs(historyStart);
    const profileStartMs = parseLedgerInstantMs(profileStart);
    const windowStartMs = Date.parse(windowStart);
    // A start we could not read is NOT the same as a profile with no recorded start. With none
    // recorded, the ledger's own first snapshot is the only lifetime boundary that exists, so
    // history trivially covers it. With one recorded but unparseable — or with a lookup that threw —
    // the boundary EXISTS and is unknown to us.
    const profileStartUnknown =
      profileLookupFailed || (profileStart != null && Number.isNaN(profileStartMs));
    const coverageStartMs =
      interval === "all"
        ? Number.isNaN(profileStartMs)
          ? historyStartMs
          : profileStartMs
        : Number.isNaN(profileStartMs) || profileStartMs <= windowStartMs
          ? windowStartMs
          : profileStartMs;
    // Only `all` has to fail closed on an unknown boundary, because for `all` that boundary IS the
    // coverage question: falling back to history would let the series claim full-lifetime coverage
    // it cannot prove and drop the initial-balance baseline in favour of the first snapshot. A
    // windowed interval asks a strictly narrower question that `historyStartMs <= windowStartMs`
    // answers outright — history predates the window, so the window is covered whatever the profile
    // start was. That inequality is exactly what the comparison below reduces to when the start is
    // unknown, since an unparsed `profileStartMs` already collapses `coverageStartMs` to
    // `windowStartMs`. Failing closed there instead would substitute the initial balance for a real
    // in-window snapshot and silently report the wrong portfolioPnl.
    const coverageComplete =
      !(interval === "all" && profileStartUnknown) &&
      !Number.isNaN(historyStartMs) &&
      !Number.isNaN(coverageStartMs) &&
      historyStartMs <= coverageStartMs;

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
        liquidationValueUsdc: p.liquidation_value_usdc ?? null,
        unrealizedPnlMidUsdc: p.unrealized_pnl_mid_usdc ?? null,
        unrealizedPnlLiquidationUsdc: p.unrealized_pnl_liquidation_usdc ?? null,
        totalEquityLiquidationUsdc: p.total_equity_liquidation_usdc ?? null,
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

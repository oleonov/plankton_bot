import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { LiveLiteConfig } from "./live-lite-guard.js";

export interface PreflightBlocker {
  code: string;
  message: string;
}

export interface PreflightWarning {
  code: string;
  message: string;
}

export interface ProfilePreflightResult {
  status: "passed" | "passed_with_warnings" | "failed";
  blockers: PreflightBlocker[];
  warnings: PreflightWarning[];
  info: Record<string, unknown>;
}

export function runProfilePreflight(opts: {
  profile: string;
  ledgerDb: Database.Database;
  controlDb: Database.Database;
  liveLiteConfig?: LiveLiteConfig;
}): ProfilePreflightResult {
  const blockers: PreflightBlocker[] = [];
  const warnings: PreflightWarning[] = [];
  const info: Record<string, unknown> = { profile: opts.profile };

  if (opts.profile === "live-lite" && opts.liveLiteConfig) {
    runLiveLiteChecks(opts.ledgerDb, opts.liveLiteConfig, blockers, warnings);
  }

  const familyCount = opts.controlDb
    .prepare(
      "SELECT COUNT(*) as cnt FROM family_deployments WHERE profile = ? AND enabled = 1",
    )
    .get(opts.profile) as { cnt: number };
  info.deployedFamilies = familyCount.cnt;

  const posCount = opts.ledgerDb
    .prepare("SELECT COUNT(*) as cnt FROM positions WHERE status = 'open'")
    .get() as { cnt: number };
  info.openPositions = posCount.cnt;

  const status =
    blockers.length > 0
      ? "failed"
      : warnings.length > 0
        ? "passed_with_warnings"
        : "passed";

  return { status, blockers, warnings, info };
}

function runLiveLiteChecks(
  db: Database.Database,
  envelope: LiveLiteConfig,
  blockers: PreflightBlocker[],
  warnings: PreflightWarning[],
): void {
  // Positions outside allowlist
  if (envelope.familyAllowlist.length > 0) {
    const placeholders = envelope.familyAllowlist.map(() => "?").join(",");
    const outsidePositions = db
      .prepare(
        `SELECT DISTINCT family_id FROM positions WHERE status = 'open' AND family_id NOT IN (${placeholders})`,
      )
      .all(...envelope.familyAllowlist) as { family_id: string }[];
    for (const row of outsidePositions) {
      blockers.push({
        code: "NON_ALLOWLISTED_POSITION",
        message: `open position with non-allowlisted family: ${row.family_id}`,
      });
    }
  }

  // Orders outside allowlist
  if (envelope.familyAllowlist.length > 0) {
    const placeholders = envelope.familyAllowlist.map(() => "?").join(",");
    const outsideOrders = db
      .prepare(
        `SELECT DISTINCT family_id FROM orders WHERE status IN ('open','pending','partially-filled') AND family_id NOT IN (${placeholders})`,
      )
      .all(...envelope.familyAllowlist) as { family_id: string }[];
    for (const row of outsideOrders) {
      blockers.push({
        code: "NON_ALLOWLISTED_ORDER",
        message: `open order with non-allowlisted family: ${row.family_id}`,
      });
    }
  }

  // Combined exposure
  const positionValue = db
    .prepare(
      "SELECT COALESCE(SUM(cost_basis_usdc), 0) as total FROM positions WHERE status = 'open'",
    )
    .get() as { total: number };

  const buyOrderNotional = db
    .prepare(
      "SELECT COALESCE(SUM(size_usdc), 0) as total FROM orders WHERE side = 'buy' AND status IN ('open','pending','partially-filled')",
    )
    .get() as { total: number };

  const totalExposure = positionValue.total + buyOrderNotional.total;
  if (totalExposure > envelope.maxOpenValueUsdc) {
    blockers.push({
      code: "EXPOSURE_EXCEEDS_CAP",
      message: `combined exposure $${totalExposure.toFixed(2)} (positions $${positionValue.total.toFixed(2)} + buy orders $${buyOrderNotional.total.toFixed(2)}) exceeds cap $${envelope.maxOpenValueUsdc}`,
    });
  }

  // Active markets count
  const activeMarkets = db
    .prepare(
      "SELECT COUNT(DISTINCT token_id) as cnt FROM positions WHERE status = 'open'",
    )
    .get() as { cnt: number };
  if (activeMarkets.cnt > envelope.maxActiveMarkets) {
    blockers.push({
      code: "MARKETS_EXCEED_CAP",
      message: `active markets ${activeMarkets.cnt} exceeds cap ${envelope.maxActiveMarkets}`,
    });
  }

  // Warn if exposure is above 80% of cap but still within limits
  if (
    totalExposure <= envelope.maxOpenValueUsdc &&
    totalExposure > envelope.maxOpenValueUsdc * 0.8
  ) {
    warnings.push({
      code: "EXPOSURE_NEAR_CAP",
      message: `exposure $${totalExposure.toFixed(2)} is above 80% of cap $${envelope.maxOpenValueUsdc}`,
    });
  }
}

/** Write preflight result to control.db preflight_reports table */
export function writePreflightReport(
  controlDb: Database.Database,
  profile: string,
  result: ProfilePreflightResult,
  switchRequestId?: string,
): string {
  const reportId = randomUUID();
  controlDb
    .prepare(
      `INSERT INTO preflight_reports
       (report_id, switch_request_id, profile, kind, status, blockers_json, warnings_json, info_json, created_at)
     VALUES (?, ?, ?, 'startup', ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      reportId,
      switchRequestId ?? null,
      profile,
      result.status,
      result.blockers.length > 0 ? JSON.stringify(result.blockers) : null,
      result.warnings.length > 0 ? JSON.stringify(result.warnings) : null,
      JSON.stringify(result.info),
    );
  return reportId;
}

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { resolveFamilyLiveTradingPolicy } from "@plankton/domain";
import type { LiveLiteConfig } from "./live-lite-guard.js";
import { LiveLiteGuard } from "./live-lite-guard.js";
import { parseRelayerConfigJson } from "./relayer-config.js";

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
    const liveLiteGuard = new LiveLiteGuard(opts.liveLiteConfig);
    info.walletMode = liveLiteGuard.getWalletMode();
    info.minOrderUsdc = liveLiteGuard.getMinOrderUsdc();
    runLiveLiteChecks(opts.ledgerDb, opts.controlDb, opts.liveLiteConfig, blockers, warnings);
  }

  const familyCount = opts.controlDb
    .prepare("SELECT COUNT(*) as cnt FROM family_deployments WHERE profile = ? AND enabled = 1")
    .get(opts.profile) as { cnt: number };
  info.deployedFamilies = familyCount.cnt;

  const posCount = opts.ledgerDb
    .prepare("SELECT COUNT(*) as cnt FROM positions WHERE status = 'open'")
    .get() as { cnt: number };
  info.openPositions = posCount.cnt;

  const status =
    blockers.length > 0 ? "failed" : warnings.length > 0 ? "passed_with_warnings" : "passed";

  return { status, blockers, warnings, info };
}

function runLiveLiteChecks(
  db: Database.Database,
  controlDb: Database.Database,
  envelope: LiveLiteConfig,
  blockers: PreflightBlocker[],
  warnings: PreflightWarning[],
): void {
  const liveLiteGuard = new LiveLiteGuard(envelope);
  const walletMode = liveLiteGuard.getWalletMode();
  const minOrderUsdc = liveLiteGuard.getMinOrderUsdc();
  const settingsRow = controlDb
    .prepare("SELECT relayer_json FROM profile_settings WHERE profile_id = 'live-lite'")
    .get() as { relayer_json: string | null } | undefined;

  const enabledFamilies = controlDb
    .prepare(
      `SELECT fd.family_id, fc.primary_category, fc.fee_tier, fc.live_wallet_requirement,
              fc.requires_post_only_for_live
         FROM family_deployments fd
         JOIN family_catalog fc ON fc.family_id = fd.family_id
        WHERE fd.profile = 'live-lite' AND fd.enabled = 1
        ORDER BY fd.priority, fd.family_id`,
    )
    .all() as Array<{
    family_id: string;
    primary_category: string;
    fee_tier: string | null;
    live_wallet_requirement: string | null;
    requires_post_only_for_live: number | null;
  }>;

  if (liveLiteGuard.wouldExceedFamilyCount(enabledFamilies.length)) {
    blockers.push({
      code: "LIVE_MAX_FAMILIES_EXCEEDED",
      message: `enabled live families ${enabledFamilies.length} exceeds cap ${envelope.maxFamilies}`,
    });
  }

  if (walletMode === "eoa" && (minOrderUsdc == null || minOrderUsdc < 3)) {
    blockers.push({
      code: "LIVE_MIN_ORDER_TOO_LOW",
      message: `live-lite EOA mode requires min_order_usdc >= 3.00 (current ${minOrderUsdc ?? "unset"})`,
    });
  }

  if (walletMode === "relayer") {
    if (minOrderUsdc == null || minOrderUsdc < 1) {
      blockers.push({
        code: "LIVE_MIN_ORDER_TOO_LOW",
        message: `live-lite relayer mode requires min_order_usdc >= 1.00 (current ${minOrderUsdc ?? "unset"})`,
      });
    }

    const relayerConfig = parseRelayerConfigJson(settingsRow?.relayer_json ?? null);
    if (!relayerConfig.ok) {
      blockers.push({
        code: "LIVE_RELAYER_CONFIG_INVALID",
        message: relayerConfig.errors.join("; "),
      });
    }
  }

  for (const family of enabledFamilies) {
    const policy = resolveFamilyLiveTradingPolicy({
      primaryCategory: family.primary_category,
      feeTier: family.fee_tier as "fee-free" | "fee-enabled" | "unknown" | null,
      liveWalletRequirement: family.live_wallet_requirement as "eoa-ok" | "relayer-required" | null,
      requiresPostOnlyForLive:
        family.requires_post_only_for_live == null
          ? null
          : family.requires_post_only_for_live === 1,
    });

    if (walletMode === "eoa" && policy.liveWalletRequirement === "relayer-required") {
      blockers.push({
        code: "LIVE_EOA_FEE_ENABLED_FAMILY",
        message: `enabled live family ${family.family_id} is not allowed in EOA mode (${policy.feeTier}, requires relayer path)`,
      });
    }

    if (policy.requiresPostOnlyForLive && walletMode !== "relayer") {
      blockers.push({
        code: "LIVE_POST_ONLY_REQUIRED",
        message: `enabled live family ${family.family_id} requires post-only before live trading`,
      });
    }
  }

  // Positions outside allowlist
  const positionsQuery =
    envelope.familyAllowlist.length > 0
      ? {
          sql: `SELECT DISTINCT family_id FROM positions WHERE status = 'open' AND family_id NOT IN (${envelope.familyAllowlist.map(() => "?").join(",")})`,
          params: envelope.familyAllowlist,
        }
      : {
          sql: "SELECT DISTINCT family_id FROM positions WHERE status = 'open'",
          params: [] as string[],
        };
  const outsidePositions = db.prepare(positionsQuery.sql).all(...positionsQuery.params) as {
    family_id: string;
  }[];
  for (const row of outsidePositions) {
    blockers.push({
      code: "NON_ALLOWLISTED_POSITION",
      message: `open position with non-allowlisted family: ${row.family_id}`,
    });
  }

  // Orders outside allowlist
  const ordersQuery =
    envelope.familyAllowlist.length > 0
      ? {
          sql: `SELECT DISTINCT family_id FROM orders WHERE status IN ('open','pending','partially-filled') AND family_id NOT IN (${envelope.familyAllowlist.map(() => "?").join(",")})`,
          params: envelope.familyAllowlist,
        }
      : {
          sql: "SELECT DISTINCT family_id FROM orders WHERE status IN ('open','pending','partially-filled')",
          params: [] as string[],
        };
  const outsideOrders = db.prepare(ordersQuery.sql).all(...ordersQuery.params) as {
    family_id: string;
  }[];
  for (const row of outsideOrders) {
    blockers.push({
      code: "NON_ALLOWLISTED_ORDER",
      message: `open order with non-allowlisted family: ${row.family_id}`,
    });
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
    .prepare("SELECT COUNT(DISTINCT token_id) as cnt FROM positions WHERE status = 'open'")
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

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
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
  relayerBuilderAuthConfigured?: boolean;
}): ProfilePreflightResult {
  const blockers: PreflightBlocker[] = [];
  const warnings: PreflightWarning[] = [];
  const info: Record<string, unknown> = { profile: opts.profile };

  if (opts.profile === "live-lite" && opts.liveLiteConfig) {
    const liveLiteGuard = new LiveLiteGuard(opts.liveLiteConfig);
    info.walletMode = liveLiteGuard.getWalletMode();
    info.minOrderUsdc = liveLiteGuard.getMinOrderUsdc();
    info.relayerBuilderAuthConfigured = opts.relayerBuilderAuthConfigured ?? false;
    runLiveLiteChecks(
      opts.ledgerDb,
      opts.controlDb,
      opts.liveLiteConfig,
      opts.relayerBuilderAuthConfigured ?? false,
      blockers,
      warnings,
    );
  }

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
  relayerBuilderAuthConfigured: boolean,
  blockers: PreflightBlocker[],
  warnings: PreflightWarning[],
): void {
  const liveLiteGuard = new LiveLiteGuard(envelope);
  const walletMode = liveLiteGuard.getWalletMode();
  const minOrderUsdc = liveLiteGuard.getMinOrderUsdc();
  const settingsRow = controlDb
    .prepare("SELECT relayer_json FROM profile_settings WHERE profile_id = 'live-lite'")
    .get() as { relayer_json: string | null } | undefined;

  if (walletMode === "eoa" && (minOrderUsdc == null || minOrderUsdc < 0.5)) {
    blockers.push({
      code: "LIVE_MIN_ORDER_TOO_LOW",
      message: `live-lite EOA mode requires min_order_usdc >= 0.50 (current ${minOrderUsdc ?? "unset"})`,
    });
  }

  if (walletMode === "relayer") {
    if (minOrderUsdc == null || minOrderUsdc < 0.05) {
      blockers.push({
        code: "LIVE_MIN_ORDER_TOO_LOW",
        message: `live-lite relayer mode requires min_order_usdc >= 0.05 (current ${minOrderUsdc ?? "unset"})`,
      });
    }

    const relayerConfig = parseRelayerConfigJson(settingsRow?.relayer_json ?? null);
    if (!relayerConfig.ok) {
      blockers.push({
        code: "LIVE_RELAYER_CONFIG_INVALID",
        message: relayerConfig.errors.join("; "),
      });
    } else if (!relayerConfig.value?.builder && !relayerBuilderAuthConfigured) {
      blockers.push({
        code: "LIVE_RELAYER_BUILDER_AUTH_MISSING",
        message:
          "live-lite relayer mode requires builder auth: configure relayer_json.builder or POLY_BUILDER_API_KEY/POLY_BUILDER_SECRET/POLY_BUILDER_PASSPHRASE",
      });
    }
  }

  // familyAllowlist is no longer enforced on positions/orders (family_id column dropped)

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

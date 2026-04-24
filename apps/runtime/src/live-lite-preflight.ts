import type Database from "better-sqlite3";
import type { LiveLiteConfig } from "./live-lite-guard.js";

export interface PreflightResult {
  shouldPause: boolean;
  violations: string[];
}

export function liveLitePreflight(
  db: Database.Database,
  envelope: LiveLiteConfig,
): PreflightResult {
  const violations: string[] = [];

  // Active markets count
  const activeMarkets = db
    .prepare(
      "SELECT COUNT(DISTINCT token_id) as cnt FROM positions WHERE status IN ('open','dust')",
    )
    .get() as { cnt: number };

  if (activeMarkets.cnt > envelope.maxActiveMarkets) {
    violations.push(`active markets ${activeMarkets.cnt} exceeds cap ${envelope.maxActiveMarkets}`);
  }

  // Total exposure = positions cost_basis_usdc + open buy order notional (conservative full size_usdc)
  const positionValue = db
    .prepare(
      "SELECT COALESCE(SUM(cost_basis_usdc), 0) as total FROM positions WHERE status IN ('open','dust')",
    )
    .get() as { total: number };

  const buyOrderNotional = db
    .prepare(
      "SELECT COALESCE(SUM(size_usdc), 0) as total FROM orders WHERE side = 'buy' AND status IN ('open','pending','partially-filled')",
    )
    .get() as { total: number };

  const totalExposure = positionValue.total + buyOrderNotional.total;
  if (totalExposure > envelope.maxOpenValueUsdc) {
    violations.push(
      `combined exposure $${totalExposure.toFixed(2)} (positions $${positionValue.total.toFixed(2)} + buy orders $${buyOrderNotional.total.toFixed(2)}) exceeds cap $${envelope.maxOpenValueUsdc}`,
    );
  }

  return {
    shouldPause: violations.length > 0,
    violations,
  };
}

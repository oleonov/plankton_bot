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

  // 1. Open positions with familyId not in allowlist
  const positionsOutside = db
    .prepare(positionsQuery.sql)
    .all(...positionsQuery.params) as { family_id: string }[];

  for (const row of positionsOutside) {
    violations.push(`open position with non-allowlisted family: ${row.family_id}`);
  }

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

  // 2. Open orders with familyId not in allowlist
  const ordersOutside = db
    .prepare(ordersQuery.sql)
    .all(...ordersQuery.params) as { family_id: string }[];

  for (const row of ordersOutside) {
    violations.push(`open order with non-allowlisted family: ${row.family_id}`);
  }

  // 3. Active markets count
  const activeMarkets = db
    .prepare("SELECT COUNT(DISTINCT token_id) as cnt FROM positions WHERE status = 'open'")
    .get() as { cnt: number };

  if (activeMarkets.cnt > envelope.maxActiveMarkets) {
    violations.push(`active markets ${activeMarkets.cnt} exceeds cap ${envelope.maxActiveMarkets}`);
  }

  // 4. Total exposure = positions cost_basis_usdc + open buy order notional (conservative full size_usdc)
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
    violations.push(
      `combined exposure $${totalExposure.toFixed(2)} (positions $${positionValue.total.toFixed(2)} + buy orders $${buyOrderNotional.total.toFixed(2)}) exceeds cap $${envelope.maxOpenValueUsdc}`,
    );
  }

  return {
    shouldPause: violations.length > 0,
    violations,
  };
}

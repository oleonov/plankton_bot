/**
 * One-off recovery script for orphaned inventory lots.
 *
 * Finds closed positions with remaining_size > 0 in inventory_lots,
 * queries Gamma for the actual resolution, and performs proper settlement:
 * - Zeros inventory lots
 * - Writes settlement_ledger entries
 * - Updates position realized PnL, size to 0, and closed_at
 * - Updates market_resolutions from unknown/detected to actual resolution/settled
 * - Recomputes family state for affected families
 *
 * Usage:
 *   npx tsx scripts/recover-orphaned-lots.ts <path-to-db>
 *
 * Run with runtime container STOPPED. Take a backup first.
 */

import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const Database = require("better-sqlite3") as typeof import("better-sqlite3").default;

const DB_PATH = process.argv[2];
if (!DB_PATH) {
  console.error("Usage: npx tsx scripts/recover-orphaned-lots.ts <path-to-db>");
  process.exit(1);
}

const GAMMA_BASE = "https://gamma-api.polymarket.com";

interface OrphanedPosition {
  positionId: string;
  tokenId: string;
  familyId: string;
  conditionId: string;
  slug: string;
  outcome: string;
  size: number;
  avgEntryPrice: number;
  realizedPnl: number;
  lotCount: number;
  lotRemainingSize: number;
  lotTailCost: number;
}

interface GammaResolution {
  resolution: "YES" | "NO" | "unknown";
  closedTime: string | null;
}

async function fetchResolution(slug: string): Promise<GammaResolution> {
  const url = `${GAMMA_BASE}/markets/slug/${encodeURIComponent(slug)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as Record<string, unknown>;

      const closed = raw.closed === true;
      if (!closed) return { resolution: "unknown", closedTime: null };

      // Parse outcomePrices
      const rawOutcomes = raw.outcomes as string | undefined;
      const rawPrices = raw.outcomePrices as string | undefined;
      if (rawOutcomes && rawPrices) {
        const outcomes: unknown[] =
          typeof rawOutcomes === "string" ? JSON.parse(rawOutcomes) : rawOutcomes;
        const prices: unknown[] = typeof rawPrices === "string" ? JSON.parse(rawPrices) : rawPrices;
        if (Array.isArray(outcomes) && Array.isArray(prices)) {
          for (let i = 0; i < outcomes.length; i++) {
            if (Number(prices[i]) === 1) {
              const winner =
                String(outcomes[i]).toUpperCase() === "YES" ? ("YES" as const) : ("NO" as const);
              return {
                resolution: winner,
                closedTime: (raw.closedTime as string) ?? null,
              };
            }
          }
        }
      }

      return {
        resolution: "unknown",
        closedTime: (raw.closedTime as string) ?? null,
      };
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("unreachable");
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // 1. Find all closed positions with open lots
  const orphans = db
    .prepare(
      `
    SELECT
      p.position_id AS positionId,
      p.token_id AS tokenId,
      p.family_id AS familyId,
      p.size,
      p.avg_entry_price AS avgEntryPrice,
      p.realized_pnl AS realizedPnl,
      m.condition_id AS conditionId,
      m.slug,
      m.outcome,
      COUNT(l.lot_id) AS lotCount,
      COALESCE(SUM(l.remaining_size), 0) AS lotRemainingSize,
      COALESCE(SUM(l.remaining_size * l.entry_price), 0) AS lotTailCost
    FROM positions p
    JOIN markets m ON p.token_id = m.token_id
    JOIN inventory_lots l ON p.position_id = l.position_id
    WHERE p.status = 'closed' AND l.remaining_size > 0
    GROUP BY p.position_id
    ORDER BY p.family_id
  `,
    )
    .all() as OrphanedPosition[];

  if (orphans.length === 0) {
    console.log("No orphaned lots found. Nothing to do.");
    db.close();
    return;
  }

  console.log(`Found ${orphans.length} closed positions with open lots:\n`);
  for (const o of orphans) {
    console.log(
      `  ${o.familyId} | ${o.positionId.substring(0, 30)}... | lots=${o.lotCount} remSize=${o.lotRemainingSize.toFixed(2)} tail=$${o.lotTailCost.toFixed(2)} | slug=${o.slug}`,
    );
  }

  // 2. Group by conditionId and fetch resolution from Gamma
  const conditionIds = [...new Set(orphans.map((o) => o.conditionId))];
  const resolutions = new Map<string, GammaResolution>();

  console.log(`\nFetching resolution for ${conditionIds.length} conditions from Gamma...\n`);
  for (const cid of conditionIds) {
    const orphan = orphans.find((o) => o.conditionId === cid)!;
    const result = await fetchResolution(orphan.slug);
    resolutions.set(cid, result);
    console.log(`  ${cid.substring(0, 20)}... (${orphan.slug}): ${result.resolution}`);
    // Rate limit: wait between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  // 3. Settle in a single transaction
  const now = new Date().toISOString();

  const settleLots = db.prepare(
    `UPDATE inventory_lots SET remaining_size = 0 WHERE position_id = ? AND remaining_size > 0`,
  );
  const updatePosition = db.prepare(
    `UPDATE positions SET size = 0, realized_pnl = ?, current_value_usdc = 0, closed_at = ?, updated_at = ? WHERE position_id = ?`,
  );
  const insertSettlement = db.prepare(
    `INSERT OR IGNORE INTO settlement_ledger
       (settlement_id, condition_id, position_id, token_id, family_id,
        resolution, settlement_price, size, delta, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertResolution = db.prepare(
    `INSERT INTO market_resolutions (condition_id, resolution, resolved_at, detected_at, source, raw_response, status)
     VALUES (?, ?, ?, ?, 'manual', NULL, 'settled')
     ON CONFLICT(condition_id) DO UPDATE SET
       resolution = excluded.resolution,
       resolved_at = excluded.resolved_at,
       source = 'manual',
       status = 'settled'`,
  );

  const runRecovery = db.transaction(() => {
    let settled = 0;
    for (const o of orphans) {
      const res = resolutions.get(o.conditionId);
      if (!res || res.resolution === "unknown") {
        console.log(`  SKIP ${o.positionId.substring(0, 30)}... — resolution unknown`);
        continue;
      }

      const isWinner = o.outcome.toUpperCase() === res.resolution;
      const settlementPrice = isWinner ? 1.0 : 0.0;
      // Use lot remaining size (source of truth), not position.size (may be stale)
      const settlementPnl = (settlementPrice - o.avgEntryPrice) * o.lotRemainingSize;
      const newRealizedPnl = o.realizedPnl + settlementPnl;

      // Zero lots
      settleLots.run(o.positionId);

      // Update position (set closed_at to actual resolution time, not startup time)
      const closedAt = res.closedTime ?? now;
      updatePosition.run(newRealizedPnl, closedAt, now, o.positionId);

      // Upsert market_resolutions first (settlement_ledger has FK to it)
      upsertResolution.run(o.conditionId, res.resolution, res.closedTime ?? now, now);

      // Write settlement_ledger
      const settlementId = `recovery-${o.conditionId}-${o.tokenId}`;
      insertSettlement.run(
        settlementId,
        o.conditionId,
        o.positionId,
        o.tokenId,
        o.familyId,
        res.resolution,
        settlementPrice,
        o.lotRemainingSize,
        settlementPnl,
        res.closedTime ?? now,
      );

      console.log(
        `  SETTLED ${o.positionId.substring(0, 30)}... | ${res.resolution} | pnl=${settlementPnl.toFixed(4)}`,
      );
      settled++;
    }
    return settled;
  });

  const settledCount = runRecovery();
  console.log(`\nSettled ${settledCount}/${orphans.length} positions.`);

  // 4. Recompute family state for affected families
  const affectedFamilies = [...new Set(orphans.map((o) => o.familyId))];
  console.log(`\nRecomputing family state for ${affectedFamilies.length} families...`);

  for (const familyId of affectedFamilies) {
    const positions = db
      .prepare(`SELECT * FROM positions WHERE family_id = ?`)
      .all(familyId) as any[];

    let openPositionCount = 0;
    let openDustCount = 0;
    let openValueUsdc = 0;
    let totalRealizedPnl = 0;
    let currentTailCostUsdc = 0;
    const activeTokens = new Set<string>();

    for (const pos of positions) {
      totalRealizedPnl += pos.realized_pnl;
      if (pos.status === "open") {
        openPositionCount++;
        openValueUsdc += pos.cost_basis_usdc;
        activeTokens.add(pos.token_id);
      } else if (pos.status === "dust") {
        openDustCount++;
        openValueUsdc += pos.cost_basis_usdc;
        activeTokens.add(pos.token_id);
      }
    }

    // Compute tail cost from open lots on non-closed positions
    for (const pos of positions) {
      if (pos.status === "closed") continue;
      const lots = db
        .prepare(
          `SELECT remaining_size, entry_price FROM inventory_lots WHERE position_id = ? AND remaining_size > 0`,
        )
        .all(pos.position_id) as any[];
      for (const lot of lots) {
        currentTailCostUsdc += lot.remaining_size * lot.entry_price;
      }
    }

    const tailAdjustedPnlLive = totalRealizedPnl - currentTailCostUsdc;

    // Derive effective mode using same logic as FamilyExposureCalculator (family-exposure.ts:98-122).
    // We don't have FamilyRulesProvider here, so set to null — runtime will recompute on first fill.
    // The critical fields for risk-gate (currentTailCostUsdc, tailAdjustedPnlLive) are correct.
    db.prepare(
      `
      UPDATE family_runtime_state SET
        open_value_usdc = ?,
        open_position_count = ?,
        open_dust_count = ?,
        active_market_count = ?,
        current_tail_cost_usdc = ?,
        tail_adjusted_pnl_live = ?,
        effective_mode = NULL,
        derived_mode_reason = NULL,
        updated_at = ?
      WHERE family_id = ?
    `,
    ).run(
      openValueUsdc,
      openPositionCount,
      openDustCount,
      activeTokens.size,
      currentTailCostUsdc,
      tailAdjustedPnlLive,
      now,
      familyId,
    );

    console.log(
      `  ${familyId}: tail=$${currentTailCostUsdc.toFixed(2)} pnl=$${tailAdjustedPnlLive.toFixed(2)} open=${openPositionCount} dust=${openDustCount}`,
    );
  }

  // 5. Verify: no more orphaned lots
  const remaining = db
    .prepare(
      `
    SELECT COUNT(*) as cnt FROM positions p
    JOIN inventory_lots l ON p.position_id = l.position_id
    WHERE p.status = 'closed' AND l.remaining_size > 0
  `,
    )
    .get() as { cnt: number };

  console.log(`\nVerification: ${remaining.cnt} orphaned lots remaining (should be 0).`);

  db.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Recovery failed:", err);
  process.exit(1);
});

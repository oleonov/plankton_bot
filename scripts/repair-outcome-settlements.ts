/**
 * repair-outcome-settlements.ts
 *
 * One-off data repair script for mis-settled non-binary market positions.
 *
 * The bug: non-binary outcomes (e.g., "Up"/"Down") were forced to "YES"/"NO",
 * causing both tokens in a condition to be settled as winners.
 *
 * Five phases:
 *   1. Diagnose — find non-binary settlements, re-query Gamma for actual winner
 *   2. Safety check — abort if any mismatched position is not closed
 *   3. Fix settlements — update settlement_ledger + positions.realized_pnl
 *   4. Reset derived state — family_runtime_state, family_evidence, family_deployments, rollups
 *   5. Flag transitions — annotate tainted state_transitions
 *
 * Usage:
 *   npx tsx scripts/repair-outcome-settlements.ts --dry-run    (default, read-only)
 *   npx tsx scripts/repair-outcome-settlements.ts --fix         (writes to DB)
 *
 * Environment:
 *   LEDGER_PATH  — path to ledger DB (default: apps/runtime/data/ledger-live-lite.db)
 *   CONTROL_PATH — path to control DB (default: apps/runtime/data/control.db)
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const Database = require("better-sqlite3") as typeof import("better-sqlite3").default;
type DatabaseInstance = InstanceType<typeof Database>;

// ─── CLI ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = !args.includes("--fix");

const LEDGER_PATH = process.env.LEDGER_PATH ?? "apps/runtime/data/ledger-live-lite.db";
const CONTROL_PATH = process.env.CONTROL_PATH ?? "apps/runtime/data/control.db";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const GAMMA_DELAY_MS = 500;

// ─── Types ──────────────────────────────────────────────────────────────

interface SettlementRow {
  settlement_id: string;
  condition_id: string;
  position_id: string;
  token_id: string;
  family_id: string;
  resolution: string;
  settlement_price: number;
  size: number;
  delta: number;
  settled_at: string;
}

interface PositionRow {
  position_id: string;
  token_id: string;
  family_id: string;
  status: string;
  size: number;
  avg_entry_price: number;
  realized_pnl: number;
  cost_basis_usdc: number;
}

interface GammaToken {
  outcome: string;
  winner: boolean;
  token_id: string;
}

interface Mismatch {
  settlement: SettlementRow & { outcome: string; slug: string };
  actualWinnerTokenId: string;
  actualWinnerOutcome: string;
  correctPrice: number;
  correctDelta: number;
  pnlDiff: number;
}

interface FamilyExposure {
  openPositionCount: number;
  openDustCount: number;
  activeOrderCount: number;
}

// ─── Gamma API ──────────────────────────────────────────────────────────

interface GammaWinner {
  tokenId: string;
  outcome: string;
}

async function fetchWinnerFromGamma(slug: string): Promise<GammaWinner | null> {
  const url = `${GAMMA_BASE}/markets/slug/${encodeURIComponent(slug)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 404 || res.status === 422) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const raw = (await res.json()) as Record<string, unknown>;
      if (!raw || typeof raw !== "object") return null;

      // Strategy 1: tokens[].winner flag (preferred — includes token_id directly)
      const tokens = raw.tokens as GammaToken[] | undefined;
      if (tokens && Array.isArray(tokens)) {
        for (const tok of tokens) {
          if (tok.winner === true) {
            return { tokenId: tok.token_id, outcome: String(tok.outcome) };
          }
        }
      }

      // Strategy 2: outcomePrices + clobTokenIds (parallel arrays)
      const rawOutcomes = raw.outcomes;
      const rawPrices = raw.outcomePrices;
      const rawTokenIds = raw.clobTokenIds;
      if (rawOutcomes && rawPrices && rawTokenIds) {
        const outcomes: unknown[] =
          typeof rawOutcomes === "string" ? JSON.parse(rawOutcomes as string) : rawOutcomes;
        const prices: unknown[] =
          typeof rawPrices === "string" ? JSON.parse(rawPrices as string) : rawPrices;
        const tokenIds: unknown[] =
          typeof rawTokenIds === "string" ? JSON.parse(rawTokenIds as string) : rawTokenIds;

        if (
          Array.isArray(outcomes) &&
          Array.isArray(prices) &&
          Array.isArray(tokenIds) &&
          outcomes.length === prices.length &&
          outcomes.length === tokenIds.length
        ) {
          for (let i = 0; i < prices.length; i++) {
            if (Number(prices[i]) === 1) {
              return {
                tokenId: String(tokenIds[i]),
                outcome: String(outcomes[i]),
              };
            }
          }
        }
      }

      return null;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("unreachable");
}

// ─── Helpers ────────────────────────────────────────────────────────────

function log(phase: string, msg: string): void {
  console.log(`[${phase}] ${msg}`);
}

function abort(msg: string): never {
  console.error(`\nABORT: ${msg}`);
  process.exit(1);
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  repair-outcome-settlements");
  console.log(`  Mode: ${dryRun ? "DRY-RUN (read-only)" : "FIX (writing to DB)"}`);
  console.log(`  Ledger DB: ${resolve(LEDGER_PATH)}`);
  console.log(`  Control DB: ${resolve(CONTROL_PATH)}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  const ledgerDb = new Database(LEDGER_PATH, { readonly: dryRun });
  const controlDb = new Database(CONTROL_PATH, { readonly: dryRun });

  if (!dryRun) {
    ledgerDb.pragma("journal_mode = WAL");
    controlDb.pragma("journal_mode = WAL");
  }
  ledgerDb.pragma("foreign_keys = ON");
  controlDb.pragma("foreign_keys = ON");

  // ═══════════ PHASE 1: DIAGNOSE ═══════════════════════════════════════

  log("Phase 1", "Scanning for non-binary settlements...");

  // Find settlement rows where the resolution is YES/NO but the market outcome
  // is something different (indicating the outcome was forced to binary)
  const settlements = ledgerDb
    .prepare(
      `
      SELECT
        s.settlement_id, s.condition_id, s.position_id, s.token_id,
        s.family_id, s.resolution, s.settlement_price, s.size, s.delta, s.settled_at,
        m.outcome, m.slug
      FROM settlement_ledger s
      JOIN markets m ON s.token_id = m.token_id
      WHERE m.outcome NOT IN ('Yes', 'No')
         OR s.resolution NOT IN ('Yes', 'No')
    `,
    )
    .all() as (SettlementRow & { outcome: string; slug: string })[];

  if (settlements.length === 0) {
    log("Phase 1", "No non-binary settlements found. Nothing to repair.");
    ledgerDb.close();
    controlDb.close();
    return;
  }

  log("Phase 1", `Found ${settlements.length} settlement rows to check.`);

  // Group by condition_id and fetch actual winner from Gamma
  const conditionSlugs = new Map<string, string>();
  for (const s of settlements) {
    if (!conditionSlugs.has(s.condition_id)) {
      conditionSlugs.set(s.condition_id, s.slug);
    }
  }

  log("Phase 1", `Querying Gamma for ${conditionSlugs.size} conditions...`);

  const gammaWinners = new Map<string, GammaWinner>();
  for (const [conditionId, slug] of conditionSlugs) {
    const winner = await fetchWinnerFromGamma(slug);
    if (winner) {
      gammaWinners.set(conditionId, winner);
      log(
        "Phase 1",
        `  ${conditionId.substring(0, 20)}... (${slug}): winner=${winner.outcome} token=${winner.tokenId.substring(0, 20)}...`,
      );
    } else {
      log("Phase 1", `  ${conditionId.substring(0, 20)}... (${slug}): UNRESOLVED — skipping`);
    }
    await new Promise((r) => setTimeout(r, GAMMA_DELAY_MS));
  }

  // Build mismatches: settlement rows whose delta/price is wrong
  const mismatches: Mismatch[] = [];

  for (const s of settlements) {
    const winner = gammaWinners.get(s.condition_id);
    if (!winner) continue;

    // Determine correct settlement price for this token
    const isWinner = s.token_id === winner.tokenId;
    const correctPrice = isWinner ? 1.0 : 0.0;

    if (Math.abs(s.settlement_price - correctPrice) < 1e-9) continue;

    // Load position to get avg_entry_price
    const pos = ledgerDb
      .prepare(`SELECT * FROM positions WHERE position_id = ?`)
      .get(s.position_id) as PositionRow | undefined;

    if (!pos) {
      log(
        "Phase 1",
        `  WARNING: position ${s.position_id} not found for settlement ${s.settlement_id}`,
      );
      continue;
    }

    const correctDelta = (correctPrice - pos.avg_entry_price) * s.size;
    const pnlDiff = correctDelta - s.delta;

    mismatches.push({
      settlement: s,
      actualWinnerTokenId: winner.tokenId,
      actualWinnerOutcome: winner.outcome,
      correctPrice,
      correctDelta,
      pnlDiff,
    });
  }

  if (mismatches.length === 0) {
    log("Phase 1", "All settlements are correct. Nothing to repair.");
    ledgerDb.close();
    controlDb.close();
    return;
  }

  log("Phase 1", `Found ${mismatches.length} mismatched settlements:\n`);
  for (const m of mismatches) {
    const s = m.settlement;
    console.log(
      `  ${s.family_id} | ${s.token_id.substring(0, 20)}... | ` +
        `outcome=${s.outcome} | old_price=${s.settlement_price} -> correct=${m.correctPrice} | ` +
        `old_delta=${s.delta.toFixed(4)} -> correct=${m.correctDelta.toFixed(4)} | ` +
        `pnl_diff=${m.pnlDiff.toFixed(4)}`,
    );
  }
  console.log();

  // ═══════════ PHASE 2: SAFETY CHECK ════════════════════════════════════

  log("Phase 2", "Running safety checks...");

  const affectedPositionIds = [...new Set(mismatches.map((m) => m.settlement.position_id))];
  const affectedFamilyIds = [...new Set(mismatches.map((m) => m.settlement.family_id))];

  // Verify all affected positions are closed
  for (const posId of affectedPositionIds) {
    const pos = ledgerDb
      .prepare(`SELECT status FROM positions WHERE position_id = ?`)
      .get(posId) as { status: string } | undefined;

    if (!pos) abort(`Position ${posId} not found in DB`);
    if (pos.status !== "closed") {
      abort(
        `Position ${posId} has status '${pos.status}' — expected 'closed'. ` +
          `Cannot repair non-closed positions. Fix manually first.`,
      );
    }
  }
  log("Phase 2", `  All ${affectedPositionIds.length} affected positions are closed.`);

  // Verify no open inventory lots for affected positions
  for (const posId of affectedPositionIds) {
    const openLots = ledgerDb
      .prepare(
        `SELECT COUNT(*) as cnt FROM inventory_lots WHERE position_id = ? AND remaining_size > 0`,
      )
      .get(posId) as { cnt: number };

    if (openLots.cnt > 0) {
      abort(
        `Position ${posId} has ${openLots.cnt} inventory lots with remaining_size > 0. ` +
          `Cannot repair positions with open lots. Run recover-orphaned-lots.ts first.`,
      );
    }
  }
  log("Phase 2", "  No open inventory lots on affected positions.");

  // Verify no active orders for affected positions' tokens
  for (const m of mismatches) {
    const activeOrders = ledgerDb
      .prepare(
        `SELECT COUNT(*) as cnt FROM orders
         WHERE token_id = ? AND status IN ('pending', 'open', 'partially_filled')`,
      )
      .get(m.settlement.token_id) as { cnt: number };

    if (activeOrders.cnt > 0) {
      abort(
        `Token ${m.settlement.token_id} has ${activeOrders.cnt} active orders. ` +
          `Cannot repair while orders are live. Cancel orders first.`,
      );
    }
  }
  log("Phase 2", "  No active orders on affected tokens.");

  // Track family live exposure for Phase 4 tiering
  const familyExposure = new Map<string, FamilyExposure>();
  for (const familyId of affectedFamilyIds) {
    const openPos = ledgerDb
      .prepare(
        `SELECT COUNT(*) as cnt FROM positions
         WHERE family_id = ? AND status IN ('open', 'dust')`,
      )
      .get(familyId) as { cnt: number };

    const activeOrd = ledgerDb
      .prepare(
        `SELECT COUNT(*) as cnt FROM orders
         WHERE family_id = ? AND status IN ('pending', 'open', 'partially_filled')`,
      )
      .get(familyId) as { cnt: number };

    const openDust = ledgerDb
      .prepare(
        `SELECT COUNT(*) as cnt FROM positions
         WHERE family_id = ? AND status = 'dust'`,
      )
      .get(familyId) as { cnt: number };

    familyExposure.set(familyId, {
      openPositionCount: openPos.cnt - openDust.cnt,
      openDustCount: openDust.cnt,
      activeOrderCount: activeOrd.cnt,
    });

    const exposure = familyExposure.get(familyId)!;
    const tier =
      exposure.openPositionCount === 0 &&
      exposure.openDustCount === 0 &&
      exposure.activeOrderCount === 0
        ? "CLOSED-ONLY"
        : "LIVE-EXPOSURE";
    log(
      "Phase 2",
      `  ${familyId}: ${tier} (open=${exposure.openPositionCount}, dust=${exposure.openDustCount}, orders=${exposure.activeOrderCount})`,
    );
  }

  log("Phase 2", "Safety checks passed.\n");

  if (dryRun) {
    log("DRY-RUN", "Would apply the following fixes (re-run with --fix to commit):\n");
    printPlan(mismatches, affectedFamilyIds, familyExposure);
    ledgerDb.close();
    controlDb.close();
    return;
  }

  // ═══════════ PHASE 3: FIX SETTLEMENTS ════════════════════════════════

  log("Phase 3", "Fixing settlement_ledger and positions...");

  const updateSettlement = ledgerDb.prepare(
    `UPDATE settlement_ledger
     SET resolution = ?, settlement_price = ?, delta = ?
     WHERE settlement_id = ?`,
  );

  const updatePositionPnl = ledgerDb.prepare(
    `UPDATE positions
     SET realized_pnl = realized_pnl + ?, updated_at = datetime('now')
     WHERE position_id = ?`,
  );

  const fixSettlements = ledgerDb.transaction(() => {
    let fixed = 0;
    for (const m of mismatches) {
      // Both winner and loser rows in the same condition get the winner's outcome label
      updateSettlement.run(
        m.actualWinnerOutcome,
        m.correctPrice,
        m.correctDelta,
        m.settlement.settlement_id,
      );

      updatePositionPnl.run(m.pnlDiff, m.settlement.position_id);

      log(
        "Phase 3",
        `  Fixed ${m.settlement.settlement_id}: price ${m.settlement.settlement_price}->${m.correctPrice}, ` +
          `delta ${m.settlement.delta.toFixed(4)}->${m.correctDelta.toFixed(4)}, pnl_diff=${m.pnlDiff.toFixed(4)}`,
      );
      fixed++;
    }
    return fixed;
  });

  const fixedCount = fixSettlements();
  log("Phase 3", `Fixed ${fixedCount} settlement rows.\n`);

  // ═══════════ PHASE 4: RESET DERIVED STATE ════════════════════════════

  log("Phase 4", "Resetting derived family state...");

  for (const familyId of affectedFamilyIds) {
    const exposure = familyExposure.get(familyId)!;
    const isClosed =
      exposure.openPositionCount === 0 &&
      exposure.openDustCount === 0 &&
      exposure.activeOrderCount === 0;

    if (isClosed) {
      resetClosedFamily(ledgerDb, controlDb, familyId);
    } else {
      resetLiveFamily(ledgerDb, controlDb, familyId);
    }
  }

  log("Phase 4", "Derived state reset complete.\n");

  // ═══════════ PHASE 5: FLAG TRANSITIONS ════════════════════════════════

  log("Phase 5", "Annotating tainted state transitions...");

  for (const familyId of affectedFamilyIds) {
    // Get earliest settlement date for this family from the ledger DB
    const earliest = ledgerDb
      .prepare(`SELECT MIN(settled_at) as min_ts FROM settlement_ledger WHERE family_id = ?`)
      .get(familyId) as { min_ts: string | null };

    if (!earliest.min_ts) {
      log("Phase 5", `  ${familyId}: no settlement rows — skipping`);
      continue;
    }

    // Annotate transitions in control DB using the reason column
    // (state_transitions has no 'notes' column — we append to 'reason')
    const result = controlDb
      .prepare(
        `UPDATE state_transitions
         SET reason = reason || ' [pre-outcome-fix: PnL was incorrect]'
         WHERE entity_type = 'family' AND entity_id = ?
           AND created_at >= ?`,
      )
      .run(familyId, earliest.min_ts);

    log(
      "Phase 5",
      `  ${familyId}: annotated ${result.changes} transition(s) since ${earliest.min_ts}`,
    );
  }

  log("Phase 5", "Transition annotation complete.\n");

  // ═══════════ DONE ═══════════════════════════════════════════════════

  ledgerDb.close();
  controlDb.close();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Repair complete.");
  console.log(`  Settlements fixed: ${fixedCount}`);
  console.log(`  Families reset: ${affectedFamilyIds.length}`);
  console.log("═══════════════════════════════════════════════════════════");
}

// ─── Phase 4 helpers ────────────────────────────────────────────────────

function recomputeFamilyPnl(
  ledgerDb: DatabaseInstance,
  familyId: string,
): { currentTailCost: number; tailAdjustedPnl: number } {
  // Sum realized PnL across all positions
  const pnlResult = ledgerDb
    .prepare(
      `SELECT COALESCE(SUM(realized_pnl), 0) as total_pnl FROM positions WHERE family_id = ?`,
    )
    .get(familyId) as { total_pnl: number };

  // Compute tail cost from open lots on non-closed positions
  const tailResult = ledgerDb
    .prepare(
      `SELECT COALESCE(SUM(l.remaining_size * l.entry_price), 0) as tail_cost
       FROM inventory_lots l
       JOIN positions p ON l.position_id = p.position_id
       WHERE p.family_id = ? AND p.status != 'closed' AND l.remaining_size > 0`,
    )
    .get(familyId) as { tail_cost: number };

  return {
    currentTailCost: tailResult.tail_cost,
    tailAdjustedPnl: pnlResult.total_pnl - tailResult.tail_cost,
  };
}

function resetClosedFamily(
  ledgerDb: DatabaseInstance,
  controlDb: DatabaseInstance,
  familyId: string,
): void {
  const { currentTailCost, tailAdjustedPnl } = recomputeFamilyPnl(ledgerDb, familyId);

  // Ledger: full reset — mode back to active, quarantine cleared
  ledgerDb
    .prepare(
      `UPDATE family_runtime_state
       SET current_tail_cost_usdc = ?,
           tail_adjusted_pnl_live = ?,
           open_value_usdc = 0,
           open_position_count = 0,
           open_dust_count = 0,
           runtime_mode = 'active',
           quarantine_reason = NULL,
           effective_mode = NULL,
           derived_mode_reason = NULL,
           updated_at = datetime('now')
       WHERE family_id = ?`,
    )
    .run(currentTailCost, tailAdjustedPnl, familyId);

  // Control: evidence — promotion back to probe-only, PnL zeroed
  controlDb
    .prepare(
      `UPDATE family_evidence
       SET local_realized_pnl_fifo = 0,
           tail_adjusted_pnl = 0,
           evidence_score = 0,
           promotion_state = 'probe-only',
           scores_updated_at = NULL,
           updated_at = datetime('now')
       WHERE family_id = ?`,
    )
    .run(familyId);

  // Control: deployments — mode back to active
  controlDb
    .prepare(
      `UPDATE family_deployments
       SET operator_mode = 'active',
           updated_at = datetime('now')
       WHERE family_id = ?`,
    )
    .run(familyId);

  // Control: rollups — PnL zeroed
  controlDb
    .prepare(
      `UPDATE family_profile_rollups
       SET realized_pnl = 0,
           tail_adjusted_pnl = 0,
           updated_at = datetime('now')
       WHERE family_id = ?`,
    )
    .run(familyId);

  log(
    "Phase 4",
    `  ${familyId}: CLOSED-ONLY full reset (tail=$${currentTailCost.toFixed(2)}, pnl=$${tailAdjustedPnl.toFixed(2)})`,
  );
}

function resetLiveFamily(
  ledgerDb: DatabaseInstance,
  controlDb: DatabaseInstance,
  familyId: string,
): void {
  const { currentTailCost, tailAdjustedPnl } = recomputeFamilyPnl(ledgerDb, familyId);

  // Ledger: PnL-only — do NOT touch mode/quarantine
  ledgerDb
    .prepare(
      `UPDATE family_runtime_state
       SET current_tail_cost_usdc = ?,
           tail_adjusted_pnl_live = ?,
           updated_at = datetime('now')
       WHERE family_id = ?`,
    )
    .run(currentTailCost, tailAdjustedPnl, familyId);

  // Control: evidence — update PnL fields only, do NOT touch promotion/mode
  controlDb
    .prepare(
      `UPDATE family_evidence
       SET tail_adjusted_pnl = ?,
           updated_at = datetime('now')
       WHERE family_id = ?`,
    )
    .run(tailAdjustedPnl, familyId);

  // Control: rollups — update PnL fields only
  controlDb
    .prepare(
      `UPDATE family_profile_rollups
       SET tail_adjusted_pnl = ?,
           updated_at = datetime('now')
       WHERE family_id = ?`,
    )
    .run(tailAdjustedPnl, familyId);

  log(
    "Phase 4",
    `  ${familyId}: LIVE-EXPOSURE PnL-only reset (tail=$${currentTailCost.toFixed(2)}, pnl=$${tailAdjustedPnl.toFixed(2)})`,
  );
}

// ─── Dry-run plan printer ───────────────────────────────────────────────

function printPlan(
  mismatches: Mismatch[],
  familyIds: string[],
  familyExposure: Map<string, FamilyExposure>,
): void {
  console.log("Phase 3 — Settlement fixes:");
  for (const m of mismatches) {
    console.log(
      `  UPDATE settlement_ledger SET resolution='${m.actualWinnerOutcome}', ` +
        `settlement_price=${m.correctPrice}, delta=${m.correctDelta.toFixed(4)} ` +
        `WHERE settlement_id='${m.settlement.settlement_id}'`,
    );
    console.log(
      `  UPDATE positions SET realized_pnl += ${m.pnlDiff.toFixed(4)} ` +
        `WHERE position_id='${m.settlement.position_id}'`,
    );
  }

  console.log("\nPhase 4 — Derived state resets:");
  for (const familyId of familyIds) {
    const exposure = familyExposure.get(familyId)!;
    const isClosed =
      exposure.openPositionCount === 0 &&
      exposure.openDustCount === 0 &&
      exposure.activeOrderCount === 0;
    console.log(
      `  ${familyId}: ${isClosed ? "CLOSED-ONLY full reset" : "LIVE-EXPOSURE PnL-only reset"}`,
    );
  }

  console.log("\nPhase 5 — State transitions would be annotated for all affected families.");
  console.log();
}

// ─── Entry ──────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Repair failed:", err);
  process.exit(1);
});

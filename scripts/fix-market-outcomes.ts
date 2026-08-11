/**
 * fix-market-outcomes.ts
 *
 * One-off data fix for suspect market rows where every token in a condition
 * has outcome = "NO" — the fingerprint of the bug that forced all non-"YES"
 * outcomes to "NO".
 *
 * Three phases:
 *   1. Diagnose — find conditions where ALL tokens have outcome = "NO"
 *   2. Safety check — skip any condition with live positions or active orders
 *   3. Fix — re-fetch real outcomes from Gamma and update markets.outcome
 *
 * Usage:
 *   npx tsx scripts/fix-market-outcomes.ts --dry-run    (default, read-only)
 *   npx tsx scripts/fix-market-outcomes.ts --fix         (writes to DB)
 *
 * Environment:
 *   LEDGER_PATH — path to ledger DB (default: apps/runtime/data/ledger-live-lite.db)
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = !args.includes("--fix");

const LEDGER_PATH = process.env.LEDGER_PATH ?? "apps/runtime/data/ledger-live-lite.db";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const GAMMA_DELAY_MS = 500;

// ─── Types ───────────────────────────────────────────────────────────────────

interface SuspectCondition {
  condition_id: string;
  token_ids: string; // comma-separated
  slug: string;
}

interface TokenOutcomeMapping {
  tokenId: string;
  outcome: string;
}

// ─── Gamma API ───────────────────────────────────────────────────────────────

async function fetchTokenOutcomes(slug: string): Promise<TokenOutcomeMapping[] | null> {
  const url = `${GAMMA_BASE}/markets/slug/${encodeURIComponent(slug)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 404 || res.status === 422) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const raw = (await res.json()) as Record<string, unknown>;
      if (!raw || typeof raw !== "object") return null;

      const rawTokenIds = raw.clobTokenIds;
      const rawOutcomes = raw.outcomes;
      if (!rawTokenIds || !rawOutcomes) return null;

      const tokenIds: unknown[] =
        typeof rawTokenIds === "string" ? JSON.parse(rawTokenIds) : rawTokenIds;
      const outcomes: unknown[] =
        typeof rawOutcomes === "string" ? JSON.parse(rawOutcomes) : rawOutcomes;

      if (!Array.isArray(tokenIds) || !Array.isArray(outcomes)) return null;
      if (tokenIds.length !== outcomes.length || tokenIds.length === 0) return null;

      return tokenIds.map((id, i) => ({
        tokenId: String(id),
        outcome: String(outcomes[i]),
      }));
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("unreachable");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(phase: string, msg: string): void {
  console.log(`[${phase}] ${msg}`);
}

function sqlPlaceholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  fix-market-outcomes");
  console.log(`  Mode: ${dryRun ? "DRY-RUN (read-only)" : "FIX (writing to DB)"}`);
  console.log(`  Ledger DB: ${resolve(LEDGER_PATH)}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  const db = new Database(LEDGER_PATH, { readonly: dryRun });

  if (!dryRun) {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");

  // ═══════════ PHASE 1: DIAGNOSE ═══════════════════════════════════════════

  log("Phase 1", "Scanning for conditions where every token has outcome = 'NO'...");

  // A condition is suspect when ALL its tokens share outcome = "NO"
  // (binary markets always have one "Yes" and one "No" — if both are "NO" the bug hit)
  const suspects = db
    .prepare(
      `
      SELECT condition_id,
             GROUP_CONCAT(token_id) AS token_ids,
             slug
      FROM markets
      GROUP BY condition_id
      HAVING COUNT(DISTINCT outcome) = 1
         AND MAX(outcome) = 'NO'
         AND COUNT(*) >= 2
    `,
    )
    .all() as SuspectCondition[];

  if (suspects.length === 0) {
    log("Phase 1", "No suspect conditions found. Nothing to fix.");
    db.close();
    return;
  }

  log("Phase 1", `Found ${suspects.length} suspect condition(s):\n`);
  for (const s of suspects) {
    const tokenList = s.token_ids.split(",");
    console.log(
      `  ${s.condition_id.substring(0, 24)}... | ${tokenList.length} tokens | slug=${s.slug}`,
    );
  }
  console.log();

  // ═══════════ PHASE 2: SAFETY CHECK ═══════════════════════════════════════

  log("Phase 2", "Checking for live exposure on each condition...");

  const passing: SuspectCondition[] = [];

  for (const suspect of suspects) {
    const tokenIds = suspect.token_ids.split(",");
    const placeholders = sqlPlaceholders(tokenIds.length);

    const openPositions = db
      .prepare(
        `SELECT COUNT(*) as c FROM positions
         WHERE token_id IN (${placeholders}) AND status IN ('open', 'dust')`,
      )
      .get(...tokenIds) as { c: number };

    const activeOrders = db
      .prepare(
        `SELECT COUNT(*) as c FROM orders
         WHERE token_id IN (${placeholders}) AND status IN ('pending', 'open', 'partially_filled')`,
      )
      .get(...tokenIds) as { c: number };

    if (openPositions.c > 0 || activeOrders.c > 0) {
      log(
        "Phase 2",
        `  SKIP ${suspect.condition_id.substring(0, 24)}... — ` +
          `positions=${openPositions.c} orders=${activeOrders.c} (live exposure)`,
      );
      continue;
    }

    log("Phase 2", `  OK   ${suspect.condition_id.substring(0, 24)}... — no live exposure`);
    passing.push(suspect);
  }

  if (passing.length === 0) {
    log("Phase 2", "\nAll suspect conditions have live exposure. Nothing to fix.");
    db.close();
    return;
  }

  log("Phase 2", `\n${passing.length} condition(s) cleared for repair.\n`);

  // ═══════════ PHASE 3: FETCH FROM GAMMA + FIX ════════════════════════════

  log("Phase 3", "Fetching real outcomes from Gamma...\n");

  interface Fix {
    tokenId: string;
    oldOutcome: string;
    newOutcome: string;
    conditionId: string;
  }

  const fixes: Fix[] = [];

  for (const suspect of passing) {
    const tokenIds = suspect.token_ids.split(",");

    const mappings = await fetchTokenOutcomes(suspect.slug);

    if (!mappings) {
      log(
        "Phase 3",
        `  SKIP ${suspect.condition_id.substring(0, 24)}... — Gamma returned no data for slug=${suspect.slug}`,
      );
      await new Promise((r) => setTimeout(r, GAMMA_DELAY_MS));
      continue;
    }

    // Build a lookup: tokenId → outcome
    const gammaMap = new Map<string, string>(mappings.map((m) => [m.tokenId, m.outcome]));

    let allMapped = true;
    for (const tokenId of tokenIds) {
      if (!gammaMap.has(tokenId)) {
        log(
          "Phase 3",
          `  WARN ${suspect.condition_id.substring(0, 24)}... — token ${tokenId.substring(0, 20)}... not in Gamma response; skipping condition`,
        );
        allMapped = false;
        break;
      }
    }

    if (!allMapped) {
      await new Promise((r) => setTimeout(r, GAMMA_DELAY_MS));
      continue;
    }

    for (const tokenId of tokenIds) {
      const newOutcome = gammaMap.get(tokenId)!;
      fixes.push({ tokenId, oldOutcome: "NO", newOutcome, conditionId: suspect.condition_id });
    }

    const pairs = tokenIds.map((id) => `${id.substring(0, 16)}...→${gammaMap.get(id)}`).join(", ");
    log("Phase 3", `  ${suspect.condition_id.substring(0, 24)}...: ${pairs}`);

    await new Promise((r) => setTimeout(r, GAMMA_DELAY_MS));
  }

  console.log();

  if (fixes.length === 0) {
    log("Phase 3", "No fixes to apply.");
    db.close();
    return;
  }

  // Print plan
  console.log(`Planned updates (${fixes.length} rows):\n`);
  for (const f of fixes) {
    console.log(
      `  UPDATE markets SET outcome = '${f.newOutcome}' WHERE token_id = '${f.tokenId.substring(0, 20)}...'` +
        `  -- was: '${f.oldOutcome}'`,
    );
  }
  console.log();

  if (dryRun) {
    log("DRY-RUN", "Re-run with --fix to apply these changes.");
    db.close();
    return;
  }

  // Apply fixes in a single transaction
  const updateOutcome = db.prepare(
    `UPDATE markets SET outcome = ?, updated_at = ? WHERE token_id = ?`,
  );

  const applyFixes = db.transaction(() => {
    let updated = 0;
    for (const f of fixes) {
      const result = updateOutcome.run(f.newOutcome, new Date().toISOString(), f.tokenId);
      if (result.changes === 1) {
        updated++;
      } else {
        log("Phase 3", `  WARN: no row updated for token_id=${f.tokenId}`);
      }
    }
    return updated;
  });

  const updatedCount = applyFixes();

  db.close();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Fix complete.");
  console.log(`  Markets updated: ${updatedCount}/${fixes.length}`);
  console.log("═══════════════════════════════════════════════════════════");
}

// ─── Entry ───────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Fix failed:", err);
  process.exit(1);
});

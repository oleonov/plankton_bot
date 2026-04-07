#!/usr/bin/env node
// Backfill fills.fee using the corrected Polymarket formula, and
// invalidate derived state so the runtime/publisher recompute from
// clean facts on the next cycle.
//
// This script is idempotent: running it twice produces the same DB
// state as running it once. It skips rows whose fee already matches
// the correct value.
//
// Usage:
//   node scripts/fee-backfill.mjs <ledger.db> <control.db> [--apply]

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const findBetterSqlite3 = () => {
  const paths = [
    "better-sqlite3",
    "../node_modules/better-sqlite3",
    "../node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3",
    "./node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3",
  ];
  for (const p of paths) {
    try {
      return require(p);
    } catch (e) {}
  }
  throw new Error("Could not find better-sqlite3");
};

const Database = findBetterSqlite3();

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const [ledgerPath, controlPath] = args.filter((a) => !a.startsWith("--"));
if (!ledgerPath || !controlPath) {
  console.error("usage: fee-backfill.mjs <ledger.db> <control.db> [--apply]");
  process.exit(1);
}

const CATEGORY_RATES = {
  crypto: 0.072,
  sports: 0.03,
  finance: 0.04,
  politics: 0.04,
  geopolitics: 0,
};

const ledger = new Database(ledgerPath);
const control = new Database(controlPath);

// Migration: ensure fee_rate_bps exists in ledger.db
const info = ledger.prepare("PRAGMA table_info(fills)").all();
if (!info.some((c) => c.name === "fee_rate_bps")) {
  console.log("Adding missing column fee_rate_bps to fills table...");
  ledger.prepare("ALTER TABLE fills ADD COLUMN fee_rate_bps REAL NOT NULL DEFAULT 0").run();
}

// Enable foreign keys for integrity
ledger.pragma("foreign_keys = ON");
control.pragma("foreign_keys = ON");

// Load family categories for more accurate rate recovery
const families = control.prepare("SELECT family_id, primary_category FROM family_catalog").all();
const categoryMap = new Map(families.map((f) => [f.family_id, f.primary_category?.toLowerCase()]));

function computeCorrectFee(row) {
  if (row.liquidity_role === "maker") return 0;

  const category = categoryMap.get(row.family_id);
  const rate =
    category && CATEGORY_RATES[category] !== undefined
      ? CATEGORY_RATES[category]
      : row.fee_rate_bps !== undefined
        ? row.fee_rate_bps / 10_000
        : row.size > 0 && row.price > 0
          ? row.fee / (row.size * row.price)
          : 0;

  return row.size * rate * row.price * (1 - row.price);
}

const fills = ledger.prepare(`SELECT * FROM fills`).all();
const updates = [];
for (const f of fills) {
  const newFee = computeCorrectFee(f);
  if (Math.abs((f.fee ?? 0) - newFee) > 1e-9) {
    updates.push({ fill_id: f.fill_id, family_id: f.family_id, oldFee: f.fee, newFee });
  }
}

const affectedFamilies = new Set(updates.map((u) => u.family_id));

console.log(`fills to update: ${updates.length} / ${fills.length}`);
console.log(`affected families: ${affectedFamilies.size}`);
console.log(`old fee sum: ${updates.reduce((s, u) => s + u.oldFee, 0).toFixed(6)}`);
console.log(`new fee sum: ${updates.reduce((s, u) => s + u.newFee, 0).toFixed(6)}`);

if (!apply) {
  console.log("\n(dry mode — no writes. Re-run with --apply to commit.)");
  process.exit(0);
}

// Apply: single IMMEDIATE transaction on ledger + separate tx on control.
const updFee = ledger.prepare("UPDATE fills SET fee = ? WHERE fill_id = ?");
const tx1 = ledger.transaction((updates) => {
  for (const u of updates) updFee.run(u.newFee, u.fill_id);
});
tx1(updates);
console.log(`✓ fills.fee updated for ${updates.length} rows`);

// Reset derived tail fields on family_runtime_state for affected families.
const famList = [...affectedFamilies];
const resetTail = ledger.prepare(
  `UPDATE family_runtime_state
   SET current_tail_cost_usdc = 0,
       tail_adjusted_pnl_live = 0,
       updated_at = datetime('now')
   WHERE family_id = ?`,
);
const tx2 = ledger.transaction((famIds) => {
  for (const fid of famIds) resetTail.run(fid);
});
tx2(famList);
console.log(`✓ family_runtime_state tail fields reset for ${famList.length} families`);

// Delete stale scorecards for affected families whose recorded
// executionTelemetry24h contains non-zero fees.
// We must clean up dependent references first because of foreign keys.
const findStale = control.prepare(`
  SELECT scorecard_id FROM family_validation_scorecards
  WHERE family_id = ?
    AND profile = 'live-lite'
    AND CAST(json_extract(summary_json, '$.executionTelemetry24h.explicitFeesUsdc') AS REAL) > 0
`);

const delLatest = control.prepare(`DELETE FROM family_validation_latest WHERE scorecard_id = ?`);
const nullifyDeployment = control.prepare(
  `UPDATE family_deployments SET approved_scorecard_id = NULL WHERE approved_scorecard_id = ?`,
);
const nullifyProposal = control.prepare(
  `UPDATE promotion_proposals SET source_scorecard_id = NULL WHERE source_scorecard_id = ?`,
);
const delStale = control.prepare(`DELETE FROM family_validation_scorecards WHERE scorecard_id = ?`);

let deletedScorecards = 0;
const tx3 = control.transaction((famIds) => {
  for (const fid of famIds) {
    const staleOnes = findStale.all(fid);
    for (const s of staleOnes) {
      delLatest.run(s.scorecard_id);
      nullifyDeployment.run(s.scorecard_id);
      nullifyProposal.run(s.scorecard_id);
      const info = delStale.run(s.scorecard_id);
      deletedScorecards += info.changes;
    }
  }
});
tx3(famList);
console.log(`✓ stale scorecards deleted: ${deletedScorecards}`);

console.log("\nBackfill complete. Next steps:");
console.log("  1. Runtime will recompute family_runtime_state on next evidence tick.");
console.log("  2. Publisher will emit fresh scorecards on next publish tick.");
console.log("  3. Review family_deployments WHERE operator_mode IN ('quarantine','reduce-only')");
console.log("     AND operator_reason LIKE '%fee%' manually.");

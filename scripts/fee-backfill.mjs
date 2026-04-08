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
//
// Without --apply, the script prints what it WOULD change and exits.
// With --apply, the script runs in a single IMMEDIATE transaction;
// on any error the whole change rolls back.

import Database from "better-sqlite3";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const [ledgerPath, controlPath] = args.filter((a) => !a.startsWith("--"));
if (!ledgerPath || !controlPath) {
  console.error("usage: fee-backfill.mjs <ledger.db> <control.db> [--apply]");
  process.exit(1);
}

function computeCorrectFee(row) {
  if (row.liquidity_role === "maker") return 0;
  const oldRate = row.size > 0 && row.price > 0 ? row.fee / (row.size * row.price) : 0;
  const newFee = row.size * oldRate * row.price * (1 - row.price);
  return newFee;
}

const ledger = new Database(ledgerPath);
const control = new Database(controlPath);

const fills = ledger.prepare(`SELECT * FROM fills`).all();
const updates = [];
let oldFeeSum = 0;
let newFeeSum = 0;

for (const f of fills) {
  const newFee = computeCorrectFee(f);
  if (Math.abs((f.fee ?? 0) - newFee) > 1e-9) {
    updates.push({ fill_id: f.fill_id, family_id: f.family_id, oldFee: f.fee, newFee, role: f.liquidity_role });
    oldFeeSum += f.fee ?? 0;
    newFeeSum += newFee;
  }
}

const affectedFamilies = new Set(updates.map((u) => u.family_id));

console.log(`fills to update: ${updates.length} / ${fills.length}`);
console.log(`affected families: ${affectedFamilies.size}`);
console.log(`old fee sum: ${oldFeeSum.toFixed(6)}`);
console.log(`new fee sum: ${newFeeSum.toFixed(6)}`);

if (updates.length > 0) {
    const takerExample = updates.find(u => u.role === "taker");
    if (takerExample) {
        console.log("Example taker update:", takerExample);
    } else {
        console.log("No taker updates in the list.");
    }
}

if (!apply) {
  console.log("\n(dry mode — no writes. Re-run with --apply to commit.)");
  process.exit(0);
}

// Apply: single IMMEDIATE transaction on ledger + separate tx on control.
// We accept the tiny risk of partial failure (ledger updated but control
// not yet invalidated) because control invalidation is idempotent and can
// be re-run.

const updFee = ledger.prepare("UPDATE fills SET fee = ? WHERE fill_id = ?");
const tx1 = ledger.transaction((updates) => {
  for (const u of updates) updFee.run(u.newFee, u.fill_id);
});
tx1(updates);
console.log(`✓ fills.fee updated for ${updates.length} rows`);

// Reset derived tail fields on family_runtime_state for affected families.
// The runtime's next evidence-engine tick will recompute these from the
// corrected fills + open-lot snapshot.
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
// executionTelemetry24h contains non-zero fees. The publisher will
// regenerate fresh scorecards on its next tick with clean data.
const delStale = control.prepare(
  `DELETE FROM family_validation_scorecards
   WHERE family_id = ?
     AND profile = 'live-lite'
     AND CAST(json_extract(summary_json, '$.executionTelemetry24h.explicitFeesUsdc') AS REAL) > 0`,
);
let deletedScorecards = 0;
const tx3 = control.transaction((famIds) => {
  for (const fid of famIds) {
    const info = delStale.run(fid);
    deletedScorecards += info.changes;
  }
});
tx3(famList);
console.log(`✓ stale scorecards deleted: ${deletedScorecards}`);

console.log("\nBackfill complete. Next steps:");
console.log("  1. Runtime will recompute family_runtime_state on next evidence tick.");
console.log("  2. Publisher will emit fresh scorecards on next publish tick.");
console.log("  3. Review family_deployments WHERE operator_mode IN ('quarantine','reduce-only')");
console.log("     AND operator_reason LIKE '%fee%' manually — decide case-by-case whether");
console.log("     to unquarantine (operator action, NOT automated).");

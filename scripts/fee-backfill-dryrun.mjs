#!/usr/bin/env node
/**
 * Read-only dry-run scope report for fee backfill.
 * Analyzes what would change in ledger.db and control.db before any writes.
 *
 * Usage:
 *   node scripts/fee-backfill-dryrun.mjs <ledger.db> <control.db>
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const findBetterSqlite3 = () => {
  const paths = [
    "better-sqlite3",
    "../node_modules/better-sqlite3",
    "../node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3",
  ];
  for (const p of paths) {
    try {
      return require(p);
    } catch (e) {}
  }
  throw new Error("Could not find better-sqlite3");
};

const Database = findBetterSqlite3();

const [ledgerPath, controlPath] = process.argv.slice(2);
if (!ledgerPath || !controlPath) {
  console.error("usage: fee-backfill-dryrun.mjs <ledger.db> <control.db>");
  process.exit(1);
}

function computeCorrectFee(row) {
  if (row.liquidity_role === "maker") return 0;
  // Use price and size from row. Old rate is derived from recorded fee.
  const oldRate = row.size > 0 && row.price > 0 ? row.fee / (row.size * row.price) : 0;
  return row.size * oldRate * row.price * (1 - row.price);
}

const ledger = new Database(ledgerPath, { readonly: true });
const control = new Database(controlPath, { readonly: true });

const fills = ledger.prepare("SELECT * FROM fills").all();
const total = fills.length;
let changed = 0;
let oldFeeSum = 0;
let newFeeSum = 0;

const familyStats = new Map();

for (const f of fills) {
  const newFee = computeCorrectFee(f);
  oldFeeSum += f.fee ?? 0;
  newFeeSum += newFee;
  if (Math.abs((f.fee ?? 0) - newFee) > 1e-9) {
    changed++;
    const key = f.family_id;
    const b = familyStats.get(key) ?? { rows: 0, oldFee: 0, newFee: 0 };
    b.rows++;
    b.oldFee += f.fee ?? 0;
    b.newFee += newFee;
    familyStats.set(key, b);
  }
}

const affectedFamilies = [...familyStats.keys()].sort();

// Families whose family_validation_scorecards currently have non-zero fees
const bloatedScorecards = control.prepare(`
  SELECT family_id, COUNT(*) n,
         MAX(CAST(json_extract(summary_json, '$.executionTelemetry24h.explicitFeesUsdc') AS REAL)) AS max_fees,
         MAX(CAST(json_extract(summary_json, '$.executionTelemetry24h.volumeUsdc') AS REAL)) AS max_volume
  FROM family_validation_scorecards
  WHERE profile = 'live-lite'
    AND json_extract(summary_json, '$.executionTelemetry24h.explicitFeesUsdc') > 0
  GROUP BY family_id
  ORDER BY max_fees DESC
`).all();

// Canary-driven demotions (fee/leakage reasons)
const demotions = control.prepare(`
  SELECT family_id, profile, operator_mode, strategy_stage, operator_reason, updated_at
  FROM family_deployments
  WHERE profile = 'live-lite'
    AND enabled = 1
    AND operator_mode IN ('quarantine', 'reduce-only')
    AND (operator_reason LIKE '%fee%' OR operator_reason LIKE '%canary%' OR operator_reason LIKE '%leakage%')
  ORDER BY updated_at DESC
`).all();

// Report (markdown)
const out = [];
out.push(`# Fee Backfill Dry-Run Report`);
out.push(`Generated: ${new Date().toISOString()}`);
out.push(``);
out.push(`## Fills scope`);
out.push(`- Total fills in ledger: **${total}**`);
out.push(`- Fills that would change: **${changed}** (${((changed / total) * 100).toFixed(1)}%)`);
out.push(`- Old fee total: **${oldFeeSum.toFixed(6)} USDC**`);
out.push(`- New fee total: **${newFeeSum.toFixed(6)} USDC**`);
out.push(`- Delta (old − new): **${(oldFeeSum - newFeeSum).toFixed(6)} USDC** (${(((oldFeeSum - newFeeSum) / oldFeeSum) * 100).toFixed(1)}% reduction)`);
out.push(``);
out.push(`## Families with changed fills`);
out.push(`| family_id | rows | old_fee | new_fee | delta |`);
out.push(`|---|---:|---:|---:|---:|`);
for (const fam of affectedFamilies) {
  const b = familyStats.get(fam);
  out.push(`| \`${fam}\` | ${b.rows} | ${b.oldFee.toFixed(6)} | ${b.newFee.toFixed(6)} | ${(b.oldFee - b.newFee).toFixed(6)} |`);
}
out.push(``);
out.push(`## Scorecards with non-zero explicitFeesUsdc (live-lite)`);
out.push(`| family_id | n scorecards | max fees | max volume |`);
out.push(`|---|---:|---:|---:|`);
for (const s of bloatedScorecards) {
  out.push(`| \`${s.family_id}\` | ${s.n} | ${(s.max_fees ?? 0).toFixed(6)} | ${(s.max_volume ?? 0).toFixed(6)} |`);
}
out.push(``);
out.push(`## Demotions referencing fees/canary/leakage (live-lite, currently active)`);
out.push(`| family_id | mode | stage | reason | updated_at |`);
out.push(`|---|---|---|---|---|`);
for (const d of demotions) {
  out.push(`| \`${d.family_id}\` | ${d.operator_mode} | ${d.strategy_stage} | ${(d.operator_reason ?? "").replace(/\|/g, " ")} | ${d.updated_at} |`);
}
out.push(``);
out.push(`## Sanity guardrails`);
out.push(`- If \`Fills that would change\` is 0, the backfill is a no-op — stop.`);
out.push(`- If \`Fills that would change\` exceeds \`Total fills\`, the script has a bug — stop.`);
out.push(`- If \`new fee total\` is **larger** than old, the formula is backwards — stop.`);
out.push(`- If any family in "Families with changed fills" has \`delta\` negative, investigate before running the backfill.`);

console.log(out.join("\n"));

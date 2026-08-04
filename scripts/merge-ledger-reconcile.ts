/**
 * Operator reconciliation for stuck `merge_ledger` rows.
 *
 * WHY THIS EXISTS: InventoryManagerModule fences a condition_id from further inventory merges for
 * as long as `merge_ledger` holds a row whose status != 'applied' (see
 * apps/runtime/src/modules/inventory-auto-merge/inventory-manager-module.ts). That fence is
 * durable BY DESIGN: no code path can tell "the on-chain merge never landed" apart from "it landed
 * but we missed the receipt", and guessing wrong in either direction risks merging the same
 * inventory twice (real, unrecoverable money loss). Only an operator who has checked the chain can
 * break that tie, and this script is the supported way to record that decision instead of
 * hand-rolled SQL against prod.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO: apply a merge. Applying one means consuming FIFO lots
 * on both legs, booking the spread P&L, updating both positions and flipping the ledger row — all
 * in ONE transaction (MergeSettler.applyMerge). A CLI that only flipped `status` to 'applied' would
 * lift the fence while both legs stayed open, and the very next sweep could merge the same
 * inventory a second time. So the operator's decision is recorded as a STATUS, and the runtime does
 * the money part: an 'onchain' row is settled locally by InventoryManagerModule on its next start.
 *
 * Usage:
 *   npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db>
 *     List every non-terminal row (status != 'applied'). Read-only, no --apply needed.
 *
 *   npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db> --mark-onchain <mergeId> --apply
 *     Record that you verified ON-CHAIN that this merge really landed. The row moves
 *     'pending' -> 'onchain'; it stays fenced until the runtime settles it locally on its next
 *     start, which consumes the lots and books the P&L atomically. Restart the runtime afterwards.
 *
 *   npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db> --discard <mergeId> --apply
 *     Delete the row because you verified ON-CHAIN that the merge did NOT go through. Only a
 *     'pending' row can be discarded — an 'onchain' row is a merge that provably landed, and
 *     deleting it would drop the only local record of it.
 *
 * Omit --apply on a write to see what WOULD happen without touching the database (the
 * default-to-dry-run convention used across this repo's operator scripts).
 *
 * Both writes are compare-and-swap against the status this command actually READ. If the runtime
 * moves the row in between, the write matches zero rows and the command aborts instead of
 * overwriting a decision made by a process that knows more than it does.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseType } from "better-sqlite3";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const Database = require("better-sqlite3") as typeof import("better-sqlite3").default;

export type MergeLedgerStatus = "pending" | "onchain" | "applied";

export interface MergeLedgerRow {
  merge_id: string;
  condition_id: string;
  merged_amount: number;
  spread_pnl: number;
  merged_at: string;
  created_at: string;
  status: MergeLedgerStatus;
}

type Action = "help" | "list" | "mark-onchain" | "discard";

interface Args {
  dbPath: string;
  action: Action;
  mergeId: string | null;
  apply: boolean;
}

const HELP = `Usage:
  npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db>
      List every merge_ledger row with status != 'applied' (read-only, no --apply needed).

  npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db> --mark-onchain <mergeId> --apply
      Record that the merge PROVABLY landed on chain: 'pending' -> 'onchain'. The fence stays up
      until the runtime settles the row locally (lots consumed, P&L booked, positions updated) on
      its next start — restart the runtime after this command.

  npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db> --discard <mergeId> --apply
      Delete the row because the merge provably did NOT land. Only a 'pending' row may be
      discarded; an 'onchain' row is refused because it names a merge that already happened.

Flags:
  --db <path>          Ledger SQLite DB path (or set LEDGER_PATH env var).
  --mark-onchain <id>  Promote merge_id <id> to 'onchain'. Requires --apply to actually write.
  --discard <id>       Delete merge_ledger row <id>. Requires --apply to actually write.
  --apply              Confirms a write. Without it, prints what would happen and exits without
                       touching the database (dry-run is the default).
  --help, -h           Print this help.

Run this with the runtime STOPPED. Writes are compare-and-swap on the status read a moment
earlier, so a concurrent runtime cannot be silently overwritten — the command aborts instead.
`;

export function parseArgs(raw: string[]): Args {
  if (raw.includes("--help") || raw.includes("-h")) {
    return { dbPath: "", action: "help", mergeId: null, apply: false };
  }

  const value = (name: string): string | null => {
    const index = raw.indexOf(name);
    return index >= 0 ? (raw[index + 1] ?? null) : null;
  };

  const dbPath = value("--db") ?? process.env.LEDGER_PATH ?? null;
  const markId = value("--mark-onchain");
  const discardId = value("--discard");
  const apply = raw.includes("--apply");

  if (!dbPath) {
    throw new Error("required: --db <ledger.db> (or set LEDGER_PATH)");
  }
  if (markId != null && discardId != null) {
    throw new Error("--mark-onchain and --discard are mutually exclusive");
  }

  if (markId != null) {
    return { dbPath, action: "mark-onchain", mergeId: markId, apply };
  }
  if (discardId != null) {
    return { dbPath, action: "discard", mergeId: discardId, apply };
  }
  return { dbPath, action: "list", mergeId: null, apply };
}

export function listNonTerminal(db: DatabaseType): MergeLedgerRow[] {
  return db
    .prepare(
      `SELECT merge_id, condition_id, merged_amount, spread_pnl, merged_at, created_at, status
       FROM merge_ledger WHERE status != 'applied' ORDER BY created_at`,
    )
    .all() as MergeLedgerRow[];
}

export function findRow(db: DatabaseType, mergeId: string): MergeLedgerRow | undefined {
  return db
    .prepare(
      `SELECT merge_id, condition_id, merged_amount, spread_pnl, merged_at, created_at, status
       FROM merge_ledger WHERE merge_id = ?`,
    )
    .get(mergeId) as MergeLedgerRow | undefined;
}

/**
 * Every write here is a compare-and-swap against `expectedStatus` — the status this command read
 * moments earlier. Zero rows changed does not mean "mistyped id"; it means the row is no longer in
 * the state the operator's decision was based on, because a live runtime moved it. Failing loud is
 * the point: the alternative is a CLI that deletes a row the runtime just proved landed on chain.
 */
function assertClaimHeld(
  changes: number,
  mergeId: string,
  expectedStatus: MergeLedgerStatus,
  op: "mark-onchain" | "discard",
): void {
  if (changes !== 1) {
    throw new Error(
      `refused to ${op} mergeId=${mergeId}: expected exactly 1 row still at status='${expectedStatus}', ` +
        `matched ${changes}. The row changed under this command — stop the runtime, re-run the ` +
        `list, and decide again.`,
    );
  }
}

export function markRowOnchain(
  db: DatabaseType,
  mergeId: string,
  expectedStatus: MergeLedgerStatus,
): void {
  const { changes } = db
    .prepare(`UPDATE merge_ledger SET status = 'onchain' WHERE merge_id = ? AND status = ?`)
    .run(mergeId, expectedStatus);
  assertClaimHeld(changes, mergeId, expectedStatus, "mark-onchain");
}

export function discardRow(
  db: DatabaseType,
  mergeId: string,
  expectedStatus: MergeLedgerStatus,
): void {
  const { changes } = db
    .prepare(`DELETE FROM merge_ledger WHERE merge_id = ? AND status = ?`)
    .run(mergeId, expectedStatus);
  assertClaimHeld(changes, mergeId, expectedStatus, "discard");
}

const ZONELESS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * SQLite's `datetime('now')` — the column default for `merge_ledger.created_at` — writes UTC with
 * NO zone designator, and `Date.parse` reads a zone-less timestamp as LOCAL time. On a UTC+7 host
 * a row written one second ago would print as seven hours old, and row age is precisely the number
 * an operator uses to judge whether a merge is stuck. Rows written by the runtime already carry an
 * explicit `Z`, so only add one where the string has no zone of its own.
 */
export function parseLedgerTimestamp(raw: string): number {
  return Date.parse(ZONELESS_TIMESTAMP.test(raw) ? `${raw.replace(" ", "T")}Z` : raw);
}

export function ageSeconds(createdAt: string, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - parseLedgerTimestamp(createdAt)) / 1000));
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

function runList(db: DatabaseType): number {
  const rows = listNonTerminal(db);
  if (rows.length === 0) {
    console.log("No non-terminal merge_ledger rows found (every merge is 'applied').");
    return 0;
  }
  const now = Date.now();
  const withAge = rows.map((row) => {
    const seconds = ageSeconds(row.created_at, now);
    return { ...row, age_seconds: seconds, age: formatAge(seconds) };
  });
  console.log(JSON.stringify(withAge, null, 2));
  return 0;
}

/**
 * Both writes are only legal from 'pending'. 'applied' is terminal, and 'onchain' already carries
 * the operator's "it landed" decision — the remaining work on it belongs to the runtime, which
 * settles it atomically, not to a CLI that can only touch one column.
 */
function rejectIllegalTransition(
  row: MergeLedgerRow,
  action: "mark-onchain" | "discard",
): string | null {
  if (row.status === "applied") {
    return `mergeId=${row.merge_id} is already 'applied' — nothing to reconcile`;
  }
  if (row.status === "onchain") {
    return action === "mark-onchain"
      ? `mergeId=${row.merge_id} is already 'onchain' — start the runtime and it will settle the ` +
          `row locally (consume lots, book P&L, lift the fence)`
      : `refusing to discard mergeId=${row.merge_id}: status='onchain' means this merge PROVABLY ` +
          `landed on chain. Deleting it would erase the only local record of it and let the next ` +
          `sweep merge the same inventory twice. Start the runtime instead — it settles the row.`;
  }
  return null;
}

function runWrite(
  db: DatabaseType,
  action: "mark-onchain" | "discard",
  mergeId: string,
  apply: boolean,
): number {
  const row = findRow(db, mergeId);
  if (!row) {
    console.error(`no merge_ledger row for mergeId=${mergeId}`);
    return 1;
  }
  console.log(JSON.stringify(row, null, 2));

  const rejection = rejectIllegalTransition(row, action);
  if (rejection) {
    console.error(rejection);
    return 1;
  }

  if (!apply) {
    const verb =
      action === "mark-onchain" ? "promote it to 'onchain'" : "delete this 'pending' row";
    console.log(`DRY RUN: would ${verb}. Re-run with --apply to commit. No changes made.`);
    return 0;
  }

  if (action === "mark-onchain") {
    markRowOnchain(db, mergeId, row.status);
    console.log(
      `mergeId=${mergeId} -> status='onchain'. The fence stays up on condition_id=` +
        `${row.condition_id} until the runtime settles it: restart the runtime, which consumes the ` +
        `lots, books the spread P&L and marks the row 'applied' in one transaction.`,
    );
  } else {
    discardRow(db, mergeId, row.status);
    console.log(
      `discarded mergeId=${mergeId}. Fence lifted; the next auto-merge sweep will retry this ` +
        `merge from scratch.`,
    );
  }
  return 0;
}

export function run(args: Args): number {
  if (args.action === "help") {
    console.log(HELP);
    return 0;
  }

  // Dry-run keeps the connection read-only so a bug in the "would do X" branch can never write.
  const writable = args.action !== "list" && args.apply;
  const db = new Database(args.dbPath, { readonly: !writable });
  try {
    if (args.action === "list") {
      return runList(db);
    }
    return runWrite(db, args.action, args.mergeId as string, args.apply);
  } finally {
    db.close();
  }
}

const isMainModule = process.argv[1] != null && process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  process.exit(run(parseArgs(process.argv.slice(2))));
}

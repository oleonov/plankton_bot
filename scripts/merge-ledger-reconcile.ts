/**
 * Operator reconciliation for non-terminal merge intents.
 *
 * The runtime persists both exact token/position identities before submitting a merge. Recovery
 * and this CLI use only those immutable recorded identities; the mutable markets catalog is never
 * consulted. `--mark-onchain` records an operator's on-chain confirmation and leaves settlement to
 * the runtime. `--discard --fenced` is allowed only when an exact recorded leg is now missing or
 * closed and no live lots for its recorded token remain. All writes require a stopped runtime and
 * use compare-and-swap; omitting `--apply` is always a dry run.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  evaluateRecordedMergeLegs,
  invalidRecordedMergeIdentity,
  parseInstantMs,
} from "@krabs/domain";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

export type MergeLedgerStatus = "pending" | "onchain" | "applied";

export interface MergeLedgerRow {
  merge_id: string;
  condition_id: string;
  merged_amount: number;
  spread_pnl: number;
  merged_at: string;
  created_at: string;
  status: MergeLedgerStatus;
  yes_token_id: string | null;
  no_token_id: string | null;
  yes_position_id: string | null;
  no_position_id: string | null;
}

type Action = "help" | "list" | "mark-onchain" | "discard";

interface Args {
  dbPath: string;
  action: Action;
  mergeId: string | null;
  apply: boolean;
  fenced: boolean;
}

const HELP = `Usage:
  npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db>
      List every non-terminal row, including its exact recorded token and position identities.

  npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db> --mark-onchain <mergeId> --apply
      Record an operator-confirmed on-chain merge: 'pending' -> 'onchain'. The runtime then settles
      the exact recorded legs locally. Rows without complete recorded identities are refused.

  npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db> --discard <mergeId> --apply
      Delete the row because the merge provably did NOT land. Only a 'pending' row may be
      discarded; an 'onchain' row needs the bounded --fenced proof below.

  npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db> --discard <mergeId> --fenced --apply
      Delete a confirmed on-chain row only when one exact recorded leg is missing/closed and there
      are no live lots anywhere for its recorded token. Catalog remaps cannot change this proof.
      Missing identity, token mismatch, malformed timestamps, newer lots, or recoverable exact legs
      are refused. Reconcile wallet balances before resuming after any fenced discard.

Flags:
  --db <path>          Ledger SQLite DB path (or set LEDGER_PATH env var).
  --mark-onchain <id>  Promote merge_id <id> to 'onchain'. Requires --apply to actually write.
  --discard <id>       Delete merge_ledger row <id>. Requires --apply to actually write.
  --fenced             Acknowledge that an 'onchain' row was fenced by boot recovery.
                       Only legal with --discard and only honoured after exact-identity proof.
  --apply              Confirms a write. Without it, prints what would happen and exits without
                       touching the database (dry-run is the default).
  --help, -h           Print this help.

Run this with the runtime STOPPED. The command cannot verify runtime liveness. Fenced proof and
delete share one BEGIN IMMEDIATE transaction; all writes also compare the status that was read.
`;

const KNOWN_FLAGS = new Set([
  "--help",
  "-h",
  "--db",
  "--mark-onchain",
  "--discard",
  "--fenced",
  "--apply",
]);

/**
 * Flags this script USED to accept, with the reason they are gone. Silence here would be the worst
 * outcome: an unrecognised flag used to fall through to the read-only list, so old operator
 * automation calling `--settle <id> --apply` exited 0 having reconciled NOTHING, and the operator
 * had every reason to believe the row was healed.
 */
const REMOVED_FLAGS: Record<string, string> = {
  "--settle":
    "--settle was removed. It only flipped status to 'applied' — no FIFO lots consumed, no spread " +
    "P&L booked, no positions updated — which lifted the fence while both legs stayed open and let " +
    "the next sweep merge the same inventory twice. Verify the merge on chain, then use " +
    "--mark-onchain <mergeId> --apply and restart the runtime: it settles the row atomically.",
};

function rejectUnsupportedFlags(raw: string[]): void {
  for (const token of raw) {
    // Values (db paths, merge ids) never start with '-', so a leading dash means "this was meant
    // as a flag" — and a flag this script does not implement must never be silently ignored.
    if (!token.startsWith("-")) continue;
    const removed = REMOVED_FLAGS[token];
    if (removed) throw new Error(removed);
    if (!KNOWN_FLAGS.has(token)) {
      throw new Error(`unknown flag ${token} — run with --help for the supported commands`);
    }
  }
}

export function parseArgs(raw: string[]): Args {
  if (raw.includes("--help") || raw.includes("-h")) {
    return { dbPath: "", action: "help", mergeId: null, apply: false, fenced: false };
  }
  rejectUnsupportedFlags(raw);

  const value = (name: string): string | null => {
    const index = raw.indexOf(name);
    return index >= 0 ? (raw[index + 1] ?? null) : null;
  };

  const dbPath = value("--db") ?? process.env.LEDGER_PATH ?? null;
  const markId = value("--mark-onchain");
  const discardId = value("--discard");
  const apply = raw.includes("--apply");
  const fenced = raw.includes("--fenced");

  if (!dbPath) {
    throw new Error("required: --db <ledger.db> (or set LEDGER_PATH)");
  }
  if (markId != null && discardId != null) {
    throw new Error("--mark-onchain and --discard are mutually exclusive");
  }
  // --fenced only ever relaxes the discard transition (see rejectIllegalTransition), so pairing it
  // with --mark-onchain or passing it with no action at all is a usage mistake worth catching here
  // rather than silently ignoring.
  if (fenced && discardId == null) {
    throw new Error(
      "--fenced is only valid together with --discard <mergeId> --apply — run with --help for usage",
    );
  }

  if (markId != null) {
    return { dbPath, action: "mark-onchain", mergeId: markId, apply, fenced };
  }
  if (discardId != null) {
    return { dbPath, action: "discard", mergeId: discardId, apply, fenced };
  }
  return { dbPath, action: "list", mergeId: null, apply, fenced };
}

export function listNonTerminal(db: DatabaseType): MergeLedgerRow[] {
  return db
    .prepare(
      `SELECT merge_id, condition_id, merged_amount, spread_pnl, merged_at, created_at, status, yes_token_id, no_token_id, yes_position_id, no_position_id
       FROM merge_ledger WHERE status != 'applied' ORDER BY created_at`,
    )
    .all() as MergeLedgerRow[];
}

export function findRow(db: DatabaseType, mergeId: string): MergeLedgerRow | undefined {
  return db
    .prepare(
      `SELECT merge_id, condition_id, merged_amount, spread_pnl, merged_at, created_at, status, yes_token_id, no_token_id, yes_position_id, no_position_id
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

export function parseLedgerTimestamp(raw: string): number {
  return parseInstantMs(raw);
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
 * Both writes are only legal from 'pending' — except a discard explicitly acknowledged with
 * --fenced, the sole supported escape from a row whose exact recorded legs boot recovery fenced.
 * 'applied' is terminal, and an un-acknowledged 'onchain' row already carries the operator's "it
 * landed" decision — the remaining work on it belongs to the runtime, which settles it atomically,
 * not to a CLI that can only touch one column.
 */
function rejectIllegalTransition(
  row: MergeLedgerRow,
  action: "mark-onchain" | "discard",
  fenced: boolean,
): string | null {
  if (row.status === "applied") {
    return `mergeId=${row.merge_id} is already 'applied' — nothing to reconcile`;
  }
  if (row.status === "onchain") {
    if (action === "discard" && fenced) {
      return null;
    }
    const fencedEscape =
      `if boot recovery fenced it (check the runtime's error log for this mergeId — "the row ` +
      `stays fenced for an operator to reconcile" — or the inventory_merge_recovery_fenced_total ` +
      `metric), inspect the exact recorded identities and use ` +
      `--discard ${row.merge_id} --fenced --apply`;
    return action === "mark-onchain"
      ? `mergeId=${row.merge_id} is already 'onchain' — the runtime settles it locally on its next ` +
          `start (consumes lots, books P&L, lifts the fence) unless it is fenced; ${fencedEscape}`
      : `refusing to discard mergeId=${row.merge_id}: status='onchain' means this merge PROVABLY ` +
          `landed on chain. Deleting it would erase the only local record of it and let the next ` +
          `sweep merge the same inventory twice. The runtime settles it locally on its next start ` +
          `unless it is fenced; ${fencedEscape}`;
  }
  return null;
}

export type FenceProof = { proven: true } | { proven: false; reason: string };

interface LotTimeRow {
  created_at: string | null;
}

function invalidRowIdentity(row: MergeLedgerRow): string | null {
  return invalidRecordedMergeIdentity({
    yesTokenId: row.yes_token_id,
    noTokenId: row.no_token_id,
    yesPositionId: row.yes_position_id,
    noPositionId: row.no_position_id,
  });
}

export function proveRecoveryFence(db: DatabaseType, row: MergeLedgerRow): FenceProof {
  const invalidIdentity = invalidRowIdentity(row);
  if (invalidIdentity) {
    return {
      proven: false,
      reason: `non-terminal row has invalid recorded leg identity: ${invalidIdentity}`,
    };
  }
  const position = db.prepare(
    `SELECT token_id, status, opened_at FROM positions WHERE position_id = ?`,
  );
  const lots = db.prepare(
    `SELECT created_at FROM inventory_lots WHERE position_id = ? AND remaining_size > 0`,
  );
  const tokenLots = db.prepare(
    `SELECT 1 FROM inventory_lots WHERE token_id = ? AND remaining_size > 0 LIMIT 1`,
  );
  const leg = (tokenId: string, positionId: string) => {
    const exact = position.get(positionId) as
      | { token_id: string; status: string; opened_at: string | null }
      | undefined;
    return {
      tokenId,
      positionId,
      position: exact
        ? { tokenId: exact.token_id, status: exact.status, openedAt: exact.opened_at }
        : null,
      liveLotCreatedAts: (lots.all(positionId) as LotTimeRow[]).map((lot) => lot.created_at),
      hasTokenWideLiveLots: tokenLots.get(tokenId) !== undefined,
    };
  };
  const evaluated = evaluateRecordedMergeLegs({
    mergedAt: row.merged_at,
    yes: leg(row.yes_token_id!, row.yes_position_id!),
    no: leg(row.no_token_id!, row.no_position_id!),
  });
  if (evaluated.ok) {
    return { proven: false, reason: "both exact recorded legs remain recoverable" };
  }
  if (evaluated.reason.endsWith("-missing-or-closed")) return { proven: true };
  return { proven: false, reason: `recorded-leg validation failed: ${evaluated.reason}` };
}

/**
 * A fenced discard deletes the only local record of a merge that provably happened on chain, so
 * the operator must see exactly what is being given up in BOTH dry-run and --apply — this is
 * deliberately the loudest message the script prints, and the last checkpoint before a real record
 * disappears.
 */
function fencedDiscardWarning(mergeId: string, conditionId: string): string {
  return (
    `FENCED DISCARD WARNING — mergeId=${mergeId} condition_id=${conditionId}: the on-chain merge ` +
    `REALLY HAPPENED, but THIS merge was never settled locally: its spread P&L was never booked ` +
    `and it never consumed any FIFO lots. That does NOT mean the original legs' lots still exist — ` +
    `a later SELL can already have consumed them. This deletes the only local record of the merge. ` +
    `The proof uses the exact identities recorded before submission and confirmed that one recorded ` +
    `leg is missing or closed with no live lots for its token. Before resuming the runtime, reconcile ` +
    `local positions against actual wallet balances. Run this command only with the runtime stopped.`
  );
}

/**
 * Shared by the pre-check and the transactional re-check so the two refusals can never drift apart.
 */
function fencedDiscardRefusal(mergeId: string, reason: string): string {
  return (
    `refusing --discard ${mergeId} --fenced: this database does not PROVE the row is fenced — ` +
    `${reason}. The proof uses only the exact recorded token/position identities and their live ` +
    `lots. Deleting on an inconclusive result could allow the same inventory to be merged twice. ` +
    `Stop the runtime, inspect its recovery error for this mergeId, and reconcile manually.`
  );
}

/**
 * Re-proves the fence and deletes the row under a single `BEGIN IMMEDIATE`.
 *
 * The pre-check in `runWrite` runs in autocommit, so its snapshot is already history by the time it
 * returns — a writer committing between it and the DELETE would make the delete rest on a state
 * that no longer exists. SQLite admits one writer at a time, so taking the write lock BEFORE the
 * proof's reads is what makes the delete conditional on the state the proof actually saw.
 *
 * This is atomicity, not exclusion: it cannot stop a runtime that is already running, and nothing
 * in this database can prove one is not (`bot_runs.finished_at` is never written, and the runtime's
 * heartbeat lives in the control DB this command does not open). The command is supported ONLY
 * with the runtime stopped.
 */
function discardFenced(db: DatabaseType, mergeId: string, row: MergeLedgerRow): FenceProof {
  return db
    .transaction((): FenceProof => {
      const proof = proveRecoveryFence(db, row);
      if (!proof.proven) return proof;
      discardRow(db, mergeId, row.status);
      return proof;
    })
    .immediate();
}

function runWrite(
  db: DatabaseType,
  action: "mark-onchain" | "discard",
  mergeId: string,
  apply: boolean,
  fenced: boolean,
): number {
  const row = findRow(db, mergeId);
  if (!row) {
    console.error(`no merge_ledger row for mergeId=${mergeId}`);
    return 1;
  }
  console.log(JSON.stringify(row, null, 2));

  // Applied history predates leg-identity migration 100 and legitimately carries NULLs. Terminal
  // status is the decisive diagnostic for those rows; do not misreport them as malformed
  // non-terminal work merely because their historical identities cannot be reconstructed.
  if (row.status === "applied") {
    // eslint-disable-next-line no-console -- Operator CLI refusals intentionally use stderr.
    console.error(rejectIllegalTransition(row, action, fenced));
    return 1;
  }

  const invalidIdentity = invalidRowIdentity(row);
  if (invalidIdentity) {
    // eslint-disable-next-line no-console -- Operator CLI refusals intentionally use stderr.
    console.error(
      `refusing ${action} for mergeId=${mergeId}: non-terminal row has invalid recorded leg identity: ${invalidIdentity}`,
    );
    return 1;
  }

  const rejection = rejectIllegalTransition(row, action, fenced);
  if (rejection) {
    console.error(rejection);
    return 1;
  }

  const isFencedDiscard = action === "discard" && row.status === "onchain" && fenced;
  if (isFencedDiscard) {
    // Before the warning and before the dry-run exit: a dry run that reported "would delete" for a
    // row this command will in fact refuse would send the operator back with --apply on a row the
    // runtime can still settle — the exact override this proof exists to close.
    const proof = proveRecoveryFence(db, row);
    if (!proof.proven) {
      console.error(fencedDiscardRefusal(mergeId, proof.reason));
      return 1;
    }
    console.log(fencedDiscardWarning(mergeId, row.condition_id));
  }

  if (!apply) {
    const verb =
      action === "mark-onchain" ? "promote it to 'onchain'" : `delete this '${row.status}' row`;
    console.log(`DRY RUN: would ${verb}. Re-run with --apply to commit. No changes made.`);
    return 0;
  }

  if (action === "mark-onchain") {
    markRowOnchain(db, mergeId, row.status);
    console.log(
      `mergeId=${mergeId} -> status='onchain'. The fence stays up on condition_id=` +
        `${row.condition_id} until the runtime settles it: restart the runtime, which consumes the ` +
        `lots, books the spread P&L and marks the row 'applied' in one transaction using the exact ` +
        `recorded legs. If validation fails, the row remains 'onchain'; inspect the recovery log.`,
    );
  } else {
    if (isFencedDiscard) {
      const proof = discardFenced(db, mergeId, row);
      if (!proof.proven) {
        console.error(
          `${fencedDiscardRefusal(mergeId, proof.reason)} (the state changed between the check ` +
            `above and the write — nothing was deleted)`,
        );
        return 1;
      }
    } else {
      discardRow(db, mergeId, row.status);
    }
    console.log(
      isFencedDiscard
        ? `discarded fenced mergeId=${mergeId} on condition_id=${row.condition_id}. The next ` +
            `auto-merge sweep will re-evaluate this condition_id from current inventory.`
        : `discarded mergeId=${mergeId}. Fence lifted; the next auto-merge sweep will retry this ` +
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
    return runWrite(db, args.action, args.mergeId as string, args.apply, args.fenced);
  } finally {
    db.close();
  }
}

const isMainModule = process.argv[1] != null && process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  process.exit(run(parseArgs(process.argv.slice(2))));
}

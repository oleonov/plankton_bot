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
 *     'pending' -> 'onchain'; it stays fenced until the runtime settles it locally, which consumes
 *     the lots and books the P&L atomically. Restart the runtime afterwards — but the restart
 *     settles the row only if the legs it derives are themselves unfenced: if a leg trips freshness,
 *     ownership or the live-lot predicate below, the row stays 'onchain' and the runtime logs why.
 *     Read that log after the restart rather than assuming the promotion finished the job.
 *
 *   npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db> --discard <mergeId> --apply
 *     Delete the row because you verified ON-CHAIN that the merge did NOT go through. Only a
 *     'pending' row can be discarded — an 'onchain' row is a merge that provably landed, and
 *     deleting it would drop the only local record of it.
 *
 *   npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db> --discard <mergeId> --fenced --apply
 *     Escape hatch for an 'onchain' row that boot recovery has FENCED (see findStaleMergeLeg in
 *     apps/runtime/src/modules/inventory-auto-merge/recover-onchain-merges.ts): a derived leg
 *     cannot be shown to be one the merge moved — its `opened_at` is at or after the intent (or
 *     either timestamp is unparseable), its `positions.condition_id` is not this merge's condition,
 *     or a live FIFO lot under it cannot be shown to predate the start of the intent's second — so
 *     debiting its lots would be a wrong debit after an irreversible on-chain merge, and the
 *     runtime refuses to settle the row for as long as that stays true. It is NOT a permanent
 *     verdict: the legs are re-derived from the mutable `markets` catalog on every boot, so a later
 *     scanner upsert can hand recovery a different pair (which is exactly why the proof below
 *     refuses on an incomplete catalog). The comparison is `>=` on purpose, and equality is NOT by
 *     itself evidence of a substitution: `merged_at` and `opened_at` come from independent
 *     millisecond-resolution `new Date().toISOString()` calls, so an ORIGINAL leg that opened inside
 *     the merge intent's own millisecond is fenced too. That direction is the cheap one — a falsely
 *     fenced row costs this one escalation, a falsely accepted one debits lots the merge never
 *     touched — but it means "fenced" reads as "the runtime can no longer tell", not as "the legs
 *     were proven replaced". --fenced only relaxes the onchain -> deleted
 *     transition; it never marks a row 'applied' (see REMOVED_FLAGS["--settle"] below for why that
 *     stays off the table permanently). Deleting is still strictly better than a fenced
 *     --mark-onchain-then-settle, which would debit lots the merge never touched — but it does NOT
 *     prove the next sweep is safe. The fence trips on ONE stale leg and this proof clears on ONE
 *     side having no usable leg, so the OTHER side can perfectly well still hold the original
 *     pre-merge row: a later sweep could pair a replacement with that survivor and merge inventory
 *     that already went on chain. That is why reconciling local positions against the actual wallet
 *     balances before resuming the runtime is a REQUIREMENT, not a suggestion. The other cost is
 *     losing the historical record of the original merge — an explicit operator trade-off.
 *
 *     The flag is NOT taken on trust: `proveRecoveryFence` below re-derives the fence from
 *     `markets`, `positions` AND `inventory_lots` in this same DB and refuses the delete unless the
 *     runtime provably cannot settle the row. Without that check --fenced was an unchecked override — it would
 *     happily delete an ordinary recoverable 'onchain' row, and against a running bot the delete
 *     could win the race with the settle transaction, roll the settle back, and hand the still-open
 *     inventory to the next sweep to merge a SECOND time on chain. "Provably" is read DURABLY: a
 *     token that is merely ambiguous today becomes a settleable leg the moment one of its rows
 *     closes, so it counts as usable and the proof refuses. It also refuses on an INCOMPLETE
 *     catalog, because an empty side only means something when the catalog can express that side:
 *     when `markets` does not currently name both a YES and a NO token for the condition, or when
 *     the condition still owns positions (by `positions.condition_id`, the one anchor no market
 *     upsert rewrites) on tokens absent from its current `markets` rows. Both gaps heal by
 *     themselves on the next scanner upsert — after the row that fenced the pair is already gone.
 *     Proof and DELETE share one
 *     BEGIN IMMEDIATE, so the delete rests on the state the proof actually saw — that is atomicity
 *     inside this command, never exclusion of a runtime that is already running.
 *
 * Omit --apply on a write to see what WOULD happen without touching the database (the
 * default-to-dry-run convention used across this repo's operator scripts).
 *
 * Both writes are compare-and-swap against the status this command actually READ. If the runtime
 * moves the row FIRST, the write matches zero rows and the command aborts instead of overwriting a
 * decision made by a process that knows more than it does. The CAS does NOT make this command safe
 * against a running runtime in the other ordering: a delete that lands first simply wins, and the
 * runtime's settle transaction rolls back on the row it can no longer find. Stopping the runtime is
 * a REQUIREMENT this command cannot verify: the ledger DB carries no liveness signal at all
 * (`bot_runs.finished_at` is never written, and the runtime's heartbeat lives in control.db, which
 * this command does not open). The fence proof narrows what an operator who forgets can destroy; it
 * does not make the delete safe against a live process.
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
  fenced: boolean;
}

const HELP = `Usage:
  npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db>
      List every merge_ledger row with status != 'applied' (read-only, no --apply needed).

  npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db> --mark-onchain <mergeId> --apply
      Record that the merge PROVABLY landed on chain: 'pending' -> 'onchain'. The fence stays up
      until the runtime settles the row locally (lots consumed, P&L booked, positions updated) —
      restart the runtime after this command. The restart settles it ONLY if the legs recovery
      derives are unfenced; if any trips a predicate below, the row stays 'onchain' and the runtime
      logs the reason. Check that log instead of assuming the restart finished the job.

  npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db> --discard <mergeId> --apply
      Delete the row because the merge provably did NOT land. Only a 'pending' row may be
      discarded; an 'onchain' row is refused because it names a merge that already happened —
      unless it was fenced by boot recovery, see --fenced below.

  npx tsx scripts/merge-ledger-reconcile.ts --db <ledger.db> --discard <mergeId> --fenced --apply
      Escape hatch for an 'onchain' row that boot recovery fences. Any ONE of three predicates
      fences a derived leg: (1) opened_at NOT SHOWN to predate the merge — at or after it, or
      either side unparseable, which the runtime reports as 'unparseable' and treats identically
      because it fails closed — so the runtime cannot prove which lots to debit; (2) a
      positions.condition_id that is not this merge's condition (including the
      empty string legacy rows carry), so the leg cannot be shown to belong to this merge at all;
      (3) a LIVE inventory_lots row under that leg whose created_at cannot be shown to predate the
      START of the SECOND in which the merge intent was recorded — startup adoption rewrites a
      winner's opened_at BACKWARD across every row it absorbs
      but never touches a lot's created_at, so lot ages are the provenance that survives
      consolidation. None of the three is proof of substitution. (1) is fenced at equality
      deliberately — both timestamps are independent millisecond-resolution clock reads, so an
      ORIGINAL leg can land in the merge intent's own millisecond and be fenced too. (3) trips
      identically on a legitimate scale-in made after the intent was recorded, and its threshold is
      the whole second rather than the intent's instant because inventory_lots.created_at defaults
      to second-resolution datetime('now') and would otherwise read up to 999 ms EARLIER than the
      moment it records — so a lot whose own timestamp is demonstrably milliseconds BEFORE the
      intent is fenced too. This
      command re-derives the fence from markets/positions/inventory_lots in the same DB and refuses
      the delete unless the runtime provably cannot settle the row, so --fenced is a declaration of
      intent, not an override. Both the fence and
      this re-derivation read the MUTABLE markets catalog, which every scanner upsert rewrites, so
      neither says "forever": they describe the catalog as it stands right now, and a later scan
      can change the answer in either direction. This never marks the row 'applied' — it only deletes
      the local record so the fence lifts and the next sweep merges the current inventory. That
      sweep is NOT proven safe: the fence trips on one stale leg, so the other side can still be
      the original row the on-chain merge already moved. Reconcile local positions against actual
      wallet balances before resuming — that is a requirement, not advice.
      Supported ONLY with the runtime STOPPED, and this command cannot check that — see below.

Flags:
  --db <path>          Ledger SQLite DB path (or set LEDGER_PATH env var).
  --mark-onchain <id>  Promote merge_id <id> to 'onchain'. Requires --apply to actually write.
  --discard <id>       Delete merge_ledger row <id>. Requires --apply to actually write.
  --fenced             Acknowledge that an 'onchain' row was fenced by boot recovery.
                       Only legal together with --discard, and only honoured when this command can
                       re-derive the fence itself. Read the runtime's recovery error log first: it
                       names the mergeId and conditionId ("the row stays fenced for an operator to
                       reconcile"). The inventory_merge_recovery_fenced_total metric is labelled
                       only by reason — it proves A row was fenced, never WHICH one.
  --apply              Confirms a write. Without it, prints what would happen and exits without
                       touching the database (dry-run is the default).
  --help, -h           Print this help.

Run this with the runtime STOPPED — a requirement this command CANNOT verify. Nothing in the ledger
DB reports a live runtime: bot_runs.finished_at is never written, and the runtime's heartbeat lives
in control.db, which this command does not open. The operator is the only check there is.

Writes are compare-and-swap on the status read a moment earlier, so a runtime that moves the row
FIRST makes this command abort; but a delete that lands first still wins and rolls the runtime's
settle back. The fenced discard re-proves the fence and deletes under one BEGIN IMMEDIATE, so the
delete rests on the state its proof actually saw — that is atomicity inside this process, NOT
exclusion of a runtime that is already running.
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
 * Both writes are only legal from 'pending' — except a discard explicitly acknowledged with
 * --fenced, the sole supported escape from a row boot recovery has fenced (see
 * findStaleMergeLeg in apps/runtime/src/modules/inventory-auto-merge/recover-onchain-merges.ts).
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
      `metric), the runtime will not settle it while the legs it derives from the CURRENT catalog ` +
      `stay fenced — a later scanner upsert can remap them and change that: use ` +
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

/** Exactly what `new Date().toISOString()` renders — the only shape both parsers agree on. */
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Epoch ms for a canonical ISO instant, or null for ANY other rendering.
 *
 * The fence proof below has to reproduce a comparison the runtime makes with `parseInstantMs`
 * (packages/domain/src/timestamp.ts), and this script deliberately imports nothing from the
 * workspace — `@krabs/db` only exports `dist/`, so an operator on an unbuilt checkout would get a
 * resolution error instead of a reconciliation tool. Rather than duplicating that parser and hoping
 * the two never drift, the proof accepts only the one rendering where `Date.parse` and
 * `parseInstantMs` are provably identical, and refuses everything else. Both columns are written
 * exclusively by `new Date().toISOString()` today — `positions.opened_at` measured 693/693 canonical
 * on the live ledger (2026-08-11) and `merged_at` has exactly one writer, `recordPending` — so
 * refusing the other renderings costs nothing real and keeps the proof from ever permitting a
 * delete on a timestamp the runtime reads differently.
 */
function canonicalIsoMs(raw: string | null | undefined): number | null {
  if (raw == null || !CANONICAL_ISO.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export type FenceProof = { proven: true } | { proven: false; reason: string };

interface ConditionTokenRow {
  token_id: string;
  outcome: string | null;
  outcome_index: number | null;
}

interface ActiveLegRow {
  position_id: string;
  opened_at: string | null;
  condition_id: string;
}

interface LiveLotRow {
  position_id: string;
  live_size: number;
}

interface LotTimeRow {
  created_at: string | null;
}

interface DisplacedLegRow {
  token_id: string;
  position_id: string;
  status: string;
}

/**
 * Proves — from this same ledger DB — that boot recovery cannot settle `row` from the catalog and
 * legs as they stand RIGHT NOW, which is the only thing that makes deleting an 'onchain' record
 * safe. Not "never": every scanner upsert rewrites `markets`, so a later scan can hand recovery a
 * different, settleable pair. That is precisely why the wallet-balance reconciliation before the
 * restart is a requirement rather than advice.
 *
 * Without this, --fenced was a bare assertion: the operator typed a flag and the row went away, on
 * an ordinary recoverable row just as readily as on a fenced one. Against a running bot that is a
 * money bug, not a usability one — the delete can win the race with `MergeSettler.applyMerge`, whose
 * `markApplied` CAS then matches zero rows and rolls the whole settle back, leaving both legs open
 * with no ledger row and no fence. The next sweep merges the same inventory a SECOND time on chain.
 *
 * The proof is deliberately NOT a re-derivation of `findMergeCandidates` — duplicating the leg
 * selection, the token-level SELL-lock arithmetic and the dust threshold in a CLI would be a second
 * implementation of the exact logic that must not drift. It is a one-way SUFFICIENT condition
 * instead: it only ever answers "the runtime provably cannot settle this", never "it can" — and
 * that answer is scoped to the CURRENT `markets` catalog, which a later scanner upsert can remap
 * into a different, settleable pair. Recovery
 * settles a row only via a candidate holding one YES leg and one NO leg, where each leg is the sole
 * non-closed row of its token, STRICTLY predates `merged_at` (`findStaleMergeLeg` fences anything
 * opened at or after it), carries this merge's `positions.condition_id` (the same function
 * fences a leg it cannot show belongs to the condition, empty legacy value included) AND holds no
 * live FIFO lot created at or after `merged_at` (the same function's `lot-after` branch). All four
 * conditions are mirrored here — dropping any one of them makes this command refuse a row the
 * runtime has in fact fenced, leaving the merge with no supported exit at all. So if either side
 * has no token that can supply such a leg, every
 * reachable outcome is a fence: no candidate at all (the "no open YES/NO pair" branch) or a
 * candidate whose leg `findStaleMergeLeg` rejects. "Cannot supply a leg" has to mean DURABLY — see
 * `describeUsableLeg`.
 *
 * Every uncertainty resolves toward USABLE — an unparseable `opened_at`, an unknown timestamp
 * rendering, a condition with no `markets` rows, a condition whose `markets` rows do not currently
 * name BOTH sides, a token this command cannot map to a YES/NO side — so the proof fails to a
 * refusal rather than to a delete. It is therefore incomplete on purpose: a genuinely fenced row can still be refused (e.g.
 * one fenced only because the free size fell to the dust threshold). Refusing a real fence costs an
 * escalation; permitting a settleable row costs a double merge.
 */
/**
 * A label for a token that can still supply boot recovery with a leg, or null when it provably
 * cannot — and "provably" here has to mean DURABLY, not just at this instant.
 *
 * Only three states qualify, because only they survive any later write. No non-closed row and no
 * resurrectable inventory: nothing is left to open, and anything opened from here on carries
 * `opened_at > merged_at`, which `findStaleMergeLeg` fences. Exactly one non-closed row opened at
 * or after `merged_at`: that row is a REPLACEMENT and the same fence rejects it. Exactly one
 * non-closed row that is old enough itself but carries a live lot created at or after `merged_at`:
 * the runtime's `lot-after` branch fences that one too, because startup consolidation rewrites
 * `opened_at` backward while never touching a lot's own `created_at`.
 *
 * That third branch mirrors the runtime with the parse strictness REVERSED, and the reversal is the
 * whole point. The runtime fails CLOSED on a timestamp it cannot read — an unparseable lot
 * `created_at` fences the leg. This command must fence NO MORE than the runtime does, so an
 * unparseable `created_at` is NOT accepted as proof: only a canonically parseable lot at or after
 * the threshold proves the runtime will refuse. `canonicalIsoMs` is the stricter reader of the two
 * (see its comment), and `inventory_lots.created_at` has a `datetime('now')` column DEFAULT whose
 * space-form rendering it rejects outright — so a leg the runtime really does fence can still read
 * as usable here. That costs an escalation; the opposite direction would delete a settleable row.
 *
 * Two or more non-closed rows is NOT such a state, even though `ambiguousTokens()` makes recovery
 * skip the token today. Ambiguity is transient — startup adoption or dust abandonment closes one of
 * the rows and the token becomes a sole settleable leg. Treating "ambiguous" as proof would let
 * this command delete the ledger row moments before recovery gains a candidate for it, which is the
 * delete-wins race the proof exists to prevent. So it counts as usable and the proof refuses.
 *
 * OWNERSHIP is applied before any of that, because `findStaleMergeLeg` fences a leg whose
 * `positions.condition_id` is not this merge's condition — including the empty string legacy rows
 * carry — no matter how old it is. A row the runtime will not accept cannot make this token
 * "able to supply a leg", and counting it would leave a fenced merge with no reachable exit: the
 * runtime refuses to settle it while this command refuses to discard it. So only
 * OWNED non-closed rows are weighed, and a token whose non-closed rows are all foreign supplies
 * nothing. Ambiguity is judged on the owned rows too: closing one of two foreign rows just leaves
 * another foreign row, which the runtime fences exactly as it fenced the first.
 *
 * The `resurrectableLots` branch is deliberately NOT filtered by ownership. `rebuildTokenPosition`
 * picks the winner among a token's lot owners by its own ranking, so "some owner is foreign" does
 * not tell us the winner will be — and this branch's direction is the safe one anyway: counting a
 * lot that cannot in fact resurrect an owned leg only makes the proof REFUSE, which costs an
 * escalation, never a double merge.
 *
 * `resurrectableLots` is what makes "no non-closed row" durable rather than merely momentary. A
 * live `inventory_lots` row outlives the position that owns it, and a fenced discard is precisely
 * the case where those lots were NEVER consumed — so "every row is closed" does not mean the
 * inventory left. `rebuildTokenPosition` (startup-position-adoption.ts) scans `remaining_size > 0`
 * token-wide, picks the lot's owner even when that owner is CLOSED, restores it to 'open' and
 * BACKDATES `opened_at` to the earliest instant across the winner and its sources. That write goes
 * through raw SQL, not `SqlitePositionRepository.save()` whose `ON CONFLICT` deliberately leaves
 * `opened_at` alone — so the "anything opened later is newer than merged_at" argument does not
 * hold for it, and a token that looked permanently empty comes back as an un-fenced settleable
 * leg. Lots owned by a row already in `legs` are excluded by the caller: those cannot resurrect
 * anything, and counting them would make the proof refuse for every genuinely fenced replacement,
 * which would leave the escape hatch with no reachable use at all.
 */
function describeUsableLeg(
  tokenId: string,
  legs: ActiveLegRow[],
  resurrectableLots: LiveLotRow[],
  mergedAtMs: number,
  conditionId: string,
  liveLotTimes: (positionId: string) => (string | null)[],
): string | null {
  if (resurrectableLots.length > 0) {
    const owners = resurrectableLots
      .map((lot) => `${lot.position_id}=${lot.live_size}`)
      .join(" + ");
    return `${tokenId} (live inventory_lots under rows outside the non-closed set: ${owners} — rebuildTokenPosition reopens such an owner and backdates its opened_at)`;
  }
  const owned = legs.filter((leg) => leg.condition_id === conditionId);
  if (owned.length === 0) return null;
  if (owned.length > 1) {
    const ids = owned.map((leg) => leg.position_id).join(" + ");
    return `${tokenId} (${owned.length} non-closed rows: ${ids} — ambiguous now, but closing one of them makes it settleable)`;
  }
  const leg = owned[0]!;
  const openedAtMs = canonicalIsoMs(leg.opened_at);
  // `>=` mirrors findStaleMergeLeg exactly. Equality is the replacement opened in the merge
  // intent's own millisecond: the runtime fences it, so reporting it usable here would refuse a
  // row that really is stuck — the one row this escape hatch exists for.
  if (openedAtMs !== null && openedAtMs >= mergedAtMs) return null;
  // The `lot-after` mirror. `opened_at` alone is not durable provenance: startup adoption ranks a
  // token's non-closed rows newest-first and then rewrites the winner's `opened_at` to the earliest
  // instant across everything it absorbed, so one older sibling backdates a replacement under the
  // check above. Lot ages survive that rewrite — the consolidation reparents inventory by setting
  // `inventory_lots.position_id`, never `created_at`. Floored to the SECOND for the same reason the
  // runtime floors it: a `datetime('now')`-defaulted lot reads up to 999 ms earlier than the
  // instant it records.
  const lotFenceMs = Math.floor(mergedAtMs / 1000) * 1000;
  const fencingLot = liveLotTimes(leg.position_id).find((createdAt) => {
    const createdMs = canonicalIsoMs(createdAt);
    return createdMs !== null && createdMs >= lotFenceMs;
  });
  if (fencingLot) return null;
  return `${tokenId} (${leg.position_id}, opened_at=${leg.opened_at})`;
}

export function proveRecoveryFence(db: DatabaseType, row: MergeLedgerRow): FenceProof {
  const mergedAtMs = canonicalIsoMs(row.merged_at);
  if (mergedAtMs === null) {
    return {
      proven: false,
      reason:
        `merged_at=${JSON.stringify(row.merged_at)} is not a canonical ISO instant, so this ` +
        `command cannot reproduce the runtime's freshness comparison`,
    };
  }

  const tokens = db
    .prepare(`SELECT token_id, outcome, outcome_index FROM markets WHERE condition_id = ?`)
    .all(row.condition_id) as ConditionTokenRow[];
  if (tokens.length === 0) {
    return {
      proven: false,
      reason:
        `no markets rows for condition_id=${row.condition_id}, so the legs this merge moved cannot ` +
        `be identified — an ingestion gap that re-scanning can heal is not proof of a fence`,
    };
  }

  const activeLegs = db.prepare(
    `SELECT position_id, opened_at, condition_id FROM positions
      WHERE token_id = ? AND status != 'closed'`,
  );
  const liveLots = db.prepare(
    `SELECT position_id, SUM(remaining_size) AS live_size FROM inventory_lots
      WHERE token_id = ? AND remaining_size > 0 GROUP BY position_id`,
  );
  // Mirrors InventoryLotRepository.findOpen's filter, which is what the runtime's `lot-after` fence
  // reads. Queried lazily per leg because only the sole-owned-row branch needs it.
  const lotTimes = db.prepare(
    `SELECT created_at FROM inventory_lots WHERE position_id = ? AND remaining_size > 0`,
  );
  const usableYes: string[] = [];
  const usableNo: string[] = [];
  const unclassified: string[] = [];
  const yesTokens: string[] = [];
  const noTokens: string[] = [];
  for (const token of tokens) {
    // Mirrors findMergeCandidates' YES/NO test, including a row that satisfies both — counting it
    // on both sides can only add usable legs, and more usable legs can only make this refuse.
    // Classified BEFORE the usable-leg test on purpose: which sides `markets` currently names is a
    // property of the catalog, not of whether a leg happens to be open on them right now.
    const isYes = token.outcome?.toUpperCase() === "YES" || token.outcome_index === 0;
    const isNo = token.outcome?.toUpperCase() === "NO" || token.outcome_index === 1;
    if (isYes) yesTokens.push(token.token_id);
    if (isNo) noTokens.push(token.token_id);

    const legs = activeLegs.all(token.token_id) as ActiveLegRow[];
    const legIds = new Set(legs.map((leg) => leg.position_id));
    const label = describeUsableLeg(
      token.token_id,
      legs,
      (liveLots.all(token.token_id) as LiveLotRow[]).filter((lot) => !legIds.has(lot.position_id)),
      mergedAtMs,
      row.condition_id,
      (positionId) => (lotTimes.all(positionId) as LotTimeRow[]).map((lot) => lot.created_at),
    );
    if (label === null) continue;
    // A usable leg on a token this test classifies as NEITHER side must not just vanish: dropping
    // it silently empties one side and reads as proof. `markets.outcome_index` is nullable and the
    // text is whatever the venue returned ('Democrat', 'Over', ...), so an ordinary market upsert
    // filling `outcome_index` in later turns the very same row into a leg findMergeCandidates
    // derives — after this command already deleted the ledger row it was fenced by.
    if (!isYes && !isNo) {
      unclassified.push(
        `${label} [outcome=${JSON.stringify(token.outcome)}, outcome_index=${token.outcome_index}]`,
      );
      continue;
    }
    if (isYes) usableYes.push(label);
    if (isNo) usableNo.push(label);
  }

  if (unclassified.length > 0) {
    return {
      proven: false,
      reason:
        `condition_id=${row.condition_id} has usable legs on tokens this command cannot map to a ` +
        `YES/NO side, so it cannot tell whether recovery would pair them — a market upsert that ` +
        `fills outcome_index later makes them settleable: ${unclassified.join(", ")}`,
    };
  }

  // An EMPTY side is only a fence if `markets` actually names that side. When it does not, the side
  // is empty because the catalog is, and this command would be reading an ingestion/classification
  // gap as proof — the same failure `tokens.length === 0` already refuses, one row further along.
  // The gap heals on its own: every scanner upsert rewrites condition_id/outcome/outcome_index
  // (UPSERT_MARKET_SQL in packages/db/src/repositories/market-repository.ts) and the startup market
  // scan runs BEFORE merge recovery, so the missing side can appear and hand findMergeCandidates
  // the original pair — after this command deleted the ledger row that fenced it. `merge_ledger`
  // stores only condition_id, never the token ids that merged, so there is nothing more precise to
  // anchor to and refusing is the only sound answer. Measured on the live ledger 2026-08-11: 33 of
  // the 72 conditions holding an open position have `markets` rows for one side only.
  if (yesTokens.length === 0 || noTokens.length === 0) {
    return {
      proven: false,
      reason:
        `condition_id=${row.condition_id} does not currently have BOTH a YES and a NO token in ` +
        `markets (YES: ${yesTokens.join(", ") || "none"}; NO: ${noTokens.join(", ") || "none"}), ` +
        `so an empty side proves nothing about the fence — a later market upsert can supply the ` +
        `missing side and make the original pair settleable again`,
    };
  }

  if (usableYes.length === 0 || usableNo.length === 0) {
    // An empty side can also be empty because the leg that used to fill it is DISPLACED: its token
    // is no longer among this condition's markets rows. The same mutability that motivates the
    // both-sides refusal above (UPSERT_MARKET_SQL rewrites condition_id on every scanner upsert)
    // can move a token to another condition and later move it back — and then findMergeCandidates
    // re-derives the original pair with no ledger row left to fence it, i.e. a second on-chain
    // merge of inventory that already merged. `positions.condition_id` is written once at row
    // creation and never rewritten by market upserts, so it is the only stable anchor tying a
    // position back to the merge's condition (`merge_ledger` itself stores no token ids).
    // Measured readonly on the live ledger 2026-08-11: of 72 non-closed positions, 0 are displaced
    // and 1 carries the legacy empty condition_id — which never equals a real condition, so it
    // cannot make this refuse. Computed here rather than above so no existing refusal changes.
    const displaced = db
      .prepare(
        // NOT EXISTS, never NOT IN: `markets.token_id` is a bare `TEXT PRIMARY KEY`
        // (packages/db/src/schemas/ledger.sql:11) and SQLite's legacy rowid-table quirk lets a
        // non-INTEGER PRIMARY KEY hold NULL. One NULL token in the subquery makes every `NOT IN`
        // comparison UNKNOWN instead of TRUE, which returns zero rows and silently disables this
        // whole refusal. NOT EXISTS compares row-wise, so a NULL simply never matches.
        `SELECT DISTINCT p.token_id, p.position_id, p.status FROM positions p
          WHERE p.condition_id = ?
            AND NOT EXISTS (SELECT 1 FROM markets m
                             WHERE m.condition_id = ? AND m.token_id = p.token_id)
            AND (p.status != 'closed'
                 OR EXISTS (SELECT 1 FROM inventory_lots l
                             WHERE l.position_id = p.position_id AND l.remaining_size > 0))`,
      )
      .all(row.condition_id, row.condition_id) as DisplacedLegRow[];
    if (displaced.length > 0) {
      return {
        proven: false,
        reason:
          `condition_id=${row.condition_id} still owns positions whose tokens are NOT in its ` +
          `current markets rows, so an empty side may be empty only because the leg is displaced ` +
          `— a later market upsert can map the token back and hand recovery the original pair: ` +
          `${displaced
            .map((leg) => `${leg.token_id} (${leg.position_id}, status=${leg.status})`)
            .join(", ")}`,
      };
    }
    return { proven: true };
  }
  return {
    proven: false,
    reason:
      `condition_id=${row.condition_id} can still supply boot recovery with a YES and a NO leg ` +
      `against merged_at=${row.merged_at}, so it can settle this row normally — YES: ` +
      `${usableYes.join(", ")}; NO: ${usableNo.join(", ")}`,
  };
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
    `Before resuming the runtime, reconcile local positions against the actual wallet balances. ` +
    `THE PROOF BEHIND THIS DELETE IS DERIVED FROM A MUTABLE CATALOG: boot recovery finds both legs ` +
    `through 'markets', whose condition_id/outcome every scanner upsert rewrites wholesale, so a ` +
    `later upsert can hand the runtime a fresh settleable YES/NO pair for this condition — after ` +
    `the row that fenced it is already gone. The proof shows only that the CURRENT catalog cannot ` +
    `settle this row; it cannot promise the next one won't. That reconciliation against wallet ` +
    `balances, done BEFORE the restart, is what catches such a pair — which is also why this ` +
    `command is supported only with the runtime stopped.`
  );
}

/**
 * Shared by the pre-check and the transactional re-check so the two refusals can never drift apart.
 */
function fencedDiscardRefusal(mergeId: string, reason: string): string {
  return (
    `refusing --discard ${mergeId} --fenced: this database does not PROVE the row is fenced — ` +
    `${reason}. That is NOT the same as showing the row settleable: this proof reads only ` +
    `canonical ISO timestamps while the runtime's reader is deliberately more tolerant, so a live ` +
    `lot carrying inventory_lots.created_at's schema-default space-separated rendering leaves the ` +
    `proof inconclusive on a row the runtime does in fact fence. Deleting on an inconclusive ` +
    `proof would let the next sweep merge the same inventory a second time on ` +
    `chain. Stop the runtime, re-read its recovery error log for this mergeId, and escalate rather ` +
    `than forcing the delete. This verdict is derived from a MUTABLE catalog — every scanner ` +
    `upsert rewrites 'markets' condition_id/outcome — so it describes only the catalog as it ` +
    `stands right now: re-running after a scan can answer differently, in either direction.`
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
        `lots, books the spread P&L and marks the row 'applied' in one transaction — but only if ` +
        `the legs it derives are unfenced. If one trips freshness, ownership or the live-lot ` +
        `predicate, the row stays 'onchain' and the runtime logs which; read that log after the ` +
        `restart rather than assuming this promotion settled it.`,
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

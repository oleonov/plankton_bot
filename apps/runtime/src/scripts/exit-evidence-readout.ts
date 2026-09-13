import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { LIMITS, type Episode, type Run } from "../modules/exit-evidence/types.js";
import { familyBytes } from "../modules/exit-evidence/store.js";

type EvidenceRow = { slot: number; kind: string; origin: string; source: number; payload: string };
type QualityRow = { reason: string; count: number };
const INCOMPLETE = new Set([
  "lifecycle_drop",
  "event_quota",
  "link_unknown",
  "link_ambiguous",
  "left_censored",
  "clock_backwards",
  "restart_gap",
  "catchup_incomplete",
  "invalid_time",
  "future_time",
]);

export function readEvidence(path: string): object {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    db.pragma("query_only=ON");
    if (
      db.pragma("user_version", { simple: true }) !== 1 ||
      db.pragma("journal_mode", { simple: true }) !== "delete"
    )
      throw new Error("unsupported sidecar");
    return readSummary(db, path);
  } finally {
    db.close();
  }
}
function coverage(run: Run, count: number, quality: QualityRow[]): object {
  const evidenceExpired = run.disabled === 2;
  return {
    evidenceExpired,
    unknownEnrollmentSlots: evidenceExpired ? null : run.spent - count,
    cohortIncomplete:
      evidenceExpired ||
      !run.clean_shutdown ||
      run.spent !== count ||
      quality.some((q) => q.count > 0 && INCOMPLETE.has(q.reason)),
    quality,
  };
}
function readSummary(db: Database.Database, path: string): object {
  const run = db.prepare("SELECT * FROM run_state WHERE id=1").get() as Run;
  const episodes = db.prepare("SELECT * FROM episodes ORDER BY slot LIMIT 32").all() as Episode[];
  const rows = db
    .prepare("SELECT slot,kind,origin,source,payload FROM events ORDER BY id LIMIT ?")
    .all(LIMITS.events) as EvidenceRow[];
  const quality = db
    .prepare("SELECT reason,count FROM quality ORDER BY reason LIMIT 32")
    .all() as QualityRow[];
  return {
    run,
    familyBytes: familyBytes(path),
    ...coverage(run, episodes.length, quality),
    sourceCutoff: rows.reduce((last, row) => Math.max(last, row.source ?? 0), 0),
    evidenceRows: rows.length,
    bookRows: (db.prepare("SELECT count(*) AS n FROM book_samples").get() as { n: number }).n,
    episodes: episodes.map((e) => summarize(e, rows)),
    comparison: "comparison_unavailable",
    interpretation:
      "Counts describe evidence availability. Accepted size is not signed shares; pending signed facts do not prove transmission. Missing sale is not proof of no sale. Settlement details unavailable. Plankton conclusions require refreshed Historical AND Observer shards; no September coverage assumed.",
  };
}
function facts(rows: EvidenceRow[], kind: string): Record<string, unknown>[] {
  return rows
    .filter((r) => r.kind === kind)
    .map((r) => ({
      origin: r.origin,
      ...(JSON.parse(r.payload) as Record<string, unknown>),
    }));
}
function orderEvidence(e: Episode, rows: EvidenceRow[], orders: Record<string, unknown>[]): object {
  const intents = facts(rows, "PlaceOrderRequested");
  return {
    initialIntent: intents.filter((f) => f.clientOrderId === e.client),
    laterIntents: intents.filter((f) => f.clientOrderId !== e.client),
    recoveredOrderFacts: orders.filter((f) => f.origin === "recovered"),
    acceptedOrderFacts: orders.filter((f) => f.origin === "live" || f.accepted === true),
    preparedSigned: orders
      .filter((f) => typeof f.preparedShares === "number")
      .map((f) => ({
        orderId: f.orderId,
        shares: f.preparedShares,
        logicalSize: f.preparedLogicalSize,
        transmitted: "unknown",
      })),
  };
}
function fillEvidence(e: Episode, rows: EvidenceRow[], orders: Record<string, unknown>[]): object {
  const fills = new Map(facts(rows, "FillReceived").map((f) => [String(f.fillId), f]));
  const unique = [...fills.values()];
  const originalOrders = new Set(
    orders.filter((f) => f.clientOrderId === e.client).map((f) => f.orderId),
  );
  return {
    actualFills: unique.map((f) => ({
      ...f,
      buyOrigin:
        f.side !== "buy"
          ? null
          : f.clientOrderId === e.client || originalOrders.has(f.orderId)
            ? "original"
            : "later_or_unknown",
    })),
    hasBuy: unique.some((f) => f.side === "buy"),
    hasSale: unique.some((f) => f.side === "sell"),
  };
}
function summarize(e: Episode, rows: EvidenceRow[]): object {
  const selected = rows.filter((r) => r.slot === e.slot);
  const orders = facts(selected, "OrderPlaced");
  return {
    ...e,
    ...orderEvidence(e, selected, orders),
    ...fillEvidence(e, selected, orders),
    failedAttempts: selected.filter((r) => ["OrderSkipped", "OrderRejected"].includes(r.kind))
      .length,
    openOrRightCensored: !e.terminal,
    cleanLink: !!e.position && !e.ambiguous,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2])
      throw new Error("usage: exit-evidence-readout.js /path/to/exit-evidence.db");
    process.stdout.write(JSON.stringify(readEvidence(resolve(process.argv[2])), null, 2) + "\n");
  } catch {
    process.stderr.write(
      "Readout unavailable: disable and drain collector first; verify path/schema.\n",
    );
    process.exitCode = 1;
  }
}

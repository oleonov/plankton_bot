import type Database from "better-sqlite3";
import {
  classifySellLoopGuardReject,
  classifySellLoopGuardSkip,
  type LoopGuardOutcomeKind,
} from "@krabs/domain";

/**
 * Startup recovery rebuilds the loop-guard counts inside the active window from
 * durable rows so a restart mid-storm does not reset the breaker. Two sources:
 *  - `orders`: rejected SELL rows whose `exchange_error_message` is a no-order-id
 *    message (the `exchange_no_order_id` class). Their `created_at` is ISO.
 *  - `risk_events`: `order_skipped` rows for local `post-only-cross-pre-submit`
 *    SELL skips. Their `created_at` is the SQLite `datetime('now')` space format.
 *
 * Deduplicated `order_rejected` risk events are intentionally NOT read — the live
 * count subscribes to the bus before that dedup, and recovery mirrors the same
 * truth source (`orders`). See research_plankton/loop_guard_spec_2026-06-11.md §4.4.
 */
export interface RecoveredLoopGuardEvent {
  tokenId: string;
  outcome: LoopGuardOutcomeKind;
  timestampMs: number;
}

interface OrderRow {
  token_id: string;
  side: string;
  exchange_error_message: string | null;
  exchange_rejection_reason: string | null;
  decision_rule_id: string | null;
  created_at: string;
}

interface RiskEventRow {
  payload: string;
  created_at: string;
}

/**
 * Parse a ledger timestamp to epoch ms. `orders.created_at` is ISO (has 'T' and
 * 'Z'); `risk_events.created_at` is the SQLite `datetime('now')` UTC space format
 * 'YYYY-MM-DD HH:MM:SS' with no zone — normalize it to ISO-UTC before parsing.
 */
function parseDbTimestampMs(raw: string): number {
  const normalized = raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
  return Date.parse(normalized);
}

export function recoverSellLoopGuardEvents(
  db: Database.Database,
  windowStartMs: number,
): RecoveredLoopGuardEvent[] {
  const isoBound = new Date(windowStartMs).toISOString();
  const spaceBound = isoBound.slice(0, 19).replace("T", " ");
  const recovered: RecoveredLoopGuardEvent[] = [];
  const hasDecisionRuleId = hasColumn(db, "orders", "decision_rule_id");

  const orderRows = db
    .prepare(
      `SELECT token_id, side, exchange_error_message, exchange_rejection_reason,
              ${hasDecisionRuleId ? "decision_rule_id" : "NULL AS decision_rule_id"},
              created_at
       FROM orders
       WHERE side = 'sell' AND created_at >= ?`,
    )
    .all(isoBound) as OrderRow[];
  for (const row of orderRows) {
    const outcome = classifySellLoopGuardReject({
      side: row.side,
      reason: row.exchange_rejection_reason,
      exchangeErrorMessage: row.exchange_error_message,
      decisionRuleId: row.decision_rule_id,
    });
    pushIfInWindow(recovered, row.token_id, outcome, row.created_at, windowStartMs);
  }

  const skipRows = db
    .prepare(
      `SELECT payload, created_at
       FROM risk_events
       WHERE event_type = 'order_skipped' AND created_at >= ?`,
    )
    .all(spaceBound) as RiskEventRow[];
  for (const row of skipRows) {
    const parsed = parsePayload(row.payload);
    if (!parsed) continue;
    const outcome = classifySellLoopGuardSkip({
      side: parsed.side,
      reasonCode: parsed.reasonCode,
      decisionRuleId: parsed.decisionRuleId,
    });
    pushIfInWindow(recovered, parsed.tokenId, outcome, row.created_at, windowStartMs);
  }

  recovered.sort((a, b) => a.timestampMs - b.timestampMs);
  return recovered;
}

function parsePayload(
  raw: string,
): { tokenId: string; side: string; reasonCode: string; decisionRuleId: string | null } | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const tokenId = typeof obj.tokenId === "string" ? obj.tokenId : null;
    const side = typeof obj.side === "string" ? obj.side : "";
    const reasonCode = typeof obj.reasonCode === "string" ? obj.reasonCode : "";
    const decisionRuleId = typeof obj.decisionRuleId === "string" ? obj.decisionRuleId : null;
    if (!tokenId) return null;
    return { tokenId, side, reasonCode, decisionRuleId };
  } catch {
    return null;
  }
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function pushIfInWindow(
  out: RecoveredLoopGuardEvent[],
  tokenId: string,
  outcome: LoopGuardOutcomeKind | null,
  createdAt: string,
  windowStartMs: number,
): void {
  if (!outcome) return;
  const timestampMs = parseDbTimestampMs(createdAt);
  if (Number.isNaN(timestampMs) || timestampMs < windowStartMs) return;
  out.push({ tokenId, outcome, timestampMs });
}

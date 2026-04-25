import type Database from "better-sqlite3";
import {
  createConditionId,
  createFillId,
  createOrderId,
  createPositionId,
  createTokenId,
} from "@plankton/domain";
import type {
  ClientOrderId,
  LegState,
  LegStateTransitionRepository,
  PositionId,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";
import { deriveLegPhase, nextLegStateForFill } from "./update-leg-state-for-fill.js";

interface FillReplayRow {
  fill_id: string;
  order_id: string;
  client_order_id: string | null;
  token_id: string;
  position_id: string | null;
  condition_id: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  size_usdc: number;
  filled_at: string;
}

export interface LegStateTransitionBackfillResult {
  scannedFills: number;
  insertedTransitions: number;
  skippedInvalidSells: number;
}

export function backfillLegStateTransitionsFromLedger(
  db: Database.Database,
  transitionRepo: LegStateTransitionRepository,
  log: Logger,
): LegStateTransitionBackfillResult {
  const rows = db
    .prepare(
      `SELECT
          f.fill_id,
          f.order_id,
          o.client_order_id,
          f.token_id,
          (
            SELECT p.position_id
              FROM positions p
             WHERE p.token_id = f.token_id
             ORDER BY CASE WHEN p.status IN ('open', 'dust') THEN 0 ELSE 1 END,
                      p.opened_at DESC,
                      p.position_id DESC
             LIMIT 1
          ) AS position_id,
          f.condition_id,
          f.side,
          f.price,
          f.size,
          f.size_usdc,
          f.filled_at
        FROM fills f
        LEFT JOIN orders o ON o.order_id = f.order_id
       ORDER BY f.token_id ASC, f.filled_at ASC, f.fill_id ASC`,
    )
    .all() as FillReplayRow[];

  const stateByToken = new Map<string, LegState | null>();
  const result: LegStateTransitionBackfillResult = {
    scannedFills: rows.length,
    insertedTransitions: 0,
    skippedInvalidSells: 0,
  };

  for (const row of rows) {
    const tokenId = createTokenId(row.token_id);
    const existing = stateByToken.get(row.token_id) ?? null;
    const next = nextLegStateForFill(
      existing,
      {
        tokenId,
        side: row.side,
        price: row.price,
        filledAt: row.filled_at,
      },
      row.filled_at,
    );

    if (!next) {
      result.skippedInvalidSells += 1;
      continue;
    }

    const fromPhase = deriveLegPhase(existing);
    const toPhase = deriveLegPhase(next);
    const positionId = row.position_id ? createPositionId(row.position_id) : null;
    if (
      insertReplayTransition(transitionRepo, row, positionId, existing, next, fromPhase, toPhase)
    ) {
      result.insertedTransitions += 1;
    }
    stateByToken.set(row.token_id, next);
  }

  log.info(result, "leg phase transition backfill complete");
  return result;
}

function insertReplayTransition(
  transitionRepo: LegStateTransitionRepository,
  row: FillReplayRow,
  positionId: PositionId | null,
  existing: LegState | null,
  next: LegState,
  fromPhase: ReturnType<typeof deriveLegPhase>,
  toPhase: ReturnType<typeof deriveLegPhase>,
): boolean {
  return transitionRepo.insert({
    tokenId: createTokenId(row.token_id),
    positionId,
    fillId: createFillId(row.fill_id),
    orderId: createOrderId(row.order_id),
    clientOrderId: row.client_order_id ? (row.client_order_id as ClientOrderId) : null,
    conditionId: row.condition_id ? createConditionId(row.condition_id) : null,
    fromPhase,
    toPhase,
    action: row.side === "buy" ? "BUY" : "SELL",
    price: row.price,
    size: row.size,
    sizeUsdc: row.size_usdc,
    fromBuyCount: existing?.buyCount ?? 0,
    fromSellCount: existing?.sellCount ?? 0,
    toBuyCount: next.buyCount,
    toSellCount: next.sellCount,
    reason: "startup_backfill",
    occurredAt: row.filled_at,
  });
}

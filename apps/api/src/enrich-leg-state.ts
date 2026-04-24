/**
 * Leg-state enrichment + phase derivation for the positions DTO.
 *
 * Phase is the S0/S1/S2/S3 state machine the bot uses to classify what it is
 * doing with a given token. Source of truth is the `leg_states` table, which
 * is keyed by token_id and updated on every fill (see LegStateTrackerModule).
 *
 * This helper is API-side intentionally — the web client renders whatever
 * phase the server reports and never derives it itself (design handoff §
 * "Implementation notes for the developer", point 6).
 */

import type Database from "better-sqlite3";

export type Phase = "S0" | "S1" | "S2" | "S3";
export type LegAction = "BUY" | "SELL" | null;

export interface LegStateInfo {
  buyCount: number;
  sellCount: number;
  lastAction: LegAction;
  lastActionAt: string | null;
}

export const EMPTY_LEG_STATE: LegStateInfo = {
  buyCount: 0,
  sellCount: 0,
  lastAction: null,
  lastActionAt: null,
};

/**
 * Build a Map<tokenId, LegStateInfo> for a set of token IDs.
 * Single IN-clause query — no N+1.
 */
export function buildLegStateMap(
  db: Database.Database,
  tokenIds: string[],
): Map<string, LegStateInfo> {
  const result = new Map<string, LegStateInfo>();
  if (tokenIds.length === 0) return result;

  const unique = [...new Set(tokenIds)];
  const placeholders = unique.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT token_id, buy_count, sell_count, last_action, last_trade_at
         FROM leg_states
        WHERE token_id IN (${placeholders})`,
    )
    .all(...unique) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const lastActionRaw = (row.last_action as string | null) ?? null;
    const lastAction: LegAction =
      lastActionRaw === "BUY" || lastActionRaw === "SELL" ? lastActionRaw : null;
    result.set(row.token_id as string, {
      buyCount: Number(row.buy_count ?? 0),
      sellCount: Number(row.sell_count ?? 0),
      lastAction,
      lastActionAt: (row.last_trade_at as string | null) ?? null,
    });
  }

  return result;
}

export function getLegStateOrEmpty(map: Map<string, LegStateInfo>, tokenId: string): LegStateInfo {
  return map.get(tokenId) ?? EMPTY_LEG_STATE;
}

/**
 * Phase derivation per design handoff + 06_algorithm_spec:
 *   S0 — no open shares (dust/closed) OR no leg_state yet.
 *   S1 — buy_count === 1 AND last_action === BUY   (first entry).
 *   S2 — buy_count >= 2 AND last_action === BUY    (accumulating).
 *   S3 — position still open AND last_action === SELL (distributing).
 *
 * Counter does NOT reset after partial sells followed by a new buy
 * (README §"State machine").
 */
export function derivePhase(positionStatus: string, leg: LegStateInfo): Phase {
  if (positionStatus === "closed" || positionStatus === "dust") return "S0";
  if (leg.buyCount === 0 && leg.sellCount === 0) return "S0";
  if (leg.lastAction === "SELL") return "S3";
  if (leg.lastAction === "BUY" && leg.buyCount === 1) return "S1";
  if (leg.lastAction === "BUY" && leg.buyCount >= 2) return "S2";
  return "S0";
}

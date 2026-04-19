/**
 * PositionSettler — closes positions on resolved markets and records
 * settlement PnL in the settlement_ledger table.
 *
 * Uses the existing "closed" status (not a new "settled" variant) to avoid
 * churn in position-repository and strategy code that reads position status.
 * Resolution context is preserved in market_resolutions + settlement_ledger.
 */

import type Database from "better-sqlite3";
import type {
  PositionRepository,
  InventoryLotRepository,
  MarketRepository,
  Position,
} from "@plankton/domain";
import type { RuntimeEventMap } from "@plankton/domain";
import type { DetectedResolution, ResolutionCandidate } from "./resolution-detector.js";

export type SettledPosition = RuntimeEventMap["PositionSettled"];

const ALGO_REDEEM_RESOLUTION = "algo-redeem";
const ALGO_REDEEM_SETTLEMENT_PRICE = 0;

function normalizeOutcomeLabel(value: string): string {
  return value.trim().toLowerCase();
}

export class PositionSettler {
  private readonly db: Database.Database;
  private readonly settlementInsert: Database.Statement;
  private readonly settlementInsertOrIgnore: Database.Statement;

  constructor(
    private readonly positionRepo: PositionRepository,
    private readonly lotRepo: InventoryLotRepository,
    db: Database.Database,
    private readonly marketRepo?: MarketRepository,
  ) {
    this.db = db;
    this.settlementInsert = db.prepare(
      `INSERT INTO settlement_ledger
         (settlement_id, condition_id, position_id, token_id,
          resolution, settlement_price, size, delta, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.settlementInsertOrIgnore = db.prepare(
      `INSERT OR IGNORE INTO settlement_ledger
         (settlement_id, condition_id, position_id, token_id,
          resolution, settlement_price, size, delta, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /**
   * Settle positions triggered by the algorithm's REDEEM rule.
   * Unlike market-resolution settlement, the market may not actually be
   * resolved on-chain — the algo detected conditions (state=S1|S2 + price<0.05 +
   * hold_duration<=3600) that observationally correspond to near-certain loss.
   * Settles at price 0, marks resolution as "algo-redeem".
   *
   * Idempotent: already-closed positions are skipped; duplicate settlement_ledger
   * rows are ignored via INSERT OR IGNORE.
   */
  settleAlgoRedeem(conditionIds: readonly string[]): SettledPosition[] {
    if (!this.marketRepo) {
      throw new Error("settleAlgoRedeem requires marketRepo in constructor deps");
    }
    const marketRepo = this.marketRepo;
    const results: SettledPosition[] = [];
    const resolvedAt = new Date().toISOString();

    const runSettlement = this.db.transaction(() => {
      for (const conditionId of conditionIds) {
        const markets = marketRepo.findByConditionId(conditionId);
        for (const market of markets) {
          const position = this.positionRepo.findByTokenId(market.tokenId);
          if (!position || position.status === "closed") continue;

          const settlementPnl =
            (ALGO_REDEEM_SETTLEMENT_PRICE - position.avgEntryPrice) * position.size;

          this.lotRepo.settleAll(position.positionId);

          const settlementId = `algo-redeem-${conditionId}-${String(market.tokenId)}`;
          this.settlementInsertOrIgnore.run(
            settlementId,
            conditionId,
            String(position.positionId),
            String(market.tokenId),
            ALGO_REDEEM_RESOLUTION,
            ALGO_REDEEM_SETTLEMENT_PRICE,
            position.size,
            settlementPnl,
            resolvedAt,
          );

          this.positionRepo.save({
            ...position,
            status: "closed",
            size: 0,
            realizedPnl: position.realizedPnl + settlementPnl,
            currentValueUsdc: 0,
            closedAt: resolvedAt,
            updatedAt: resolvedAt,
          });

          results.push({
            positionId: position.positionId,
            tokenId: market.tokenId,
            resolution: ALGO_REDEEM_RESOLUTION,
            settlementPrice: ALGO_REDEEM_SETTLEMENT_PRICE,
            realizedPnl: settlementPnl,
            size: position.size,
            avgEntryPrice: position.avgEntryPrice,
            timestamp: Date.now(),
          });
        }
      }
    });
    runSettlement();

    return results;
  }

  settle(resolution: DetectedResolution): SettledPosition[] {
    const results: SettledPosition[] = [];

    // Wrap all settlement writes in a transaction for atomicity.
    // Without this, a crash between lot zeroing and position close
    // would leave the DB in an inconsistent state.
    const runSettlement = this.db.transaction(() => {
      for (const candidate of resolution.candidates) {
        const position = this.positionRepo.findByTokenId(candidate.tokenId);
        if (!position || position.status === "closed") continue;

        const settled = this.settleOne(position, candidate, resolution);
        if (settled) results.push(settled);
      }
    });
    runSettlement();

    return results;
  }

  private settleOne(
    position: Position,
    candidate: ResolutionCandidate,
    resolution: DetectedResolution,
  ): SettledPosition | null {
    const isWinner = resolution.winnerTokenId
      ? String(candidate.tokenId) === String(resolution.winnerTokenId)
      : normalizeOutcomeLabel(candidate.outcome) === normalizeOutcomeLabel(resolution.resolution);
    const settlementPrice = isWinner ? 1.0 : 0.0;
    const settlementPnl = (settlementPrice - position.avgEntryPrice) * position.size;

    // Zero out all inventory lots
    this.lotRepo.settleAll(position.positionId);

    // Record in settlement_ledger
    const settlementId = `settlement-${resolution.conditionId}-${String(candidate.tokenId)}`;
    this.settlementInsert.run(
      settlementId,
      resolution.conditionId,
      String(position.positionId),
      String(candidate.tokenId),
      resolution.resolution,
      settlementPrice,
      position.size,
      settlementPnl,
      resolution.resolvedAt,
    );

    // Close position using save() (existing pattern from inventory-handler)
    this.positionRepo.save({
      ...position,
      status: "closed",
      size: 0,
      realizedPnl: position.realizedPnl + settlementPnl,
      currentValueUsdc: 0,
      closedAt: resolution.resolvedAt,
      updatedAt: new Date().toISOString(),
    });

    return {
      positionId: position.positionId,
      tokenId: candidate.tokenId,
      resolution: resolution.resolution,
      settlementPrice,
      realizedPnl: settlementPnl,
      size: position.size,
      avgEntryPrice: position.avgEntryPrice,
      timestamp: Date.now(),
    };
  }
}

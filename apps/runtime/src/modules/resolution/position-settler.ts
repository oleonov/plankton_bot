/**
 * PositionSettler — closes positions on resolved markets and records
 * settlement PnL in the settlement_ledger table.
 *
 * Uses existing "closed" status (not a new "settled" variant) to avoid
 * blast radius across family-exposure, position-repository, and strategy code.
 * Resolution context is preserved in market_resolutions + settlement_ledger.
 */

import type Database from "better-sqlite3";
import type { PositionRepository, InventoryLotRepository, Position } from "@plankton/domain";
import type { RuntimeEventMap } from "@plankton/domain";
import type { DetectedResolution, ResolutionCandidate } from "./resolution-detector.js";

export type SettledPosition = RuntimeEventMap["PositionSettled"];

export class PositionSettler {
  private readonly db: Database.Database;
  private readonly settlementInsert: Database.Statement;

  constructor(
    private readonly positionRepo: PositionRepository,
    private readonly lotRepo: InventoryLotRepository,
    db: Database.Database,
  ) {
    this.db = db;
    this.settlementInsert = db.prepare(
      `INSERT INTO settlement_ledger
         (settlement_id, condition_id, position_id, token_id, family_id,
          resolution, settlement_price, size, delta, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
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
      : candidate.outcome === resolution.resolution;
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
      String(position.familyId),
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
      familyId: position.familyId,
      resolution: resolution.resolution,
      settlementPrice,
      realizedPnl: settlementPnl,
      size: position.size,
      avgEntryPrice: position.avgEntryPrice,
      timestamp: Date.now(),
    };
  }
}

/**
 * Inventory Handler — processes FillReceived events to maintain
 * Position and InventoryLot state.
 *
 * Responsibilities:
 *  - Create/update Position on buy fills (new lot, update avgEntryPrice/costBasis)
 *  - Consume FIFO lots on sell fills (update realizedPnl, close position if depleted)
 *  - Persist Position and InventoryLot changes
 *  - Return position for downstream event publication
 *
 * Does NOT publish events — the parent module handles that.
 */

import type Database from "better-sqlite3";
import type {
  PositionRepository,
  InventoryLotRepository,
  Position,
  InventoryLot,
  FillId,
  TokenId,
  ConditionId,
} from "@plankton/domain";
import { createPositionId, createLotId } from "@plankton/domain";
import type { Logger } from "../../logger.js";
import { resolveOpenPositionStatus } from "../../position-status.js";

export interface FillEvent {
  fillId: FillId;
  tokenId: TokenId;
  conditionId: ConditionId;
  side: "buy" | "sell";
  price: number;
  size: number;
  sizeUsdc: number;
  fee: number;
  signalReason: string | null;
  timestamp: number;
}

export class InventoryHandler {
  private readonly pnlLedgerInsert: Database.Statement;

  constructor(
    private readonly positionRepo: PositionRepository,
    private readonly lotRepo: InventoryLotRepository,
    private readonly log: Logger,
    db: Database.Database,
  ) {
    this.pnlLedgerInsert = db.prepare(
      `INSERT INTO pnl_ledger (fill_id, position_id, family_id, delta, filled_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
  }

  /**
   * Apply a fill to inventory state. Returns the updated position.
   * Throws if a sell fill exceeds available inventory.
   */
  applyFill(fill: FillEvent): Position {
    if (fill.side === "buy") {
      return this.applyBuyFill(fill);
    }
    return this.applySellFill(fill);
  }

  private applyBuyFill(fill: FillEvent): Position {
    const existing = this.positionRepo.findByTokenId(fill.tokenId);

    if (existing) {
      return this.addToPosition(existing, fill);
    }
    return this.createNewPosition(fill);
  }

  private createNewPosition(fill: FillEvent): Position {
    const now = new Date().toISOString();
    const positionId = createPositionId(`pos-${fill.tokenId}-${Date.now()}`);

    const position: Position = {
      positionId,
      tokenId: fill.tokenId,
      conditionId: fill.conditionId,
      side: "buy",
      size: fill.size,
      avgEntryPrice: fill.price,
      costBasisUsdc: fill.sizeUsdc,
      currentValueUsdc: fill.sizeUsdc,
      realizedPnl: 0,
      status: "open",
      entryStyle: fill.signalReason === "spray-entry" ? "spray" : "probe",
      openedAt: now,
      closedAt: null,
      updatedAt: now,
    };
    this.positionRepo.save(position);

    // Create inventory lot
    const lot: InventoryLot = {
      lotId: createLotId(`lot-${fill.fillId}`),
      positionId,
      tokenId: fill.tokenId,
      side: "buy",
      size: fill.size,
      remainingSize: fill.size,
      entryPrice: fill.price,
      costUsdc: fill.sizeUsdc,
      fillId: fill.fillId,
      createdAt: now,
    };
    this.lotRepo.save(lot);

    this.log.info({ positionId, tokenId: fill.tokenId, size: fill.size }, "new position created");

    return position;
  }

  private addToPosition(existing: Position, fill: FillEvent): Position {
    const now = new Date().toISOString();
    const newSize = existing.size + fill.size;
    const newCostBasis = existing.costBasisUsdc + fill.sizeUsdc;
    const newAvgPrice = newCostBasis / newSize;

    const updated: Position = {
      ...existing,
      size: newSize,
      avgEntryPrice: newAvgPrice,
      costBasisUsdc: newCostBasis,
      currentValueUsdc: newSize * fill.price,
      status: "open",
      updatedAt: now,
    };
    this.positionRepo.save(updated);

    // Create inventory lot for this fill
    const lot: InventoryLot = {
      lotId: createLotId(`lot-${fill.fillId}`),
      positionId: existing.positionId,
      tokenId: fill.tokenId,
      side: "buy",
      size: fill.size,
      remainingSize: fill.size,
      entryPrice: fill.price,
      costUsdc: fill.sizeUsdc,
      fillId: fill.fillId,
      createdAt: now,
    };
    this.lotRepo.save(lot);

    this.log.debug(
      { positionId: existing.positionId, newSize, newAvgPrice: newAvgPrice.toFixed(4) },
      "position scaled in",
    );

    return updated;
  }

  private applySellFill(fill: FillEvent): Position {
    const existing = this.positionRepo.findByTokenId(fill.tokenId);
    if (!existing) {
      this.log.error(
        { tokenId: fill.tokenId, fillId: fill.fillId },
        "sell fill for unknown position — inventory drift detected",
      );
      throw new Error(
        `Inventory drift: sell fill ${fill.fillId} for token ${fill.tokenId} ` +
          `has no matching open position`,
      );
    }

    // Consume FIFO lots
    const consumed = this.lotRepo.consumeFifo(existing.positionId, fill.size);

    // Calculate realized PnL from consumed lots
    let sellRealizedPnl = 0;
    let consumedCostBasis = 0;
    for (const { lot, consumed: qty } of consumed) {
      const lotCost = qty * lot.entryPrice;
      const lotRevenue = qty * fill.price;
      sellRealizedPnl += lotRevenue - lotCost;
      consumedCostBasis += lotCost;
    }
    sellRealizedPnl -= fill.fee;

    // Persist realized PnL delta for historical series
    this.pnlLedgerInsert.run(
      fill.fillId,
      existing.positionId,
      null,
      sellRealizedPnl,
      new Date(fill.timestamp).toISOString(),
    );

    const now = new Date().toISOString();
    const newSize = existing.size - fill.size;
    const newCostBasis = existing.costBasisUsdc - consumedCostBasis;
    const newRealizedPnl = existing.realizedPnl + sellRealizedPnl;

    // Determine new status
    let status: "open" | "closed" | "dust";
    if (newSize <= 0) {
      status = "closed";
    } else {
      status = resolveOpenPositionStatus(newSize * fill.price);
    }

    // Recompute avg entry price from remaining lots
    const remainingLots = this.lotRepo.findOpen(existing.positionId);
    let remainingAvgPrice = existing.avgEntryPrice;
    if (remainingLots.length > 0) {
      const totalRemaining = remainingLots.reduce((s, l) => s + l.remainingSize, 0);
      const totalCost = remainingLots.reduce((s, l) => s + l.remainingSize * l.entryPrice, 0);
      remainingAvgPrice = totalRemaining > 0 ? totalCost / totalRemaining : 0;
    }

    const updated: Position = {
      ...existing,
      size: Math.max(0, newSize),
      avgEntryPrice: remainingAvgPrice,
      costBasisUsdc: Math.max(0, newCostBasis),
      currentValueUsdc: newSize > 0 ? newSize * fill.price : null,
      realizedPnl: newRealizedPnl,
      status,
      closedAt: status === "closed" ? now : existing.closedAt,
      updatedAt: now,
    };
    this.positionRepo.save(updated);

    this.log.info(
      {
        positionId: existing.positionId,
        newSize: updated.size,
        realizedPnl: sellRealizedPnl.toFixed(4),
        status,
      },
      "sell fill applied",
    );

    return updated;
  }
}

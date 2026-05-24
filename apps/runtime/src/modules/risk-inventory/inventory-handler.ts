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
} from "@krabs/domain";
import { createPositionId, createLotId } from "@krabs/domain";
import { withImmediate } from "@krabs/db";
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
    private readonly db: Database.Database,
    private readonly latestMinOrderSize?: (tokenId: TokenId) => number | null,
  ) {
    this.pnlLedgerInsert = db.prepare(resolvePnlLedgerInsertSql(db));
  }

  /**
   * Apply a fill to inventory state. Returns the updated position.
   * Throws if a sell fill exceeds available inventory.
   */
  applyFill(fill: FillEvent): Position {
    return withImmediate(this.db, () => {
      if (fill.side === "buy") {
        return this.applyBuyFill(fill);
      }
      return this.applySellFill(fill);
    });
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
    const unitCost = fill.size > 0 ? fill.sizeUsdc / fill.size : fill.price;

    const position: Position = {
      positionId,
      tokenId: fill.tokenId,
      conditionId: fill.conditionId,
      side: "buy",
      size: fill.size,
      avgEntryPrice: unitCost,
      costBasisUsdc: fill.sizeUsdc,
      currentValueUsdc: fill.sizeUsdc,
      realizedPnl: 0,
      status: "open",
      entryStyle: "probe",
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
      entryPrice: unitCost,
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
    const unitCost = fill.size > 0 ? fill.sizeUsdc / fill.size : fill.price;

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
      entryPrice: unitCost,
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

    let consumed: { lot: InventoryLot; consumed: number }[];
    try {
      consumed = this.lotRepo.consumeFifo(existing.positionId, fill.size);
    } catch (err) {
      const repaired = this.tryRepairPartiallyAppliedSellFill(existing, fill, err);
      if (repaired) return repaired;
      throw err;
    }

    // Calculate realized PnL from consumed lots
    let sellRealizedPnl = 0;
    for (const { lot, consumed: qty } of consumed) {
      const lotCost = qty * lot.entryPrice;
      const lotRevenue = qty * fill.price;
      sellRealizedPnl += lotRevenue - lotCost;
    }
    sellRealizedPnl -= fill.fee;

    return this.saveSellOutcome(
      existing,
      fill,
      sellRealizedPnl,
      this.lotRepo.findOpen(existing.positionId),
    );
  }

  private tryRepairPartiallyAppliedSellFill(
    existing: Position,
    fill: FillEvent,
    err: unknown,
  ): Position | null {
    if (!isInsufficientInventoryError(err)) return null;

    const remainingLots = this.lotRepo.findOpen(existing.positionId);
    const remainingSize = remainingLots.reduce((sum, lot) => sum + lot.remainingSize, 0);
    const expectedRemainingSize = Math.max(0, existing.size - fill.size);
    if (!nearlyEqual(remainingSize, expectedRemainingSize)) return null;

    const remainingCostBasis = remainingLots.reduce(
      (sum, lot) => sum + lot.remainingSize * lot.entryPrice,
      0,
    );
    const consumedCostBasis = Math.max(0, existing.costBasisUsdc - remainingCostBasis);
    const sellRealizedPnl = fill.size * fill.price - consumedCostBasis - fill.fee;

    this.log.warn(
      {
        positionId: existing.positionId,
        fillId: fill.fillId,
        remainingSize,
        expectedRemainingSize,
      },
      "repairing partially applied sell fill",
    );

    return this.saveSellOutcome(existing, fill, sellRealizedPnl, remainingLots);
  }

  private saveSellOutcome(
    existing: Position,
    fill: FillEvent,
    sellRealizedPnl: number,
    remainingLots: InventoryLot[],
  ): Position {
    this.pnlLedgerInsert.run(
      fill.fillId,
      existing.positionId,
      sellRealizedPnl,
      new Date(fill.timestamp).toISOString(),
    );

    const now = new Date().toISOString();
    const remainingSize = remainingLots.reduce((sum, lot) => sum + lot.remainingSize, 0);
    const remainingCostBasis = remainingLots.reduce(
      (sum, lot) => sum + lot.remainingSize * lot.entryPrice,
      0,
    );
    const newRealizedPnl = existing.realizedPnl + sellRealizedPnl;
    const status =
      remainingSize <= 0
        ? "closed"
        : resolveOpenPositionStatus(remainingSize * fill.price, {
            size: remainingSize,
            minOrderSize: this.latestMinOrderSize?.(fill.tokenId) ?? null,
          });
    const remainingAvgPrice = remainingSize > 0 ? remainingCostBasis / remainingSize : 0;

    const updated: Position = {
      ...existing,
      size: remainingSize,
      avgEntryPrice: remainingAvgPrice,
      costBasisUsdc: remainingCostBasis,
      currentValueUsdc: remainingSize > 0 ? remainingSize * fill.price : null,
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

function isInsufficientInventoryError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Insufficient inventory");
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-6;
}

function resolvePnlLedgerInsertSql(db: Database.Database): string {
  if (hasPnlLedgerFamilyId(db)) {
    return `INSERT INTO pnl_ledger (fill_id, position_id, family_id, delta, filled_at)
            VALUES (?, ?, 'legacy', ?, ?)`;
  }

  return `INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at)
          VALUES (?, ?, ?, ?)`;
}

function hasPnlLedgerFamilyId(db: Database.Database): boolean {
  try {
    const statement = db.prepare("PRAGMA table_info(pnl_ledger)") as { all?: () => unknown[] };
    if (typeof statement.all !== "function") return false;
    return (statement.all() as Array<{ name?: string }>).some(
      (column) => column.name === "family_id",
    );
  } catch {
    return false;
  }
}

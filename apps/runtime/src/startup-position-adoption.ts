import type Database from "better-sqlite3";
import type {
  BotRunId,
  ExchangeFill,
  ExchangeGateway,
  FamilyRulesProvider,
  FamilyStateRepository,
  FillRepository,
  MarketRepository,
  Order,
  OrderRepository,
  PositionRepository,
  InventoryLotRepository,
  ClientOrderId,
  FamilyId,
} from "@plankton/domain";
import { createFamilyId, createFillId, createOrderId } from "@plankton/domain";
import type { Logger } from "./logger.js";
import { InventoryHandler } from "./modules/risk-inventory/inventory-handler.js";
import { FamilyExposureCalculator } from "./modules/risk-inventory/family-exposure.js";
import {
  buildLocalFillFromExchangeFill,
  findLocalOrderForExchangeFill,
  importExchangeFills,
  updateOrderStatusFromPersistedFills,
} from "./modules/reconciliation/fill-reconciler.js";

export interface StartupPositionAdoptionDeps {
  gateway: Pick<ExchangeGateway, "getFills">;
  marketRepo: MarketRepository;
  orderRepo: OrderRepository;
  fillRepo: FillRepository;
  positionRepo: PositionRepository;
  inventoryLotRepo: InventoryLotRepository;
  familyStateRepo: FamilyStateRepository;
  rulesProvider: FamilyRulesProvider;
  log: Logger;
  db: Database.Database;
  botRunId: BotRunId;
}

export interface StartupPositionAdoptionResult {
  scannedFills: number;
  alreadyKnownFills: number;
  appliedFills: number;
  adoptedOrphanFills: number;
  syntheticOrdersCreated: number;
  positionsCreated: number;
  cleanedSyntheticOrders: number;
  cleanedSyntheticFills: number;
  cleanedSyntheticTokens: number;
  skippedInvalidTimestamp: number;
  skippedNoMarket: number;
  skippedNoFamily: number;
  skippedInventoryDrift: number;
  details: string[];
}

interface PendingFill {
  fill: ExchangeFill;
  localOrder: Order | null;
  orphanGroupKey: string | null;
}

interface SyntheticOrderSeed {
  orderId: string;
  exchangeOrderId: string | null;
  clientOrderId: ClientOrderId;
  tokenId: Order["tokenId"];
  familyId: Order["familyId"];
  side: Order["side"];
  size: number;
  sizeUsdc: number;
  price: number;
  createdAt: string;
}

interface StartupAdoptionCleanupResult {
  orderIds: string[];
  fillIds: string[];
  tokenIds: string[];
  familyIds: FamilyId[];
}

const SYNTHETIC_SIGNAL_REASON = "startup-adoption";
const DUST_THRESHOLD_USDC = 0.5;

export async function runStartupPositionAdoption(
  deps: StartupPositionAdoptionDeps,
): Promise<StartupPositionAdoptionResult> {
  const log = deps.log.child({ module: "startup-position-adoption" });
  const inventory = new InventoryHandler(deps.positionRepo, deps.inventoryLotRepo, log, deps.db);
  const exposure = new FamilyExposureCalculator(
    deps.familyStateRepo,
    deps.positionRepo,
    deps.inventoryLotRepo,
    log,
    deps.rulesProvider,
  );

  const rawFills = await deps.gateway.getFills(0);

  const result: StartupPositionAdoptionResult = {
    scannedFills: rawFills.length,
    alreadyKnownFills: 0,
    appliedFills: 0,
    adoptedOrphanFills: 0,
    syntheticOrdersCreated: 0,
    positionsCreated: 0,
    cleanedSyntheticOrders: 0,
    cleanedSyntheticFills: 0,
    cleanedSyntheticTokens: 0,
    skippedInvalidTimestamp: 0,
    skippedNoMarket: 0,
    skippedNoFamily: 0,
    skippedInventoryDrift: 0,
    details: [],
  };
  const familiesToRecompute = new Set<string>();

  const cleanup = cleanupPriorStartupAdoptionArtifacts(deps);
  result.cleanedSyntheticOrders = cleanup.orderIds.length;
  result.cleanedSyntheticFills = cleanup.fillIds.length;
  result.cleanedSyntheticTokens = cleanup.tokenIds.length;
  cleanup.familyIds.forEach((familyId) => familiesToRecompute.add(String(familyId)));

  const fills: ExchangeFill[] = [];
  for (const fill of rawFills) {
    const timestamp = normalizeFillTimestamp(fill.timestamp);
    if (timestamp === null) {
      result.skippedInvalidTimestamp++;
      result.details.push(
        `fill ${fill.fillId} skipped — invalid timestamp ${String(fill.timestamp)}`,
      );
      log.warn(
        { fillId: fill.fillId, rawTimestamp: fill.timestamp },
        "startup adoption skipped — invalid fill timestamp",
      );
      continue;
    }
    fills.push({ ...fill, timestamp });
  }
  fills.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.fillId.localeCompare(b.fillId);
  });

  const pendingFills: PendingFill[] = [];
  const syntheticSeeds = new Map<string, SyntheticOrderSeed>();
  const syntheticOrders = new Map<string, Order>();

  for (const fill of fills) {
    if (deps.fillRepo.exists(createFillId(fill.fillId))) {
      result.alreadyKnownFills++;
      continue;
    }

    const localOrder = findLocalOrderForExchangeFill(deps.orderRepo, fill, log);
    if (localOrder) {
      pendingFills.push({ fill, localOrder, orphanGroupKey: null });
      continue;
    }

    const market = deps.marketRepo.findByTokenId(fill.tokenId);
    if (!market) {
      result.skippedNoMarket++;
      result.details.push(`fill ${fill.fillId} skipped — token ${fill.tokenId} not in market repo`);
      log.warn(
        { fillId: fill.fillId, tokenId: fill.tokenId },
        "startup adoption skipped — no market",
      );
      continue;
    }

    if (!market.familyId) {
      result.skippedNoFamily++;
      result.details.push(`fill ${fill.fillId} skipped — token ${fill.tokenId} has no family`);
      log.warn(
        { fillId: fill.fillId, tokenId: fill.tokenId },
        "startup adoption skipped — market has no family",
      );
      continue;
    }

    const orphanGroupKey = buildOrphanGroupKey(fill);
    const existing = syntheticSeeds.get(orphanGroupKey);
    const sizeUsdc = fill.size * fill.price;

    if (existing) {
      const totalSize = existing.size + fill.size;
      const totalNotional = existing.sizeUsdc + sizeUsdc;
      existing.size = totalSize;
      existing.sizeUsdc = totalNotional;
      existing.price = totalSize > 0 ? totalNotional / totalSize : fill.price;
      if (fill.timestamp < new Date(existing.createdAt).getTime()) {
        existing.createdAt = new Date(fill.timestamp).toISOString();
      }
    } else {
      syntheticSeeds.set(orphanGroupKey, {
        orderId: resolveSyntheticOrderId(fill, orphanGroupKey),
        exchangeOrderId: resolveSyntheticExchangeOrderId(fill),
        clientOrderId: resolveSyntheticClientOrderId(fill, orphanGroupKey),
        tokenId: fill.tokenId,
        familyId: market.familyId,
        side: fill.side,
        size: fill.size,
        sizeUsdc,
        price: fill.price,
        createdAt: new Date(fill.timestamp).toISOString(),
      });
    }

    pendingFills.push({ fill, localOrder: null, orphanGroupKey });
  }

  const bus = { publish: async () => {} } as any;

  for (const pending of pendingFills) {
    const localOrder =
      pending.localOrder ??
      resolveSyntheticOrder(pending.orphanGroupKey!, syntheticSeeds, syntheticOrders, deps);
    const existingPosition = deps.positionRepo.findByTokenId(pending.fill.tokenId);

    try {
      // Use standard import logic so fee calculation matches exactly
      const importResult = await importExchangeFills([pending.fill], {
        fillRepo: deps.fillRepo,
        orderRepo: deps.orderRepo,
        rulesProvider: deps.rulesProvider,
        bus,
        log,
      });

      if (importResult.imported === 0) {
        continue;
      }

      const fillId = createFillId(pending.fill.fillId);
      const savedFill = deps.fillRepo
        .findByOrderId(localOrder.orderId)
        .find((f) => String(f.fillId) === String(fillId));

      if (!savedFill) {
        throw new Error(`fill ${pending.fill.fillId} not found after import`);
      }

      inventory.applyFill({
        fillId: savedFill.fillId,
        tokenId: pending.fill.tokenId,
        familyId: localOrder.familyId,
        side: pending.fill.side,
        price: pending.fill.price,
        size: pending.fill.size,
        sizeUsdc: savedFill.sizeUsdc,
        fee: savedFill.fee,
        signalReason: localOrder.signalReason ?? SYNTHETIC_SIGNAL_REASON,
        timestamp: pending.fill.timestamp,
      });
      deps.fillRepo.markReconciled([savedFill.fillId]);

      familiesToRecompute.add(String(localOrder.familyId));
      result.appliedFills++;
      if (!pending.localOrder) {
        result.adoptedOrphanFills++;
      }
      if (!existingPosition) {
        result.positionsCreated++;
      }
    } catch (err) {
      result.skippedInventoryDrift++;
      result.details.push(
        `fill ${pending.fill.fillId} skipped — inventory apply failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
      log.error(
        {
          err,
          fillId: pending.fill.fillId,
          tokenId: pending.fill.tokenId,
        },
        "startup adoption failed while applying fill",
      );
    }
  }

  for (const familyId of familiesToRecompute) {
    exposure.recompute(createFamilyId(familyId), true, false);
  }

  result.syntheticOrdersCreated = syntheticOrders.size;
  return result;
}

function cleanupPriorStartupAdoptionArtifacts(
  deps: StartupPositionAdoptionDeps,
): StartupAdoptionCleanupResult {
  const rows = deps.db
    .prepare(
      `SELECT DISTINCT
         o.order_id AS order_id,
         f.fill_id AS fill_id,
         f.token_id AS token_id,
         f.family_id AS family_id
       FROM orders o
       LEFT JOIN fills f ON f.order_id = o.order_id
       WHERE o.signal_reason = ?`,
    )
    .all(SYNTHETIC_SIGNAL_REASON) as Array<{
    order_id: string;
    fill_id: string | null;
    token_id: string | null;
    family_id: string | null;
  }>;

  const orderIds = [...new Set(rows.map((row) => row.order_id))];
  const fillIds = [...new Set(rows.map((row) => row.fill_id).filter(Boolean))] as string[];
  const tokenIds = [...new Set(rows.map((row) => row.token_id).filter(Boolean))] as string[];
  const familyIds = [...new Set(rows.map((row) => row.family_id).filter(Boolean))].map((familyId) =>
    createFamilyId(familyId as string),
  );

  if (orderIds.length === 0) {
    return { orderIds, fillIds, tokenIds, familyIds };
  }

  deps.db.transaction(() => {
    deleteWhereIn(deps.db, "pnl_ledger", "fill_id", fillIds);
    deleteWhereIn(deps.db, "inventory_lots", "fill_id", fillIds);
    deleteWhereIn(deps.db, "fills", "fill_id", fillIds);
    deleteWhereIn(deps.db, "orders", "order_id", orderIds);

    for (const tokenId of tokenIds) {
      rebuildTokenPosition(deps.db, tokenId);
    }
  })();

  deps.log.info(
    {
      cleanedSyntheticOrders: orderIds.length,
      cleanedSyntheticFills: fillIds.length,
      cleanedSyntheticTokens: tokenIds.length,
    },
    "cleared prior startup adoption artifacts before recovery",
  );

  return { orderIds, fillIds, tokenIds, familyIds };
}

function deleteWhereIn(
  db: Database.Database,
  table: string,
  column: string,
  values: string[],
): void {
  if (values.length === 0) return;
  const placeholders = values.map(() => "?").join(", ");
  db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...values);
}

function rebuildTokenPosition(db: Database.Database, tokenId: string): void {
  const openRows = db
    .prepare(
      `SELECT position_id, entry_style, opened_at
       FROM positions
       WHERE token_id = ? AND status != 'closed'
       ORDER BY opened_at DESC`,
    )
    .all(tokenId) as Array<{
    position_id: string;
    entry_style: "spray" | "probe" | null;
    opened_at: string;
  }>;

  const remainingLots = db
    .prepare(
      `SELECT position_id, family_id, remaining_size, entry_price, created_at
       FROM inventory_lots
       WHERE token_id = ? AND remaining_size > 0
       ORDER BY created_at ASC`,
    )
    .all(tokenId) as Array<{
    position_id: string;
    family_id: string;
    remaining_size: number;
    entry_price: number;
    created_at: string;
  }>;

  if (remainingLots.length === 0) {
    db.prepare(`DELETE FROM positions WHERE token_id = ? AND status != 'closed'`).run(tokenId);
    return;
  }

  const activePositionId = remainingLots[0]!.position_id;
  const totalSize = remainingLots.reduce((sum, lot) => sum + lot.remaining_size, 0);
  const totalCost = remainingLots.reduce(
    (sum, lot) => sum + lot.remaining_size * lot.entry_price,
    0,
  );
  const avgEntryPrice = totalSize > 0 ? totalCost / totalSize : 0;
  const realizedRow = db
    .prepare(`SELECT COALESCE(SUM(delta), 0) AS total FROM pnl_ledger WHERE position_id = ?`)
    .get(activePositionId) as { total: number } | undefined;
  const activeRow = openRows.find((row) => row.position_id === activePositionId);
  const entryStyle = activeRow?.entry_style ?? null;
  const openedAt = activeRow?.opened_at ?? remainingLots[0]!.created_at;
  const status = totalCost < DUST_THRESHOLD_USDC ? "dust" : "open";
  const familyId = remainingLots[0]!.family_id;
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE positions
     SET family_id = ?,
         side = 'buy',
         size = ?,
         avg_entry_price = ?,
         cost_basis_usdc = ?,
         current_value_usdc = ?,
         realized_pnl = ?,
         status = ?,
         entry_style = ?,
         opened_at = ?,
         closed_at = NULL,
         updated_at = ?
     WHERE position_id = ?`,
  ).run(
    familyId,
    totalSize,
    avgEntryPrice,
    totalCost,
    totalCost,
    realizedRow?.total ?? 0,
    status,
    entryStyle,
    openedAt,
    now,
    activePositionId,
  );

  if (openRows.length > 1) {
    db.prepare(
      `DELETE FROM positions WHERE token_id = ? AND status != 'closed' AND position_id != ?`,
    ).run(tokenId, activePositionId);
  }
}

function resolveSyntheticOrder(
  orphanGroupKey: string,
  seeds: Map<string, SyntheticOrderSeed>,
  orders: Map<string, Order>,
  deps: StartupPositionAdoptionDeps,
): Order {
  const cached = orders.get(orphanGroupKey);
  if (cached) {
    return cached;
  }

  const seed = seeds.get(orphanGroupKey);
  if (!seed) {
    throw new Error(`missing synthetic order seed for ${orphanGroupKey}`);
  }
  const existing = deps.orderRepo.findById(createOrderId(seed.orderId));
  if (existing) {
    orders.set(orphanGroupKey, existing);
    return existing;
  }

  const syntheticOrder: Order = {
    orderId: createOrderId(seed.orderId),
    clientOrderId: seed.clientOrderId,
    tokenId: seed.tokenId,
    familyId: seed.familyId,
    side: seed.side,
    orderType: "GTC",
    postOnly: false,
    price: seed.price,
    size: seed.size,
    sizeUsdc: seed.sizeUsdc,
    status: "filled",
    exchangeOrderId: seed.exchangeOrderId,
    signalId: null,
    signalReason: SYNTHETIC_SIGNAL_REASON,
    botRunId: deps.botRunId,
    createdAt: seed.createdAt,
    updatedAt: seed.createdAt,
  };
  deps.orderRepo.save(syntheticOrder);
  orders.set(orphanGroupKey, syntheticOrder);
  return syntheticOrder;
}

function normalizeFillTimestamp(timestamp: number): number | null {
  if (!Number.isFinite(timestamp)) return null;
  const abs = Math.abs(timestamp);
  if (abs === 0) return 0;
  return abs < 1_000_000_000_000 ? Math.trunc(timestamp * 1000) : Math.trunc(timestamp);
}

function buildOrphanGroupKey(fill: ExchangeFill): string {
  const orderId = fill.orderId.trim();
  if (orderId.length > 0) {
    return `exchange:${orderId}`;
  }

  const clientOrderId = fill.clientOrderId.trim();
  if (clientOrderId.length > 0) {
    return `client:${clientOrderId}`;
  }

  return `fill:${fill.fillId}`;
}

function resolveSyntheticOrderId(fill: ExchangeFill, orphanGroupKey: string): string {
  const orderId = fill.orderId.trim();
  if (orderId.length > 0) {
    return orderId;
  }
  return `adopt-${sanitizeKey(orphanGroupKey)}`;
}

function resolveSyntheticExchangeOrderId(fill: ExchangeFill): string | null {
  const orderId = fill.orderId.trim();
  return orderId.length > 0 ? orderId : null;
}

function resolveSyntheticClientOrderId(fill: ExchangeFill, orphanGroupKey: string): ClientOrderId {
  const clientOrderId = fill.clientOrderId.trim();
  if (clientOrderId.length > 0) {
    return clientOrderId as ClientOrderId;
  }
  return `adopt-${sanitizeKey(orphanGroupKey)}` as ClientOrderId;
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 120);
}

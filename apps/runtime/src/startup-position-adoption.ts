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
} from "@plankton/domain";
import { createFillId, createOrderId } from "@plankton/domain";
import type { Logger } from "./logger.js";
import { InventoryHandler } from "./modules/risk-inventory/inventory-handler.js";
import { FamilyExposureCalculator } from "./modules/risk-inventory/family-exposure.js";
import {
  buildLocalFillFromExchangeFill,
  findLocalOrderForExchangeFill,
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

const SYNTHETIC_SIGNAL_REASON = "startup-adoption";

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
    skippedInvalidTimestamp: 0,
    skippedNoMarket: 0,
    skippedNoFamily: 0,
    skippedInventoryDrift: 0,
    details: [],
  };

  const fills: ExchangeFill[] = [];
  for (const fill of rawFills) {
    const timestamp = normalizeFillTimestamp(fill.timestamp);
    if (timestamp === null) {
      result.skippedInvalidTimestamp++;
      result.details.push(`fill ${fill.fillId} skipped — invalid timestamp ${String(fill.timestamp)}`);
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

  for (const pending of pendingFills) {
    const localOrder =
      pending.localOrder ??
      resolveSyntheticOrder(pending.orphanGroupKey!, syntheticSeeds, syntheticOrders, deps);
    const existingPosition = deps.positionRepo.findByTokenId(pending.fill.tokenId);

    try {
      deps.db.transaction(() => {
        const resolved = buildLocalFillFromExchangeFill(pending.fill, localOrder);
        deps.fillRepo.save(resolved.fill);
        updateOrderStatusFromPersistedFills(deps.orderRepo, deps.fillRepo, localOrder.orderId);
        inventory.applyFill({
          fillId: resolved.fillId,
          tokenId: pending.fill.tokenId,
          familyId: localOrder.familyId,
          side: pending.fill.side,
          price: pending.fill.price,
          size: pending.fill.size,
          sizeUsdc: resolved.sizeUsdc,
          fee: pending.fill.fee,
          signalReason: localOrder.signalReason ?? SYNTHETIC_SIGNAL_REASON,
          timestamp: pending.fill.timestamp,
        });
        deps.fillRepo.markReconciled([resolved.fillId]);
        exposure.recompute(localOrder.familyId, pending.fill.side === "buy");
      })();

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

  result.syntheticOrdersCreated = syntheticOrders.size;
  return result;
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

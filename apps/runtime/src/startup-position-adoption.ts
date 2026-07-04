import type Database from "better-sqlite3";
import type {
  BotRunId,
  ConditionId,
  EventBus,
  ExchangeFill,
  ExchangeGateway,
  FillRepository,
  LegStateRepository,
  MarketRepository,
  Order,
  OrderRepository,
  PositionRepository,
  InventoryLotRepository,
  ClientOrderId,
  TokenId,
} from "@krabs/domain";
import { createFillId, createOrderId, createTokenId } from "@krabs/domain";
import type { Logger } from "./logger.js";
import { resolveOpenPositionStatus } from "./position-status.js";
import { InventoryHandler } from "./modules/risk-inventory/inventory-handler.js";
import {
  findLocalOrderForExchangeFill,
  importExchangeFills,
} from "./modules/reconciliation/fill-reconciler.js";
import { updateLegStateForFill } from "./modules/leg-state/update-leg-state-for-fill.js";

export interface StartupPositionAdoptionDeps {
  gateway: Pick<ExchangeGateway, "getFills" | "getMarketFeeInfo">;
  marketRepo: MarketRepository;
  orderRepo: OrderRepository;
  fillRepo: FillRepository;
  positionRepo: PositionRepository;
  inventoryLotRepo: InventoryLotRepository;
  legStateRepo: LegStateRepository;
  log: Logger;
  db: Database.Database;
  botRunId: BotRunId;
  /** Relative fill-completion tolerance forwarded to importExchangeFills (#36). */
  fillCompletionTolerance?: number | undefined;
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
  skippedInventoryDrift: number;
  seededLegStates: number;
  alreadyPresentLegStates: number;
  positionsWithoutFills: TokenId[];
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
  conditionId: ConditionId;
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
}

const SYNTHETIC_SIGNAL_REASON = "startup-adoption";

export async function runStartupPositionAdoption(
  deps: StartupPositionAdoptionDeps,
): Promise<StartupPositionAdoptionResult> {
  const log = deps.log.child({ module: "startup-position-adoption" });
  const inventory = new InventoryHandler(deps.positionRepo, deps.inventoryLotRepo, log, deps.db);

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
    skippedInventoryDrift: 0,
    seededLegStates: 0,
    alreadyPresentLegStates: 0,
    positionsWithoutFills: [],
    details: [],
  };
  const cleanup = cleanupPriorStartupAdoptionArtifacts(deps);
  result.cleanedSyntheticOrders = cleanup.orderIds.length;
  result.cleanedSyntheticFills = cleanup.fillIds.length;
  result.cleanedSyntheticTokens = cleanup.tokenIds.length;

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

    const orphanGroupKey = buildOrphanGroupKey(fill);
    const existing = syntheticSeeds.get(orphanGroupKey);
    // Prefer exchange notional when present; fee remains separate from
    // position size/cost basis and is applied through the fill fee field.
    const sizeUsdc = fill.sizeUsdc ?? (fill.grossSize ?? fill.size) * fill.price;

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
        conditionId: market.conditionId as ConditionId,
        side: fill.side,
        size: fill.size,
        sizeUsdc,
        price: fill.price,
        createdAt: new Date(fill.timestamp).toISOString(),
      });
    }

    pendingFills.push({ fill, localOrder: null, orphanGroupKey });
  }

  // Startup adoption replays historical fills from the exchange to rebuild
  // local inventory; the downstream FillReceived handlers (risk gate, signal
  // bridge) must not react to that replay as if the fills were live. A typed
  // no-op bus satisfies importExchangeFills's EventBus contract while dropping
  // the publish side-effect on the floor.
  const bus: EventBus = {
    publish: async () => {},
    subscribe: () => () => {},
    drain: async () => {},
  };

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
        bus,
        log,
        gateway: deps.gateway,
        fillCompletionTolerance: deps.fillCompletionTolerance,
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
        conditionId: savedFill.conditionId,
        side: pending.fill.side,
        price: pending.fill.price,
        size: savedFill.size,
        sizeUsdc: savedFill.sizeUsdc,
        fee: savedFill.fee,
        signalReason: localOrder.signalReason ?? SYNTHETIC_SIGNAL_REASON,
        entryStyle: localOrder.entryStyle ?? null,
        timestamp: pending.fill.timestamp,
      });
      deps.fillRepo.markReconciled([savedFill.fillId]);

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

  rebuildLegStatesFromLedger(deps, result, log);

  return result;
}

/**
 * Seed `leg_states` from the ledger for any active token that has no row yet.
 *
 * Why this belongs in startup adoption: adoption applies fills through a
 * no-op bus (the supervisor has not started, `LegStateTrackerModule` is not
 * subscribed yet), which means restart flow never populates `leg_states` from
 * the adopted fills. `AlgoDecisionModule.decide` treats a missing leg_state
 * as "first entry" and can fire a fresh probe-entry against an existing open
 * position on the next tick.
 *
 * Replay fills through `updateLegStateForFill` in deterministic
 * (filled_at ASC, fill_id ASC) order so that the result is byte-identical to
 * the live path regardless of tie ordering. Token dedup is performed up-front
 * — a token with coexisting open + dust rows must not have its fills counted
 * twice.
 */
function rebuildLegStatesFromLedger(
  deps: StartupPositionAdoptionDeps,
  result: StartupPositionAdoptionResult,
  log: Logger,
): void {
  const activeTokens = deps.db
    .prepare(
      `SELECT DISTINCT token_id FROM positions
        WHERE status != 'closed'
          AND NOT EXISTS (
            SELECT 1 FROM leg_states ls WHERE ls.token_id = positions.token_id
          )`,
    )
    .all() as Array<{ token_id: string }>;

  const existingLegStateCount = deps.db
    .prepare(
      `SELECT COUNT(*) AS c FROM leg_states ls
        WHERE EXISTS (
          SELECT 1 FROM positions p
           WHERE p.token_id = ls.token_id AND p.status != 'closed'
        )`,
    )
    .get() as { c: number };
  result.alreadyPresentLegStates = existingLegStateCount.c;

  if (activeTokens.length === 0) return;

  // ADR-027 §D-B — scope replay so that fills from prior closed legs on the
  // same token don't bleed into the active leg's cumulative_*, buy/sell
  // counts, or first_trade_at. We pick the largest `closed_at` strictly less
  // than the active leg's `opened_at`: that's the chronologically-prior
  // close. Filtering on `closed_at < active.opened_at` is essential because
  // bootstrap's duplicate-open repair (`ensureUniqueOpenPositionIndex` in
  // packages/db/src/bootstrap.ts) writes `closed_at = datetime('now')`,
  // which would otherwise outrank any real prior close and mask out the
  // active leg's own fills. Using `closed_at` (rather than `opened_at`) for
  // the prior leg avoids the clock-skew gap between exchange `filled_at`
  // (event-time) and the active position's `opened_at` (wall-clock at handler
  // time): the active opening fill can have `filled_at < active.opened_at`,
  // but it always has `filled_at > prior.closed_at` since the prior leg's
  // closure happened chronologically earlier on the wire.
  //
  // Comparisons go through `julianday()` because the duplicate-open repair
  // writes SQLite's `datetime('now')` format (`YYYY-MM-DD HH:MM:SS`) while
  // runtime opens/fills/closes are ISO strings (`YYYY-MM-DDTHH:mm:ss.sssZ`).
  // Lexical ordering disagrees with chronological ordering on the same calendar
  // day (space sorts before `T`), so a same-day synthetic close would falsely
  // qualify as "prior" without numeric time parsing.
  //
  // When no prior closed leg exists, fall back to no lower bound — there is
  // nothing to leak from.
  const priorCloseStmt = deps.db.prepare(
    `SELECT MAX(closed_at) AS max_closed_at FROM positions
       WHERE token_id = ?
         AND status = 'closed'
         AND closed_at IS NOT NULL
         AND julianday(closed_at) < julianday(?)`,
  );
  const selectFillsScoped = deps.db.prepare(
    `SELECT fill_id, token_id, condition_id, side, price, size, size_usdc, filled_at
       FROM fills
      WHERE token_id = ?
        AND julianday(filled_at) > julianday(?)
      ORDER BY filled_at ASC, fill_id ASC`,
  );

  const now = new Date().toISOString();

  for (const { token_id } of activeTokens) {
    const tokenId = createTokenId(token_id);
    const activePosition = deps.positionRepo.findByTokenId(tokenId);
    const activeOpenedAt = activePosition?.openedAt ?? "9999-12-31T23:59:59.999Z";
    const priorClose = priorCloseStmt.get(token_id, activeOpenedAt) as
      | { max_closed_at: string | null }
      | undefined;
    const replayLowerBound = priorClose?.max_closed_at ?? "1970-01-01T00:00:00.000Z";
    const fills = selectFillsScoped.all(token_id, replayLowerBound) as Array<{
      fill_id: string;
      token_id: string;
      condition_id: string | null;
      side: "buy" | "sell";
      price: number;
      size: number | null;
      size_usdc: number | null;
      filled_at: string;
    }>;

    if (fills.length === 0) {
      result.positionsWithoutFills.push(tokenId);
      log.warn(
        {
          tokenId: token_id,
          priorCloseAt: priorClose?.max_closed_at ?? null,
          activeOpenedAt: activePosition?.openedAt ?? null,
        },
        "startup leg-state rebuild — active position has no matching fills",
      );
      continue;
    }

    for (const f of fills) {
      updateLegStateForFill(
        deps.legStateRepo,
        {
          tokenId: createTokenId(f.token_id),
          side: f.side,
          price: f.price,
          filledAt: f.filled_at,
          size: f.size,
          sizeUsdc: f.size_usdc,
        },
        log,
        now,
      );
    }

    // Synthetic orphan-adoption fills can land with price=0 when the
    // exchange fill lacks a usable price. Fall back to the canonical
    // position's avg_entry_price so the leg_state reflects economic reality.
    const seeded = deps.legStateRepo.get(tokenId);
    if (seeded && seeded.firstTradePrice === 0) {
      const position = deps.positionRepo.findByTokenId(tokenId);
      if (position && position.avgEntryPrice > 0) {
        deps.legStateRepo.upsert({
          ...seeded,
          firstTradePrice: position.avgEntryPrice,
          updatedAt: now,
        });
      }
    }

    if (deps.legStateRepo.get(tokenId)) {
      result.seededLegStates += 1;
    }
  }
}

/**
 * Durable orphan-loop guard (Option B1). A fill that is already `reconciled = 1`
 * AND recorded in `leg_state_transitions` is terminal: it has been fully
 * processed and must never be re-adopted. Removing its synthetic adoption order
 * here would make `rebuildTokenPosition` + re-adoption replay the fill via
 * `consumeFifo`, over-consuming lots and re-triggering the self-perpetuating
 * "Insufficient inventory" loop (see
 * research_plankton/inventory_drift_investigation_2026-06-10.md §6-8).
 *
 * Fail-safe by design: returns `true` (preserve) ONLY on positive confirmation
 * of both conditions. A missing fill id, an absent fill row, an unreconciled
 * fill, or a fill not yet in leg state all return `false`, so the existing
 * removal behavior is preserved for every non-pathological case.
 */
export function isTerminalReconciledOrphan(db: Database.Database, fillId: string | null): boolean {
  if (!fillId) return false;
  const fill = db.prepare("SELECT reconciled FROM fills WHERE fill_id = ?").get(fillId) as
    | { reconciled: number }
    | undefined;
  if (!fill || fill.reconciled !== 1) return false;
  const legState = db
    .prepare("SELECT 1 AS present FROM leg_state_transitions WHERE fill_id = ? LIMIT 1")
    .get(fillId) as { present: number } | undefined;
  return legState !== undefined;
}

export function cleanupPriorStartupAdoptionArtifacts(
  deps: StartupPositionAdoptionDeps,
): StartupAdoptionCleanupResult {
  const rows = deps.db
    .prepare(
      `SELECT DISTINCT
         o.order_id AS order_id,
         f.fill_id AS fill_id,
         f.token_id AS token_id
       FROM orders o
       LEFT JOIN fills f ON f.order_id = o.order_id
       WHERE o.signal_reason = ?`,
    )
    .all(SYNTHETIC_SIGNAL_REASON) as Array<{
    order_id: string;
    fill_id: string | null;
    token_id: string | null;
  }>;

  // Never remove artifacts whose fill is a terminal reconciled orphan — doing so
  // restarts the over-consumption loop. Preserve the whole order if any of its
  // fills is terminal (conservative: errs toward not re-adopting).
  const skipOrderIds = new Set(
    rows
      .filter((row) => isTerminalReconciledOrphan(deps.db, row.fill_id))
      .map((row) => row.order_id),
  );
  const removableRows = rows.filter((row) => !skipOrderIds.has(row.order_id));

  const orderIds = [...new Set(removableRows.map((row) => row.order_id))];
  const fillIds = [...new Set(removableRows.map((row) => row.fill_id).filter(Boolean))] as string[];
  const tokenIds = [
    ...new Set(removableRows.map((row) => row.token_id).filter(Boolean)),
  ] as string[];

  if (skipOrderIds.size > 0) {
    deps.log.info(
      { preservedReconciledOrphanOrders: skipOrderIds.size },
      "preserved reconciled orphan adoption artifacts (orphan-loop guard)",
    );
  }

  if (orderIds.length === 0) {
    return { orderIds, fillIds, tokenIds };
  }

  deps.db.transaction(() => {
    deleteWhereIn(deps.db, "pnl_ledger", "fill_id", fillIds);
    deleteWhereIn(deps.db, "inventory_lots", "fill_id", fillIds);
    deleteWhereIn(deps.db, "fills", "fill_id", fillIds);
    deleteWhereIn(deps.db, "orders", "order_id", orderIds);

    for (const tokenId of tokenIds) {
      rebuildTokenPosition(deps.db, tokenId, deps.log);
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

  return { orderIds, fillIds, tokenIds };
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

function rebuildTokenPosition(db: Database.Database, tokenId: string, log: Logger): void {
  // Winner selection matches the DB invariant:
  //   `idx_positions_unique_open_per_token` + migration 032 repair rule =
  //   `opened_at DESC, position_id DESC`.
  // Tie-break on position_id DESC eliminates SQLite's implementation-defined
  // ordering when two rows share the same opened_at.
  const openRows = db
    .prepare(
      `SELECT position_id, entry_style, opened_at
       FROM positions
       WHERE token_id = ? AND status != 'closed'
       ORDER BY opened_at DESC, position_id DESC`,
    )
    .all(tokenId) as Array<{
    position_id: string;
    entry_style: "probe" | "maker" | null;
    opened_at: string;
  }>;

  const remainingLots = db
    .prepare(
      `SELECT position_id, remaining_size, entry_price, created_at
       FROM inventory_lots
       WHERE token_id = ? AND remaining_size > 0
       ORDER BY created_at ASC`,
    )
    .all(tokenId) as Array<{
    position_id: string;
    remaining_size: number;
    entry_price: number;
    created_at: string;
  }>;

  if (remainingLots.length === 0) {
    db.prepare(`DELETE FROM positions WHERE token_id = ? AND status != 'closed'`).run(tokenId);
    return;
  }

  if (openRows.length > 1) {
    log.warn(
      {
        tokenId,
        duplicateCount: openRows.length,
        canonicalPositionId: openRows[0]!.position_id,
        closedPositionIds: openRows.slice(1).map((r) => r.position_id),
      },
      "startup adoption repair — multiple non-closed positions for same token (invariant bypassed)",
    );
  }

  const activePositionId = openRows[0]?.position_id ?? remainingLots[0]!.position_id;
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
  const status = resolveOpenPositionStatus(totalCost, { size: totalSize, minOrderSize: null });
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE positions
     SET side = 'buy',
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
    conditionId: seed.conditionId,
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

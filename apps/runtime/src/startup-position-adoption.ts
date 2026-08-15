import type Database from "better-sqlite3";
import type {
  BotRunId,
  ConditionId,
  EventBus,
  ExchangeFill,
  ExchangeGateway,
  ExchangeOrder,
  FetchResult,
  FillRepository,
  LegStateRepository,
  MarketRepository,
  Order,
  OrderRepository,
  PositionId,
  PositionRepository,
  InventoryLotRepository,
  ClientOrderId,
  TokenId,
} from "@krabs/domain";
import { createFillId, createOrderId, createTokenId } from "@krabs/domain";
import { ledgerInstant, parseLedgerInstantMs, withImmediate } from "@krabs/db";
import type { Logger } from "./logger.js";
import { resolveOpenPositionStatus } from "./position-status.js";
import { InventoryHandler } from "./modules/risk-inventory/inventory-handler.js";
import {
  findLocalOrderForExchangeFill,
  importExchangeFills,
} from "./modules/reconciliation/fill-reconciler.js";
import { updateLegStateForFill } from "./modules/leg-state/update-leg-state-for-fill.js";
import { applyOrderVerdict } from "./modules/reconciliation/order-status-resolver.js";

/**
 * Thrown when the authoritative exchange fill snapshot cannot be read reliably at
 * startup. FAIL CLOSED (core-infra Gap 2): a transport/parse failure must NOT be
 * read as an authoritative empty ("flat") snapshot — that silently drops real
 * open positions/orphans. The bot must refuse to start rather than act on a false
 * flat. Thrown BEFORE any cleanup/mutation so the ledger is left untouched.
 */
export class StartupSnapshotUnreliableError extends Error {
  constructor(
    readonly reason: string,
    readonly attempts: number,
  ) {
    super(
      `startup aborted — exchange fill snapshot unreliable (reason=${reason}, attempts=${attempts})`,
    );
    this.name = "StartupSnapshotUnreliableError";
  }
}

export interface StartupPositionAdoptionDeps {
  gateway: Pick<ExchangeGateway, "getMarketFeeInfo"> & {
    getFillsResult(sinceMs: number): Promise<FetchResult<ExchangeFill[]>>;
    /**
     * Release A Phase 3 (P6): authoritative open-orders snapshot used to find
     * stale/reopening-risk working orders BEFORE the supervisor starts
     * servicing. Hard-required (no optional fallback) for the same reason
     * `getFillsResult` is hard-required above: a startup fence that silently
     * skipped classification on a missing method would defeat the fence.
     */
    getOpenOrdersResult(): Promise<FetchResult<ExchangeOrder[]>>;
    getOrderResult?(orderId: string): Promise<FetchResult<ExchangeOrder | null>>;
  };
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

/**
 * Release A Phase 3 (P6): one token's stale/reopening-risk working orders,
 * classified at startup but not yet cancelled — `ExecutionModule.
 * seedStartupTransitions` performs the actual drain once the module has
 * started (its bus subscriptions must be wired before the cancel publish is
 * consumed).
 */
export interface StartupDrainTarget {
  tokenId: TokenId;
  activePositionId: PositionId | null;
  orders: Order[];
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
  /** Working SELL orders classified stale (NULL/legacy or non-active-cycle positionId). */
  quarantinedStaleSells: number;
  /** Resting BUYs that could reopen a token with zero currently-active positions. */
  quarantinedReopeningBuys: number;
  /** Exchange-reported open orders with no matching local Order record. */
  unknownExchangeOrders: number;
  /** Per-token drain targets to hand to `ExecutionModule.seedStartupTransitions`. */
  drainTargets: StartupDrainTarget[];
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
  const pendingOrderIds = deps.orderRepo
    .findOpen()
    .filter((order) => order.status === "pending")
    .map((order) => order.orderId);

  // FAIL CLOSED (Gap 2): use the reliable result-returning API that distinguishes
  // an authoritative empty snapshot (ok:true, data:[]) from a transport/parse
  // failure (ok:false). On failure, throw BEFORE any cleanup/mutation below so the
  // ledger is untouched and the bot refuses to start rather than acting on a false
  // "flat" snapshot (the legacy getFills(0) returned [] on failure).
  const fillsResult = await deps.gateway.getFillsResult(0);
  if (!fillsResult.ok) {
    log.fatal(
      { reason: fillsResult.reason, attempts: fillsResult.attempts },
      "startup adoption ABORTED — exchange fill snapshot unreliable (fail-closed, no ledger mutation)",
    );
    throw new StartupSnapshotUnreliableError(fillsResult.reason, fillsResult.attempts);
  }
  const rawFills = fillsResult.data;
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
    quarantinedStaleSells: 0,
    quarantinedReopeningBuys: 0,
    unknownExchangeOrders: 0,
    drainTargets: [],
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

      const applied = withImmediate(deps.db, () => {
        if (!deps.fillRepo.claimForReconciliation(savedFill.fillId)) return false;
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
          decisionRuleId: localOrder.decisionRuleId ?? null,
          timestamp: pending.fill.timestamp,
        });
        return true;
      });
      if (!applied) continue;

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

  for (const orderId of pendingOrderIds) {
    const order = deps.orderRepo.findById(orderId);
    if (!order?.exchangeOrderId || !deps.gateway.getOrderResult) {
      throw new Error(
        `startup aborted — pending order ${String(orderId)} lacks exact terminal proof`,
      );
    }
    const exact = await deps.gateway.getOrderResult(order.exchangeOrderId);
    if (!exact.ok)
      throw new Error(
        `startup aborted — exact lookup unreliable for pending order ${String(orderId)}`,
      );
    if (exact.data === null) {
      throw new Error(
        `startup aborted — pending order ${String(orderId)} lacks exact terminal proof`,
      );
    }
    const verdict = await applyOrderVerdict({
      orderRepo: deps.orderRepo,
      fillRepo: deps.fillRepo,
      log,
      orderId,
      exchange: exact.data,
      publish: false,
      fillCompletionTolerance: deps.fillCompletionTolerance,
    });
    if (verdict.status === "unresolved")
      throw new Error(`startup aborted — pending order ${String(orderId)} unresolved`);
  }

  rebuildLegStatesFromLedger(deps, result, log);

  result.drainTargets = await classifyStartupTransitionTargets(deps, result, log);

  return result;
}

/**
 * Release A Phase 3 (P6) startup fence: read-only classification of exchange
 * open orders that could reopen or fill against a stale/closed cycle. Never
 * mutates the exchange or the ledger — cancellation is deferred entirely to
 * `ExecutionModule.seedStartupTransitions` (called after the supervisor
 * starts), which reuses the same confirm/fill-race machinery the live barrier
 * uses, so there is exactly one place that owns "cancel + wait for terminal".
 *
 * Fail-closed like the fills fetch above: an unreliable open-orders snapshot
 * must abort startup rather than silently skip the fence.
 */
async function classifyStartupTransitionTargets(
  deps: StartupPositionAdoptionDeps,
  result: StartupPositionAdoptionResult,
  log: Logger,
): Promise<StartupDrainTarget[]> {
  const openOrdersResult = await deps.gateway.getOpenOrdersResult();
  if (!openOrdersResult.ok) {
    log.fatal(
      { reason: openOrdersResult.reason, attempts: openOrdersResult.attempts },
      "startup adoption ABORTED — exchange open-orders snapshot unreliable (fail-closed)",
    );
    throw new StartupSnapshotUnreliableError(openOrdersResult.reason, openOrdersResult.attempts);
  }

  const restingByToken = new Map<string, ExchangeOrder[]>();
  for (const exchangeOrder of openOrdersResult.data) {
    if (exchangeOrder.status !== "OPEN" && exchangeOrder.status !== "PARTIALLY_FILLED") continue;
    const key = String(exchangeOrder.tokenId);
    const bucket = restingByToken.get(key) ?? [];
    bucket.push(exchangeOrder);
    restingByToken.set(key, bucket);
  }

  const drainTargets: StartupDrainTarget[] = [];
  for (const [tokenKey, exchangeOrders] of restingByToken) {
    const tokenId = exchangeOrders[0]!.tokenId;
    const activePositions = deps.positionRepo.findActiveByTokenId(tokenId);
    const activePositionIds = new Set(activePositions.map((p) => String(p.positionId)));
    const staleOrders: Order[] = [];

    for (const exchangeOrder of exchangeOrders) {
      const localOrder = deps.orderRepo.findByExchangeOrderId(exchangeOrder.orderId);
      if (!localOrder) {
        result.unknownExchangeOrders++;
        // Finding 5/6 fail-closed: an exchange-live order with NO local record cannot be
        // barrier-tracked (no local OrderId). ABORT startup rather than resume trading
        // blind (mirrors the unreliable-snapshot abort) when it could interfere:
        //  - it sits on a token where we hold an ACTIVE position (could fill against a
        //    cycle we are about to service), OR
        //  - it is a BUY (reopening-capable — could fill and reopen inventory that live
        //    fill-reconciliation cannot associate with a local order), even with no
        //    active position (finding 6).
        // A SELL on a token with no active position is benign for Release A → tolerated.
        const isUnknownBuy = String(exchangeOrder.side).toLowerCase() === "buy";
        if (activePositions.length > 0 || isUnknownBuy) {
          log.fatal(
            {
              tokenId: tokenKey,
              exchangeOrderId: exchangeOrder.orderId,
              side: exchangeOrder.side,
              activePositionIds: [...activePositionIds],
            },
            "startup adoption ABORTED — unknown reopening-capable exchange-live order (fail-closed)",
          );
          throw new StartupSnapshotUnreliableError(
            `unknown exchange order ${exchangeOrder.orderId} (${String(exchangeOrder.side)}) on token ${tokenKey}`,
            1,
          );
        }
        log.warn(
          { tokenId: tokenKey, exchangeOrderId: exchangeOrder.orderId },
          "startup fence — unknown SELL on a token with no active position (tolerated)",
        );
        continue;
      }
      if (!isStaleOrReopeningWorkingOrder(localOrder, activePositionIds)) continue;
      staleOrders.push(localOrder);
      if (localOrder.side === "sell") result.quarantinedStaleSells++;
      else result.quarantinedReopeningBuys++;
    }

    if (staleOrders.length === 0) continue;
    log.warn(
      {
        tokenId: tokenKey,
        activePositionIds: [...activePositionIds],
        orderIds: staleOrders.map((o) => String(o.orderId)),
      },
      "startup fence — quarantining stale/reopening-risk working order(s)",
    );
    drainTargets.push({
      tokenId,
      activePositionId: activePositions[0]?.positionId ?? null,
      orders: staleOrders,
    });
  }

  return drainTargets;
}

/**
 * SELL: stale if its cycle identity can't be established (NULL/legacy —
 * fail-closed) or its cycle has already closed (not in `activePositionIds`).
 * BUY: quarantine-worthy ONLY when there is NO currently active position for
 * the token — a resting BUY alongside an active position is a legitimate
 * scale-in add, not a reopening risk, and is left untouched (common-path
 * byte-identical behavior).
 */
function isStaleOrReopeningWorkingOrder(
  order: Order,
  activePositionIds: ReadonlySet<string>,
): boolean {
  // Finding 5: classify BOTH sides strictly by cycle identity. Any working order —
  // a SELL or a scale-in add BUY — is stale/reopening-risk UNLESS its positionId
  // matches a CURRENT active cycle. A NULL/legacy positionId or a positionId that
  // matches no active position is fail-closed to stale (a resting BUY with no cycle
  // identity could reopen a closed cycle; a legit scale-in add carries the matching
  // positionId and is left untouched).
  const positionId = order.positionId != null ? String(order.positionId) : null;
  return positionId == null || !activePositionIds.has(positionId);
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
export function rebuildLegStatesFromLedger(
  deps: StartupPositionAdoptionDeps,
  result: StartupPositionAdoptionResult,
  log: Logger,
  replacementTokens?: ReadonlySet<TokenId>,
): import("@krabs/domain").LegState[] {
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

  const tokensToRebuild = replacementTokens
    ? activeTokens.filter(({ token_id }) => replacementTokens.has(createTokenId(token_id)))
    : activeTokens;
  if (tokensToRebuild.length === 0) return [];

  // ADR-027 §D-B — scope replay so that fills from prior closed legs on the
  // same token don't bleed into the active leg's cumulative_*, buy/sell
  // counts, or first_trade_at. We pick the largest `closed_at` strictly less
  // than the active leg's `opened_at`: that's the chronologically-prior
  // close. Filtering on `closed_at < active.opened_at` is essential because
  // bootstrap's duplicate-open repair (`ensureUniqueOpenPositionIndex` in
  // packages/db/src/bootstrap.ts) stamps `closed_at` at repair time, which
  // would otherwise outrank any real prior close and mask out the
  // active leg's own fills. Using `closed_at` (rather than `opened_at`) for
  // the prior leg avoids the clock-skew gap between exchange `filled_at`
  // (event-time) and the active position's `opened_at` (wall-clock at handler
  // time): the active opening fill can have `filled_at < active.opened_at`,
  // but it always has `filled_at > prior.closed_at` since the prior leg's
  // closure happened chronologically earlier on the wire.
  //
  // Comparisons AND the pick of the latest leg both go through `ledgerInstant()` because
  // `closed_at` carries three renderings of the same instant — see packages/db/src/db-timestamp.ts.
  // Lexical ordering disagrees with chronological ordering on the same calendar day (space sorts
  // before `T`), so `MAX(closed_at)` would return the earlier ISO leg over a later space-format
  // one and replay would start too early, leaking the intervening leg's fills into the active leg.
  // Ordering numerically instead of maxing lexically is what keeps the filter and the pick agreed.
  //
  // When no prior closed leg exists, fall back to no lower bound — there is
  // nothing to leak from.
  const priorCloseStmt = deps.db.prepare(
    `SELECT closed_at AS max_closed_at FROM positions
       WHERE token_id = ?
         AND status = 'closed'
         AND closed_at IS NOT NULL
         AND ${ledgerInstant("closed_at")} < ${ledgerInstant("?")}
       ORDER BY ${ledgerInstant("closed_at")} DESC
       LIMIT 1`,
  );
  // The lower bound is wrapped because its bind is the prior leg's `closed_at`, which carries the
  // legacy space and Gamma renderings. The ORDER BY compares `filled_at` only against itself — a
  // single-rendering canonical column — so it sorts raw and keeps the plain string ordering.
  const selectFillsScoped = deps.db.prepare(
    `SELECT fill_id, token_id, condition_id, side, price, size, size_usdc, filled_at
       FROM fills
      WHERE token_id = ?
        AND ${ledgerInstant("filled_at")} > ${ledgerInstant("?")}
      ORDER BY filled_at ASC, fill_id ASC`,
  );
  const selectFillsForPosition = deps.db.prepare(
    `SELECT f.fill_id, f.token_id, f.condition_id, f.side, f.price, f.size, f.size_usdc, f.filled_at
       FROM fills f JOIN (SELECT fill_id FROM inventory_lots WHERE position_id = ?
                          UNION SELECT fill_id FROM pnl_ledger WHERE position_id = ?) p USING (fill_id)
      ORDER BY f.filled_at ASC, f.fill_id ASC`,
  );

  const now = new Date().toISOString();
  const rebuilt = [] as import("@krabs/domain").LegState[];

  for (const { token_id } of tokensToRebuild) {
    const tokenId = createTokenId(token_id);
    const activePosition = deps.positionRepo.findByTokenId(tokenId);
    const activeOpenedAt = activePosition?.openedAt ?? "9999-12-31T23:59:59.999Z";
    const priorClose = priorCloseStmt.get(token_id, activeOpenedAt) as
      | { max_closed_at: string | null }
      | undefined;
    const replayLowerBound = priorClose?.max_closed_at ?? "1970-01-01T00:00:00.000Z";
    const fills = (
      replacementTokens?.has(tokenId) && activePosition
        ? selectFillsForPosition.all(activePosition.positionId, activePosition.positionId)
        : selectFillsScoped.all(token_id, replayLowerBound)
    ) as Array<{
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

    const rebuiltState = deps.legStateRepo.get(tokenId);
    if (rebuiltState) {
      result.seededLegStates += 1;
      rebuilt.push(rebuiltState);
    }
  }
  return rebuilt;
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

function isMergeBoundSyntheticFill(db: Database.Database, fillId: string | null): boolean {
  if (!fillId) return false;
  return (
    db
      .prepare(
        `SELECT 1
           WHERE EXISTS (SELECT 1 FROM inventory_lots l JOIN merge_ledger m
                           ON l.position_id IN (m.yes_position_id, m.no_position_id)
                          WHERE l.fill_id = ?)
              OR EXISTS (SELECT 1 FROM pnl_ledger p JOIN merge_ledger m
                           ON p.position_id IN (m.yes_position_id, m.no_position_id)
                          WHERE p.fill_id = ?)`,
      )
      .get(fillId, fillId) !== undefined
  );
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

  // Preserve the whole order: removing a sibling of a terminal/merge-bound fill recreates it.
  const skipOrderIds = new Set(
    rows
      .filter(
        (row) =>
          isTerminalReconciledOrphan(deps.db, row.fill_id) ||
          isMergeBoundSyntheticFill(deps.db, row.fill_id),
      )
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

/**
 * Hand every merge source's ENTIRE ledger footprint to the winner: every lot it owns — live AND
 * fully consumed — and every realized row.
 *
 * Moving only the live lots splits one round trip across two positions. `buildPositionCycles`
 * (apps/api/src/routes/position-cycles.ts) attributes a BUY by `inventory_lots.position_id` while
 * carrying `fills.size` — the FULL original fill, never `remaining_size` — and attributes the SELL
 * by `pnl_ledger.position_id`. A lot that bought 10 and still holds 4 would hand the winner a
 * 10-share BUY it never made and leave the source a SELL with no BUY (`UNKNOWN_ACCT`), corrupting
 * invested value, holding interval and P&L percentage on both cycles. Whole-footprint is what makes
 * the survivor's cycle add up, and it is why this is the ONLY place lot ownership moves.
 *
 * `orders.position_id` deliberately stays put. It is the exit-owner servicing key (ledger.sql:160,
 * Release A Phase 3): the executor scopes cancel/replace/backstop by it and rejects stale
 * cross-cycle commands, so reparenting a source's orders would present them to the executor as the
 * winner's live cycle. `settlement_ledger` stays too — settlement calls `settleAll` before closing
 * (modules/resolution/position-settler.ts), which zeroes `remaining_size`, so a settled position
 * can never appear among the live-lot owners this merges, and a non-closed source cannot own a
 * settlement row at all.
 */
function mergeRetiredPositionFootprint(
  db: Database.Database,
  winnerPositionId: string,
  mergeSourceIds: readonly string[],
): void {
  if (mergeSourceIds.length === 0) return;
  const placeholders = mergeSourceIds.map(() => "?").join(", ");
  for (const table of ["inventory_lots", "pnl_ledger"] as const) {
    db.prepare(`UPDATE ${table} SET position_id = ? WHERE position_id IN (${placeholders})`).run(
      winnerPositionId,
      ...mergeSourceIds,
    );
  }
}

/**
 * Retire exactly the positions named in `positionIds`: DELETE the rows that are provably
 * unreferenced, CLOSE the rest. The caller passes an explicit list rather than a token-wide
 * `status != 'closed'` filter because a merge source can ALREADY be closed — `rebuildTokenPosition`
 * absorbs the footprint of every position that still owns a live lot for the token, and a closed
 * position owning one is an ordinary state (reconciliation force-closes a position that vanished
 * remotely without touching its lots, `ensureUniqueOpenPositionIndex` and migration 032 close
 * duplicate opens the same way, and modules/resolution/resolution-module.ts searches for exactly
 * that shape). Such a source is emptied by the merge and must be re-accounted too, or it keeps a
 * basis and a realized total whose underlying rows now belong to the winner.
 *
 * DELETE alone is not safe. `inventory_lots`, `pnl_ledger` and `settlement_ledger` each declare
 * `position_id ... REFERENCES positions(position_id)` with no ON DELETE clause (ledger.sql:328,
 * 350, 377) and every runtime connection sets `PRAGMA foreign_keys = ON` (connection.ts:98), so
 * deleting a position that still owns a fully-consumed lot (`remaining_size = 0`, invisible to the
 * `remaining_size > 0` scan in `rebuildTokenPosition`), a realized-P&L row or a settlement row
 * raises SQLITE_CONSTRAINT_FOREIGNKEY — aborting the whole adoption transaction and failing the
 * very boot this repair exists to rescue. Closing such a row frees the slot in
 * `idx_positions_unique_open_per_token` (partial, `WHERE status = 'open'`) just as deletion did,
 * keeps it invisible to readers (they filter `status != 'closed'`) and preserves the audit trail
 * its dependent rows belong to. Same primitive `ensureUniqueOpenPositionIndex` uses at
 * bootstrap.ts:538.
 *
 * CLOSE alone is not safe either. A position with no dependent rows at all has no history to
 * preserve, and closing it fabricates one: both the merge above and
 * `cleanupPriorStartupAdoptionArtifacts` (which deletes a synthetic order's lots, fills and P&L
 * rows immediately before calling here) can leave behind an empty husk — and a zero-`realized_pnl`
 * closed row is counted as a LOSS by `readClosedWinrate` (apps/api/src/routes/dashboard.ts, which
 * filters on nothing but `status`/`closed_at` and derives losses as `total - wins`) and returned as
 * a phantom `CLOSED_PROFIT` cycle by `buildPositionCycles` (apps/api/src/routes/position-cycles.ts,
 * which maps every `positions` row with no zero-fill guard). Those husks are deleted.
 *
 * `orders.position_id` (ledger.sql:160) does NOT join the test, and that holds for WORKING orders
 * too. It declares no FK, so deleting the position cannot raise SQLITE_CONSTRAINT, and retaining
 * the row buys nothing a working order can use: I2 (`stalePointerSells`, packages/db
 * exit-ownership-invariants.ts) requires the pointed-to position to be `status <> 'closed'`, so a
 * retired row flags exactly as a missing one does, and `exitOwnerIdentityRejection`
 * (modules/execution/execution-module.ts) resolves its target out of `findActiveByTokenId`, where
 * a closed row is equally absent — the order is unserviceable either way. Every other consumer is
 * an in-memory equality or membership check that fails to match identically, I5 INNER JOINs
 * `positions` and drops the row, and the P6 fence classifies the order stale off
 * `activePositionIds` and drains it in the same boot. Deleted and closed are therefore
 * indistinguishable to every reader — except that closing additionally fabricates the loss +
 * phantom cycle described above, and does so permanently. So orders never pin a row.
 * `leg_state_transitions.position_id` (ledger.sql:719) deliberately does NOT join the test —
 * `cleanupPriorStartupAdoptionArtifacts` preserves those rows on purpose (they are the record that
 * the reconciliation happened, and it removes only orders/fills/lots/P&L), so gating on them would
 * make every cleaned artifact undeletable and reinstate exactly the phantom row described above.
 *
 * The rows that survive as closed are re-accounted, not merely flagged. At every call site the
 * retired row provably holds no inventory — either the token has no remaining lots at all, or the
 * winner has already absorbed AND taken ownership of every one of them (see
 * `rebuildTokenPosition`) — so `size`, `cost_basis_usdc`, `current_value_usdc` and
 * `liquidation_value_usdc` all go to zero. Zeroing the basis is not cosmetic: the winner's
 * `cost_basis_usdc` already counts those same lots, and `GET /metrics/events`
 * (apps/api/src/routes/metrics.ts) aggregates `cost_basis_usdc` and
 * `current_value_usdc - cost_basis_usdc` over `positions` with NO status filter, so a retained
 * basis is double-counted volume plus a fabricated unrealized loss of exactly that size.
 * `liquidation_value_usdc` is the depth-aware valuation of that same vanished inventory and is
 * read the same way — every aggregate takes it as `COALESCE(liquidation_value_usdc,
 * current_value_usdc)` (metrics.ts, apps/api/src/routes/status.ts,
 * modules/publisher/profile-runtime-publisher.ts, position-concentration-service.ts), so leaving it
 * set would override the zeroed `current_value_usdc` and re-fabricate the profit as depth-aware.
 * `realized_pnl` is recomputed from the row's OWN surviving `pnl_ledger` rows rather than kept,
 * because the column is a denormalized cache of them: `cleanupPriorStartupAdoptionArtifacts`
 * deletes the synthetic fills' P&L rows immediately before calling here, and `rebuildTokenPosition`
 * hands a retired duplicate's realized rows to the winner — in both cases the stored total is
 * orphaned, and it would be reported as a win by `readClosedWinrate` (dashboard.ts) and counted a
 * second time in the winner's. `pnl_ledger` is the complete realized source for these rows:
 * settlement always closes the position it settles (modules/resolution/position-settler.ts), and a
 * settled row cannot reach here — `settleAll` zeroes `remaining_size`, so it never appears among
 * the live-lot owners the caller merges, and the non-closed sources cannot own a settlement row.
 *
 * `closed_at = COALESCE(closed_at, ?)` keeps an already-closed source's original close time; only a
 * row being closed for the first time gets a fresh stamp.
 */
function retirePositions(db: Database.Database, positionIds: readonly string[]): void {
  if (positionIds.length === 0) return;
  const placeholders = positionIds.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM positions
      WHERE position_id IN (${placeholders})
        AND NOT EXISTS (SELECT 1 FROM inventory_lots WHERE position_id = positions.position_id)
        AND NOT EXISTS (SELECT 1 FROM pnl_ledger WHERE position_id = positions.position_id)
        AND NOT EXISTS (SELECT 1 FROM settlement_ledger WHERE position_id = positions.position_id)`,
  ).run(...positionIds);

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE positions
        SET status = 'closed',
            size = 0,
            cost_basis_usdc = 0,
            current_value_usdc = 0,
            liquidation_value_usdc = 0,
            realized_pnl = (SELECT COALESCE(SUM(delta), 0)
                              FROM pnl_ledger
                             WHERE position_id = positions.position_id),
            closed_at = COALESCE(closed_at, ?),
            updated_at = ?
      WHERE position_id IN (${placeholders})`,
  ).run(now, now, ...positionIds);
}

function rebuildTokenPosition(db: Database.Database, tokenId: string, log: Logger): void {
  // Winner selection matches the DB invariant:
  //   `idx_positions_unique_open_per_token` + migration 032 repair rule — both rank by INSTANT,
  // never by text (032:43-47 spells out `ledgerInstant()` inline because migrations cannot import
  // it). The index is UNIQUE on token_id WHERE status = 'open', so it constrains only the 'open'
  // rows; this query selects `status != 'closed'`, so an older 'open' row and a newer 'dust' row
  // for one token are a legal state that lands here with something to rank. Text ordering would
  // then pick the wrong survivor for a same-day space-vs-ISO pair — ' ' (0x20) < 'T' (0x54) puts
  // the chronologically newer space row last — and every loser is CLOSED below, so the wrong
  // ranking retires the live row rather than mis-sorting a display. `opened_at` is 100% canonical
  // ISO on production today (680/680 measured 2026-08-06); the wrap costs nothing at that size and
  // keeps this ranking identical to the migration's on any row that is not.
  // Tie-break on position_id DESC eliminates SQLite's implementation-defined
  // ordering when two rows share the same opened_at.
  const openRows = db
    .prepare(
      `SELECT position_id, entry_style, opened_at
       FROM positions
       WHERE token_id = ? AND status != 'closed'
       ORDER BY ${ledgerInstant("opened_at")} DESC, position_id DESC`,
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
    retirePositions(
      db,
      openRows.map((row) => row.position_id),
    );
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
  // Every position whose history the winner is about to absorb, and exactly the set retired below.
  // Two sources, one rule:
  //   - the non-closed duplicates (`openRows` minus the winner) — the invariant breach this repair
  //     exists for;
  //   - every OTHER owner of a live lot for this token, INCLUDING an already-closed one. The totals
  //     below sum `remainingLots` token-wide, so each of those lots ends up in the winner's size and
  //     basis; ownership has to follow, because every downstream consumer scopes by `position_id`,
  //     never by token — SELL lot consumption (inventory-lot-repository.ts `consumeFifo`), exit
  //     validation (modules/execution, @krabs/domain exit-loss-floor.ts) and settlement. A lot left
  //     parented elsewhere is counted in the winner's basis and still unspendable by the SELL that
  //     tries to consume it, surfacing as `cost_inconsistent` or `Insufficient inventory`.
  // Merging the WHOLE footprint of both classes — rather than reparenting the live lots alone — is
  // what keeps the round trip on one position (see `mergeRetiredPositionFootprint`). It also lets a
  // source that contributed nothing but ledger rows come out dependency-free, so it is deleted
  // rather than left behind as a phantom closed row.
  const mergeSourceIds = [
    ...new Set([...openRows, ...remainingLots].map((row) => row.position_id)),
  ].filter((positionId) => positionId !== activePositionId);
  // Read BEFORE `retirePositions` below, which deletes a source left with no dependent rows
  // once the merge reparents them — a deleted row can no longer be read back for its opened_at.
  // Covers the winner too, not just its sources: `openRows` excludes an already-closed position
  // that still owns a live lot (see the comment above), and when `openRows` is empty entirely,
  // `activePositionId` above falls back to `remainingLots[0]`'s owner — which can BE that
  // already-closed position. It is also excluded from `mergeSourceIds` by definition (it's the
  // winner, not a source), so without this its own opened_at wouldn't be read from `positions`
  // at all.
  const openedAtLookupIds = [activePositionId, ...mergeSourceIds];
  const openedAtRows = db
    .prepare(
      `SELECT opened_at FROM positions WHERE position_id IN (${openedAtLookupIds
        .map(() => "?")
        .join(", ")})`,
    )
    .all(...openedAtLookupIds) as Array<{ opened_at: string }>;
  mergeRetiredPositionFootprint(db, activePositionId, mergeSourceIds);

  const totalSize = remainingLots.reduce((sum, lot) => sum + lot.remaining_size, 0);
  const totalCost = remainingLots.reduce(
    (sum, lot) => sum + lot.remaining_size * lot.entry_price,
    0,
  );
  const avgEntryPrice = totalSize > 0 ? totalCost / totalSize : 0;
  // Read AFTER the merge above, so the winner's realized total includes the rows it absorbed.
  // Nothing is double-counted: those rows now belong to exactly one position, and every retired
  // row's `realized_pnl` is recomputed from what is left under it (`retirePositions`).
  const realizedRow = db
    .prepare(`SELECT COALESCE(SUM(delta), 0) AS total FROM pnl_ledger WHERE position_id = ?`)
    .get(activePositionId) as { total: number } | undefined;
  const activeRow = openRows.find((row) => row.position_id === activePositionId);
  const entryStyle = activeRow?.entry_style ?? null;
  // The merged position's cycle start is the EARLIEST opened_at across the winner and every
  // absorbed source, not just the winner's own: when the winner is the more recently opened
  // duplicate, a retired source's absorbed BUY/SELL fills predate the winner's own `opened_at`,
  // understating hold duration and dropping those fills from any `filled_at >= opened_at` read
  // (e.g. dashboard hold-time queries). `openedAtRows` (above) already includes the winner's own
  // row read straight from `positions`, so this covers the closed-winner case too — falling back
  // to `activeRow`/`openRows` here would miss it. `remainingLots[0]!.created_at` is the
  // last-resort fallback for the pathological case where the winner has no row in `positions` at
  // all. Renderings can mix (ISO vs SQLite space-form, see `ledgerInstant`), so compare parsed
  // instants rather than the raw text.
  const openedAtCandidates = openedAtRows.map((row) => row.opened_at);
  const openedAt =
    openedAtCandidates.length > 0
      ? openedAtCandidates.reduce((earliest, candidate) =>
          parseLedgerInstantMs(candidate) < parseLedgerInstantMs(earliest) ? candidate : earliest,
        )
      : remainingLots[0]!.created_at;
  const status = resolveOpenPositionStatus(totalCost, { size: totalSize, minOrderSize: null });
  const now = new Date().toISOString();

  // Losers are retired BEFORE the winner is promoted, not after.
  // `idx_positions_unique_open_per_token` is UNIQUE on token_id WHERE status = 'open', so it
  // permits one 'open' row alongside any number of 'dust' ones — and `openRows` selects
  // `status != 'closed'`, so a token legitimately reaches here with a newer 'dust' row ranking
  // above an older 'open' one. Promoting that winner to 'open' first puts a SECOND 'open' row on
  // the token and throws SQLITE_CONSTRAINT out of startup adoption — the repair path this branch
  // exists for is exactly the one that used to abort boot. Retiring first frees the slot; the
  // winner is excluded by position_id, so it is never the row touched, and nothing below reads the
  // loser rows (the totals come from `remainingLots`, `pnl_ledger` and the already-materialized
  // `openRows`).
  retirePositions(db, mergeSourceIds);

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

  const clientOrderId = fill.clientOrderId?.trim() ?? "";
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
  const clientOrderId = fill.clientOrderId?.trim() ?? "";
  if (clientOrderId.length > 0) {
    return clientOrderId as ClientOrderId;
  }
  return `adopt-${sanitizeKey(orphanGroupKey)}` as ClientOrderId;
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 120);
}

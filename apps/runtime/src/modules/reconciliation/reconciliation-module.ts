/**
 * Reconciliation Module — startup reconciliation + periodic drift detection.
 *
 * Startup: runs full reconciliation during start() before returning,
 * blocking trading until the pass completes.
 *
 * Periodic: setInterval-driven loop with re-entrancy guard.
 *
 * Drift categories:
 *  - Phantom orders (local open, not on exchange) → cancelled locally
 *  - Unknown exchange orders (on exchange, not local) → logged
 *  - Missing fills → imported via importExchangeFills, FillReceived published on bus
 *  - Unrecoverable inventory drift → emits critical severity event
 *
 * Exchange is source of truth. Does NOT fabricate state.
 */

import type {
  RuntimeModule,
  EventBus,
  ExchangeGateway,
  OrderRepository,
  FillRepository,
  MarketRepository,
  FamilyRulesProvider,
  ReconciliationResult,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";
import { reconcileOrders } from "./order-reconciler.js";
import { reconcileFills } from "./fill-reconciler.js";
import { cleanStaleEntryOrders } from "./stale-order-cleaner.js";

export interface ReconciliationModuleDeps {
  gateway: ExchangeGateway;
  bus: EventBus;
  orderRepo: OrderRepository;
  fillRepo: FillRepository;
  marketRepo: MarketRepository;
  rulesProvider: FamilyRulesProvider;
  log: Logger;
  reconcileIntervalMs: number;
}

export class ReconciliationModule implements RuntimeModule {
  private readonly log: Logger;
  private unsubs: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;
  private started = false;
  private runCount = 0;
  private lastRunAt: number | null = null;
  private lastResult: ReconciliationResult | null = null;
  private readonly staleBackoffMap = new Map<string, number>();

  constructor(private readonly deps: ReconciliationModuleDeps) {
    this.log = deps.log.child({ module: "reconciliation" });
  }

  async start(): Promise<void> {
    // Startup reconciliation — blocks until complete
    this.log.info("running startup reconciliation");
    await this.runReconciliation();
    this.log.info("startup reconciliation complete");

    // Periodic loop
    this.timer = setInterval(() => {
      this.runReconciliation().catch((err) =>
        this.log.error({ err }, "periodic reconciliation error"),
      );
    }, this.deps.reconcileIntervalMs);

    this.started = true;
    this.log.info(
      { reconcileIntervalMs: this.deps.reconcileIntervalMs },
      "reconciliation module started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.started = false;
    this.log.info("reconciliation module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.started) {
      return { ok: false, detail: "not started" };
    }
    return {
      ok: true,
      detail: `runs=${this.runCount} lastRun=${this.lastRunAt ?? "never"} clean=${this.lastResult?.clean ?? "unknown"}`,
    };
  }

  /** Exposed for testing — in production driven by startup + interval timer. */
  async runReconciliation(): Promise<ReconciliationResult> {
    if (this.reconciling) {
      this.log.debug("reconciliation already in progress — skipping");
      return this.lastResult ?? this.emptyResult();
    }

    this.reconciling = true;
    try {
      const ranAt = Date.now();
      const allDetails: string[] = [];

      // 1. Order reconciliation
      // Grace = 2 intervals + 30s buffer. Covers worst case: order placed right after
      // pass N, still absent on pass N+1 (60s) and N+2 (120s), only phantom-cancel on N+3.
      const graceMs = this.deps.reconcileIntervalMs * 2 + 30_000;
      const orderResult = await reconcileOrders({
        gateway: this.deps.gateway,
        orderRepo: this.deps.orderRepo,
        log: this.log,
        phantomGraceMs: graceMs,
      });
      allDetails.push(...orderResult.details);

      // 2. Fill reconciliation (startup uses sinceMs=0, periodic uses last run)
      const sinceMs = this.lastRunAt ?? 0;
      const fillResult = await reconcileFills(
        {
          gateway: this.deps.gateway,
          fillRepo: this.deps.fillRepo,
          orderRepo: this.deps.orderRepo,
          rulesProvider: this.deps.rulesProvider,
          bus: this.deps.bus,
          log: this.log,
        },
        sinceMs,
      );
      allDetails.push(...fillResult.details);

      // 3. Stale entry order cleanup
      const staleResult = await cleanStaleEntryOrders(
        {
          orderRepo: this.deps.orderRepo,
          marketRepo: this.deps.marketRepo,
          rulesProvider: this.deps.rulesProvider,
          bus: this.deps.bus,
          log: this.log,
        },
        this.staleBackoffMap,
      );
      if (staleResult.staleTtlCancelled > 0) {
        allDetails.push(`stale entry TTL cancels: ${staleResult.staleTtlCancelled}`);
      }
      if (staleResult.staleEndDateCancelled > 0) {
        allDetails.push(`stale entry endDate cancels: ${staleResult.staleEndDateCancelled}`);
      }
      if (staleResult.staleExitTtlCancelled > 0) {
        allDetails.push(`stale exit TTL cancels: ${staleResult.staleExitTtlCancelled}`);
      }

      // 4. Build result
      const clean =
        orderResult.phantomsCancelled === 0 &&
        orderResult.unknownExchangeOrders === 0 &&
        fillResult.missingFillsImported === 0 &&
        orderResult.staleCancelled === 0 &&
        orderResult.staleCancelFailed === 0 &&
        staleResult.staleTtlCancelled === 0 &&
        staleResult.staleEndDateCancelled === 0 &&
        staleResult.staleExitTtlCancelled === 0;

      const result: ReconciliationResult = {
        ranAt,
        openOrdersExchange: orderResult.exchangeOpenCount,
        openOrdersLocal: orderResult.localOpenCount,
        missingFills: fillResult.missingFillsImported,
        phantomOrders: orderResult.phantomsCancelled,
        positionDriftCount: 0,
        clean,
        details: allDetails,
      };

      this.runCount++;
      this.lastRunAt = ranAt;
      this.lastResult = result;

      // 5. Publish events
      if (!clean) {
        const severity =
          fillResult.missingFillsImported > 0 ? ("critical" as const) : ("warn" as const);
        await this.deps.bus.publish("ReconciliationDriftDetected", {
          details: allDetails.join("; "),
          severity,
          timestamp: ranAt,
        });
      }

      await this.deps.bus.publish("ReconciliationComplete", { result });

      this.log.info(
        {
          run: this.runCount,
          clean,
          phantoms: orderResult.phantomsCancelled,
          phantomsSkippedGrace: orderResult.phantomsSkippedGrace,
          missingFills: fillResult.missingFillsImported,
          unknownOrders: orderResult.unknownExchangeOrders,
          staleCancelled: orderResult.staleCancelled,
          staleCancelFailed: orderResult.staleCancelFailed,
          staleEntryTtl: staleResult.staleTtlCancelled,
          staleEntryEndDate: staleResult.staleEndDateCancelled,
          staleExitTtl: staleResult.staleExitTtlCancelled,
        },
        "reconciliation pass complete",
      );

      return result;
    } finally {
      this.reconciling = false;
    }
  }

  private emptyResult(): ReconciliationResult {
    return {
      ranAt: Date.now(),
      openOrdersExchange: 0,
      openOrdersLocal: 0,
      missingFills: 0,
      phantomOrders: 0,
      positionDriftCount: 0,
      clean: true,
      details: [],
    };
  }
}

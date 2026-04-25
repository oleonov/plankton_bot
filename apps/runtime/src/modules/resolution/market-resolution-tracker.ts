/**
 * MarketResolutionTracker — early-init service that knows whether a given
 * Polymarket condition has resolved.
 *
 * Why a separate service (not a runtime module):
 *   1. `isResolved()` must be sync (Set lookup) — it runs on the BUY hot path
 *      in RiskInventoryModule.handleSignal and SignalToOrderBridge.handleApproved.
 *   2. Subscription must happen BEFORE any publisher of MarketResolved /
 *      MarketResolvedHint is constructed/started, otherwise events that fire
 *      between supervisor.start() and the tracker's own subscribe() would be
 *      lost (InProcessEventBus has no replay).
 *   3. The seed (`init()`) reads from `MarketResolutionRepository.findAll()` so
 *      we don't depend on resolution detection running before the first BUY
 *      tick — historical resolutions are already in the Set on cold start.
 *
 * Fail-closed contract: if `init()` throws (e.g. DB read failure), the
 * tracker keeps `healthy=false` forever. BUY-side guards must treat
 * `healthy()===false` as "block BUY with reason resolution_tracker_unavailable"
 * rather than fall through allow.
 */

import type { EventBus, MarketResolutionRepository, RuntimeEventMap } from "@plankton/domain";
import type { Logger } from "../../logger.js";

export class MarketResolutionTracker {
  private readonly resolvedConditions = new Set<string>();
  private readonly log: Logger;
  private unsubs: Array<() => void> = [];
  private initialized = false;
  private initFailed = false;

  constructor(
    private readonly resolutionRepo: MarketResolutionRepository,
    log: Logger,
  ) {
    this.log = log.child({ component: "market-resolution-tracker" });
  }

  /**
   * Seed the in-memory Set from the resolutions table. Throws on DB failure;
   * caller decides whether to abort startup or accept the failClosed state.
   * Idempotent — safe to retry.
   */
  init(): void {
    try {
      const rows = this.resolutionRepo.findAll();
      for (const row of rows) this.resolvedConditions.add(row.conditionId);
      this.initialized = true;
      this.initFailed = false;
      this.log.info(
        { seededCount: this.resolvedConditions.size },
        "market resolution tracker seeded from repo",
      );
    } catch (err) {
      this.initFailed = true;
      this.initialized = false;
      this.log.error(
        { err },
        "market resolution tracker init failed — BUY orders will be blocked fail-closed",
      );
      throw err;
    }
  }

  /**
   * Wire bus subscriptions. MUST be called after `init()` and BEFORE any
   * module that publishes MarketResolved/MarketResolvedHint is started.
   */
  subscribe(bus: EventBus): void {
    this.unsubs.push(
      bus.subscribe("MarketResolved", (p) => this.handleResolved(p)),
      bus.subscribe("MarketResolvedHint", (p) => this.handleResolvedHint(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  /** Sync, never throws. False when init failed — caller checks `healthy()` separately. */
  isResolved(conditionId: string): boolean {
    return this.resolvedConditions.has(conditionId);
  }

  /** Whether the tracker can be trusted. False until init() completes successfully. */
  healthy(): boolean {
    return this.initialized && !this.initFailed;
  }

  /** Test/operator helper. */
  size(): number {
    return this.resolvedConditions.size;
  }

  private async handleResolved(payload: RuntimeEventMap["MarketResolved"]): Promise<void> {
    if (!this.resolvedConditions.has(payload.conditionId)) {
      this.resolvedConditions.add(payload.conditionId);
      this.log.info(
        { conditionId: payload.conditionId, source: payload.source },
        "market resolved — added to tracker",
      );
    }
  }

  private async handleResolvedHint(payload: RuntimeEventMap["MarketResolvedHint"]): Promise<void> {
    if (!this.resolvedConditions.has(payload.conditionId)) {
      this.resolvedConditions.add(payload.conditionId);
      this.log.info(
        { conditionId: payload.conditionId },
        "market resolved hint — added to tracker",
      );
    }
  }
}

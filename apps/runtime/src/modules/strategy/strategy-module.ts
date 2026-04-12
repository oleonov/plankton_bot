/**
 * Strategy Module — scanner loop, signal production, and signal-to-order bridging.
 *
 * Subscribes to:
 *  - NormalizedMarketUpdated → cache latest market snapshot
 *  - PositionUpdated → track buy fills for scale-in limiting
 *
 * On timer tick:
 *  - Run scanner against cached markets
 *  - Publish SignalProduced for each generated signal
 *
 * The embedded SignalToOrderBridge subscribes to SignalApproved (published by
 * risk-inventory after gate evaluation) and converts them into PlaceOrderRequested
 * events for the execution module, completing the end-to-end trading path.
 *
 * Re-entrancy guard prevents overlapping scan cycles.
 * Buy count tracking for scale-in is maintained in-memory.
 */

import type {
  RuntimeModule,
  EventBus,
  FamilyRulesProvider,
  PositionRepository,
  OrderRepository,
  FamilyStateRepository,
  NormalizedMarket,
  RuntimeEventMap,
  RuntimeControl,
} from "@plankton/domain";
import type { GlobalConfig } from "@plankton/config";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import { ENTRY_REASONS } from "@plankton/domain";
import {
  scan,
  createBuyTracker,
  createSessionTracker,
  createSprayTracker,
  type BuyTracker,
  type SessionTracker,
  type SprayTracker,
} from "./scanner.js";
import { SignalToOrderBridge } from "./signal-to-order.js";
import {
  CandidateBookCache,
  applyOrderBookToMarket,
  type CandidateBookGateway,
} from "./candidate-book-cache.js";

export interface StrategyModuleDeps {
  bus: EventBus;
  rulesProvider: FamilyRulesProvider;
  positionRepo: PositionRepository;
  orderRepo?: OrderRepository | undefined;
  familyStateRepo: FamilyStateRepository;
  candidateBookGateway?: CandidateBookGateway | undefined;
  candidateBookCache?: CandidateBookCache | undefined;
  log: Logger;
  scanIntervalMs: number;
  runtimeControl?: RuntimeControl | undefined;
  liveLiteGuard?: LiveLiteGuard | undefined;
  globalConfig?: GlobalConfig | undefined;
}

export class StrategyModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly buyTracker: BuyTracker;
  private readonly sessionTracker: SessionTracker;
  private readonly sprayTracker: SprayTracker;
  private readonly bridge: SignalToOrderBridge;
  private readonly candidateBookCache: CandidateBookCache | undefined;
  private readonly ownsCandidateBookCache: boolean;
  /** Last-known size per position — used to distinguish buy-fill updates from sell-fill updates. */
  private readonly lastKnownSize = new Map<string, number>();
  /** Tokens with open spray positions — cross-tick dedup to prevent re-spraying. */
  private readonly sprayedTokens = new Set<string>();
  /** Attempt-level entry cooldown: "familyId|tokenId" → epoch ms of last approved entry signal. */
  private readonly lastAttemptTs = new Map<string, number>();
  private cachedMarkets: readonly NormalizedMarket[] = [];
  private unsubs: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private started = false;
  private tickCount = 0;
  private signalCount = 0;

  constructor(private readonly deps: StrategyModuleDeps) {
    this.log = deps.log.child({ module: "strategy" });
    this.buyTracker = createBuyTracker();
    this.sessionTracker = createSessionTracker();
    this.sprayTracker = createSprayTracker();
    this.candidateBookCache =
      deps.candidateBookCache ??
      (deps.candidateBookGateway
        ? new CandidateBookCache({
            gateway: deps.candidateBookGateway,
            log: this.log.child({ component: "candidate-book-cache" }),
          })
        : undefined);
    this.ownsCandidateBookCache =
      deps.candidateBookCache == null && this.candidateBookCache != null;
    this.bridge = new SignalToOrderBridge({
      bus: deps.bus,
      log: this.log,
      rulesProvider: deps.rulesProvider,
      orderRepo: deps.orderRepo,
      liveLiteGuard: deps.liveLiteGuard,
      candidateBookCache: this.candidateBookCache,
    });
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) => this.handleMarketUpdate(p)),
      this.deps.bus.subscribe("PositionUpdated", (p) => this.handlePositionUpdated(p)),
      this.deps.bus.subscribe("PlaceOrderRequested", async (p) => {
        if (ENTRY_REASONS.has(p.command.signalReason ?? "")) {
          const key = `${p.command.familyId}|${p.command.tokenId}`;
          this.lastAttemptTs.set(key, p.timestamp);
        }
      }),
    );
    this.bridge.subscribe();

    // Rehydrate spray tracker + sprayedTokens from persisted open spray positions
    const openSprayPositions = this.deps.positionRepo.findOpenByEntryStyle("spray");
    for (const pos of openSprayPositions) {
      this.sprayTracker.trackPosition(String(pos.positionId), pos.costBasisUsdc);
      this.sprayedTokens.add(String(pos.tokenId));
    }
    if (openSprayPositions.length > 0) {
      this.log.info(
        {
          sprayPositions: openSprayPositions.length,
          sprayExposureUsdc: this.sprayTracker.getExposureUsdc(),
        },
        "rehydrated spray tracker",
      );
    }

    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log.error({ err }, "strategy tick error"));
    }, this.deps.scanIntervalMs);

    this.started = true;
    this.log.info({ scanIntervalMs: this.deps.scanIntervalMs }, "strategy module started");
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.bridge.unsubscribe();
    if (this.ownsCandidateBookCache) {
      this.candidateBookCache?.dispose();
    }
    this.started = false;
    this.log.info("strategy module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.started) {
      return { ok: false, detail: "not started" };
    }
    return {
      ok: true,
      detail: `ticks=${this.tickCount} signals=${this.signalCount} markets=${this.cachedMarkets.length}`,
    };
  }

  /** Exposed for testing — in production driven by the interval timer. */
  async tick(): Promise<void> {
    if (this.scanning) return;
    if (this.deps.runtimeControl?.isPaused()) {
      this.log.debug("tick skipped — runtime paused");
      return;
    }
    if (this.cachedMarkets.length === 0) return;

    this.scanning = true;
    try {
      this.tickCount++;
      const tickTs = Date.now();

      // Keep the live-lite scan loop focused on the explicit operator allowlist.
      const filteredMarkets = this.cachedMarkets.filter((m) => {
        if (!m.familyId) return false;

        const fid = String(m.familyId);

        if (!this.deps.liveLiteGuard) {
          return true;
        }

        if (!this.deps.liveLiteGuard.isFamilyAllowed(fid)) {
          return false;
        }

        const familyState = this.deps.familyStateRepo.get(m.familyId);
        if (familyState?.runtimeMode === "quarantine") {
          return false;
        }

        return true;
      });

      if (filteredMarkets.length === 0) {
        this.scanning = false;
        return;
      }

      const scanMarkets = await this.prepareMarketsForScan(filteredMarkets);

      const { signals, meta: scanMeta } = scan(
        scanMarkets,
        {
          rulesProvider: this.deps.rulesProvider,
          positionRepo: this.deps.positionRepo,
          orderRepo: this.deps.orderRepo,
          familyStateRepo: this.deps.familyStateRepo,
          log: this.log,
          globalConfig: this.deps.globalConfig,
          minEntryNotionalUsdc: this.deps.liveLiteGuard?.getMinEntryNotionalUsdc() ?? undefined,
          spraySnapshot: {
            positionCount: this.sprayTracker.getPositionCount(),
            exposureUsdc: this.sprayTracker.getExposureUsdc(),
          },
          sprayedTokens: this.sprayedTokens,
          lastAttemptTs: this.lastAttemptTs,
        },
        this.buyTracker,
        tickTs,
        this.sessionTracker,
      );

      const filteredSignals = this.deps.liveLiteGuard
        ? signals.filter((s) => this.deps.liveLiteGuard!.isFamilyAllowed(String(s.familyId)))
        : signals;

      for (const signal of filteredSignals) {
        this.signalCount++;
        await this.deps.bus.publish("SignalProduced", { signal });
      }

      // Publish scanner metadata every tick (even when no signals) for trading state computation
      await this.deps.bus.publish("ScanTickCompleted", {
        ...scanMeta,
        signalsProduced: filteredSignals.length,
        timestamp: tickTs,
      });

      if (filteredSignals.length > 0) {
        this.log.info(
          { tick: this.tickCount, signals: filteredSignals.length },
          "scan tick produced signals",
        );
      } else {
        this.log.debug({ tick: this.tickCount }, "scan tick — no signals");
      }
    } finally {
      this.scanning = false;
    }
  }

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    this.cachedMarkets = payload.markets;
    this.log.debug({ count: payload.markets.length }, "market cache updated");
  }

  private async prepareMarketsForScan(
    markets: readonly NormalizedMarket[],
  ): Promise<readonly NormalizedMarket[]> {
    if (!this.candidateBookCache) return markets;

    const conditionKeys = new Set<string>();
    for (const market of markets) {
      if (!market.familyId || !market.active) continue;
      const bundle = this.deps.rulesProvider.getRule(market.familyId);
      if (!bundle || !this.deps.rulesProvider.isEnabled(market.familyId)) continue;
      if (bundle.rules.universe.action !== "trade") continue;
      conditionKeys.add(`${market.familyId}|${market.conditionId}`);
    }

    if (conditionKeys.size === 0) return markets;

    const tokenIds = markets
      .filter(
        (market) =>
          market.familyId && conditionKeys.has(`${market.familyId}|${market.conditionId}`),
      )
      .map((market) => String(market.tokenId));
    if (tokenIds.length === 0) return markets;

    try {
      const uniqueTokenIds = [...new Set(tokenIds)];
      const nowMs = Date.now();
      const cachedEntries = new Map<string, ReturnType<CandidateBookCache["getFreshEntry"]>>();
      const staleTokenIds: string[] = [];
      for (const tokenId of uniqueTokenIds) {
        const entry = this.candidateBookCache.getFreshEntry(tokenId, nowMs);
        if (entry) {
          cachedEntries.set(tokenId, entry);
        } else {
          staleTokenIds.push(tokenId);
        }
      }

      const refreshedEntries =
        staleTokenIds.length > 0 ? await this.candidateBookCache.prime(staleTokenIds) : new Map();
      if (cachedEntries.size === 0 && refreshedEntries.size === 0) return markets;
      return markets.map((market) => {
        const entry =
          cachedEntries.get(String(market.tokenId)) ??
          refreshedEntries.get(String(market.tokenId)) ??
          null;
        if (!entry) return market;
        return applyOrderBookToMarket(market, entry);
      });
    } catch (err) {
      this.log.warn({ err, tokenCount: tokenIds.length }, "candidate book enrichment failed");
      return markets;
    }
  }

  private async handlePositionUpdated(payload: RuntimeEventMap["PositionUpdated"]): Promise<void> {
    const { position } = payload;
    const posId = String(position.positionId);

    // Clean up trackers when position is closed or dust (dust is effectively abandoned)
    if (position.status === "closed" || position.status === "dust") {
      this.buyTracker.removeBuyCount(posId);
      this.lastKnownSize.delete(posId);
      if (position.entryStyle === "spray") {
        this.sprayTracker.removePosition(posId);
        this.sprayedTokens.delete(String(position.tokenId));
      }
      return;
    }

    // Track open spray positions — always update exposure (not just on first see)
    // because scale-in grows costBasisUsdc. Map.set overwrites, so this is safe.
    if (position.entryStyle === "spray" && position.status === "open") {
      this.sprayTracker.trackPosition(posId, position.costBasisUsdc);
      this.sprayedTokens.add(String(position.tokenId));
    }

    // Only increment buy count when position size increased (buy fill).
    // Sell fills also produce PositionUpdated with side="buy" for long positions,
    // but they decrease size. Comparing against last-known size distinguishes the two.
    if (position.side === "buy" && position.status === "open") {
      const prevSize = this.lastKnownSize.get(posId) ?? 0;
      if (position.size > prevSize) {
        this.buyTracker.incrementBuyCount(posId);

        // Session tracker: record filled probe/entry (P1-6).
        // A new position (prevSize === 0) means this is the initial probe fill.
        if (prevSize === 0) {
          this.sessionTracker.incrementProbeCount(String(position.tokenId));
          this.sessionTracker.recordNewMarket(String(position.familyId), String(position.tokenId));
        }
      }
      this.lastKnownSize.set(posId, position.size);
    }
  }
}

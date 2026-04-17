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
  EntryRulePreset,
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
  defaultEntryPreset?: EntryRulePreset | undefined;
}

export class StrategyModule implements RuntimeModule {
  private static readonly METRICS_LOG_WINDOW_MS = 30_000;
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
  /** Attempt-level entry cooldown: "familyId|tokenId" → epoch ms of last accepted entry order. */
  private readonly lastAttemptTs = new Map<string, number>();
  private readonly cachedMarkets = new Map<string, NormalizedMarket>();
  private unsubs: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private started = false;
  private tickCount = 0;
  private signalCount = 0;
  private lastMetricsLogAtMs = 0;
  private metricsWindow = {
    scanTicks: 0,
    scanUniverseSize: 0,
    candidatesConsidered: 0,
    signalsProduced: 0,
    normalizedBatchCount: 0,
    normalizedMarketsTotal: 0,
  };

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
      orderRepo: deps.orderRepo,
      liveLiteGuard: deps.liveLiteGuard,
      candidateBookCache: this.candidateBookCache,
    });
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) => this.handleMarketUpdate(p)),
      this.deps.bus.subscribe("PositionUpdated", (p) => this.handlePositionUpdated(p)),
      this.deps.bus.subscribe("OrderPlaced", async (p) => {
        if (ENTRY_REASONS.has(p.signalReason ?? "")) {
          const key = `${p.familyId}|${p.tokenId}`;
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
      detail: `ticks=${this.tickCount} signals=${this.signalCount} markets=${this.cachedMarkets.size}`,
    };
  }

  /** Exposed for testing — in production driven by the interval timer. */
  async tick(): Promise<void> {
    if (this.scanning) return;
    if (this.deps.runtimeControl?.isPaused()) {
      this.log.debug("tick skipped — runtime paused");
      return;
    }
    const cachedMarkets = this.getCachedMarketsSnapshot();
    if (cachedMarkets.length === 0) return;

    this.scanning = true;
    try {
      this.tickCount++;
      const tickTs = Date.now();

      // Keep the live-lite scan loop focused on the explicit operator allowlist.
      const filteredMarkets = cachedMarkets.filter((m) => {
        if (!m.familyId) return false;

        const fid = String(m.familyId);

        if (!this.deps.liveLiteGuard) {
          return true;
        }

        if (!this.deps.liveLiteGuard.isFamilyAllowed(fid)) {
          return false;
        }

        return true;
      });

      if (filteredMarkets.length === 0) {
        this.scanning = false;
        return;
      }

      const { markets: scanMarkets, scanPrimeSkippedByPolicy } =
        await this.prepareMarketsForScan(filteredMarkets);

      const { signals, meta: scanMeta } = scan(
        scanMarkets,
        {
          rulesProvider: this.deps.rulesProvider,
          positionRepo: this.deps.positionRepo,
          orderRepo: this.deps.orderRepo,
          familyStateRepo: this.deps.familyStateRepo,
          log: this.log,
          globalConfig: this.deps.globalConfig,
          defaultEntryPreset: this.deps.defaultEntryPreset,
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

      this.metricsWindow.scanTicks++;
      this.metricsWindow.scanUniverseSize = scanMarkets.length;
      this.metricsWindow.candidatesConsidered += scanMeta.candidatesConsidered;
      this.metricsWindow.signalsProduced += filteredSignals.length;

      for (const signal of filteredSignals) {
        this.signalCount++;
        await this.deps.bus.publish("SignalProduced", { signal });
      }

      // Publish scanner metadata every tick (even when no signals) for trading state computation
      await this.deps.bus.publish("ScanTickCompleted", {
        ...scanMeta,
        scanPrimeSkippedByPolicy,
        signalsProduced: filteredSignals.length,
        timestamp: tickTs,
      });

      if (filteredSignals.length > 0) {
        this.log.info(
          {
            tick: this.tickCount,
            signals: filteredSignals.length,
            strategyCachedMarkets: this.cachedMarkets.size,
            scanUniverseSize: scanMarkets.length,
            candidatesConsidered: scanMeta.candidatesConsidered,
          },
          "scan tick produced signals",
        );
      } else {
        this.log.debug(
          {
            tick: this.tickCount,
            strategyCachedMarkets: this.cachedMarkets.size,
            scanUniverseSize: scanMarkets.length,
            candidatesConsidered: scanMeta.candidatesConsidered,
          },
          "scan tick — no signals",
        );
      }
      this.logMetricsWindowIfNeeded(tickTs);
    } finally {
      this.scanning = false;
    }
  }

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    for (const market of payload.markets) {
      const tokenKey = String(market.tokenId);
      if (!market.active) {
        this.cachedMarkets.delete(tokenKey);
        continue;
      }
      this.cachedMarkets.set(tokenKey, market);
    }
    this.metricsWindow.normalizedBatchCount++;
    this.metricsWindow.normalizedMarketsTotal += payload.markets.length;
    this.log.debug(
      {
        batchSize: payload.markets.length,
        strategyCachedMarkets: this.cachedMarkets.size,
      },
      "market cache merged",
    );
  }

  private getCachedMarketsSnapshot(): readonly NormalizedMarket[] {
    return [...this.cachedMarkets.values()];
  }

  private logMetricsWindowIfNeeded(nowMs: number): void {
    if (this.lastMetricsLogAtMs === 0) {
      this.lastMetricsLogAtMs = nowMs;
      return;
    }
    if (nowMs - this.lastMetricsLogAtMs < StrategyModule.METRICS_LOG_WINDOW_MS) {
      return;
    }
    const avgNormalizedBatchSize =
      this.metricsWindow.normalizedBatchCount > 0
        ? this.metricsWindow.normalizedMarketsTotal / this.metricsWindow.normalizedBatchCount
        : 0;
    this.log.info(
      {
        strategyCachedMarkets: this.cachedMarkets.size,
        scanTicks: this.metricsWindow.scanTicks,
        scanUniverseSize: this.metricsWindow.scanUniverseSize,
        candidatesConsidered: this.metricsWindow.candidatesConsidered,
        signalsProduced: this.metricsWindow.signalsProduced,
        normalizedBatchCount: this.metricsWindow.normalizedBatchCount,
        normalizedMarketsTotal: this.metricsWindow.normalizedMarketsTotal,
        normalizedAvgBatchSize: Number(avgNormalizedBatchSize.toFixed(2)),
        windowMs: nowMs - this.lastMetricsLogAtMs,
      },
      "strategy throughput snapshot",
    );
    this.lastMetricsLogAtMs = nowMs;
    this.metricsWindow = {
      scanTicks: 0,
      scanUniverseSize: 0,
      candidatesConsidered: 0,
      signalsProduced: 0,
      normalizedBatchCount: 0,
      normalizedMarketsTotal: 0,
    };
  }

  private async prepareMarketsForScan(markets: readonly NormalizedMarket[]): Promise<{
    readonly markets: readonly NormalizedMarket[];
    readonly scanPrimeSkippedByPolicy: number;
  }> {
    if (!this.candidateBookCache) {
      return { markets, scanPrimeSkippedByPolicy: 0 };
    }

    const conditionKeys = new Set<string>();
    for (const market of markets) {
      if (!market.familyId || !market.active) continue;
      const bundle = this.deps.rulesProvider.getRule(market.familyId);
      if (!bundle || !this.deps.rulesProvider.isEnabled(market.familyId)) continue;
      if (bundle.rules.universe.action !== "trade") continue;
      conditionKeys.add(`${market.familyId}|${market.conditionId}`);
    }

    if (conditionKeys.size === 0) return { markets, scanPrimeSkippedByPolicy: 0 };

    const tokenIds = markets
      .filter(
        (market) =>
          market.familyId && conditionKeys.has(`${market.familyId}|${market.conditionId}`),
      )
      .map((market) => String(market.tokenId));
    if (tokenIds.length === 0) return { markets, scanPrimeSkippedByPolicy: 0 };

    try {
      const uniqueTokenIds = [...new Set(tokenIds)];
      const nowMs = Date.now();
      const cachedEntries = new Map<string, ReturnType<CandidateBookCache["getFreshEntry"]>>();
      let scanPrimeSkippedByPolicy = 0;
      for (const tokenId of uniqueTokenIds) {
        const entry = this.candidateBookCache.getFreshEntry(tokenId, nowMs);
        if (entry) {
          cachedEntries.set(tokenId, entry);
        } else {
          scanPrimeSkippedByPolicy++;
        }
      }

      if (cachedEntries.size === 0) {
        return { markets, scanPrimeSkippedByPolicy };
      }
      return {
        scanPrimeSkippedByPolicy,
        markets: markets.map((market) => {
          const entry = cachedEntries.get(String(market.tokenId)) ?? null;
          if (!entry) return market;
          return applyOrderBookToMarket(market, entry);
        }),
      };
    } catch (err) {
      this.log.warn({ err, tokenCount: tokenIds.length }, "candidate book enrichment failed");
      return { markets, scanPrimeSkippedByPolicy: 0 };
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

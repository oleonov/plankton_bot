/**
 * Market Scanner Module -- slow-cadence discovery of markets via Gamma API.
 *
 * Responsibilities:
 *  - Discover candidate markets from the exchange catalog
 *  - Evaluate each market against the SelectionRuleEngine (Phase 4+)
 *  - Upsert ALL discovered markets into the DB with selection_status populated
 *  - Run on startup (non-blocking) and on a configurable periodic interval
 *
 * Does NOT provide pricing -- that is MarketDataModule's job.
 * Family matching is NO LONGER performed here (Phase 6 will remove family symbols).
 */

import type {
  RuntimeModule,
  EventBus,
  MarketDiscoveryGateway,
  MarketRepository,
  Market,
  PositionRepository,
  OrderRepository,
} from "@plankton/domain";
import { evaluatePreEntry, createTokenId } from "@plankton/domain";
import type { Logger } from "../../logger.js";
import { isTransientNetworkError } from "../../network-errors.js";
import type { RefreshableSelectionRuleEngine } from "../../selection-rule-engine-factory.js";

const HINT_SCAN_DEBOUNCE_MS = 250;
const HINT_SCAN_MIN_INTERVAL_MS = 60_000;

export interface MarketScannerModuleDeps {
  discoveryGateway: MarketDiscoveryGateway;
  marketRepo: MarketRepository;
  bus: EventBus;
  log: Logger;
  scanIntervalMs: number;
  selectionRuleEngine: RefreshableSelectionRuleEngine;
  /** When provided, tokens with open positions are preserved from deactivation. */
  positionRepo?: PositionRepository;
  /** When provided, tokens with open orders are preserved from deactivation. */
  orderRepo?: OrderRepository;
}

export interface MarketScanResult {
  /** ClobMarkets seen from Gamma (market-level). */
  discoveredMarkets: number;
  /** Markets whose evaluatePreEntry resolved to INCLUDE (market-level). */
  includedMarkets: number;
  /** Token rows written to DB (token-level). */
  savedTokens: number;
  /** Tokens preserved from deactivation via open positions/orders (token-level). */
  preservedTokens: number;
  /** Token rows deactivated (token-level). */
  deactivatedTokens: number;
  durationMs: number;
}

export class MarketScannerModule implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubs: Array<() => void> = [];
  private scanning = false;
  private lastSuccessfulScanMs = 0;
  private wsHintConsumed = 0;
  private readonly log: Logger;

  constructor(private readonly deps: MarketScannerModuleDeps) {
    this.log = deps.log.child({ module: "market-scanner" });
  }

  async start(): Promise<void> {
    this.log.info({ intervalMs: this.deps.scanIntervalMs }, "starting market-scanner module");
    this.unsubs.push(
      this.deps.bus.subscribe("NewMarketDiscoveredHint", async () => {
        this.wsHintConsumed++;
        this.scheduleHintScan();
      }),
    );
    // Fire first scan without blocking startup
    this.scan().catch((err) => this.log.error({ err }, "initial scan failed"));
    this.timer = setInterval(() => {
      this.scan().catch((err) => this.log.error({ err }, "scan cycle error"));
    }, this.deps.scanIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.hintTimer) {
      clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
    this.log.info("market-scanner module stopped");
  }

  getHintMetricsSnapshot(): { readonly discoveryWsHintsConsumed: number } {
    return {
      discoveryWsHintsConsumed: this.wsHintConsumed,
    };
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (this.lastSuccessfulScanMs === 0) {
      return { ok: false, detail: "no successful scan yet" };
    }
    const ageMs = Date.now() - this.lastSuccessfulScanMs;
    // Consider unhealthy if last scan was more than 3x the interval ago
    const stale = ageMs > this.deps.scanIntervalMs * 3;
    return {
      ok: !stale,
      detail: stale
        ? `stale: last scan ${Math.round(ageMs / 1000)}s ago`
        : `fresh: last scan ${Math.round(ageMs / 1000)}s ago`,
    };
  }

  /** Exposed for testing -- in production driven by the interval timer. */
  async scan(): Promise<void> {
    await this.runScan(false);
  }

  /** Blocking startup helper — throws on discovery failures. */
  async scanOrThrow(): Promise<MarketScanResult> {
    const result = await this.runScan(true);
    if (!result) {
      throw new Error("market scan skipped unexpectedly");
    }
    return result;
  }

  private async runScan(throwOnError: boolean): Promise<MarketScanResult | null> {
    if (this.scanning) return null;
    this.scanning = true;
    const startMs = Date.now();

    try {
      this.log.debug("scan cycle starting");

      // Refresh selection rules if the DB version has advanced since last tick.
      this.deps.selectionRuleEngine.refreshIfStale();
      const engine = this.deps.selectionRuleEngine.current;

      let discoveredMarkets = 0;
      let includedMarkets = 0;
      let savedTokens = 0;
      const now = new Date().toISOString();
      const discoveredTokenIds = new Set<string>();

      // Build set of tokens with open positions/orders for preservation
      const activeTokenIds = new Set<string>();
      if (this.deps.positionRepo) {
        for (const pos of this.deps.positionRepo.findOpen()) {
          activeTokenIds.add(String(pos.tokenId));
        }
      }
      if (this.deps.orderRepo) {
        for (const ord of this.deps.orderRepo.findOpen()) {
          activeTokenIds.add(String(ord.tokenId));
        }
      }

      await this.deps.discoveryGateway.forEachMarketPage((pageMarkets) => {
        discoveredMarkets += pageMarkets.length;
        const pageBatch: Market[] = [];
        for (const clobMarket of pageMarkets) {
          const evalResult = evaluatePreEntry(engine, {
            eventSlug: clobMarket.eventSlug ?? null,
            slug: clobMarket.slug,
            eventMarketCount: clobMarket.eventMarketCount,
          });

          // tradable = INCLUDE decision (CLOB entry eligibility)
          const tradable = evalResult.finalStatus === "INCLUDE";
          if (tradable) includedMarkets++;

          const hasActiveLeg = clobMarket.tokens.some((t) => activeTokenIds.has(t.tokenId));

          for (const token of clobMarket.tokens) {
            const tokenId = createTokenId(token.tokenId);
            discoveredTokenIds.add(String(tokenId));
            pageBatch.push({
              tokenId,
              conditionId: clobMarket.conditionId,
              slug: clobMarket.slug,
              eventSlug: clobMarket.eventSlug ?? null,
              question: clobMarket.question,
              outcome: token.outcome,
              outcomeIndex: token.outcomeIndex ?? null,
              regime: null,
              horizon: null,
              endDate: clobMarket.endDate || null,
              active: clobMarket.active || hasActiveLeg,
              // preserved-for-lifecycle markets become tradable=false so MarketSelectionCache
              // stops signalling new BUYs; selection engine determines tradability otherwise.
              tradable: clobMarket.active && tradable,
              tickSize: clobMarket.tickSize,
              negRisk: clobMarket.negRisk,
              eventMarketCount: clobMarket.eventMarketCount,
              selectionStatus: evalResult.selectionStatus,
              selectionWinningRuleId: evalResult.winningRuleId,
              createdAt: now,
              updatedAt: now,
            });
          }
        }
        if (pageBatch.length > 0) {
          this.deps.marketRepo.saveBatch(pageBatch);
          savedTokens += pageBatch.length;
        }
      });

      // Deactivate tracked markets not in latest scan AND without open positions/orders.
      // Uses repo-side cursor + batch update to avoid materialising the full active
      // Market slice (~75 MB peak under full universe) alongside discoveredTokenIds.
      const deactivatedCount = this.deps.marketRepo.deactivateMissing(
        discoveredTokenIds,
        activeTokenIds,
        now,
      );

      this.lastSuccessfulScanMs = Date.now();
      const durationMs = this.lastSuccessfulScanMs - startMs;
      const result: MarketScanResult = {
        discoveredMarkets,
        includedMarkets,
        savedTokens,
        preservedTokens: activeTokenIds.size,
        deactivatedTokens: deactivatedCount,
        durationMs,
      };

      this.log.info(
        {
          discoveredMarkets,
          includedMarkets,
          savedTokens,
          preservedTokens: activeTokenIds.size,
          deactivatedTokens: deactivatedCount,
          durationMs,
        },
        "scan cycle complete",
      );
      return result;
    } catch (err) {
      if (!throwOnError && this.lastSuccessfulScanMs > 0 && isTransientNetworkError(err)) {
        this.log.warn({ err }, "scan cycle degraded — keeping existing catalog");
        return null;
      }
      this.log.error({ err }, "scan cycle failed");
      if (throwOnError) {
        throw err;
      }
      return null;
    } finally {
      this.scanning = false;
    }
  }

  private scheduleHintScan(): void {
    const now = Date.now();
    if (
      this.lastSuccessfulScanMs > 0 &&
      now - this.lastSuccessfulScanMs < HINT_SCAN_MIN_INTERVAL_MS
    ) {
      return;
    }
    if (this.hintTimer) return;
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      if (
        this.lastSuccessfulScanMs > 0 &&
        Date.now() - this.lastSuccessfulScanMs < HINT_SCAN_MIN_INTERVAL_MS
      ) {
        return;
      }
      void this.scan().catch((err) => this.log.error({ err }, "hint-triggered scan failed"));
    }, HINT_SCAN_DEBOUNCE_MS);
  }
}

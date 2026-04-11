/**
 * Market Data Module — refreshes pricing for tracked active markets
 * and publishes MarketSnapshotReceived events.
 *
 * Responsibilities:
 *  - REST polling on a configurable interval (Gamma-backed Phase 1)
 *  - Re-entrancy guard (no overlapping poll cycles)
 *  - Freshness / staleness tracking
 *  - Graceful degradation on failures (no crash, health degrades)
 *
 * Does NOT discover or classify markets — that is the scanner's job.
 * Does NOT enrich markets — that is normalization's job.
 */

import type {
  RuntimeModule,
  EventBus,
  MarketDataGateway,
  MarketRepository,
  NormalizedMarket,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";

export interface MarketDataModuleDeps {
  gateway: MarketDataGateway;
  marketRepo: MarketRepository;
  bus: EventBus;
  log: Logger;
  pollIntervalMs: number;
  staleThresholdMs: number;
  botRunId?: string;
}

export class MarketDataModule implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private lastSuccessfulPollMs = 0;
  private readonly log: Logger;

  constructor(private readonly deps: MarketDataModuleDeps) {
    this.log = deps.log.child({ module: "market-data" });
  }

  async start(): Promise<void> {
    this.log.info(
      { intervalMs: this.deps.pollIntervalMs, staleMs: this.deps.staleThresholdMs },
      "starting market-data module",
    );
    // Fire first poll without blocking startup — interval handles retries
    this.poll().catch((err) => this.log.error({ err }, "initial poll failed"));
    this.timer = setInterval(() => {
      this.poll().catch((err) => this.log.error({ err }, "poll cycle error"));
    }, this.deps.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info("market-data module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (this.lastSuccessfulPollMs === 0) {
      return { ok: false, detail: "no successful poll yet" };
    }
    const ageMs = Date.now() - this.lastSuccessfulPollMs;
    const stale = ageMs > this.deps.staleThresholdMs;
    return {
      ok: !stale,
      detail: stale
        ? `stale: last poll ${Math.round(ageMs / 1000)}s ago`
        : `fresh: last poll ${Math.round(ageMs / 1000)}s ago`,
    };
  }

  /** Exposed for testing — in production driven by the interval timer. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      this.log.debug("poll cycle starting");

      if (this.deps.botRunId) {
        await this.deps.bus.publish("MarketDataPollProgress", {
          active: true,
          page: 0,
          botRunId: this.deps.botRunId,
        });
      }

      const tracked = this.deps.marketRepo.findActive();
      if (tracked.length === 0) {
        this.log.debug("no active tracked markets — skipping pricing, waiting for scanner");
        // Do NOT update lastSuccessfulPollMs — no tracked markets means
        // discovery hasn't run yet or found nothing. Stay STALE.
        await this.deps.bus.publish("MarketSnapshotReceived", {
          markets: [],
          timestamp: Date.now(),
        });
        return;
      }

      const tokenIds = tracked.map((m) => String(m.tokenId));
      this.log.debug(
        { trackedCount: tracked.length, tokenCount: tokenIds.length },
        "fetching pricing for tracked markets",
      );

      const pricingMap = await this.deps.gateway.getMarketPricing(tokenIds);
      const now = Date.now();
      const markets: NormalizedMarket[] = [];

      for (const market of tracked) {
        const pricing = pricingMap.get(String(market.tokenId));
        const bestBid = pricing?.bestBid ?? null;
        const bestAsk = pricing?.bestAsk ?? null;
        const midPrice = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
        const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

        markets.push({
          tokenId: market.tokenId,
          conditionId: market.conditionId,
          slug: market.slug,
          eventSlug: market.eventSlug,
          question: market.question,
          outcome: market.outcome,
          familyId: market.familyId,
          familyKey: market.familyKey,
          regime: market.regime,
          horizon: market.horizon,
          endDate: market.endDate,
          active: market.active,
          tickSize: market.tickSize,
          negRisk: market.negRisk,
          bestBid,
          bestAsk,
          midPrice,
          spread,
          volume24h: pricing?.volume24h ?? null,
          liquidity: pricing?.liquidity ?? null,
          minOrderSize: pricing?.minOrderSize ?? null,
          bookSource: pricing?.bookSource ?? "unknown",
          snapshotTs: now,
        });
      }

      this.lastSuccessfulPollMs = Date.now();
      this.log.info({ tokenCount: markets.length }, "poll cycle complete");

      await this.deps.bus.publish("MarketSnapshotReceived", {
        markets,
        timestamp: Date.now(),
      });
    } catch (err) {
      this.log.error({ err }, "poll cycle failed");
    } finally {
      if (this.deps.botRunId) {
        await this.deps.bus.publish("MarketDataPollProgress", {
          active: false,
          page: 0,
          botRunId: this.deps.botRunId,
        });
      }
      this.polling = false;
    }
  }
}

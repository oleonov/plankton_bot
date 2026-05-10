/**
 * GammaMarketDiscoveryGateway -- discovers markets via the Gamma REST API.
 *
 * Uses the /events endpoint (not /markets) because Gamma excludes event-grouped
 * markets (e.g. will-bitcoin-reach-*) from the paginated /markets listing.
 * The /events endpoint returns nested markets that have identical structure
 * to top-level market objects.
 *
 * Does NOT perform slug filtering -- that is the scanner module's job.
 */

import type { MarketDiscoveryGateway, ClobMarket } from "@krabs/domain";
import { drainResponseBody } from "../live/market-data-gateway.js";
import { mapGammaMarket } from "../mappers.js";
import { isTransientNetworkError, sleep } from "../network-errors.js";

export interface GammaDiscoveryConfig {
  /** Base URL -- defaults to https://gamma-api.polymarket.com */
  baseUrl?: string;
  /** Optional tag_id for server-side category narrowing */
  tagId?: number;
  /** Request timeout in ms (default 30000) */
  timeoutMs?: number;
  /** Page size for offset pagination (default 100) */
  pageSize?: number;
  /** Max retry attempts per page (default 3) */
  maxRetries?: number;
  /** Delay between retries in ms (default 1000) */
  retryDelayMs?: number;
}

const DEFAULT_BASE_URL = "https://gamma-api.polymarket.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export class GammaMarketDiscoveryGateway implements MarketDiscoveryGateway {
  private readonly baseUrl: string;
  private readonly tagId: number | undefined;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(config: GammaDiscoveryConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.tagId = config.tagId;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  async discoverMarkets(): Promise<ClobMarket[]> {
    const allMarkets: ClobMarket[] = [];
    await this.forEachMarketPage((pageMarkets) => {
      allMarkets.push(...pageMarkets);
    });
    return allMarkets;
  }

  async forEachMarketPage(
    callback: (
      markets: ClobMarket[],
      eventStats: { events: number; singleMarket: number; multiMarket: number },
    ) => void,
  ): Promise<{ totalMarkets: number }> {
    let offset = 0;
    let totalMarkets = 0;

    while (true) {
      const events = await this.fetchPage(offset);
      const pageMarkets: ClobMarket[] = [];
      let eventsWithMarkets = 0;
      let singleMarket = 0;
      let multiMarket = 0;
      for (const event of events) {
        const nestedMarkets = Array.isArray(event.markets)
          ? (event.markets as Record<string, unknown>[])
          : [];
        const parentSlug = typeof event.slug === "string" ? event.slug : null;
        const marketCount = nestedMarkets.length;
        // Zero-market events (malformed payload, settled/closed envelopes) are
        // excluded from eventStats entirely so the partition invariant
        // `events == singleMarket + multiMarket` always holds and ADR-003's
        // 39.17 % single-market ratio remains apples-to-apples with what the
        // scanner actually evaluates downstream.
        if (marketCount === 0) continue;
        eventsWithMarkets++;
        if (marketCount === 1) singleMarket++;
        else multiMarket++;
        for (const raw of nestedMarkets) {
          pageMarkets.push(mapGammaMarket(raw, { slug: parentSlug, marketCount }));
        }
      }

      if (eventsWithMarkets > 0) {
        callback(pageMarkets, {
          events: eventsWithMarkets,
          singleMarket,
          multiMarket,
        });
      }
      if (pageMarkets.length > 0) {
        totalMarkets += pageMarkets.length;
      }

      if (events.length < this.pageSize) break;
      offset += this.pageSize;
    }

    return { totalMarkets };
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly latencyMs: number }> {
    const start = Date.now();
    try {
      const url = this.buildUrl(0, 1);
      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await drainResponseBody(response);
      return { ok: response.ok, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  private async fetchPage(offset: number): Promise<Array<Record<string, unknown>>> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const url = this.buildUrl(offset);
        const response = await fetch(url.toString(), {
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
          await drainResponseBody(response);
          throw new Error(`Gamma API responded with ${response.status}: ${response.statusText}`);
        }

        return (await response.json()) as Array<Record<string, unknown>>;
      } catch (err: unknown) {
        if (attempt === this.maxRetries || !this.isTransient(err)) throw err;
        await sleep(this.retryDelayMs);
      }
    }
    throw new Error("unreachable");
  }

  private isTransient(err: unknown): boolean {
    return isTransientNetworkError(err);
  }

  private buildUrl(offset: number, limitOverride?: number): URL {
    const url = new URL("/events", this.baseUrl);
    // ADR-019 §D4 / Step 2 audit P2: align with ADR-003 baseline universe
    // (`active=true&closed=false`). `active=false` events are paused/scheduled
    // and never tradable in the current cycle — excluding them keeps scanner
    // counters apples-to-apples with the published 39.17 % single-event ratio.
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", String(limitOverride ?? this.pageSize));
    url.searchParams.set("offset", String(offset));
    if (this.tagId !== undefined) {
      url.searchParams.set("tag_id", String(this.tagId));
    }
    return url;
  }
}

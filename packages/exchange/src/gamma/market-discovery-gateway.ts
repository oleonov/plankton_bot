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

import type { MarketDiscoveryGateway, ClobMarket } from "@plankton/domain";
import { mapGammaMarket } from "../mappers.js";

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
    let offset = 0;

    while (true) {
      const events = await this.fetchPage(offset);
      for (const event of events) {
        const nestedMarkets = Array.isArray(event.markets)
          ? (event.markets as Record<string, unknown>[])
          : [];
        for (const raw of nestedMarkets) {
          allMarkets.push(mapGammaMarket(raw));
        }
      }

      if (events.length < this.pageSize) break;
      offset += this.pageSize;
    }

    return allMarkets;
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly latencyMs: number }> {
    const start = Date.now();
    try {
      const url = this.buildUrl(0, 1);
      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
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
          throw new Error(
            `Gamma API responded with ${response.status}: ${response.statusText}`,
          );
        }

        return (await response.json()) as Array<Record<string, unknown>>;
      } catch (err: unknown) {
        if (attempt === this.maxRetries || !this.isTransient(err)) throw err;
        await new Promise((r) => setTimeout(r, this.retryDelayMs));
      }
    }
    throw new Error("unreachable");
  }

  private isTransient(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|timed out|UND_ERR_SOCKET/.test(msg);
  }

  private buildUrl(offset: number, limitOverride?: number): URL {
    const url = new URL("/events", this.baseUrl);
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", String(limitOverride ?? this.pageSize));
    url.searchParams.set("offset", String(offset));
    if (this.tagId !== undefined) {
      url.searchParams.set("tag_id", String(this.tagId));
    }
    return url;
  }
}

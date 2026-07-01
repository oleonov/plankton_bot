/**
 * GammaMarketDiscoveryGateway -- discovers markets via the Gamma REST API.
 *
 * Uses the /events/keyset endpoint (not /markets) because Gamma excludes
 * event-grouped markets (e.g. will-bitcoin-reach-*) from the paginated /markets
 * listing. The /events/keyset endpoint returns nested markets that have
 * identical structure to top-level market objects.
 *
 * Does NOT perform slug filtering -- that is the scanner module's job.
 */

import type { MarketDiscoveryGateway, ClobMarket, DepHealthRecorder } from "@krabs/domain";
import { drainResponseBody } from "../live/market-data-gateway.js";
import { timeDepCall } from "../dep-health.js";
import { mapGammaMarket } from "../mappers.js";
import { isTransientNetworkError, sleep } from "../network-errors.js";

export interface GammaDiscoveryConfig {
  /** Base URL -- defaults to https://gamma-api.polymarket.com */
  baseUrl?: string;
  /** Optional tag_id for server-side category narrowing */
  tagId?: number;
  /** Request timeout in ms (default 30000) */
  timeoutMs?: number;
  /** Page size for keyset pagination (default 100) */
  pageSize?: number;
  /** Max retry attempts per page (default 3) */
  maxRetries?: number;
  /** Delay between retries in ms (default 1000) */
  retryDelayMs?: number;
  /** Optional Phase-2 dependency-latency recorder (measure-only; no-op when absent). */
  depHealthRecorder?: DepHealthRecorder | null;
}

const DEFAULT_BASE_URL = "https://gamma-api.polymarket.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const CURSOR_PREVIEW_MAX_LENGTH = 32;

/**
 * Extract event-level Gamma tags as slug strings (Track B §4.2b). The
 * `/events/keyset` payload returns `tags` as an array of objects
 * (`{ id, label, slug, ... }`, prod-verified); we prefer `slug`, fall back to
 * `label`. Tolerates a plain string array defensively. Null when absent/empty.
 */
function extractEventTags(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const tags = value
    .map((t): string | null => {
      if (typeof t === "string") return t;
      if (t != null && typeof t === "object") {
        const obj = t as Record<string, unknown>;
        if (typeof obj.slug === "string") return obj.slug;
        if (typeof obj.label === "string") return obj.label;
      }
      return null;
    })
    .filter((t): t is string => t != null);
  return tags.length > 0 ? tags : null;
}

function previewCursor(afterCursor: string | null): string | null {
  if (!afterCursor) return null;
  if (afterCursor.length <= CURSOR_PREVIEW_MAX_LENGTH) return afterCursor;
  return `${afterCursor.slice(0, CURSOR_PREVIEW_MAX_LENGTH)}...`;
}

function gammaApiResponseError(args: {
  response: Response;
  url: URL;
  afterCursor: string | null;
  attempt: number;
  maxAttempts: number;
}): Error {
  const err = new Error(
    `Gamma API responded with ${args.response.status}: ${args.response.statusText}`,
  );
  return Object.assign(err, {
    operation: "gamma.events.keyset",
    statusCode: args.response.status,
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    endpointPath: args.url.pathname,
    cursorPreview: previewCursor(args.afterCursor),
  });
}

interface GammaEventsPage {
  readonly events: Array<Record<string, unknown>>;
  readonly nextCursor: string | null;
}

export class GammaMarketDiscoveryGateway implements MarketDiscoveryGateway {
  private readonly baseUrl: string;
  private readonly tagId: number | undefined;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly depHealthRecorder: DepHealthRecorder | null;

  constructor(config: GammaDiscoveryConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.tagId = config.tagId;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.depHealthRecorder = config.depHealthRecorder ?? null;
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
    let afterCursor: string | null = null;
    let totalMarkets = 0;

    while (true) {
      const page = await this.fetchPage(afterCursor);
      const events = page.events;
      const pageMarkets: ClobMarket[] = [];
      let eventsWithMarkets = 0;
      let singleMarket = 0;
      let multiMarket = 0;
      for (const event of events) {
        const nestedMarkets = Array.isArray(event.markets)
          ? (event.markets as Record<string, unknown>[])
          : [];
        const parentSlug = typeof event.slug === "string" ? event.slug : null;
        const eventTags = extractEventTags(event.tags);
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
          pageMarkets.push(mapGammaMarket(raw, { slug: parentSlug, marketCount, tags: eventTags }));
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

      if (!page.nextCursor) break;
      afterCursor = page.nextCursor;
    }

    return { totalMarkets };
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly latencyMs: number }> {
    const start = Date.now();
    try {
      const url = this.buildUrl(null, 1);
      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await drainResponseBody(response);
      return { ok: response.ok, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  private async fetchPage(afterCursor: string | null): Promise<GammaEventsPage> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const url = this.buildUrl(afterCursor);
        // Phase-2a: HEADER-LEVEL HTTP telemetry — `fetch` resolves on response
        // headers, so body read/parse latency is NOT included and a post-200
        // body/parse failure is not counted. Tightened to full-attempt
        // measurement in 2b (before threshold calibration).
        const response = await timeDepCall(
          this.depHealthRecorder,
          "gamma",
          () => fetch(url.toString(), { signal: AbortSignal.timeout(this.timeoutMs) }),
          { isOk: (r: Response) => r.ok },
        );

        if (!response.ok) {
          await drainResponseBody(response);
          throw gammaApiResponseError({
            response,
            url,
            afterCursor,
            attempt,
            maxAttempts: this.maxRetries,
          });
        }

        return this.parseEventsPage(await response.json());
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

  private buildUrl(afterCursor: string | null, limitOverride?: number): URL {
    const url = new URL("/events/keyset", this.baseUrl);
    // ADR-019 §D4 / Step 2 audit P2: align with ADR-003 baseline universe
    // (`active=true&closed=false`). `active=false` events are paused/scheduled
    // and never tradable in the current cycle — excluding them keeps scanner
    // counters apples-to-apples with the published 39.17 % single-event ratio.
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", String(limitOverride ?? this.pageSize));
    if (afterCursor) {
      url.searchParams.set("after_cursor", afterCursor);
    }
    if (this.tagId !== undefined) {
      url.searchParams.set("tag_id", String(this.tagId));
    }
    return url;
  }

  private parseEventsPage(body: unknown): GammaEventsPage {
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Gamma API keyset response must be an object");
    }

    const record = body as Record<string, unknown>;
    const events = record["events"];
    if (!Array.isArray(events)) {
      throw new Error("Gamma API keyset response missing events array");
    }

    const nextCursor = record["next_cursor"];
    return {
      events: events as Array<Record<string, unknown>>,
      nextCursor: typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : null,
    };
  }
}

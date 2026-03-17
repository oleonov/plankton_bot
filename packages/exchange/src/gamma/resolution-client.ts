/**
 * GammaResolutionClient — queries Gamma API for market resolution status.
 *
 * Uses documented endpoints:
 *  - GET /markets/slug/{slug}
 *  - GET /markets/{conditionId}
 *
 * Rate limits: 300 req/10s for /markets (documented).
 * We target ~10 req/s max to stay well within limits.
 */

const DEFAULT_BASE_URL = "https://gamma-api.polymarket.com";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export interface GammaResolutionConfig {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface GammaMarketInfo {
  conditionId: string;
  slug: string;
  closed: boolean;
  closedTime: string | null;
  umaResolutionStatus: string | null;
  endDate: string;
  rawPayload: Record<string, unknown>;
}

export class GammaResolutionClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(config: GammaResolutionConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  async getMarketBySlug(slug: string): Promise<GammaMarketInfo | null> {
    const url = new URL(`/markets/slug/${encodeURIComponent(slug)}`, this.baseUrl);
    return this.fetchMarket(url);
  }

  async getMarketById(conditionId: string): Promise<GammaMarketInfo | null> {
    const url = new URL(`/markets/${encodeURIComponent(conditionId)}`, this.baseUrl);
    return this.fetchMarket(url);
  }

  private async fetchMarket(url: URL): Promise<GammaMarketInfo | null> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(url.toString(), {
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.status === 404) return null;

        if (!response.ok) {
          throw new Error(
            `Gamma API responded with ${response.status}: ${response.statusText}`,
          );
        }

        const raw = (await response.json()) as Record<string, unknown>;

        // Gamma returns an empty object or array for delisted markets
        if (!raw || (Array.isArray(raw) && raw.length === 0)) return null;
        if (typeof raw !== "object" || !raw.condition_id) return null;

        return {
          conditionId: raw.condition_id as string,
          slug: (raw.slug as string) ?? "",
          closed: raw.closed === true || raw.closed === "true",
          closedTime: (raw.closed_time as string) ?? null,
          umaResolutionStatus: (raw.uma_resolution_status as string) ?? null,
          endDate: (raw.end_date_iso as string) ?? (raw.end_date as string) ?? "",
          rawPayload: raw,
        };
      } catch (err: unknown) {
        if (attempt === this.maxRetries || !this.isTransient(err)) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, this.retryDelayMs));
      }
    }
    throw new Error("unreachable");
  }

  private isTransient(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|timed out|UND_ERR_SOCKET/.test(msg);
  }
}

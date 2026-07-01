import type { DepHealthRecorder } from "@krabs/domain";
import { drainResponseBody } from "../live/market-data-gateway.js";
import { timeDepCall } from "../dep-health.js";
import { isTransientNetworkError, sleep } from "../network-errors.js";

/**
 * GammaResolutionClient — queries Gamma API for market resolution status.
 *
 * Primary endpoint: GET /markets/slug/{slug}
 * Fallback endpoint: GET /markets/{id} — accepts Gamma's internal numeric id,
 *   NOT conditionId (returns 422 for conditionId; treated as not-found).
 *
 * Gamma returns camelCase fields (conditionId, endDateIso, closedTime, etc.).
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
  /** Optional Phase-2 dependency-latency recorder (measure-only; no-op when absent). */
  depHealthRecorder?: DepHealthRecorder | null;
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
  private readonly depHealthRecorder: DepHealthRecorder | null;

  constructor(config: GammaResolutionConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.depHealthRecorder = config.depHealthRecorder ?? null;
  }

  async getMarketBySlug(slug: string): Promise<GammaMarketInfo | null> {
    const url = new URL(`/markets/slug/${encodeURIComponent(slug)}`, this.baseUrl);
    return this.fetchMarket(url);
  }

  /**
   * Fallback lookup by conditionId. The /markets/{id} endpoint doesn't actually
   * accept conditionId (returns 422), so this gracefully returns null in that case.
   * Kept as a fallback for slug-rename scenarios where Gamma may eventually
   * support conditionId lookups.
   */
  async getMarketById(conditionId: string): Promise<GammaMarketInfo | null> {
    const url = new URL(`/markets/${encodeURIComponent(conditionId)}`, this.baseUrl);
    return this.fetchMarket(url);
  }

  private async fetchMarket(url: URL): Promise<GammaMarketInfo | null> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        // Phase-2a: HEADER-LEVEL HTTP telemetry — `fetch` resolves when response
        // headers arrive, so body read/parse latency is NOT included and a
        // post-200 body/parse failure is not counted here. Tightened to full-
        // attempt measurement in 2b (before threshold calibration).
        // 404/422 are valid "not found" responses — the dependency is reachable.
        const response = await timeDepCall(
          this.depHealthRecorder,
          "gamma",
          () => fetch(url.toString(), { signal: AbortSignal.timeout(this.timeoutMs) }),
          { isOk: (r: Response) => r.ok || r.status === 404 || r.status === 422 },
        );

        // 404 = not found, 422 = endpoint doesn't accept this ID format
        if (response.status === 404 || response.status === 422) {
          await drainResponseBody(response);
          return null;
        }

        if (!response.ok) {
          await drainResponseBody(response);
          throw new Error(`Gamma API responded with ${response.status}: ${response.statusText}`);
        }

        const raw = (await response.json()) as Record<string, unknown>;

        // Gamma returns an empty object or array for delisted markets
        if (!raw || (Array.isArray(raw) && raw.length === 0)) return null;
        // Gamma returns camelCase fields (conditionId, endDateIso, etc.)
        const cid = (raw.conditionId ?? raw.condition_id) as string | undefined;
        if (typeof raw !== "object" || !cid) return null;

        return {
          conditionId: cid,
          slug: (raw.slug as string) ?? "",
          closed: raw.closed === true || raw.closed === "true",
          closedTime: ((raw.closedTime ?? raw.closed_time) as string) ?? null,
          umaResolutionStatus:
            ((raw.umaResolutionStatus ?? raw.uma_resolution_status) as string) ?? null,
          endDate:
            ((raw.endDateIso ?? raw.end_date_iso ?? raw.endDate ?? raw.end_date) as string) ?? "",
          rawPayload: raw,
        };
      } catch (err: unknown) {
        if (attempt === this.maxRetries || !this.isTransient(err)) {
          throw err;
        }
        await sleep(this.retryDelayMs);
      }
    }
    throw new Error("unreachable");
  }

  private isTransient(err: unknown): boolean {
    return isTransientNetworkError(err);
  }
}

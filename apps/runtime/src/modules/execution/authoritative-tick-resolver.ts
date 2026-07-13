/**
 * AuthoritativeTickResolver — lazy, cached lookup of the authoritative CLOB
 * minimum_tick_size at the order boundary.
 *
 * Precedence per market (plan Phase 1 / scope D1):
 *   1. CLOB /markets minimum_tick_size  (authoritative — via getMarket)
 *   2. persistedTickSize               (caller-supplied; from cmd.tickSize / markets.tick_size)
 *   3. /tick-size endpoint             (constrained last-resort — via getTickSize, only reached
 *                                       when both getMarket AND persisted are unavailable)
 *   4. 0.01                            (absolute last-resort)
 *
 * A legit 0.001 market returns 0.001; we never hardcode 0.01 for a market
 * whose CLOB value disagrees. Cache is bounded by TTL; lookup failure always
 * falls through rather than blocking the order.
 */

import type { ClobMarket, TokenId } from "@krabs/domain";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min

interface CacheEntry {
  tick: number;
  resolvedAt: number;
}

export class AuthoritativeTickResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly getMarket: (conditionId: string) => Promise<ClobMarket | null>;
  private readonly getTickSize: ((tokenId: TokenId) => Promise<number>) | undefined;

  constructor(opts: {
    getMarket: (conditionId: string) => Promise<ClobMarket | null>;
    /** /tick-size endpoint — only called as last-resort when getMarket + persisted both fail. */
    getTickSize?: (tokenId: TokenId) => Promise<number>;
    ttlMs?: number;
  }) {
    this.getMarket = opts.getMarket;
    this.getTickSize = opts.getTickSize;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Resolve the authoritative tick for conditionId.
   *
   * Precedence:
   *   1. CLOB /markets minimum_tick_size (cached, via getMarket)
   *   2. persistedTickSize (cmd.tickSize / markets.tick_size)
   *   3. /tick-size endpoint (constrained last-resort, only when getTickSize supplied
   *      and both step 1 + 2 are unavailable)
   *   4. 0.01 (absolute fallback)
   *
   * Never throws — any lookup error produces a safe fallback.
   *
   * @param tokenId  Optional — only used for the /tick-size last-resort (step 3).
   *                 When omitted, step 3 is skipped and falls through to 0.01.
   */
  async resolve(
    conditionId: string,
    persistedTickSize: number,
    tokenId?: TokenId | string,
  ): Promise<number> {
    const now = Date.now();
    const hit = this.cache.get(conditionId);
    if (hit && now - hit.resolvedAt < this.ttlMs) {
      return hit.tick;
    }

    // Step 1: authoritative CLOB /markets minimum_tick_size
    try {
      const market = await this.getMarket(conditionId);
      if (market && Number.isFinite(market.tickSize) && market.tickSize > 0) {
        this.cache.set(conditionId, { tick: market.tickSize, resolvedAt: now });
        return market.tickSize;
      }
    } catch {
      // fall through
    }

    // Step 2: persisted markets.tick_size (already in cmd.tickSize)
    if (Number.isFinite(persistedTickSize) && persistedTickSize > 0) {
      return persistedTickSize;
    }

    // Step 3: /tick-size endpoint — constrained last-resort before hardcoded 0.01
    if (this.getTickSize && tokenId != null) {
      try {
        const tick = await this.getTickSize(tokenId as TokenId);
        if (Number.isFinite(tick) && tick > 0) {
          return tick;
        }
      } catch {
        // fall through to absolute last-resort
      }
    }

    // Step 4: absolute last-resort
    return 0.01;
  }

  /** Evict a single condition from cache (use after a confirmed tick correction). */
  invalidate(conditionId: string): void {
    this.cache.delete(conditionId);
  }
}

import type { EventBus, MarketSelectionPolicy, NormalizedMarket, TokenId } from "@krabs/domain";
import { evaluatePreEntry, type PreEntryRejectReason } from "@krabs/domain";
import type { SelectedMarketCache } from "./algo-decision-module.js";
import type { RefreshableSelectionRuleEngine } from "../../selection-rule-engine-factory.js";

// v5.11 §1 — Live Pre-Entry Filter, driven by hard price/liquidity/category gates.
//
// Eligibility gates NEW BUYs only. We key on `tradable` (CLOB-entry-eligible),
// not `active`: preserved-for-lifecycle markets (active=true, tradable=false)
// keep flowing pricing for SELL/REDEEM but are excluded from new-entry gating.

/**
 * ADR-018 §D2 — Step 1 universe-filter funnel telemetry.
 *
 * Legacy funnel counters retained for dashboards that still read them. Volume
 * no longer blocks admission; v5.11 hard filters are applied by evaluatePreEntry.
 *
 * Invariants:
 *  - volume-partition (disjoint within layer):
 *    `seen == volumeZeroDropped + volumeNullEvaluated + volumePositiveEvaluated`
 *  - selection-partition (disjoint within layer; only counts evaluated events):
 *    `volumeNullEvaluated + volumePositiveEvaluated == selectionRuleAdmitted + selectionRuleRejected`
 */
export interface UniverseFilterSnapshot {
  readonly seen: number;
  readonly volumeZeroDropped: number;
  readonly volumeNullEvaluated: number;
  readonly volumePositiveEvaluated: number;
  readonly selectionRuleAdmitted: number;
  readonly selectionRuleRejected: number;
  readonly selectionRejectReasons: Readonly<Record<string, number>>;
}

export class MarketSelectionCache implements SelectedMarketCache {
  private readonly eligible = new Set<string>();
  private unsub: (() => void) | null = null;
  private trackedUnsub: (() => void) | null = null;

  // ADR-018 §D2 — funnel counters. Process-cumulative, never reset.
  private seen = 0;
  private volumeZeroDropped = 0;
  private volumeNullEvaluated = 0;
  private volumePositiveEvaluated = 0;
  private selectionRuleAdmitted = 0;
  private selectionRuleRejected = 0;
  private readonly selectionRejectReasons = new Map<string, number>();

  constructor(
    private readonly bus: EventBus,
    private readonly selectionRuleEngine: RefreshableSelectionRuleEngine,
    private readonly marketSelectionPolicy?: () => MarketSelectionPolicy,
  ) {}

  subscribe(): void {
    this.unsub = this.bus.subscribe("NormalizedMarketUpdated", async (payload) => {
      const policy = this.marketSelectionPolicy?.();
      for (const market of payload.markets) {
        this.processMarket(market, policy);
      }
    });
    // Drop eligibility for tokens that exit the tracked universe so `eligible`
    // doesn't accumulate ghost entries from vanished tokens. The existing
    // NormalizedMarketUpdated handler self-cleans on non-tradable/!INCLUDE
    // updates, but never sees tokens that simply stopped being tracked.
    this.trackedUnsub = this.bus.subscribe("TrackedMarketsChanged", async (payload) => {
      for (const tokenId of payload.removedTokenIds) {
        this.eligible.delete(String(tokenId));
      }
    });
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
    this.trackedUnsub?.();
    this.trackedUnsub = null;
  }

  isEligible(tokenId: TokenId): boolean {
    return this.eligible.has(String(tokenId));
  }

  getEligibleTokenIds(): TokenId[] {
    return [...this.eligible] as TokenId[];
  }

  /**
   * ADR-018 §D2 — Step 1 universe-filter funnel snapshot. Counters are
   * process-cumulative; callers compute deltas if rate metrics are needed.
   */
  getUniverseFilterSnapshot(): UniverseFilterSnapshot {
    return {
      seen: this.seen,
      volumeZeroDropped: this.volumeZeroDropped,
      volumeNullEvaluated: this.volumeNullEvaluated,
      volumePositiveEvaluated: this.volumePositiveEvaluated,
      selectionRuleAdmitted: this.selectionRuleAdmitted,
      selectionRuleRejected: this.selectionRuleRejected,
      selectionRejectReasons: Object.fromEntries(this.selectionRejectReasons.entries()),
    };
  }

  private processMarket(market: NormalizedMarket, policy?: MarketSelectionPolicy): void {
    const tokenId = String(market.tokenId);
    if (!market.tradable) {
      // Untracked/preserved-for-lifecycle tokens are out of scope for the
      // admission funnel — they cannot be NEW-BUY admitted.
      this.eligible.delete(tokenId);
      return;
    }
    this.seen++;
    if (market.volume24h == null) {
      this.volumeNullEvaluated++;
    } else {
      this.volumePositiveEvaluated++;
    }
    const evalResult = evaluatePreEntry(
      this.selectionRuleEngine.current,
      {
        eventSlug: market.eventSlug,
        slug: market.slug,
        eventMarketCount: market.eventMarketCount,
        question: market.question,
        midPrice: market.midPrice,
        liquidity: market.liquidity ?? null,
      },
      policy,
    );
    if (evalResult.finalStatus === "INCLUDE") {
      this.selectionRuleAdmitted++;
      this.eligible.add(tokenId);
    } else {
      this.selectionRuleRejected++;
      this.incrementRejectReason(classifySelectionRejectReason(market, evalResult.rejectReason));
      this.eligible.delete(tokenId);
    }
  }

  private incrementRejectReason(reason: string): void {
    this.selectionRejectReasons.set(reason, (this.selectionRejectReasons.get(reason) ?? 0) + 1);
  }
}

const FEATURE_STALE_MS = 4 * 60 * 60 * 1000;

function classifySelectionRejectReason(
  market: NormalizedMarket,
  rejectReason: PreEntryRejectReason | undefined,
): string {
  if (
    market.featuresCapturedTs != null &&
    Date.now() - market.featuresCapturedTs > FEATURE_STALE_MS
  ) {
    return "rejected_stale_snapshot";
  }
  if (
    rejectReason === "mid_price_too_high" &&
    (market.midPrice == null || !Number.isFinite(market.midPrice))
  ) {
    return "rejected_no_midprice";
  }
  if (
    rejectReason === "liquidity_too_low" &&
    (market.liquidity == null || !Number.isFinite(market.liquidity))
  ) {
    return "rejected_missing_feature_liquidity";
  }
  if (rejectReason) return `rejected_${rejectReason}`;
  if (market.volume24hr == null || !Number.isFinite(market.volume24hr)) {
    return "rejected_missing_feature_volume24hr";
  }
  return "rejected_other";
}

import type { EventBus, TokenId } from "@plankton/domain";
import { evaluatePreEntry } from "@plankton/domain";
import type { SelectedMarketCache } from "./algo-decision-module.js";
import type { RefreshableSelectionRuleEngine } from "../../selection-rule-engine-factory.js";

// Spec §0 — Live Pre-Entry Filter, driven by SelectionRuleEngine (Phase 4+).
//
// Eligibility gates NEW BUYs only. We key on `tradable` (CLOB-entry-eligible),
// not `active`: preserved-for-lifecycle markets (active=true, tradable=false)
// keep flowing pricing for SELL/REDEEM but are excluded from new-entry gating.
//
// Historical Universe Filter (spec §0 R1, `trade_count > 0`) — Gamma exposes
// no `trade_count` field; we use lifetime volume (`volumeNum`) as a proxy per
// ADR-007. `volume24h === 0` (lifetime never traded) → excluded. `null`
// (unknown, e.g. CLOB path) → not blocked.

/**
 * ADR-018 §D2 — Step 1 universe-filter funnel telemetry.
 *
 * Two-partition counters of `NormalizedMarketUpdated` events that reach the
 * gate while `tradable === true`. Counters are cumulative since process start
 * (monotonic), updated **per processed event** (not per unique token — a token
 * may migrate between buckets across updates).
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

  constructor(
    private readonly bus: EventBus,
    private readonly selectionRuleEngine: RefreshableSelectionRuleEngine,
  ) {}

  subscribe(): void {
    this.unsub = this.bus.subscribe("NormalizedMarketUpdated", async (payload) => {
      for (const market of payload.markets) {
        this.processMarket(
          String(market.tokenId),
          market.eventSlug,
          market.slug,
          market.eventMarketCount,
          market.tradable,
          market.volume24h ?? null,
        );
      }
    });
    // Drop eligibility for tokens that exit the tracked universe so `eligible`
    // doesn't accumulate ghost entries from vanished tokens. The existing
    // NormalizedMarketUpdated handler self-cleans on non-tradable/volume=0/!INCLUDE
    // but never sees tokens that simply stopped being tracked.
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
    };
  }

  private processMarket(
    tokenId: string,
    eventSlug: string | null,
    slug: string,
    eventMarketCount: number,
    tradable: boolean,
    volumeLifetime: number | null,
  ): void {
    if (!tradable) {
      // Untracked/preserved-for-lifecycle tokens are out of scope for the
      // Step 1 funnel — they cannot be NEW-BUY admitted regardless of volume.
      this.eligible.delete(tokenId);
      return;
    }
    this.seen++;
    // ADR-007: Historical Universe Filter (spec §0 R1). `volumeLifetime === 0`
    // means the market has never traded — proxy for `trade_count > 0`. `null`
    // is treated as unknown (not blocking) — typical for CLOB-path markets.
    if (volumeLifetime != null && volumeLifetime === 0) {
      this.volumeZeroDropped++;
      this.eligible.delete(tokenId);
      return;
    }
    if (volumeLifetime == null) {
      this.volumeNullEvaluated++;
    } else {
      this.volumePositiveEvaluated++;
    }
    const evalResult = evaluatePreEntry(this.selectionRuleEngine.current, {
      eventSlug,
      slug,
      eventMarketCount,
    });
    if (evalResult.finalStatus === "INCLUDE") {
      this.selectionRuleAdmitted++;
      this.eligible.add(tokenId);
    } else {
      this.selectionRuleRejected++;
      this.eligible.delete(tokenId);
    }
  }
}

import type {
  EventBus,
  MarketSelectionPolicy,
  NormalizedMarket,
  RiskEventRepository,
  TokenId,
} from "@krabs/domain";
import {
  evaluatePreEntry,
  evaluateShortLifetimeGuard,
  DEFAULT_BUY_GUARD_SHORT_LIFETIME_POLICY,
  type PreEntryRejectReason,
} from "@krabs/domain";
import type { SelectedMarketCache } from "./algo-decision-module.js";
import type { RefreshableSelectionRuleEngine } from "../../selection-rule-engine-factory.js";
import type { EffectiveResolutionGate } from "../../effective-resolution-service.js";

// GATE selection-bypass (docs/plans/2026-07-17-gate-entry-selection-bypass.md):
// ONLY the v5.11 hard *data* filters (null live liquidity / mid / zero-coverage
// category) are bypassable for a whitelisted GATE market — those wrongly drop the
// cheap deep-OTM longshots GATE targets. Explicit selection-rule excludes, strike,
// and short-lifetime rejects stay authoritative and are NEVER bypassed.
const GATE_BYPASSABLE_REJECT_REASONS: ReadonlySet<PreEntryRejectReason> = new Set([
  "liquidity_too_low",
  "mid_price_too_high",
  "zero_coverage_category",
]);

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
  // GATE selection-bypass: tokens rejected by v5.11 ONLY via a bypassable hard
  // data filter (see GATE_BYPASSABLE_REJECT_REASONS). Disjoint from `eligible`.
  private readonly gateBypassEligible = new Set<string>();
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

  // Track B §5.4 — durable strike-reject counter for T+7d monitoring. Dedup
  // per token (in-memory; reset on restart) so a chatty NormalizedMarketUpdated
  // stream writes at most one risk_events row per token per process lifetime.
  private readonly persistedRejects = new Set<string>();

  constructor(
    private readonly bus: EventBus,
    private readonly selectionRuleEngine: RefreshableSelectionRuleEngine,
    private readonly marketSelectionPolicy?: () => MarketSelectionPolicy,
    private readonly riskEventSink?: Pick<RiskEventRepository, "insert">,
    private readonly effectiveResolution?: Pick<EffectiveResolutionGate, "toPreEntryFields">,
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
        this.gateBypassEligible.delete(String(tokenId));
        // Allow a token to be re-persisted if it re-enters the universe later.
        this.persistedRejects.delete(String(tokenId));
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

  /**
   * GATE selection-bypass (docs/plans/2026-07-17-gate-entry-selection-bypass.md):
   * true when this token was rejected by v5.11 ONLY via a bypassable hard data
   * filter (null live liquidity / mid / zero-coverage category), never via an
   * explicit rule-exclude / strike / short-lifetime reject, and it is tradable
   * (non-tradable tokens return before evaluation and are cleared here). The GATE
   * lane may then evaluate it on a pure GATE path; nothing else may enter it.
   */
  isGateBypassEligible(tokenId: TokenId): boolean {
    return this.gateBypassEligible.has(String(tokenId));
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
      // admission funnel — they cannot be NEW-BUY admitted (GATE bypass included).
      this.eligible.delete(tokenId);
      this.gateBypassEligible.delete(tokenId);
      return;
    }
    this.seen++;
    if (market.volume24h == null) {
      this.volumeNullEvaluated++;
    } else {
      this.volumePositiveEvaluated++;
    }
    const preEntryInput = {
      eventSlug: market.eventSlug,
      slug: market.slug,
      eventMarketCount: market.eventMarketCount,
      question: market.question,
      midPrice: market.midPrice,
      liquidity: market.liquidity ?? null,
      endDate: market.endDate,
      groupItemTitle: market.groupItemTitle ?? null,
      groupItemThreshold: market.groupItemThreshold ?? null,
      tags: market.tags ?? null,
      ...this.effectiveResolution?.toPreEntryFields(market),
    };
    const evalResult = evaluatePreEntry(this.selectionRuleEngine.current, preEntryInput, policy);
    if (evalResult.finalStatus === "INCLUDE") {
      this.selectionRuleAdmitted++;
      this.eligible.add(tokenId);
      // Normally eligible now — no bypass needed; clear any stale bypass flag.
      this.gateBypassEligible.delete(tokenId);
    } else {
      this.selectionRuleRejected++;
      this.incrementRejectReason(classifySelectionRejectReason(market, evalResult.rejectReason));
      this.persistStrikeReject(tokenId, market, evalResult.rejectReason, evalResult.horizonHours);
      this.eligible.delete(tokenId);
      // GATE selection-bypass: only a bypassable hard-data-filter reject keeps the
      // token reachable by the GATE lane; any other reject (rule_exclude / strike /
      // short_lifetime) is authoritative and clears bypass eligibility. A hard-filter
      // reject MASKS the short-lifetime guard (evaluatePreEntry checks hard filters
      // BEFORE short-lifetime and returns early), so re-check it explicitly here: a
      // near-resolution market must NOT be bypassed even when whitelisted, since
      // GATE's own eligibility gates total lifespan, not time-to-close.
      const bypassable =
        evalResult.rejectReason != null &&
        GATE_BYPASSABLE_REJECT_REASONS.has(evalResult.rejectReason) &&
        !evaluateShortLifetimeGuard(
          preEntryInput,
          policy?.shortLifetime ?? DEFAULT_BUY_GUARD_SHORT_LIFETIME_POLICY,
        ).blocked;
      if (bypassable) {
        this.gateBypassEligible.add(tokenId);
      } else {
        this.gateBypassEligible.delete(tokenId);
      }
    }
  }

  // Track B §5.4 — durable, per-token-deduped persistence of the two D1 strike
  // rejects into risk_events for T+7d monitoring.
  private persistStrikeReject(
    tokenId: string,
    market: NormalizedMarket,
    rejectReason: PreEntryRejectReason | undefined,
    horizonHours: number | undefined,
  ): void {
    if (rejectReason !== "strike_min_horizon" && rejectReason !== "strike_yes_tail_short_runway") {
      return;
    }
    if (this.riskEventSink == null || this.persistedRejects.has(tokenId)) return;
    this.riskEventSink.insert({
      eventType: "selection_reject",
      payload: {
        reason: rejectReason,
        tokenId,
        slug: market.slug,
        midPrice: market.midPrice,
        horizonHours: horizonHours ?? null,
        regime: "strike",
        ts: Date.now(),
      },
    });
    this.persistedRejects.add(tokenId);
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

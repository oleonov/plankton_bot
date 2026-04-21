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
export class MarketSelectionCache implements SelectedMarketCache {
  private readonly eligible = new Set<string>();
  private unsub: (() => void) | null = null;
  private trackedUnsub: (() => void) | null = null;

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

  private processMarket(
    tokenId: string,
    eventSlug: string | null,
    slug: string,
    eventMarketCount: number,
    tradable: boolean,
    volumeLifetime: number | null,
  ): void {
    if (!tradable) {
      this.eligible.delete(tokenId);
      return;
    }
    // ADR-007: Historical Universe Filter (spec §0 R1). `volumeLifetime === 0`
    // means the market has never traded — proxy for `trade_count > 0`. `null`
    // is treated as unknown (not blocking) — typical for CLOB-path markets.
    if (volumeLifetime != null && volumeLifetime === 0) {
      this.eligible.delete(tokenId);
      return;
    }
    const evalResult = evaluatePreEntry(this.selectionRuleEngine.current, {
      eventSlug,
      slug,
      eventMarketCount,
    });
    if (evalResult.finalStatus === "INCLUDE") {
      this.eligible.add(tokenId);
    } else {
      this.eligible.delete(tokenId);
    }
  }
}

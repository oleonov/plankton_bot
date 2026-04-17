import type { EventBus, TokenId } from "@plankton/domain";
import { matchesPreEntryFilter } from "@plankton/domain";
import type { SelectedMarketCache } from "./algo-decision-module.js";

// Spec v2.2 §0 — Live Pre-Entry Filter. Slug-prefix match only.
//
// Eligibility gates NEW BUYs only. We key on `tradable` (CLOB-entry-eligible),
// not `active`: preserved-for-lifecycle markets (active=true, tradable=false)
// keep flowing pricing for SELL/REDEEM but are excluded from new-entry gating.
//
// The Historical Universe Filter (`trade_count > 0`) is intentionally omitted
// per docs/superpowers/specs/2026-04-16-market-selection-layer-design.md §1.1
// — Gamma exposes no trade_count field and the design doc forbids proxies.
export class MarketSelectionCache implements SelectedMarketCache {
  private readonly eligible = new Set<string>();
  private unsub: (() => void) | null = null;

  constructor(private readonly bus: EventBus) {}

  subscribe(): void {
    this.unsub = this.bus.subscribe("NormalizedMarketUpdated", async (payload) => {
      for (const market of payload.markets) {
        this.processMarket(String(market.tokenId), market.eventSlug, market.tradable);
      }
    });
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
  }

  isEligible(tokenId: TokenId): boolean {
    return this.eligible.has(String(tokenId));
  }

  getEligibleTokenIds(): TokenId[] {
    return [...this.eligible] as TokenId[];
  }

  private processMarket(tokenId: string, eventSlug: string | null, tradable: boolean): void {
    if (tradable && matchesPreEntryFilter(eventSlug)) {
      this.eligible.add(tokenId);
    } else {
      this.eligible.delete(tokenId);
    }
  }
}

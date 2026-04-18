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
// The Historical Universe Filter (`trade_count > 0`) is intentionally omitted
// per docs/superpowers/specs/2026-04-16-market-selection-layer-design.md §1.1
// — Gamma exposes no trade_count field and the design forbids proxies.
export class MarketSelectionCache implements SelectedMarketCache {
  private readonly eligible = new Set<string>();
  private unsub: (() => void) | null = null;

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
        );
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

  private processMarket(
    tokenId: string,
    eventSlug: string | null,
    slug: string,
    eventMarketCount: number,
    tradable: boolean,
  ): void {
    if (!tradable) {
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

import type { EventBus, TokenId } from "@plankton/domain";
import { matchesPreEntryFilter } from "@plankton/domain";
import type { SelectedMarketCache } from "./algo-decision-module.js";

interface TokenMeta {
  conditionId: string;
  outcomeLc: string;
  eventSlug: string | null;
  active: boolean;
}

export class MarketSelectionCache implements SelectedMarketCache {
  private readonly conditionTokens = new Map<string, Set<string>>();
  private readonly tokenMeta = new Map<string, TokenMeta>();
  private readonly conditionOutcomeCounts = new Map<string, Map<string, number>>();
  private readonly eligible = new Set<string>();
  private unsub: (() => void) | null = null;

  constructor(private readonly bus: EventBus) {}

  subscribe(): void {
    this.unsub = this.bus.subscribe("NormalizedMarketUpdated", async (payload) => {
      for (const market of payload.markets) {
        this.processMarket(
          String(market.tokenId),
          market.conditionId,
          market.outcome,
          market.eventSlug,
          market.active,
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
    conditionId: string,
    outcome: string,
    eventSlug: string | null,
    active: boolean,
  ): void {
    const outcomeLc = outcome.toLowerCase();

    // Step 1: read previous state
    const prev = this.tokenMeta.get(tokenId);

    // Step 2: decrement old outcome count if previously active
    if (prev && prev.active) {
      const counts = this.conditionOutcomeCounts.get(prev.conditionId);
      if (counts) {
        const c = (counts.get(prev.outcomeLc) ?? 1) - 1;
        if (c <= 0) {
          counts.delete(prev.outcomeLc);
        } else {
          counts.set(prev.outcomeLc, c);
        }
      }
    }

    // Step 3: store new metadata
    this.tokenMeta.set(tokenId, { conditionId, outcomeLc, eventSlug, active });
    if (!this.conditionTokens.has(conditionId)) {
      this.conditionTokens.set(conditionId, new Set());
    }
    this.conditionTokens.get(conditionId)!.add(tokenId);

    // Step 4: increment new outcome count if active
    if (active) {
      if (!this.conditionOutcomeCounts.has(conditionId)) {
        this.conditionOutcomeCounts.set(conditionId, new Map());
      }
      const counts = this.conditionOutcomeCounts.get(conditionId)!;
      counts.set(outcomeLc, (counts.get(outcomeLc) ?? 0) + 1);
    }

    // Step 5: compute distinctOutcomes
    const distinctOutcomes = this.conditionOutcomeCounts.get(conditionId)?.size ?? 0;

    // Step 6: re-evaluate ALL tokens in this condition
    for (const tid of this.conditionTokens.get(conditionId)!) {
      const meta = this.tokenMeta.get(tid);
      if (meta && meta.active && matchesPreEntryFilter(meta.eventSlug, distinctOutcomes)) {
        this.eligible.add(tid);
      } else {
        this.eligible.delete(tid);
      }
    }
  }
}

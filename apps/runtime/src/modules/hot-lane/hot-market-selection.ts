import type {
  FamilyRulesProvider,
  FamilyRuleBundle,
  NormalizedMarket,
  Order,
} from "@plankton/domain";
import { shouldUseHotQuoteLane } from "./hot-lane-policy.js";

export interface HotMarketSelectionOptions {
  readonly nowMs: number;
  readonly rulesProvider: FamilyRulesProvider;
  readonly markets: readonly NormalizedMarket[];
  readonly openOrders?: readonly Pick<Order, "tokenId" | "signalReason">[];
  readonly suppressedUntilByToken?: ReadonlyMap<string, number>;
  readonly maxTokens: number;
}

function rankHotMarkets(opts: HotMarketSelectionOptions): NormalizedMarket[] {
  const hotOpenTokens = new Set(
    (opts.openOrders ?? [])
      .filter(
        (order) => order.signalReason === "spray-entry" || order.signalReason === "repricing-exit",
      )
      .map((order) => String(order.tokenId)),
  );

  return opts.markets
    .filter((market) => market.active && market.familyId)
    .map((market) => {
      const bundle = opts.rulesProvider.getRule(market.familyId!);
      return bundle && shouldUseHotQuoteLane(bundle) ? { market, bundle } : null;
    })
    .filter(
      (
        entry,
      ): entry is {
        market: NormalizedMarket;
        bundle: FamilyRuleBundle;
      } => entry != null,
    )
    .filter(({ market, bundle }) => {
      if (bundle.rules.universe.action !== "trade") return false;
      const suppressedUntil = opts.suppressedUntilByToken?.get(String(market.tokenId)) ?? 0;
      return suppressedUntil <= opts.nowMs;
    })
    .sort((a, b) => {
      const aHot = hotOpenTokens.has(String(a.market.tokenId));
      const bHot = hotOpenTokens.has(String(b.market.tokenId));
      if (aHot !== bHot) return aHot ? -1 : 1;

      const aPrice = a.market.bestBid ?? a.market.bestAsk ?? a.market.midPrice ?? 1;
      const bPrice = b.market.bestBid ?? b.market.bestAsk ?? b.market.midPrice ?? 1;
      return aPrice - bPrice;
    })
    .map(({ market }) => market);
}

export function selectHotMarkets(opts: HotMarketSelectionOptions): NormalizedMarket[] {
  return rankHotMarkets(opts).slice(0, opts.maxTokens);
}

export class StableHotMarketSelector {
  private currentTokenOrder: string[] = [];
  private heldUntilByToken = new Map<string, number>();

  select(
    opts: HotMarketSelectionOptions & {
      readonly holdWindowMs: number;
    },
  ): NormalizedMarket[] {
    const ranked = rankHotMarkets(opts);
    const topRanked = ranked.slice(0, opts.maxTokens);
    const eligibleByToken = new Map(ranked.map((market) => [String(market.tokenId), market]));
    const topRankedTokenKeys = new Set(topRanked.map((market) => String(market.tokenId)));
    const selected: NormalizedMarket[] = [];
    const selectedTokenKeys = new Set<string>();

    for (const tokenKey of this.currentTokenOrder) {
      if (selected.length >= opts.maxTokens) break;
      const market = eligibleByToken.get(tokenKey);
      if (!market) continue;

      const holdUntil = this.heldUntilByToken.get(tokenKey) ?? 0;
      const stillTopRanked = topRankedTokenKeys.has(tokenKey);
      const keepHeldToken = stillTopRanked || holdUntil > opts.nowMs;
      if (!keepHeldToken) continue;

      selected.push(market);
      selectedTokenKeys.add(tokenKey);
      if (stillTopRanked) {
        this.heldUntilByToken.set(tokenKey, opts.nowMs + opts.holdWindowMs);
      }
    }

    for (const market of topRanked) {
      if (selected.length >= opts.maxTokens) break;
      const tokenKey = String(market.tokenId);
      if (selectedTokenKeys.has(tokenKey)) continue;
      selected.push(market);
      selectedTokenKeys.add(tokenKey);
      this.heldUntilByToken.set(tokenKey, opts.nowMs + opts.holdWindowMs);
    }

    this.currentTokenOrder = selected.map((market) => String(market.tokenId));
    for (const tokenKey of [...this.heldUntilByToken.keys()]) {
      if (!selectedTokenKeys.has(tokenKey)) {
        this.heldUntilByToken.delete(tokenKey);
      }
    }

    return selected;
  }

  reset(): void {
    this.currentTokenOrder = [];
    this.heldUntilByToken.clear();
  }
}

export function dedupeHotFamilyIds(
  markets: readonly NormalizedMarket[],
): readonly import("@plankton/domain").FamilyId[] {
  const seen = new Set<string>();
  const familyIds: import("@plankton/domain").FamilyId[] = [];
  for (const market of markets) {
    if (!market.familyId) continue;
    const key = String(market.familyId);
    if (seen.has(key)) continue;
    seen.add(key);
    familyIds.push(market.familyId);
  }
  return familyIds;
}

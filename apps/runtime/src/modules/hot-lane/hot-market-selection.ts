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

export function selectHotMarkets(opts: HotMarketSelectionOptions): NormalizedMarket[] {
  const hotOpenTokens = new Set(
    (opts.openOrders ?? [])
      .filter((order) => order.signalReason === "spray-entry" || order.signalReason === "repricing-exit")
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
    .slice(0, opts.maxTokens)
    .map(({ market }) => market);
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

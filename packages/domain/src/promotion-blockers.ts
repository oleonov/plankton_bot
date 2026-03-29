export interface PromotionBlocker {
  metric: string;
  current: number;
  required: number;
  passed: boolean;
}

export function getPromotionBlockers(input: {
  repricingExits: number;
  distinctMarkets: number;
  tradeCount: number;
  recycleScore: number;
  toxicity: number;
  tailAdjustedPnl: number;
}): PromotionBlocker[] {
  return [
    { metric: "Repricing exits", current: input.repricingExits, required: 3, passed: input.repricingExits >= 3 },
    { metric: "Distinct markets", current: input.distinctMarkets, required: 5, passed: input.distinctMarkets >= 5 },
    { metric: "Trade count", current: input.tradeCount, required: 20, passed: input.tradeCount >= 20 },
    { metric: "Recycle score", current: +input.recycleScore.toFixed(2), required: 0.6, passed: input.recycleScore >= 0.6 },
    { metric: "Toxicity", current: +input.toxicity.toFixed(2), required: 0.3, passed: input.toxicity < 0.3 },
    { metric: "Tail-adjusted PnL", current: +input.tailAdjustedPnl.toFixed(2), required: 0, passed: input.tailAdjustedPnl > 0 },
  ];
}

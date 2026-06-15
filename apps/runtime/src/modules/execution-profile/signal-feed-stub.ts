import type { ScaleInMarketSignals, TokenId } from "@krabs/domain";

export interface ScaleInSignalSource {
  getSignalSnapshot(tokenId: TokenId): ScaleInMarketSignals;
}

export function createStubScaleInSignalSource(): ScaleInSignalSource {
  return {
    getSignalSnapshot: () => ({
      recovery60: 0,
      range60: 0,
      std60: 0,
      tradeCount3h: 0,
      notional3h: 0,
    }),
  };
}

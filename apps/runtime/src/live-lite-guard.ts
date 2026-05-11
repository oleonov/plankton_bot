import type { WalletMode } from "@krabs/domain";

const NOTIONAL_EPSILON_USDC = 1e-6;
const DEFAULT_FALLBACK_MIN_ORDER_USDC_RELAYER = 1;
const DEFAULT_FALLBACK_MIN_ORDER_USDC_EOA = 3;
const DEFAULT_MARKETABLE_BUY_MIN_USDC = 1;

export interface LiveLiteConfig {
  maxOpenValueUsdc: number;
  maxOrderUsdc: number;
  maxActiveMarkets: number;
  walletMode?: WalletMode;
  minOrderUsdc?: number | null;
  fallbackMinOrderUsdcRelayer?: number | null;
  fallbackMinOrderUsdcEoa?: number | null;
}

export class LiveLiteGuard {
  readonly isActive: boolean;

  constructor(private readonly config: LiveLiteConfig | undefined) {
    this.isActive = config !== undefined;
  }

  isOrderWithinCap(notional: number): boolean {
    if (!this.config) return true;
    return notional <= this.config.maxOrderUsdc;
  }

  wouldExceedOpenValueCap(currentValue: number, additionalValue: number): boolean {
    if (!this.config) return false;
    return currentValue + additionalValue > this.config.maxOpenValueUsdc;
  }

  wouldExceedActiveMarketsCap(currentCount: number, additional: number): boolean {
    if (!this.config) return false;
    return currentCount + additional > this.config.maxActiveMarkets;
  }

  getWalletMode(): WalletMode | null {
    if (!this.config) return null;
    return this.config.walletMode ?? "eoa";
  }

  getMinOrderUsdc(): number | null {
    if (!this.config) return null;
    if (this.config.minOrderUsdc != null) return this.config.minOrderUsdc;
    if (this.getWalletMode() === "relayer") {
      return this.config.fallbackMinOrderUsdcRelayer ?? DEFAULT_FALLBACK_MIN_ORDER_USDC_RELAYER;
    }
    return this.config.fallbackMinOrderUsdcEoa ?? DEFAULT_FALLBACK_MIN_ORDER_USDC_EOA;
  }

  isOrderAboveMin(notionalUsdc: number): boolean {
    const minOrderUsdc = this.getMinOrderUsdc();
    if (minOrderUsdc == null) return true;
    return notionalUsdc + NOTIONAL_EPSILON_USDC >= minOrderUsdc;
  }

  getMinEntryNotionalUsdc(
    marketableBuyMinNotionalUsdc = DEFAULT_MARKETABLE_BUY_MIN_USDC,
  ): number | null {
    if (!this.config) return null;
    const minOrderUsdc = this.getMinOrderUsdc();
    return Math.max(minOrderUsdc ?? 0, marketableBuyMinNotionalUsdc);
  }
}

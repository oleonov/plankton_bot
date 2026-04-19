import type { WalletMode } from "@plankton/domain";

const CLOB_MARKETABLE_BUY_MIN_USDC = 1;
const NOTIONAL_EPSILON_USDC = 1e-6;

export interface LiveLiteConfig {
  maxOpenValueUsdc: number;
  maxOrderUsdc: number;
  maxActiveMarkets: number;
  walletMode?: WalletMode;
  minOrderUsdc?: number | null;
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
    return this.getWalletMode() === "relayer" ? 1 : 3;
  }

  isOrderAboveMin(notionalUsdc: number): boolean {
    const minOrderUsdc = this.getMinOrderUsdc();
    if (minOrderUsdc == null) return true;
    return notionalUsdc + NOTIONAL_EPSILON_USDC >= minOrderUsdc;
  }

  // Current CLOB rejects marketable BUY orders below $1 even when relayer
  // profile minimums are configured lower for dust experiments.
  getMinEntryNotionalUsdc(): number | null {
    if (!this.config) return null;
    const minOrderUsdc = this.getMinOrderUsdc();
    return Math.max(minOrderUsdc ?? 0, CLOB_MARKETABLE_BUY_MIN_USDC);
  }
}

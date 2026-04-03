import {
  resolveFamilyLiveTradingPolicy,
  type FamilyIdentity,
  type WalletMode,
} from "@plankton/domain";

export interface LiveLiteConfig {
  familyAllowlist: string[];
  maxFamilies: number;
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

  isFamilyAllowed(familyId: string): boolean {
    if (!this.config) return true;
    return this.config.familyAllowlist.includes(familyId);
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

  wouldExceedFamilyCount(enabledFamilies: number): boolean {
    if (!this.config) return false;
    return enabledFamilies > this.config.maxFamilies;
  }

  getWalletMode(): WalletMode | null {
    if (!this.config) return null;
    return this.config.walletMode ?? "eoa";
  }

  getMinOrderUsdc(): number | null {
    if (!this.config) return null;
    if (this.config.minOrderUsdc != null) return this.config.minOrderUsdc;
    return this.getWalletMode() === "relayer" ? 2 : 3;
  }

  supportsPostOnlyFamilies(): boolean {
    return this.getWalletMode() === "relayer";
  }

  isOrderAboveMin(notionalUsdc: number): boolean {
    const minOrderUsdc = this.getMinOrderUsdc();
    if (minOrderUsdc == null) return true;
    return notionalUsdc >= minOrderUsdc;
  }

  getFamilyPolicyRejections(opts: {
    identity: Pick<
      FamilyIdentity,
      "primaryCategory" | "feeTier" | "liveWalletRequirement" | "requiresPostOnlyForLive"
    >;
    isEntry: boolean;
    orderNotionalUsdc: number;
    hasPostOnlySupport?: boolean;
  }): string[] {
    if (!this.config || !opts.isEntry) return [];

    const walletMode = this.getWalletMode();
    const minOrderUsdc = this.getMinOrderUsdc();
    const policy = resolveFamilyLiveTradingPolicy(opts.identity);
    const rejected: string[] = [];

    if (policy.requiresPostOnlyForLive && !opts.hasPostOnlySupport) {
      rejected.push("live-post-only-required");
    }

    if (walletMode === "eoa" && policy.liveWalletRequirement === "relayer-required") {
      rejected.push(
        policy.feeTier === "fee-enabled"
          ? "live-eoa-fee-enabled-family-rejected"
          : "live-relayer-required-family-rejected",
      );
    }

    if (minOrderUsdc != null && opts.orderNotionalUsdc < minOrderUsdc) {
      rejected.push("live-min-order-usdc-rejected");
    }

    return rejected;
  }
}

import {
  resolveFamilyLiveTradingPolicy,
  type FamilyIdentity,
  type WalletMode,
} from "@plankton/domain";

const CLOB_MARKETABLE_BUY_MIN_USDC = 1;
const NOTIONAL_EPSILON_USDC = 1e-6;

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
  private dynamicFamilyAllowlist: string[] | null = null;

  constructor(private readonly config: LiveLiteConfig | undefined) {
    this.isActive = config !== undefined;
  }

  isFamilyAllowed(familyId: string): boolean {
    if (!this.config) return true;
    return this.getEffectiveFamilyAllowlist().includes(familyId);
  }

  setDynamicFamilyAllowlist(familyIds: string[] | null): void {
    if (!this.config) return;
    this.dynamicFamilyAllowlist =
      familyIds && familyIds.length > 0 ? Array.from(new Set(familyIds)) : null;
  }

  getConfiguredFamilyAllowlist(): string[] {
    return this.config?.familyAllowlist ?? [];
  }

  getEffectiveFamilyAllowlist(): string[] {
    if (!this.config) return [];
    return this.dynamicFamilyAllowlist ?? this.config.familyAllowlist;
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
    return this.getWalletMode() === "relayer" ? 1 : 3;
  }

  supportsPostOnlyFamilies(): boolean {
    return this.getWalletMode() === "relayer";
  }

  isOrderAboveMin(notionalUsdc: number): boolean {
    const minOrderUsdc = this.getMinOrderUsdc();
    if (minOrderUsdc == null) return true;
    return notionalUsdc + NOTIONAL_EPSILON_USDC >= minOrderUsdc;
  }

  /**
   * Current CLOB rejects marketable BUY orders below $1 even when relayer
   * profile minimums are configured lower for dust experiments.
   */
  getMinEntryNotionalUsdc(): number | null {
    if (!this.config) return null;
    const minOrderUsdc = this.getMinOrderUsdc();
    return Math.max(minOrderUsdc ?? 0, CLOB_MARKETABLE_BUY_MIN_USDC);
  }

  getFamilyPolicyRejections(opts: {
    identity: Pick<
      FamilyIdentity,
      "primaryCategory" | "feeTier" | "liveWalletRequirement" | "requiresPostOnlyForLive"
    >;
    isEntry: boolean;
    orderNotionalUsdc: number;
    hasPostOnlySupport?: boolean;
    signalReason?: string | null;
  }): string[] {
    if (!this.config || !opts.isEntry) return [];

    const walletMode = this.getWalletMode();
    const minOrderUsdc = this.getMinEntryNotionalUsdc();
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

    if (minOrderUsdc != null && opts.orderNotionalUsdc + NOTIONAL_EPSILON_USDC < minOrderUsdc) {
      rejected.push("live-min-order-usdc-rejected");
    }

    return rejected;
  }
}

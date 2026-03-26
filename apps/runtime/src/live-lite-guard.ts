export interface LiveLiteConfig {
  familyAllowlist: string[];
  maxFamilies: number;
  maxOpenValueUsdc: number;
  maxOrderUsdc: number;
  maxActiveMarkets: number;
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
}

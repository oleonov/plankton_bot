import type { FeeTier, LiveWalletRequirement } from "./enums.js";

export interface FamilyLiveTradingPolicyInput {
  primaryCategory: string;
  feeTier?: FeeTier | null;
  liveWalletRequirement?: LiveWalletRequirement | null;
  requiresPostOnlyForLive?: boolean | null;
}

export interface ResolvedFamilyLiveTradingPolicy {
  feeTier: FeeTier;
  liveWalletRequirement: LiveWalletRequirement;
  requiresPostOnlyForLive: boolean;
}

function defaultFamilyLiveTradingPolicy(primaryCategory: string): ResolvedFamilyLiveTradingPolicy {
  if (primaryCategory === "geopolitics") {
    return {
      feeTier: "fee-free",
      liveWalletRequirement: "eoa-ok",
      requiresPostOnlyForLive: false,
    };
  }

  return {
    feeTier: "fee-enabled",
    liveWalletRequirement: "relayer-required",
    requiresPostOnlyForLive: true,
  };
}

export function resolveFamilyLiveTradingPolicy(
  input: FamilyLiveTradingPolicyInput,
): ResolvedFamilyLiveTradingPolicy {
  const defaults = defaultFamilyLiveTradingPolicy(input.primaryCategory);

  return {
    feeTier: input.feeTier ?? defaults.feeTier,
    liveWalletRequirement: input.liveWalletRequirement ?? defaults.liveWalletRequirement,
    requiresPostOnlyForLive: input.requiresPostOnlyForLive ?? defaults.requiresPostOnlyForLive,
  };
}

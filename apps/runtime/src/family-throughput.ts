import type { FamilyRuleBundle } from "@plankton/domain";

export interface FamilyThroughputPolicy {
  maxConcurrentOrdersPerFamily: number;
  maxProbeInFlightPerToken: number;
  maxEntrySignalsPerTickPerFamily: number;
  source: "configured" | "core" | "reduced" | "fallback";
}

export type FamilyThroughputTier = "core" | "reduced" | "fallback";

const CORE_FAMILY_KEYS = new Set([
  "bitcoin-price",
  "btc-updown-4h",
  "who-will-be-next-supreme-leader-of-iran",
  "us-next-strikes-iran-on",
]);

const REDUCED_FAMILY_KEYS = new Set([
  "bitcoin-above",
  "ethereum-price",
  "will-bitcoin-reach",
  "will-ethereum-reach",
]);

export type FamilySpeedTier = "core-fast" | "reduced-fast" | "standard";

const CORE_LIMITS: FamilyThroughputPolicy = {
  maxConcurrentOrdersPerFamily: 10,
  maxProbeInFlightPerToken: 2,
  maxEntrySignalsPerTickPerFamily: 1,
  source: "core",
};

const REDUCED_LIMITS: FamilyThroughputPolicy = {
  maxConcurrentOrdersPerFamily: 3,
  maxProbeInFlightPerToken: 1,
  maxEntrySignalsPerTickPerFamily: 1,
  source: "reduced",
};

const FALLBACK_LIMITS: FamilyThroughputPolicy = {
  maxConcurrentOrdersPerFamily: 2,
  maxProbeInFlightPerToken: 1,
  maxEntrySignalsPerTickPerFamily: 1,
  source: "fallback",
};

function defaultPolicyForFamilyKey(familyKey: string): FamilyThroughputPolicy {
  if (CORE_FAMILY_KEYS.has(familyKey)) return CORE_LIMITS;
  if (REDUCED_FAMILY_KEYS.has(familyKey)) return REDUCED_LIMITS;
  return FALLBACK_LIMITS;
}

export function resolveFamilyThroughputTierByFamilyKey(
  familyKey: string | null | undefined,
): FamilyThroughputTier {
  if (!familyKey) return "fallback";
  if (CORE_FAMILY_KEYS.has(familyKey)) return "core";
  if (REDUCED_FAMILY_KEYS.has(familyKey)) return "reduced";
  return "fallback";
}

export function resolveFamilySpeedTierByFamilyKey(
  familyKey: string | null | undefined,
  fastLaneEnabled: boolean | null | undefined = null,
): FamilySpeedTier {
  if (!fastLaneEnabled) return "standard";
  const tier = resolveFamilyThroughputTierByFamilyKey(familyKey);
  if (tier === "core") return "core-fast";
  if (tier === "reduced") return "reduced-fast";
  return "standard";
}

export function resolveFamilySpeedTier(bundle: FamilyRuleBundle): FamilySpeedTier {
  return resolveFamilySpeedTierByFamilyKey(
    bundle.identity.familyKey,
    bundle.rules.throughput?.fastLaneEnabled ?? null,
  );
}

export function isFastLaneEnabled(bundle: FamilyRuleBundle | null | undefined): boolean {
  return bundle?.rules.throughput?.fastLaneEnabled === true;
}

export function resolveFamilyThroughputPolicy(bundle: FamilyRuleBundle): FamilyThroughputPolicy {
  const base = defaultPolicyForFamilyKey(bundle.identity.familyKey);
  const configured = bundle.rules.throughput;
  const hasOverride =
    configured?.maxConcurrentOrdersPerFamily != null ||
    configured?.maxProbeInFlightPerToken != null ||
    configured?.maxEntrySignalsPerTickPerFamily != null;

  if (!hasOverride) return base;

  return {
    maxConcurrentOrdersPerFamily:
      configured.maxConcurrentOrdersPerFamily ?? base.maxConcurrentOrdersPerFamily,
    maxProbeInFlightPerToken: configured.maxProbeInFlightPerToken ?? base.maxProbeInFlightPerToken,
    maxEntrySignalsPerTickPerFamily:
      configured.maxEntrySignalsPerTickPerFamily ?? base.maxEntrySignalsPerTickPerFamily,
    source: "configured",
  };
}

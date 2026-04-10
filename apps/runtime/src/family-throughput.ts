import type { FamilyRuleBundle } from "@plankton/domain";

export interface FamilyThroughputPolicy {
  maxConcurrentOrdersPerFamily: number;
  maxProbeInFlightPerToken: number;
  maxEntrySignalsPerTickPerFamily: number;
  source: "configured" | "core" | "reduced" | "fallback";
}

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

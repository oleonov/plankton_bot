/**
 * family-throughput — throughput policy resolution for trading families.
 *
 * FamilyRuleBundle is no longer a domain type (Phase 6). A local minimal
 * interface covers the fields needed by these helpers.
 */

/** Minimal bundle shape needed by throughput helpers. */
export interface ThroughputBundle {
  identity: { familyKey: string };
  rules: {
    throughput?: {
      maxConcurrentOrdersPerFamily?: number | null;
      maxProbeInFlightPerToken?: number | null;
      maxEntrySignalsPerTickPerFamily?: number | null;
      fastLaneEnabled?: boolean | null;
      dustLaneEnabled?: boolean | null;
      queueJumpCanaryEnabled?: boolean | null;
    } | null;
  };
}

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
  "donald-trump-of-truth-social-posts",
  "ethereum-price",
  "highest-temperature-in-london",
  "highest-temperature-in-nyc",
  "highest-temperature-in-seoul",
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
  return "reduced-fast";
}

export function resolveFamilySpeedTier(bundle: ThroughputBundle): FamilySpeedTier {
  return resolveFamilySpeedTierByFamilyKey(
    bundle.identity.familyKey,
    bundle.rules.throughput?.fastLaneEnabled ?? null,
  );
}

export function isFastLaneEnabled(bundle: ThroughputBundle | null | undefined): boolean {
  return bundle?.rules.throughput?.fastLaneEnabled === true;
}

export function isDustLaneEnabled(bundle: ThroughputBundle | null | undefined): boolean {
  return bundle?.rules.throughput?.dustLaneEnabled === true;
}

export function isQueueJumpCanaryEnabled(bundle: ThroughputBundle | null | undefined): boolean {
  return bundle?.rules.throughput?.queueJumpCanaryEnabled === true;
}

export function isHotQuoteFamily(bundle: ThroughputBundle | null | undefined): boolean {
  if (!bundle) return false;
  return isFastLaneEnabled(bundle) || isDustLaneEnabled(bundle);
}

export function resolveFamilyThroughputPolicy(bundle: ThroughputBundle): FamilyThroughputPolicy {
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

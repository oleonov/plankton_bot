export interface EntryRulePreset {
  minEntryPrice: number;
  maxEntryPrice: number;
  highPriceThreshold: number;
  requireProvenFamilyAbovePrice: number;
  preferredEntryBand: string | null;
}

export interface FamilyEntryClassificationInput {
  familyKey: string;
  primaryCategory: string;
  regime: string;
  horizon: string;
  strategyProfile: string;
  slugPattern: string | null;
  tickSize?: number | null;
}

export interface DiscoveryEntryPolicyInput extends FamilyEntryClassificationInput {
  defaultEntryPreset: EntryRulePreset;
}

export type DiscoveryEntryTier = "aggressive" | "standard" | "micro-default";

export type DiscoveryEntryMatchType = "safety" | "override" | "structured" | "keyword" | "fallback";

export interface ResolvedDiscoveryEntryPolicy {
  tier: DiscoveryEntryTier;
  matchedBy: DiscoveryEntryMatchType;
  reason: string;
  preset: EntryRulePreset;
}

export interface ClassifiedFamilyEntryTier {
  tier: DiscoveryEntryTier;
  matchedBy: DiscoveryEntryMatchType;
  reason: string;
}

export type FamilyMarketabilityTier = "core" | "reduced" | "fallback";

const AGGRESSIVE_PRESET: EntryRulePreset = {
  minEntryPrice: 0.02,
  maxEntryPrice: 0.5,
  highPriceThreshold: 0.5,
  requireProvenFamilyAbovePrice: 0.5,
  preferredEntryBand: "0.02-0.50",
};

const STANDARD_PRESET: EntryRulePreset = {
  minEntryPrice: 0.03,
  maxEntryPrice: 0.35,
  highPriceThreshold: 0.35,
  requireProvenFamilyAbovePrice: 0.35,
  preferredEntryBand: "0.05-0.35",
};

const LONDON_WEATHER_OVERRIDE: EntryRulePreset = {
  minEntryPrice: 0.03,
  maxEntryPrice: 0.2,
  highPriceThreshold: 0.2,
  requireProvenFamilyAbovePrice: 0.2,
  preferredEntryBand: "0.05-0.20",
};

const MICRO_TICK_SIZE_THRESHOLD = 0.001;

function normalize(text: string | null | undefined): string {
  return (text ?? "").trim().toLowerCase();
}

function includesAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function buildCombinedText(input: FamilyEntryClassificationInput): string {
  return [
    normalize(input.familyKey),
    normalize(input.primaryCategory),
    normalize(input.regime),
    normalize(input.horizon),
    normalize(input.strategyProfile),
    normalize(input.slugPattern),
  ]
    .filter(Boolean)
    .join(" ");
}

function withReason(
  tier: DiscoveryEntryTier,
  matchedBy: DiscoveryEntryMatchType,
  reason: string,
): ClassifiedFamilyEntryTier {
  return { tier, matchedBy, reason };
}

function resolvePresetForClassification(
  input: DiscoveryEntryPolicyInput,
  classification: ClassifiedFamilyEntryTier,
): EntryRulePreset {
  if (normalize(input.familyKey) === "highest-temperature-in-london") {
    return LONDON_WEATHER_OVERRIDE;
  }

  if (classification.tier === "aggressive") return AGGRESSIVE_PRESET;
  if (classification.tier === "standard") return STANDARD_PRESET;
  return input.defaultEntryPreset;
}

export function classifyFamilyEntryTier(
  input: FamilyEntryClassificationInput,
): ClassifiedFamilyEntryTier {
  const familyKey = normalize(input.familyKey);
  const primaryCategory = normalize(input.primaryCategory);
  const regime = normalize(input.regime);
  const combined = buildCombinedText(input);

  if (input.tickSize != null && input.tickSize <= MICRO_TICK_SIZE_THRESHOLD) {
    return withReason(
      "micro-default",
      "safety",
      `tick_size=${input.tickSize} <= ${MICRO_TICK_SIZE_THRESHOLD}`,
    );
  }

  if (familyKey === "highest-temperature-in-london") {
    return withReason("micro-default", "override", "family_key=highest-temperature-in-london");
  }

  if (includesAny(combined, ["truth-social", "donald-trump", "elon-musk", "tweets"])) {
    return withReason("aggressive", "keyword", "social-activity keyword match");
  }

  if (includesAny(combined, ["inflation", "cpi", "crude-oil", "oil"])) {
    return withReason("standard", "keyword", "macro keyword match");
  }

  if (primaryCategory === "geopolitics" || regime === "geopolitics" || regime === "succession") {
    return withReason(
      "aggressive",
      "structured",
      `structured category/regime match (${primaryCategory}/${regime})`,
    );
  }

  if (regime === "social-activity") {
    return withReason("aggressive", "structured", "structured regime match (social-activity)");
  }

  if (regime === "directional-updown") {
    return withReason(
      "standard",
      "structured",
      "structured regime match (directional-updown)",
    );
  }

  if (primaryCategory.startsWith("crypto")) {
    return withReason("standard", "structured", `structured category match (${primaryCategory})`);
  }

  if (primaryCategory === "weather" || regime === "price-range") {
    return withReason(
      "micro-default",
      "structured",
      `structured weather/price-range match (${primaryCategory}/${regime})`,
    );
  }

  return withReason(
    "micro-default",
    "fallback",
    "no override, structured rule, or keyword rule matched",
  );
}

export function resolveFamilyMarketabilityTier(
  input: FamilyEntryClassificationInput,
): FamilyMarketabilityTier {
  const classification = classifyFamilyEntryTier(input);
  if (classification.tier === "aggressive") return "core";
  if (classification.tier === "standard") return "reduced";
  return "fallback";
}

export function resolveDiscoveryEntryPolicy(
  input: DiscoveryEntryPolicyInput,
): ResolvedDiscoveryEntryPolicy {
  const classification = classifyFamilyEntryTier(input);
  return {
    ...classification,
    preset: resolvePresetForClassification(input, classification),
  };
}

import {
  PromotionState,
  type FamilyEvidence,
  type FamilyIdentity,
  type FamilyRuleBundle,
} from "@plankton/domain";

const PROVEN_EVIDENCE_SCORE_THRESHOLD = 55;
const PROVEN_LOCAL_TRADE_COUNT_THRESHOLD = 100;

function hasSufficientEvidence(evidence: FamilyEvidence | undefined): boolean {
  if (!evidence) return false;
  if (evidence.evidenceStatus === "unknown" || evidence.evidenceStatus === "weak") {
    return false;
  }
  if (evidence.promotionState !== PromotionState.Scaled) {
    return false;
  }
  return (
    evidence.evidenceScore >= PROVEN_EVIDENCE_SCORE_THRESHOLD &&
    evidence.localTradeCount >= PROVEN_LOCAL_TRADE_COUNT_THRESHOLD
  );
}

function isThresholdRegime(identity: Pick<FamilyIdentity, "regime">): boolean {
  return identity.regime === "threshold";
}

function isConfiguredWeatherRecycler(
  bundle: Pick<FamilyRuleBundle, "identity" | "rules">,
): boolean {
  if (bundle.identity.primaryCategory !== "weather" || bundle.identity.regime !== "price-range") {
    return false;
  }
  if (bundle.identity.strategyProfile !== "scalp") return false;
  if (bundle.rules.universe.action !== "trade") return false;
  if (bundle.rules.throughput?.fastLaneEnabled !== true) return false;
  return bundle.rules.scaleIn.scaleMode !== "disabled";
}

export function isProvenNonThresholdFamily(
  bundle:
    | FamilyRuleBundle
    | {
        identity: Pick<FamilyIdentity, "regime">;
        evidence?: FamilyEvidence | undefined;
      },
): boolean {
  if (isThresholdRegime(bundle.identity)) return false;
  return hasSufficientEvidence(bundle.evidence);
}

export function shouldRelaxNegativeTailProbeOnly(
  bundle:
    | FamilyRuleBundle
    | {
        identity: Pick<FamilyIdentity, "regime">;
        evidence?: FamilyEvidence | undefined;
      },
): boolean {
  return isProvenNonThresholdFamily(bundle);
}

export function shouldPromoteFallbackMarketability(
  bundle: Pick<FamilyRuleBundle, "identity" | "evidence" | "rules">,
  tickSize: number | null | undefined,
): boolean {
  if (tickSize != null && tickSize <= 0.001) return false;
  if (bundle.rules.throughput?.fastLaneEnabled !== true) return false;
  if (isConfiguredWeatherRecycler(bundle)) return true;
  return isProvenNonThresholdFamily(bundle);
}

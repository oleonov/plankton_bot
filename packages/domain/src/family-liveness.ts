export type FamilyLiveness = "active" | "dormant" | "unseen";

export interface FamilyLivenessMetrics {
  activeMarketCount: number;
  knownMarketCount: number;
  lastMarketSeenAt: string | null;
}

export interface FamilyLivenessSnapshot extends FamilyLivenessMetrics {
  liveness: FamilyLiveness;
}

export function deriveFamilyLiveness(metrics: FamilyLivenessMetrics): FamilyLiveness {
  if (metrics.activeMarketCount > 0) return "active";
  if (metrics.knownMarketCount > 0) return "dormant";
  return "unseen";
}

export function toFamilyLivenessSnapshot(
  metrics: FamilyLivenessMetrics,
): FamilyLivenessSnapshot {
  return {
    ...metrics,
    liveness: deriveFamilyLiveness(metrics),
  };
}

export function emptyFamilyLivenessSnapshot(): FamilyLivenessSnapshot {
  return {
    activeMarketCount: 0,
    knownMarketCount: 0,
    lastMarketSeenAt: null,
    liveness: "unseen",
  };
}
